"""Strict request/result guards embedded in brief-proposal Dify Code nodes."""

from __future__ import annotations

import hashlib
import json
import re
import uuid
from typing import Any


MAX_INPUT_BYTES = 120_000
MAX_MODEL_RESPONSE_BYTES = 64_000
MAX_OUTPUT_BYTES = 128_000
MAX_SOURCES = 20
MAX_EXCERPT_BYTES = 60_000
RELEASE_ID = "brief-proposal-2026-10-24.1"
HASH_RE = re.compile(r"^[a-f0-9]{64}$")
CONTROL_RE = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]")
INPUT_KEYS = {"schemaVersion", "requestId", "topic", "contentMode", "currentBrief", "style", "sources", "requestHash"}
BRIEF_KEYS = {"topic", "audience", "centralMessage", "category", "tone", "targetLength", "cta", "exclusions", "notes"}
STYLE_KEYS = {"tone", "brandbook"}
SOURCE_KEYS = {"snapshotId", "sha256", "label", "excerpt", "sampled"}
MODEL_KEYS = {"status", "brief", "assumptions"}
PROPOSAL_KEYS = {"audience", "centralMessage", "category", "tone", "cta"}


def _fail(code: str) -> None:
    raise ValueError("BRIEF_PROPOSAL_" + code)


def _unique_object(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for key, value in pairs:
        if key in result:
            _fail("DUPLICATE_JSON_KEY")
        result[key] = value
    return result


def _reject_constant(_value: str) -> None:
    _fail("INVALID_JSON_NUMBER")


def _canonical(value: Any) -> bytes:
    try:
        return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False).encode("utf-8", "strict")
    except (TypeError, ValueError, UnicodeError, RecursionError):
        _fail("INVALID_JSON")


def _utf16_length(value: str) -> int:
    try:
        return len(value.encode("utf-16-le", "strict")) // 2
    except UnicodeError:
        _fail("INVALID_TEXT")


def _text(value: Any, maximum: int, *, empty: bool = True, code: str = "TEXT") -> str:
    if not isinstance(value, str) or (not empty and not value.strip()) or _utf16_length(value) > maximum or CONTROL_RE.search(value):
        _fail("INVALID_" + code)
    try:
        value.encode("utf-8", "strict")
    except UnicodeError:
        _fail("INVALID_" + code)
    return value


def _uuid(value: Any) -> str:
    if not isinstance(value, str):
        _fail("INVALID_UUID")
    try:
        if str(uuid.UUID(value)) != value:
            _fail("INVALID_UUID")
    except (ValueError, AttributeError, TypeError):
        _fail("INVALID_UUID")
    return value


def _hash(value: Any, code: str = "HASH") -> str:
    if not isinstance(value, str) or not HASH_RE.fullmatch(value):
        _fail("INVALID_" + code)
    return value


def _brief(value: Any) -> dict[str, Any]:
    if not isinstance(value, dict) or set(value) != BRIEF_KEYS:
        _fail("INVALID_CURRENT_BRIEF_SHAPE")
    result = {
        "topic": _text(value["topic"], 500, code="BRIEF_TOPIC"),
        "audience": _text(value["audience"], 2_000, code="BRIEF_AUDIENCE"),
        "centralMessage": _text(value["centralMessage"], 4_000, code="BRIEF_CENTRAL_MESSAGE"),
        "category": _text(value["category"], 120, code="BRIEF_CATEGORY"),
        "tone": _text(value["tone"], 10_000, code="BRIEF_TONE"),
        "targetLength": value["targetLength"],
        "cta": _text(value["cta"], 2_000, code="BRIEF_CTA"),
        "exclusions": value["exclusions"],
        "notes": _text(value["notes"], 10_000, code="BRIEF_NOTES"),
    }
    target = result["targetLength"]
    if isinstance(target, bool) or not isinstance(target, int) or not 50 <= target <= 20_000:
        _fail("INVALID_TARGET_LENGTH")
    exclusions = result["exclusions"]
    if not isinstance(exclusions, list) or len(exclusions) > 50:
        _fail("INVALID_EXCLUSIONS")
    result["exclusions"] = [_text(item, 500, empty=False, code="EXCLUSION") for item in exclusions]
    return result


