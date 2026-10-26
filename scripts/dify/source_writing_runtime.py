"""Deterministic guards for source-grounded writing candidates.

The model writes and reviews text. This runtime validates frozen identities,
literal locators, mandatory legacy claims, bounded revisions and final status;
it never approves content or treats a citation as proof of truth.
"""
from __future__ import annotations

import copy
import hashlib
import json
import math
import re
import uuid

MAX_INPUT_BYTES = 150_000
MAX_PASSAGE_CONTEXT_BYTES = 60_000
MAX_PASSAGES = 1000
MAX_OUTPUT_PASSAGE_IDS = 100
MAX_REQUIRED_CLAIMS = 100
MAX_SECTIONS = 30
MAX_PARAGRAPHS = 300
MAX_REVIEW_ISSUES = 20
MAX_MODEL_CALLS = 4
MAX_OUTPUT_BYTES = 450_000
MAX_STATE_BYTES = 750_000
MAX_SECTION_WORDS = 20_000
FORMATS = frozenset(("TELEGRAM_POST", "LINKEDIN_TEXT", "LINKEDIN_COVER", "INSTAGRAM_COVER",
                     "LINKEDIN_CAROUSEL", "INSTAGRAM_CAROUSEL", "INSTAGRAM_STORIES"))
SEVERITIES = frozenset(("minor", "major", "critical"))
BLOCKING = frozenset(("major", "critical"))


def fail(code: str) -> None:
    raise ValueError("SOURCE_WRITING_" + code)


def canonical(value: object) -> str:
    """Match the backend's recursively key-sorted JSON.stringify canonical form."""
    def js_string(item):
        rendered = json.dumps(item, ensure_ascii=False, separators=(",", ":"))
        # JSON.stringify escapes lone UTF-16 surrogates while preserving valid pairs.
        return re.sub(r"[\ud800-\udfff]", lambda match: "\\u%04x" % ord(match.group(0)), rendered)

    def js_number(item):
        try:
            number = float(item)
        except (OverflowError, TypeError, ValueError):
            fail("JSON_NUMBER")
        if not math.isfinite(number):
            fail("JSON_NUMBER")
        if number == 0:
            return "0"
        sign = "-" if number < 0 else ""
        raw = repr(abs(number)).lower()
        if "e" in raw:
            mantissa, exponent_text = raw.split("e", 1)
            exponent = int(exponent_text)
        else:
            mantissa, exponent = raw, 0
        if "." in mantissa:
            whole, fraction = mantissa.split(".", 1)
        else:
            whole, fraction = mantissa, ""
        digits = whole + fraction
        point = len(whole) + exponent
        leading = len(digits) - len(digits.lstrip("0"))
        digits = digits[leading:]
        point -= leading
        digits = digits.rstrip("0") or "0"
        decimal_exponent = point - 1
        if decimal_exponent >= 21 or decimal_exponent <= -7:
            significand = digits[0] + ("." + digits[1:] if len(digits) > 1 else "")
            exp = ("+" if decimal_exponent >= 0 else "") + str(decimal_exponent)
            return sign + significand + "e" + exp
        if point <= 0:
            return sign + "0." + ("0" * -point) + digits
        if point >= len(digits):
            return sign + digits + ("0" * (point - len(digits)))
        return sign + digits[:point] + "." + digits[point:]

    def encode(item):
        if item is None:
            return "null"
        if item is True:
            return "true"
        if item is False:
            return "false"
        if isinstance(item, str):
            return js_string(item)
        if isinstance(item, (int, float)):
            return js_number(item)
        if isinstance(item, list):
            return "[" + ",".join(encode(row) for row in item) + "]"
        if isinstance(item, dict):
            if not all(isinstance(key, str) for key in item):
                fail("JSON_KEY")
            keys = sorted(item, key=lambda key: key.encode("utf-16-be", "surrogatepass"))
            return "{" + ",".join(js_string(key) + ":" + encode(item[key]) for key in keys) + "}"
        fail("JSON_VALUE")

    try:
        return encode(value)
    except (TypeError, ValueError, RecursionError, UnicodeError):
        fail("JSON_VALUE")


def digest(value: object) -> str:
    return hashlib.sha256(canonical(value).encode("utf-8", "strict")).hexdigest()


def unique_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            fail("DUPLICATE_JSON_KEY")
        result[key] = value
    return result


def load(value):
    if isinstance(value, dict) or isinstance(value, list):
        return copy.deepcopy(value)
    if not isinstance(value, str):
        fail("JSON_TYPE")
    try:
        if len(value.encode("utf-8", "strict")) > 2 * 1024 * 1024:
            fail("JSON_SIZE")
        return json.loads(value, object_pairs_hook=unique_object,
                          parse_constant=lambda _: fail("JSON_NUMBER"))
    except (json.JSONDecodeError, UnicodeError, RecursionError):
        fail("JSON_INVALID")


