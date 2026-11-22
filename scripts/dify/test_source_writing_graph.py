"""Exercise the native source-writing graph on Graphon with synthetic replies."""
from __future__ import annotations

import copy
import hashlib
import json
import logging
import subprocess
import sys
import time
import unittest
from unittest.mock import patch

import jsonschema
import yaml

import build_source_writing_dsl as builder
import source_writing_runtime as runtime_logic
import validate_dify_dsl as validator
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
from prompt_rendering import message_text, render_messages


PREFIX = "10000000-0000-4000-8000-"
REQUEST_ID = PREFIX + "000000000001"
PASSAGE_ID = PREFIX + "000000000002"
PASSAGE_PACKET_ID = PREFIX + "000000000003"
PASSAGE_SNAPSHOT_ID = PREFIX + "000000000004"
CLAIM_ID = PREFIX + "000000000005"
CLAIM_EVIDENCE_ID = PREFIX + "000000000006"
CONTEXT_ID = PREFIX + "000000000007"
SECTION_ID = PREFIX + "000000000008"
SECTION_2_ID = PREFIX + "000000000009"
PARAGRAPH_ID = PREFIX + "000000000010"
PARAGRAPH_2_ID = PREFIX + "000000000011"
PASSAGE_QUOTE = "Під час контрольного випробування стенд витримав навантаження 42 кН протягом 15 хвилин."
CLAIM_QUOTE = "Вимірювання виконали 12 листопада 2025 року за температури 20 °C."
CLAIM_WORDING = "Контрольне вимірювання виконали 12 листопада 2025 року за температури 20 °C."
BASE_PROSE = ("У межах описаного випробування фахівці перевірили роботу стенда в контрольованих умовах. "
    + PASSAGE_QUOTE + " " + CLAIM_QUOTE + " Це окреслює межі результату й не переносить його на інші "
    "навантаження або режими. Для подальшої оцінки варто зіставити цей протокол з умовами запланованої "
    "експлуатації та окремо вказати відмінності й обмеження. Практичне значення перевірки полягає в тому, "
    "що параметри досліду відомі читачеві та можуть бути враховані під час інтерпретації наведених даних. "
    "Такий виклад залишає числові межі помітними й не перетворює один дослід на загальне правило.")
SECTION_PROSE = ("Наведений результат описує конкретне випробування стенда за заданих умов. "
    "Уривок джерела дає змогу читачеві побачити фактичний результат і не переносити його автоматично "
    "на інші режими використання. Тут важливо зберегти точні числові параметри, бо вони обмежують зміст "
    "висновку. Повний уривок містить контекст, потрібний для перевірки формулювання. Коли читач оцінює "
    "цей результат, він може зіставити його з умовами власного завдання, але таке зіставлення саме по собі "
    "не є новим підтвердженим фактом. Тому розділ описує лише наведені дані та їхні межі. "
    "У тексті варто відрізняти повідомлені факти від подальших очікувань і окремих рішень щодо застосування.")


def make_input(task: str = "ADAPTATION") -> dict:
    context_text = "Пиши короткими реченнями, не перебільшуй висновки."
    value = {
        "schemaVersion": "source-writing-input-v1", "requestId": REQUEST_ID, "task": task,
        "brief": {"topic": "Контрольне випробування стенда", "audience": "Інженери",
            "centralMessage": "Пояснити результат в його межах.", "category": "Технічна стаття",
            "tone": "Чітко й без перебільшень", "targetLength": 100,
            "cta": "", "exclusions": ["Не узагальнювати один дослід."], "notes": "Лише доречні деталі."},
        "style": {"brandbook": "", "tone": "", "settings": {
            "small": 1e-6, "large": 1e21, "surrogate-safe-order": "😀"}},
        "context": [{"snapshotId": CONTEXT_ID, "purpose": "NOTES",
            "sha256": hashlib.sha256(context_text.encode("utf-8")).hexdigest(), "text": context_text}],
        "passages": [{"id": PASSAGE_ID, "packetId": PASSAGE_PACKET_ID,
            "snapshotId": PASSAGE_SNAPSHOT_ID, "quote": PASSAGE_QUOTE}],
        "requiredClaims": [{"claimRevisionId": CLAIM_ID, "wording": CLAIM_WORDING,
            "evidence": [{"evidenceId": CLAIM_EVIDENCE_ID, "quote": CLAIM_QUOTE}]}],
    }
    if task == "SECTION":
        value["requiredClaims"] = []
        value["section"] = {"id": SECTION_ID, "title": "Результат випробування",
            "purpose": "Описати підтверджений результат і його умови.", "targetWords": 100}
        value["approvedOutline"] = {"title": "Перевірка стенда", "sections": [
            {"id": SECTION_ID, "title": "Результат випробування",
             "purpose": "Описати підтверджений результат і його умови.", "targetWords": 100}]}
    elif task == "ADAPTATION":
        value["format"] = "TELEGRAM_POST"
    return value


