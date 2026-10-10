"""Provider-free controller for the reviewed Telegram-generation workflow.

The model returns paragraph/segment selections. This module validates their
references, derives all UTF-16 offsets, bounds one targeted repair, and emits
only an unapproved candidate plus its review report.
"""
import copy
import hashlib
import json
import re
import uuid

MAX_INPUT_BYTES = 350_000
MAX_OUTPUT_BYTES = 32_768
MAX_TEXT_UTF16 = 4_096
MAX_PARAGRAPHS = 20
MAX_SEGMENTS = 100
MAX_ISSUES = 30
REPORT_SCHEMA = "telegram-editorial-report-v1"


def fail(code: str) -> None:
    raise ValueError("TELEGRAM_WORKFLOW_" + code)


def dumps(value: object, *, sort_keys: bool = False) -> str:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"), sort_keys=sort_keys, allow_nan=False)


def digest_text(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def digest_output(value: object) -> str:
    # Preserve schema insertion order to match JSON.stringify on the backend.
    return digest_text(dumps(value))


def load(value: object) -> object:
    if not isinstance(value, str):
        return copy.deepcopy(value)
    if len(value.encode("utf-8")) > 2 * 1024 * 1024:
        fail("JSON_SIZE")

    def pairs(rows):
        result = {}
        for key, child in rows:
            if key in result:
                fail("DUPLICATE_KEY")
            result[key] = child
        return result

    try:
        return json.loads(value, object_pairs_hook=pairs,
                          parse_constant=lambda _: fail("JSON_NUMBER"))
    except (json.JSONDecodeError, RecursionError):
        fail("JSON_INVALID")


def obj(value: object, required=(), allowed=None) -> dict:
    if not isinstance(value, dict) or any(key not in value for key in required):
        fail("OBJECT_SHAPE")
    if allowed is not None and set(value) - set(allowed):
        fail("OBJECT_FIELDS")
    return value


def text(value: object, maximum: int, *, empty: bool = False) -> str:
    if not isinstance(value, str) or len(value) > maximum or (not empty and not value.strip()):
        fail("TEXT_SHAPE")
    if re.search(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]", value):
        fail("TEXT_CONTROL")
    return value


def rows(value: object, maximum: int, *, minimum: int = 0) -> list:
    if not isinstance(value, list) or not minimum <= len(value) <= maximum:
        fail("ARRAY_SHAPE")
    return value


def identifier(value: object) -> str:
    value = text(value, 36)
    try:
        uuid.UUID(value)
    except (ValueError, AttributeError):
        fail("REFERENCE_FORMAT")
    return value


def utf16_len(value: str) -> int:
    return len(value.encode("utf-16-le")) // 2


def size(value: object, maximum: int, code: str) -> None:
    if len(dumps(value, sort_keys=True).encode("utf-8")) > maximum:
        fail(code)


def validate_input(value: object) -> dict:
    e = obj(load(value), ("schemaVersion", "inputMode", "contentMode", "includeLink", "brief", "style",
                          "claims", "context", "article"))
    size(e, MAX_INPUT_BYTES, "INPUT_SIZE")
    if e["schemaVersion"] != "telegram-context-v1" or e["inputMode"] not in ("DIRECT", "ARTICLE_DERIVED") \
            or e["contentMode"] not in ("FACTUAL", "CREATIVE") or type(e["includeLink"]) is not bool:
        fail("INPUT_CONTRACT")
    obj(e["brief"])
    obj(e["style"], ("brandbook", "tone", "settings"), ("brandbook", "tone", "settings"))
    text(e["style"]["brandbook"], 20_000, empty=True)
    text(e["style"]["tone"], 10_000, empty=True)
    if not isinstance(e["style"]["settings"], (dict, list, str, type(None))):
        fail("STYLE_SHAPE")

    if e["inputMode"] == "DIRECT":
        if e["article"] is not None:
            fail("INPUT_MODE")
    else:
        if e["article"] is None:
            fail("INPUT_MODE")
        article = obj(e["article"], ("versionId", "sha256", "text"), ("versionId", "sha256", "text"))
        identifier(article["versionId"])
        text(article["text"], 300_000)
        if not isinstance(article["sha256"], str) or not re.fullmatch(r"[a-f0-9]{64}", article["sha256"]):
            fail("ARTICLE_HASH")

    context_by_snapshot = {}
    for entry in rows(e["context"], 100):
        entry = obj(entry, ("snapshotId", "purpose", "sha256", "text"),
                    ("snapshotId", "purpose", "sha256", "text"))
        sid = identifier(entry["snapshotId"])
        purpose = text(entry["purpose"], 100)
        content = text(entry["text"], 300_000)
        if sid in context_by_snapshot or not isinstance(entry["sha256"], str) or entry["sha256"] != digest_text(content):
            fail("CONTEXT_HASH")
        context_by_snapshot[sid] = {"snapshotId": sid, "purpose": purpose, "sha256": entry["sha256"], "text": content}

    claim_ids, evidence_ids, allowed_pairs = set(), set(), {}
    for claim in rows(e["claims"], 100):
        claim = obj(claim, ("claimRevisionId", "wording", "evidence"),
                    ("claimRevisionId", "wording", "evidence"))
        cid = identifier(claim["claimRevisionId"])
        wording = text(claim["wording"], 10_000)
        if cid in claim_ids:
            fail("DUPLICATE_CLAIM")
        claim_ids.add(cid)
        evidence = set()
        for item in rows(claim["evidence"], 100, minimum=1):
            item = obj(item, ("evidenceId", "quote", "snapshotId"),
                       ("evidenceId", "quote", "snapshotId"))
            eid = identifier(item["evidenceId"])
            quote = text(item["quote"], 10_000)
            snapshot_id = identifier(item["snapshotId"])
            if eid in evidence_ids:
                fail("DUPLICATE_EVIDENCE")
            evidence_ids.add(eid)
            evidence.add(eid)
        allowed_pairs[cid] = evidence

    required_raw = e["brief"].get("requiredClaimRevisionIds", [])
    required = {identifier(v) for v in rows(required_raw, 100)}
    if required - claim_ids:
        fail("REQUIRED_REFERENCE")
    if e["contentMode"] == "CREATIVE":
        if claim_ids or required:
            fail("CREATIVE_EVIDENCE")
    elif not claim_ids:
        fail("MISSING_BASIS")
    return {"input": e, "allowed": allowed_pairs, "required": sorted(required)}


def normalize_paragraphs(raw_paragraphs: object, checked: dict) -> list[dict]:
    e = checked["input"]
    paragraphs = rows(raw_paragraphs, MAX_PARAGRAPHS, minimum=1)
    result = []
    segment_count = 0
    for index, paragraph in enumerate(paragraphs, 1):
        paragraph = obj(paragraph, ("segments",), ("segments",))
        segments = []
        for segment in rows(paragraph["segments"], MAX_SEGMENTS, minimum=1):
            segment = obj(segment, ("text", "claimRevisionId", "evidenceId"),
                          ("text", "claimRevisionId", "evidenceId"))
            value = text(segment["text"], MAX_TEXT_UTF16)
            cid = text(segment["claimRevisionId"], 36, empty=True)
            eid = text(segment["evidenceId"], 36, empty=True)
            if e["contentMode"] == "CREATIVE":
                if cid or eid:
                    fail("CREATIVE_MAPPING")
            else:
                if not cid or not eid or eid not in checked["allowed"].get(cid, set()):
                    fail("EVIDENCE_REFERENCE")
            segment_count += 1
            if segment_count > MAX_SEGMENTS:
                fail("SEGMENT_LIMIT")
            segments.append({"text": value, "claimRevisionId": cid, "evidenceId": eid})
        result.append({"paragraphId": f"p{index}", "segments": segments})
    return result


def validate_coverage(paragraphs: list[dict], checked: dict) -> None:
    if checked["input"]["contentMode"] != "FACTUAL":
        return
    covered = {segment["claimRevisionId"] for paragraph in paragraphs for segment in paragraph["segments"]}
    if set(checked["required"]) - covered:
        fail("REQUIRED_CLAIM_COVERAGE")
    if not covered:
        fail("FACTUAL_EMPTY")


def paragraph_text(paragraph: dict) -> str:
    return "".join(segment["text"] for segment in paragraph["segments"])


def render(paragraphs: list[dict], checked: dict) -> tuple[str, list[dict]]:
    e = checked["input"]
    pieces, mappings = [], []
    offset = 0
    factual = e["contentMode"] == "FACTUAL"
    for paragraph in paragraphs:
        if pieces:
            pieces.append("\n\n")
            offset += 2
        for segment in paragraph["segments"]:
            value = segment["text"]
            start = offset
            end = start + utf16_len(value)
            if factual:
                mappings.append({"startOffset": start, "endOffset": end, "quote": value,
                                 "claimRevisionId": segment["claimRevisionId"],
                                 "evidenceId": segment["evidenceId"]})
            pieces.append(value)
            offset = end
    content = "".join(pieces)
    token = "[ПОСИЛАННЯ]"
    if e["includeLink"]:
        if token not in content:
            content += ("\n\n" if content else "") + token
    elif token in content:
        fail("UNREQUESTED_LINK_PLACEHOLDER")
    if utf16_len(content) > MAX_TEXT_UTF16:
        fail("OUTPUT_TEXT_LIMIT")
    if len(mappings) > 100:
        fail("MAPPING_LIMIT")
    return content, mappings


def candidate_output(paragraphs: list[dict], checked: dict) -> dict:
    content, mappings = render(paragraphs, checked)
    return {"schemaVersion": "telegram-v1", "content": {"text": content, "mappings": mappings}}


def safe_reason(value: object) -> str:
    return text(value, 500)


def validate_review(raw: object, paragraphs: list[dict]) -> dict:
    review = obj(load(raw), ("status", "reasons", "issues"), ("status", "reasons", "issues"))
    if review["status"] not in ("ready", "needs_human", "insufficient_evidence"):
        fail("REVIEW_STATUS")
    reasons = [safe_reason(value) for value in rows(review["reasons"], 10)]
    indexes = {paragraph["paragraphId"]: paragraph_text(paragraph) for paragraph in paragraphs}
    issues = []
    seen = set()
    for issue in rows(review["issues"], MAX_ISSUES):
        issue = obj(issue, ("severity", "category", "paragraphId", "quote", "instruction"),
                    ("severity", "category", "paragraphId", "quote", "instruction"))
        if issue["severity"] not in ("critical", "major", "minor"):
            fail("ISSUE_SEVERITY")
        category = text(issue["category"], 60)
        pid = text(issue["paragraphId"], 20)
        quote = text(issue["quote"], 1000)
        instruction = text(issue["instruction"], 1000)
        if pid not in indexes or quote not in indexes[pid]:
            fail("ISSUE_LOCATOR")
        key = (pid, quote, category)
        if key in seen:
            fail("DUPLICATE_ISSUE")
        seen.add(key)
        issues.append({"severity": issue["severity"], "category": category, "paragraphId": pid,
                       "quote": quote, "instruction": instruction})
    return {"status": review["status"], "reasons": reasons, "issues": issues}


def serious(review: dict) -> bool:
    return any(issue["severity"] in ("critical", "major") for issue in review["issues"])


def review_outcome(review: dict, *, repaired: bool) -> tuple[str, bool]:
    if review["status"] == "insufficient_evidence":
        return "insufficient_evidence", False
    if review["status"] == "ready" and not serious(review):
        return "ready", False
    if not repaired and review["issues"]:
        return "running", True
    return "needs_human", False


def report(state: dict) -> dict:
    final = state.get("finalOutput")
    return {"schemaVersion": REPORT_SCHEMA, "status": state["status"],
            "contentHash": digest_output(final) if state["status"] == "ready" and final is not None else None,
            "validation": state.get("validation", {}), "reasons": state.get("reasons", [])}


def base_result(state: dict, *, request: dict | None = None, repair_required: int = 0) -> dict:
    final = report(state)
    output_json = dumps(state["finalOutput"]) if state["status"] == "ready" and state.get("finalOutput") is not None else ""
    report_json = dumps(final)
    if len(output_json.encode("utf-8")) > MAX_OUTPUT_BYTES or len(report_json.encode("utf-8")) > MAX_OUTPUT_BYTES:
        fail("OUTPUT_SIZE")
    return {"state": state, "request": request or {}, "repair_required": repair_required,
            "status": state["status"], "telegram_json": output_json, "telegram_report": report_json}


def model_input(checked: dict) -> dict:
    e = checked["input"]
    return {"inputMode": e["inputMode"], "contentMode": e["contentMode"], "includeLink": e["includeLink"],
            "brief": e["brief"], "style": e["style"], "claims": e["claims"], "context": e["context"],
            "article": e["article"], "requiredClaimRevisionIds": checked["required"]}


def main(operation: str, payload_json: str) -> str:
    payload = obj(load(payload_json))
    state = load(payload.get("state", {})) or {}

    if operation == "prepare":
        checked = validate_input(payload.get("editorial_json"))
        source = model_input(checked)
        state = {"schemaVersion": "telegram-state-v1", "input": source, "paragraphs": [], "review": None,
                 "repairCount": 0, "reviewCount": 0, "status": "running", "reasons": [], "validation": {}}
        request = {**source, "task": "Write a concise standalone Telegram post. Return paragraphs as selected text segments with exact approved claim/evidence IDs for every factual segment."}
        return dumps({"result": base_result(state, request=request)})

    if operation == "draft":
        checked = validate_input(payload.get("editorial_json"))
        if state.get("schemaVersion") != "telegram-state-v1":
            fail("STATE_CONTRACT")
        try:
            raw = obj(load(payload.get("raw")), ("paragraphs",), ("paragraphs",))
            paragraphs = normalize_paragraphs(raw["paragraphs"], checked)
            candidate_output(paragraphs, checked)
        except ValueError as exc:
            code = str(exc).replace("TELEGRAM_WORKFLOW_", "")[:80]
            state["paragraphs"] = []
            state["status"] = "needs_human"
            state["reasons"] = ["The generated candidate failed deterministic validation."]
            state["validation"] = {"inputMode": checked["input"]["inputMode"], "contentMode": checked["input"]["contentMode"],
                                   "includeLink": checked["input"]["includeLink"], "requiredClaimRevisionIds": checked["required"],
                                   "repairCount": 0, "reviewCount": 0, "candidateValidationError": code}
            return dumps({"result": base_result(state)})
        state["paragraphs"] = paragraphs
        state["validation"] = {"inputMode": checked["input"]["inputMode"], "contentMode": checked["input"]["contentMode"],
                               "includeLink": checked["input"]["includeLink"], "requiredClaimRevisionIds": checked["required"],
                               "coveredClaimRevisionIds": sorted({s["claimRevisionId"] for p in paragraphs for s in p["segments"] if s["claimRevisionId"]}),
                               "repairCount": 0, "reviewCount": 0}
        return dumps({"result": base_result(state)})

    if operation == "review_request":
        if state.get("status") != "running":
            return dumps({"result": base_result(state)})
        checked = validate_input(payload.get("editorial_json"))
        candidate = candidate_output(state.get("paragraphs", []), checked)
        request = {"input": model_input(checked), "candidate": candidate,
                   "paragraphs": state["paragraphs"], "reviewNumber": state.get("reviewCount", 0) + 1,
                   "priorReview": state.get("review")}
        return dumps({"result": base_result(state, request=request)})

    if operation == "review":
        if state.get("status") != "running":
            return dumps({"result": base_result(state)})
        checked = validate_input(payload.get("editorial_json"))
        review = validate_review(payload.get("raw"), state.get("paragraphs", []))
        state["review"] = review
        state["reviewCount"] = state.get("reviewCount", 0) + 1
        repaired = state.get("repairCount", 0) > 0
        status, needs_repair = review_outcome(review, repaired=repaired)
        state["status"] = status
        state["reasons"] = review["reasons"] or [i["instruction"] for i in review["issues"][:5]]
        state["validation"].update({"reviewCount": state["reviewCount"], "repairCount": state.get("repairCount", 0),
                                    "finalReviewStatus": review["status"], "issueCount": len(review["issues"])})
        request = {"input": model_input(checked), "paragraphs": state["paragraphs"], "issues": review["issues"],
                   "allowedParagraphIds": sorted({issue["paragraphId"] for issue in review["issues"]})} if needs_repair else {}
        return dumps({"result": base_result(state, request=request, repair_required=int(needs_repair))})

    if operation == "patch":
        checked = validate_input(payload.get("editorial_json"))
        review = state.get("review") or {}
        targets = sorted({issue["paragraphId"] for issue in review.get("issues", [])})
        try:
            patch = obj(load(payload.get("raw")), ("replacements",), ("replacements",))
            replacements = rows(patch["replacements"], MAX_PARAGRAPHS, minimum=1)
            replacement_map = {}
            for item in replacements:
                item = obj(item, ("paragraphId", "segments"), ("paragraphId", "segments"))
                pid = text(item["paragraphId"], 20)
                if pid in replacement_map:
                    fail("PATCH_DUPLICATE")
                replacement_map[pid] = item["segments"]
            if set(replacement_map) != set(targets) or not targets:
                fail("PATCH_SCOPE")
            staged = []
            for paragraph in state.get("paragraphs", []):
                if paragraph["paragraphId"] in replacement_map:
                    staged.append({"paragraphId": paragraph["paragraphId"], "segments": replacement_map[paragraph["paragraphId"]]})
                else:
                    staged.append(copy.deepcopy(paragraph))
            # Keep the controller-generated IDs and validate every new segment.
            raw_paragraphs = [{"segments": paragraph["segments"]} for paragraph in staged]
            paragraphs = normalize_paragraphs(raw_paragraphs, checked)
            if [p["paragraphId"] for p in paragraphs] != [p["paragraphId"] for p in staged]:
                fail("PATCH_LOCATOR")
            new_text = {p["paragraphId"]: paragraph_text(p) for p in paragraphs}
            if any(new_text[pid] == paragraph_text(old) for pid, old in
                   ((p["paragraphId"], p) for p in state["paragraphs"] if p["paragraphId"] in targets)):
                fail("PATCH_NO_PROGRESS")
            candidate_output(paragraphs, checked)
            state["paragraphs"] = paragraphs
            state["repairCount"] = 1
            state["validation"].update({"repairCount": 1})
            state["status"] = "running"
        except ValueError as exc:
            # Invalid or out-of-scope repairs yield a useful blocked report and
            # never expose the unrepaired candidate as ready.
            state["paragraphs"] = []
            state["status"] = "needs_human"
            state["reasons"] = ["The single targeted repair was invalid or made no progress."]
            state["validation"].update({"repairCount": 1, "repairError": str(exc).replace("TELEGRAM_WORKFLOW_", "")[:80]})
            state["repairCount"] = 1
        return dumps({"result": base_result(state)})

    if operation == "finalize":
        checked = validate_input(payload.get("editorial_json"))
        final = None
        if state.get("status") == "ready":
            try:
                validate_coverage(state.get("paragraphs", []), checked)
                output = candidate_output(state.get("paragraphs", []), checked)
                # Final gate: valid current review, complete factual coverage,
                # exact deterministic ranges and stable content hash.
                review = state.get("review") or {}
                if review.get("status") != "ready" or serious(review) or state.get("reviewCount") not in (1, 2):
                    fail("FINAL_REVIEW")
                final = output
            except ValueError as exc:
                state["status"] = "needs_human"
                state["reasons"] = ["The deterministic final validation did not pass."]
                state["validation"].update({"finalValidationError": str(exc).replace("TELEGRAM_WORKFLOW_", "")[:80]})
        if final is not None:
            state["finalOutput"] = final
            state["validation"].update({"outputSchemaVersion": "telegram-v1", "utf16Length": utf16_len(final["content"]["text"]),
                                        "mappingCount": len(final["content"]["mappings"]),
                                        "coveredClaimRevisionIds": sorted({m["claimRevisionId"] for m in final["content"]["mappings"]}),
                                        "factualMappingsVerified": checked["input"]["contentMode"] == "FACTUAL",
                                        "creativeUnverified": checked["input"]["contentMode"] == "CREATIVE"})
        else:
            state["finalOutput"] = None
            if state.get("status") == "running":
                state["status"] = "needs_human"
                state["reasons"] = ["Editorial review did not clear the candidate."]
        return dumps({"result": base_result(state)})

    fail("OPERATION")


if __name__ == "__main__":
    import sys
    print(main(sys.argv[1], sys.argv[2]))
