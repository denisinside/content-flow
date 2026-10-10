"""Provider-free, fail-closed runtime embedded in claims Dify Code nodes.

Models select evidence IDs; this code reconstructs immutable source metadata.
Snapshot content hashes are independently verified by the backend: the input
contains selected fragments, so this runtime cannot reconstruct full snapshots.
"""
import copy
import hashlib
import json
import re
import uuid

MAX_BYTES = 350000
MAX_CALLS = 200
SIGNIFICANT = {"major", "critical"}


def fail(code):
    raise ValueError("CLAIMS_WORKFLOW_" + code)


def dumps(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False)


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


def array(value, maximum=100, minimum=0):
    if not isinstance(value, list) or not minimum <= len(value) <= maximum:
        fail("ARRAY_SHAPE")
    return value


def text(value, maximum=2000, empty=False):
    if not isinstance(value, str) or len(value.encode("utf-16-le")) // 2 > maximum or (not empty and not value.strip()):
        fail("TEXT_SHAPE")
    if re.search(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]", value):
        fail("TEXT_CONTROL")
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


def source_context(value):
    sources = array(load(value), 100, 1)
    size(sources)
    fragments, snapshots = {}, set()
    packets, packet = [], []
    for source in sources:
        obj(source, ("snapshotId", "materialId", "sha256", "fragments"))
        sid = identifier(source["snapshotId"])
        identifier(source["materialId"])
        if sid.lower() in snapshots or not isinstance(source["sha256"], str) or not re.fullmatch(r"[a-f0-9]{64}", source["sha256"]):
            fail("SNAPSHOT_SHAPE")
        snapshots.add(sid.lower())
        for f in array(source["fragments"], 1000, 1):
            obj(f, ("id", "startOffset", "endOffset", "sha256", "text"))
            fid = identifier(f["id"])
            if fid.lower() in {key.lower() for key in fragments}:
                fail("DUPLICATE_FRAGMENT")
            text(f["text"], 10000)
            start, end = f["startOffset"], f["endOffset"]
            if type(start) is not int or type(end) is not int or start < 0 or end <= start or end - start != len(f["text"].encode("utf-16-le")) // 2:
                fail("FRAGMENT_OFFSETS")
            if f["sha256"] != hashlib.sha256(f["text"].encode("utf-8")).hexdigest():
                fail("FRAGMENT_HASH")
            row = dict(f, snapshotId=sid, materialId=source["materialId"])
            fragments[fid] = row
            if len(dumps([row]).encode("utf-8")) > 40000:
                fail("FRAGMENT_PACKET_SIZE")
            if packet and (len(packet) == 8 or len(dumps([fragments[k] for k in packet + [fid]]).encode("utf-8")) > 40000):
                packets.append(packet)
                packet = []
            packet.append(fid)
    if packet:
        packets.append(packet)
    if len(packets) > 30:
        fail("PACKET_LIMIT")
    return sources, fragments, packets


def candidates(value, fragments, allowed=None, maximum=100):
    rows, seen = [], set()
    for row in array(value, maximum):
        obj(row, ("key", "wording", "evidence"))
        key = text(row["key"], 64)
        if not re.fullmatch(r"(?:b[1-9][0-9]*-c[1-9][0-9]*|g-c[1-9][0-9]*)", key) or key in seen:
            fail("CLAIM_KEY")
        seen.add(key)
        wording = text(row["wording"], 2000).strip()
        evidence, refs = [], set()
        for evidence_row in array(row["evidence"], 10, 1):
            obj(evidence_row, ("fragmentId", "relation"))
            fid, relation = evidence_row["fragmentId"], evidence_row["relation"]
            if fid not in fragments or (allowed is not None and fid not in allowed) or relation not in ("SUPPORTS", "CONTRADICTS") or fid in refs:
                fail("CLAIM_EVIDENCE")
            refs.add(fid)
            evidence.append({"fragmentId": fid, "relation": relation})
        if not any(row["relation"] == "SUPPORTS" for row in evidence):
            fail("CLAIM_NO_SUPPORT")
        rows.append({"key": key, "wording": wording, "evidence": evidence})
    return rows


def version(state, batch=False):
    return digest(state["current"] if batch else {"claims": state["claims"], "conflicts": state["conflicts"]})


