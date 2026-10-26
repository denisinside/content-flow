#!/usr/bin/env python3
"""Build the importable ContentFlow Google source-embedding Dify workflow."""

from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
from typing import Any

import yaml

import build_claim_extraction_dsl as base


ROOT = Path(__file__).resolve().parents[2]
WORKFLOW_DIR = ROOT / "packages/backend/src/evidence/workflows/source-embedding"
OUTPUT_PATH = WORKFLOW_DIR / "source-embedding-v1.yml"
RELEASE_PATH = WORKFLOW_DIR / "release.json"
DSL_VERSION = "0.7.0"
TARGET = {"difyVersion": "1.17.1", "graphonVersion": "0.7.0", "dslVersion": DSL_VERSION}
RELEASE_ID = "source-embedding-2026-10-20.1"
MODEL = "gemini-embedding-001"
DIMENSIONS = 768
DOCUMENT_TASK_TYPE = "RETRIEVAL_DOCUMENT"
QUERY_TASK_TYPE = "RETRIEVAL_QUERY"


REQUEST_CODE = r'''import hashlib
import json
import re
import uuid

MAX_REQUEST_BYTES = 64000
MAX_TEXTS = 16
MAX_TEXT_CHARS = 4000
MAX_TEXT_BYTES = 1536
MAX_TOTAL_TEXT_BYTES = 64000

def fail(code):
    raise ValueError("SOURCE_EMBEDDING_" + code)

def unique_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            fail("DUPLICATE_JSON_KEY")
        result[key] = value
    return result

def canonical(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False)

def canonical_uuid(value):
    if not isinstance(value, str):
        return False
    try:
        return str(uuid.UUID(value)) == value
    except (ValueError, AttributeError, TypeError):
        return False

def main(embedding_request_json):
    if not isinstance(embedding_request_json, str):
        fail("REQUEST_TYPE")
    try:
        raw_request = embedding_request_json.encode("utf-8", "strict")
    except UnicodeError:
        fail("REQUEST_UNICODE")
    if len(raw_request) > MAX_REQUEST_BYTES:
        fail("REQUEST_BYTES_LIMIT")
    try:
        request = json.loads(
            embedding_request_json,
            object_pairs_hook=unique_object,
            parse_constant=lambda _value: fail("INVALID_JSON_NUMBER"),
        )
    except (ValueError, RecursionError) as exc:
        if str(exc).startswith("SOURCE_EMBEDDING_"):
            raise
        fail("INVALID_JSON")
    if not isinstance(request, dict) or set(request) != {"schemaVersion", "requestId", "task", "texts"}:
        fail("REQUEST_SHAPE")
    if request["schemaVersion"] != "source-embedding-request-v1":
        fail("SCHEMA_VERSION")
    if not canonical_uuid(request["requestId"]):
        fail("REQUEST_ID")
    if request["task"] not in ("DOCUMENT", "QUERY"):
        fail("TASK")
    texts = request["texts"]
    if not isinstance(texts, list) or not 1 <= len(texts) <= MAX_TEXTS:
        fail("TEXT_COUNT")
    if request["task"] == "QUERY" and len(texts) != 1:
        fail("QUERY_TEXT_COUNT")

    seen_ids = set()
    total_bytes = 0
    api_requests = []
    for item in texts:
        if not isinstance(item, dict) or set(item) != {"id", "text", "sha256"}:
            fail("TEXT_SHAPE")
        item_id = item["id"]
        text = item["text"]
        digest = item["sha256"]
        if not canonical_uuid(item_id) or item_id in seen_ids:
            fail("TEXT_ID")
        seen_ids.add(item_id)
        if not isinstance(text, str) or not text.strip() or len(text) > MAX_TEXT_CHARS:
            fail("TEXT_CHARS")
        if re.search(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]", text):
            fail("TEXT_CONTROL_CHARACTER")
        try:
            text_bytes = text.encode("utf-8", "strict")
        except UnicodeError:
            fail("TEXT_UNICODE")
        if len(text_bytes) > MAX_TEXT_BYTES:
            fail("TEXT_BYTES")
        total_bytes += len(text_bytes)
        if total_bytes > MAX_TOTAL_TEXT_BYTES:
            fail("TOTAL_TEXT_BYTES")
        if not isinstance(digest, str) or re.fullmatch(r"[0-9a-f]{64}", digest) is None:
            fail("TEXT_HASH_FORMAT")
        if hashlib.sha256(text_bytes).hexdigest() != digest:
            fail("TEXT_HASH_MISMATCH")
        task_type = "RETRIEVAL_DOCUMENT" if request["task"] == "DOCUMENT" else "RETRIEVAL_QUERY"
        api_requests.append({
            "model": "models/gemini-embedding-001",
            "content": {"parts": [{"text": text}]},
            # batchEmbedContents accepts these legacy top-level fields. Keep
            # them alongside the current config because the live request
            # returned the model's default 3072 dimensions when sizing was
            # supplied only inside embedContentConfig.
            "taskType": task_type,
            "outputDimensionality": 768,
            "embedContentConfig": {
                "taskType": task_type,
                "outputDimensionality": 768,
                "autoTruncate": False,
            },
        })

    canonical_request = canonical(request)
    request_hash = hashlib.sha256(canonical_request.encode("utf-8")).hexdigest()
    metadata = {
        "requestHash": request_hash,
        "requestId": request["requestId"],
        "task": request["task"],
        "texts": [{"id": item["id"], "sha256": item["sha256"]} for item in texts],
    }
    google_request_json = canonical({"requests": api_requests})
    if len(google_request_json.encode("utf-8")) > 400000:
        fail("GOOGLE_REQUEST_BYTES_LIMIT")
    return {
        "google_request_json": google_request_json,
        "metadata_json": canonical(metadata),
        "request_hash": request_hash,
    }
'''


