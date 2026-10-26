"""Exercise the generated source-embedding code and native Graphon HTTP node offline."""

from __future__ import annotations

import hashlib
import json
import logging
import sys
import time
import unittest
from unittest.mock import patch

import yaml

import build_source_embedding_dsl as builder
import validate_dify_dsl as validator
from graphon.entities.graph_init_params import GraphInitParams
from graphon.enums import BuiltinNodeTypes
from graphon.graph.graph import Graph
from graphon.graph_engine.command_channels.in_memory_channel import InMemoryChannel
from graphon.graph_engine.config import GraphEngineConfig
from graphon.graph_engine.graph_engine import GraphEngine
from graphon.graph_events.graph import GraphRunFailedEvent, GraphRunSucceededEvent
from graphon.http import HttpResponse
from graphon.nodes.base.node import Node
from graphon.nodes.code.limits import CodeNodeLimits
from graphon.nodes.http_request.config import build_http_request_config
from graphon.nodes.http_request.node import HttpRequestNodeDependencies
from graphon.nodes.llm.entities import LLMNodeData
from graphon.runtime.graph_runtime_state import GraphRuntimeState
from graphon.runtime.variable_pool import VariablePool
from graphon.variables.variables import SecretVariable


FIXTURE_REQUEST = {
    "schemaVersion": "source-embedding-request-v1",
    "requestId": "10000000-0000-4000-8000-000000000000",
    "task": "DOCUMENT",
    "texts": [{
        "id": "10000000-0000-4000-8000-000000000001",
        "text": "Джерело 😀: 42 мс\nУмова збережена.",
        "sha256": "5aed2f9f116f07d8bab310c8cc3dc49eee02b817ff08c2d201f1a47005111c25",
    }],
}
FIXTURE_REQUEST_HASH = "e28903c85d85b772aee7b07f818409c48bb9f9ac032981f5f851b4d615195385"
SYNTHETIC_KEY = "synthetic-google-key-never-valid"


class LocalExecutor:
    def execute(self, *, language, code, inputs):
        namespace = {"__name__": "__main__"}
        with patch.object(sys, "argv", ["sandbox"]):
            exec(compile(code, "<source-embedding-code-node>", "exec"), namespace)
        return namespace["main"](**inputs)

    def is_execution_error(self, error):
        return isinstance(error, (ValueError, TypeError))


class SyntheticModel(Node[LLMNodeData]):
    node_type = BuiltinNodeTypes.LLM

    @classmethod
    def version(cls):
        return "99"

    def _run(self):
        raise AssertionError("Embedding graph must not invoke a language model")


class FakeFiles:
    def download(self, file):
        raise AssertionError("No file should be downloaded")


class FakeToolFiles:
    def create_file_by_raw(self, **kwargs):
        raise AssertionError("No file response is expected")

    def get_file_generator_by_tool_file_id(self, _tool_file_id):
        raise AssertionError("No file response is expected")


class FakeFileReferenceFactory:
    def build_from_mapping(self, **kwargs):
        raise AssertionError("No file response is expected")


class StubGoogle:
    max_retries_exceeded_error = RuntimeError
    request_error = RuntimeError

    def __init__(self):
        self.calls = []
        self.task_types = []

    def post(self, url, **kwargs):
        self.calls.append((url, kwargs))
        request = kwargs.get("json")
        if request is None and kwargs.get("content"):
            request = json.loads(kwargs["content"])
        # Model the batch endpoint's compatibility behavior: its sizing and
        # task settings are read from the documented top-level request fields;
        # matching values nested only under embedContentConfig are ignored.
        vectors = []
        for item in request["requests"]:
            self.task_types.append(item.get("taskType"))
            dimensions = item.get("outputDimensionality", 3072)
            vector = [0.0] * dimensions
            vector[0] = 1.0
            vectors.append(vector)
        body = json.dumps({"embeddings": [{"values": vector} for vector in vectors]}, separators=(",", ":"))
        return HttpResponse(status_code=200, headers={"content-type": "application/json"}, content=body.encode("utf-8"))

    def get(self, *args, **kwargs):
        raise AssertionError("Unexpected GET request")

    def head(self, *args, **kwargs):
        raise AssertionError("Unexpected HEAD request")

    def put(self, *args, **kwargs):
        raise AssertionError("Unexpected PUT request")

    def delete(self, *args, **kwargs):
        raise AssertionError("Unexpected DELETE request")

    def patch(self, *args, **kwargs):
        raise AssertionError("Unexpected PATCH request")


