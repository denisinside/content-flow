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

MAX_SOURCE_BYTES = 350000
MAX_BYTES = 1024 * 1024
MAX_CODE_OUTPUT_CHARS = 400000
MAX_CALLS = 200
MAX_BATCH_FRAGMENTS = 32
MAX_BATCH_BYTES = 40000
MAX_CLAIMS = 500
MAX_BATCH_CLAIMS = 20
MAX_GLOBAL_PATCH_OPERATIONS = 40
MAX_REVIEW_RETRIES = 2
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


def code_output_size(value):
    """Enforce Dify's per-output string character and UTF-8 byte envelopes."""
    encoded = dumps(value)
    if len(encoded) > MAX_CODE_OUTPUT_CHARS or len(encoded.encode("utf-8")) > MAX_BYTES:
        fail("CODE_OUTPUT_LIMIT")


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
    size(sources, MAX_SOURCE_BYTES)
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
            if len(dumps([row]).encode("utf-8")) > MAX_BATCH_BYTES:
                fail("FRAGMENT_PACKET_SIZE")
            if packet and (len(packet) == MAX_BATCH_FRAGMENTS or
                           len(dumps([fragments[k] for k in packet + [fid]]).encode("utf-8")) > MAX_BATCH_BYTES):
                packets.append(packet)
                packet = []
            packet.append(fid)
    if packet:
        packets.append(packet)
    if len(packets) > 30:
        fail("PACKET_LIMIT")
    return sources, fragments, packets


def model_fragment(fragment):
    """Keep prompts focused while preserving exact text and source-version identity."""
    return {"id": fragment["id"], "snapshotId": fragment["snapshotId"], "text": fragment["text"]}


def model_fragments(fragments, identifiers=None):
    identifiers = list(fragments) if identifiers is None else identifiers
    return [model_fragment(fragments[identifier]) for identifier in identifiers]


def packet_manifest(packets, fragments):
    """Bind each review acknowledgement to the exact ordered IDs and text hashes."""
    return [{
        "batchId": "b" + str(index + 1),
        "batchHash": digest([{"id": fid, "sha256": fragments[fid]["sha256"]} for fid in packet]),
    } for index, packet in enumerate(packets)]


def model_fragments_with_batches(fragments, packets):
    batch_ids = {fid: "b" + str(index + 1) for index, packet in enumerate(packets) for fid in packet}
    return [dict(model_fragment(fragment), batchId=batch_ids[fid]) for fid, fragment in fragments.items()]


def candidates(value, fragments, allowed=None, maximum=MAX_CLAIMS):
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
    coverage_key = "coverage" if batch else "batchCoverage"
    obj(value, ("versionHash", "issues", coverage_key))
    if value["versionHash"] != version(state, batch):
        fail("STALE_REVIEW")
    claims = state["current"] if batch else state["claims"]
    allowed = state["packets"][state["cursor"]] if batch else list(fragments)
    checked = issues(value["issues"], claims, fragments, allowed)
    if batch:
        by_key = {row["key"]: row for row in claims}
        seen = set()
        coverage = []
        for row in array(value[coverage_key], MAX_BATCH_FRAGMENTS):
            obj(row, ("fragmentId", "disposition", "claimKeys"))
            fid = row["fragmentId"]
            keys = array(row["claimKeys"], MAX_CLAIMS)
            if fid not in allowed or fid in seen or len(set(keys)) != len(keys):
                fail("COVERAGE_REFERENCE")
            seen.add(fid)
            expected_keys = {claim["key"] for claim in claims
                             if any(evidence["fragmentId"] == fid for evidence in claim["evidence"])}
            if row["disposition"] == "covered":
                if set(keys) != expected_keys or not keys or any(key not in by_key for key in keys):
                    fail("COVERAGE_CLAIM")
            elif row["disposition"] == "no_factual_claims":
                if keys or expected_keys:
                    fail("COVERAGE_EMPTY")
            else:
                fail("COVERAGE_DISPOSITION")
            coverage.append(copy.deepcopy(row))
        if seen != set(allowed):
            fail("COVERAGE_INCOMPLETE")
        return {"versionHash": value["versionHash"], "issues": checked, "coverage": coverage}

    expected = packet_manifest(state["packets"], fragments)
    by_batch = {row["batchId"]: row["batchHash"] for row in expected}
    seen = set()
    batch_coverage = []
    for row in array(value[coverage_key], 30):
        obj(row, ("batchId", "batchHash"))
        batch_id = text(row["batchId"], 3)
        batch_hash = text(row["batchHash"], 64)
        if batch_id not in by_batch:
            fail("GLOBAL_COVERAGE_REFERENCE")
        if batch_id in seen:
            fail("GLOBAL_COVERAGE_DUPLICATE")
        if batch_hash != by_batch[batch_id]:
            fail("GLOBAL_COVERAGE_HASH")
        seen.add(batch_id)
        batch_coverage.append(copy.deepcopy(row))
    if seen != set(by_batch):
        fail("GLOBAL_COVERAGE_INCOMPLETE")
    return {"versionHash": value["versionHash"], "issues": checked, "batchCoverage": batch_coverage}


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