RESPONSE_CODE = r'''import json
import math
import re
import uuid

DIMENSIONS = 768
MAX_OUTPUT_CHARS = 400000
MAX_OUTPUT_BYTES = 1048576
MAX_RESPONSE_BYTES = 400000

def fail(code):
    raise ValueError("SOURCE_EMBEDDING_" + code)

def canonical(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False)

def main(status_code, response_body, metadata_json):
    if isinstance(status_code, bool) or not isinstance(status_code, int) or not 200 <= status_code < 300:
        fail("HTTP_STATUS")
    if (not isinstance(response_body, str)
            or len(response_body) > MAX_RESPONSE_BYTES
            or len(response_body.encode("utf-8", "strict")) > MAX_RESPONSE_BYTES):
        fail("RESPONSE_BYTES_LIMIT")
    if not isinstance(metadata_json, str) or len(metadata_json.encode("utf-8", "strict")) > 64000:
        fail("METADATA_BYTES_LIMIT")
    try:
        response = json.loads(response_body, parse_constant=lambda _value: fail("INVALID_RESPONSE_NUMBER"))
        metadata = json.loads(metadata_json)
    except (ValueError, RecursionError) as exc:
        if str(exc).startswith("SOURCE_EMBEDDING_"):
            raise
        fail("INVALID_RESPONSE_JSON")
    except UnicodeError:
        fail("INVALID_RESPONSE_JSON")
    if not isinstance(metadata, dict) or set(metadata) != {"requestHash", "requestId", "task", "texts"}:
        fail("METADATA_SHAPE")
    if not isinstance(metadata["requestHash"], str) or re.fullmatch(r"[0-9a-f]{64}", metadata["requestHash"]) is None:
        fail("METADATA_HASH")
    try:
        if str(uuid.UUID(metadata["requestId"])) != metadata["requestId"]:
            fail("METADATA_REQUEST_ID")
    except (ValueError, AttributeError, TypeError):
        fail("METADATA_REQUEST_ID")
    if metadata["task"] not in ("DOCUMENT", "QUERY"):
        fail("METADATA_TASK")
    texts = metadata["texts"]
    if not isinstance(texts, list) or not 1 <= len(texts) <= 16:
        fail("METADATA_TEXT_COUNT")
    if metadata["task"] == "QUERY" and len(texts) != 1:
        fail("METADATA_QUERY_TEXT_COUNT")
    seen_ids = set()
    for item in texts:
        if not isinstance(item, dict) or set(item) != {"id", "sha256"}:
            fail("METADATA_TEXT_SHAPE")
        try:
            if str(uuid.UUID(item["id"])) != item["id"]:
                fail("METADATA_TEXT_ID")
        except (ValueError, AttributeError, TypeError):
            fail("METADATA_TEXT_ID")
        if item["id"] in seen_ids or not isinstance(item["sha256"], str) or re.fullmatch(r"[0-9a-f]{64}", item["sha256"]) is None:
            fail("METADATA_TEXT_IDENTITY")
        seen_ids.add(item["id"])
    if not isinstance(response, dict) or not isinstance(response.get("embeddings"), list):
        fail("RESPONSE_SHAPE")
    raw_embeddings = response["embeddings"]
    if len(raw_embeddings) != len(texts):
        fail("RESPONSE_COUNT")

    embeddings = []
    for index, (item, raw_embedding) in enumerate(zip(texts, raw_embeddings)):
        if not isinstance(raw_embedding, dict) or not isinstance(raw_embedding.get("values"), list):
            fail("VECTOR_SHAPE")
        values = raw_embedding["values"]
        if len(values) != DIMENSIONS:
            fail("VECTOR_DIMENSIONS")
        vector = []
        for value in values:
            if isinstance(value, bool) or not isinstance(value, (int, float)):
                fail("VECTOR_VALUE")
            number = float(value)
            if not math.isfinite(number):
                fail("VECTOR_NONFINITE")
            vector.append(number)
        norm = math.hypot(*vector)
        if not math.isfinite(norm) or norm <= 0:
            fail("VECTOR_ZERO_NORM")
        normalized = [round(value / norm, 15) for value in vector]
        embeddings.append({"id": item["id"], "sha256": item["sha256"], "values": normalized})

    result = {
        "schemaVersion": "source-embedding-v1",
        "requestId": metadata["requestId"],
        "requestHash": metadata["requestHash"],
        "model": "gemini-embedding-001",
        "dimensions": DIMENSIONS,
        "task": metadata["task"],
        "embeddings": embeddings,
    }
    embedding_json = canonical(result)
    if len(embedding_json) > MAX_OUTPUT_CHARS or len(embedding_json.encode("utf-8")) > MAX_OUTPUT_BYTES:
        fail("OUTPUT_BYTES_LIMIT")
    return {"embedding_json": embedding_json}
'''


