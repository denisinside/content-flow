"""Bounded, provider-free runtime for a reviewed outline candidate.

Model reviews assess meaning; deterministic checks protect frozen references,
revision coverage and targeted edits. This module never grants approval.
"""
import copy
import hashlib
import json
import re
import uuid

MAX_BYTES = 350000
MAX_CALLS = 16
SIGNIFICANT = {"critical", "major"}
STRATEGY_FIELDS = ("readerNeed", "angle", "promise", "narrativeLogic", "exclusions")
SECTION_FIELDS = ("sectionId", "title", "purpose", "keyMessage", "readerQuestion", "claimRevisionIds", "targetWords", "transition")


def fail(code):
    raise ValueError("OUTLINE_WORKFLOW_" + code)


def dumps(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False)


def digest(value):
    return hashlib.sha256(dumps(value).encode("utf-8")).hexdigest()


def load(value):
    if not isinstance(value, str):
        return copy.deepcopy(value)
    # The entry-point envelope carries several independently bounded JSON
    # strings; its aggregate must not be mistaken for one Code-node string.
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
        return json.loads(value, object_pairs_hook=pairs, parse_constant=lambda _: fail("JSON_NUMBER"))
    except (json.JSONDecodeError, RecursionError):
        fail("JSON_INVALID")


def size(value, maximum=MAX_BYTES):
    if len(dumps(value).encode("utf-8")) > maximum:
        fail("SIZE_LIMIT")


def obj(value, keys):
    if not isinstance(value, dict) or set(value) != set(keys):
        fail("OBJECT_SHAPE")
    return value


def text(value, maximum=2000, empty=False):
    if not isinstance(value, str) or len(value.encode("utf-16-le")) // 2 > maximum or (not empty and not value.strip()):
        fail("TEXT_SHAPE")
    if re.search(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]", value):
        fail("TEXT_CONTROL")
    return value


def items(value, maximum=100, minimum=0):
    if not isinstance(value, list) or not minimum <= len(value) <= maximum:
        fail("ARRAY_SHAPE")
    return value


def integer(value, low=0, high=20000):
    if type(value) is not int or not low <= value <= high:
        fail("INTEGER_SHAPE")
    return value


def identifier(value):
    if not isinstance(value, str):
        fail("REFERENCE_FORMAT")
    try:
        if str(uuid.UUID(value)) != value.lower():
            fail("REFERENCE_FORMAT")
    except (ValueError, AttributeError):
        fail("REFERENCE_FORMAT")
    return value


def ids(value):
    result = [identifier(v) for v in items(value)]
    if len({v.lower() for v in result}) != len(result):
        fail("DUPLICATE_REFERENCE")
    return result


def context(value):
    e = obj(load(value), ("schemaVersion", "contentMode", "brief", "style", "claims", "context"))
    size(e)
    if e["schemaVersion"] != "outline-context-v1" or e["contentMode"] not in ("FACTUAL", "CREATIVE"):
        fail("INPUT_CONTRACT")
    brief = obj(e["brief"], ("topic", "audience", "centralMessage", "category", "tone", "targetLength", "cta", "exclusions", "notes", "requiredClaimRevisionIds"))
    for key, maximum in (("topic", 500), ("audience", 2000), ("centralMessage", 4000), ("category", 120), ("tone", 10000), ("cta", 2000), ("notes", 10000)):
        text(brief[key], maximum, key != "topic")
    integer(brief["targetLength"], 50, 20000)
    for value in items(brief["exclusions"], 50):
        text(value, 500)
    required = ids(brief["requiredClaimRevisionIds"])
    style = obj(e["style"], ("brandbook", "tone", "settings"))
    text(style["brandbook"], MAX_BYTES, True)
    text(style["tone"], 10000, True)
    claims = set()
    for claim in items(e["claims"], 100):
        obj(claim, ("claimRevisionId", "wording", "evidence"))
        cid = identifier(claim["claimRevisionId"])
        if cid.lower() in claims:
            fail("DUPLICATE_CLAIM")
        claims.add(cid.lower())
        text(claim["wording"], 10000)
        evidence = set()
        for row in items(claim["evidence"], 100, 1):
            obj(row, ("evidenceId", "quote", "snapshotId"))
            eid = identifier(row["evidenceId"])
            if eid.lower() in evidence:
                fail("DUPLICATE_EVIDENCE")
            evidence.add(eid.lower())
            identifier(row["snapshotId"])
            text(row["quote"], 10000)
    if {v.lower() for v in required} - claims:
        fail("REQUIRED_REFERENCE")
    if e["contentMode"] == "CREATIVE" and (claims or required):
        fail("CREATIVE_EVIDENCE")
    if e["contentMode"] == "FACTUAL" and not claims:
        fail("MISSING_BASIS")
    snapshots = set()
    for row in items(e["context"], 100):
        obj(row, ("snapshotId", "purpose", "sha256", "text"))
        sid = identifier(row["snapshotId"])
        if sid.lower() in snapshots:
            fail("DUPLICATE_CONTEXT")
        snapshots.add(sid.lower())
        text(row["purpose"], 2000, True)
        text(row["text"], MAX_BYTES, True)
        if row["sha256"] != hashlib.sha256(row["text"].encode("utf-8")).hexdigest():
            fail("CONTEXT_HASH")
    return e