def _parse_request(raw_request: Any) -> dict[str, Any]:
    if not isinstance(raw_request, str):
        _fail("REQUEST_TYPE")
    try:
        raw_bytes = raw_request.encode("utf-8", "strict")
    except UnicodeError:
        _fail("REQUEST_UNICODE")
    if len(raw_bytes) > MAX_INPUT_BYTES:
        _fail("INPUT_BYTES_LIMIT")
    try:
        request = json.loads(raw_request, object_pairs_hook=_unique_object, parse_constant=_reject_constant)
    except (json.JSONDecodeError, RecursionError) as exc:
        if str(exc).startswith("BRIEF_PROPOSAL_"):
            raise
        _fail("INVALID_REQUEST_JSON")
    if not isinstance(request, dict) or set(request) != INPUT_KEYS:
        _fail("INVALID_REQUEST_SHAPE")
    if request["schemaVersion"] != "brief-proposal-input-v1":
        _fail("UNSUPPORTED_REQUEST_VERSION")
    request_id = _uuid(request["requestId"])
    topic = _text(request["topic"], 500, empty=False, code="PROJECT_TOPIC")
    if request["contentMode"] not in ("FACTUAL", "CREATIVE"):
        _fail("INVALID_CONTENT_MODE")
    current_brief = _brief(request["currentBrief"])
    style = request["style"]
    if not isinstance(style, dict) or set(style) != STYLE_KEYS:
        _fail("INVALID_STYLE_SHAPE")
    style = {"tone": _text(style["tone"], 10_000, code="STYLE_TONE"),
             "brandbook": _text(style["brandbook"], 50_000, code="STYLE_BRANDBOOK")}
    sources = request["sources"]
    if not isinstance(sources, list) or len(sources) > MAX_SOURCES:
        _fail("SOURCE_COUNT_LIMIT")
    checked_sources: list[dict[str, Any]] = []
    seen_snapshots: set[str] = set()
    excerpt_bytes = 0
    for source in sources:
        if not isinstance(source, dict) or set(source) != SOURCE_KEYS:
            _fail("INVALID_SOURCE_SHAPE")
        snapshot_id = _uuid(source["snapshotId"])
        if snapshot_id in seen_snapshots:
            _fail("DUPLICATE_SOURCE")
        seen_snapshots.add(snapshot_id)
        source_hash = _hash(source["sha256"], "SOURCE_HASH")
        label = _text(source["label"], 200, empty=False, code="SOURCE_LABEL")
        excerpt = _text(source["excerpt"], MAX_EXCERPT_BYTES, empty=False, code="SOURCE_EXCERPT")
        excerpt_bytes += len(excerpt.encode("utf-8", "strict"))
        if excerpt_bytes > MAX_EXCERPT_BYTES:
            _fail("SOURCE_EXCERPT_BYTES_LIMIT")
        if not isinstance(source["sampled"], bool):
            _fail("INVALID_SOURCE_SAMPLED_FLAG")
        checked_sources.append({"snapshotId": snapshot_id, "sha256": source_hash, "label": label,
                                "excerpt": excerpt, "sampled": source["sampled"]})
    request_hash = _hash(request["requestHash"], "REQUEST_HASH")
    hash_input = {key: value for key, value in request.items() if key != "requestHash"}
    if hashlib.sha256(_canonical(hash_input)).hexdigest() != request_hash:
        _fail("REQUEST_HASH_MISMATCH")
    checked = {"schemaVersion": "brief-proposal-input-v1", "requestId": request_id, "topic": topic,
               "contentMode": request["contentMode"], "currentBrief": current_brief, "style": style,
               "sources": checked_sources, "requestHash": request_hash}
    if len(_canonical(checked)) > MAX_INPUT_BYTES:
        _fail("INPUT_BYTES_LIMIT")
    return checked


def _prepare(raw_request: Any) -> dict[str, str]:
    request = _parse_request(raw_request)
    model_input = {
        "schemaVersion": "brief-proposal-model-input-v1",
        "topic": request["topic"],
        "contentMode": request["contentMode"],
        "currentBrief": request["currentBrief"],
        "style": request["style"],
        # IDs and hashes bind the request to snapshots server-side. They are not
        # editorial prompt material, so only the label and exact selected excerpt
        # are exposed to the model. Every validated excerpt is kept.
        "sources": [{"label": row["label"], "excerpt": row["excerpt"], "sampled": row["sampled"]}
                    for row in request["sources"]],
    }
    prompt_json = _canonical(model_input).decode("utf-8")
    if len(prompt_json.encode("utf-8")) > MAX_INPUT_BYTES:
        _fail("PROMPT_BYTES_LIMIT")
    return {"prompt_request_json": prompt_json, "request_hash": request["requestHash"],
            "request_id": request["requestId"]}


