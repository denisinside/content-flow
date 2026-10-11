"""Self-contained, provider-free Code-node runtime for the editorial workflow.

main(operation, payload_json) is the only Dify entry point. Inputs are frozen
editorial_json, state_json, raw model JSON and (for review) scope. No source
material is included in exception messages. Graph nodes must use the returned
state and must never authorize publication or human approval.
"""
import copy
import hashlib
import json
import re
import uuid

MAX_BYTES = 350000
MAX_CALLS = 200
SCOPES = ("global", "language", "factual")
SEVERITY = {"critical": 10000, "major": 100, "minor": 1}


def fail(code):
    raise ValueError("ARTICLE_WORKFLOW_" + code)


def dumps(value):
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"), sort_keys=True, allow_nan=False)


def digest(value):
    return hashlib.sha256(dumps(value).encode("utf-8")).hexdigest()


def load(value):
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


def obj(value, required=(), allowed=None):
    if not isinstance(value, dict) or any(key not in value for key in required):
        fail("OBJECT_SHAPE")
    if allowed is not None and set(value) - set(allowed):
        fail("OBJECT_FIELDS")
    return value


def text(value, maximum=2000, empty=False):
    if not isinstance(value, str) or len(value) > maximum or (not empty and not value.strip()):
        fail("TEXT_SHAPE")
    if re.search(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]", value):
        fail("TEXT_CONTROL")
    return value


def items(value, maximum=100, minimum=0):
    if not isinstance(value, list) or not minimum <= len(value) <= maximum:
        fail("ARRAY_SHAPE")
    return value


def integer(value, minimum=0, maximum=20000):
    if type(value) is not int or not minimum <= value <= maximum:
        fail("INTEGER_SHAPE")
    return value


def identifier(value):
    text(value, 36)
    try:
        if str(uuid.UUID(value)) != value.lower():
            fail("REFERENCE_FORMAT")
    except (ValueError, AttributeError):
        fail("REFERENCE_FORMAT")
    return value


def ids(value):
    result = [identifier(v) for v in items(value)]
    if len(set(result)) != len(result):
        fail("DUPLICATE_REFERENCE")
    return result


def size(value):
    if len(dumps(value).encode("utf-8")) > MAX_BYTES:
        fail("STATE_SIZE")


def context(value):
    e = obj(load(value), ("schemaVersion", "contentMode", "brief", "outline", "claims", "style", "context"))
    size(e)
    if e["schemaVersion"] != "article-context-v1" or e["contentMode"] not in ("FACTUAL", "CREATIVE"):
        fail("INPUT_CONTRACT")
    brief = obj(e["brief"], ("targetLength", "requiredClaimRevisionIds"))
    integer(brief["targetLength"], 50, 20000)
    required = ids(brief["requiredClaimRevisionIds"])
    outline = obj(e["outline"], ("title", "sections"), ("title", "sections"))
    text(outline["title"], 500)
    references = {}
    for claim in items(e["claims"], 100):
        obj(claim, ("claimRevisionId", "wording", "evidence"))
        cid = identifier(claim["claimRevisionId"])
        text(claim["wording"], 10000)
        if cid in references:
            fail("DUPLICATE_CLAIM")
        evidence = set()
        for row in items(claim["evidence"], 100, 1):
            obj(row, ("evidenceId", "quote", "snapshotId"))
            eid = identifier(row["evidenceId"])
            identifier(row["snapshotId"])
            text(row["quote"], 10000)
            if eid in evidence:
                fail("DUPLICATE_EVIDENCE")
            evidence.add(eid)
        references[cid] = evidence
    if set(required) - set(references):
        fail("REQUIRED_REFERENCE")
    if e["contentMode"] == "CREATIVE" and (references or required):
        fail("CREATIVE_EVIDENCE")
    if e["contentMode"] == "FACTUAL" and not references:
        fail("MISSING_BASIS")
    for section in items(outline["sections"], 30, 1):
        obj(section, ("title", "purpose", "claimRevisionIds"), ("title", "purpose", "claimRevisionIds"))
        text(section["title"], 300)
        text(section["purpose"], 2000)
        if set(ids(section["claimRevisionIds"])) - set(references):
            fail("OUTLINE_REFERENCE")
    obj(e["style"])
    items(e["context"], 100)
    return e


def references(e):
    return {c["claimRevisionId"]: {v["evidenceId"] for v in c["evidence"]} for c in e["claims"]}


def active_id(s):
    if not s["plan"] or s["cursor"] >= len(s["order"]):
        fail("NO_ACTIVE_SECTION")
    return s["order"][s["cursor"]]


