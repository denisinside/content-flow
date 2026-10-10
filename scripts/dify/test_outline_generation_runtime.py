"""Synthetic semantic-boundary tests, without paid providers or source data."""
import copy
import hashlib
import json
import unittest
import uuid

import outline_generation_runtime as runtime


def uid(n):
    return str(uuid.UUID(int=n, version=4))


def editorial(creative=False):
    source = "У тестовій вибірці було 12 учасників."
    return {"schemaVersion": "outline-context-v1", "contentMode": "CREATIVE" if creative else "FACTUAL",
            "brief": {"topic": "Дослідження", "audience": "Редактори", "centralMessage": "Межі результатів важливі.",
                      "category": "Стаття", "tone": "Спокійний", "targetLength": 500, "cta": "", "exclusions": [],
                      "notes": "", "requiredClaimRevisionIds": [] if creative else [uid(1)]},
            "style": {"brandbook": "Пишіть конкретно.", "tone": "", "settings": {}},
            "claims": [] if creative else [{"claimRevisionId": uid(1), "wording": source,
                "evidence": [{"evidenceId": uid(2), "snapshotId": uid(3), "quote": source}]}],
            "context": [{"snapshotId": uid(3), "purpose": "Редакційний контекст",
                         "sha256": hashlib.sha256(source.encode()).hexdigest(), "text": source}]}


def strategy():
    return {"readerNeed": "Зрозуміти межі дослідження", "angle": "Вибірка та межі висновків", "promise": "Пояснити, що показують дані",
            "narrativeLogic": "Запитання, метод, обмеження", "exclusions": []}


def plan(creative=False):
    return {"title": "Що показує вибірка", "sections": [
        {"sectionId": "s1", "title": "Чому це питання важливе", "purpose": "Поставити редакційне питання без додаткових фактів.",
         "keyMessage": "Висновки залежать від методу", "readerQuestion": "Що потрібно з’ясувати?", "claimRevisionIds": [], "targetWords": 150,
         "transition": "Перейти до методу."},
        {"sectionId": "s2", "title": "Метод і межі", "purpose": "Пояснити обсяг вибірки і межі висновків.",
         "keyMessage": "Показати обсяг дослідження", "readerQuestion": "Що досліджували?", "claimRevisionIds": [] if creative else [uid(1)],
         "targetWords": 350, "transition": ""}]}


class Session:
    def __init__(self, value=None):
        self.editorial = editorial() if value is None else value
        self.state = None
        self.request = None
        self.run("prepare")

    def run(self, operation, raw=None, scope=None):
        payload = {"editorial_json": runtime.dumps(self.editorial)}
        if self.state is not None:
            payload["state_json"] = runtime.dumps(self.state)
        if raw is not None:
            payload["model_json"] = runtime.dumps(raw)
        if scope is not None:
            payload["scope"] = scope
        result = json.loads(runtime.main(operation, runtime.dumps(payload))["result_json"])
        self.state, self.request = result["state"], result["request"]
        return result

    def review(self, issues=None):
        return {"reviewedHash": runtime.version(self.state), "issues": [] if issues is None else issues}

    def issue(self, target="s2", field="purpose", severity="major", quote=None):
        if target == "strategy":
            value = self.state["strategy"][field]
        elif target == "article":
            value = self.state["plan"][field]
        else:
            value = next(v for v in self.state["plan"]["sections"] if v["sectionId"] == target)[field]
        return {"issueId": "i1", "severity": severity, "category": "clarity", "targetId": target, "field": field,
                "quote": quote if quote is not None else (value if isinstance(value, str) else ""),
                "instruction": "Уточнити інструкцію для автора.", "acceptance": "Інструкція пояснює конкретне завдання."}

    def architecture(self):
        self.run("strategy_draft", strategy())
        self.run("strategy_review", self.review())
        self.run("strategy_decision")
        self.run("plan_request")
        self.run("plan_draft", plan(self.editorial["contentMode"] == "CREATIVE"))

    def pair(self, editorial_issues=None, grounding_issues=None):
        self.run("review", self.review(editorial_issues), "editorial")
        self.run("review", self.review(grounding_issues), "grounding")
        return self.run("decision")