def checked_patch(value, old, feedback, fragments, allowed=None, maximum=MAX_CLAIMS, allow_unchanged=False):
    changed = candidates(value, fragments, allowed, maximum)
    old_map, new_map = {c["key"]: c for c in old}, {c["key"]: c for c in changed}
    flagged = {i["claimKey"] for i in feedback if i["claimKey"]}
    addition_anchors = {i["fragmentId"] for i in feedback if not i["claimKey"] and i["fragmentId"]}
    compound_keys = {i["claimKey"] for i in feedback
                     if i["claimKey"] and i["category"] == "compound_claim"}
    addition_anchors.update(evidence["fragmentId"] for claim in old if claim["key"] in compound_keys
                            for evidence in claim["evidence"])
    for key, claim in old_map.items():
        if key not in flagged and new_map.get(key) != claim:
            fail("UNREQUESTED_PATCH")
    for key in set(new_map) - set(old_map):
        if not addition_anchors.intersection(evidence["fragmentId"] for evidence in new_map[key]["evidence"]
                                             if evidence["relation"] == "SUPPORTS"):
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


def checked_global_patch(value, state, fragments):
    """Apply bounded edits to reviewed claims without round-tripping the full set through the model."""
    obj(value, ("versionHash", "updates", "additions", "removals", "conflicts"))
    if value["versionHash"] != version(state):
        fail("STALE_PATCH")
    old = state["claims"]
    old_map = {claim["key"]: claim for claim in old}
    feedback = state["globalReview"]["issues"]
    flagged = {issue["claimKey"] for issue in feedback if issue["claimKey"]}

    updates = candidates(value["updates"], fragments, maximum=MAX_GLOBAL_PATCH_OPERATIONS)
    additions = candidates(value["additions"], fragments, maximum=MAX_GLOBAL_PATCH_OPERATIONS)
    removals = [text(key, 64) for key in array(value["removals"], MAX_GLOBAL_PATCH_OPERATIONS)]
    if len(updates) + len(additions) + len(removals) > MAX_GLOBAL_PATCH_OPERATIONS:
        fail("GLOBAL_PATCH_OPERATION_LIMIT")
    update_map = {claim["key"]: claim for claim in updates}
    if len(update_map) != len(updates) or len(set(removals)) != len(removals):
        fail("GLOBAL_PATCH_DUPLICATE")
    if set(update_map).intersection(removals):
        fail("GLOBAL_PATCH_DUPLICATE")
    if set(update_map) - flagged or set(removals) - flagged:
        fail("UNREQUESTED_PATCH")
    if set(update_map) - set(old_map) or set(removals) - set(old_map):
        fail("GLOBAL_PATCH_REFERENCE")

    # Additions must use new stable keys and cite the source or claim evidence
    # that the independent final audit actually flagged.
    if any(not re.fullmatch(r"g-c[1-9][0-9]*", claim["key"]) for claim in additions):
        fail("GLOBAL_ADDITION_KEY")
    addition_keys = {claim["key"] for claim in additions}
    if len(addition_keys) != len(additions) or addition_keys.intersection(old_map):
        fail("GLOBAL_ADDITION_KEY")
    addition_anchors = {issue["fragmentId"] for issue in feedback
                        if not issue["claimKey"] and issue["fragmentId"]}
    compound_keys = {issue["claimKey"] for issue in feedback
                     if issue["claimKey"] and issue["category"] == "compound_claim"}
    addition_anchors.update(evidence["fragmentId"] for claim in old if claim["key"] in compound_keys
                            for evidence in claim["evidence"])
    for claim in additions:
        if not addition_anchors.intersection(evidence["fragmentId"] for evidence in claim["evidence"]
                                             if evidence["relation"] == "SUPPORTS"):
            fail("GLOBAL_ADDITION_ANCHOR")

    removed = set(removals)
    updated = [update_map.get(claim["key"], claim) for claim in old if claim["key"] not in removed]
    updated.extend(additions)
    if len(updated) > MAX_CLAIMS:
        fail("CLAIM_LIMIT")
    if supported_fragments(old) - supported_fragments(updated):
        fail("PATCH_DROPPED_SOURCE")
    updated_conflicts = checked_conflict_patch(value["conflicts"], state["conflicts"], old, updated, feedback)
    return updated, updated_conflicts


def call(state):
    if state["modelCalls"] >= MAX_CALLS:
        fail("CALL_LIMIT")
    state["modelCalls"] += 1