def issues(value, claims, fragments, allowed):
    rows, seen = [], set()
    mapping = {row["key"]: row for row in claims}
    for row in array(value, 40):
        obj(row, ("id", "severity", "category", "claimKey", "fragmentId", "quote", "instruction", "acceptance"))
        issue_id = text(row["id"], 80)
        if issue_id in seen or row["severity"] not in ("critical", "major", "minor"):
            fail("ISSUE_SHAPE")
        seen.add(issue_id)
        text(row["category"], 100)
        text(row["instruction"], 2000)
        text(row["acceptance"], 2000)
        key = text(row["claimKey"], 64, empty=True)
        fid = text(row["fragmentId"], 36, empty=True)
        quote = text(row["quote"], 10000)
        if key and key not in mapping:
            fail("ISSUE_CLAIM")
        if fid and (fid not in fragments or fid not in allowed):
            fail("ISSUE_FRAGMENT")
        anchors = ([mapping[key]["wording"]] if key else []) + ([fragments[fid]["text"]] if fid else [])
        if not anchors or not any(quote in anchor for anchor in anchors):
            fail("ISSUE_ANCHOR")
        rows.append(copy.deepcopy(row))
    return rows


def review(value, state, fragments, batch=False):
    obj(value, ("versionHash", "issues", "coverage"))
    if value["versionHash"] != version(state, batch):
        fail("STALE_REVIEW")
    claims = state["current"] if batch else state["claims"]
    allowed = state["packets"][state["cursor"]] if batch else list(fragments)
    checked = issues(value["issues"], claims, fragments, allowed)
    by_key = {row["key"]: row for row in claims}
    seen = set()
    coverage = []
    for row in array(value["coverage"], 240):
        obj(row, ("fragmentId", "disposition", "claimKeys"))
        fid = row["fragmentId"]
        keys = array(row["claimKeys"], 100)
        if fid not in allowed or fid in seen or len(set(keys)) != len(keys):
            fail("COVERAGE_REFERENCE")
        seen.add(fid)
        if row["disposition"] == "covered":
            if not keys or any(key not in by_key or not any(e["fragmentId"] == fid for e in by_key[key]["evidence"]) for key in keys):
                fail("COVERAGE_CLAIM")
        elif row["disposition"] == "no_factual_claims":
            if keys or any(any(e["fragmentId"] == fid for e in c["evidence"]) for c in claims):
                fail("COVERAGE_EMPTY")
        else:
            fail("COVERAGE_DISPOSITION")
        coverage.append(copy.deepcopy(row))
    if seen != set(allowed):
        fail("COVERAGE_INCOMPLETE")
    return {"versionHash": value["versionHash"], "issues": checked, "coverage": coverage}


def conflicts(value, claims):
    known = {row["key"] for row in claims}
    rows, seen = [], set()
    for row in array(value, 100):
        obj(row, ("claimKeys", "rationale"))
        keys = array(row["claimKeys"], 10, 2)
        if len(set(keys)) != len(keys) or set(keys) - known:
            fail("CONFLICT_REFERENCE")
        pair = tuple(sorted(keys))
        if pair in seen:
            fail("CONFLICT_DUPLICATE")
        seen.add(pair)
        rows.append({"claimKeys": keys, "rationale": text(row["rationale"], 2000).strip()})
    return rows


def supported_fragments(claims):
    return {e["fragmentId"] for claim in claims for e in claim["evidence"] if e["relation"] == "SUPPORTS"}


def checked_patch(value, old, feedback, fragments, allowed=None, maximum=100, allow_unchanged=False):
    changed = candidates(value, fragments, allowed, maximum)
    old_map, new_map = {c["key"]: c for c in old}, {c["key"]: c for c in changed}
    flagged = {i["claimKey"] for i in feedback if i["claimKey"]}
    omission = any(not i["claimKey"] for i in feedback)
    for key, claim in old_map.items():
        if key not in flagged and new_map.get(key) != claim:
            fail("UNREQUESTED_PATCH")
    if set(new_map) - set(old_map) and not (flagged or omission):
        fail("UNREQUESTED_ADDITION")
    if changed == old and not allow_unchanged:
        fail("PATCH_NO_CHANGE")
    return changed


