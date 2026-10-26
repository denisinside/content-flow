#!/usr/bin/env python3
"""Build the importable ContentFlow brief-proposal Dify Workflow DSL."""

from __future__ import annotations

import hashlib
import json
from pathlib import Path
from typing import Any

import yaml

import build_claim_extraction_dsl as base


ROOT = Path(__file__).resolve().parents[2]
DIRECTORY = ROOT / "packages/backend/src/editorial/workflows/brief-proposal"
PROMPT_PATH = DIRECTORY / "prompt.md"
RUNTIME_PATH = DIRECTORY / "runtime.py"
OUTPUT_PATH = DIRECTORY / "brief-proposal-v1.yml"
RELEASE_PATH = DIRECTORY / "release.json"
RELEASE_ID = "brief-proposal-2026-10-24.1"
CONTRACT_VERSION = "brief-proposal-v1"
PROMPT_VERSION = "brief-proposal-prompt-v1"
DSL_VERSION = "0.7.0"
TARGET = {"difyVersion": "1.17.1", "graphonVersion": "0.7.0", "dslVersion": DSL_VERSION}
MAX_INPUT_BYTES = 120_000
MAX_SOURCES = 20
MAX_EXCERPT_BYTES = 60_000
MODEL = {"provider": "langgenius/gemini/google", "name": "gemini-3.8-flash", "mode": "chat"}
MODEL_COMPLETION_PARAMS = base.completion_params(4096)


def _sha256(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def _canonical(value: Any) -> bytes:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False).encode("utf-8")


def _release_base() -> dict[str, Any]:
    return {
        "schemaVersion": "contextflow-dify-release-v1",
        "operation": "BRIEF_PROPOSAL",
        "releaseId": RELEASE_ID,
        "contractVersion": CONTRACT_VERSION,
        "promptTemplateVersion": PROMPT_VERSION,
        "promptTemplateFile": PROMPT_PATH.name,
        "promptSha256": _sha256(PROMPT_PATH.read_bytes()),
        "workflowDslFile": OUTPUT_PATH.name,
        "runtimeFile": str(RUNTIME_PATH.relative_to(ROOT)).replace("\\", "/"),
        "runtimeSha256": _sha256(RUNTIME_PATH.read_bytes()),
        "target": TARGET,
        "limits": {"inputBytes": MAX_INPUT_BYTES, "sources": MAX_SOURCES,
                   "aggregateExcerptBytes": MAX_EXCERPT_BYTES, "outputBytes": 128_000,
                   "modelResponseBytes": 64_000,
                   "assumptions": 10},
        "apiBaseEnv": "DIFY_API_BASE_URL",
        "apiKeyEnv": "DIFY_BRIEF_PROPOSAL_API_KEY",
        "publishedWorkflowIdEnv": "DIFY_BRIEF_PROPOSAL_PUBLISHED_WORKFLOW_ID",
        "configDigestEnv": "DIFY_BRIEF_PROPOSAL_CONFIG_SHA256",
        "inputVariable": "brief_request_json",
        "outputVariable": "brief_proposal_json",
        "responseMode": "streaming",
        "provider": "dify",
        "model": {**MODEL, "completionParams": MODEL_COMPLETION_PARAMS},
    }


def _config_digest() -> str:
    # The DSL digest is recorded separately because the digest is injected into
    # the final Code node; including the DSL bytes here would be self-referential.
    return _sha256(_canonical(_release_base()))


def _runtime_node_code(operation: str, parameters: list[str], output_names: list[str], config_digest: str = "") -> str:
    runtime_source = RUNTIME_PATH.read_text(encoding="utf-8").rstrip()
    parameter_list = ", ".join(parameters)
    mapping = "{" + ", ".join(repr(name) + ": " + name for name in parameters) + "}"
    result_fields = ",\n        ".join(repr(name) + ": result[" + repr(name) + "]" for name in output_names)
    digest_arg = f", {config_digest!r}" if operation == "finalize" else ""
    wrapper = (
        "\n\ndef main(" + parameter_list + "):\n"
        f"    result = runtime_main({operation!r}, {mapping}{digest_arg})\n"
        "    if not isinstance(result, dict):\n"
        "        raise ValueError('BRIEF_PROPOSAL_INVALID_RUNTIME_RESULT')\n"
        f"    return {{\n        {result_fields}\n    }}\n"
    )
    return runtime_source + wrapper


def _code_node(node_id: str, title: str, operation: str, selectors: dict[str, list[str]],
               output_names: list[str], x: int, config_digest: str = "") -> dict[str, Any]:
    parameters = list(selectors)
    code = _runtime_node_code(operation, parameters, output_names, config_digest)
    return base.node(node_id, "code", {
        "title": title,
        "code_language": "python3",
        "code": code,
        "variables": [{"variable": name, "value_selector": selector} for name, selector in selectors.items()],
        "outputs": {name: {"type": "string", "children": None} for name in output_names},
    }, x, 260, width=330, height=170)


def _brief_fields() -> dict[str, Any]:
    return {
        "audience": {"type": "string", "description": "A specific, supportable reader group."},
        "centralMessage": {"type": "string", "description": "One focused question or editorial promise, without unsupported factual claims."},
        "category": {"type": "string", "description": "A concise editorial category."},
        "tone": {"type": "string", "description": "A concise practical tone aligned with the workspace style."},
        "cta": {"type": "string", "description": "A suitable call to action, or empty when none follows from the request."},
    }


