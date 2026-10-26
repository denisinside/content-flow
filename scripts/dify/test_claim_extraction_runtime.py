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
        # Existing unit scenarios describe the requested resulting claim set;
        # translate that fixture shorthand into the new sparse editor contract.
        if operation == "global_patch" and isinstance(raw, dict) and "claims" in raw:
            old = {claim["key"]: claim for claim in self.state["claims"]}
            proposed = {claim["key"]: claim for claim in raw["claims"]}
            raw = {"versionHash": raw["versionHash"],
                   "updates": [claim for key, claim in proposed.items() if key in old and claim != old[key]],
                   "additions": [claim for key, claim in proposed.items() if key not in old],
                   "removals": [key for key in old if key not in proposed],
                   "conflicts": raw["conflicts"]}
        payload = {"sources_json": runtime.dumps(self.sources)}
        if self.state is not None:
            payload["state_json"] = runtime.dumps(self.state)
        if raw is not None:
            payload["raw"] = runtime.dumps(raw)
        result = json.loads(runtime.main(operation, runtime.dumps(payload))["result_json"])
        self.state, self.request = result["state"], result["request"]
        return result

    def review(self, batch=False, issues=None):
        result = {"versionHash": runtime.version(self.state, batch), "issues": issues or []}
        if batch:
            current = self.state["current"]
            ids = self.state["packets"][self.state["cursor"]]
            coverage = []
            for fid in ids:
                keys = [c["key"] for c in current if any(e["fragmentId"] == fid for e in c["evidence"])]
                coverage.append({"fragmentId": fid, "disposition": "covered" if keys else "no_factual_claims", "claimKeys": keys})
            result["coverage"] = coverage
        else:
            result["batchCoverage"] = runtime.packet_manifest(self.state["packets"], runtime.source_context(self.sources)[1])
        return result

    def accept_batch(self, candidates=None):
        self.run("batch_request")
        self.run("batch_draft", {"claims": candidates if candidates is not None else [claim(1), claim(2, uid(11))]})
        self.run("batch_review", self.review(True))
        self.run("advance")

    def global_phase(self, candidates=None, groups=None):
        self.accept_batch(candidates)
        self.run("merge_request")
        self.run("merge", {"versionHash": runtime.version(self.state), "groups": groups or []})
        self.run("conflict_request")
        self.run("conflict", {"versionHash": runtime.version(self.state), "conflicts": []})

    def issue(self, batch=False, key="b1-c1", severity="major", category="entailment", fid=""):
        current = self.state["current"] if batch else self.state["claims"]
        wording = next(c["wording"] for c in current if c["key"] == key) if key else self.sources[0]["fragments"][0]["text"]
        return {"id": "i1", "severity": severity, "category": category, "claimKey": key, "fragmentId": fid,
                "quote": wording, "instruction": "Збережи точні умови джерела.", "acceptance": "Формулювання підтримане джерелом."}