def retryable_review_code(error):
    """Return a safe, bounded correction hint for structural reviewer failures only."""
    prefix = "CLAIMS_WORKFLOW_"
    message = str(error)
    if not message.startswith(prefix):
        return ""
    code = message[len(prefix):]
    if code.startswith("COVERAGE_") or code.startswith("GLOBAL_COVERAGE_") or code == "STALE_REVIEW":
        return code
    return ""


def schedule_review_retry(state, error):
    code = retryable_review_code(error)
    if not code:
        raise error
    state["mode"] = "review_retry"
    state["reviewRetryCode"] = code
    if state["reviewRetryCount"] >= MAX_REVIEW_RETRIES:
        state["status"], state["reason"] = "needs_human", "REVIEW_VALIDATION_LIMIT"
        return
    # Reserve the next reviewer call now. The invalid response itself is discarded.
    call(state)
    state["reviewRetryCount"] += 1


def expected_coverage(packet, claims):
    """Mechanical fragment-to-current-candidate map; this says nothing about entailment."""
    by_fragment = {fid: [] for fid in packet}
    for claim in claims:
        for evidence in claim["evidence"]:
            fid = evidence["fragmentId"]
            if fid in by_fragment:
                by_fragment[fid].append(claim["key"])
    return [{"fragmentId": fid, "claimKeys": by_fragment[fid]} for fid in packet]


