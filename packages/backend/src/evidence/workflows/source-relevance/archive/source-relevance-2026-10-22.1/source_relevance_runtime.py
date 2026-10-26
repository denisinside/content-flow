"""Strict request/result guards embedded in the source-relevance Dify Code nodes."""

import hashlib
import json
import re
import uuid
from typing import Any


MAX_INPUT_BYTES = 100_000
MAX_CANDIDATES = 60
MAX_CANDIDATE_BYTES = 60_000
MAX_OUTPUT_BYTES = 40_000
MAX_QUERY_UTF16 = 1_000
MAX_QUERY_BYTES = 1_536
MAX_QUOTE_BYTES = 1_536
MAX_LABEL_UTF16 = 200
HASH_PATTERN = re.compile(r"^[a-f0-9]{64}$")
UUID_PATTERN = re.compile(
    r"^(?:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}|"
    r"00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$", re.IGNORECASE)
CONTROL_PATTERN = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]")
INPUT_KEYS = {"schemaVersion", "requestId", "query", "candidates"}
CANDIDATE_KEYS = {"id", "snapshotId", "fragmentId", "startOffset", "endOffset", "quote", "sha256",
                  "snapshotSha256", "label"}
DECISION_KEYS = {"id", "sha256", "relevance", "reason"}
MODEL_KEYS = {"decisions", "rankedIds"}
RELEVANCE_REASONS = {
    "DIRECT": {"ANSWERS", "RELEVANT_CONDITION"},
    "PARTIAL": {"ANSWERS", "RELEVANT_CONDITION"},
    "IRRELEVANT": {"NO_QUERY_SUPPORT", "BOILERPLATE", "DUPLICATE"},
}


def _reject_constant(value: str) -> None:
    raise ValueError("SOURCE_RELEVANCE_INVALID_JSON_NUMBER")


def _unique_object(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("SOURCE_RELEVANCE_DUPLICATE_JSON_KEY")
        result[key] = value
    return result


def _load_json(raw: Any, maximum_bytes: int, error: str) -> Any:
    if not isinstance(raw, str):
        raise ValueError(error)
    try:
        encoded = raw.encode("utf-8", errors="strict")
    except UnicodeError as exc:
        raise ValueError(error) from exc
    if len(encoded) > maximum_bytes:
        raise ValueError("SOURCE_RELEVANCE_SIZE_LIMIT")
    try:
        return json.loads(raw, object_pairs_hook=_unique_object, parse_constant=_reject_constant)
    except (json.JSONDecodeError, RecursionError) as exc:
        raise ValueError(error) from exc


def _json_bytes(value: Any) -> bytes:
    try:
        return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False).encode("utf-8", errors="strict")
    except (TypeError, ValueError, UnicodeError, RecursionError) as exc:
        raise ValueError("SOURCE_RELEVANCE_INVALID_JSON") from exc


def _utf16_length(value: str) -> int:
    try:
        return len(value.encode("utf-16-le", errors="strict")) // 2
    except UnicodeError as exc:
        raise ValueError("SOURCE_RELEVANCE_INVALID_TEXT") from exc


def _text(value: Any, *, maximum_utf16: int | None = None, maximum_bytes: int | None = None) -> str:
    if not isinstance(value, str) or not value.strip() or CONTROL_PATTERN.search(value):
        raise ValueError("SOURCE_RELEVANCE_INVALID_TEXT")
    try:
        encoded = value.encode("utf-8", errors="strict")
    except UnicodeError as exc:
        raise ValueError("SOURCE_RELEVANCE_INVALID_TEXT") from exc
    if maximum_utf16 is not None and _utf16_length(value) > maximum_utf16:
        raise ValueError("SOURCE_RELEVANCE_TEXT_LIMIT")
    if maximum_bytes is not None and len(encoded) > maximum_bytes:
        raise ValueError("SOURCE_RELEVANCE_TEXT_LIMIT")
    return value


def _hash(value: Any) -> str:
    if not isinstance(value, str) or not HASH_PATTERN.fullmatch(value):
        raise ValueError("SOURCE_RELEVANCE_INVALID_HASH")
    return value


def _uuid(value: Any) -> str:
    if not isinstance(value, str) or not UUID_PATTERN.fullmatch(value):
        raise ValueError("SOURCE_RELEVANCE_INVALID_UUID")
    try:
        uuid.UUID(value)
    except (ValueError, AttributeError) as exc:
        raise ValueError("SOURCE_RELEVANCE_INVALID_UUID") from exc
    return value