def internal_paragraph(ident=PARAGRAPH_ID, text=BASE_PROSE):
    return {"id": ident, "text": text, "citations": [
        {"kind": "source_passage", "passageId": PASSAGE_ID, "claimRevisionId": "", "evidenceId": "",
         "quote": PASSAGE_QUOTE, "assertionText": PASSAGE_QUOTE},
        {"kind": "approved_claim", "passageId": "", "claimRevisionId": CLAIM_ID,
         "evidenceId": CLAIM_EVIDENCE_ID, "quote": CLAIM_QUOTE, "assertionText": CLAIM_QUOTE},
    ]}


def writer_result(task, *, malformed=False):
    result = {"task": task, "title": "", "sectionId": "", "sections": [], "paragraphs": [],
        "sectionParagraphs": [],"frames": [],"coverInstruction": ""}
    if task == "OUTLINE":
        result.update({"title": "Перевірка стенда", "sections": [{
            "id": SECTION_ID, "title": "Результат випробування",
            "purpose": "Показати підтверджений результат і межі застосування.", "targetWords": 100,
            "passageIds": [PASSAGE_ID], "requiredClaimRevisionIds": [CLAIM_ID]}]})
    else:
        if task == "SECTION":
            result["sectionId"] = SECTION_ID
        if task == "SECTION" and not malformed:
            result["sectionParagraphs"] = [{"text": SECTION_PROSE, "passageIndex": 0}]
        else:
            result["paragraphs"] = [internal_paragraph()]
        if malformed:
            if task == "SECTION":
                result["sectionParagraphs"] = [{"text": SECTION_PROSE, "passageIndex": 1000}]
            else:
                result["paragraphs"][0]["citations"][0]["quote"] = "вигаданий уривок"
    return result


def model_request(node):
    messages = render_messages(node.node_data, node.graph_runtime_state.variable_pool)
    user = next(message_text(message) for message in messages if message.role.value == "user")
    prefix, suffix = "<writing_request>\n", "\n</writing_request>"
    if not user.startswith(prefix) or not user.endswith(suffix):
        raise ValueError("Writing request Jinja template did not render its explicit selector")
    return json.loads(user[len(prefix):-len(suffix)])


class LocalExecutor:
    def execute(self, *, language, code, inputs):
        namespace = {"__name__": "__main__"}
        with patch.object(sys, "argv", ["sandbox"]):
            exec(compile(code, "<source-writing-code-node>", "exec"), namespace)
        return namespace["main"](**inputs)

    def is_execution_error(self, error):
        return isinstance(error, (ValueError, TypeError))


class SyntheticModel(Node[LLMNodeData]):
    node_type = BuiltinNodeTypes.LLM

    @classmethod
    def version(cls):
        return "99"

    def _run(self):
        raw = self.graph_init_params.run_context["scenario"].respond(self)
        jsonschema.Draft7Validator(self.node_data.structured_output["schema"]).validate(raw)
        return NodeRunResult(status=WorkflowNodeExecutionStatus.SUCCEEDED,
            outputs={"text": json.dumps(raw, ensure_ascii=False), "structured_output": raw})


