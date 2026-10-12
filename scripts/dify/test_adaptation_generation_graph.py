"""Exercise the exported shared adaptation graph on Graphon with synthetic model replies."""
import contextlib
import hashlib
import io
import json
import logging
import sys
import time
import unittest
from unittest.mock import patch

import jsonschema
import yaml

import build_adaptation_generation_dsl as builder
import test_adaptation_generation_runtime as fixtures
import validate_dify_dsl as validator
from prompt_rendering import message_text, render_messages

from graphon.entities.graph_init_params import GraphInitParams
from graphon.enums import BuiltinNodeTypes, WorkflowNodeExecutionStatus
from graphon.graph.graph import Graph
from graphon.graph_engine.command_channels.in_memory_channel import InMemoryChannel
from graphon.graph_engine.config import GraphEngineConfig
from graphon.graph_engine.graph_engine import GraphEngine
from graphon.graph_events.graph import GraphRunFailedEvent, GraphRunSucceededEvent
from graphon.node_events.base import NodeRunResult
from graphon.nodes.base.node import Node
from graphon.nodes.code.limits import CodeNodeLimits
from graphon.nodes.llm.entities import LLMNodeData
from graphon.runtime.graph_runtime_state import GraphRuntimeState
from graphon.runtime.variable_pool import VariablePool


class LocalExecutor:
    def execute(self, *, language, code, inputs):
        namespace = {"__name__": "__main__"}
        with patch.object(sys, "argv", ["sandbox"]):
            exec(compile(code, "<adaptation-code-node>", "exec"), namespace)
        return namespace["main"](**inputs)

    def is_execution_error(self, error):
        return isinstance(error, (ValueError, TypeError))


class SyntheticModel(Node[LLMNodeData]):
    node_type = BuiltinNodeTypes.LLM

    @classmethod
    def version(cls):
        return "99"

    def _run(self):
        raw = self.graph_init_params.run_context["respond"](self)
        jsonschema.Draft7Validator(self.node_data.structured_output["schema"]).validate(raw)
        return NodeRunResult(status=WorkflowNodeExecutionStatus.SUCCEEDED,
                             outputs={"text": json.dumps(raw, ensure_ascii=False)})


def request_for(node):
    messages = render_messages(node.node_data, node.graph_runtime_state.variable_pool)
    user = next(message_text(message) for message in messages if message.role.value == "user")
    prefix, suffix = "<adaptation_request>\n", "\n</adaptation_request>"
    if not user.startswith(prefix) or not user.endswith(suffix):
        raise ValueError("Adaptation request Jinja template did not render its explicit selector")
    rendered = user[len(prefix):-len(suffix)]
    return json.loads(rendered)


