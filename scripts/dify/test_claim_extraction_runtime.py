"""Synthetic invariant tests; no model calls or source material."""
import copy
import hashlib
import itertools
import json
import unittest
import uuid

import claim_extraction_runtime as runtime


def uid(n):
    return str(uuid.UUID(int=n))


def sources(count=2, source_text="Вибірка містила 12 учасників."):
    rows = []
    offset = 0
    for n in range(count):
        length = len(source_text.encode("utf-16-le")) // 2
        rows.append({"id": uid(n + 10), "startOffset": offset, "endOffset": offset + length,
                     "sha256": hashlib.sha256(source_text.encode()).hexdigest(), "text": source_text})
        offset += length
    return [{"snapshotId": uid(1), "materialId": uid(2), "sha256": "a" * 64, "fragments": rows}]


def claim(n, fid=uid(10), wording="Дослідження охопило 12 учасників.", batch=1):
    return {"key": "b%d-c%d" % (batch, n), "wording": wording,
            "evidence": [{"fragmentId": fid, "relation": "SUPPORTS"}]}


class Session:
    def __init__(self, input_sources=None):
        self.sources = input_sources or sources()
        self.state = None
        self.request = None
        self.run("prepare")

    def run(self, operation, raw=None):
        payload = {"sources_json": runtime.dumps(self.sources)}
        if self.state is not None:
            payload["state_json"] = runtime.dumps(self.state)
        if raw is not None:
            payload["raw"] = runtime.dumps(raw)
        result = json.loads(runtime.main(operation, runtime.dumps(payload))["result_json"])
        self.state, self.request = result["state"], result["request"]
        return result

    def review(self, batch=False, issues=None):
        current = self.state["current"] if batch else self.state["claims"]
        ids = self.state["packets"][self.state["cursor"]] if batch else [f["id"] for s in self.sources for f in s["fragments"]]
        coverage = []
        for fid in ids:
            keys = [c["key"] for c in current if any(e["fragmentId"] == fid for e in c["evidence"])]
            coverage.append({"fragmentId": fid, "disposition": "covered" if keys else "no_factual_claims", "claimKeys": keys})
        return {"versionHash": runtime.version(self.state, batch), "issues": issues or [], "coverage": coverage}

    def accept_batch(self, candidates=None):
        self.run("batch_request")
        self.run("batch_draft", {"claims": candidates if candidates is not None else [claim(1), claim(2, uid(11))]})
        self.run("batch_review", self.review(True))
        self.run("advance")

    def global_phase(self, candidates=None, groups=None):
        self.accept_batch(candidates)
        self.run("merge_request")
        self.run("merge", {"versionHash": runtime.version(self.state), "groups": groups or [{"claimKeys": [c["key"]]} for c in self.state["claims"]]})
        self.run("conflict_request")
        self.run("conflict", {"versionHash": runtime.version(self.state), "conflicts": []})

    def issue(self, batch=False, key="b1-c1", severity="major", category="entailment", fid=""):
        current = self.state["current"] if batch else self.state["claims"]
        wording = next(c["wording"] for c in current if c["key"] == key) if key else self.sources[0]["fragments"][0]["text"]
        return {"id": "i1", "severity": severity, "category": category, "claimKey": key, "fragmentId": fid,
                "quote": wording, "instruction": "Збережи точні умови джерела.", "acceptance": "Формулювання підтримане джерелом."}


