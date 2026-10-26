#!/usr/bin/env python3
"""Build the bounded source-relevance Workflow API DSL offline."""

from __future__ import annotations

import hashlib
import json
from pathlib import Path
from typing import Any

import yaml


ROOT = Path(__file__).resolve().parents[2]
DIRECTORY = ROOT / "packages/backend/src/evidence/workflows/source-relevance"
PROMPT_PATH = DIRECTORY / "prompt.md"
OUTPUT_PATH = DIRECTORY / "source-relevance-v1.yml"
RUNTIME_PATH = ROOT / "scripts/dify/source_relevance_runtime.py"
DSL_VERSION = "0.7.0"
RELEASE_ID = "source-relevance-2026-10-24.1"
PROMPT_VERSION = "source-relevance-prompt-v2"
MODEL_PROTOCOL_VERSION = "source-relevance-compact-model-v1"
TARGET = {"difyVersion": "1.17.1", "graphonVersion": "0.7.0", "dslVersion": DSL_VERSION}
LIMITS = {"maxCandidates": 60, "candidateBytes": 60_000, "inputBytes": 100_000,
          "maxPassages": 20, "outputBytes": 40_000}


def completion_params(output_tokens: int) -> dict[str, Any]:
    return {"max_output_tokens": output_tokens, "thinking_level": "Low", "include_thoughts": False,
            "media_resolution": "Default", "grounding": False, "url_context": False,
            "code_execution": False, "service_tier": "standard"}


def object_schema(properties: dict[str, dict[str, Any]], required: list[str] | None = None) -> dict[str, Any]:
    return {"type": "object", "additionalProperties": False, "properties": properties,
            "required": required if required is not None else list(properties)}


def string_schema(values: list[str] | None = None, minimum: int | None = None) -> dict[str, Any]:
    value: dict[str, Any] = {"type": "string"}
    if values is not None:
        value["enum"] = values
    if minimum is not None:
        value["minLength"] = minimum
    return value


def integer_schema(minimum: int = 0) -> dict[str, Any]:
    return {"type": "integer", "minimum": minimum}


def model_schema() -> dict[str, Any]:
    decision = object_schema({
        "i": integer_schema(),
        "c": string_schema(["D", "P", "N", "B", "X"]),
    })
    return object_schema({
        "decisions": {"type": "array", "items": decision, "minItems": 1,
                      "description": "Exactly one {i,c} decision for every supplied numeric candidate index; runtime enforces complete coverage."},
        "rankedIndexes": {"type": "array", "items": integer_schema(), "minItems": 0,
                          "description": "Every useful candidate index exactly once in relevance order; empty is valid; runtime verifies the exact set."},
    })


def node(node_id: str, node_type: str, data: dict[str, Any], x: int, y: int,
         width: int = 300, height: int = 150) -> dict[str, Any]:
    return {
        "data": {**data, "type": node_type, "selected": False},
        "height": height,
        "id": node_id,
        "position": {"x": x, "y": y},
        "positionAbsolute": {"x": x, "y": y},
        "selected": False,
        "sourcePosition": "right",
        "targetPosition": "left",
        "type": "custom",
        "width": width,
        "zIndex": 0,
    }


def edge(source: str, target: str, source_type: str, target_type: str) -> dict[str, Any]:
    return {
        "data": {"isInIteration": False, "isInLoop": False, "sourceType": source_type, "targetType": target_type},
        "id": f"{source}-source-{target}-target",
        "selected": False,
        "source": source,
        "sourceHandle": "source",
        "target": target,
        "targetHandle": "target",
        "type": "custom",
        "zIndex": 0,
    }


class DifyDumper(yaml.SafeDumper):
    def ignore_aliases(self, data: Any) -> bool:
        return True


def represent_string(dumper: yaml.SafeDumper, value: str) -> yaml.ScalarNode:
    return dumper.represent_scalar("tag:yaml.org,2002:str", value, style="|" if "\n" in value else None)


DifyDumper.add_representer(str, represent_string)