class Scenario:
    def __init__(self, input_value=None, mode="ready"):
        self.input = input_value or make_input()
        self.mode = mode
        self.counts = {}
        self.requests = {}

    def respond(self, node):
        self.counts[node.id] = self.counts.get(node.id, 0) + 1
        request = model_request(node)
        self.requests[node.id] = request
        if node.id == "writer":
            self.assert_untrusted_data_remains_opaque(request)
            result = writer_result(self.input["task"], malformed=self.mode == "bad-citation")
            if self.input["task"] == "SECTION" and self.mode in ("section-short", "section-missing-detail"):
                result["sectionParagraphs"][0]["text"] = "Навантаження стенда становило 42 кН."
            if self.input["task"] == "SECTION" and self.mode == "section-water":
                result["sectionParagraphs"][0]["text"] = SECTION_PROSE + " " + SECTION_PROSE
            if self.input["task"] == "SECTION" and self.mode == "bad-section-index":
                result["sectionParagraphs"][0]["passageIndex"] = 9
            if self.input["task"] == "SECTION" and self.mode in ("extra-section-fields", "extra-fields-invalid-section"):
                result["task"] = "OUTLINE"
                result["title"] = "Зайвий заголовок"
                result["sections"] = writer_result("OUTLINE")["sections"]
                result["paragraphs"] = [internal_paragraph()]
                result["coverInstruction"] = "Зайва інструкція до обкладинки"
                if self.mode == "extra-fields-invalid-section":
                    result["sectionParagraphs"][0]["passageIndex"] = 9
            if self.input.get("format") in ("LINKEDIN_CAROUSEL","INSTAGRAM_CAROUSEL","INSTAGRAM_STORIES"):
                result["frames"] = [{**internal_paragraph(PARAGRAPH_2_ID),"purpose": "Результат", "visualHint": "Схема стенда",
                    "transition": "Завершення" if self.input["format"] == "INSTAGRAM_STORIES" else ""}]
            if self.input.get("format") in ("LINKEDIN_COVER","INSTAGRAM_COVER"):
                result["title"] = "Випробування стенда"
                result["coverInstruction"] = "Стримана схема стенда без додаткових чисел."
            if self.mode == "overlap-citations" and result["paragraphs"]:
                result["paragraphs"][0]["citations"][1]["assertionText"] = PASSAGE_QUOTE
            return result
        if node.id == "reviewer":
            if self.mode == "stale-review":
                reviewed_hash = "0" * 64
            else:
                reviewed_hash = request["reviewedHash"]
            if self.mode in ("repair", "unresolved", "frame-repair", "section-repair", "section-missing-detail", "section-water"):
                target = request["content"]["frames" if self.mode == "frame-repair" else "paragraphs"][0]["id"]
                return {"reviewedHash": reviewed_hash, "status": "needs_human", "issues": [{
                    "id": "unsupported-inference", "severity": "major", "paragraphId": target,
                    "sectionId": "", "reason": ("Додайте підтверджену тривалість випробування, потрібну для цього результату."
                        if self.mode == "section-missing-detail" else "Приберіть повтор і воду."
                        if self.mode == "section-water" else "Приберіть непідтверджене узагальнення.")}], "reasons": []}
            return {"reviewedHash": reviewed_hash, "status": "ready", "issues": [], "reasons": []}
        if node.id == "repairer":
            replacements = []
            section_replacements = []
            for issue in request["issues"]:
                target_id = issue["paragraphId"]
                original = next(row for row in request["content"]["paragraphs"]+request["content"].get("frames",[]) if row["id"] == target_id)
                if self.input["task"] == "SECTION" and not self.input["requiredClaims"]:
                    section_replacements.append({"paragraphId": target_id, "text": SECTION_PROSE,
                                                 "passageIndex": 0})
                    continue
                revised = {key: copy.deepcopy(original[key]) for key in ("id","text","citations")}
                revised["text"] = revised["text"].replace(
                    "не перетворює один дослід на загальне правило", "не слід переносити цей результат на інші режими")
                revised["citations"] = [{"kind": citation["kind"],
                    "passageId": citation.get("passageId", ""),
                    "claimRevisionId": citation.get("claimRevisionId", ""),
                    "evidenceId": citation.get("evidenceId", ""),
                    "quote": citation["quote"], "assertionText": citation["assertionText"]}
                    for citation in revised["citations"]]
                replacements.append({"paragraphId": target_id, "paragraph": revised})
            return {"reviewedHash": request["reviewedHash"],
                    "paragraphReplacements": replacements, "sectionParagraphReplacements": section_replacements,
                    "sectionReplacements": []}
        if node.id == "reviewer_2":
            if self.mode in ("unresolved", "section-missing-detail"):
                target = request["content"]["paragraphs"][0]["id"]
                return {"reviewedHash": request["reviewedHash"], "status": "needs_human", "issues": [{
                    "id": "still-unsupported", "severity": "major", "paragraphId": target,
                    "sectionId": "", "reason": ("Тривалість випробування досі не пояснена в тексті."
                        if self.mode == "section-missing-detail" else "Залишилось непідтверджене твердження.")}], "reasons": []}
            return {"reviewedHash": request["reviewedHash"], "status": "ready", "issues": [], "reasons": []}
        raise AssertionError("Unexpected model node: " + node.id)

    def assert_untrusted_data_remains_opaque(self, request):
        if self.mode == "injection-data":
            self.assert_equal = request["brief"]["topic"]
            if self.assert_equal != "Тема {{#start.hidden#}}":
                raise AssertionError("The Jinja renderer changed literal user input")