class Scenario:
    def __init__(self, editorial, mode="ready"):
        self.editorial = editorial
        self.mode = mode
        self.counts = {}
        self.requests = {}

    def respond(self, node):
        self.counts[node.id] = self.counts.get(node.id, 0) + 1
        request = request_for(node)
        self.requests[node.id] = request
        factual = self.editorial["contentMode"] == "FACTUAL"
        segment = {"text": "📊 Показник змінився у вимірюванні.",
                   "claimRevisionId": fixtures.CLAIM if factual else "",
                   "evidenceId": fixtures.EVIDENCE if factual else ""}
        if node.id == "writer":
            paragraphs = [{"field": "text", "segments": [segment]}]
            instruction = ""
            if self.editorial["format"] in ("LINKEDIN_COVER", "INSTAGRAM_COVER"):
                paragraphs.append({"field": "cover", "segments": [dict(segment, text="Показник змінився")]})
                instruction = "Світлий фон, виразний заголовок."
            result = {"paragraphs": paragraphs, "coverInstruction": instruction}
            if self.editorial["format"] in fixtures.rt.SCRIPT_FORMATS:
                frame_segment = {"text": "Вимірювання підтвердило зміну показника.",
                    "claimRevisionId": fixtures.CLAIM if factual else "",
                    "evidenceId": fixtures.EVIDENCE if factual else ""}
                story = self.editorial["format"] == "INSTAGRAM_STORIES"
                result["script"] = {"frames": [
                    {"id": fixtures.FRAME_1, "purpose": "Показати зміну показника.",
                     "segments": [frame_segment], "visualHint": "Великий заголовок і простий графік.",
                     "transition": "Перейти до наступного кадру." if story else ""},
                    {"id": fixtures.FRAME_2, "purpose": "Підсумувати факт.",
                     "segments": [frame_segment], "visualHint": "Залишити місце для короткого підсумку.",
                     "transition": "Завершити коротким підсумком." if story else ""}]}
            return result
        if node.id == "reviewer":
            if self.mode == "insufficient":
                return {"status": "insufficient_evidence", "reasons": ["Не вистачає даних для відповіді."], "issues": []}
            if self.mode == "repair":
                target = "p2" if self.editorial["format"] in ("LINKEDIN_COVER", "INSTAGRAM_COVER") else "p1"
                target_text = next(p for p in request["paragraphs"] if p["paragraphId"] == target)["segments"][0]["text"]
                return {"status": "needs_human", "reasons": ["Уточніть формулювання."], "issues": [
                    {"severity": "major", "category": "accuracy", "paragraphId": target,
                     "quote": target_text, "instruction": "Уточніть фразу за дозволеними фактами."}]}
            if self.mode == "repair-frame":
                frame = request["candidate"]["script"]["frames"][0]
                return {"status": "needs_human", "reasons": ["Уточніть сценарій."], "issues": [
                    {"severity": "major", "category": "accuracy", "paragraphId": "frame:" + fixtures.FRAME_1,
                     "quote": frame["text"], "instruction": "Уточніть текст кадру."}]}
            return {"status": "ready", "reasons": [], "issues": []}
        if node.id == "repairer":
            replacements = []
            for target in request["allowedParagraphIds"]:
                paragraph = next(p for p in request["paragraphs"] if p["paragraphId"] == target)
                updated = dict(paragraph["segments"][0], text=paragraph["segments"][0]["text"] + " так.")
                replacements.append({"paragraphId": target, "segments": [updated]})
            frame_replacements = []
            for frame_id in request["allowedFrameIds"]:
                frame = next(item for item in request["scriptFrames"] if item["id"] == frame_id)
                segments = [dict(frame["segments"][0], text=frame["segments"][0]["text"] + " Так.")]
                frame_replacements.append({"frameId": frame_id, "purpose": frame["purpose"], "segments": segments,
                    "visualHint": frame["visualHint"], "transition": frame["transition"]})
            return {"replacements": replacements, "frameReplacements": frame_replacements,
                    "coverInstruction": request["coverInstruction"]}
        if node.id == "reviewer-2":
            return {"status": "ready", "reasons": [], "issues": []}
        raise AssertionError("Unexpected model node: " + node.id)


class Factory:
    def __init__(self, graph, runtime):
        self.params = GraphInitParams(workflow_id="synthetic-adaptation", graph_config=graph,
            run_context={"respond": runtime}, call_depth=0)
        self.mapping = validator._graphon_mapping("0.7.0")[0]

    def create_node(self, config):
        data = config["data"]
        cls = SyntheticModel if data["type"] == "llm" else self.mapping[data["type"]][data.get("version", "1")]
        kwargs = {"graph_init_params": self.params, "graph_runtime_state": self.runtime}
        if data["type"] == "code":
            kwargs.update(code_executor=LocalExecutor(), code_limits=CodeNodeLimits(
                max_string_length=800000, max_number=1e100, min_number=-1e100, max_precision=20,
                max_depth=5, max_number_array_length=1000, max_string_array_length=30, max_object_array_length=30))
        return cls(node_id=config["id"], data=cls.validate_node_data(data), **kwargs)


