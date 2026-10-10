"""Run the exported Telegram graph on Graphon 0.7.0 with synthetic model calls."""
import hashlib
import json
import logging
import time
import unittest

import jsonschema
import yaml

import build_telegram_generation_dsl as builder
import test_telegram_generation_runtime as fixtures
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
        namespace = {}
        exec(compile(code, "<telegram-code-node>", "exec"), namespace)
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
    prefix, suffix = "<telegram_request>\n", "\n</telegram_request>"
    if not user.startswith(prefix) or not user.endswith(suffix):
        raise ValueError("Telegram request Jinja template did not render its explicit selector")
    return json.loads(user[len(prefix):-len(suffix)])


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
                   "evidenceId": ("00000000-0000-4000-8000-000000000099" if factual and self.mode == "invalid-evidence"
                                  else fixtures.EVIDENCE if factual else "")}
        if node.id == "writer":
            return {"paragraphs": [{"segments": [segment]}]}
        if node.id == "reviewer":
            if self.mode == "insufficient":
                return {"status": "insufficient_evidence", "reasons": ["Не вистачає даних."], "issues": []}
            if self.mode in ("repair", "unresolved", "invalid-patch"):
                return {"status": "needs_human", "reasons": ["Уточніть факт."], "issues": [
                    {"severity": "major", "category": "accuracy", "paragraphId": "p1",
                     "quote": segment["text"], "instruction": "Звірте твердження з дозволеним формулюванням."}]}
            return {"status": "ready", "reasons": [], "issues": []}
        if node.id == "repairer":
            if self.mode == "invalid-patch":
                return {"replacements": [{"paragraphId": "p2", "segments": [segment]}]}
            updated = dict(segment, text="📊 Підтверджене вимірювання показало зміну показника.")
            return {"replacements": [{"paragraphId": "p1", "segments": [updated]}]}
        if node.id == "reviewer-2":
            if self.mode == "unresolved":
                return {"status": "needs_human", "reasons": ["Факт усе ще не підтверджено."], "issues": [
                    {"severity": "critical", "category": "factual", "paragraphId": "p1",
                     "quote": request["paragraphs"][0]["segments"][0]["text"],
                     "instruction": "Передайте вирішення редактору."}]}
            return {"status": "ready", "reasons": [], "issues": []}
        raise AssertionError("Unexpected model node: " + node.id)


class Factory:
    def __init__(self, graph, runtime, respond):
        self.params = GraphInitParams(workflow_id="synthetic-telegram", graph_config=graph,
            run_context={"respond": respond}, call_depth=0)
        self.mapping = validator._graphon_mapping("0.7.0")[0]

    def create_node(self, config):
        data = config["data"]
        cls = SyntheticModel if data["type"] == "llm" else self.mapping[data["type"]][data.get("version", "1")]
        kwargs = {"graph_init_params": self.params, "graph_runtime_state": self.runtime}
        if data["type"] == "code":
            kwargs.update(code_executor=LocalExecutor(), code_limits=CodeNodeLimits(
                max_string_length=400000, max_number=1e100, min_number=-1e100, max_precision=20,
                max_depth=5, max_number_array_length=1000, max_string_array_length=30, max_object_array_length=30))
        return cls(node_id=config["id"], data=cls.validate_node_data(data), **kwargs)