class RuntimeTests(unittest.TestCase):
    def test_ready_candidate_has_exact_contract_and_frozen_references(self):
        s = Session()
        s.architecture()
        s.pair()
        result = s.run("finalize")
        self.assertEqual(result["status"], "ready")
        self.assertEqual(result["outline_json"], {"schemaVersion": "outline-v1", "content": {
            "title": plan()["title"], "sections": [{k: row[k] for k in ("title", "purpose", "claimRevisionIds")} for row in plan()["sections"]]}})
        self.assertEqual(result["outline_report"]["modelCalls"], 5)
        self.assertTrue(result["outline_report"]["humanApprovalRequired"])

    def test_creative_outline_has_no_claims(self):
        s = Session(editorial(True))
        s.architecture()
        s.pair()
        self.assertTrue(all(not row["claimRevisionIds"] for row in s.run("finalize")["outline_json"]["content"]["sections"]))

    def test_strategy_patch_and_review_are_bounded(self):
        s = Session()
        s.run("strategy_draft", strategy())
        issue = s.issue("strategy", "angle")
        s.run("strategy_review", s.review([issue]))
        result = s.run("strategy_decision")
        self.assertEqual(result["mode"], "edit")
        updated = strategy()
        updated["angle"] = "Що можна сказати про вибірку"
        s.run("strategy_patch", {"reviewedHash": runtime.version(s.state), "strategy": updated})
        self.assertIsNone(s.state["strategyReview"])
        s.run("strategy_review", s.review([s.issue("strategy", "angle")]))
        self.assertEqual(s.run("strategy_decision")["status"], "needs_human")
        final = s.run("finalize")
        self.assertIsNone(final["outline_json"])
        self.assertEqual(final["outline_report"]["reason"], "UNRESOLVED_STRATEGY")

    def test_strategy_unflagged_changes_are_rejected(self):
        s = Session()
        s.run("strategy_draft", strategy())
        s.run("strategy_review", s.review([s.issue("strategy", "angle")]))
        s.run("strategy_decision")
        updated = strategy()
        updated["angle"], updated["promise"] = "Новий кут", "Інша обіцянка"
        with self.assertRaisesRegex(ValueError, "UNFLAGGED_EDIT"):
            s.run("strategy_patch", {"reviewedHash": runtime.version(s.state), "strategy": updated})

    def test_strategy_cannot_skip_review_or_invent_current_version(self):
        s = Session()
        s.run("strategy_draft", strategy())
        with self.assertRaisesRegex(ValueError, "MISSING_CURRENT_REVIEW"):
            s.run("strategy_decision")
        with self.assertRaisesRegex(ValueError, "STRATEGY_NOT_REVIEWED"):
            s.run("plan_request")

    def test_outline_targeted_repair_then_pair_pass(self):
        s = Session()
        s.architecture()
        issue = s.issue()
        s.pair([issue])
        updated = copy.deepcopy(s.state["plan"])
        updated["sections"][1]["purpose"] = "Пояснити лише розмір вибірки, без узагальнення на іншу популяцію."
        old_hash = runtime.version(s.state)
        s.run("plan_patch", {"reviewedHash": old_hash, "plan": updated})
        self.assertIsNone(s.state["editorialReview"])
        self.assertIsNone(s.state["groundingReview"])
        self.assertNotEqual(old_hash, runtime.version(s.state))
        s.pair()
        self.assertEqual(s.run("finalize")["outline_report"]["outlineRevisions"], 1)

    def test_two_outline_repairs_then_needs_human(self):
        s = Session()
        s.architecture()
        for n in range(2):
            s.pair([s.issue()])
            updated = copy.deepcopy(s.state["plan"])
            updated["sections"][1]["purpose"] += " Уточнення %d." % n
            s.run("plan_patch", {"reviewedHash": runtime.version(s.state), "plan": updated})
        s.pair([s.issue()])
        result = s.run("finalize")
        self.assertIsNone(result["outline_json"])
        self.assertEqual(result["status"], "needs_human")
        self.assertEqual(result["outline_report"]["modelCalls"], 11)

    def test_worst_case_has_13_model_calls(self):
        s = Session()
        s.run("strategy_draft", strategy())
        s.run("strategy_review", s.review([s.issue("strategy", "angle")]))
        s.run("strategy_decision")
        updated = strategy()
        updated["angle"] = "Уточнений кут"
        s.run("strategy_patch", {"reviewedHash": runtime.version(s.state), "strategy": updated})
        s.run("strategy_review", s.review())
        s.run("strategy_decision")
        s.run("plan_request")
        s.run("plan_draft", plan())
        for n in range(2):
            s.pair([s.issue()])
            updated = copy.deepcopy(s.state["plan"])
            updated["sections"][1]["purpose"] += " Уточнення %d." % n
            s.run("plan_patch", {"reviewedHash": runtime.version(s.state), "plan": updated})
        s.pair()
        self.assertEqual(s.run("finalize")["outline_report"]["modelCalls"], 13)

    def test_stale_review_and_patch_are_rejected(self):
        s = Session()
        s.architecture()
        with self.assertRaisesRegex(ValueError, "STALE_REVIEW"):
            s.run("review", {"reviewedHash": "0" * 64, "issues": []}, "editorial")
        s.pair([s.issue()])
        with self.assertRaisesRegex(ValueError, "STALE_PATCH"):
            s.run("plan_patch", {"reviewedHash": "0" * 64, "plan": plan()})

    def test_both_reviews_are_mandatory_and_ordered(self):
        s = Session()
        s.architecture()
        with self.assertRaisesRegex(ValueError, "REVIEW_ORDER"):
            s.run("review", s.review(), "grounding")
        s.run("review", s.review(), "editorial")
        with self.assertRaisesRegex(ValueError, "MISSING_CURRENT_REVIEW"):
            s.run("decision")

    def test_minor_findings_do_not_auto_approve_or_block_candidate(self):
        s = Session()
        s.architecture()
        s.pair([s.issue(severity="minor")])
        final = s.run("finalize")
        self.assertEqual(final["status"], "ready")
        self.assertEqual(len(final["outline_report"]["unresolvedIssues"]), 1)
        self.assertTrue(final["outline_report"]["humanApprovalRequired"])

    def test_incomplete_workflow_returns_no_candidate(self):
        s = Session()
        self.assertIsNone(s.run("finalize")["outline_json"])
        self.assertEqual(s.state["reason"], "INCOMPLETE_WORKFLOW")

    def test_unknown_claim_missing_required_and_word_budget_rejected(self):
        for code, mutate in (("PLAN_REFERENCE", lambda p: p["sections"][1].update(claimRevisionIds=[uid(99)])),
                             ("REQUIRED_COVERAGE", lambda p: p["sections"][1].update(claimRevisionIds=[])),
                             ("WORD_BUDGET", lambda p: p["sections"][1].update(targetWords=351))):
            with self.subTest(code=code):
                s = Session()
                s.run("strategy_draft", strategy())
                s.run("strategy_review", s.review())
                s.run("strategy_decision")
                s.run("plan_request")
                updated = plan()
                mutate(updated)
                with self.assertRaisesRegex(ValueError, code):
                    s.run("plan_draft", updated)

    def test_optional_claims_need_not_all_be_covered(self):
        e = editorial()
        second = copy.deepcopy(e["claims"][0])
        second["claimRevisionId"] = uid(99)
        e["claims"].append(second)
        s = Session(e)
        s.architecture()
        s.pair()
        self.assertEqual(s.run("finalize")["status"], "ready")

    def test_duplicate_section_or_reference_rejected(self):
        s = Session()
        s.architecture()
        for code, mutate in (("SECTION_ID", lambda p: p["sections"][1].update(sectionId="s1")),
                             ("DUPLICATE_REFERENCE", lambda p: p["sections"][1].update(claimRevisionIds=[uid(1), uid(1)]))):
            p = plan()
            mutate(p)
            with self.subTest(code=code), self.assertRaisesRegex(ValueError, code):
                runtime.plan(p, s.editorial)

    def test_issue_anchors_reject_unknown_section_and_invented_quote(self):
        s = Session()
        s.architecture()
        for code, change in (("ISSUE_TARGET", {"targetId": "s30"}), ("ISSUE_ANCHOR", {"quote": "Неіснуючий текст"})):
            issue = s.issue()
            issue.update(change)
            with self.subTest(code=code), self.assertRaisesRegex(ValueError, code):
                s.run("review", s.review([issue]), "editorial")

    def test_unflagged_section_and_title_edits_are_rejected(self):
        s = Session()
        s.architecture()
        s.pair([s.issue()])
        for mutate in (lambda p: p.update(title="Інший заголовок"), lambda p: p["sections"][0].update(purpose="Інший розділ")):
            p = plan()
            p["sections"][1]["purpose"] += " Уточнення."
            mutate(p)
            with self.assertRaisesRegex(ValueError, "UNFLAGGED_EDIT"):
                s.run("plan_patch", {"reviewedHash": runtime.version(s.state), "plan": p})

    def test_reorder_requires_structural_issue(self):
        s = Session()
        s.architecture()
        s.pair([s.issue()])
        p = plan()
        p["sections"].reverse()
        with self.assertRaisesRegex(ValueError, "STRUCTURE_EDIT"):
            s.run("plan_patch", {"reviewedHash": runtime.version(s.state), "plan": p})

    def test_structural_issue_allows_reorder_without_unrelated_rewrites(self):
        s = Session()
        s.architecture()
        s.pair([s.issue("article", "sections")])
        p = plan()
        p["sections"].reverse()
        s.run("plan_patch", {"reviewedHash": runtime.version(s.state), "plan": p})
        self.assertEqual(s.state["plan"]["sections"][0]["sectionId"], "s2")
        s.pair([s.issue("article", "sections")])
        p = copy.deepcopy(s.state["plan"])
        p["sections"].reverse()
        p["sections"][0]["purpose"] = "Неузгоджене переписування"
        with self.assertRaisesRegex(ValueError, "UNFLAGGED_EDIT"):
            s.run("plan_patch", {"reviewedHash": runtime.version(s.state), "plan": p})

    def test_structural_edit_does_not_rename_unchanged_section(self):
        s = Session()
        s.architecture()
        s.pair([s.issue("article", "sections")])
        p = plan()
        p["sections"][0]["sectionId"] = "s3"
        with self.assertRaisesRegex(ValueError, "SECTION_RENAMED"):
            s.run("plan_patch", {"reviewedHash": runtime.version(s.state), "plan": p})

    def test_frozen_input_change_and_corrupt_context_are_rejected(self):
        s = Session()
        s.editorial["brief"]["topic"] = "Інша тема"
        with self.assertRaisesRegex(ValueError, "INPUT_CHANGED"):
            s.run("strategy_draft", strategy())
        e = editorial()
        e["context"][0]["text"] += " Зміна"
        with self.assertRaisesRegex(ValueError, "CONTEXT_HASH"):
            Session(e)

    def test_frozen_state_input_hash_is_rechecked(self):
        s = Session()
        s.state["editorial"]["brief"]["topic"] = "Інша тема"
        with self.assertRaisesRegex(ValueError, "INPUT_HASH"):
            s.run("strategy_draft", strategy())

    def test_creative_rejects_factual_basis(self):
        e = editorial()
        e["contentMode"] = "CREATIVE"
        with self.assertRaisesRegex(ValueError, "CREATIVE_EVIDENCE"):
            Session(e)

    def test_capacity_and_call_limit_fail_closed(self):
        e = editorial()
        e["style"]["settings"] = {"data": "x" * 350000}
        with self.assertRaisesRegex(ValueError, "JSON_SIZE|SIZE_LIMIT"):
            Session(e)
        s = Session()
        s.state["modelCalls"] = 16
        with self.assertRaisesRegex(ValueError, "CALL_LIMIT"):
            s.run("strategy_draft", strategy())

    def test_model_array_limits_remain_hard_bounds_without_native_max_items(self):
        # Gemini-facing schema describes these limits; runtime must still
        # reject oversized model answers rather than trusting the hint.
        candidate = strategy()
        candidate["exclusions"] = ["Не вигадувати фактів."] * 50
        self.assertEqual(len(runtime.strategy(candidate)["exclusions"]), 50)
        candidate["exclusions"].append("Ще одне виключення.")
        with self.assertRaisesRegex(ValueError, "OUTLINE_WORKFLOW_ARRAY_SHAPE"):
            runtime.strategy(candidate)
        e, candidate = editorial(True), plan(True)
        e["brief"]["targetLength"] = 60
        template = candidate["sections"][0]
        candidate["sections"] = [dict(template, sectionId="s" + str(i + 1), targetWords=2) for i in range(30)]
        self.assertEqual(len(runtime.plan(candidate, e)["sections"]), 30)
        candidate["sections"].append(dict(template, sectionId="s31", targetWords=2))
        with self.assertRaisesRegex(ValueError, "OUTLINE_WORKFLOW_ARRAY_SHAPE"):
            runtime.plan(candidate, e)

    def test_duplicate_json_key_and_nonfinite_number_are_rejected(self):
        for raw, code in (("{\"a\":1,\"a\":2}", "DUPLICATE_KEY"), ("{\"a\":NaN}", "JSON_NUMBER")):
            with self.subTest(raw=raw), self.assertRaisesRegex(ValueError, code):
                runtime.load(raw)

    def test_read_only_requests_do_not_increment_counter(self):
        s = Session()
        s.run("strategy_draft", strategy())
        self.assertEqual(s.run("strategy_review_request")["state"]["modelCalls"], 2)
        s.run("strategy_review", s.review())
        s.run("strategy_decision")
        s.run("plan_request")
        s.run("plan_draft", plan())
        self.assertEqual(s.run("review_request", scope="editorial")["state"]["modelCalls"], 4)

    def test_ready_cannot_be_forged_after_unreviewed_change(self):
        s = Session()
        s.architecture()
        s.pair()
        s.state["plan"]["title"] = "Нерецензований заголовок"
        with self.assertRaisesRegex(ValueError, "FINAL_NOT_REVIEWED"):
            s.run("finalize")

    def test_patch_requires_actual_change(self):
        s = Session()
        s.architecture()
        s.pair([s.issue()])
        with self.assertRaisesRegex(ValueError, "PATCH_NO_CHANGE"):
            s.run("plan_patch", {"reviewedHash": runtime.version(s.state), "plan": plan()})

    def test_omitted_boundary_can_be_added_to_empty_strategy_exclusions(self):
        s = Session()
        s.run("strategy_draft", strategy())
        s.run("strategy_review", s.review([s.issue("strategy", "exclusions")]))
        s.run("strategy_decision")
        updated = strategy()
        updated["exclusions"] = ["Не узагальнювати висновки на інші популяції."]
        s.run("strategy_patch", {"reviewedHash": runtime.version(s.state), "strategy": updated})
        s.run("strategy_review", s.review())
        self.assertEqual(s.run("strategy_decision")["mode"], "pass")

    def test_structural_addition_preserves_ids_and_requires_budget_change_anchor(self):
        s = Session()
        s.architecture()
        budget = s.issue("s2", "targetWords")
        budget["issueId"] = "i2"
        s.pair([s.issue("article", "sections"), budget])
        updated = plan()
        updated["sections"][1]["targetWords"] = 250
        new = copy.deepcopy(updated["sections"][0])
        new.update(sectionId="s3", title="Підсумок", purpose="Підсумувати межі висновків.", targetWords=100)
        updated["sections"].append(new)
        s.run("plan_patch", {"reviewedHash": runtime.version(s.state), "plan": updated})
        self.assertEqual([row["sectionId"] for row in s.state["plan"]["sections"]], ["s1", "s2", "s3"])
        s.pair()
        self.assertEqual(len(s.run("finalize")["outline_json"]["content"]["sections"]), 3)

    def test_model_text_bounds_count_utf16_units(self):
        p = plan()
        p["sections"][0]["readerQuestion"] = "\U0001f9ea" * 501
        with self.assertRaisesRegex(ValueError, "TEXT_SHAPE"):
            runtime.plan(p, editorial())
        value = strategy()
        value["exclusions"] = ["межа"] * 50
        self.assertEqual(len(runtime.strategy(value)["exclusions"]), 50)
        value["exclusions"].append("ще одна")
        with self.assertRaisesRegex(ValueError, "ARRAY_SHAPE"):
            runtime.strategy(value)

    def test_entry_envelope_allows_individually_bounded_large_state_and_input(self):
        e = editorial()
        e["style"]["settings"] = {"data": "x" * 180000}
        s = Session(e)
        s.architecture()
        s.pair()
        self.assertEqual(s.run("finalize")["status"], "ready")

    def test_missing_transition_can_be_reviewed_and_repaired(self):
        s = Session()
        s.architecture()
        self.assertEqual(s.state["plan"]["sections"][1]["transition"], "")
        s.pair([s.issue("s2", "transition", quote="")])
        updated = copy.deepcopy(s.state["plan"])
        updated["sections"][1]["transition"] = "Повернутися до головного редакційного питання."
        s.run("plan_patch", {"reviewedHash": runtime.version(s.state), "plan": updated})
        s.pair()
        self.assertEqual(s.run("finalize")["status"], "ready")


if __name__ == "__main__":
    unittest.main()