class DifyDumper(base.DifyDumper):
    def ignore_aliases(self, data: Any) -> bool:
        return True


def node(node_id: str, node_type: str, data: dict[str, Any], x: int, y: int,
         width: int = 260, height: int = 130) -> dict[str, Any]:
    return base.node(node_id, node_type, data, x, y, width=width, height=height)


def edge(source: str, target: str, source_type: str, target_type: str) -> dict[str, Any]:
    return base.edge(source, target, source_type, target_type)


def code_node(node_id: str, title: str, source: str, variables: list[dict[str, Any]], outputs: dict[str, dict[str, Any]],
              x: int, y: int) -> dict[str, Any]:
    return node(node_id, "code", {
        "title": title,
        "code_language": "python3",
        "code": source,
        "variables": variables,
        "outputs": {name: {"type": item_type["type"], "children": None} for name, item_type in outputs.items()},
    }, x, y, width=310, height=170)


def canonical(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False)


def build_document() -> dict[str, Any]:
    request_env = {
        "id": "ac273144-63cc-5d1b-966a-28e995ab3e70",
        "name": "GOOGLE_EMBEDDING_API_KEY",
        "value": "",
        "value_type": "secret",
        "description": "Google Gemini API key used only by this workflow's fixed embedding request.",
    }
    nodes = [
        node("start", "start", {"title": "Embedding request", "variables": [{
            "variable": "embedding_request_json",
            "label": "Validated source or query text request (JSON)",
            "type": "paragraph",
            "required": True,
            "max_length": 64000,
            "options": [],
        }]}, 80, 260, width=280, height=120),
        code_node("validate_request", "Validate and prepare embedding request", REQUEST_CODE,
            [{"variable": "embedding_request_json", "value_selector": ["start", "embedding_request_json"]}],
            {"google_request_json": {"type": "string"}, "metadata_json": {"type": "string"},
             "request_hash": {"type": "string"}}, 430, 240),
        node("google_embeddings", "http-request", {
            "title": "Google batch embeddings",
            "method": "post",
            "url": "https://generativelanguage.googleapis.com/v1beta/models/gemini-embedding-001:batchEmbedContents",
            "authorization": {"type": "api-key", "config": {
                "type": "custom",
                "api_key": "{{#env.GOOGLE_EMBEDDING_API_KEY#}}",
                "header": "x-goog-api-key",
            }},
            "headers": "Content-Type: application/json",
            "params": "",
            "body": {"type": "raw-text", "data": [{
                "key": "",
                "type": "text",
                "value": "{{#validate_request.google_request_json#}}",
            }]},
            "timeout": {"connect": 10, "read": 60, "write": 60},
            "ssl_verify": True,
            "retry_config": {"retry_enabled": False, "max_retries": 0, "retry_interval": 1000},
        }, 810, 260, width=320, height=180),
        code_node("validate_response", "Validate and normalize embedding vectors", RESPONSE_CODE,
            [
                {"variable": "status_code", "value_selector": ["google_embeddings", "status_code"]},
                {"variable": "response_body", "value_selector": ["google_embeddings", "body"]},
                {"variable": "metadata_json", "value_selector": ["validate_request", "metadata_json"]},
            ], {"embedding_json": {"type": "string"}}, 1220, 240),
        node("end", "end", {"title": "Return source-embedding-v1", "outputs": [{
            "variable": "embedding_json",
            "value_selector": ["validate_response", "embedding_json"],
        }]}, 1650, 260, width=280, height=120),
    ]
    edges = [
        edge("start", "validate_request", "start", "code"),
        edge("validate_request", "google_embeddings", "code", "http-request"),
        edge("google_embeddings", "validate_response", "http-request", "code"),
        edge("validate_response", "end", "code", "end"),
    ]
    return {
        "app": {
            "description": "ContentFlow source-embedding adapter. Validates a bounded batch and returns normalized, source-bound vectors from Google's fixed Gemini embedding model.",
            "icon": "search",
            "icon_background": "#D1E9FF",
            "icon_type": "emoji",
            "mode": "workflow",
            "name": "contentflow-source-embedding-v1",
            "use_icon_as_answer_icon": False,
        },
        "dependencies": [],
        "kind": "app",
        "version": DSL_VERSION,
        "workflow": {
            "conversation_variables": [],
            "environment_variables": [request_env],
            "features": {
                "file_upload": {"allowed_file_extensions": [], "allowed_file_types": [],
                    "allowed_file_upload_methods": [], "enabled": False,
                    "image": {"enabled": False, "number_limits": 3,
                              "transfer_methods": ["local_file", "remote_url"]}, "number_limits": 3},
                "opening_statement": "",
                "retriever_resource": {"enabled": False},
                "sensitive_word_avoidance": {"enabled": False},
                "speech_to_text": {"enabled": False},
                "suggested_questions": [],
                "suggested_questions_after_answer": {"enabled": False},
                "text_to_speech": {"enabled": False, "language": "", "voice": ""},
            },
            "graph": {"edges": edges, "nodes": nodes, "viewport": {"x": 0, "y": 0, "zoom": 0.7}},
            "rag_pipeline_variables": [],
        },
    }