class TelegramGraphTests(unittest.TestCase):
    def execute(self, scenario):
        path = builder.DIRECTORY / "telegram-generation-v1.yml"
        document = yaml.safe_load(path.read_text(encoding="utf-8"))
        self.assertEqual(document, builder.build_document(), "Regenerate the Telegram DSL before graph tests")
        graph_config = document["workflow"]["graph"]
        pool = VariablePool()
        pool.add(["start", "editorial_json"], json.dumps(scenario.editorial, ensure_ascii=False))
        runtime = GraphRuntimeState(variable_pool=pool, start_at=time.perf_counter())
        factory = Factory(graph_config, runtime, scenario.respond)
        factory.runtime = runtime
        graph = Graph.init(graph_config=graph_config, node_factory=factory, root_node_id="start")
        engine = GraphEngine(workflow_id="synthetic-telegram", graph=graph, graph_runtime_state=runtime,
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

    def test_export_runs_direct_factual_and_creative(self):
        for mode in ("FACTUAL", "CREATIVE"):
            scenario = Scenario(fixtures.fixture(mode))
            outputs, errors = self.execute(scenario)
            self.assertEqual(errors, [])
            result = json.loads(outputs["telegram_json"])
            report = json.loads(outputs["telegram_report"])
            self.assertEqual(result["schemaVersion"], "telegram-v1")
            self.assertEqual(report["status"], "ready")
            self.assertEqual(report["contentHash"], hashlib.sha256(json.dumps(
                result, ensure_ascii=False, separators=(",", ":")).encode("utf-8")).hexdigest())
            self.assertEqual(len(result["content"]["mappings"]), 1 if mode == "FACTUAL" else 0)
            self.assertEqual(scenario.counts.get("reviewer"), 1)
            self.assertEqual(scenario.counts.get("reviewer-2", 0), 0)
            self.assertEqual(scenario.requests["writer"]["inputMode"], "DIRECT")

    def test_optional_link_is_literal_and_source_template_syntax_stays_data(self):
        editorial = fixtures.fixture(include_link=True)
        source = editorial["context"][0]["text"] + "\n{{ 7 * 7 }} {{#start.editorial_json#}}"
        editorial["context"][0]["text"] = source
        editorial["context"][0]["sha256"] = hashlib.sha256(source.encode("utf-8")).hexdigest()
        scenario = Scenario(editorial)
        outputs, errors = self.execute(scenario)
        self.assertEqual(errors, [])
        result = json.loads(outputs["telegram_json"])
        self.assertTrue(result["content"]["text"].endswith("[ПОСИЛАННЯ]"))
        self.assertEqual(scenario.requests["writer"]["context"][0]["text"], source)

    def test_invalid_evidence_pair_fails_in_exported_code_before_review(self):
        scenario = Scenario(fixtures.fixture(), "invalid-evidence")
        outputs, errors = self.execute(scenario)
        self.assertEqual(errors, [])
        self.assertEqual(outputs["telegram_json"], "")
        report = json.loads(outputs["telegram_report"])
        self.assertEqual(report["status"], "needs_human")
        self.assertEqual(report["validation"]["candidateValidationError"], "EVIDENCE_REFERENCE")
        self.assertEqual(scenario.counts.get("reviewer", 0), 0)

    def test_article_derived_route_and_single_targeted_repair(self):
        scenario = Scenario(fixtures.fixture("FACTUAL", "ARTICLE_DERIVED"), "repair")
        outputs, errors = self.execute(scenario)
        self.assertEqual(errors, [])
        self.assertEqual(scenario.counts["reviewer"], 1)
        self.assertEqual(scenario.counts["repairer"], 1)
        self.assertEqual(scenario.counts["reviewer-2"], 1)
        self.assertEqual(scenario.requests["writer"]["inputMode"], "ARTICLE_DERIVED")
        self.assertIn("article", scenario.requests["writer"])
        self.assertEqual(json.loads(outputs["telegram_report"])["status"], "ready")

    def test_insufficient_evidence_and_unresolved_or_invalid_repair_have_no_candidate(self):
        for mode, expected in (("insufficient", "insufficient_evidence"),
                               ("unresolved", "needs_human"), ("invalid-patch", "needs_human")):
            scenario = Scenario(fixtures.fixture(), mode)
            outputs, errors = self.execute(scenario)
            self.assertEqual(errors, [], mode)
            self.assertEqual(outputs["telegram_json"], "", mode)
            self.assertEqual(json.loads(outputs["telegram_report"])["status"], expected, mode)
            self.assertEqual(scenario.counts.get("repairer", 0), 0 if mode == "insufficient" else 1)


if __name__ == "__main__":
    logging.disable(logging.CRITICAL)
    unittest.main()