def checked_conflict_patch(value, old_conflicts, old_claims, new_claims, feedback):
    """Limit changes to conflicts connected to the current anchored feedback."""
    updated = conflicts(value, new_claims)
    affected = {issue["claimKey"] for issue in feedback if issue["claimKey"]}
    flagged_fragments = {issue["fragmentId"] for issue in feedback if issue["fragmentId"]}
    affected.update(claim["key"] for claim in old_claims
                    if any(e["fragmentId"] in flagged_fragments for e in claim["evidence"]))
    affected.update({claim["key"] for claim in new_claims} - {claim["key"] for claim in old_claims})
    before = {tuple(sorted(conflict["claimKeys"])): conflict["rationale"] for conflict in old_conflicts}
    after = {tuple(sorted(conflict["claimKeys"])): conflict["rationale"] for conflict in updated}
    for participants, rationale in before.items():
        if not affected.intersection(participants) and after.get(participants) != rationale:
            fail("UNREQUESTED_CONFLICT_PATCH")
    for participants in after:
        if participants not in before and not affected.intersection(participants):
            fail("UNREQUESTED_CONFLICT_ADDITION")
    return updated


def call(state):
    if state["modelCalls"] >= MAX_CALLS:
        fail("CALL_LIMIT")
    state["modelCalls"] += 1