def plan_section(s, sid):
    for row in s["plan"]["sections"]:
        if row["sectionId"] == sid:
            return row
    fail("SECTION_REFERENCE")


def blocks(s, scope):
    if scope == "section":
        sid = active_id(s)
        return {sid: s["sections"].get(sid, [])}
    return s["sections"]


def version(s, scope):
    return digest(s["plan"] if scope == "plan" else blocks(s, scope))


def block_text(block):
    return "".join(v["text"] for v in block["spans"])


def article_metrics(e, s):
    target = e["brief"]["targetLength"]
    return {"wordCount": sum(len(re.findall(r"\S+", block_text(b)))
                              for rows in s["sections"].values() for b in rows),
            "targetWords": target, "minWords": (80 * target + 99) // 100,
            "maxWords": (120 * target) // 100}


def article_length_valid(e, s):
    metrics = article_metrics(e, s)
    return metrics["minWords"] <= metrics["wordCount"] <= metrics["maxWords"]


def editorial_issues(issues):
    # A critical finding is never waived, even if labelled as length.
    return [i for i in issues if i["category"] != "length" or i["severity"] == "critical"]


def shorter_after_edit(e, s):
    baseline = s.get("lengthEditBaseline")
    return bool(baseline and s["globalRounds"] > 0 and
                version(s, "global") != baseline["versionHash"] and
                all(s["reviews"].get(scope, {}).get("versionHash") == version(s, "global") for scope in SCOPES) and
                article_metrics(e, s)["wordCount"] < article_metrics(e, s)["minWords"] and
                not significant(editorial_issues(s["globalIssues"])) and not s["localBlockers"] and
                issue_score(editorial_issues(s["globalIssues"])) < baseline["issueScore"])


def length_findings(e, s):
    metrics = article_metrics(e, s)
    if article_length_valid(e, s):
        return []
    # One real editable anchor per section; never force the whole shortage into
    # an introduction. This bounded list is also the editor's patch allowlist.
    findings = []
    for row in s["plan"]["sections"]:
        sid = row["sectionId"]
        block = max((b for b in s["sections"][sid] if b["type"] != "heading"),
                    key=lambda b: len(block_text(b)))
        findings.append({"id": "controller-length-" + sid, "severity": "major", "category": "length",
            "sectionId": sid, "blockId": block["id"], "quote": block_text(block)[:200],
            "instruction": "Тіло статті має " + str(metrics["wordCount"]) + " слів; ціль " +
                str(metrics["targetWords"]) + ", діапазон " + str(metrics["minWords"]) + "–" +
                str(metrics["maxWords"]) + ". Скоригуйте обсяг у дозволених блоках, зберігши вже виправлений текст. " +
                "Не повертайте усунуті дефекти, не вигадуйте факти і не додавайте порожнє наповнення.",
            "acceptance": "Змістовний текст у межах 80–120% цілі зі збереженими фактами та редакторськими правками."})
    return findings


def finish_shorter_after_edit(e, s):
    if not shorter_after_edit(e, s):
        return False
    for issue in s["globalIssues"]:
        if issue["category"] == "length" and issue["severity"] != "critical":
            issue["severity"] = "minor"
    s["reviewedFinalHash"] = version(s, "global")
    s["lengthException"] = True
    return True


def coverage(rows):
    return {v["claimRevisionId"] for values in rows.values() for b in values for v in b["spans"] if v.get("claimRevisionId")}


def validate_block(block, e, sid):
    block = copy.deepcopy(block)
    obj(block, ("id", "type", "spans"), ("id", "type", "spans", "level"))
    bid = text(block["id"], 80)
    if not re.fullmatch(re.escape(sid) + r"-b[1-9][0-9]{0,3}", bid):
        fail("BLOCK_ID")
    if block["type"] not in ("paragraph", "heading", "bullet", "ordered", "blockquote"):
        fail("BLOCK_TYPE")
    if (block["type"] == "heading") != ("level" in block) or ("level" in block and block["level"] != 3):
        fail("HEADING_LEVEL")
    ref = references(e)
    for span in items(block["spans"], 40, 1):
        obj(span, ("text",), ("text", "claimRevisionId", "evidenceId"))
        # Unmapped separators between factual spans may be a single space.
        # Preserve them verbatim; the whole block still needs visible text.
        text(span["text"], 10000, empty=True)
        if not span["text"]:
            fail("TEXT_SHAPE")
        # Structured-output schemas require both reference fields even for
        # creative prose. Empty pairs are the canonical unmapped sentinel.
        if span.get("claimRevisionId") == "" and span.get("evidenceId") == "":
            del span["claimRevisionId"]
            del span["evidenceId"]
        if ("claimRevisionId" in span) != ("evidenceId" in span):
            fail("SPAN_REFERENCE")
        if "claimRevisionId" in span:
            if not span["text"].strip():
                fail("SPAN_REFERENCE")
            if e["contentMode"] != "FACTUAL" or span["evidenceId"] not in ref.get(span["claimRevisionId"], set()):
                fail("SPAN_REFERENCE")
    if not block_text(block).strip():
        fail("EMPTY_BLOCK")
    return copy.deepcopy(block)


def validate_section(raw, e, s):
    obj(raw, ("sectionId", "blocks"), ("sectionId", "blocks"))
    sid = active_id(s)
    if raw["sectionId"] != sid:
        fail("SECTION_ORDER")
    values = [validate_block(b, e, sid) for b in items(raw["blocks"], 60, 1)]
    if len({b["id"] for b in values}) != len(values):
        fail("DUPLICATE_BLOCK")
    if not any(b["type"] != "heading" for b in values):
        fail("EMPTY_SECTION")
    if set(plan_section(s, sid)["claimRevisionIds"]) - coverage({sid: values}):
        fail("SECTION_COVERAGE")
    return values


def issue_key(issue):
    return digest({k: issue[k] for k in ("sectionId", "blockId", "category", "quote", "instruction")})


def issue_score(issues):
    return sum(SEVERITY[v["severity"]] for v in issues)


def significant(issues):
    return any(v["severity"] in ("critical", "major") for v in issues)


def check_review(raw, s, scope, e=None):
    obj(raw, ("versionHash", "issues"), ("versionHash", "issues", "resolvedIssueIds"))
    if raw["versionHash"] != version(s, scope):
        fail("STALE_REVIEW")
    result, seen, issue_ids = [], set(), set()
    for issue in items(raw["issues"], 40):
        fields = ("id", "severity", "category", "sectionId", "blockId", "quote", "instruction", "acceptance")
        obj(issue, fields, fields)
        for key in fields:
            text(issue[key], 1000 if key in ("instruction", "acceptance", "quote") else 80)
        if issue["severity"] not in SEVERITY:
            fail("ISSUE_SEVERITY")
        sid, bid = issue["sectionId"], issue["blockId"]
        if scope == "plan":
            if bid != "plan":
                fail("PLAN_LOCATOR")
            anchor = dumps(plan_section(s, sid))
        elif bid in ("title", "heading") and e is not None and scope in SCOPES:
            if sid not in {row["sectionId"] for row in s["plan"]["sections"]}:
                fail("ISSUE_LOCATOR")
            if scope == "section" and sid != active_id(s):
                fail("ISSUE_LOCATOR")
            if bid == "title":
                if sid != "s1":
                    fail("ISSUE_LOCATOR")
                anchor = e["outline"]["title"]
            else:
                index = int(sid[1:]) - 1
                anchor = e["outline"]["sections"][index]["title"]
        else:
            matches = [b for b in blocks(s, scope).get(sid, []) if b["id"] == bid]
            if len(matches) != 1:
                fail("ISSUE_LOCATOR")
            anchor = block_text(matches[0])
        if issue["quote"] not in anchor:
            fail("ISSUE_ANCHOR")
        if issue["id"] in issue_ids:
            fail("DUPLICATE_ISSUE_ID")
        issue_ids.add(issue["id"])
        key = issue_key(issue)
        if key in seen:
            continue
        seen.add(key)
        result.append(copy.deepcopy(issue))
    resolved = items(raw.get("resolvedIssueIds", []), 100)
    for iid in resolved:
        text(iid, 80)
    if len(set(resolved)) != len(resolved) or set(resolved) - {i["id"] for i in s["localBlockers"]}:
        fail("ISSUE_CLOSURE_REFERENCE")
    if scope not in SCOPES and resolved:
        fail("ISSUE_CLOSURE_SCOPE")
    return {"versionHash": raw["versionHash"], "issues": result, "resolvedIssueIds": resolved}


def call(s):
    if s["calls"] >= MAX_CALLS:
        s["status"] = "needs_human"
        s["reasons"] = ["MODEL_CALL_BUDGET_EXHAUSTED"]
        return False
    s["calls"] += 1
    return True


def plan_request(e, s):
    return {"editorial": e, "sectionIds": ["s" + str(i + 1) for i in range(len(e["outline"]["sections"]))],
            "previousPlan": s["plan"], "feedback": s["planReview"], "remainingCalls": MAX_CALLS - s["calls"]}


def section_request(e, s):
    sid = active_id(s)
    chosen = plan_section(s, sid)
    needed = set(chosen["claimRevisionIds"])
    prior = s["memory"]
    result = {"brief": e["brief"], "contentMode": e["contentMode"], "style": e["style"],
            "context": e["context"], "approvedOutline": e["outline"], "plan": s["plan"],
            "section": chosen, "claims": [c for c in e["claims"] if c["claimRevisionId"] in needed],
            "memory": prior, "currentBlocks": s["sections"].get(sid, []),
            "versionHash": version(s, "section"), "feedback": s["sectionReview"],
            "mode": "patch" if s["sections"].get(sid) else "draft", "allowedBlockIdPrefix": sid + "-b",
            "allowedPatchTargets": [{"sectionId": sid, "blockId": bid} for sid, bid in sorted({
                (i["sectionId"], i["blockId"]) for i in (s["sectionReview"] or {}).get("issues", [])
                if i["blockId"] not in ("title", "heading")})],
            "remainingCalls": MAX_CALLS - s["calls"]}
    if chosen["role"] in ("introduction", "conclusion"):
        result["acceptedSections"] = [{"sectionId": row["sectionId"], "blocks": s["sections"][row["sectionId"]]}
                                      for row in s["plan"]["sections"] if row["sectionId"] in s["sections"]]
    return result


def article_request(e, s):
    return {"editorial": e, "plan": s["plan"], "sections": s["sections"],
            "versionHash": version(s, "global"), "localBlockers": s["localBlockers"],
            "feedback": s["globalIssues"], "previousReviews": s["reviews"],
            "readOnlyBlocks": [{"sectionId": "s1", "blockId": "title", "text": e["outline"]["title"]}] +
                              [{"sectionId": "s" + str(i + 1), "blockId": "heading", "text": row["title"]}
                               for i, row in enumerate(e["outline"]["sections"])],
            "metrics": article_metrics(e, s),
            "allowedPatchTargets": [{"sectionId": sid, "blockId": bid} for sid, bid in sorted({
                (i["sectionId"], i["blockId"]) for i in s["globalIssues"]
                if i["blockId"] not in ("title", "heading")})],
            "remainingCalls": MAX_CALLS - s["calls"]}


def apply_patch(raw, e, s, scope):
    obj(raw, ("versionHash", "replacements"), ("versionHash", "replacements"))
    if raw["versionHash"] != version(s, scope):
        fail("STALE_PATCH")
    feedback = s["sectionReview"]["issues"] if scope == "section" else s["globalIssues"]
    allowed = {(i["sectionId"], i["blockId"]) for i in feedback if i["blockId"] not in ("title", "heading")}
    if not allowed:
        fail("UNREQUESTED_PATCH")
    before = coverage(s["sections"])
    candidate, seen = copy.deepcopy(s["sections"]), set()
    for patch in items(raw["replacements"], 60, 1):
        obj(patch, ("sectionId", "blockId", "block"), ("sectionId", "blockId", "block"))
        sid, bid = patch["sectionId"], patch["blockId"]
        if (sid, bid) not in allowed or (sid, bid) in seen:
            fail("PATCH_LOCATOR")
        seen.add((sid, bid))
        value = validate_block(patch["block"], e, sid)
        if value["id"] != bid:
            fail("PATCH_ID")
        matches = [i for i, b in enumerate(candidate.get(sid, [])) if b["id"] == bid]
        if len(matches) != 1:
            fail("PATCH_LOCATOR")
        candidate[sid][matches[0]] = value
    if before - coverage(candidate):
        fail("PATCH_COVERAGE_REGRESSION")
    for sid, rows in candidate.items():
        if not any(b["type"] != "heading" for b in rows):
            fail("EMPTY_SECTION")
        if set(plan_section(s, sid)["claimRevisionIds"]) - coverage({sid: rows}):
            fail("PATCH_SECTION_REGRESSION")
    if digest(candidate) == digest(s["sections"]):
        return False
    s["sections"] = candidate
    s["reviews"] = {}
    s["closureVotes"] = {}
    return True


def compile_article(e, s):
    content, nodes, marks = [], 1, 0
    def paragraph(block):
        nonlocal nodes, marks
        inline = []
        # Adjacent equal evidence marks are joined by the backend. Join them
        # here first so the exact quote stays equal to the resulting text.
        joined = []
        for span in block["spans"]:
            if (joined and "claimRevisionId" in span and
                    span.get("claimRevisionId") == joined[-1].get("claimRevisionId") and
                    span.get("evidenceId") == joined[-1].get("evidenceId")):
                joined[-1]["text"] += span["text"]
                if len(joined[-1]["text"]) > 10000:
                    fail("EVIDENCE_QUOTE_LIMIT")
            else:
                joined.append(copy.deepcopy(span))
        for span in joined:
            node = {"type": "text", "text": span["text"]}
            if "claimRevisionId" in span:
                marks += 1
                node["marks"] = [{"type": "evidence", "attrs": {"claimRevisionId": span["claimRevisionId"],
                                  "evidenceId": span["evidenceId"], "quote": span["text"]}}]
            inline.append(node)
        nodes += 1 + len(inline)
        result = {"type": "heading" if block["type"] == "heading" else "paragraph", "content": inline}
        if block["type"] == "heading":
            result["attrs"] = {"level": 3}
        return result
    for i, frozen in enumerate(e["outline"]["sections"]):
        sid = "s" + str(i + 1)
        if not s["sections"].get(sid):
            fail("INCOMPLETE_ARTICLE")
        content.append({"type": "heading", "attrs": {"level": 2}, "content": [{"type": "text", "text": frozen["title"]}]})
        nodes += 2
        for b in s["sections"][sid]:
            p = paragraph(b)
            if b["type"] in ("bullet", "ordered"):
                list_type = "bulletList" if b["type"] == "bullet" else "orderedList"
                item = {"type": "listItem", "content": [p]}
                nodes += 1
                if content[-1]["type"] == list_type and len(content[-1]["content"]) < 1000:
                    content[-1]["content"].append(item)
                else:
                    content.append({"type": list_type, "content": [item]})
                    nodes += 1
            elif b["type"] == "blockquote":
                content.append({"type": "blockquote", "content": [p]})
                nodes += 1
            else:
                content.append(p)
    result = {"schemaVersion": "article-v1", "content": {"title": e["outline"]["title"], "document": {"type": "doc", "content": content}}}
    if nodes > 5000 or marks > 200 or len(content) > 1000 or len(dumps(result["content"]).encode("utf-8")) > 500000:
        fail("ARTICLE_LIMITS")
    return result


def emit(s, request=None, done=False, **extra):
    size(s)
    request = request or {}
    size(request)
    result = {"state": s, "request": request, "done": int(done or s["status"] != "running"), "status": s["status"]}
    result.update(extra)
    return result


def dispatch(operation, p):
    e = context(p.get("editorial_json", p.get("editorial")))
    if operation == "prepare":
        s = {"schemaVersion": "article-runtime-v1", "inputHash": digest(e), "status": "running", "reasons": [],
             "calls": 0, "plan": None, "planReview": None, "planRounds": 0, "order": [], "cursor": 0,
             "sections": {}, "sectionReview": None, "sectionRounds": 0, "bestSection": None,
             "localBlockers": [], "memory": [], "reviews": {}, "globalIssues": [], "globalRounds": 0,
             "closureVotes": {}, "history": [], "reviewedFinalHash": None, "bestArticle": None,
             "restoredEarlierVersion": False, "lengthEditBaseline": None, "lengthException": False}
        return emit(s, plan_request(e, s), editorial_json=dumps(e))
    s = obj(load(p.get("state_json", p.get("state"))), ("schemaVersion", "inputHash", "status", "calls"))
    size(s)
    if s["schemaVersion"] != "article-runtime-v1" or s["inputHash"] != digest(e):
        fail("FROZEN_CONTEXT_CHANGED")
    integer(s["calls"], 0, MAX_CALLS)
    if s["status"] not in ("running", "ready", "needs_human", "insufficient_evidence"):
        fail("STATE_STATUS")
    if s["status"] != "running" and operation != "finalize":
        return emit(s, done=True)
    raw = load(p.get("raw")) if "raw" in p else None
    if operation == "plan_request":
        return emit(s, plan_request(e, s))
    if operation == "plan":
        if s["sections"]:
            fail("PLAN_FROZEN")
        if not call(s):
            return emit(s, done=True)
        obj(raw, ("status", "reasons"), ("status", "reasons", "sections", "terminology"))
        if raw["status"] not in ("ready", "needs_human", "insufficient_evidence"):
            fail("PLAN_STATUS")
        reasons = [text(v, 1000) for v in items(raw["reasons"], 10)]
        if raw["status"] != "ready":
            if not reasons:
                fail("MISSING_REASON")
            s["status"], s["reasons"] = raw["status"], reasons
            return emit(s, done=True)
        sections = items(raw.get("sections"), 30, 1)
        if len(sections) != len(e["outline"]["sections"]):
            fail("PLAN_STRUCTURE")
        allowed_refs = references(e)
        for i, row in enumerate(sections):
            fields = ("sectionId", "role", "readerQuestion", "thesis", "paragraphPlan", "claimRevisionIds", "targetWords", "avoidRepeating", "transition")
            obj(row, fields, fields)
            if row["sectionId"] != "s" + str(i + 1) or row["role"] not in ("body", "introduction", "conclusion"):
                fail("PLAN_SECTION")
            if row["role"] == "introduction" and i != 0 or row["role"] == "conclusion" and i != len(sections) - 1:
                fail("PLAN_BOOKEND")
            for key in ("readerQuestion", "thesis", "transition"):
                text(row[key], 2000, empty=key == "transition")
            for v in items(row["paragraphPlan"], 12, 1):
                text(v, 1000)
            for v in items(row["avoidRepeating"], 12):
                text(v, 1000)
            row_ids = ids(row["claimRevisionIds"])
            if set(row_ids) - set(allowed_refs) or set(e["outline"]["sections"][i]["claimRevisionIds"]) - set(row_ids):
                fail("PLAN_CLAIMS")
            integer(row["targetWords"], 1, 20000)
        assigned = {v for row in sections for v in row["claimRevisionIds"]}
        if set(e["brief"]["requiredClaimRevisionIds"]) - assigned:
            fail("PLAN_REQUIRED_CLAIMS")
        total = sum(row["targetWords"] for row in sections)
        if not (80 * e["brief"]["targetLength"] + 99) // 100 <= total <= (120 * e["brief"]["targetLength"]) // 100:
            fail("PLAN_LENGTH")
        if not any(row["role"] == "body" for row in sections):
            # Role is scheduling metadata rather than the approved structure.
            # A valid short outline can consist of bookends only: generate its
            # first section as body, then let the closing section read it.
            sections[0]["role"] = "body"
        terminology = []
        for entry in items(raw.get("terminology", []), 50):
            obj(entry, ("term", "definition"), ("term", "definition"))
            text(entry["term"], 200)
            text(entry["definition"], 1000)
            terminology.append(copy.deepcopy(entry))
        s["plan"] = {"sections": sections, "terminology": terminology}
        s["order"] = [v["sectionId"] for role in ("body", "introduction", "conclusion") for v in sections if v["role"] == role]
        s["planReview"] = None
        req = {"editorial": e, "plan": s["plan"], "versionHash": version(s, "plan"),
               "serializedSections": {row["sectionId"]: dumps(row) for row in sections}}
        return emit(s, req)
    if operation == "plan_review":
        if s["plan"] is None or s["sections"]:
            fail("PLAN_REVIEW_PHASE")
        if not call(s):
            return emit(s, done=True)
        review = check_review(raw, s, "plan", e)
        s["planReview"] = review
        needs = significant(review["issues"])
        if needs and s["planRounds"] >= 1:
            s["status"], s["reasons"] = "needs_human", ["PLAN_REVIEW_LIMIT"]
        elif needs:
            s["planRounds"] += 1
        return emit(s, plan_request(e, s) if needs else section_request(e, s), done=not needs)
    if operation == "section_request":
        if s["cursor"] >= len(s["order"]):
            return emit(s, done=True)
        if not s["planReview"] or significant(s["planReview"]["issues"]):
            fail("UNREVIEWED_PLAN")
        req = section_request(e, s)
        return emit(s, req, mode=req["mode"])
    if operation == "section_draft":
        sid = active_id(s)
        if s["sections"].get(sid):
            fail("DUPLICATE_SECTION_DRAFT")
        if not call(s):
            return emit(s, done=True)
        s["sections"][sid] = validate_section(raw, e, s)
        return emit(s, section_request(e, s))
    if operation == "section_patch":
        if s["sectionRounds"] >= 2:
            fail("SECTION_PATCH_LIMIT")
        if not call(s):
            return emit(s, done=True)
        if not apply_patch(raw, e, s, "section"):
            s["status"], s["reasons"] = "needs_human", ["EDITOR_NO_PROGRESS"]
            return emit(s, done=True)
        s["sectionRounds"] += 1
        return emit(s, section_request(e, s))
    if operation == "section_review":
        sid = active_id(s)
        if not s["sections"].get(sid):
            fail("UNDRAFTED_SECTION")
        if not call(s):
            return emit(s, done=True)
        review = check_review(raw, s, "section", e)
        s["sectionReview"] = review
        score = issue_score(review["issues"])
        best = s["bestSection"]
        if best is None or score <= best["score"]:
            s["bestSection"] = {"score": score, "blocks": copy.deepcopy(s["sections"][sid]), "review": review}
        done = not significant(review["issues"]) or s["sectionRounds"] >= 2
        return emit(s, section_request(e, s), done=done)
    if operation == "advance":
        sid = active_id(s)
        if not s["sectionReview"]:
            fail("UNREVIEWED_SECTION")
        if significant(s["sectionReview"]["issues"]) and s["sectionRounds"] < 2:
            return emit(s, section_request(e, s))
        best = s["bestSection"]
        s["sections"][sid] = best["blocks"]
        # Prefix issue IDs by section to avoid reviewer-local ID collisions.
        for issue in best["review"]["issues"]:
            if issue["severity"] in ("major", "critical"):
                v = copy.deepcopy(issue)
                v["id"] = "local-" + digest({"section": sid, "hash": best["review"]["versionHash"], "id": v["id"]})[:24]
                s["localBlockers"].append(v)
        chosen = plan_section(s, sid)
        rows = s["sections"][sid]
        s["memory"].append({"sectionId": sid, "thesis": chosen["thesis"],
                            "usedClaims": sorted(coverage({sid: rows})), "lastParagraph": block_text(rows[-1])})
        s["history"].append({"stage": "section", "sectionId": sid, "versionHash": digest(rows),
                             "revisions": s["sectionRounds"], "issueCount": len(best["review"]["issues"])})
        s["cursor"] += 1
        s["sectionReview"], s["bestSection"], s["sectionRounds"] = None, None, 0
        done = s["cursor"] >= len(s["order"])
        return emit(s, article_request(e, s) if done else section_request(e, s), done=done)
    if operation == "article_request":
        if s["cursor"] != len(s["order"]) or not s["plan"]:
            fail("INCOMPLETE_ARTICLE")
        compile_article(e, s)
        return emit(s, article_request(e, s))
    if operation == "review":
        scope = p.get("scope")
        if scope not in SCOPES or s["cursor"] != len(s["order"]):
            fail("REVIEW_PHASE")
        if not call(s):
            return emit(s, done=True)
        review = check_review(raw, s, scope, e)
        s["reviews"][scope] = review
        s["closureVotes"][scope] = review["resolvedIssueIds"]
        return emit(s, article_request(e, s))
    if operation == "decision":
        final_hash = version(s, "global")
        if any(s["reviews"].get(scope, {}).get("versionHash") != final_hash for scope in SCOPES):
            fail("INCOMPLETE_GLOBAL_REVIEW")
        merged, seen = [], set()
        for scope in SCOPES:
            for issue in s["reviews"][scope]["issues"]:
                key = issue_key(issue)
                if key not in seen:
                    seen.add(key)
                    v = copy.deepcopy(issue)
                    v["id"] = scope + "-r" + str(s["globalRounds"]) + "-" + digest(v["id"])[:24]
                    merged.append(v)
        merged.extend(length_findings(e, s))
        s["globalIssues"] = merged
        closed = {v for values in s["closureVotes"].values() for v in values}
        s["localBlockers"] = [i for i in s["localBlockers"] if i["id"] not in closed]
        # Save only independently reviewed snapshots without substantive defects.
        # If a later cosmetic edit regresses, this exact reviewed version remains
        # eligible; no new unreviewed text is manufactured on rollback.
        if not significant(merged) and not s["localBlockers"] and article_length_valid(e, s):
            if s["bestArticle"] is None or issue_score(merged) <= s["bestArticle"]["score"]:
                s["bestArticle"] = {"score": issue_score(merged),
                    "sections": copy.deepcopy(s["sections"]), "reviews": copy.deepcopy(s["reviews"]),
                    "globalIssues": copy.deepcopy(merged), "versionHash": final_hash}
        immutable = [i for i in merged if i["blockId"] in ("title", "heading")]
        editable = [i for i in merged if i["blockId"] not in ("title", "heading")]
        done = not editable or s["globalRounds"] >= 2 or significant(immutable)
        if done:
            if (significant(editorial_issues(merged)) or s["localBlockers"]) and s["bestArticle"] is not None:
                best = s["bestArticle"]
                if article_length_valid(e, {"sections": best["sections"]}):
                    s["sections"] = copy.deepcopy(best["sections"])
                    s["reviews"] = copy.deepcopy(best["reviews"])
                    s["globalIssues"] = copy.deepcopy(best["globalIssues"])
                    s["localBlockers"] = []
                    s["restoredEarlierVersion"] = True
                    final_hash = best["versionHash"]
            finish_shorter_after_edit(e, s)
            s["reviewedFinalHash"] = final_hash
            if significant(s["globalIssues"]) or s["localBlockers"]:
                reason = "UNRESOLVED_EDITORIAL_ISSUES" if significant(editorial_issues(s["globalIssues"])) or s["localBlockers"] else "ARTICLE_LENGTH_OUT_OF_RANGE"
                s["status"], s["reasons"] = "needs_human", [reason]
        return emit(s, article_request(e, s), done=done)
    if operation == "patch":
        if s["globalRounds"] >= 2:
            fail("GLOBAL_PATCH_LIMIT")
        if not call(s):
            return emit(s, done=True)
        # Only a fully reviewed in-range pre-edit version with real editorial
        # findings can justify retaining an improved short version later.
        if article_length_valid(e, s) and editorial_issues(s["globalIssues"]):
            s["lengthEditBaseline"] = {"versionHash": version(s, "global"),
                "issueScore": issue_score(editorial_issues(s["globalIssues"]))}
        if not apply_patch(raw, e, s, "global"):
            if not editorial_issues(s["globalIssues"]) and finish_shorter_after_edit(e, s):
                return emit(s, done=True)
            s["status"], s["reasons"] = "needs_human", ["EDITOR_NO_PROGRESS"]
            return emit(s, done=True)
        s["globalRounds"] += 1
        s["lengthException"] = False
        s["reviewedFinalHash"] = None
        return emit(s, article_request(e, s))
    if operation == "finalize":
        article = None
        if s["status"] in ("running", "ready"):
            final_hash = version(s, "global")
            complete = bool(s["plan"]) and s["cursor"] == len(s["order"])
            reviews_current = all(s["reviews"].get(scope, {}).get("versionHash") == final_hash for scope in SCOPES)
            if not complete or not reviews_current or s["reviewedFinalHash"] != final_hash:
                s["status"], s["reasons"] = "needs_human", ["FINAL_REVIEW_REQUIRED"]
            elif significant(s["globalIssues"]) or s["localBlockers"]:
                s["status"], s["reasons"] = "needs_human", ["UNRESOLVED_EDITORIAL_ISSUES"]
            elif set(e["brief"]["requiredClaimRevisionIds"]) - coverage(s["sections"]):
                s["status"], s["reasons"] = "needs_human", ["REQUIRED_CLAIMS_MISSING"]
            elif not article_length_valid(e, s) and not (s["lengthException"] and shorter_after_edit(e, s)):
                s["status"], s["reasons"] = "needs_human", ["ARTICLE_LENGTH_OUT_OF_RANGE"]
            else:
                article = compile_article(e, s)
                s["status"] = "ready"
        report = {"schemaVersion": "article-editorial-report-v1", "status": s["status"],
                  "reasons": s["reasons"], "inputHash": s["inputHash"],
                  "finalVersionHash": version(s, "global") if s["plan"] else None,
                  "modelCalls": s["calls"], "globalRevisions": s["globalRounds"],
                  "planRevisions": s["planRounds"],
                  "restoredEarlierVersion": s["restoredEarlierVersion"],
                  "metrics": article_metrics(e, s),
                  "lengthPolicy": "shorter_after_edit" if s["lengthException"] else "standard_range",
                  "warnings": ["ARTICLE_SHORTER_AFTER_EDIT"] if s["lengthException"] else [],
                  "sectionHistory": s["history"], "unresolvedIssues": s["localBlockers"] + s["globalIssues"],
                  "humanApprovalRequired": True, "semanticChecks": "model_review_not_proof"}
        if s["status"] != "ready" and s["planReview"] and significant(s["planReview"]["issues"]):
            report["unresolvedIssues"] += s["planReview"]["issues"]
        if len(dumps(report).encode("utf-8")) > 256 * 1024:
            fail("REPORT_SIZE")
        return emit(s, done=True, article_json=article, editorial_report=report)
    fail("OPERATION")


def main(operation: str, payload_json: str) -> dict:
    try:
        result = dispatch(operation, obj(load(payload_json)))
        return {"result_json": dumps(result)}
    except (KeyError, TypeError, IndexError, RecursionError, OverflowError):
        fail("INPUT_SHAPE")