def object_shape(value, required, optional=()):
    if not isinstance(value, dict) or not set(required) <= set(value) or set(value) - set(required) - set(optional):
        fail("OBJECT_SHAPE")
    return value


def string(value, maximum=4000, *, empty=False):
    if (not isinstance(value, str) or len(value.encode("utf-16-le")) // 2 > maximum
            or (not empty and not value.strip())):
        fail("TEXT_SHAPE")
    if re.search(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]", value):
        fail("TEXT_CONTROL")
    try:
        value.encode("utf-8", "strict")
    except UnicodeError:
        fail("TEXT_UNICODE")
    return value


def integer(value, low=0, high=MAX_SECTION_WORDS):
    if type(value) is not int or not low <= value <= high:
        fail("INTEGER_SHAPE")
    return value


def canonical_uuid(value):
    if not isinstance(value, str):
        fail("ID_FORMAT")
    try:
        if str(uuid.UUID(value)) != value or value != value.lower():
            fail("ID_FORMAT")
    except (ValueError, AttributeError, TypeError):
        fail("ID_FORMAT")
    return value


def array(value, maximum, minimum=0):
    if not isinstance(value, list) or not minimum <= len(value) <= maximum:
        fail("ARRAY_BOUNDS")
    return value


def exactly_once(haystack, needle):
    first = haystack.find(needle)
    return first >= 0 and haystack.find(needle, first + 1) < 0


def unique_ids(values, maximum=100):
    array(values, maximum)
    seen = set()
    result = []
    for value in values:
        ident = canonical_uuid(value)
        if ident in seen:
            fail("DUPLICATE_ID")
        seen.add(ident)
        result.append(ident)
    return result


def _brief(value):
    keys = ("topic", "audience", "centralMessage", "category", "tone", "targetLength", "cta", "exclusions", "notes")
    object_shape(value, keys)
    string(value["topic"], 500)
    string(value["audience"], 2000, empty=True)
    string(value["centralMessage"], 4000, empty=True)
    string(value["category"], 120, empty=True)
    string(value["tone"], 10_000, empty=True)
    integer(value["targetLength"], 50, MAX_SECTION_WORDS)
    string(value["cta"], 2000, empty=True)
    string(value["notes"], 10_000, empty=True)
    exclusions = array(value["exclusions"], 50)
    for item in exclusions:
        string(item, 500)
    return value


def _section(value, *, output=False):
    if output:
        object_shape(value, ("id", "title", "purpose", "targetWords", "passageIds", "requiredClaimRevisionIds"))
    else:
        object_shape(value, ("id", "title", "purpose", "targetWords"))
    canonical_uuid(value["id"])
    string(value["title"], 300)
    string(value["purpose"], 2000)
    integer(value["targetWords"], 20, MAX_SECTION_WORDS)
    if output:
        unique_ids(value["passageIds"], MAX_OUTPUT_PASSAGE_IDS)
        unique_ids(array(value["requiredClaimRevisionIds"], MAX_REQUIRED_CLAIMS))
    elif "passageIds" in value:
        unique_ids(array(value["passageIds"], MAX_PASSAGES))
    return value


def _paragraph(value):
    object_shape(value, ("id", "text", "citations"))
    canonical_uuid(value["id"])
    string(value["text"], 20_000)
    citations = array(value["citations"], 100)
    for citation in citations:
        kind = citation.get("kind") if isinstance(citation, dict) else None
        if kind == "source_passage":
            object_shape(citation, ("kind", "passageId", "quote", "assertionText"))
            canonical_uuid(citation["passageId"])
        elif kind == "approved_claim":
            object_shape(citation, ("kind", "claimRevisionId", "evidenceId", "quote", "assertionText"))
            canonical_uuid(citation["claimRevisionId"])
            canonical_uuid(citation["evidenceId"])
        else:
            fail("CITATION_KIND")
        string(citation["quote"], 10_000)
        string(citation["assertionText"], 10_000)
    return value