def _code_node(node_id: str, operation: str, title: str, input_bindings: dict[str, list[str]],
               output_names: list[str], x: int, y: int) -> dict[str, Any]:
    parameter_list = ", ".join(input_bindings)
    payload = "{" + ", ".join(repr(key) + ": " + key for key in input_bindings) + "}"
    assignments = ",\n        ".join(repr(key) + ": result[" + repr(key) + "]" for key in output_names)
    wrapper = (
        "import json\n\n"
        f"def main({parameter_list}):\n"
        f"    result = runtime_main({operation!r}, {payload})\n"
        "    if not isinstance(result, dict):\n"
        "        raise ValueError('SOURCE_RELEVANCE_INVALID_RUNTIME_RESULT')\n"
        f"    return {{\n        {assignments}\n    }}\n"
    )
    runtime_source = RUNTIME_PATH.read_text(encoding="utf-8").rstrip()
    code = wrapper + "\n" + runtime_source + "\n"
    return node(node_id, "code", {
        "title": title,
        "code_language": "python3",
        "code": code,
        "variables": [{"variable": name, "value_selector": selector}
                      for name, selector in input_bindings.items()],
        "outputs": {name: {"type": "string", "children": None} for name in output_names},
    }, x, y, width=330, height=170)


def build_document() -> dict[str, Any]:
    prompt = PROMPT_PATH.read_text(encoding="utf-8").strip()
    nodes = [
        node("start", "start", {
            "title": "Запит і точні фрагменти",
            "variables": [{"variable": "source_relevance_request_json", "label": "Запит та точні фрагменти (JSON)",
                           "type": "paragraph", "required": True, "max_length": LIMITS["inputBytes"], "options": []}],
        }, 80, 260, width=270, height=110),
        _code_node("prepare_request", "prepare", "Перевірити запит і фрагменти", {
            "source_relevance_request_json": ["start", "source_relevance_request_json"],
        }, ["prompt_request_json", "request_hash"], 450, 260),
        node("rank_candidates", "llm", {
            "title": "Оцінити користь фрагментів для запиту",
            "desc": "One-pass query-specific relevance filter. Uses numeric indexes to keep output compact; returns candidates only, no claims or approvals.",
            "model": {"provider": "langgenius/gemini/google", "name": "gemini-3.8-flash", "mode": "chat",
                      "completion_params": completion_params(4096)},
            "prompt_template": [
                {"id": "source-relevance-system-v2", "role": "system", "edition_type": "basic", "text": prompt},
                {"id": "source-relevance-request-v2", "role": "user", "edition_type": "jinja2",
                 "text": "<source_relevance_request>\n{{ request_json }}\n</source_relevance_request>",
                 "jinja2_text": "<source_relevance_request>\n{{ request_json }}\n</source_relevance_request>"},
            ],
            "prompt_config": {"jinja2_variables": [
                {"variable": "request_json", "value_selector": ["prepare_request", "prompt_request_json"]},
            ]},
            "context": {"enabled": False, "variable_selector": []},
            "vision": {"enabled": False},
            "structured_output_enabled": True,
            "structured_output": {"schema": model_schema()},
            "retry_config": {"max_retries": 0, "retry_enabled": False, "retry_interval": 3000},
        }, 850, 260, width=360, height=190),
        _code_node("validate_result", "finalize", "Перевірити повноту та точні ID", {
            "source_relevance_request_json": ["start", "source_relevance_request_json"],
            "raw": ["rank_candidates", "text"],
        }, ["source_relevance_json"], 1320, 260),
        node("end", "end", {
            "title": "Повернути ранжовані фрагменти",
            "outputs": [{"variable": "source_relevance_json", "value_type": "string",
                         "value_selector": ["validate_result", "source_relevance_json"]}],
        }, 1750, 260, width=280, height=110),
    ]
    edges = [edge("start", "prepare_request", "start", "code"),
             edge("prepare_request", "rank_candidates", "code", "llm"),
             edge("rank_candidates", "validate_result", "llm", "code"),
             edge("validate_result", "end", "code", "end")]
    return {
        "app": {"description": "Query-specific, bounded relevance ranking over exact frozen source passages. The server validates every decision; no claim extraction or approval.",
                "icon": "book_open", "icon_background": "#D1E9FF", "icon_type": "emoji",
                "mode": "workflow", "name": "contentflow-source-relevance-v2", "use_icon_as_answer_icon": False},
        "dependencies": [],
        "kind": "app",
        "version": DSL_VERSION,
        "workflow": {
            "conversation_variables": [],
            "environment_variables": [],
            "features": {
                "file_upload": {"allowed_file_extensions": [], "allowed_file_types": [],
                                "allowed_file_upload_methods": [], "enabled": False,
                                "image": {"enabled": False, "number_limits": 3,
                                          "transfer_methods": ["local_file", "remote_url"]}, "number_limits": 3},
                "opening_statement": "", "retriever_resource": {"enabled": False},
                "sensitive_word_avoidance": {"enabled": False}, "speech_to_text": {"enabled": False},
                "suggested_questions": [], "suggested_questions_after_answer": {"enabled": False},
                "text_to_speech": {"enabled": False, "language": "", "voice": ""},
            },
            "graph": {"edges": edges, "nodes": nodes, "viewport": {"x": 0, "y": 70, "zoom": 0.7}},
            "rag_pipeline_variables": [],
        },
    }