def _model_schema() -> dict[str, Any]:
    brief = {"type": ["object", "null"], "additionalProperties": False,
             "properties": _brief_fields(), "required": list(_brief_fields()),
             "description": "Null when status is needs_human; otherwise an unapproved editorial proposal."}
    return {
        "type": "object", "additionalProperties": False,
        "required": ["status", "brief", "assumptions"],
        "properties": {
            "status": {"type": "string", "enum": ["ready", "needs_human"]},
            "brief": brief,
            "assumptions": {"type": "array", "items": {"type": "string"},
                            "description": "At most 10 concise assumptions; Code node enforces the maximum."},
        },
    }


def build_document(config_digest: str | None = None) -> dict[str, Any]:
    digest = config_digest or _config_digest()
    prompt = PROMPT_PATH.read_text(encoding="utf-8").strip()
    start = base.node("start", "start", {
        "title": "Запит на пропозицію брифу",
        "variables": [{"variable": "brief_request_json", "label": "Тема, поточний бриф і вибрані джерела (JSON)",
                       "type": "paragraph", "required": True, "max_length": MAX_INPUT_BYTES, "options": []}],
    }, 80, 260, width=280, height=120)
    prepare = _code_node("prepare_request", "Перевірити запит і підготувати контекст", "prepare",
                         {"brief_request_json": ["start", "brief_request_json"]},
                         ["prompt_request_json", "request_hash", "request_id"], 420)
    propose = base.node("propose_brief", "llm", {
        "title": "Запропонувати редакторський бриф",
        "desc": "One editorial proposal from the project topic, current draft, style and all selected source excerpts. Human review is required.",
        "model": {**MODEL, "completion_params": MODEL_COMPLETION_PARAMS},
        "prompt_template": [
            {"id": "brief-proposal-system-v1", "role": "system", "edition_type": "basic", "text": prompt},
            {"id": "brief-proposal-input-v1", "role": "user", "edition_type": "jinja2",
             "text": "<brief_proposal_request>\n{{ request_json }}\n</brief_proposal_request>",
             "jinja2_text": "<brief_proposal_request>\n{{ request_json }}\n</brief_proposal_request>"},
        ],
        "prompt_config": {"jinja2_variables": [{"variable": "request_json", "value_selector": ["prepare_request", "prompt_request_json"]}]},
        "context": {"enabled": False, "variable_selector": []},
        "vision": {"enabled": False},
        "structured_output_enabled": True,
        "structured_output": {"schema": _model_schema()},
        "retry_config": {"max_retries": 0, "retry_enabled": False, "retry_interval": 3000},
    }, 800, 260, width=360, height=200)
    finalize = _code_node("validate_result", "Перевірити пропозицію та прив’язку запиту", "finalize",
                          {"brief_request_json": ["start", "brief_request_json"],
                           "model_response": ["propose_brief", "text"]},
                          ["brief_proposal_json"], 1260, digest)
    end = base.node("end", "end", {
        "title": "Повернути пропозицію для перевірки людиною",
        "outputs": [{"variable": "brief_proposal_json", "value_type": "string",
                     "value_selector": ["validate_result", "brief_proposal_json"]}],
    }, 1680, 260, width=320, height=120)
    nodes = [start, prepare, propose, finalize, end]
    edges = [base.edge("start", "prepare_request", "start", "code"),
             base.edge("prepare_request", "propose_brief", "code", "llm"),
             base.edge("propose_brief", "validate_result", "llm", "code"),
             base.edge("validate_result", "end", "code", "end")]
    envelope = {
        "app": {"description": "One-pass editorial brief proposal from a project topic, current draft, workspace style and selected source excerpts. All output remains an unapproved candidate for human review.",
                "icon": "book_open", "icon_background": "#D1E9FF", "icon_type": "emoji",
                "mode": "workflow", "name": "contentflow-brief-proposal-v1", "use_icon_as_answer_icon": False},
        "dependencies": [], "kind": "app", "version": DSL_VERSION,
        "workflow": {
            "conversation_variables": [], "environment_variables": [],
            "features": {
                "file_upload": {"allowed_file_extensions": [], "allowed_file_types": [], "allowed_file_upload_methods": [],
                                "enabled": False, "image": {"enabled": False, "number_limits": 3,
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
    return envelope


def write_release(dsl_bytes: bytes) -> dict[str, Any]:
    release = _release_base()
    release["workflowDslSha256"] = _sha256(dsl_bytes)
    release["configDigest"] = _sha256(_canonical(_release_base()))
    RELEASE_PATH.write_text(json.dumps(release, ensure_ascii=False, indent=2) + "\n", encoding="utf-8", newline="\n")
    return release


def main() -> int:
    DIRECTORY.mkdir(parents=True, exist_ok=True)
    document = build_document()
    dsl_bytes = yaml.dump(document, Dumper=base.DifyDumper, allow_unicode=True, sort_keys=True,
                          width=1000, default_flow_style=False).encode("utf-8")
    OUTPUT_PATH.write_bytes(dsl_bytes)
    release = write_release(dsl_bytes)
    print(f"Built {len(document['workflow']['graph']['nodes'])} native nodes for Dify {TARGET['difyVersion']} / Graphon {TARGET['graphonVersion']} / DSL {DSL_VERSION}.")
    print(f"Release {RELEASE_ID}; configDigest {release['configDigest']}; workflowDslSha256 {release['workflowDslSha256']}.")
    print("Remote import and publication are separate.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