def _parse_model(raw: Any) -> dict[str, Any]:
    if not isinstance(raw, str):
        _fail("MODEL_RESPONSE_TYPE")
    if len(raw.encode("utf-8", "strict")) > MAX_MODEL_RESPONSE_BYTES:
        _fail("MODEL_RESPONSE_BYTES_LIMIT")
    try:
        result = json.loads(raw, object_pairs_hook=_unique_object, parse_constant=_reject_constant)
    except (json.JSONDecodeError, RecursionError) as exc:
        if str(exc).startswith("BRIEF_PROPOSAL_"):
            raise
        _fail("INVALID_MODEL_JSON")
    if not isinstance(result, dict) or set(result) != MODEL_KEYS:
        _fail("INVALID_MODEL_SHAPE")
    if result["status"] not in ("ready", "needs_human"):
        _fail("INVALID_MODEL_STATUS")
    assumptions = result["assumptions"]
    if not isinstance(assumptions, list) or len(assumptions) > 10:
        _fail("ASSUMPTIONS_LIMIT")
    checked_assumptions = [_text(item, 600, empty=False, code="ASSUMPTION") for item in assumptions]
    if result["status"] == "needs_human":
        if result["brief"] is not None or not checked_assumptions:
            _fail("INVALID_NEEDS_HUMAN_RESULT")
        return {"status": "needs_human", "brief": None, "assumptions": checked_assumptions}
    proposal = result["brief"]
    if not isinstance(proposal, dict) or set(proposal) != PROPOSAL_KEYS:
        _fail("INVALID_PROPOSAL_SHAPE")
    checked_proposal = {
        "audience": _text(proposal["audience"], 2_000, empty=False, code="PROPOSAL_AUDIENCE"),
        "centralMessage": _text(proposal["centralMessage"], 4_000, empty=False, code="PROPOSAL_CENTRAL_MESSAGE"),
        "category": _text(proposal["category"], 120, empty=False, code="PROPOSAL_CATEGORY"),
        "tone": _text(proposal["tone"], 10_000, empty=False, code="PROPOSAL_TONE"),
        "cta": _text(proposal["cta"], 2_000, code="PROPOSAL_CTA"),
    }
    return {"status": "ready", "brief": checked_proposal, "assumptions": checked_assumptions}


def _finalize(raw_request: Any, raw_model: Any, config_digest: Any) -> dict[str, str]:
    request = _parse_request(raw_request)
    digest = _hash(config_digest, "CONFIG_DIGEST")
    result = _parse_model(raw_model)
    if result["status"] == "ready":
        if request["contentMode"] == "FACTUAL" and not request["sources"]:
            _fail("FACTUAL_PROPOSAL_WITHOUT_SOURCES")
        generated = result["brief"]
        # Topic, length, exclusions and notes are direct owner input. Keep those
        # exact values in the candidate; AI only proposes editorial fields.
        brief = {"topic": request["currentBrief"]["topic"] or request["topic"],
                 "audience": generated["audience"], "centralMessage": generated["centralMessage"],
                 "category": generated["category"], "tone": generated["tone"],
                 "targetLength": request["currentBrief"]["targetLength"], "cta": generated["cta"],
                 "exclusions": request["currentBrief"]["exclusions"], "notes": request["currentBrief"]["notes"]}
        if request["currentBrief"]["topic"] and brief["topic"] != request["currentBrief"]["topic"]:
            _fail("PROJECT_TOPIC_CHANGED")
        result["brief"] = brief
    elif request["contentMode"] == "FACTUAL" and not request["sources"]:
        # A factual proposal without a selected source is never ready. The
        # needs_human result still carries the user-visible reason.
        pass
    payload = {"schemaVersion": "brief-proposal-output-v1", "requestId": request["requestId"],
               "requestHash": request["requestHash"], "releaseId": RELEASE_ID, "configDigest": digest,
               "status": result["status"], "brief": result["brief"], "assumptions": result["assumptions"]}
    encoded = _canonical(payload).decode("utf-8")
    if len(encoded.encode("utf-8")) > MAX_OUTPUT_BYTES:
        _fail("OUTPUT_BYTES_LIMIT")
    return {"brief_proposal_json": encoded}


def runtime_main(operation: str, values: dict[str, Any], config_digest: Any = "") -> dict[str, str]:
    if operation == "prepare":
        return _prepare(values.get("brief_request_json"))
    if operation == "finalize":
        return _finalize(values.get("brief_request_json"), values.get("model_response"), config_digest)
    _fail("UNKNOWN_OPERATION")