def execute(operation, payload):
    sources, fragments, packets = source_context(payload["sources_json"])
    state = load(payload.get("state_json", {}))
    raw = load(payload.get("raw", {}))
    request = {}
    if operation == "prepare":
        # This is the smallest future global-review request. Reject sources that
        # cannot fit even with zero candidates before spending any model calls.
        size({"versionHash": "0" * 64, "claims": [], "conflicts": [], "preMergeClaims": [],
              "feedback": [], "batchManifest": packet_manifest(packets, fragments),
              "fragments": model_fragments_with_batches(fragments, packets)})
        state = {"inputHash": digest(sources), "status": "running", "phase": "batch", "mode": "draft", "modelCalls": 0,
                 "reviewRetryCount": 0, "reviewRetryCode": "",
                 "packets": packets, "cursor": 0, "current": [], "batchReview": None, "batchRevisions": 0,
                 "claims": [], "conflicts": [], "preMergeClaims": [], "batchHistory": [], "minorIssues": [], "globalReview": None,
                 "globalRevisions": 0, "decisionHash": "", "reason": ""}
    elif not isinstance(state, dict) or state.get("inputHash") != digest(sources) or state.get("packets") != packets:
        fail("INPUT_CHANGED")
    elif operation != "finalize" and state.get("status") != "running" and not (
        operation == "decision" and state.get("status") == "needs_human"
        and state.get("reason") == "REVIEW_VALIDATION_LIMIT"
        and state.get("mode") == "review_retry" and state.get("reviewRetryCode")
    ):
        fail("STATE_TERMINAL")
    elif operation.startswith("batch_"):
        if state["phase"] != "batch" or state["cursor"] >= len(packets):
            fail("PHASE")
        packet = packets[state["cursor"]]
        if operation == "batch_request":
            if state["mode"] != "review_retry":
                call(state)
            request = {"batchId": "b" + str(state["cursor"] + 1), "mode": state["mode"], "versionHash": version(state, True),
                       "fragments": model_fragments(fragments, packet), "claims": state["current"],
                       "feedback": state["batchReview"]["issues"] if state["batchReview"] else []}
        elif operation == "batch_review_request":
            if state["batchReview"] is not None:
                fail("REVIEW_ALREADY_PRESENT")
            request = {"batchId": "b" + str(state["cursor"] + 1), "versionHash": version(state, True),
                       "fragments": model_fragments(fragments, packet), "claims": state["current"]}
            if state["reviewRetryCode"]:
                request["validationCode"] = state["reviewRetryCode"]
                if state["reviewRetryCode"].startswith("COVERAGE_"):
                    request["expectedCoverage"] = expected_coverage(packet, state["current"])
        elif operation in ("batch_draft", "batch_patch"):
            if operation == "batch_draft":
                obj(raw, ("claims",))
                if state["current"] or state["mode"] != "draft":
                    fail("DRAFT_STATE")
                updated = candidates(raw["claims"], fragments, packet, MAX_BATCH_CLAIMS)
            else:
                obj(raw, ("versionHash", "claims"))
                if not state["batchReview"] or raw["versionHash"] != version(state, True) or state["batchRevisions"] >= 2:
                    fail("STALE_PATCH")
                updated = checked_patch(raw["claims"], state["current"], state["batchReview"]["issues"],
                                        fragments, packet, MAX_BATCH_CLAIMS, allow_unchanged=True)
                state["batchRevisions"] += 1
            if any(not c["key"].startswith("b" + str(state["cursor"] + 1) + "-c") for c in updated):
                fail("BATCH_KEY")
            if len(state["claims"]) + len(updated) > MAX_CLAIMS:
                fail("CLAIM_LIMIT")
            state["current"], state["batchReview"] = updated, None
            call(state)
            request = {"versionHash": version(state, True), "fragments": model_fragments(fragments, packet), "claims": updated}
        elif operation == "batch_review":
            try:
                state["batchReview"] = review(raw, state, fragments, True)
            except ValueError as error:
                schedule_review_retry(state, error)
            else:
                state["reviewRetryCode"] = ""
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
            state["reviewRetryCode"] = ""
            if state["cursor"] == len(packets):
                state["phase"] = "merge"
    elif operation in ("merge_request", "conflict_request", "global_request"):
        phase = {"merge_request": "merge", "conflict_request": "conflict", "global_request": "global"}[operation]
        if state["phase"] != phase:
            fail("PHASE")
        if operation != "global_request" or state["mode"] != "review_retry":
            call(state)
        request = {"versionHash": version(state), "claims": state["claims"], "conflicts": state["conflicts"],
                   "fragments": model_fragments(fragments)}
        if operation == "global_request":
            request["feedback"] = state["globalReview"]["issues"] if state["globalReview"] else []
            request["preMergeClaims"] = state["preMergeClaims"]
            request["batchManifest"] = packet_manifest(state["packets"], fragments)
            request["fragments"] = model_fragments_with_batches(fragments, state["packets"])
            if state["reviewRetryCode"]:
                request["validationCode"] = state["reviewRetryCode"]
    elif operation == "merge":
        obj(raw, ("versionHash", "groups"))
        if state["phase"] != "merge" or raw["versionHash"] != version(state):
            fail("STALE_MERGE")
        known = {c["key"]: c for c in state["claims"]}
        index = {c["key"]: n for n, c in enumerate(state["claims"])}
        seen, grouped, merged = set(), [], []
        for group in array(raw["groups"], MAX_CLAIMS // 2):
            obj(group, ("claimKeys",))
            keys = array(group["claimKeys"], MAX_CLAIMS, 2)
            if len(set(keys)) != len(keys) or set(keys) - set(known) or seen.intersection(keys):
                fail("MERGE_PARTITION")
            seen.update(keys)
            grouped.append(sorted(keys, key=lambda k: index[k]))
        # The model reports actual duplicate groups only. Every unmentioned
        # candidate is retained as its own group to keep the response bounded.
        grouped.extend([[key] for key in known if key not in seen])
        for keys in grouped:
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
        try:
            state["globalReview"] = review(raw, state, fragments)
        except ValueError as error:
            schedule_review_retry(state, error)
        else:
            state["reviewRetryCode"] = ""
            state["mode"] = "draft"
    elif operation == "decision":
        current = state["globalReview"]
        if state["phase"] != "global":
            fail("MISSING_GLOBAL_REVIEW")
        if state["reviewRetryCode"]:
            if state["mode"] != "review_retry":
                fail("REVIEW_RETRY_STATE")
        elif not current or current["versionHash"] != version(state):
            fail("MISSING_GLOBAL_REVIEW")
        else:
            significant = any(i["severity"] in SIGNIFICANT for i in current["issues"])
            if not significant:
                state["status"], state["decisionHash"] = "ready", version(state)
            elif state["globalRevisions"] >= 2:
                state["status"], state["reason"] = "needs_human", "GLOBAL_REPAIR_LIMIT"
            else:
                state["mode"] = "patch"
                call(state)
                request = {"versionHash": version(state), "claims": state["claims"], "conflicts": state["conflicts"],
                           "fragments": model_fragments_with_batches(fragments, state["packets"]),
                           "batchManifest": packet_manifest(state["packets"], fragments),
                           "feedback": current["issues"], "preMergeClaims": state["preMergeClaims"]}
    elif operation == "global_patch":
        obj(raw, ("versionHash", "updates", "additions", "removals", "conflicts"))
        if state["phase"] != "global" or not state["globalReview"] or state["globalRevisions"] >= 2 or raw["versionHash"] != version(state):
            fail("STALE_PATCH")
        updated, updated_conflicts = checked_global_patch(raw, state, fragments)
        state["claims"], state["conflicts"] = updated, updated_conflicts
        state["globalRevisions"] += 1
        state["globalReview"], state["decisionHash"] = None, ""
        state["reviewRetryCode"] = ""
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
    code_output_size(state)
    code_output_size(request)
    if result_claims is not None:
        code_output_size(result_claims)
    if report is not None:
        code_output_size(report)
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