def strategy(value):
    obj(value, STRATEGY_FIELDS)
    for key in STRATEGY_FIELDS[:-1]:
        text(value[key])
    for row in items(value["exclusions"], 50):
        text(row, 500)
    return copy.deepcopy(value)


def plan(value, e):
    obj(value, ("title", "sections"))
    text(value["title"], 500)
    allowed = {c["claimRevisionId"] for c in e["claims"]}
    covered, section_ids, budget = set(), set(), 0
    for section in items(value["sections"], 30, 1):
        obj(section, SECTION_FIELDS)
        sid = section["sectionId"]
        if not isinstance(sid, str) or not re.fullmatch(r"s(?:[1-9]|[12][0-9]|30)", sid) or sid in section_ids:
            fail("SECTION_ID")
        section_ids.add(sid)
        for key, maximum in (("title", 300), ("purpose", 2000), ("keyMessage", 1500), ("readerQuestion", 1000), ("transition", 1000)):
            text(section[key], maximum, key == "transition")
        references = ids(section["claimRevisionIds"])
        if set(references) - allowed:
            fail("PLAN_REFERENCE")
        covered.update(references)
        budget += integer(section["targetWords"], 1, 20000)
    if budget != e["brief"]["targetLength"]:
        fail("WORD_BUDGET")
    if set(e["brief"]["requiredClaimRevisionIds"]) - covered:
        fail("REQUIRED_COVERAGE")
    return copy.deepcopy(value)


def version(state):
    return digest(state["strategy"] if state["phase"] == "strategy" else state["plan"])


def reviews(state):
    if state["phase"] == "strategy":
        return [state["strategyReview"]]
    return [state["editorialReview"], state["groundingReview"]]


def issues(state):
    return [v for review in reviews(state) if review for v in review["issues"]]


def checked_review(raw, state, scope):
    obj(raw, ("reviewedHash", "issues"))
    if raw["reviewedHash"] != version(state):
        fail("STALE_REVIEW")
    seen = set()
    for issue in items(raw["issues"], 40):
        obj(issue, ("issueId", "severity", "category", "targetId", "field", "quote", "instruction", "acceptance"))
        key = text(issue["issueId"], 80)
        if key in seen or issue["severity"] not in ("critical", "major", "minor"):
            fail("ISSUE_SHAPE")
        seen.add(key)
        for field in ("category", "instruction", "acceptance"):
            text(issue[field], 1000 if field != "category" else 100)
        quote = text(issue["quote"], 1000, True)
        target, field = issue["targetId"], issue["field"]
        if scope == "strategy":
            if target != "strategy" or field not in STRATEGY_FIELDS:
                fail("ISSUE_TARGET")
            value = state["strategy"][field]
        elif target == "article":
            if field not in ("title", "sections"):
                fail("ISSUE_TARGET")
            value = state["plan"][field]
        else:
            section = next((s for s in state["plan"]["sections"] if s["sectionId"] == target), None)
            if section is None or field not in SECTION_FIELDS[1:]:
                fail("ISSUE_TARGET")
            value = section[field]
        if field in ("sections", "targetWords"):
            if quote:
                fail("ISSUE_ANCHOR")
        elif isinstance(value, list):
            if (not value and quote) or (value and (not quote or quote not in value)):
                fail("ISSUE_ANCHOR")
        elif (not value and quote) or (value and (not quote or quote not in value)):
            fail("ISSUE_ANCHOR")
    return copy.deepcopy(raw)