def _candidate(raw, state):
    value = load(raw)
    object_shape(value, ("task", "title", "sectionId", "sections", "paragraphs", "frames", "coverInstruction"))
    task = state["input"]["task"]
    if value["task"] != task:
        fail("CANDIDATE_TASK")
    title = string(value["title"], 500, empty=True)
    section_id = string(value["sectionId"], 36, empty=True)
    raw_sections = array(value["sections"], MAX_SECTIONS)
    raw_paragraphs = array(value["paragraphs"], 300)
    raw_frames = array(value["frames"], 30)
    cover_instruction = string(value["coverInstruction"], 2000, empty=True)
    if task != "ADAPTATION" and (raw_frames or cover_instruction):
        fail("CANDIDATE_TASK_FIELDS")
    if task == "OUTLINE":
        if section_id or raw_paragraphs:
            fail("CANDIDATE_TASK_FIELDS")
        string(title, 500)
        sections = raw_sections
        for section in sections:
            _section(section, output=True)
        if len({row["id"] for row in sections}) != len(sections):
            fail("DUPLICATE_SECTION")
        if sum(row["targetWords"] for row in sections) != state["input"]["brief"]["targetLength"]:
            fail("OUTLINE_WORD_BUDGET")
        return {"title": title, "sections": sections}
    if task == "SECTION":
        if title or raw_sections:
            fail("CANDIDATE_TASK_FIELDS")
        if canonical_uuid(section_id) != state["input"]["section"]["id"]:
            fail("SECTION_ID")
        paragraphs = [_clean_paragraph(row) for row in raw_paragraphs]
        array(paragraphs, MAX_PARAGRAPHS, 1)
        for paragraph in paragraphs:
            _paragraph(paragraph)
        if len({row["id"] for row in paragraphs}) != len(paragraphs):
            fail("DUPLICATE_PARAGRAPH")
        return {"sectionId": section_id, "paragraphs": paragraphs}
    if section_id or raw_sections:
        fail("CANDIDATE_TASK_FIELDS")
    paragraphs = [_clean_paragraph(row) for row in raw_paragraphs]
    array(paragraphs, MAX_PARAGRAPHS, 1)
    for paragraph in paragraphs:
        _paragraph(paragraph)
    if len({row["id"] for row in paragraphs}) != len(paragraphs):
        fail("DUPLICATE_PARAGRAPH")
    content = {"paragraphs": paragraphs}
    if title:
        content["title"] = title
    if raw_frames:
        content["frames"] = [_clean_frame(row) for row in raw_frames]
    if cover_instruction:
        content["coverInstruction"] = cover_instruction
    _channel_shape(content,state["input"])
    return content


def _clean_frame(raw):
    object_shape(raw, ("id","text","citations","purpose","visualHint","transition"))
    paragraph = _clean_paragraph({key: raw[key] for key in ("id","text","citations")})
    _paragraph(paragraph)
    string(paragraph["text"],3000)
    return {**paragraph,"purpose": string(raw["purpose"],200),"visualHint": string(raw["visualHint"],1000,empty=True),
            "transition": string(raw["transition"],300,empty=True)}


def _prose_rows(content):
    return content.get("paragraphs",[]) + content.get("frames",[])