class AdaptationGraphTests(unittest.TestCase):
    def execute(self, scenario):
        path = builder.DIRECTORY / "adaptation-generation-v1.yml"
        document = yaml.safe_load(path.read_text(encoding="utf-8"))
        self.assertEqual(document, builder.build_document(), "Regenerate adaptation DSL before graph tests")
        graph_config = document["workflow"]["graph"]
        pool = VariablePool()
        pool.add(["start", "editorial_json"], json.dumps(scenario.editorial, ensure_ascii=False))
        runtime = GraphRuntimeState(variable_pool=pool, start_at=time.perf_counter())
        factory = Factory(graph_config, scenario.respond)
        factory.runtime = runtime
        graph = Graph.init(graph_config=graph_config, node_factory=factory, root_node_id="start")
        engine = GraphEngine(workflow_id="synthetic-adaptation", graph=graph, graph_runtime_state=runtime,
            command_channel=InMemoryChannel(), config=GraphEngineConfig(min_workers=1, max_workers=1))
        events = []
        try:
            events.extend(engine.run())
        except RuntimeError:
            if not any(isinstance(event, GraphRunFailedEvent) for event in events):
                raise
        failures = [event.error for event in events if isinstance(event, GraphRunFailedEvent)]
        succeeded = [event for event in events if isinstance(event, GraphRunSucceededEvent)]
        return succeeded[-1].outputs if succeeded else None, failures

    def test_exported_graph_runs_format_route_and_mode_matrix(self):
        for format_name in sorted(fixtures.rt.FORMATS):
            for content_mode in ("FACTUAL", "CREATIVE"):
                for input_mode in ("DIRECT", "ARTICLE_DERIVED"):
                    with self.subTest(format=format_name, mode=content_mode, route=input_mode):
                        editorial = fixtures.fixture(format_name, content_mode, input_mode)
                        scenario = Scenario(editorial)
                        outputs, errors = self.execute(scenario)
                        self.assertEqual(errors, [])
                        candidate = json.loads(outputs["adaptation_json"])
                        report = json.loads(outputs["adaptation_report"])
                        self.assertEqual(candidate["format"], format_name)
                        self.assertEqual(report["status"], "ready")
                        self.assertEqual(report["contentHash"], hashlib.sha256(json.dumps(
                            candidate, ensure_ascii=False, separators=(",", ":")).encode("utf-8")).hexdigest())
                        self.assertEqual(bool(candidate["content"].get("cover")),
                                         format_name in fixtures.rt.COVER_FORMATS)
                        self.assertEqual("script" in candidate, format_name in fixtures.rt.SCRIPT_FORMATS)
                        self.assertEqual(scenario.requests["writer"]["format"], format_name)
                        self.assertEqual(scenario.requests["writer"]["inputMode"], input_mode)

    def test_article_derived_creative_cover_runs_one_repair_and_second_review(self):
        editorial = fixtures.fixture("LINKEDIN_COVER", "CREATIVE", "ARTICLE_DERIVED")
        scenario = Scenario(editorial, "repair")
        outputs, errors = self.execute(scenario)
        self.assertEqual(errors, [])
        self.assertEqual(scenario.counts["reviewer"], 1)
        self.assertEqual(scenario.counts["repairer"], 1)
        self.assertEqual(scenario.counts["reviewer-2"], 1)
        candidate = json.loads(outputs["adaptation_json"])
        self.assertEqual(candidate["format"], "LINKEDIN_COVER")
        self.assertEqual(candidate["content"]["mappings"], [])
        self.assertTrue(candidate["content"]["cover"]["text"].endswith(" так."))
        self.assertEqual(scenario.requests["writer"]["inputMode"], "ARTICLE_DERIVED")
        self.assertEqual(scenario.requests["writer"]["contentMode"], "CREATIVE")

    def test_insufficient_evidence_returns_report_without_candidate(self):
        scenario = Scenario(fixtures.fixture(), "insufficient")
        outputs, errors = self.execute(scenario)
        self.assertEqual(errors, [])
        self.assertEqual(outputs["adaptation_json"], "")
        self.assertEqual(json.loads(outputs["adaptation_report"])["status"], "insufficient_evidence")

    def test_exported_graph_repairs_one_story_frame_without_changing_its_locator(self):
        editorial = fixtures.fixture("INSTAGRAM_STORIES", "FACTUAL", "DIRECT")
        scenario = Scenario(editorial, "repair-frame")
        outputs, errors = self.execute(scenario)
        self.assertEqual(errors, [])
        self.assertEqual(scenario.counts["repairer"], 1)
        candidate = json.loads(outputs["adaptation_json"])
        self.assertEqual(candidate["script"]["frames"][0]["id"], fixtures.FRAME_1)
        self.assertTrue(candidate["script"]["frames"][0]["text"].endswith(" Так."))


if __name__ == "__main__":
    logging.disable(logging.CRITICAL)
    unittest.main()