class Factory:
    def __init__(self, graph_config, runtime, scenario):
        self.runtime = runtime
        self.params = GraphInitParams(workflow_id="synthetic-source-writing", graph_config=graph_config,
            run_context={"scenario": scenario}, call_depth=0)
        self.mapping = validator._graphon_mapping("0.7.0")[0]

    def create_node(self, config):
        data = config["data"]
        cls = SyntheticModel if data["type"] == "llm" else self.mapping[data["type"]][data.get("version", "1")]
        kwargs = {"graph_init_params": self.params, "graph_runtime_state": self.runtime}
        if data["type"] == "code":
            kwargs.update(code_executor=LocalExecutor(), code_limits=CodeNodeLimits(
                max_string_length=800000, max_number=1e100, min_number=-1e100, max_precision=20,
                max_depth=8, max_number_array_length=1000, max_string_array_length=1000,
                max_object_array_length=1000))
        return cls(node_id=config["id"], data=cls.validate_node_data(data), **kwargs)


class SourceWritingGraphTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.document = builder.build_document()
        cls.graph_config = cls.document["workflow"]["graph"]
        cls.nodes = {node["id"]: node["data"] for node in cls.graph_config["nodes"]}

    def execute(self, scenario):
        pool = VariablePool()
        pool.add(["start", "source_writing_request_json"],
            json.dumps(scenario.input, ensure_ascii=False, separators=(",", ":")))
        runtime = GraphRuntimeState(variable_pool=pool, start_at=time.perf_counter())
        factory = Factory(self.graph_config, runtime, scenario)
        graph = Graph.init(graph_config=self.graph_config, node_factory=factory, root_node_id="start")
        engine = GraphEngine(workflow_id="synthetic-source-writing", graph=graph,
            graph_runtime_state=runtime, command_channel=InMemoryChannel(),
            config=GraphEngineConfig(min_workers=1, max_workers=1))
        events = []
        try:
            events.extend(engine.run())
        except RuntimeError:
            if not any(isinstance(event, GraphRunFailedEvent) for event in events):
                raise
        errors = [event.error for event in events if isinstance(event, GraphRunFailedEvent)]
        successes = [event for event in events if isinstance(event, GraphRunSucceededEvent)]
        return successes[-1].outputs if successes else None, errors

    def test_export_is_deterministic_and_valid_for_graphon_070(self):
        self.assertTrue(builder.OUTPUT_PATH.exists(), "Run build_source_writing_dsl.py before graph tests")
        exported = yaml.safe_load(builder.OUTPUT_PATH.read_text(encoding="utf-8"))
        self.assertEqual(exported, self.document)
        errors, warnings = validator.validate_document(exported,
            graphon_mapping=validator._graphon_mapping("0.7.0")[0])
        self.assertEqual(errors, [])
        self.assertFalse(any("undeclared" in warning for warning in warnings))
        self.assertIn("source_writing_request_json", [item["variable"] for item in self.nodes["start"]["variables"]])
        self.assertNotIn("maxItems", json.dumps([node["data"].get("structured_output")
            for node in self.document["workflow"]["graph"]["nodes"]], ensure_ascii=False))

    def test_release_descriptor_hashes_all_local_source_artifacts(self):
        release = json.loads(builder.RELEASE_PATH.read_text(encoding="utf-8"))
        unsigned = dict(release)
        config_digest = unsigned.pop("configDigest")
        self.assertEqual(release["releaseId"], "source-writing-2026-11-22.1")
        self.assertEqual(release["target"], {"difyVersion": "1.17.1", "graphonVersion": "0.7.0", "dslVersion": "0.7.0"})
        self.assertEqual(release["publishedWorkflowIdEnv"], "DIFY_SOURCE_WRITING_PUBLISHED_WORKFLOW_ID")
        self.assertEqual(hashlib.sha256(builder.canonical(unsigned).encode("utf-8")).hexdigest(), config_digest)
        self.assertEqual(hashlib.sha256(builder.OUTPUT_PATH.read_bytes()).hexdigest(), release["workflowDslSha256"])
        self.assertEqual(hashlib.sha256((builder.DIRECTORY / "prompt.md").read_bytes()).hexdigest(), release["promptSha256"])
        self.assertEqual(hashlib.sha256(builder.RUNTIME.read_bytes()).hexdigest(), release["runtimeSha256"])

    def test_ready_outline_section_and_adaptation_use_the_contract_shapes(self):
        for task in ("OUTLINE", "SECTION", "ADAPTATION"):
            with self.subTest(task=task):
                scenario = Scenario(make_input(task))
                outputs, errors = self.execute(scenario)
                self.assertEqual(errors, [])
                result = json.loads(outputs["source_writing_json"])
                self.assertEqual(result["task"], task)
                self.assertEqual(result["status"], "ready")
                self.assertEqual(result["review"]["modelCalls"], 2)
                self.assertEqual(result["review"]["status"], "ready")
                if task == "OUTLINE":
                    self.assertEqual(result["content"]["sections"][0]["requiredClaimRevisionIds"], [CLAIM_ID])
                elif task == "SECTION":
                    paragraph = result["content"]["paragraphs"][0]
                    self.assertEqual(paragraph["citations"], [{"kind": "source_passage", "passageId": PASSAGE_ID,
                        "quote": PASSAGE_QUOTE, "assertionText": paragraph["text"]}])
                    self.assertEqual(result["content"]["sectionId"], SECTION_ID)
                else:
                    self.assertEqual(result["content"]["paragraphs"][0]["citations"][0]["quote"], PASSAGE_QUOTE)
                self.assertEqual(json.loads(outputs["source_writing_report"])["status"], "ready")

    def test_section_passage_index_is_bound_to_frozen_order_and_quote_is_server_built(self):
        scenario = Scenario(make_input("SECTION"))
        outputs, errors = self.execute(scenario)
        self.assertEqual(errors, [])
        result = json.loads(outputs["source_writing_json"])
        self.assertEqual(result["status"], "ready")
        request = scenario.requests["writer"]
        self.assertEqual(request["sectionWordRange"], {"minimum": 80, "maximum": 120})
        self.assertEqual(request["paragraphEvidenceMode"].startswith("one supplied passage"), True)
        self.assertEqual(result["content"]["paragraphs"][0]["citations"][0]["quote"], request["passages"][0]["quote"])
        self.assertEqual(result["content"]["paragraphs"][0]["citations"][0]["assertionText"], SECTION_PROSE)
        bad, errors = self.execute(Scenario(make_input("SECTION"), "bad-section-index"))
        self.assertEqual(errors, [])
        rejected = json.loads(bad["source_writing_json"])
        self.assertEqual(rejected["status"], "needs_human")
        self.assertIsNone(rejected["content"])

    def test_section_word_range_is_guidance_and_reviewer_decides_content_quality(self):
        concise_scenario = Scenario(make_input("SECTION"), "section-short")
        concise, errors = self.execute(concise_scenario)
        self.assertEqual(errors, [])
        accepted = json.loads(concise["source_writing_json"])
        self.assertEqual(accepted["status"], "ready")
        text = accepted["content"]["paragraphs"][0]["text"]
        self.assertLess(len(text.split()), 80)
        self.assertEqual(accepted["review"]["modelCalls"], 2)
        self.assertEqual(accepted["content"]["paragraphs"][0]["citations"][0]["quote"], PASSAGE_QUOTE)
        self.assertEqual(concise_scenario.requests["reviewer"]["sectionWordRange"],
                         {"minimum": 80, "maximum": 120})

        insufficient, errors = self.execute(Scenario(make_input("SECTION"), "section-missing-detail"))
        self.assertEqual(errors, [])
        flagged = json.loads(insufficient["source_writing_json"])
        self.assertEqual(flagged["status"], "needs_human")
        self.assertIsNone(flagged["content"])
        self.assertEqual(flagged["review"]["modelCalls"], 4)

        water_scenario = Scenario(make_input("SECTION"), "section-water")
        water, errors = self.execute(water_scenario)
        self.assertEqual(errors, [])
        trimmed = json.loads(water["source_writing_json"])
        self.assertEqual(trimmed["status"], "ready")
        reviewed_text = water_scenario.requests["reviewer"]["content"]["paragraphs"][0]["text"]
        self.assertGreater(len(reviewed_text.split()), 120)
        self.assertEqual(trimmed["content"]["paragraphs"][0]["text"], SECTION_PROSE)
        self.assertEqual(trimmed["review"]["modelCalls"], 4)

    def test_unrelated_section_fields_are_discarded_before_review(self):
        outputs, errors = self.execute(Scenario(make_input("SECTION"), "extra-section-fields"))
        self.assertEqual(errors, [])
        result = json.loads(outputs["source_writing_json"])
        self.assertEqual(result["status"], "ready")
        self.assertEqual(result["review"]["modelCalls"], 2)
        self.assertEqual(set(result["content"]), {"sectionId", "paragraphs"})
        self.assertEqual(result["content"]["paragraphs"][0]["citations"][0]["quote"], PASSAGE_QUOTE)

        outputs, errors = self.execute(Scenario(make_input("SECTION"), "extra-fields-invalid-section"))
        self.assertEqual(errors, [])
        rejected = json.loads(outputs["source_writing_json"])
        self.assertEqual(rejected["status"], "needs_human")
        self.assertIsNone(rejected["content"])

    def test_indexed_section_patch_preserves_paragraph_identity_and_rechecks_draft(self):
        scenario = Scenario(make_input("SECTION"), "section-repair")
        outputs, errors = self.execute(scenario)
        self.assertEqual(errors, [])
        result = json.loads(outputs["source_writing_json"])
        self.assertEqual(result["status"], "ready")
        self.assertEqual(result["review"]["modelCalls"], 4)
        original = scenario.requests["reviewer"]["content"]["paragraphs"][0]
        repaired = result["content"]["paragraphs"][0]
        self.assertEqual(repaired["id"], original["id"])
        self.assertEqual(repaired["citations"][0]["quote"], PASSAGE_QUOTE)
        self.assertEqual(scenario.counts, {"writer": 1, "reviewer": 1, "repairer": 1, "reviewer_2": 1})

    def test_all_channel_formats_have_exact_cover_or_reviewed_script_shape(self):
        for format_name in sorted(runtime_logic.FORMATS):
            with self.subTest(format=format_name):
                request = make_input("ADAPTATION")
                request["format"] = format_name
                scenario = Scenario(request)
                outputs, errors = self.execute(scenario)
                self.assertEqual(errors, [])
                result = json.loads(outputs["source_writing_json"])
                self.assertEqual(result["status"], "ready")
                scripted = format_name in ("LINKEDIN_CAROUSEL","INSTAGRAM_CAROUSEL","INSTAGRAM_STORIES")
                self.assertEqual(bool(result["content"].get("frames")),scripted)
                if scripted:
                    self.assertEqual(result["content"]["frames"][0]["citations"][0]["quote"],PASSAGE_QUOTE)
                    self.assertEqual(scenario.requests["reviewer"]["content"]["frames"],result["content"]["frames"])
                self.assertEqual(bool(result["content"].get("coverInstruction")),format_name.endswith("COVER"))

    def test_frame_repair_preserves_caption_frame_identity_and_designer_metadata(self):
        request = make_input("ADAPTATION")
        request["format"] = "INSTAGRAM_STORIES"
        scenario = Scenario(request,"frame-repair")
        outputs, errors = self.execute(scenario)
        self.assertEqual(errors, [])
        result = json.loads(outputs["source_writing_json"])
        self.assertEqual(result["status"],"ready")
        self.assertEqual(result["review"]["modelCalls"],4)
        original = scenario.requests["reviewer"]["content"]
        self.assertEqual(original["paragraphs"],result["content"]["paragraphs"])
        for key in ("id","purpose","visualHint","transition"):
            self.assertEqual(original["frames"][0][key],result["content"]["frames"][0][key])
        self.assertIn("не слід переносити цей результат",result["content"]["frames"][0]["text"])

    def test_one_flagged_paragraph_gets_one_patch_and_second_independent_review(self):
        scenario = Scenario(make_input("ADAPTATION"), "repair")
        outputs, errors = self.execute(scenario)
        self.assertEqual(errors, [])
        result = json.loads(outputs["source_writing_json"])
        self.assertEqual(result["status"], "ready")
        self.assertEqual(result["review"]["modelCalls"], 4)
        self.assertEqual(scenario.counts, {"writer": 1, "reviewer": 1, "repairer": 1, "reviewer_2": 1})
        self.assertIn("не слід переносити цей результат", result["content"]["paragraphs"][0]["text"])

    def test_unresolved_review_returns_no_candidate_and_stale_review_fails_closed(self):
        unresolved, errors = self.execute(Scenario(make_input("ADAPTATION"), "unresolved"))
        self.assertEqual(errors, [])
        result = json.loads(unresolved["source_writing_json"])
        self.assertEqual(result["status"], "needs_human")
        self.assertIsNone(result["content"])
        stale, errors = self.execute(Scenario(make_input("ADAPTATION"), "stale-review"))
        self.assertEqual(errors, [])
        result = json.loads(stale["source_writing_json"])
        self.assertEqual(result["status"], "needs_human")
        self.assertIsNone(result["content"])

    def test_no_evidence_and_invalid_exact_locator_return_no_candidate(self):
        no_evidence = make_input("ADAPTATION")
        no_evidence["passages"] = []
        no_evidence["requiredClaims"] = []
        outputs, errors = self.execute(Scenario(no_evidence))
        self.assertEqual(errors, [])
        result = json.loads(outputs["source_writing_json"])
        self.assertEqual(result["status"], "insufficient_evidence")
        self.assertEqual(result["review"]["modelCalls"], 0)
        invalid, errors = self.execute(Scenario(make_input("ADAPTATION"), "bad-citation"))
        self.assertEqual(errors, [])
        result = json.loads(invalid["source_writing_json"])
        self.assertEqual(result["status"], "needs_human")
        self.assertIsNone(result["content"])
        overlap, errors = self.execute(Scenario(make_input("ADAPTATION"), "overlap-citations"))
        self.assertEqual(errors, [])
        result = json.loads(overlap["source_writing_json"])
        self.assertEqual(result["status"], "needs_human")
        self.assertIsNone(result["content"])

    def test_input_context_hash_and_task_boundaries_are_checked_in_code_node(self):
        namespace = {"__name__": "source_writing_code_node"}
        exec(compile(self.nodes["prepare"]["code"], "<prepare-code-node>", "exec"), namespace)
        prepare = namespace["main"]
        derived = make_input("ADAPTATION")
        derived["approvedArticle"] = {"versionId": SECTION_ID, "sha256": "a" * 64,
                                      "title": "Схвалена стаття", "text": BASE_PROSE}
        outputs, errors = self.execute(Scenario(derived))
        self.assertEqual(errors, [])
        self.assertEqual(json.loads(outputs["source_writing_json"])["status"], "ready")
        wrong_article = make_input("OUTLINE")
        wrong_article["approvedArticle"] = derived["approvedArticle"]
        with self.assertRaisesRegex(ValueError, "TASK_FIELDS"):
            prepare(source_writing_request_json=json.dumps(wrong_article, ensure_ascii=False))
        request = make_input()
        bad_hash = copy.deepcopy(request)
        bad_hash["context"][0]["sha256"] = "0" * 64
        with self.assertRaisesRegex(ValueError, "STYLE_CONTEXT_HASH_MISMATCH"):
            prepare(source_writing_request_json=json.dumps(bad_hash, ensure_ascii=False))
        wrong_fields = make_input("ADAPTATION")
        wrong_fields["section"] = {"id": SECTION_ID, "title": "T", "purpose": "P", "targetWords": 100}
        with self.assertRaisesRegex(ValueError, "TASK_FIELDS"):
            prepare(source_writing_request_json=json.dumps(wrong_fields, ensure_ascii=False))
        extra_section_field = make_input("SECTION")
        extra_section_field["section"]["passageIds"] = []
        with self.assertRaisesRegex(ValueError, "OBJECT_SHAPE"):
            prepare(source_writing_request_json=json.dumps(extra_section_field, ensure_ascii=False))
        mismatched_section = make_input("SECTION")
        mismatched_section["section"]["purpose"] = "Змінена мета"
        with self.assertRaisesRegex(ValueError, "SECTION_NOT_MATCHED_TO_OUTLINE"):
            prepare(source_writing_request_json=json.dumps(mismatched_section, ensure_ascii=False))

        request_json = json.dumps(request, ensure_ascii=False, separators=(",", ":"))
        javascript = r'''const crypto = require("node:crypto");
const input = JSON.parse(require("node:fs").readFileSync(0, "utf8"));
function canonical(value) {
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  if (value !== null && typeof value === "object") return "{" + Object.keys(value).sort()
    .map(key => JSON.stringify(key) + ":" + canonical(value[key])).join(",") + "}";
  return JSON.stringify(value);
}
process.stdout.write(crypto.createHash("sha256").update(canonical(input), "utf8").digest("hex"));'''
        js_hash = subprocess.run(["node", "-e", javascript], input=request_json, text=True,
            encoding="utf-8", capture_output=True, check=True).stdout
        prepared = json.loads(prepare(source_writing_request_json=request_json)["state_json"])
        self.assertEqual(prepared["inputHash"], js_hash)

    def test_json_canonical_number_rendering_matches_javascript(self):
        self.assertEqual(runtime_logic.canonical({"z": 1.0, "a": [1e-7, 1e-6, 1e20, 1e21], "emoji": "😀"}),
            '{"a":[1e-7,0.000001,100000000000000000000,1e+21],"emoji":"😀","z":1}')
        self.assertFalse(runtime_logic.exactly_once("aaa", "aa"),
            "Citation locators must reject overlapping duplicate matches like JavaScript indexOf.")


if __name__ == "__main__":
    logging.disable(logging.CRITICAL)
    unittest.main()