def _channel_shape(content, request):
    if request["task"] != "ADAPTATION":
        return
    format_name = request["format"]
    scripted = format_name in ("LINKEDIN_CAROUSEL","INSTAGRAM_CAROUSEL","INSTAGRAM_STORIES")
    frames = content.get("frames",[])
    if scripted != bool(frames):
        fail("SCRIPT_FORMAT")
    prose = "\n\n".join(row["text"] for row in content["paragraphs"])
    string(prose,4080 if format_name == "TELEGRAM_POST" else 10000)
    cover = format_name in ("LINKEDIN_COVER","INSTAGRAM_COVER")
    if cover:
        string(content.get("title"),200)
        string(content.get("coverInstruction"),2000)
    elif "coverInstruction" in content:
        fail("COVER_FORMAT")
    if len({row["id"] for row in _prose_rows(content)}) != len(_prose_rows(content)):
        fail("DUPLICATE_PARAGRAPH")
    if sum(len(row["text"].encode("utf-16-le"))//2 for row in frames) > 30000 or sum(len(row["citations"]) for row in frames) > 100:
        fail("SCRIPT_BOUNDS")
    for frame in frames:
        string(frame["text"],3000)
        if (format_name == "INSTAGRAM_STORIES" and not frame["transition"].strip()
                or format_name != "INSTAGRAM_STORIES" and frame["transition"]):
            fail("SCRIPT_TRANSITION")
    if scripted and not any(c["kind"] == "source_passage" for row in frames for c in row["citations"]):
        fail("SCRIPT_SOURCE_REQUIRED")
    required = {row["claimRevisionId"] for row in request["requiredClaims"]}
    covered = {c["claimRevisionId"] for row in frames for c in row["citations"] if c["kind"] == "approved_claim"}
    if scripted and required - covered:
        fail("SCRIPT_REQUIRED_CLAIMS")


def _clean_paragraph(value):
    object_shape(value, ("id", "text", "citations"))
    citations = []
    for item in array(value["citations"], 100):
        object_shape(item, ("kind", "passageId", "claimRevisionId", "evidenceId", "quote", "assertionText"))
        if item["kind"] == "source_passage":
            if item["claimRevisionId"] or item["evidenceId"]:
                fail("CITATION_FIELDS")
            citations.append({"kind": "source_passage", "passageId": item["passageId"],
                              "quote": item["quote"], "assertionText": item["assertionText"]})
        elif item["kind"] == "approved_claim":
            if item["passageId"]:
                fail("CITATION_FIELDS")
            citations.append({"kind": "approved_claim", "claimRevisionId": item["claimRevisionId"],
                              "evidenceId": item["evidenceId"], "quote": item["quote"],
                              "assertionText": item["assertionText"]})
        else:
            fail("CITATION_KIND")
    return {"id": value["id"], "text": value["text"], "citations": citations}


def _validate_input(raw):
    value = load(raw)
    if not isinstance(value, dict):
        fail("INPUT_SHAPE")
    if len(canonical(value).encode("utf-8")) > MAX_INPUT_BYTES:
        fail("INPUT_BYTES_LIMIT")
    object_shape(value, ("schemaVersion", "requestId", "task", "brief", "style", "context", "passages", "requiredClaims"),
                 ("section", "approvedOutline", "format", "approvedArticle"))
    if value["schemaVersion"] != "source-writing-input-v1":
        fail("SCHEMA_VERSION")
    canonical_uuid(value["requestId"])
    if value["task"] not in ("OUTLINE", "SECTION", "ADAPTATION"):
        fail("TASK")
    _brief(value["brief"])
    style = object_shape(value["style"], ("brandbook", "tone", "settings"))
    string(style["brandbook"], 20_000, empty=True)
    string(style["tone"], 10_000, empty=True)
    canonical(style["settings"])
    style_context = array(value["context"], 100)
    context_ids = set()
    for item in style_context:
        object_shape(item, ("snapshotId", "purpose", "sha256", "text"))
        snapshot_id = canonical_uuid(item["snapshotId"])
        if snapshot_id in context_ids:
            fail("DUPLICATE_STYLE_CONTEXT")
        context_ids.add(snapshot_id)
        if item["purpose"] not in ("NOTES", "BRANDBOOK", "STYLE_SAMPLE"):
            fail("STYLE_CONTEXT_PURPOSE")
        if not isinstance(item["sha256"], str) or re.fullmatch(r"[a-f0-9]{64}", item["sha256"]) is None:
            fail("STYLE_CONTEXT_HASH")
        string(item["text"], 150_000, empty=True)
        if hashlib.sha256(item["text"].encode("utf-8", "strict")).hexdigest() != item["sha256"]:
            fail("STYLE_CONTEXT_HASH_MISMATCH")

    if value["task"] == "SECTION":
        if "section" not in value or "format" in value:
            fail("TASK_FIELDS")
        _section(value["section"])
    elif "section" in value:
        fail("TASK_FIELDS")
    if value["task"] == "ADAPTATION":
        if value.get("format") not in FORMATS or "approvedOutline" in value:
            fail("FORMAT")
    elif "format" in value:
        fail("TASK_FIELDS")

    if "approvedArticle" in value:
        if value["task"] != "ADAPTATION":
            fail("TASK_FIELDS")
        article = object_shape(value["approvedArticle"], ("versionId", "sha256", "title", "text"))
        canonical_uuid(article["versionId"])
        if not isinstance(article["sha256"], str) or re.fullmatch(r"[a-f0-9]{64}", article["sha256"]) is None:
            fail("ARTICLE_HASH")
        string(article["title"], 500)
        string(article["text"], 100_000)

    if "approvedOutline" in value:
        if value["task"] != "SECTION":
            fail("TASK_FIELDS")
        plan = value["approvedOutline"]
        object_shape(plan, ("title", "sections"))
        string(plan["title"], 500)
        sections = array(plan["sections"], MAX_SECTIONS, 1)
        for row in sections:
            _section(row)
        if len({row["id"] for row in sections}) != len(sections):
            fail("DUPLICATE_SECTION")
        if sum(row["targetWords"] for row in sections) != value["brief"]["targetLength"]:
            fail("APPROVED_OUTLINE_WORD_BUDGET")
        selected = next((row for row in sections if row["id"] == value["section"]["id"]), None)
        if value["task"] == "SECTION" and selected is None:
            fail("SECTION_NOT_IN_OUTLINE")
        if selected is not None and selected != value["section"]:
            fail("SECTION_NOT_MATCHED_TO_OUTLINE")

    passages = array(value["passages"], MAX_PASSAGES)
    passage_ids = set()
    for passage in passages:
        object_shape(passage, ("id", "packetId", "snapshotId", "quote"))
        for key in ("id", "packetId", "snapshotId"):
            canonical_uuid(passage[key])
        if passage["id"] in passage_ids:
            fail("DUPLICATE_PASSAGE")
        passage_ids.add(passage["id"])
        string(passage["quote"], 10_000)
    context_bytes = len(canonical({"passages": value["passages"],
                                   "requiredClaims": value["requiredClaims"]}).encode("utf-8"))
    if context_bytes > MAX_PASSAGE_CONTEXT_BYTES:
        fail("PASSAGE_CONTEXT_BYTES_LIMIT")

    claims = array(value["requiredClaims"], MAX_REQUIRED_CLAIMS)
    claim_ids = set()
    for claim in claims:
        object_shape(claim, ("claimRevisionId", "wording", "evidence"))
        claim_id = canonical_uuid(claim["claimRevisionId"])
        if claim_id in claim_ids:
            fail("DUPLICATE_REQUIRED_CLAIM")
        claim_ids.add(claim_id)
        string(claim["wording"], 2000)
        evidence = array(claim["evidence"], 10, 1)
        evidence_ids = set()
        for row in evidence:
            object_shape(row, ("evidenceId", "quote"))
            evidence_id = canonical_uuid(row["evidenceId"])
            if evidence_id in evidence_ids:
                fail("DUPLICATE_CLAIM_EVIDENCE")
            evidence_ids.add(evidence_id)
            string(row["quote"], 10_000)
    return value


def _citation_maps(input_value):
    passages = {row["id"]: row["quote"] for row in input_value["passages"]}
    claims = {}
    for claim in input_value["requiredClaims"]:
        claims[claim["claimRevisionId"]] = {
            "wording": claim["wording"],
            "evidence": {item["evidenceId"]: item["quote"] for item in claim["evidence"]},
        }
    return passages, claims


def _validate_paragraph_citations(paragraphs, state):
    input_value = state["input"]
    passages, claims = _citation_maps(input_value)
    claim_coverage = set()
    passage_coverage = set()
    for paragraph in paragraphs:
        text_value = paragraph["text"]
        cited_ranges = []
        for citation in paragraph["citations"]:
            assertion = citation["assertionText"]
            quote = citation["quote"]
            if not exactly_once(text_value, assertion):
                fail("ASSERTION_LOCATOR_NOT_UNIQUE")
            start = text_value.find(assertion)
            end = start + len(assertion)
            if any(max(start, other_start) < min(end, other_end)
                   for other_start, other_end in cited_ranges):
                fail("ASSERTION_LOCATOR_OVERLAP")
            cited_ranges.append((start, end))
            if citation["kind"] == "source_passage":
                passage_id = citation["passageId"]
                source_quote = passages.get(passage_id)
                if source_quote is None:
                    fail("UNKNOWN_PASSAGE")
                if not exactly_once(source_quote, quote):
                    fail("QUOTE_LOCATOR_NOT_UNIQUE")
                passage_coverage.add(passage_id)
            else:
                claim_id = citation["claimRevisionId"]
                claim = claims.get(claim_id)
                if claim is None:
                    fail("UNKNOWN_CLAIM")
                source_quote = claim["evidence"].get(citation["evidenceId"])
                if source_quote is None:
                    fail("UNKNOWN_CLAIM_EVIDENCE")
                if not exactly_once(source_quote, quote):
                    fail("QUOTE_LOCATOR_NOT_UNIQUE")
                if input_value["task"] == "ADAPTATION" and (quote != source_quote or assertion != source_quote):
                    fail("LEGACY_CHANNEL_QUOTE_CHANGED")
                claim_coverage.add(claim_id)
    required = {claim["claimRevisionId"] for claim in input_value["requiredClaims"]}
    if required - claim_coverage:
        fail("REQUIRED_CLAIM_COVERAGE")
    if not any(paragraph["citations"] for paragraph in paragraphs):
        fail("MISSING_CITATIONS")
    return sorted(passage_coverage), sorted(claim_coverage)


def _validate_outline(state, content):
    input_value = state["input"]
    allowed_passages = {item["id"] for item in input_value["passages"]}
    required_claims = {item["claimRevisionId"] for item in input_value["requiredClaims"]}
    selected_passages = set()
    selected_claims = set()
    approved = input_value.get("approvedOutline")
    approved_sections = {row["id"]: row for row in approved["sections"]} if approved else {}
    for section in content["sections"]:
        if approved_sections and section["id"] not in approved_sections:
            fail("UNKNOWN_OUTLINE_SECTION")
        if set(section["passageIds"]) - allowed_passages:
            fail("UNKNOWN_PASSAGE")
        if set(section["requiredClaimRevisionIds"]) - required_claims:
            fail("UNKNOWN_CLAIM")
        selected_passages.update(section["passageIds"])
        selected_claims.update(section["requiredClaimRevisionIds"])
    if required_claims - selected_claims:
        fail("REQUIRED_CLAIM_COVERAGE")
    if not any(row["passageIds"] or row["requiredClaimRevisionIds"] for row in content["sections"]):
        fail("MISSING_OUTLINE_EVIDENCE")
    if approved_sections and {row["id"] for row in content["sections"]} != set(approved_sections):
        fail("APPROVED_OUTLINE_SECTION_SET")
    return sorted(selected_passages), sorted(selected_claims)


def _target_texts(content):
    result = {}
    if "paragraphs" in content:
        for paragraph in _prose_rows(content):
            result[paragraph["id"]] = paragraph["text"] + ("\n"+paragraph["purpose"]+"\n"+paragraph["visualHint"]+"\n"+paragraph["transition"] if "purpose" in paragraph else "")
    if "sections" in content:
        for section in content["sections"]:
            result[section["id"]] = section["title"] + "\n" + section["purpose"]
    return result


def _review(raw, state):
    value = load(raw)
    object_shape(value, ("reviewedHash", "status", "issues", "reasons"))
    if value["reviewedHash"] != state["contentHash"]:
        fail("STALE_REVIEW")
    if value["status"] not in ("ready", "needs_human", "insufficient_evidence"):
        fail("REVIEW_STATUS")
    issues = array(value["issues"], MAX_REVIEW_ISSUES)
    targets = _target_texts(state["content"])
    issue_ids = set()
    for issue in issues:
        object_shape(issue, ("id", "severity", "paragraphId", "sectionId", "reason"))
        ident = string(issue["id"], 80)
        if ident in issue_ids:
            fail("DUPLICATE_ISSUE")
        issue_ids.add(ident)
        if issue["severity"] not in SEVERITIES:
            fail("ISSUE_SEVERITY")
        string(issue["reason"], 1000)
        target_id = issue["paragraphId"] or issue["sectionId"]
        if issue["paragraphId"] and issue["sectionId"]:
            fail("ISSUE_TARGET_AMBIGUOUS")
        if target_id:
            canonical_uuid(target_id)
            if target_id not in targets:
                fail("UNKNOWN_ISSUE_TARGET")
        elif issue["severity"] in BLOCKING:
            fail("BLOCKING_ISSUE_WITHOUT_TARGET")
    reasons = array(value["reasons"], 10)
    for reason in reasons:
        string(reason, 500)
    return value


def _patch(raw, state):
    patch_value = load(raw)
    object_shape(patch_value, ("reviewedHash", "paragraphReplacements", "sectionReplacements"))
    if patch_value["reviewedHash"] != state["contentHash"]:
        fail("STALE_PATCH")
    content = copy.deepcopy(state["content"])
    issues = [issue for issue in state["review"]["issues"] if issue["severity"] in BLOCKING]
    flagged_paragraphs = {issue["paragraphId"] for issue in issues if issue["paragraphId"]}
    flagged_sections = {issue["sectionId"] for issue in issues if issue["sectionId"]}
    paragraph_replacements = array(patch_value["paragraphReplacements"], MAX_PARAGRAPHS)
    section_replacements = array(patch_value["sectionReplacements"], MAX_SECTIONS)
    seen_paragraphs = set()
    seen_sections = set()
    for replacement in paragraph_replacements:
        object_shape(replacement, ("paragraphId", "paragraph"))
        ident = canonical_uuid(replacement["paragraphId"])
        if ident not in flagged_paragraphs or ident in seen_paragraphs:
            fail("UNFLAGGED_PARAGRAPH_PATCH")
        seen_paragraphs.add(ident)
        paragraph = _clean_paragraph(replacement["paragraph"])
        _paragraph(paragraph)
        if paragraph["id"] != ident:
            fail("PATCH_PARAGRAPH_ID")
        target = next((row for row in _prose_rows(content) if row["id"] == ident), None)
        if target is None:
            fail("UNKNOWN_PATCH_PARAGRAPH")
        if "purpose" in target:
            content["frames"][content["frames"].index(target)] = {**target,**paragraph}
        else:
            content["paragraphs"][content["paragraphs"].index(target)] = paragraph
    for replacement in section_replacements:
        object_shape(replacement, ("sectionId", "section"))
        ident = canonical_uuid(replacement["sectionId"])
        if ident not in flagged_sections or ident in seen_sections:
            fail("UNFLAGGED_SECTION_PATCH")
        seen_sections.add(ident)
        section = _section(replacement["section"], output=True)
        if section["id"] != ident:
            fail("PATCH_SECTION_ID")
        target = next((row for row in content.get("sections", []) if row["id"] == ident), None)
        if target is None:
            fail("UNKNOWN_PATCH_SECTION")
        content["sections"][content["sections"].index(target)] = section
    if seen_paragraphs != flagged_paragraphs or seen_sections != flagged_sections:
        fail("INCOMPLETE_PATCH")
    if "paragraphs" in content:
        if [row["id"] for row in content["paragraphs"]] != [row["id"] for row in state["content"]["paragraphs"]]:
            fail("PATCH_CHANGED_PARAGRAPH_SET")
        _channel_shape(content,state["input"])
        passage_ids, claim_ids = _validate_paragraph_citations(_prose_rows(content), state)
    else:
        if [row["id"] for row in content["sections"]] != [row["id"] for row in state["content"]["sections"]]:
            fail("PATCH_CHANGED_SECTION_SET")
        passage_ids, claim_ids = _validate_outline(state, content)
    return content, passage_ids, claim_ids


def _state_json(state):
    rendered = canonical(state)
    if len(rendered.encode("utf-8")) > MAX_STATE_BYTES:
        fail("STATE_BYTES_LIMIT")
    return rendered


def _report(state):
    review = state.get("review") or {}
    normalized_issues = []
    for issue in review.get("issues", []):
        item = {"id": issue["id"], "severity": issue["severity"], "reason": issue["reason"]}
        if issue.get("paragraphId"):
            item["paragraphId"] = issue["paragraphId"]
        if issue.get("sectionId"):
            item["sectionId"] = issue["sectionId"]
        normalized_issues.append(item)
    reasons = review.get("reasons") or state.get("reasons", [])
    return {"status": state["status"], "issues": normalized_issues,
            "reasons": reasons, "modelCalls": state["modelCalls"]}


def _result(state):
    status = state["status"]
    content = state.get("content") if status == "ready" else None
    review = _report(state)
    envelope = {"schemaVersion": "source-writing-v1", "requestId": state["input"]["requestId"],
                "inputHash": state["inputHash"], "task": state["input"]["task"],
                "status": status, "content": content, "review": review}
    rendered = canonical(envelope)
    if len(rendered.encode("utf-8")) > MAX_OUTPUT_BYTES:
        state.update({"status": "needs_human", "content": None,
                      "reasons": ["Результат перевищив безпечний розмір і потребує ручного скорочення."]})
        review = _report(state)
        envelope.update({"status": "needs_human", "content": None, "review": review})
        rendered = canonical(envelope)
        if len(rendered.encode("utf-8")) > MAX_OUTPUT_BYTES:
            fail("OUTPUT_BYTES_LIMIT")
    return {"source_writing_json": rendered, "source_writing_report": canonical(review)}


def execute(operation, payload):
    value = load(payload)
    if not isinstance(value, dict):
        fail("PAYLOAD_SHAPE")
    if operation == "prepare":
        input_value = _validate_input(value.get("source_writing_request_json"))
        state = {"phase": "author", "input": input_value, "inputHash": digest(input_value),
                 "modelCalls": 0, "status": "running", "content": None,
                 "contentHash": "", "review": None, "usedPassageIds": [], "usedClaimRevisionIds": [],
                 "reasons": []}
        if not input_value["passages"] and not input_value["requiredClaims"]:
            state.update({"phase": "done", "status": "insufficient_evidence",
                          "reasons": ["Немає уривків або обов’язкових схвалених тверджень для цього завдання."]})
        return {"state": state, "request": {}, "status": state["status"]}

    state = load(value.get("state_json"))
    if not isinstance(state, dict) or not isinstance(state.get("input"), dict):
        fail("STATE_SHAPE")

    if operation == "author_request":
        if state["status"] != "running" or state["phase"] != "author":
            fail("AUTHOR_PHASE")
        request = {key: state["input"].get(key) for key in
                   ("task", "brief", "style", "context", "section", "approvedOutline", "format", "approvedArticle", "passages", "requiredClaims")
                   if key in state["input"]}
        return {"state": state, "request": request, "status": "running"}

    if operation == "draft":
        if state["status"] != "running" or state["phase"] != "author":
            fail("DRAFT_PHASE")
        state["modelCalls"] += 1
        try:
            content = _candidate(value.get("model_json"), state)
            if len(canonical(content).encode("utf-8")) > MAX_OUTPUT_BYTES - 30_000:
                fail("OUTPUT_CONTENT_BYTES_LIMIT")
            if "paragraphs" in content:
                passage_ids, claim_ids = _validate_paragraph_citations(_prose_rows(content), state)
            else:
                passage_ids, claim_ids = _validate_outline(state, content)
            section = state["input"].get("section")
            if section and "paragraphs" in content:
                words = sum(len(row["text"].split()) for row in content["paragraphs"])
                target = section["targetWords"]
                if not math.ceil(target * 0.8) <= words <= math.floor(target * 1.2):
                    fail("SECTION_WORD_BUDGET")
            state.update({"content": content, "contentHash": digest(content), "phase": "review",
                          "usedPassageIds": passage_ids, "usedClaimRevisionIds": claim_ids})
        except ValueError as exc:
            reason = str(exc).replace("SOURCE_WRITING_", "")[:100]
            state.update({"content": None, "contentHash": "", "phase": "done", "status": "needs_human",
                          "reasons": ["Чернетка не пройшла перевірку структури або доказових посилань: " + reason]})
        return {"state": state, "request": {}, "status": state["status"]}

    if operation == "review_request":
        if state["status"] != "running" or state["phase"] not in ("review", "review_again"):
            fail("REVIEW_REQUEST_PHASE")
        request = {"task": state["input"]["task"], "brief": state["input"]["brief"],
                   "style": state["input"]["style"], "context": state["input"]["context"],
                   "section": state["input"].get("section"),
                   "approvedOutline": state["input"].get("approvedOutline"),
                   "approvedArticle": state["input"].get("approvedArticle"),
                   "format": state["input"].get("format"),
                   "passages": state["input"]["passages"], "requiredClaims": state["input"]["requiredClaims"],
                   "content": state["content"], "reviewedHash": state["contentHash"]}
        return {"state": state, "request": request, "status": "running"}

    if operation == "review":
        if state["status"] != "running" or state["phase"] not in ("review", "review_again"):
            fail("REVIEW_PHASE")
        state["modelCalls"] += 1
        try:
            review = _review(value.get("model_json"), state)
            blocking = [issue for issue in review["issues"] if issue["severity"] in BLOCKING]
            state["review"] = review
            if review["status"] == "insufficient_evidence":
                state.update({"content": None, "phase": "done", "status": "insufficient_evidence",
                              "reasons": review["reasons"] or ["Потрібно більше підтверджувальних матеріалів."]})
            elif state["modelCalls"] >= MAX_MODEL_CALLS or not blocking:
                if blocking or review["status"] != "ready":
                    state.update({"content": None, "phase": "done", "status": "needs_human",
                                  "reasons": review["reasons"] or ["Перевірка залишила суттєві питання."]})
                else:
                    state.update({"phase": "done", "status": "ready", "reasons": review["reasons"]})
            else:
                state["phase"] = "repair"
        except ValueError as exc:
            reason = str(exc).replace("SOURCE_WRITING_", "")[:100]
            state.update({"content": None, "phase": "done", "status": "needs_human",
                          "reasons": ["Перевірка не відповідає актуальній версії чернетки: " + reason]})
        return {"state": state, "request": {}, "status": state["status"]}

    if operation == "repair_request":
        if state["status"] != "running" or state["phase"] != "repair" or state["modelCalls"] >= MAX_MODEL_CALLS - 1:
            fail("REPAIR_REQUEST_PHASE")
        request = {"task": state["input"]["task"], "brief": state["input"]["brief"],
                   "style": state["input"]["style"], "context": state["input"]["context"],
                   "section": state["input"].get("section"),
                   "approvedOutline": state["input"].get("approvedOutline"),
                   "approvedArticle": state["input"].get("approvedArticle"),
                   "format": state["input"].get("format"),
                   "passages": state["input"]["passages"], "requiredClaims": state["input"]["requiredClaims"],
                   "content": state["content"],
                   "reviewedHash": state["contentHash"],
                   "issues": [issue for issue in state["review"]["issues"] if issue["severity"] in BLOCKING]}
        return {"state": state, "request": request, "status": "running"}

    if operation == "patch":
        if state["status"] != "running" or state["phase"] != "repair":
            fail("PATCH_PHASE")
        state["modelCalls"] += 1
        try:
            state["content"], state["usedPassageIds"], state["usedClaimRevisionIds"] = _patch(value.get("model_json"), state)
            section = state["input"].get("section")
            if section and "paragraphs" in state["content"]:
                words = sum(len(row["text"].split()) for row in state["content"]["paragraphs"])
                if not math.ceil(section["targetWords"] * 0.8) <= words <= math.floor(section["targetWords"] * 1.2):
                    fail("SECTION_WORD_BUDGET")
            state["contentHash"] = digest(state["content"])
            state["phase"] = "review_again"
        except ValueError as exc:
            reason = str(exc).replace("SOURCE_WRITING_", "")[:100]
            state.update({"content": None, "phase": "done", "status": "needs_human",
                          "reasons": ["Адресна правка не пройшла перевірку: " + reason]})
        return {"state": state, "request": {}, "status": state["status"]}

    if operation == "finalize":
        if state["modelCalls"] > MAX_MODEL_CALLS:
            fail("MODEL_CALL_LIMIT")
        if state["status"] == "running":
            state.update({"content": None, "phase": "done", "status": "needs_human",
                          "reasons": ["Workflow завершився до фінальної перевірки."]})
        if state["status"] == "ready":
            if state.get("content") is None or (state.get("review") or {}).get("status") != "ready":
                fail("READY_WITHOUT_REVIEW")
            # Re-check the final reviewed output against the original frozen input.
            if "paragraphs" in state["content"]:
                _channel_shape(state["content"],state["input"])
                passage_ids, claim_ids = _validate_paragraph_citations(_prose_rows(state["content"]), state)
            else:
                passage_ids, claim_ids = _validate_outline(state, state["content"])
            state["usedPassageIds"], state["usedClaimRevisionIds"] = passage_ids, claim_ids
        result = _result(state)
        return {"state": state, **result, "status": state["status"]}

    fail("OPERATION")


def main(operation, payload_json):
    result = execute(operation, payload_json)
    return canonical({"result": result})


if __name__ == "__main__":
    import sys
    print(main(sys.argv[1], sys.stdin.read()))