def request(state, role, counted=True):
    result = {"context": state["editorial"], "strategy": state["strategy"], "plan": state["plan"],
              "reviewedHash": version(state), "issues": issues(state), "role": role}
    size(result)
    if counted:
        state["modelCalls"] += 1
        if state["modelCalls"] > MAX_CALLS:
            fail("CALL_LIMIT")
    return result


def decision(state):
    current = reviews(state)
    if any(r is None or r["reviewedHash"] != version(state) for r in current):
        fail("MISSING_CURRENT_REVIEW")
    significant = any(v["severity"] in SIGNIFICANT for v in issues(state))
    revision_key, maximum = ("strategyRevisions", 1) if state["phase"] == "strategy" else ("outlineRevisions", 2)
    if not significant:
        state["mode"], state["decisionHash"] = "pass", version(state)
        if state["phase"] == "outline":
            state["status"] = "ready"
    elif state[revision_key] >= maximum:
        state["mode"], state["status"], state["reason"] = "blocked", "needs_human", "UNRESOLVED_" + state["phase"].upper()
    else:
        state["mode"] = "edit"


def checked_patch(raw, state):
    candidate_key = "strategy" if state["phase"] == "strategy" else "plan"
    obj(raw, ("reviewedHash", candidate_key))
    if state["mode"] != "edit" or raw["reviewedHash"] != version(state):
        fail("STALE_PATCH")
    updated = strategy(raw[candidate_key]) if candidate_key == "strategy" else plan(raw[candidate_key], state["editorial"])
    original = state[candidate_key]
    if updated == original:
        fail("PATCH_NO_CHANGE")
    allowed = {(v["targetId"], v["field"]) for v in issues(state)}
    if candidate_key == "strategy":
        if any(updated[k] != original[k] and ("strategy", k) not in allowed for k in STRATEGY_FIELDS):
            fail("UNFLAGGED_EDIT")
    else:
        if updated["title"] != original["title"] and ("article", "title") not in allowed:
            fail("UNFLAGGED_EDIT")
        structural = ("article", "sections") in allowed
        old = {s["sectionId"]: s for s in original["sections"]}
        new = {s["sectionId"]: s for s in updated["sections"]}
        if not structural and [s["sectionId"] for s in updated["sections"]] != [s["sectionId"] for s in original["sections"]]:
            fail("STRUCTURE_EDIT")
        for sid in set(old) & set(new):
            for field in SECTION_FIELDS[1:]:
                if new[sid][field] != old[sid][field] and (sid, field) not in allowed:
                    fail("UNFLAGGED_EDIT")
        # Renaming a stable unchanged section is never a valid structural edit.
        for sid in set(new) - set(old):
            if any({k: v for k, v in new[sid].items() if k != "sectionId"} == {k: v for k, v in old[previous].items() if k != "sectionId"} for previous in set(old) - set(new)):
                fail("SECTION_RENAMED")
    return updated