def release_document(dsl_text: str) -> dict[str, Any]:
    config = {
        "schemaVersion": "contextflow-dify-release-v1",
        "releaseId": RELEASE_ID,
        "workflowName": "contentflow-source-embedding-v1",
        "target": TARGET,
        "contract": {
            "input": "embedding_request_json: source-embedding-request-v1",
            "output": "embedding_json: source-embedding-v1",
            "maxTexts": 16,
            "maxTextChars": 4000,
            "maxTextUtf8Bytes": 1536,
            "maxTotalTextUtf8Bytes": 64000,
            "maxRequestUtf8Bytes": 64000,
            "maxOutputChars": 400000,
            "maxOutputUtf8Bytes": 1048576,
            "maxGoogleResponseUtf8Bytes": 400000,
        },
        "provider": {
            "name": "Google Gemini API via Dify HTTP Request",
            "endpoint": "https://generativelanguage.googleapis.com/v1beta/models/gemini-embedding-001:batchEmbedContents",
            "apiKeyEnvironmentVariable": "GOOGLE_EMBEDDING_API_KEY",
            "model": MODEL,
            "dimensions": DIMENSIONS,
            "taskTypes": {"DOCUMENT": DOCUMENT_TASK_TYPE, "QUERY": QUERY_TASK_TYPE},
            "autoTruncate": False,
            "requestFieldCompatibility": "Send matching taskType and outputDimensionality both at EmbedContentRequest top level and in embedContentConfig; keep autoTruncate=false in embedContentConfig. The top-level fields are deprecated but remain in Google's batch request schema and are required by this release's tested wire shape.",
            "references": [
                "https://ai.google.dev/api/embeddings",
                "https://ai.google.dev/api/batch-api#EmbedContentRequest",
                "https://ai.google.dev/gemini-api/docs/models/gemini-embedding-001",
            ],
        },
        "limits": {
            "modelMaximumTokensPerText": 2048,
            "textBoundRationale": "The workflow uses a conservative 1536 UTF-8 byte cap per text and disables Google truncation; it does not tokenize locally, so any provider token-limit rejection fails the run visibly.",
            "difyTracePrivacy": "Dify may retain workflow inputs, HTTP request bodies and output vectors in run history; restrict access and retention there. The Google key is supplied through the Dify secret environment variable and custom API-key authorization header.",
        },
    }
    return {
        **config,
        "configDigest": hashlib.sha256(canonical(config).encode("utf-8")).hexdigest(),
        "workflowDslSha256": hashlib.sha256(dsl_text.encode("utf-8")).hexdigest(),
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, default=OUTPUT_PATH)
    parser.add_argument("--release-output", type=Path, default=RELEASE_PATH)
    args = parser.parse_args()
    args.output.parent.mkdir(parents=True, exist_ok=True)
    document = build_document()
    dsl_text = yaml.dump(document, Dumper=DifyDumper, allow_unicode=True, sort_keys=False, width=110)
    args.output.write_text(dsl_text, encoding="utf-8", newline="\n")
    release = release_document(dsl_text)
    args.release_output.write_text(json.dumps(release, ensure_ascii=False, sort_keys=True, indent=2) + "\n",
                                   encoding="utf-8", newline="\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