class RuntimeTests(unittest.TestCase):
    def test_success_reconstructs_exact_immutable_evidence(self):
        s = Session()
        s.global_phase()
        s.run("global_request")
        s.run("global_review", s.review())
        s.run("decision")
        result = s.run("finalize")
        evidence = result["claims_json"]["claims"][0]["evidence"][0]
        frozen = s.sources[0]["fragments"][0]
        self.assertEqual(evidence, {"snapshotId": uid(1), "fragmentId": uid(10), "startOffset": frozen["startOffset"],
                                    "endOffset": frozen["endOffset"], "quote": frozen["text"], "sha256": frozen["sha256"], "relation": "SUPPORTS"})
        self.assertEqual(result["extraction_report"]["status"], "ready")
        self.assertEqual(result["extraction_report"]["schemaVersion"], "claims-extraction-report-v1")
        self.assertTrue(result["extraction_report"]["humanApprovalRequired"])
        self.assertEqual(result["extraction_report"]["modelCalls"], 5)

    def test_reviewer_request_rebuild_does_not_count_second_call(self):
        s = Session()
        s.run("batch_request")
        s.run("batch_draft", {"claims": [claim(1)]})
        calls = s.state["modelCalls"]
        s.run("batch_review_request")
        self.assertEqual(s.state["modelCalls"], calls)
        self.assertEqual(s.request["claims"], [claim(1)])
        self.assertEqual(s.request["batchId"], "b1")

    def test_utf16_offsets_accept_non_bmp(self):
        Session(sources(source_text="Учасник 🧑 отримав 12 балів."))

    def test_invalid_offsets_hash_duplicate_ids_rejected(self):
        for fault in ("offset", "hash", "duplicate", "snapshot", "uuid"):
            data = sources()
            if fault == "offset":
                data[0]["fragments"][0]["endOffset"] += 1
            elif fault == "hash":
                data[0]["fragments"][0]["sha256"] = "0" * 64
            elif fault == "duplicate":
                data[0]["fragments"][1]["id"] = data[0]["fragments"][0]["id"]
            elif fault == "snapshot":
                data.append(copy.deepcopy(data[0]))
            else:
                data[0]["snapshotId"] = "invalid"
            with self.subTest(fault=fault), self.assertRaisesRegex(ValueError, "CLAIMS_WORKFLOW_"):
                Session(data)

    def test_source_mutation_detected_even_valid_fragment_hash(self):
        s = Session()
        f = s.sources[0]["fragments"][0]
        f["text"] = "Змінений текст."
        f["sha256"] = hashlib.sha256(f["text"].encode()).hexdigest()
        f["endOffset"] = len(f["text"])
        with self.assertRaisesRegex(ValueError, "INPUT_CHANGED"):
            s.run("batch_request")

    def test_packet_limit_and_packet_bytes(self):
        data = sources(16, "Факт. " * 1100)
        s = Session(data)
        self.assertGreater(len(s.state["packets"]), 2)
        _, fs, ps = runtime.source_context(data)
        for packet in ps:
            self.assertLessEqual(len(packet), 8)
            self.assertLessEqual(len(runtime.dumps([fs[k] for k in packet]).encode()), 40000)
        with self.assertRaisesRegex(ValueError, "PACKET_LIMIT"):
            Session(sources(241, "x"))

    def test_no_empty_claims_without_complete_coverage(self):
        s = Session()
        s.run("batch_request")
        s.run("batch_draft", {"claims": []})
        reviewed = s.review(True)
        reviewed["coverage"].pop()
        with self.assertRaisesRegex(ValueError, "COVERAGE_INCOMPLETE"):
            s.run("batch_review", reviewed)

    def test_empty_source_factual_candidates_is_valid_after_audits(self):
        s = Session(sources(1, "Доброго дня!"))
        s.global_phase([])
        s.run("global_request")
        s.run("global_review", s.review())
        s.run("decision")
        self.assertEqual(s.run("finalize")["claims_json"]["claims"], [])

    def test_review_rejects_stale_anchor_duplicate_issue_coverage(self):
        for fault in ("hash", "quote", "duplicate", "covered", "unlinked", "no_facts"):
            s = Session()
            s.run("batch_request")
            s.run("batch_draft", {"claims": [claim(1)]})
            review = s.review(True, [s.issue(True)])
            if fault == "hash":
                review["versionHash"] = "0" * 64
            elif fault == "quote":
                review["issues"][0]["quote"] = "вигадана цитата"
            elif fault == "duplicate":
                review["issues"].append(copy.deepcopy(review["issues"][0]))
            elif fault == "covered":
                review["coverage"][1]["disposition"] = "covered"
            elif fault == "unlinked":
                review["coverage"][1] = {"fragmentId": uid(11), "disposition": "covered", "claimKeys": ["b1-c1"]}
            else:
                review["coverage"][0] = {"fragmentId": uid(10), "disposition": "no_factual_claims", "claimKeys": []}
            with self.subTest(fault=fault), self.assertRaisesRegex(ValueError, "CLAIMS_WORKFLOW_"):
                s.run("batch_review", review)

    def test_foreign_or_contradict_only_evidence_rejected(self):
        for evidence in ([{"fragmentId": uid(99), "relation": "SUPPORTS"}], [{"fragmentId": uid(10), "relation": "CONTRADICTS"}]):
            s = Session()
            c = claim(1)
            c["evidence"] = evidence
            with self.assertRaisesRegex(ValueError, "CLAIM_"):
                s.run("batch_draft", {"claims": [c]})

    def test_batch_repairs_require_anchors_and_stop_without_partial_result(self):
        s = Session()
        s.run("batch_request")
        s.run("batch_draft", {"claims": [claim(1)]})
        for iteration in range(3):
            s.run("batch_review", s.review(True, [s.issue(True)]))
            s.run("advance")
            if iteration < 2:
                s.run("batch_request")
                changed = claim(1, wording="Учасників було %d." % (13 + iteration))
                s.run("batch_patch", {"versionHash": runtime.version(s.state, True), "claims": [changed]})
        final = s.run("finalize")
        self.assertIsNone(final["claims_json"])
        self.assertEqual(final["extraction_report"]["reason"], "BATCH_REPAIR_LIMIT")
        self.assertEqual(len(final["extraction_report"]["unresolvedIssues"]), 1)

    def test_unflagged_claim_cannot_change_in_batch_patch(self):
        s = Session()
        s.run("batch_request")
        s.run("batch_draft", {"claims": [claim(1), claim(2, uid(11))]})
        s.run("batch_review", s.review(True, [s.issue(True)]))
        with self.assertRaisesRegex(ValueError, "UNREQUESTED_PATCH"):
            s.run("batch_patch", {"versionHash": runtime.version(s.state, True), "claims": [claim(1, wording="12 людей."), claim(2, uid(11), "Інша думка.")]})

    def test_omission_addition_allowed_only_with_source_anchor(self):
        s = Session()
        s.run("batch_request")
        s.run("batch_draft", {"claims": [claim(1)]})
        i = s.issue(True, key="", fid=uid(10), category="omission")
        s.run("batch_review", s.review(True, [i]))
        s.run("batch_patch", {"versionHash": runtime.version(s.state, True), "claims": [claim(1), claim(2, uid(11))]})
        s.run("batch_review", s.review(True))
        self.assertEqual(s.run("advance")["done"], 1)

    def test_merge_preserves_first_wording_and_all_source_evidence(self):
        s = Session()
        s.global_phase(groups=[{"claimKeys": ["b1-c2", "b1-c1"]}])
        self.assertEqual(s.state["claims"][0]["key"], "b1-c1")
        self.assertEqual(len(s.state["claims"][0]["evidence"]), 2)
        self.assertEqual(len(s.state["preMergeClaims"]), 2)

    def test_merge_missing_duplicate_and_unknown_partition_rejected(self):
        for groups in ([{"claimKeys": ["b1-c1"]}], [{"claimKeys": ["b1-c1", "b1-c2"]}, {"claimKeys": ["b1-c1"]}], [{"claimKeys": ["b1-c1", "b1-c99"]}]):
            s = Session()
            s.accept_batch()
            with self.assertRaisesRegex(ValueError, "MERGE_"):
                s.run("merge", {"versionHash": runtime.version(s.state), "groups": groups})

    def test_merge_opposite_evidence_relations_rejected(self):
        s = Session()
        c = claim(2, uid(11))
        c["evidence"].append({"fragmentId": uid(10), "relation": "CONTRADICTS"})
        s.accept_batch([claim(1), c])
        with self.assertRaisesRegex(ValueError, "MERGE_EVIDENCE_CONFLICT"):
            s.run("merge", {"versionHash": runtime.version(s.state), "groups": [{"claimKeys": ["b1-c1", "b1-c2"]}]})

    def test_conflicts_not_auto_resolved_or_blocked(self):
        s = Session()
        s.accept_batch()
        s.run("merge", {"versionHash": runtime.version(s.state), "groups": [{"claimKeys": ["b1-c1"]}, {"claimKeys": ["b1-c2"]}]})
        s.run("conflict", {"versionHash": runtime.version(s.state), "conflicts": [{"claimKeys": ["b1-c1", "b1-c2"], "rationale": "Різні висновки джерел."}]})
        s.run("global_request")
        s.run("global_review", s.review())
        s.run("decision")
        self.assertEqual(len(s.run("finalize")["claims_json"]["conflicts"]), 1)

    def test_final_requires_review_of_complete_merged_snapshot(self):
        s = Session()
        s.global_phase()
        result = s.run("finalize")
        self.assertIsNone(result["claims_json"])
        self.assertEqual(result["status"], "needs_human")

    def test_global_patch_preserves_source_and_reaudits_version(self):
        s = Session()
        s.global_phase()
        s.run("global_request")
        s.run("global_review", s.review(issues=[s.issue()]))
        s.run("decision")
        original_review = s.review()
        s.run("global_patch", {"versionHash": runtime.version(s.state), "claims": [claim(1, wording="У вибірці було 12 учасників."), claim(2, uid(11))], "conflicts": []})
        self.assertIsNone(s.state["globalReview"])
        with self.assertRaisesRegex(ValueError, "STALE_REVIEW"):
            s.run("global_review", original_review)

    def test_global_patch_cannot_silently_drop_supported_fragment(self):
        s = Session()
        s.global_phase()
        s.run("global_review", s.review(issues=[s.issue()]))
        with self.assertRaisesRegex(ValueError, "PATCH_DROPPED_SOURCE"):
            s.run("global_patch", {"versionHash": runtime.version(s.state), "claims": [claim(2, uid(11))], "conflicts": []})

    def test_global_omission_restores_distinct_claim_lost_in_merge(self):
        s = Session()
        s.global_phase(groups=[{"claimKeys": ["b1-c1", "b1-c2"]}])
        issue = s.issue(key="", fid=uid(10), category="lost_meaning")
        s.run("global_request")
        self.assertEqual(len(s.request["preMergeClaims"]), 2)
        s.run("global_review", s.review(issues=[issue]))
        s.run("decision")
        addition = claim(2, uid(11), "Окреме твердження з другого фрагмента.")
        addition["key"] = "g-c1"
        s.run("global_patch", {"versionHash": runtime.version(s.state), "claims": s.state["claims"] + [addition], "conflicts": []})
        s.run("global_request")
        s.run("global_review", s.review())
        s.run("decision")
        self.assertEqual(len(s.run("finalize")["claims_json"]["claims"]), 2)

    def test_global_addition_must_use_separate_stable_key_namespace(self):
        s = Session()
        s.global_phase()
        s.run("global_review", s.review(issues=[s.issue(key="", fid=uid(10), category="omission")]))
        with self.assertRaisesRegex(ValueError, "GLOBAL_ADDITION_KEY"):
            s.run("global_patch", {"versionHash": runtime.version(s.state), "claims": s.state["claims"] + [claim(3)], "conflicts": []})

    def test_state_request_input_sizes_fail_closed(self):
        with self.assertRaisesRegex(ValueError, "SIZE_LIMIT"):
            Session(sources(30, "Український факт. " * 570))
        s = Session()
        s.state["reason"] = "я" * 180000
        with self.assertRaisesRegex(ValueError, "SIZE_LIMIT"):
            s.run("batch_request")

    def test_conflict_only_global_patch_allowed(self):
        s = Session()
        s.global_phase()
        s.run("global_review", s.review(issues=[s.issue(category="missing_conflict")]))
        s.run("decision")
        s.run("global_patch", {"versionHash": runtime.version(s.state), "claims": s.state["claims"],
                               "conflicts": [{"claimKeys": ["b1-c1", "b1-c2"], "rationale": "Джерела суперечать."}]})
        self.assertEqual(s.state["globalRevisions"], 1)

    def test_unrelated_conflicts_cannot_be_deleted_reworded_or_added(self):
        for fault in ("delete", "rewrite", "add"):
            s = Session(sources(3))
            s.global_phase([claim(1), claim(2, uid(11)), claim(3, uid(12))])
            existing = {"claimKeys": ["b1-c2", "b1-c3"], "rationale": "Різні висновки двох джерел."}
            if fault != "add":
                s.state["conflicts"] = [existing]
            s.run("global_review", s.review(issues=[s.issue(key="b1-c1")]))
            s.run("decision")
            updated = copy.deepcopy(s.state["claims"])
            updated[0]["wording"] = "У вибірці було саме 12 учасників."
            proposed = [] if fault == "delete" else [dict(existing, rationale="Довільно переписаний висновок.")]
            with self.subTest(fault=fault), self.assertRaisesRegex(ValueError, "UNREQUESTED_CONFLICT_"):
                s.run("global_patch", {"versionHash": runtime.version(s.state), "claims": updated, "conflicts": proposed})

    def test_anchored_conflict_participant_allows_conflict_repair(self):
        s = Session(sources(3))
        s.global_phase([claim(1), claim(2, uid(11)), claim(3, uid(12))])
        s.state["conflicts"] = [{"claimKeys": ["b1-c2", "b1-c3"], "rationale": "Можлива суперечність."}]
        s.run("global_review", s.review(issues=[s.issue(key="b1-c2", category="false_conflict")]))
        s.run("decision")
        s.run("global_patch", {"versionHash": runtime.version(s.state), "claims": s.state["claims"], "conflicts": []})
        self.assertEqual(s.state["conflicts"], [])

    def test_source_anchor_allows_repair_of_linked_conflict(self):
        s = Session(sources(3))
        s.global_phase([claim(1), claim(2, uid(11)), claim(3, uid(12))])
        s.state["conflicts"] = [{"claimKeys": ["b1-c2", "b1-c3"], "rationale": "Можлива суперечність."}]
        issue = s.issue(key="", fid=uid(11), category="false_conflict")
        issue["quote"] = s.sources[0]["fragments"][1]["text"]
        s.run("global_review", s.review(issues=[issue]))
        s.run("decision")
        s.run("global_patch", {"versionHash": runtime.version(s.state), "claims": s.state["claims"], "conflicts": []})
        self.assertEqual(s.state["conflicts"], [])

    def test_unrelated_conflict_participant_order_can_change(self):
        s = Session(sources(3))
        s.global_phase([claim(1), claim(2, uid(11)), claim(3, uid(12))])
        existing = {"claimKeys": ["b1-c2", "b1-c3"], "rationale": "Різні висновки."}
        s.state["conflicts"] = [existing]
        s.run("global_review", s.review(issues=[s.issue(key="b1-c1")]))
        s.run("decision")
        updated = copy.deepcopy(s.state["claims"])
        updated[0]["wording"] = "У вибірці було саме 12 учасників."
        s.run("global_patch", {"versionHash": runtime.version(s.state), "claims": updated,
                               "conflicts": [dict(existing, claimKeys=list(reversed(existing["claimKeys"])))]})
        self.assertEqual(s.state["globalRevisions"], 1)

    def test_prepare_rejects_minimum_global_request_overflow_before_calls(self):
        data = sources(42, "x" * 8070)
        self.assertLess(len(runtime.dumps(data).encode()), runtime.MAX_BYTES)
        with self.assertRaisesRegex(ValueError, "SIZE_LIMIT"):
            Session(data)

    def test_global_repair_limit_blocks_all_candidates(self):
        s = Session()
        s.global_phase()
        for n in range(3):
            s.run("global_request")
            s.run("global_review", s.review(issues=[s.issue()]))
            s.run("decision")
            if n < 2:
                s.run("global_patch", {"versionHash": runtime.version(s.state), "claims": [claim(1, wording="Умовне твердження %d." % n), claim(2, uid(11))], "conflicts": []})
        result = s.run("finalize")
        self.assertIsNone(result["claims_json"])
        self.assertEqual(result["extraction_report"]["reason"], "GLOBAL_REPAIR_LIMIT")

    def test_loop_exhaustion_yields_visible_failure(self):
        s = Session(sources(9))
        s.accept_batch([claim(1)])
        result = s.run("finalize")
        self.assertEqual(result["extraction_report"]["reason"], "INCOMPLETE_WORKFLOW")

    def test_call_limit_rejects_extra_paid_work(self):
        s = Session()
        s.state["modelCalls"] = 200
        with self.assertRaisesRegex(ValueError, "CALL_LIMIT"):
            s.run("batch_request")

    def test_invalid_json_nan_duplicate_keys_sanitized(self):
        for value in ('{"sources_json":NaN}', '{"x":1,"x":2}', '{bad', '{}'):
            with self.subTest(value=value), self.assertRaisesRegex(ValueError, "^CLAIMS_WORKFLOW_"):
                runtime.main("prepare", value)

    def test_model_claim_array_limits_survive_native_schema_relaxation(self):
        # Gemini-facing schemas may omit maxItems. These are the actual Code
        # boundaries, exercised at the accepted limit and one above it.
        for operation, maximum in (("batch_draft", 30), ("batch_patch", 30), ("global_patch", 100)):
            for overflow in (False, True):
                s = Session()
                if operation == "global_patch":
                    s.global_phase([claim(1)])
                    s.run("global_review", s.review(issues=[s.issue(key="", fid=uid(10), category="omission")]))
                elif operation == "batch_patch":
                    s.run("batch_request")
                    s.run("batch_draft", {"claims": [claim(1)]})
                    s.run("batch_review", s.review(True, [s.issue(True, key="", fid=uid(10), category="omission")]))
                proposed = [claim(n + 1) for n in range(maximum + int(overflow))]
                if operation == "global_patch":
                    for n, row in enumerate(proposed[1:], 1):
                        row["key"] = "g-c%d" % n
                raw = {"claims": proposed}
                if operation != "batch_draft":
                    raw["versionHash"] = runtime.version(s.state, operation == "batch_patch")
                if operation == "global_patch":
                    raw["conflicts"] = []
                with self.subTest(operation=operation, overflow=overflow):
                    if overflow:
                        with self.assertRaisesRegex(ValueError, "ARRAY_SHAPE"):
                            s.run(operation, raw)
                    else:
                        result = s.run(operation, raw)
                        rows = result["state"]["claims"] if operation == "global_patch" else result["state"]["current"]
                        self.assertEqual(len(rows), maximum)

    def test_model_evidence_array_limit_is_enforced_by_code(self):
        _, fragments, _ = runtime.source_context(sources(11))
        row = claim(1)
        row["evidence"] = [{"fragmentId": fid, "relation": "SUPPORTS"} for fid in list(fragments)[:10]]
        self.assertEqual(len(runtime.candidates([row], fragments)[0]["evidence"]), 10)
        row["evidence"].append({"fragmentId": uid(20), "relation": "SUPPORTS"})
        with self.assertRaisesRegex(ValueError, "ARRAY_SHAPE"):
            runtime.candidates([row], fragments)

    def test_all_review_array_limits_are_enforced_by_code(self):
        s = Session(sources(240))
        s.state["claims"] = [claim(n + 1) for n in range(100)]
        _, fragments, _ = runtime.source_context(s.sources)
        proposed = s.review(issues=[dict(s.issue(), id="i%d" % n) for n in range(40)])
        self.assertEqual(len(proposed["coverage"]), 240)
        self.assertEqual(len(proposed["coverage"][0]["claimKeys"]), 100)
        self.assertEqual(runtime.review(proposed, s.state, fragments), proposed)
        for field in ("issues", "coverage", "coverage_claimKeys"):
            oversized = copy.deepcopy(proposed)
            rows = oversized["coverage"][0]["claimKeys"] if field == "coverage_claimKeys" else oversized[field]
            rows.append(copy.deepcopy(rows[0]))
            with self.subTest(field=field), self.assertRaisesRegex(ValueError, "ARRAY_SHAPE"):
                runtime.review(oversized, s.state, fragments)

    def test_both_merge_array_limits_are_enforced_by_code(self):
        for grouped in (False, True):
            for overflow in (False, True):
                s = Session()
                s.state["phase"] = "merge"
                s.state["claims"] = [claim(n + 1) for n in range(100)]
                keys = [c["key"] for c in s.state["claims"]]
                groups = [{"claimKeys": keys}] if grouped else [{"claimKeys": [key]} for key in keys]
                if overflow:
                    if grouped:
                        groups[0]["claimKeys"].append(keys[0])
                    else:
                        groups.append(copy.deepcopy(groups[0]))
                with self.subTest(grouped=grouped, overflow=overflow):
                    if overflow:
                        with self.assertRaisesRegex(ValueError, "ARRAY_SHAPE"):
                            s.run("merge", {"versionHash": runtime.version(s.state), "groups": groups})
                    else:
                        s.run("merge", {"versionHash": runtime.version(s.state), "groups": groups})
                        self.assertEqual(len(s.state["claims"]), 1 if grouped else 100)

    def test_both_conflict_array_limits_are_enforced_by_code(self):
        claims = [claim(n + 1) for n in range(15)]
        keys = [c["key"] for c in claims]
        proposed = [{"claimKeys": list(pair), "rationale": "Джерела суперечать."}
                    for pair in list(itertools.combinations(keys, 2))[:100]]
        self.assertEqual(len(runtime.conflicts(proposed, claims)), 100)
        with self.assertRaisesRegex(ValueError, "ARRAY_SHAPE"):
            runtime.conflicts(proposed + [proposed[0]], claims)
        self.assertEqual(len(runtime.conflicts([{"claimKeys": keys[:10], "rationale": "Різні висновки."}], claims)[0]["claimKeys"]), 10)
        with self.assertRaisesRegex(ValueError, "ARRAY_SHAPE"):
            runtime.conflicts([{"claimKeys": keys[:11], "rationale": "Різні висновки."}], claims)


if __name__ == "__main__":
    unittest.main()