def _integer(value: Any) -> int:
    # JavaScript represents all JSON numbers as IEEE-754 doubles. Refuse unsafe
    # offsets rather than hash a value differently in Python and in the API.
    if isinstance(value, bool) or not isinstance(value, int) or value < 0 or value > 9_007_199_254_740_991:
        raise ValueError("SOURCE_RELEVANCE_INVALID_OFFSET")
    return value


def _parse_input(source_relevance_request_json: Any) -> dict[str, Any]:
    raw = _load_json(source_relevance_request_json, MAX_INPUT_BYTES, "SOURCE_RELEVANCE_INVALID_REQUEST_JSON")
    if not isinstance(raw, dict) or set(raw) != INPUT_KEYS:
        raise ValueError("SOURCE_RELEVANCE_INVALID_REQUEST_SHAPE")
    if raw["schemaVersion"] != "source-relevance-request-v1":
        raise ValueError("SOURCE_RELEVANCE_UNSUPPORTED_REQUEST_VERSION")
    request_id = _uuid(raw["requestId"])
    query = _text(raw["query"], maximum_utf16=MAX_QUERY_UTF16, maximum_bytes=MAX_QUERY_BYTES)
    candidates = raw["candidates"]
    if not isinstance(candidates, list) or not 1 <= len(candidates) <= MAX_CANDIDATES:
        raise ValueError("SOURCE_RELEVANCE_CANDIDATE_COUNT_LIMIT")
    seen: set[str] = set()
    quote_bytes = 0
    checked: list[dict[str, Any]] = []
    for item in candidates:
        if not isinstance(item, dict) or set(item) != CANDIDATE_KEYS:
            raise ValueError("SOURCE_RELEVANCE_INVALID_CANDIDATE_SHAPE")
        candidate_id = _hash(item["id"])
        if candidate_id in seen:
            raise ValueError("SOURCE_RELEVANCE_DUPLICATE_CANDIDATE_ID")
        seen.add(candidate_id)
        snapshot_id = _uuid(item["snapshotId"])
        fragment_id = _uuid(item["fragmentId"])
        start = _integer(item["startOffset"])
        end = _integer(item["endOffset"])
        quote = _text(item["quote"], maximum_bytes=MAX_QUOTE_BYTES)
        quote_bytes += len(quote.encode("utf-8"))
        if end <= start or end - start != _utf16_length(quote):
            raise ValueError("SOURCE_RELEVANCE_INVALID_EXACT_RANGE")
        quote_hash = _hash(item["sha256"])
        if hashlib.sha256(quote.encode("utf-8")).hexdigest() != quote_hash:
            raise ValueError("SOURCE_RELEVANCE_QUOTE_HASH_MISMATCH")
        snapshot_hash = _hash(item["snapshotSha256"])
        label = _text(item["label"], maximum_utf16=MAX_LABEL_UTF16)
        checked.append({"id": candidate_id, "snapshotId": snapshot_id, "fragmentId": fragment_id,
                        "startOffset": start, "endOffset": end, "quote": quote, "sha256": quote_hash,
                        "snapshotSha256": snapshot_hash, "label": label})
    if quote_bytes > MAX_CANDIDATE_BYTES:
        raise ValueError("SOURCE_RELEVANCE_CANDIDATE_BYTES_LIMIT")
    result = {"schemaVersion": "source-relevance-request-v1", "requestId": request_id,
              "query": query, "candidates": checked}
    if len(_json_bytes(result)) > MAX_INPUT_BYTES:
        raise ValueError("SOURCE_RELEVANCE_SIZE_LIMIT")
    return result


def _canonical_input_hash(request: dict[str, Any]) -> str:
    # This sorted-key UTF-8 form is byte-for-byte the TypeScript contract's
    # JSON.stringify of its explicitly ordered, sorted-key objects.
    return hashlib.sha256(_json_bytes(request)).hexdigest()


def _prepare(source_relevance_request_json: Any) -> dict[str, str]:
    request = _parse_input(source_relevance_request_json)
    request_hash = _canonical_input_hash(request)
    model_request = {
        "schemaVersion": "source-relevance-model-request-v1",
        "query": request["query"],
        "candidates": [
            {"id": candidate["id"], "sha256": candidate["sha256"], "label": candidate["label"], "quote": candidate["quote"]}
            for candidate in request["candidates"]
        ],
    }
    model_request_json = _json_bytes(model_request).decode("utf-8")
    if len(model_request_json.encode("utf-8")) > MAX_INPUT_BYTES:
        raise ValueError("SOURCE_RELEVANCE_PROMPT_SIZE_LIMIT")
    return {"prompt_request_json": model_request_json, "request_hash": request_hash}