def canonical(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def write_release(output: Path) -> dict[str, Any]:
    prompt_bytes = PROMPT_PATH.read_bytes()
    dsl_bytes = output.read_bytes()
    runtime_bytes = RUNTIME_PATH.read_bytes()
    release: dict[str, Any] = {
        "schemaVersion": "contextflow-dify-release-v1",
        "operation": "SOURCE_RELEVANCE",
        "releaseId": RELEASE_ID,
        "contractVersion": "source-relevance-v1",
        "modelProtocolVersion": MODEL_PROTOCOL_VERSION,
        "promptTemplateVersion": PROMPT_VERSION,
        "promptTemplateFile": "prompt.md",
        "promptSha256": hashlib.sha256(prompt_bytes).hexdigest(),
        "workflowDslFile": output.name,
        "workflowDslSha256": hashlib.sha256(dsl_bytes).hexdigest(),
        "runtimeFile": "scripts/dify/source_relevance_runtime.py",
        "runtimeSha256": hashlib.sha256(runtime_bytes).hexdigest(),
        "target": TARGET,
        "relevanceLimits": LIMITS,
        "apiBaseEnv": "DIFY_API_BASE_URL",
        "apiKeyEnv": "DIFY_SOURCE_RELEVANCE_API_KEY",
        "publishedWorkflowIdEnv": "DIFY_SOURCE_RELEVANCE_PUBLISHED_WORKFLOW_ID",
        "configDigestEnv": "DIFY_SOURCE_RELEVANCE_CONFIG_SHA256",
        "inputVariable": "source_relevance_request_json",
        "outputVariable": "source_relevance_json",
        "responseMode": "streaming",
        "provider": "dify",
        "model": {"provider": "langgenius/gemini/google", "name": "gemini-3.8-flash", "mode": "chat",
                  "completionParams": completion_params(4096)},
    }
    # The provider contract uses the shared workflow manifest convention:
    # the config digest covers operational config while workflow DSL bytes
    # have their own independent pinned digest.
    config_manifest = {key: value for key, value in release.items() if key != "workflowDslSha256"}
    release["configDigest"] = hashlib.sha256(canonical(config_manifest).encode("utf-8")).hexdigest()
    release_path = DIRECTORY / "release.json"
    release_path.write_text(json.dumps(release, ensure_ascii=False, indent=2) + "\n", encoding="utf-8", newline="\n")
    return release


def main() -> int:
    DIRECTORY.mkdir(parents=True, exist_ok=True)
    document = build_document()
    OUTPUT_PATH.write_text(yaml.dump(document, Dumper=DifyDumper, allow_unicode=True, sort_keys=True,
                                     width=1000, default_flow_style=False), encoding="utf-8", newline="\n")
    release = write_release(OUTPUT_PATH)
    print(f"Built {len(document['workflow']['graph']['nodes'])} native nodes for Dify {TARGET['difyVersion']} / Graphon {TARGET['graphonVersion']} / DSL {DSL_VERSION}.")
    print(f"Release {RELEASE_ID}; configDigest {release['configDigest']}. Remote publication is separate.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