def global_patch_payload(session, updates=None, additions=None, removals=None, conflicts=None):
    return {"versionHash": runtime.version(session.state), "updates": updates or [],
            "additions": additions or [], "removals": removals or [],
            "conflicts": session.state["conflicts"] if conflicts is None else conflicts}


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

    def test_batch_structural_review_retry_preserves_candidates_and_version(self):
        s = Session()
        s.run("batch_request")
        candidate = claim(1)
        s.run("batch_draft", {"claims": [candidate]})
        before = copy.deepcopy(s.state["current"])
        frozen_version = runtime.version(s.state, True)
        bad_review = s.review(True)
        bad_review["coverage"][0] = {"fragmentId": uid(10), "disposition": "no_factual_claims", "claimKeys": []}
        calls = s.state["modelCalls"]

        s.run("batch_review", bad_review)
        self.assertEqual(s.state["current"], before)
        self.assertIsNone(s.state["batchReview"])
        self.assertEqual(s.state["mode"], "review_retry")
        self.assertEqual(s.state["reviewRetryCode"], "COVERAGE_EMPTY")
        self.assertEqual(s.state["reviewRetryCount"], 1)
        self.assertEqual(s.state["modelCalls"], calls + 1)

        calls = s.state["modelCalls"]
        s.run("batch_request")
        self.assertEqual(s.state["modelCalls"], calls)
        s.run("batch_review_request")
        self.assertEqual(s.request["versionHash"], frozen_version)
        self.assertEqual(s.request["claims"], before)
        self.assertEqual(s.request["validationCode"], "COVERAGE_EMPTY")
        self.assertEqual(s.request["expectedCoverage"], [{"fragmentId": uid(10), "claimKeys": ["b1-c1"]},
                                                           {"fragmentId": uid(11), "claimKeys": []}])
        s.run("batch_review", s.review(True))
        self.assertEqual(s.state["current"], before)
        self.assertEqual(s.state["reviewRetryCode"], "")
        self.assertEqual(s.state["reviewRetryCount"], 1)
        s.run("advance")
        self.assertEqual(s.state["reviewRetryCount"], 1)

    def test_batch_coverage_must_list_every_current_claim_reference(self):
        s = Session()
        s.run("batch_request")
        s.run("batch_draft", {"claims": [claim(1, uid(10)), claim(2, uid(10))]})
        bad_review = s.review(True)
        bad_review["coverage"][0]["claimKeys"] = ["b1-c1"]
        s.run("batch_review", bad_review)
        self.assertEqual(s.state["mode"], "review_retry")
        self.assertEqual(s.state["reviewRetryCode"], "COVERAGE_CLAIM")
        s.run("batch_request")
        s.run("batch_review_request")
        self.assertEqual(s.request["expectedCoverage"][0], {"fragmentId": uid(10), "claimKeys": ["b1-c1", "b1-c2"]})

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
            self.assertLessEqual(len(packet), runtime.MAX_BATCH_FRAGMENTS)
            self.assertLessEqual(len(runtime.dumps([fs[k] for k in packet]).encode()), 40000)
        max_rows = Session(sources(33, "x"))
        self.assertEqual([len(packet) for packet in max_rows.state["packets"]], [32, 1])
        byte_guard = sources(2, "漢" * 9000)
        _, byte_fragments, byte_packets = runtime.source_context(byte_guard)
        self.assertEqual([len(packet) for packet in byte_packets], [1, 1])
        self.assertTrue(all(len(runtime.dumps([byte_fragments[fid]]).encode()) <= runtime.MAX_BATCH_BYTES
                            for packet in byte_packets for fid in packet))
        with self.assertRaisesRegex(ValueError, "PACKET_LIMIT"):
            Session(sources(961, "x"))

    def test_781_small_fragments_fit_batch_and_compact_model_requests(self):
        s = Session(sources(781, "Короткий фрагмент."))
        self.assertEqual(len(s.state["packets"]), 25)
        self.assertEqual(sum(map(len, s.state["packets"])), 781)
        _, all_fragments, _ = runtime.source_context(s.sources)
        for packet in s.state["packets"]:
            self.assertLessEqual(len(packet), runtime.MAX_BATCH_FRAGMENTS)
            self.assertLessEqual(len(runtime.dumps([all_fragments[fid] for fid in packet]).encode()),
                                 runtime.MAX_BATCH_BYTES)
        s.run("batch_request")
        self.assertTrue(all(set(row) == {"id", "snapshotId", "text"} for row in s.request["fragments"]))
        self.assertLessEqual(len(runtime.dumps(s.request).encode()), runtime.MAX_BYTES)

    def test_global_review_compact_ack_is_bound_to_every_original_packet(self):
        s = Session(sources(781, "Короткий фрагмент."))
        while s.state["cursor"] < len(s.state["packets"]):
            s.run("batch_request")
            s.run("batch_draft", {"claims": []})
            s.run("batch_review", s.review(True))
            s.run("advance")
        s.run("merge", {"versionHash": runtime.version(s.state), "groups": []})
        s.run("conflict", {"versionHash": runtime.version(s.state), "conflicts": []})
        s.run("global_request")
        self.assertEqual(len(s.request["fragments"]), 781)
        self.assertEqual(len(s.request["batchManifest"]), 25)
        self.assertLessEqual(len(runtime.dumps(s.request).encode()), runtime.MAX_BYTES)
        self.assertTrue(all(set(row) == {"id", "snapshotId", "text", "batchId"} for row in s.request["fragments"]))
        s.run("global_review", s.review())
        s.run("decision")
        final = s.run("finalize")
        self.assertEqual(final["status"], "ready")
        self.assertEqual(final["claims_json"]["claims"], [])

    def test_global_review_requires_exact_unique_known_batch_acks(self):
        for fault, expected_error in (
            ("missing", "GLOBAL_COVERAGE_INCOMPLETE"),
            ("duplicate", "GLOBAL_COVERAGE_DUPLICATE"),
            ("wrong_hash", "GLOBAL_COVERAGE_HASH"),
            ("unknown", "GLOBAL_COVERAGE_REFERENCE"),
        ):
            s = Session(sources(33, "Короткий фрагмент."))
            s.run("batch_request")
            s.run("batch_draft", {"claims": []})
            s.run("batch_review", s.review(True))
            s.run("advance")
            s.run("batch_request")
            s.run("batch_draft", {"claims": []})
            s.run("batch_review", s.review(True))
            s.run("advance")
            s.run("merge", {"versionHash": runtime.version(s.state), "groups": []})
            s.run("conflict", {"versionHash": runtime.version(s.state), "conflicts": []})
            review = s.review()
            if fault == "missing":
                review["batchCoverage"].pop()
            elif fault == "duplicate":
                review["batchCoverage"].append(copy.deepcopy(review["batchCoverage"][0]))
            elif fault == "wrong_hash":
                review["batchCoverage"][0]["batchHash"] = "0" * 64
            else:
                review["batchCoverage"][0]["batchId"] = "b99"
            with self.subTest(fault=fault):
                original = copy.deepcopy(s.state["claims"])
                version_hash = runtime.version(s.state)
                s.run("global_review", review)
                self.assertEqual(s.state["claims"], original)
                self.assertEqual(runtime.version(s.state), version_hash)
                self.assertIsNone(s.state["globalReview"])
                self.assertEqual(s.state["reviewRetryCode"], expected_error)
                self.assertEqual(s.state["mode"], "review_retry")
                self.assertEqual(s.state["reviewRetryCount"], 1)
                s.run("global_request")
                self.assertEqual(s.request["validationCode"], expected_error)
                self.assertEqual(s.request["versionHash"], version_hash)

    def test_no_empty_claims_without_complete_coverage(self):
        s = Session()
        s.run("batch_request")
        s.run("batch_draft", {"claims": []})
        reviewed = s.review(True)
        reviewed["coverage"].pop()
        s.run("batch_review", reviewed)
        self.assertEqual(s.state["mode"], "review_retry")
        self.assertEqual(s.state["reviewRetryCode"], "COVERAGE_INCOMPLETE")
        self.assertIsNone(s.state["batchReview"])

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
            with self.subTest(fault=fault):
                if fault in ("quote", "duplicate"):
                    with self.assertRaisesRegex(ValueError, "CLAIMS_WORKFLOW_"):
                        s.run("batch_review", review)
                else:
                    s.run("batch_review", review)
                    self.assertEqual(s.state["mode"], "review_retry")
                    expected = "STALE_REVIEW" if fault == "hash" else "COVERAGE_CLAIM" if fault in ("covered", "unlinked") else "COVERAGE_EMPTY"
                    self.assertEqual(s.state["reviewRetryCode"], expected)

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
        s.run("batch_patch", {"versionHash": runtime.version(s.state, True), "claims": [claim(1), claim(2, uid(10))]})
        s.run("batch_review", s.review(True))
        self.assertEqual(s.run("advance")["done"], 1)

    def test_batch_split_requires_compound_finding_and_its_evidence(self):
        s = Session()
        s.run("batch_request")
        s.run("batch_draft", {"claims": [claim(1)]})
        s.run("batch_review", s.review(True, [s.issue(True, category="compound_claim")]))
        with self.assertRaisesRegex(ValueError, "UNREQUESTED_ADDITION"):
            s.run("batch_patch", {"versionHash": runtime.version(s.state, True),
                                   "claims": [claim(1), claim(2, uid(11))]})
        s = Session()
        s.run("batch_request")
        s.run("batch_draft", {"claims": [claim(1)]})
        s.run("batch_review", s.review(True, [s.issue(True, category="compound_claim")]))
        s.run("batch_patch", {"versionHash": runtime.version(s.state, True),
                               "claims": [claim(1), claim(2, uid(10))]})

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
            with self.assertRaisesRegex(ValueError, "ARRAY_SHAPE|MERGE_PARTITION"):
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
        s.run("merge", {"versionHash": runtime.version(s.state), "groups": []})
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
        s.run("global_review", original_review)
        self.assertEqual(s.state["reviewRetryCode"], "STALE_REVIEW")
        self.assertIsNone(s.state["globalReview"])
        s.run("global_request")
        self.assertEqual(s.request["validationCode"], "STALE_REVIEW")
        s.run("global_review", s.review())
        s.run("decision")
        self.assertEqual(s.state["status"], "ready")

    def test_sparse_global_patch_changes_only_flagged_claims(self):
        s = Session(sources(3))
        s.global_phase([claim(1), claim(2, uid(11)), claim(3, uid(12))])
        s.run("global_review", s.review(issues=[s.issue(key="b1-c1")]))
        s.run("decision")
        before = copy.deepcopy(s.state["claims"])
        changed = copy.deepcopy(before[0])
        changed["wording"] = "У вибірці було 12 учасників."
        s.run("global_patch", global_patch_payload(s, updates=[changed], conflicts=[]))
        self.assertEqual(s.state["claims"][0], changed)
        self.assertEqual(s.state["claims"][1:], before[1:])

    def test_sparse_global_patch_rejects_unflagged_or_unanchored_changes(self):
        s = Session(sources(3))
        s.global_phase([claim(1), claim(2, uid(11)), claim(3, uid(12))])
        s.run("global_review", s.review(issues=[s.issue(key="b1-c1")]))
        s.run("decision")
        changed = copy.deepcopy(s.state["claims"][1])
        changed["wording"] = "Непозначена зміна."
        with self.assertRaisesRegex(ValueError, "UNREQUESTED_PATCH"):
            s.run("global_patch", global_patch_payload(s, updates=[changed], conflicts=[]))
        with self.assertRaisesRegex(ValueError, "UNREQUESTED_PATCH"):
            s.run("global_patch", global_patch_payload(s, removals=["b1-c2"], conflicts=[]))
        addition = claim(4, uid(10), "Непідтверджене доповнення.")
        addition["key"] = "g-c1"
        with self.assertRaisesRegex(ValueError, "GLOBAL_ADDITION_ANCHOR"):
            s.run("global_patch", global_patch_payload(s, additions=[addition], conflicts=[]))

    def test_global_patch_allows_mixed_omission_and_flagged_compound_split(self):
        s = Session(sources(3))
        s.global_phase([claim(1), claim(2, uid(11)), claim(3, uid(12))])
        feedback = [s.issue(key="b1-c1", category="compound_claim"),
                    dict(s.issue(key="", fid=uid(12), category="omission"), id="i2")]
        s.run("global_review", s.review(issues=feedback))
        s.run("decision")
        addition = claim(4, uid(10), "Окрема складова теза.")
        addition["key"] = "g-c1"
        s.run("global_patch", global_patch_payload(s, additions=[addition], conflicts=[]))
        self.assertEqual(len(s.state["claims"]), 4)

    def test_sparse_global_patch_caps_combined_operations(self):
        s = Session(sources())
        s.state["phase"] = "global"
        s.state["claims"] = [claim(i + 1) for i in range(40)]
        issues = [dict(s.issue(key=claim_row["key"]), id="i%d" % i)
                  for i, claim_row in enumerate(s.state["claims"])]
        s.state["globalReview"] = s.review(issues=issues)
        updates = copy.deepcopy(s.state["claims"][:20])
        for row in updates:
            row["wording"] = "Оновлена перевірювана теза."
        addition = claim(1, uid(10), "Окрема теза з джерела.")
        addition["key"] = "g-c1"
        with self.assertRaisesRegex(ValueError, "GLOBAL_PATCH_OPERATION_LIMIT"):
            s.run("global_patch", global_patch_payload(s, updates=updates, additions=[addition],
                                                         removals=[row["key"] for row in s.state["claims"][20:]],
                                                         conflicts=[]))

    def test_sparse_global_patch_rejects_legacy_full_array_contract(self):
        s = Session()
        s.global_phase()
        s.run("global_review", s.review(issues=[s.issue(key="b1-c1")]))
        s.run("decision")
        payload = {"sources_json": runtime.dumps(s.sources), "state_json": runtime.dumps(s.state),
                   "raw": runtime.dumps({"versionHash": runtime.version(s.state),
                                         "claims": s.state["claims"], "conflicts": []})}
        with self.assertRaisesRegex(ValueError, "OBJECT_SHAPE"):
            runtime.execute("global_patch", payload)

    def test_global_patch_fails_closed_above_five_hundred_total(self):
        s = Session()
        s.state["phase"] = "global"
        s.state["claims"] = [claim(n + 1) for n in range(500)]
        omission = s.issue(key="", fid=uid(10), category="omission")
        s.state["globalReview"] = {"versionHash": runtime.version(s.state), "issues": [omission],
                                   "coverage": []}
        addition = claim(1, uid(10), "Ще одна підтримана теза.")
        addition["key"] = "g-c1"
        payload = {"sources_json": runtime.dumps(s.sources), "state_json": runtime.dumps(s.state),
                   "raw": runtime.dumps(global_patch_payload(s, additions=[addition], conflicts=[]))}
        with self.assertRaisesRegex(ValueError, "CLAIM_LIMIT"):
            runtime.execute("global_patch", payload)

    def test_five_hundred_short_candidates_fit_compound_code_payload_and_outputs(self):
        s = Session(sources(800, "Короткий фрагмент."))
        s.state["phase"] = "global"
        _, fragments, packets = runtime.source_context(s.sources)
        s.state["cursor"] = len(packets)
        s.state["claims"] = [claim(index % 20 + 1, fid, batch=index // 20 + 1)
                              for index, fid in enumerate(list(fragments)[:500])]
        s.state["preMergeClaims"] = copy.deepcopy(s.state["claims"])
        s.state["conflicts"] = []
        payload = {"sources_json": runtime.dumps(s.sources), "state_json": runtime.dumps(s.state)}
        payload_json = runtime.dumps(payload)
        self.assertLessEqual(len(payload_json.encode("utf-8")), 2 * 1024 * 1024)
        result_json = runtime.main("global_request", payload_json)["result_json"]
        self.assertLessEqual(len(result_json.encode("utf-8")), 2 * 1024 * 1024)
        result = json.loads(result_json)
        self.assertEqual(len(result["state"]["claims"]), 500)
        self.assertEqual(len(result["request"]["claims"]), 500)
        self.assertLessEqual(len(runtime.dumps(result["request"])), runtime.MAX_CODE_OUTPUT_CHARS)

    def test_review_retry_budget_is_shared_and_exhaustion_blocks_all_candidates(self):
        s = Session()
        s.run("batch_request")
        candidate = claim(1)
        s.run("batch_draft", {"claims": [candidate]})
        bad = s.review(True)
        bad["coverage"][0] = {"fragmentId": uid(10), "disposition": "no_factual_claims", "claimKeys": []}
        s.run("batch_review", bad)
        self.assertEqual(s.state["reviewRetryCount"], 1)
        s.run("batch_request")
        s.run("batch_review_request")
        s.run("batch_review", s.review(True))
        self.assertEqual(s.state["current"], [candidate])
        s.run("advance")
        s.run("merge_request")
        s.run("merge", {"versionHash": runtime.version(s.state), "groups": []})
        s.run("conflict_request")
        s.run("conflict", {"versionHash": runtime.version(s.state), "conflicts": []})

        s.run("global_request")
        first_global = s.review()
        first_global["batchCoverage"].pop()
        original_claims = copy.deepcopy(s.state["claims"])
        original_version = runtime.version(s.state)
        s.run("global_review", first_global)
        self.assertEqual(s.state["reviewRetryCount"], 2)
        self.assertEqual(s.state["claims"], original_claims)
        self.assertEqual(runtime.version(s.state), original_version)
        s.run("decision")
        s.run("global_request")
        self.assertEqual(s.request["validationCode"], "GLOBAL_COVERAGE_INCOMPLETE")
        second_global = s.review()
        second_global["batchCoverage"].pop()
        s.run("global_review", second_global)
        self.assertEqual(s.state["status"], "needs_human")
        self.assertEqual(s.state["reason"], "REVIEW_VALIDATION_LIMIT")
        self.assertEqual(s.state["reviewRetryCount"], 2)
        self.assertEqual(s.state["claims"], original_claims)
        result = s.run("finalize")
        self.assertIsNone(result["claims_json"])
        self.assertEqual(result["extraction_report"]["status"], "needs_human")
        self.assertEqual(result["extraction_report"]["reason"], "REVIEW_VALIDATION_LIMIT")
        self.assertEqual(result["extraction_report"]["modelCalls"], 7)

    def test_non_allowlisted_review_errors_still_fail_closed(self):
        s = Session()
        s.run("batch_request")
        s.run("batch_draft", {"claims": [claim(1)]})
        malformed = s.review(True)
        malformed["issues"] = [{"bad": "shape"}]
        calls = s.state["modelCalls"]
        with self.assertRaisesRegex(ValueError, "OBJECT_SHAPE"):
            s.run("batch_review", malformed)
        self.assertEqual(s.state["reviewRetryCount"], 0)
        self.assertEqual(s.state["modelCalls"], calls)

    def test_global_patch_cannot_silently_drop_supported_fragment(self):
        s = Session()
        s.global_phase()
        s.run("global_review", s.review(issues=[s.issue()]))
        with self.assertRaisesRegex(ValueError, "PATCH_DROPPED_SOURCE"):
            s.run("global_patch", {"versionHash": runtime.version(s.state), "claims": [claim(2, uid(11))], "conflicts": []})

    def test_global_omission_restores_distinct_claim_lost_in_merge(self):
        s = Session()
        s.global_phase(groups=[{"claimKeys": ["b1-c1", "b1-c2"]}])
        issue = s.issue(key="", fid=uid(11), category="lost_meaning")
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
        s.state["reason"] = "я" * 600000
        with self.assertRaisesRegex(ValueError, "SIZE_LIMIT"):
            s.run("batch_request")
        s = Session()
        s.state["reason"] = "x" * 400001
        with self.assertRaisesRegex(ValueError, "CODE_OUTPUT_LIMIT"):
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

    def test_compact_minimum_global_envelope_fits_large_frozen_input(self):
        data = sources(42, "x" * 8070)
        self.assertLess(len(runtime.dumps(data).encode()), runtime.MAX_BYTES)
        s = Session(data)
        _, fragments, packets = runtime.source_context(data)
        request = {"versionHash": "0" * 64, "claims": [], "conflicts": [], "preMergeClaims": [],
                   "feedback": [], "batchManifest": runtime.packet_manifest(packets, fragments),
                   "fragments": runtime.model_fragments_with_batches(fragments, packets)}
        self.assertLessEqual(len(runtime.dumps(request).encode()), runtime.MAX_BYTES)
        self.assertLess(len(runtime.dumps(request).encode()), len(runtime.dumps(data).encode()))

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
        for operation, maximum in (("batch_draft", 20), ("batch_patch", 20)):
            for overflow in (False, True):
                s = Session()
                if operation == "batch_patch":
                    s.run("batch_request")
                    s.run("batch_draft", {"claims": [claim(1)]})
                    s.run("batch_review", s.review(True, [s.issue(True, key="", fid=uid(10), category="omission")]))
                proposed = [claim(n + 1) for n in range(maximum + int(overflow))]
                raw = {"claims": proposed}
                if operation != "batch_draft":
                    raw["versionHash"] = runtime.version(s.state, operation == "batch_patch")
                with self.subTest(operation=operation, overflow=overflow):
                    if overflow:
                        with self.assertRaisesRegex(ValueError, "ARRAY_SHAPE"):
                            s.run(operation, raw)
                    else:
                        result = s.run(operation, raw)
                        rows = result["state"]["current"]
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
        s = Session(sources(32))
        s.state["claims"] = [claim(n + 1) for n in range(500)]
        _, fragments, _ = runtime.source_context(s.sources)
        s.state["current"] = copy.deepcopy(s.state["claims"])
        proposed = s.review(batch=True, issues=[dict(s.issue(batch=True), id="i%d" % n) for n in range(40)])
        self.assertEqual(len(proposed["coverage"]), 32)
        self.assertEqual(len(proposed["coverage"][0]["claimKeys"]), 500)
        self.assertEqual(runtime.review(proposed, s.state, fragments, batch=True), proposed)
        for field in ("issues", "coverage", "coverage_claimKeys"):
            oversized = copy.deepcopy(proposed)
            rows = oversized["coverage"][0]["claimKeys"] if field == "coverage_claimKeys" else oversized[field]
            if field == "coverage_claimKeys":
                rows.extend(copy.deepcopy(rows[:401]))
            else:
                rows.append(copy.deepcopy(rows[0]))
            with self.subTest(field=field), self.assertRaisesRegex(ValueError, "ARRAY_SHAPE"):
                runtime.review(oversized, s.state, fragments, batch=True)

    def test_global_review_ack_array_limit_is_30(self):
        s = Session(sources(960, "Короткий фрагмент."))
        s.state["phase"] = "global"
        s.state["claims"] = []
        s.state["conflicts"] = []
        _, fragments, _ = runtime.source_context(s.sources)
        proposed = {"versionHash": runtime.version(s.state), "issues": [],
                    "batchCoverage": runtime.packet_manifest(s.state["packets"], fragments)}
        self.assertEqual(len(proposed["batchCoverage"]), 30)
        self.assertEqual(runtime.review(proposed, s.state, fragments), proposed)
        proposed["batchCoverage"].append(copy.deepcopy(proposed["batchCoverage"][0]))
        with self.assertRaisesRegex(ValueError, "ARRAY_SHAPE"):
            runtime.review(proposed, s.state, fragments)

    def test_both_merge_array_limits_are_enforced_by_code(self):
        s = Session()
        s.state["phase"] = "merge"
        s.state["claims"] = [claim(n + 1) for n in range(500)]
        keys = [c["key"] for c in s.state["claims"]]
        s.run("merge", {"versionHash": runtime.version(s.state), "groups": []})
        self.assertEqual(len(s.state["claims"]), 500)

        s = Session()
        s.state["phase"] = "merge"
        s.state["claims"] = [claim(n + 1) for n in range(500)]
        keys = [c["key"] for c in s.state["claims"]]
        pairs = [{"claimKeys": keys[i:i + 2]} for i in range(0, 500, 2)]
        s.run("merge", {"versionHash": runtime.version(s.state), "groups": pairs})
        self.assertEqual(len(s.state["claims"]), 250)

        s = Session()
        s.state["phase"] = "merge"
        s.state["claims"] = [claim(n + 1) for n in range(500)]
        keys = [c["key"] for c in s.state["claims"]]
        too_many = [{"claimKeys": keys[i:i + 2]} for i in range(0, 502, 2)]
        with self.assertRaisesRegex(ValueError, "ARRAY_SHAPE"):
            s.run("merge", {"versionHash": runtime.version(s.state), "groups": too_many})

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