class Factory:
    def __init__(self, graph_config, runtime, http_client):
        self.params = GraphInitParams(workflow_id="synthetic-source-embedding", graph_config=graph_config,
            run_context={}, call_depth=0)
        self.runtime = runtime
        self.mapping = validator._graphon_mapping("0.7.0")[0]
        self.http_client = http_client
        self.http_config = build_http_request_config()

    def create_node(self, config):
        data = config["data"]
        cls = SyntheticModel if data["type"] == "llm" else self.mapping[data["type"]][data.get("version", "1")]
        kwargs = {"graph_init_params": self.params, "graph_runtime_state": self.runtime}
        if data["type"] == "code":
            kwargs.update(code_executor=LocalExecutor(), code_limits=CodeNodeLimits(
                max_string_length=400000, max_number=1e100, min_number=-1e100, max_precision=20,
                max_depth=5, max_number_array_length=1000, max_string_array_length=30,
                max_object_array_length=30))
        if data["type"] == "http-request":
            kwargs.update(
                http_request_config=self.http_config,
                dependencies=HttpRequestNodeDependencies(
                    http_client=self.http_client,
                    file_manager=FakeFiles(),
                    file_reference_factory=FakeFileReferenceFactory(),
                    tool_file_manager_factory=lambda: FakeToolFiles(),
                ),
            )
        return cls(node_id=config["id"], data=cls.validate_node_data(data), **kwargs)


class SourceEmbeddingGraphTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.document = builder.build_document()
        cls.dsl_text = yaml.dump(cls.document, Dumper=builder.DifyDumper, allow_unicode=True,
                                 sort_keys=False, width=110)
        cls.config = cls.document["workflow"]["graph"]
        cls.nodes = {node["id"]: node["data"] for node in cls.config["nodes"]}

    def code(self, node_id):
        namespace = {"__name__": "source_embedding_code_node"}
        exec(compile(self.nodes[node_id]["code"], f"<{node_id}>", "exec"), namespace)
        return namespace["main"]

    def fixture_request(self):
        return json.dumps(FIXTURE_REQUEST, ensure_ascii=False, separators=(",", ":"))

    def make_vector(self, index=0):
        vector = [0.0] * 768
        vector[index] = 1.0
        return vector

    def test_generated_workflow_matches_builder_and_native_graphon_schema(self):
        output_path = builder.OUTPUT_PATH
        self.assertTrue(output_path.exists(), "Run build_source_embedding_dsl.py before graph tests")
        exported = yaml.safe_load(output_path.read_text(encoding="utf-8"))
        self.assertEqual(exported, self.document)
        errors, warnings = validator.validate_document(exported, graphon_mapping=validator._graphon_mapping("0.7.0")[0])
        self.assertEqual(errors, [])
        self.assertFalse(any("undeclared" in warning for warning in warnings))
        http = self.nodes["google_embeddings"]
        self.assertEqual(http["url"], "https://generativelanguage.googleapis.com/v1beta/models/gemini-embedding-001:batchEmbedContents")
        self.assertEqual(http["authorization"]["type"], "api-key")
        self.assertEqual(http["authorization"]["config"]["type"], "custom")
        self.assertEqual(http["authorization"]["config"]["header"], "x-goog-api-key")
        self.assertIn("{{#env.GOOGLE_EMBEDDING_API_KEY#}}", http["authorization"]["config"]["api_key"])
        self.assertNotIn(SYNTHETIC_KEY, self.dsl_text)
        release = builder.release_document(self.dsl_text)
        self.assertEqual(release["releaseId"], builder.RELEASE_ID)
        self.assertEqual(release["workflowDslSha256"], hashlib.sha256(self.dsl_text.encode("utf-8")).hexdigest())

    def test_request_node_hash_is_stable_across_typescript_and_python(self):
        result = self.code("validate_request")(self.fixture_request())
        self.assertEqual(result["request_hash"], FIXTURE_REQUEST_HASH)
        self.assertEqual(json.loads(result["metadata_json"])["requestHash"], FIXTURE_REQUEST_HASH)
        google_request = json.loads(result["google_request_json"])
        self.assertEqual(len(google_request["requests"]), 1)
        item = google_request["requests"][0]
        self.assertEqual(item["model"], "models/gemini-embedding-001")
        self.assertEqual(item["taskType"], "RETRIEVAL_DOCUMENT")
        self.assertEqual(item["outputDimensionality"], 768)
        self.assertEqual(item["embedContentConfig"], {
            "taskType": "RETRIEVAL_DOCUMENT", "outputDimensionality": 768, "autoTruncate": False})
        self.assertEqual(item["content"]["parts"][0]["text"], FIXTURE_REQUEST["texts"][0]["text"])
        query = dict(FIXTURE_REQUEST, task="QUERY")
        query_result = self.code("validate_request")(json.dumps(query, ensure_ascii=False))
        query_item = json.loads(query_result["google_request_json"])["requests"][0]
        self.assertEqual(query_item["taskType"], "RETRIEVAL_QUERY")
        self.assertEqual(query_item["outputDimensionality"], 768)
        self.assertEqual(query_item["embedContentConfig"]["taskType"], "RETRIEVAL_QUERY")
        self.assertEqual(query_item["embedContentConfig"]["outputDimensionality"], 768)

    def test_request_rejects_identity_hash_bound_and_shape_errors(self):
        entry = self.code("validate_request")
        valid = FIXTURE_REQUEST
        cases = []
        cases.append((json.dumps(dict(valid, unknown=True)), "REQUEST_SHAPE"))
        bad_hash = json.loads(self.fixture_request())
        bad_hash["texts"][0]["sha256"] = "0" * 64
        cases.append((json.dumps(bad_hash, ensure_ascii=False), "TEXT_HASH_MISMATCH"))
        duplicate = json.loads(self.fixture_request())
        duplicate["texts"].append(dict(duplicate["texts"][0]))
        cases.append((json.dumps(duplicate, ensure_ascii=False), "TEXT_ID"))
        too_long = json.loads(self.fixture_request())
        too_long["texts"][0]["text"] = "я" * 769
        too_long["texts"][0]["sha256"] = hashlib.sha256(too_long["texts"][0]["text"].encode()).hexdigest()
        cases.append((json.dumps(too_long, ensure_ascii=False), "TEXT_BYTES"))
        control_text = json.loads(self.fixture_request())
        control_text["texts"][0]["text"] = "bad\x01text"
        control_text["texts"][0]["sha256"] = hashlib.sha256(control_text["texts"][0]["text"].encode()).hexdigest()
        cases.append((json.dumps(control_text, ensure_ascii=False), "TEXT_CONTROL_CHARACTER"))
        with_query_batch = dict(valid, task="QUERY", texts=[*valid["texts"], dict(valid["texts"][0], id="10000000-0000-4000-8000-000000000002")])
        cases.append((json.dumps(with_query_batch, ensure_ascii=False), "QUERY_TEXT_COUNT"))
        too_many = dict(valid, texts=[dict(valid["texts"][0], id=f"10000000-0000-4000-8000-{index:012x}")
                                      for index in range(17)])
        cases.append((json.dumps(too_many, ensure_ascii=False), "TEXT_COUNT"))
        cases.append(("{\"task\":1,\"task\":2}", "DUPLICATE_JSON_KEY"))
        cases.append((json.dumps(dict(valid, task="BAD")), "TASK"))
        cases.append((json.dumps(dict(valid, requestId="not-a-uuid")), "REQUEST_ID"))
        cases.append((json.dumps(dict(valid, texts=[])), "TEXT_COUNT"))
        cases.append((self.fixture_request() + " " * 64000, "REQUEST_BYTES_LIMIT"))
        for raw, expected in cases:
            with self.subTest(expected=expected):
                with self.assertRaisesRegex(ValueError, "SOURCE_EMBEDDING_" + expected):
                    entry(raw)

    def test_document_batch_uses_full_sixteen_item_bound_and_byte_edge(self):
        request = dict(FIXTURE_REQUEST, texts=[
            {"id": f"10000000-0000-4000-8000-{index:012x}",
             "text": f"passage {index}",
             "sha256": hashlib.sha256(f"passage {index}".encode()).hexdigest()}
            for index in range(16)])
        result = self.code("validate_request")(json.dumps(request, ensure_ascii=False))
        self.assertEqual(len(json.loads(result["google_request_json"])["requests"]), 16)
        exact_bytes = dict(FIXTURE_REQUEST, texts=[dict(FIXTURE_REQUEST["texts"][0], text="😀" * 384,
            sha256=hashlib.sha256(("😀" * 384).encode()).hexdigest())])
        exact_result = self.code("validate_request")(json.dumps(exact_bytes, ensure_ascii=False))
        self.assertEqual(len(json.loads(exact_result["google_request_json"])["requests"]), 1)
        over_bytes = dict(exact_bytes, texts=[dict(exact_bytes["texts"][0], text="😀" * 385,
            sha256=hashlib.sha256(("😀" * 385).encode()).hexdigest())])
        with self.assertRaisesRegex(ValueError, "SOURCE_EMBEDDING_TEXT_BYTES"):
            self.code("validate_request")(json.dumps(over_bytes, ensure_ascii=False))

    def test_response_node_normalizes_vectors_and_preserves_order(self):
        request = json.loads(self.fixture_request())
        metadata = json.loads(self.code("validate_request")(self.fixture_request())["metadata_json"])
        texts = [{"id": request["texts"][0]["id"], "sha256": request["texts"][0]["sha256"]},
                 {"id": "10000000-0000-4000-8000-000000000002", "sha256": "1" * 64}]
        metadata["texts"] = texts
        result = self.code("validate_response")(200, json.dumps({"embeddings": [
            {"values": [2.0] + [0.0] * 767}, {"values": [0.0, 3.0] + [0.0] * 766}]}), json.dumps(metadata))
        output = json.loads(result["embedding_json"])
        self.assertEqual(output["schemaVersion"], "source-embedding-v1")
        self.assertEqual(output["requestHash"], FIXTURE_REQUEST_HASH)
        self.assertEqual([row["id"] for row in output["embeddings"]], [item["id"] for item in texts])
        self.assertEqual(output["embeddings"][0]["values"][:2], [1.0, 0.0])
        self.assertEqual(output["embeddings"][1]["values"][:2], [0.0, 1.0])
        self.assertEqual(len(result["embedding_json"]), len(result["embedding_json"].encode("utf-8")))

    def test_response_node_accepts_full_sixteen_item_output(self):
        request = dict(FIXTURE_REQUEST, texts=[
            {"id": f"10000000-0000-4000-8000-{index:012x}", "text": f"passage {index}",
             "sha256": hashlib.sha256(f"passage {index}".encode()).hexdigest()}
            for index in range(16)])
        metadata = json.loads(self.code("validate_request")(json.dumps(request, ensure_ascii=False))["metadata_json"])
        raw = json.dumps({"embeddings": [{"values": self.make_vector(index)} for index in range(16)]})
        output = json.loads(self.code("validate_response")(200, raw, json.dumps(metadata))["embedding_json"])
        self.assertEqual(len(output["embeddings"]), 16)
        self.assertEqual([row["id"] for row in output["embeddings"]], [row["id"] for row in request["texts"]])

    def test_response_node_rejects_status_count_dimension_nonfinite_and_zero(self):
        response_node = self.code("validate_response")
        metadata = json.loads(self.code("validate_request")(self.fixture_request())["metadata_json"])
        good = {"embeddings": [{"values": self.make_vector()}]}
        invalid_cases = [
            (503, json.dumps(good), "HTTP_STATUS"),
            (200, json.dumps({"embeddings": []}), "RESPONSE_COUNT"),
            (200, " " * 400001, "RESPONSE_BYTES_LIMIT"),
            (200, json.dumps({"embeddings": [{"values": [1.0] + [0.0] * 3071}]}), "VECTOR_DIMENSIONS"),
            (200, json.dumps({"embeddings": [{"values": [float("nan")] + [0.0] * 767}]}), "INVALID_RESPONSE_NUMBER"),
            (200, json.dumps({"embeddings": [{"values": [0.0] * 768}]}), "VECTOR_ZERO_NORM"),
        ]
        for status, body, expected in invalid_cases:
            with self.subTest(expected=expected):
                with self.assertRaisesRegex(ValueError, "SOURCE_EMBEDDING_" + expected):
                    response_node(status, body, json.dumps(metadata))

    def test_graphon_runs_http_against_stub_and_masks_secret_from_request_trace(self):
        for task, task_type in (("DOCUMENT", "RETRIEVAL_DOCUMENT"), ("QUERY", "RETRIEVAL_QUERY")):
            with self.subTest(task=task):
                request_obj = dict(FIXTURE_REQUEST, task=task)
                request = json.dumps(request_obj, ensure_ascii=False, separators=(",", ":"))
                expected = self.code("validate_request")(request)
                pool = VariablePool.from_bootstrap(environment_variables=[SecretVariable(
                    name="GOOGLE_EMBEDDING_API_KEY", value=SYNTHETIC_KEY,
                    selector=["env", "GOOGLE_EMBEDDING_API_KEY"])])
                pool.add(["start", "embedding_request_json"], request)
                runtime = GraphRuntimeState(variable_pool=pool, start_at=time.perf_counter())
                google = StubGoogle()
                factory = Factory(self.config, runtime, google)
                graph = Graph.init(graph_config=self.config, node_factory=factory, root_node_id="start")
                engine = GraphEngine(workflow_id="synthetic-source-embedding", graph=graph,
                    graph_runtime_state=runtime, command_channel=InMemoryChannel(),
                    config=GraphEngineConfig(min_workers=1, max_workers=1))
                events = list(engine.run())
                failures = [event.error for event in events if isinstance(event, GraphRunFailedEvent)]
                self.assertEqual(failures, [])
                succeeded = [event for event in events if isinstance(event, GraphRunSucceededEvent)]
                self.assertTrue(succeeded)
                result = json.loads(succeeded[-1].outputs["embedding_json"])
                self.assertEqual(result["requestHash"], expected["request_hash"])
                self.assertEqual(result["embeddings"][0]["values"][0], 1.0)
                self.assertEqual(len(result["embeddings"][0]["values"]), 768)
                self.assertEqual(len(google.calls), 1)
                self.assertEqual(google.task_types, [task_type])
                url, kwargs = google.calls[0]
                self.assertEqual(url, "https://generativelanguage.googleapis.com/v1beta/models/gemini-embedding-001:batchEmbedContents")
                self.assertEqual(kwargs["headers"]["x-goog-api-key"], SYNTHETIC_KEY)
                request_body = kwargs.get("json")
                if request_body is None:
                    request_body = json.loads(kwargs["content"])
                sent = request_body["requests"][0]
                self.assertEqual(sent["taskType"], task_type)
                self.assertEqual(sent["outputDimensionality"], 768)
                self.assertEqual(sent["embedContentConfig"]["taskType"], task_type)
                self.assertEqual(sent["embedContentConfig"]["outputDimensionality"], 768)
                node_events = [event for event in events if getattr(event, "node_id", None) == "google_embeddings"]
                request_logs = [str(getattr(getattr(event, "node_run_result", None), "process_data", {})) for event in node_events]
                self.assertTrue(request_logs)
                self.assertTrue(all(SYNTHETIC_KEY not in log for log in request_logs))
                self.assertTrue(any("***" in log for log in request_logs))

    def test_google_wire_shape_without_top_level_sizing_is_rejected_at_3072_dimensions(self):
        request = self.fixture_request()
        metadata = self.code("validate_request")(request)["metadata_json"]
        response = StubGoogle().post("https://example.invalid", json={"requests": [{
            "model": "models/gemini-embedding-001",
            "content": {"parts": [{"text": FIXTURE_REQUEST["texts"][0]["text"]}]},
            "embedContentConfig": {"taskType": "RETRIEVAL_DOCUMENT", "outputDimensionality": 768,
                                   "autoTruncate": False},
        }]})
        with self.assertRaisesRegex(ValueError, "SOURCE_EMBEDDING_VECTOR_DIMENSIONS"):
            self.code("validate_response")(response.status_code, response.content.decode("utf-8"), metadata)


if __name__ == "__main__":
    logging.disable(logging.CRITICAL)
    unittest.main()