def _validate_model_result(model_result: Any, request: dict[str, Any]) -> dict[str, Any]:
    if not isinstance(model_result, dict) or set(model_result) != MODEL_KEYS:
        raise ValueError("SOURCE_RELEVANCE_INVALID_MODEL_SHAPE")
    candidate_map = {item["id"]: item for item in request["candidates"]}
    decisions = model_result["decisions"]
    ranked_ids = model_result["rankedIds"]
    if not isinstance(decisions, list) or len(decisions) != len(candidate_map):
        raise ValueError("SOURCE_RELEVANCE_INCOMPLETE_DECISIONS")
    checked_decisions: list[dict[str, str]] = []
    useful: set[str] = set()
    seen_decisions: set[str] = set()
    for decision in decisions:
        if not isinstance(decision, dict) or set(decision) != DECISION_KEYS:
            raise ValueError("SOURCE_RELEVANCE_INVALID_DECISION_SHAPE")
        candidate_id = _hash(decision["id"])
        if candidate_id not in candidate_map or candidate_id in seen_decisions:
            raise ValueError("SOURCE_RELEVANCE_UNKNOWN_OR_DUPLICATE_ID")
        seen_decisions.add(candidate_id)
        digest = _hash(decision["sha256"])
        if digest != candidate_map[candidate_id]["sha256"]:
            raise ValueError("SOURCE_RELEVANCE_CANDIDATE_HASH_MISMATCH")
        relevance, reason = decision["relevance"], decision["reason"]
        if not isinstance(relevance, str) or relevance not in RELEVANCE_REASONS:
            raise ValueError("SOURCE_RELEVANCE_INVALID_CLASSIFICATION")
        if not isinstance(reason, str) or reason not in RELEVANCE_REASONS[relevance]:
            raise ValueError("SOURCE_RELEVANCE_INVALID_REASON")
        if relevance != "IRRELEVANT":
            useful.add(candidate_id)
        checked_decisions.append({"id": candidate_id, "sha256": digest,
                                  "relevance": relevance, "reason": reason})
    if seen_decisions != set(candidate_map):
        raise ValueError("SOURCE_RELEVANCE_INCOMPLETE_DECISIONS")
    if not isinstance(ranked_ids, list) or len(ranked_ids) > MAX_CANDIDATES:
        raise ValueError("SOURCE_RELEVANCE_INVALID_RANKING")
    normalized_ranking: list[str] = []
    for candidate_id in ranked_ids:
        candidate_id = _hash(candidate_id)
        if candidate_id not in useful or candidate_id in normalized_ranking:
            raise ValueError("SOURCE_RELEVANCE_INVALID_RANKING")
        normalized_ranking.append(candidate_id)
    if set(normalized_ranking) != useful or len(normalized_ranking) != len(useful):
        raise ValueError("SOURCE_RELEVANCE_INCOMPLETE_RANKING")
    return {"schemaVersion": "source-relevance-v1", "requestId": request["requestId"],
            "requestHash": _canonical_input_hash(request), "decisions": checked_decisions,
            "rankedIds": normalized_ranking}


def _finalize(source_relevance_request_json: Any, raw: Any) -> dict[str, str]:
    request = _parse_input(source_relevance_request_json)
    model_result = _load_json(raw, MAX_OUTPUT_BYTES, "SOURCE_RELEVANCE_INVALID_MODEL_JSON")
    result = _validate_model_result(model_result, request)
    encoded = _json_bytes(result).decode("utf-8")
    if len(encoded.encode("utf-8")) > MAX_OUTPUT_BYTES:
        raise ValueError("SOURCE_RELEVANCE_OUTPUT_SIZE_LIMIT")
    return {"source_relevance_json": encoded}


def runtime_main(operation: str, inputs: dict[str, Any]) -> dict[str, str]:
    """Operation used by exported Code nodes and offline synthetic tests."""
    if not isinstance(inputs, dict):
        raise ValueError("SOURCE_RELEVANCE_INVALID_RUNTIME_INPUT")
    if operation == "prepare":
        if set(inputs) != {"source_relevance_request_json"}:
            raise ValueError("SOURCE_RELEVANCE_INVALID_RUNTIME_INPUT")
        return _prepare(inputs["source_relevance_request_json"])
    if operation == "finalize":
        if set(inputs) != {"source_relevance_request_json", "raw"}:
            raise ValueError("SOURCE_RELEVANCE_INVALID_RUNTIME_INPUT")
        return _finalize(inputs["source_relevance_request_json"], inputs["raw"])
    raise ValueError("SOURCE_RELEVANCE_UNKNOWN_OPERATION")