def execute(operation, payload):
    sources, fragments, packets = source_context(payload["sources_json"])
    state = load(payload.get("state_json", {}))
    raw = load(payload.get("raw", {}))
    request = {}
    if operation == "prepare":
        # This is the smallest future global-review request. Reject sources that
        # cannot fit even with zero candidates before spending any model calls.
        size({"versionHash": "0" * 64, "claims": [], "conflicts": [], "preMergeClaims": [],
              "feedback": [], "fragments": list(fragments.values())})
        state = {"inputHash": digest(sources), "status": "running", "phase": "batch", "mode": "draft", "modelCalls": 0,
                 "packets": packets, "cursor": 0, "current": [], "batchReview": None, "batchRevisions": 0,
                 "claims": [], "conflicts": [], "preMergeClaims": [], "batchHistory": [], "minorIssues": [], "globalReview": None,
                 "globalRevisions": 0, "decisionHash": "", "reason": ""}
    elif not isinstance(state, dict) or state.get("inputHash") != digest(sources) or state.get("packets") != packets:
        fail("INPUT_CHANGED")
    elif operation != "finalize" and state.get("status") != "running":
        fail("STATE_TERMINAL")
    elif operation.startswith("batch_"):
        if state["phase"] != "batch" or state["cursor"] >= len(packets):
            fail("PHASE")
        packet = packets[state["cursor"]]
        if operation == "batch_request":
            call(state)
            request = {"batchId": "b" + str(state["cursor"] + 1), "mode": state["mode"], "versionHash": version(state, True),
                       "fragments": [fragments[k] for k in packet], "claims": state["current"],
                       "feedback": state["batchReview"]["issues"] if state["batchReview"] else []}
        elif operation == "batch_review_request":
            if state["batchReview"] is not None:
                fail("REVIEW_ALREADY_PRESENT")
            request = {"batchId": "b" + str(state["cursor"] + 1), "versionHash": version(state, True),
                       "fragments": [fragments[k] for k in packet], "claims": state["current"]}
        elif operation in ("batch_draft", "batch_patch"):
            if operation == "batch_draft":
                obj(raw, ("claims",))
                if state["current"] or state["mode"] != "draft":
                    fail("DRAFT_STATE")
                updated = candidates(raw["claims"], fragments, packet, 30)
            else:
                obj(raw, ("versionHash", "claims"))
                if not state["batchReview"] or raw["versionHash"] != version(state, True) or state["batchRevisions"] >= 2:
                    fail("STALE_PATCH")
                updated = checked_patch(raw["claims"], state["current"], state["batchReview"]["issues"], fragments, packet, 30)
                state["batchRevisions"] += 1
            if any(not c["key"].startswith("b" + str(state["cursor"] + 1) + "-c") for c in updated):
                fail("BATCH_KEY")
            if len(state["claims"]) + len(updated) > 100:
                fail("CLAIM_LIMIT")
            state["current"], state["batchReview"] = updated, None
            call(state)
            request = {"versionHash": version(state, True), "fragments": [fragments[k] for k in packet], "claims": updated}
        elif operation == "batch_review":
            state["batchReview"] = review(raw, state, fragments, True)
            state["mode"] = "patch" if any(i["severity"] in SIGNIFICANT for i in state["batchReview"]["issues"]) else "draft"
        else:
            fail("OPERATION")
    elif operation == "advance":
        if state["phase"] != "batch" or not state["batchReview"] or state["batchReview"]["versionHash"] != version(state, True):
            fail("MISSING_BATCH_REVIEW")
        significant = [i for i in state["batchReview"]["issues"] if i["severity"] in SIGNIFICANT]
        if significant:
            if state["batchRevisions"] >= 2:
                state["status"], state["reason"] = "needs_human", "BATCH_REPAIR_LIMIT"
            else:
                state["mode"] = "patch"
        else:
            state["batchHistory"].append({"batchId": "b" + str(state["cursor"] + 1), "revisions": state["batchRevisions"],
                                          "claimCount": len(state["current"]), "versionHash": version(state, True)})
            state["minorIssues"].extend(state["batchReview"]["issues"])
            state["claims"].extend(state["current"])
            state["cursor"] += 1
            state["current"], state["batchReview"], state["batchRevisions"], state["mode"] = [], None, 0, "draft"
            if state["cursor"] == len(packets):
                state["phase"] = "merge"
    elif operation in ("merge_request", "conflict_request", "global_request"):
        phase = {"merge_request": "merge", "conflict_request": "conflict", "global_request": "global"}[operation]
        if state["phase"] != phase:
            fail("PHASE")
        call(state)
        request = {"versionHash": version(state), "claims": state["claims"], "conflicts": state["conflicts"],
                   "fragments": list(fragments.values())}
        if operation == "global_request":
            request["feedback"] = state["globalReview"]["issues"] if state["globalReview"] else []
            request["preMergeClaims"] = state["preMergeClaims"]
    elif operation == "merge":
        obj(raw, ("versionHash", "groups"))
        if state["phase"] != "merge" or raw["versionHash"] != version(state):
            fail("STALE_MERGE")
        known = {c["key"]: c for c in state["claims"]}
        index = {c["key"]: n for n, c in enumerate(state["claims"])}
        seen, merged = set(), []
        for group in array(raw["groups"], 100):
            obj(group, ("claimKeys",))
            keys = array(group["claimKeys"], 100, 1)
            if len(set(keys)) != len(keys) or set(keys) - set(known) or seen.intersection(keys):
                fail("MERGE_PARTITION")
            seen.update(keys)
            keys = sorted(keys, key=lambda k: index[k])
            claim = copy.deepcopy(known[keys[0]])
            union = {}
            for key in keys:
                for evidence in known[key]["evidence"]:
                    fid = evidence["fragmentId"]
                    if fid in union and union[fid]["relation"] != evidence["relation"]:
                        fail("MERGE_EVIDENCE_CONFLICT")
                    union[fid] = evidence
            claim["evidence"] = list(union.values())
            array(claim["evidence"], 10, 1)
            merged.append(claim)
        if seen != set(known):
            fail("MERGE_DROPPED_CLAIM")
        state["preMergeClaims"] = copy.deepcopy(state["claims"])
        state["claims"] = sorted(merged, key=lambda c: index[c["key"]])
        state["phase"] = "conflict"
    elif operation == "conflict":
        obj(raw, ("versionHash", "conflicts"))
        if state["phase"] != "conflict" or raw["versionHash"] != version(state):
            fail("STALE_CONFLICT")
        state["conflicts"] = conflicts(raw["conflicts"], state["claims"])
        state["phase"] = "global"
    elif operation == "global_review":
        if state["phase"] != "global":
            fail("PHASE")
        state["globalReview"] = review(raw, state, fragments)
    elif operation == "decision":
        current = state["globalReview"]
        if state["phase"] != "global" or not current or current["versionHash"] != version(state):
            fail("MISSING_GLOBAL_REVIEW")
        significant = any(i["severity"] in SIGNIFICANT for i in current["issues"])
        if not significant:
            state["status"], state["decisionHash"] = "ready", version(state)
        elif state["globalRevisions"] >= 2:
            state["status"], state["reason"] = "needs_human", "GLOBAL_REPAIR_LIMIT"
        else:
            state["mode"] = "patch"
            call(state)
            request = {"versionHash": version(state), "claims": state["claims"], "conflicts": state["conflicts"],
                       "fragments": list(fragments.values()), "feedback": current["issues"], "preMergeClaims": state["preMergeClaims"]}
    elif operation == "global_patch":
        obj(raw, ("versionHash", "claims", "conflicts"))
        if state["phase"] != "global" or not state["globalReview"] or state["globalRevisions"] >= 2 or raw["versionHash"] != version(state):
            fail("STALE_PATCH")
        updated = checked_patch(raw["claims"], state["claims"], state["globalReview"]["issues"], fragments, allow_unchanged=True)
        if supported_fragments(state["claims"]) - supported_fragments(updated):
            fail("PATCH_DROPPED_SOURCE")
        old_keys = {c["key"] for c in state["claims"]}
        if any(c["key"] not in old_keys and not re.fullmatch(r"g-c[1-9][0-9]*", c["key"]) for c in updated):
            fail("GLOBAL_ADDITION_KEY")
        updated_conflicts = checked_conflict_patch(raw["conflicts"], state["conflicts"], state["claims"],
                                                   updated, state["globalReview"]["issues"])
        if updated == state["claims"] and updated_conflicts == state["conflicts"]:
            fail("PATCH_NO_CHANGE")
        state["claims"], state["conflicts"] = updated, updated_conflicts
        state["globalRevisions"] += 1
        state["globalReview"], state["decisionHash"] = None, ""
    elif operation != "finalize":
        fail("OPERATION")
    size(state)
    size(request)
    result_claims, report = None, None
    if operation == "finalize":
        if state["status"] == "ready":
            current = state["globalReview"]
            if state["phase"] != "global" or state["cursor"] != len(packets) or not current or state["decisionHash"] != version(state) or current["versionHash"] != version(state) or any(i["severity"] in SIGNIFICANT for i in current["issues"]):
                fail("FINAL_NOT_REVIEWED")
            checked = candidates(state["claims"], fragments)
            result_claims = {"schemaVersion": "claims-v1", "claims": [], "conflicts": conflicts(state["conflicts"], checked)}
            for claim in checked:
                expanded = []
                for e in claim["evidence"]:
                    f = fragments[e["fragmentId"]]
                    expanded.append({"snapshotId": f["snapshotId"], "fragmentId": f["id"], "startOffset": f["startOffset"],
                                     "endOffset": f["endOffset"], "quote": f["text"], "sha256": f["sha256"], "relation": e["relation"]})
                result_claims["claims"].append({"key": claim["key"], "wording": claim["wording"], "evidence": expanded})
            size(result_claims)
        elif state["status"] == "running":
            state["status"], state["reason"] = "needs_human", "INCOMPLETE_WORKFLOW"
        latest = state["globalReview"] or state["batchReview"]
        report = {"schemaVersion": "claims-extraction-report-v1", "status": state["status"], "reason": state["reason"],
                  "inputHash": state["inputHash"], "finalVersionHash": version(state), "modelCalls": state["modelCalls"],
                  "batchHistory": state["batchHistory"], "globalRevisions": state["globalRevisions"],
                  "unresolvedIssues": (latest["issues"] if latest else [])[:40], "minorIssueCount": len(state["minorIssues"]),
                  "humanApprovalRequired": True, "semanticChecks": "model_review_not_proof"}
        size(report, 256000)
    done = int(state["status"] != "running" or (state["phase"] != "batch" and operation in ("advance", "finalize")))
    return {"state": state, "request": request, "done": done, "status": state["status"], "mode": state["mode"],
            "claims_json": result_claims, "extraction_report": report}


def main(operation, payload_json):
    try:
        result = execute(operation, load(payload_json))
        return {"result_json": dumps(result)}
    except ValueError as error:
        if str(error).startswith("CLAIMS_WORKFLOW_"):
            raise
        fail("INVALID_VALUE")
    except (KeyError, TypeError, UnicodeError, OverflowError, RecursionError):
        fail("INVALID_PAYLOAD")