def execute(operation, payload):
    out, report, req = None, None, {}
    if operation == "prepare":
        e = context(payload["editorial_json"])
        state = {"editorial": e, "inputHash": digest(e), "phase": "strategy", "strategy": None, "plan": None,
                 "strategyReview": None, "editorialReview": None, "groundingReview": None,
                 "strategyRevisions": 0, "outlineRevisions": 0, "modelCalls": 0,
                 "decisionHash": "", "status": "running", "mode": "draft", "reason": ""}
        size(state)
        req = request(state, "strategist")
    else:
        state = load(payload["state_json"])
        e = context(state["editorial"])
        if state["inputHash"] != digest(e):
            fail("INPUT_HASH")
        if "editorial_json" in payload and context(payload["editorial_json"]) != e:
            fail("INPUT_CHANGED")
        raw = load(payload.get("model_json", payload.get("raw", {})))
        if state["status"] != "running" and operation != "finalize":
            fail("TERMINAL_STATE")
        if operation == "strategy_draft":
            if state["phase"] != "strategy" or state["strategy"] is not None:
                fail("STAGE")
            state["strategy"] = strategy(raw)
            req = request(state, "strategy_reviewer")
        elif operation == "strategy_review_request":
            if state["phase"] != "strategy" or state["strategy"] is None:
                fail("STAGE")
            req = request(state, "strategy_reviewer", False)
        elif operation == "strategy_review":
            if state["phase"] != "strategy" or state["strategy"] is None:
                fail("STAGE")
            state["strategyReview"] = checked_review(raw, state, "strategy")
        elif operation == "strategy_decision":
            if state["phase"] != "strategy":
                fail("STAGE")
            decision(state)
            if state["mode"] == "edit":
                req = request(state, "strategy_editor")
        elif operation == "strategy_patch":
            if state["phase"] != "strategy" or state["strategyRevisions"] >= 1:
                fail("REVISION_LIMIT")
            state["strategy"] = checked_patch(raw, state)
            state["strategyRevisions"] += 1
            state["strategyReview"], state["decisionHash"], state["mode"] = None, "", "review"
            req = request(state, "strategy_reviewer")
        elif operation == "plan_request":
            if state["phase"] != "strategy" or state["mode"] != "pass" or state["decisionHash"] != version(state):
                fail("STRATEGY_NOT_REVIEWED")
            state["phase"], state["mode"], state["decisionHash"] = "outline", "draft", ""
            req = request(state, "architect")
        elif operation == "plan_draft":
            if state["phase"] != "outline" or state["plan"] is not None:
                fail("STAGE")
            state["plan"] = plan(raw, e)
            req = request(state, "editorial_reviewer")
        elif operation in ("review", "review_request"):
            scope = payload["scope"]
            if state["phase"] != "outline" or state["plan"] is None or scope not in ("editorial", "grounding"):
                fail("STAGE")
            if operation == "review_request":
                req = request(state, scope + "_reviewer", False)
            else:
                if scope == "grounding" and (not state["editorialReview"] or state["editorialReview"]["reviewedHash"] != version(state)):
                    fail("REVIEW_ORDER")
                state[scope + "Review"] = checked_review(raw, state, scope)
                if scope == "editorial":
                    req = request(state, "grounding_reviewer")
        elif operation == "decision":
            if state["phase"] != "outline":
                fail("STAGE")
            decision(state)
            if state["mode"] == "edit":
                req = request(state, "outline_editor")
        elif operation == "plan_patch":
            if state["phase"] != "outline" or state["outlineRevisions"] >= 2:
                fail("REVISION_LIMIT")
            state["plan"] = checked_patch(raw, state)
            state["outlineRevisions"] += 1
            state["editorialReview"], state["groundingReview"], state["decisionHash"], state["mode"] = None, None, "", "review"
            req = request(state, "editorial_reviewer")
        elif operation != "finalize":
            fail("OPERATION")
    if operation == "finalize":
        if state["status"] == "ready":
            if state["phase"] != "outline" or state["decisionHash"] != version(state) or not state["strategyReview"] or state["strategyReview"]["reviewedHash"] != digest(state["strategy"]) or any(v["severity"] in SIGNIFICANT for v in state["strategyReview"]["issues"]) or any(r is None or r["reviewedHash"] != version(state) for r in reviews(state)) or any(v["severity"] in SIGNIFICANT for v in issues(state)):
                fail("FINAL_NOT_REVIEWED")
            current = plan(state["plan"], state["editorial"])
            out = {"schemaVersion": "outline-v1", "content": {"title": current["title"], "sections": [
                {"title": s["title"], "purpose": s["purpose"], "claimRevisionIds": s["claimRevisionIds"]} for s in current["sections"]]}}
            size(out)
        elif state["status"] == "running":
            state["status"], state["reason"] = "needs_human", "INCOMPLETE_WORKFLOW"
        report = {"schemaVersion": "outline-review-report-v1", "status": state["status"], "reason": state["reason"],
                  "inputHash": state["inputHash"], "finalVersionHash": version(state), "modelCalls": state["modelCalls"],
                  "strategyRevisions": state["strategyRevisions"], "outlineRevisions": state["outlineRevisions"],
                  "strategy": state["strategy"], "sectionPlan": state["plan"],
                  "unresolvedIssues": issues(state), "humanApprovalRequired": True, "semanticChecks": "model_review_not_proof"}
        size(report, 256000)
    size(state)
    size(req)
    return {"state": state, "request": req, "done": int(state["mode"] in ("pass", "blocked") or state["status"] != "running"),
            "status": state["status"], "mode": state["mode"], "outline_json": out, "outline_report": report}


def main(operation, payload_json):
    try:
        return {"result_json": dumps(execute(operation, load(payload_json)))}
    except ValueError as error:
        if str(error).startswith("OUTLINE_WORKFLOW_"):
            raise
        fail("INVALID_VALUE")
    except (KeyError, TypeError, UnicodeError, OverflowError, RecursionError):
        fail("INVALID_PAYLOAD")
