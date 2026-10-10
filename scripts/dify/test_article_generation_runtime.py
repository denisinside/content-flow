"""Synthetic acceptance tests for provider-free editorial state transitions."""
import copy
import json
import unittest

import article_generation_runtime as rt


CLAIM = "11111111-1111-4111-8111-111111111111"
EVIDENCE = "22222222-2222-4222-8222-222222222222"
SNAPSHOT = "33333333-3333-4333-8333-333333333333"


def fixture(factual=True, count=1):
    return {"schemaVersion": "article-context-v1", "contentMode": "FACTUAL" if factual else "CREATIVE",
            "brief": {"topic": "Синтетичний тест", "targetLength": 100 * count,
                      "requiredClaimRevisionIds": [CLAIM] if factual else []},
            "style": {"brandbook": "", "tone": "Просто", "settings": {}}, "context": [],
            "claims": [{"claimRevisionId": CLAIM, "wording": "Результат залежить від умов.",
                        "evidence": [{"evidenceId": EVIDENCE, "quote": "Результат залежить від умов.",
                                      "snapshotId": SNAPSHOT}]}] if factual else [],
            "outline": {"title": "Тестова стаття", "sections": [
                {"title": "Розділ " + str(i + 1), "purpose": "Пояснити умови.",
                 "claimRevisionIds": [CLAIM] if factual else []} for i in range(count)]}}


def plan(e, roles=None):
    return {"status": "ready", "reasons": [], "terminology": [{"term": "умови", "definition": "Зберігати уточнення умов."}], "sections": [
        {"sectionId": "s" + str(i + 1), "role": roles[i] if roles else "body",
         "readerQuestion": "Від чого залежить результат?", "thesis": "Від умов.",
         "paragraphPlan": ["Описати результат та умови."], "claimRevisionIds": section["claimRevisionIds"],
         "targetWords": 100, "avoidRepeating": [], "transition": ""}
        for i, section in enumerate(e["outline"]["sections"])]}


def synthetic_prose(prefix="Результат залежить від умов.", words=100, suffix=""):
    """Length-controlled editorial prose for synthetic, provider-free tests."""
    explanation = ("Читачеві потрібне чітке пояснення змісту. Кожен абзац розвиває основну думку та допомагає зрозуміти її межі. "
                   "Точне формулювання зберігає умови твердження. Переходи пов’язують частини тексту без зайвих обіцянок. "
                   "Редактор перевіряє послідовність викладу та доречність слів. Прості речення полегшують читання. "
                   "Висновок спирається на наведене пояснення. Зміст залишається доступним без додаткових припущень.").split()
    leading, ending = prefix.split(), suffix.split()
    remaining = words - len(leading) - len(ending)
    if remaining < 0:
        raise ValueError("Synthetic prefix exceeds requested test length")
    body = (explanation * ((remaining + len(explanation) - 1) // len(explanation)))[:remaining]
    return " ".join(leading + body + ending)


def block(sid="s1", factual=True, value=None, bid=None):
    value = synthetic_prose() if value is None else value
    span = {"text": value}
    if factual:
        span.update(claimRevisionId=CLAIM, evidenceId=EVIDENCE)
    return {"id": bid or sid + "-b1", "type": "paragraph", "spans": [span]}


def review(s, scope, issues=None, resolved=None):
    result = {"versionHash": rt.version(s, scope), "issues": issues or []}
    if resolved is not None:
        result["resolvedIssueIds"] = resolved
    return result


def issue(sid="s1", severity="major", iid="i1", quote="Результат", bid=None):
    return {"id": iid, "severity": severity, "category": "readability", "sectionId": sid,
            "blockId": bid or sid + "-b1", "quote": quote,
            "instruction": "Уточнити формулювання.", "acceptance": "Умову збережено, формулювання ясне."}


class RuntimeTests(unittest.TestCase):
    def test_no_progress_patch_returns_human_blocker_without_accepting_or_losing_text(self):
        for scope in ("section", "global"):
            with self.subTest(scope=scope):
                e, s = self.article(False) if scope == "global" else self.ready_plan(fixture(False))
                if scope == "global":
                    s = self.global_reviews(e, s, [issue()])["state"]
                else:
                    s = self.draft(e, s)
                    s = self.invoke("section_review", e, s, review(s, "section", [issue()]))["state"]
                before = copy.deepcopy(s["sections"])
                patch = {"versionHash": rt.version(s, scope), "replacements": [
                    {"sectionId": "s1", "blockId": "s1-b1", "block": before["s1"][0]}]}
                result = self.invoke("patch" if scope == "global" else "section_patch", e, s, patch)
                self.assertEqual(result["done"], 1)
                self.assertEqual(result["state"]["sections"], before)
                final = self.invoke("finalize", e, result["state"])
                self.assertIsNone(final["article_json"])
                self.assertEqual(final["editorial_report"]["reasons"], ["EDITOR_NO_PROGRESS"])

    def test_patch_targets_expose_exact_legal_blocks_without_allowing_neighbours(self):
        e, s = self.article(False, 2)
        s = self.global_reviews(e, s, [issue()])["state"]
        request = rt.article_request(e, s)
        self.assertEqual(request["allowedPatchTargets"], [{"sectionId": "s1", "blockId": "s1-b1"}])
        bad = {"versionHash": rt.version(s, "global"), "replacements": [
            {"sectionId": "s2", "blockId": "s2-b1", "block": block("s2", False)}]}
        with self.assertRaisesRegex(ValueError, "PATCH_LOCATOR"):
            self.invoke("patch", e, s, bad)

    def test_unmapped_space_connectors_are_preserved_without_empty_or_fake_evidence(self):
        e, s = self.ready_plan()
        b = block(value="Результат")
        b["spans"] += [{"text": " ", "claimRevisionId": "", "evidenceId": ""},
                       {"text": "залежить від умов.", "claimRevisionId": CLAIM, "evidenceId": EVIDENCE}]
        accepted = self.draft(e, s, [b])
        self.assertEqual(rt.block_text(accepted["sections"]["s1"][0]), "Результат залежить від умов.")
        self.assertEqual(accepted["sections"]["s1"][0]["spans"][1], {"text": " "})
        for invalid, error in (("", "TEXT_SHAPE"), ("\x00", "TEXT_CONTROL")):
            b["spans"][1]["text"] = invalid
            with self.assertRaisesRegex(ValueError, error):
                self.draft(e, s, [b])
        b["spans"] = [{"text": " ", "claimRevisionId": CLAIM, "evidenceId": EVIDENCE}]
        with self.assertRaisesRegex(ValueError, "SPAN_REFERENCE"):
            self.draft(e, s, [b])
        b["spans"] = [{"text": " ", "claimRevisionId": "", "evidenceId": ""}]
        with self.assertRaisesRegex(ValueError, "EMPTY_BLOCK"):
            self.draft(e, s, [b])

    def test_valid_short_bookend_plans_preserve_structure_and_generate_body_first(self):
        for roles in (["introduction"], ["conclusion"], ["introduction", "conclusion"]):
            with self.subTest(roles=roles):
                e = fixture(False, len(roles))
                original = copy.deepcopy(e)
                e, s = self.ready_plan(e, roles)
                self.assertEqual(e, original)
                self.assertEqual(s["plan"]["sections"][0]["role"], "body")
                self.assertEqual(s["order"], ["s" + str(i + 1) for i in range(len(roles))])

    def test_final_length_guard_rejects_false_model_pass_and_accepts_exact_boundaries(self):
        for words, expected in ((64, "needs_human"), (65, "ready"), (135, "ready"), (136, "needs_human")):
            with self.subTest(words=words):
                e, s = self.article(False)
                s["sections"]["s1"][0]["spans"][0]["text"] = synthetic_prose(words=words)
                s = self.global_reviews(e, s)["state"]
                final = self.invoke("finalize", e, s)
                self.assertEqual(final["status"], expected)
                self.assertEqual(final["editorial_report"]["metrics"]["wordCount"], words)
                if expected == "needs_human":
                    self.assertIsNone(final["article_json"])
                    self.assertEqual(final["editorial_report"]["reasons"], ["ARTICLE_LENGTH_OUT_OF_RANGE"])
                    self.assertIsNone(s["bestArticle"])

    def test_plan_array_limits_remain_hard_guards_without_native_maxitems(self):
        e = fixture(False)
        s = self.invoke("prepare", e)["state"]
        for field in ("paragraphPlan", "avoidRepeating"):
            with self.subTest(field=field):
                p = plan(e)
                p["sections"][0][field] = ["Пункт " + str(i) for i in range(12)]
                self.invoke("plan", e, s, p)
                p["sections"][0][field].append("Надлишковий пункт")
                with self.assertRaisesRegex(ValueError, "ARRAY_SHAPE"):
                    self.invoke("plan", e, s, p)
        p = plan(e)
        p["terminology"] = [{"term": "Термін " + str(i), "definition": "Пояснення."} for i in range(50)]
        self.invoke("plan", e, s, p)
        p["terminology"].append({"term": "Надлишковий термін", "definition": "Пояснення."})
        with self.assertRaisesRegex(ValueError, "ARRAY_SHAPE"):
            self.invoke("plan", e, s, p)
        p = {"status": "needs_human", "reasons": ["Причина " + str(i) for i in range(10)]}
        self.assertEqual(self.invoke("plan", e, s, p)["status"], "needs_human")
        p["reasons"].append("Надлишкова причина")
        with self.assertRaisesRegex(ValueError, "ARRAY_SHAPE"):
            self.invoke("plan", e, s, p)

    def test_plan_section_limit_survives_native_schema_relaxation(self):
        e = fixture(False, 30)
        s = self.invoke("prepare", e)["state"]
        p = plan(e)
        self.invoke("plan", e, s, p)
        p["sections"].append(copy.deepcopy(p["sections"][-1]))
        with self.assertRaisesRegex(ValueError, "ARRAY_SHAPE"):
            self.invoke("plan", e, s, p)

    def test_section_and_span_maxima_accept_boundary_and_reject_overflow(self):
        e, s = self.ready_plan(fixture(False))
        values = [block(factual=False, bid="s1-b" + str(i + 1)) for i in range(60)]
        accepted = self.draft(e, s, values)
        self.assertEqual(len(accepted["sections"]["s1"]), 60)
        values.append(block(factual=False, bid="s1-b61"))
        with self.assertRaisesRegex(ValueError, "ARRAY_SHAPE"):
            self.draft(e, s, values)
        b = block(factual=False)
        b["spans"] = [{"text": "Текст " + str(i)} for i in range(40)]
        self.draft(e, s, [b])
        b["spans"].append({"text": "Надлишковий текст"})
        with self.assertRaisesRegex(ValueError, "ARRAY_SHAPE"):
            self.draft(e, s, [b])

    def test_patch_replacement_limit_rejects_61_valid_flagged_blocks_atomically(self):
        e, s = self.ready_plan(fixture(False, 2))
        for count in (31, 30):
            sid = rt.active_id(s)
            s = self.draft(e, s, [block(sid, False, bid=sid + "-b" + str(i + 1)) for i in range(count)])
            s = self.invoke("section_review", e, s, review(s, "section"))["state"]
            s = self.invoke("advance", e, s)["state"]
        all_issues = [issue(sid=sid, bid=b["id"], iid="i" + str(i), severity="minor")
                      for i, (sid, b) in enumerate((sid, b) for sid, rows in s["sections"].items() for b in rows)]
        for scope, issues in (("global", all_issues[:40]), ("language", all_issues[40:]), ("factual", [])):
            s = self.invoke("review", e, s, review(s, scope, issues), scope)["state"]
        s = self.invoke("decision", e, s)["state"]
        patches = [{"sectionId": sid, "blockId": b["id"],
                    "block": block(sid, False, value="Оновлене формулювання.", bid=b["id"])}
                   for sid, rows in s["sections"].items() for b in rows]
        raw = {"versionHash": rt.version(s, "global"), "replacements": patches[:60]}
        self.assertEqual(self.invoke("patch", e, s, raw)["state"]["globalRounds"], 1)
        original = copy.deepcopy(s)
        raw["replacements"] = patches
        with self.assertRaisesRegex(ValueError, "ARRAY_SHAPE"):
            self.invoke("patch", e, s, raw)
        self.assertEqual(s, original)

    def test_review_array_maxima_reject_excess_before_deduplication(self):
        e, s = self.ready_plan()
        s = self.draft(e, s)
        issues = [issue(iid="i" + str(i), quote="Результат", severity="minor") for i in range(40)]
        self.invoke("section_review", e, s, review(s, "section", issues))
        issues.append(issue(iid="i40"))
        with self.assertRaisesRegex(ValueError, "ARRAY_SHAPE"):
            self.invoke("section_review", e, s, review(s, "section", issues))
        raw = review(s, "section", resolved=["unknown"] * 101)
        with self.assertRaisesRegex(ValueError, "ARRAY_SHAPE"):
            self.invoke("section_review", e, s, raw)

    def test_plan_terminology_matches_structured_schema_and_normalizes_short_bookend(self):
        e = fixture(False)
        s = self.invoke("prepare", e)["state"]
        p = plan(e)
        accepted = self.invoke("plan", e, s, p)
        self.assertEqual(accepted["state"]["plan"]["terminology"], p["terminology"])
        self.assertIn("s1", accepted["request"]["serializedSections"])
        p["terminology"] = ["invalid string entry"]
        with self.assertRaisesRegex(ValueError, "OBJECT_SHAPE"):
            self.invoke("plan", e, s, p)
        p = plan(e, ["introduction"])
        accepted = self.invoke("plan", e, s, p)
        self.assertEqual(accepted["state"]["plan"]["sections"][0]["role"], "body")

    def test_global_cosmetic_regression_can_restore_fully_reviewed_valid_version(self):
        e, s = self.article()
        original = copy.deepcopy(s["sections"])
        s = self.global_reviews(e, s, [issue(severity="minor")])["state"]
        for number in (1, 2):
            patch = {"versionHash": rt.version(s, "global"), "replacements": [
                {"sectionId": "s1", "blockId": "s1-b1", "block": block(value="Результат погіршено " + str(number) + ".")}]}
            s = self.invoke("patch", e, s, patch)["state"]
            s = self.global_reviews(e, s, [issue(quote="Результат", severity="major")])["state"]
        self.assertEqual(s["sections"], original)
        final = self.invoke("finalize", e, s)
        self.assertEqual(final["status"], "ready")
        self.assertTrue(final["editorial_report"]["restoredEarlierVersion"])

    def test_local_review_cannot_request_edits_to_frozen_headings(self):
        e, s = self.ready_plan()
        s = self.draft(e, s)
        with self.assertRaisesRegex(ValueError, "ISSUE_LOCATOR"):
            self.invoke("section_review", e, s, review(s, "section", [issue(bid="heading", quote="Розділ")]))
    def invoke(self, op, e, s=None, raw=None, scope=None):
        p = {"editorial_json": rt.dumps(e)}
        if s is not None:
            p["state_json"] = rt.dumps(s)
        if raw is not None:
            p["raw"] = rt.dumps(raw)
        if scope is not None:
            p["scope"] = scope
        return json.loads(rt.main(op, rt.dumps(p))["result_json"])

    def ready_plan(self, e=None, roles=None):
        e = e or fixture()
        s = self.invoke("prepare", e)["state"]
        s = self.invoke("plan", e, s, plan(e, roles))["state"]
        s = self.invoke("plan_review", e, s, review(s, "plan"))["state"]
        return e, s

    def draft(self, e, s, values=None):
        sid = rt.active_id(s)
        raw = {"sectionId": sid, "blocks": values or [block(sid, e["contentMode"] == "FACTUAL")]}
        return self.invoke("section_draft", e, s, raw)["state"]

    def article(self, factual=True, count=1, roles=None):
        e, s = self.ready_plan(fixture(factual, count), roles)
        for _ in range(count):
            s = self.draft(e, s)
            s = self.invoke("section_review", e, s, review(s, "section"))["state"]
            s = self.invoke("advance", e, s)["state"]
        return e, s

    def global_reviews(self, e, s, issues=None, resolved=None):
        for scope in rt.SCOPES:
            s = self.invoke("review", e, s, review(s, scope, issues if scope == "global" else [], resolved), scope)["state"]
        return self.invoke("decision", e, s)

    def test_complete_factual_output_has_exact_quote_and_requires_human_approval(self):
        e, s = self.article()
        result = self.global_reviews(e, s)
        self.assertEqual(result["done"], 1)
        final = self.invoke("finalize", e, result["state"])
        self.assertEqual(final["status"], "ready")
        self.assertTrue(final["editorial_report"]["humanApprovalRequired"])
        doc = final["article_json"]["content"]["document"]
        evidence = doc["content"][1]["content"][0]
        self.assertEqual(evidence["text"], evidence["marks"][0]["attrs"]["quote"])
        self.assertEqual(final["article_json"]["content"]["title"], e["outline"]["title"])

    def test_creative_output_has_no_evidence(self):
        e, s = self.article(False)
        s = self.global_reviews(e, s)["state"]
        final = self.invoke("finalize", e, s)
        self.assertEqual(final["status"], "ready")
        self.assertNotIn('"evidence"', rt.dumps(final["article_json"]))

    def test_changed_frozen_context_is_rejected_without_private_excerpt(self):
        e, s = self.ready_plan()
        e["brief"]["topic"] = "PRIVATE_SENTINEL"
        with self.assertRaisesRegex(ValueError, "FROZEN_CONTEXT_CHANGED") as error:
            self.invoke("section_request", e, s)
        self.assertNotIn("PRIVATE_SENTINEL", str(error.exception))

    def test_duplicate_json_keys_rejected(self):
        with self.assertRaisesRegex(ValueError, "DUPLICATE_KEY"):
            rt.main("prepare", '{"editorial":null,"editorial":null}')

    def test_malformed_json_and_nan_rejected(self):
        for raw in ("{", '{"value":NaN}'):
            with self.assertRaises(ValueError):
                rt.main("prepare", raw)

    def test_missing_required_claim_is_rejected_at_input(self):
        e = fixture()
        e["brief"]["requiredClaimRevisionIds"] = [SNAPSHOT]
        with self.assertRaisesRegex(ValueError, "REQUIRED_REFERENCE"):
            self.invoke("prepare", e)

    def test_unknown_outline_reference_is_rejected(self):
        e = fixture()
        e["outline"]["sections"][0]["claimRevisionIds"] = [SNAPSHOT]
        with self.assertRaisesRegex(ValueError, "OUTLINE_REFERENCE"):
            self.invoke("prepare", e)

    def test_creative_cannot_carry_factual_ids(self):
        e = fixture()
        e["contentMode"] = "CREATIVE"
        with self.assertRaisesRegex(ValueError, "CREATIVE_EVIDENCE"):
            self.invoke("prepare", e)

    def test_plan_preserves_frozen_structure_and_claims(self):
        e = fixture()
        s = self.invoke("prepare", e)["state"]
        p = plan(e)
        p["sections"][0]["sectionId"] = "s2"
        with self.assertRaisesRegex(ValueError, "PLAN_SECTION"):
            self.invoke("plan", e, s, p)
        p = plan(e)
        p["sections"][0]["claimRevisionIds"] = []
        with self.assertRaisesRegex(ValueError, "PLAN_CLAIMS"):
            self.invoke("plan", e, s, p)

    def test_plan_refuses_missing_required_claim_and_bad_length(self):
        e = fixture()
        e["outline"]["sections"][0]["claimRevisionIds"] = []
        s = self.invoke("prepare", e)["state"]
        p = plan(e)
        with self.assertRaisesRegex(ValueError, "PLAN_REQUIRED_CLAIMS"):
            self.invoke("plan", e, s, p)
        p["sections"][0]["claimRevisionIds"] = [CLAIM]
        p["sections"][0]["targetWords"] = 999
        with self.assertRaisesRegex(ValueError, "PLAN_LENGTH"):
            self.invoke("plan", e, s, p)

    def test_insufficient_evidence_is_terminal_without_article(self):
        e = fixture()
        s = self.invoke("prepare", e)["state"]
        result = self.invoke("plan", e, s, {"status": "insufficient_evidence", "reasons": ["Немає даних для порівняння."]})
        self.assertEqual(result["done"], 1)
        final = self.invoke("finalize", e, result["state"])
        self.assertIsNone(final["article_json"])
        self.assertEqual(final["status"], "insufficient_evidence")

    def test_plan_review_limit_and_anchor(self):
        e = fixture()
        s = self.invoke("prepare", e)["state"]
        s = self.invoke("plan", e, s, plan(e))["state"]
        feedback = issue(bid="plan", quote="Від умов.")
        first = self.invoke("plan_review", e, s, review(s, "plan", [feedback]))
        self.assertEqual(first["done"], 0)
        s = self.invoke("plan", e, first["state"], plan(e))["state"]
        second = self.invoke("plan_review", e, s, review(s, "plan", [feedback]))
        self.assertEqual(second["status"], "needs_human")

    def test_body_generated_before_bookends_but_frozen_order_restored(self):
        e, s = self.ready_plan(fixture(True, 3), ["introduction", "body", "conclusion"])
        self.assertEqual(s["order"], ["s2", "s1", "s3"])
        for expected in s["order"]:
            self.assertEqual(rt.active_id(s), expected)
            s = self.draft(e, s)
            s = self.invoke("section_review", e, s, review(s, "section"))["state"]
            s = self.invoke("advance", e, s)["state"]
        doc = rt.compile_article(e, s)["content"]["document"]["content"]
        headings = [n["content"][0]["text"] for n in doc if n["type"] == "heading"]
        self.assertEqual(headings, ["Розділ 1", "Розділ 2", "Розділ 3"])
        self.assertEqual(s["memory"][0]["usedClaims"], [CLAIM])

    def test_section_cannot_drop_assigned_claims(self):
        e, s = self.ready_plan()
        with self.assertRaisesRegex(ValueError, "SECTION_COVERAGE"):
            self.draft(e, s, [block(factual=False)])

    def test_evidence_must_match_its_claim_and_mode(self):
        e, s = self.ready_plan()
        bad = block()
        bad["spans"][0]["evidenceId"] = SNAPSHOT
        with self.assertRaisesRegex(ValueError, "SPAN_REFERENCE"):
            self.draft(e, s, [bad])
        e, s = self.ready_plan(fixture(False))
        with self.assertRaisesRegex(ValueError, "SPAN_REFERENCE"):
            self.draft(e, s, [block()])

    def test_review_locator_anchor_and_version_are_checked(self):
        e, s = self.ready_plan()
        s = self.draft(e, s)
        for feedback, code in ((issue(bid="s1-b9"), "ISSUE_LOCATOR"), (issue(quote="not in text"), "ISSUE_ANCHOR")):
            with self.assertRaisesRegex(ValueError, code):
                self.invoke("section_review", e, s, review(s, "section", [feedback]))
        bad = review(s, "section")
        bad["versionHash"] = "0" * 64
        with self.assertRaisesRegex(ValueError, "STALE_REVIEW"):
            self.invoke("section_review", e, s, bad)

    def test_patch_preserves_ids_claims_and_old_state(self):
        e, s = self.ready_plan()
        s = self.draft(e, s)
        s = self.invoke("section_review", e, s, review(s, "section", [issue()]))["state"]
        original = copy.deepcopy(s)
        patch = {"versionHash": rt.version(s, "section"), "replacements": [
            {"sectionId": "s1", "blockId": "s1-b1", "block": block(factual=False)}]}
        with self.assertRaisesRegex(ValueError, "PATCH_COVERAGE_REGRESSION"):
            self.invoke("section_patch", e, s, patch)
        self.assertEqual(s, original)
        patch["replacements"][0]["block"] = block(value=synthetic_prose("За певних умов результат змінюється."))
        changed = self.invoke("section_patch", e, s, patch)["state"]
        self.assertNotEqual(rt.version(changed, "section"), rt.version(s, "section"))
        self.assertEqual(changed["sectionRounds"], 1)
        with self.assertRaisesRegex(ValueError, "STALE_PATCH"):
            self.invoke("section_patch", e, changed, patch)

    def test_patch_cannot_touch_unflagged_block(self):
        e, s = self.ready_plan()
        s = self.draft(e, s, [block(), block(bid="s1-b2")])
        s = self.invoke("section_review", e, s, review(s, "section", [issue()]))["state"]
        patch = {"versionHash": rt.version(s, "section"), "replacements": [
            {"sectionId": "s1", "blockId": "s1-b2", "block": block(value="Інший текст.", bid="s1-b2")}]}
        with self.assertRaisesRegex(ValueError, "PATCH_LOCATOR"):
            self.invoke("section_patch", e, s, patch)

    def test_two_round_limit_retains_best_valid_version_and_archives_blocker(self):
        e, s = self.ready_plan()
        s = self.draft(e, s)
        initial = copy.deepcopy(s["sections"])
        s = self.invoke("section_review", e, s, review(s, "section", [issue()]))["state"]
        waiting = self.invoke("advance", e, s)
        self.assertEqual(waiting["state"]["cursor"], 0)
        for number in (1, 2):
            patch = {"versionHash": rt.version(s, "section"), "replacements": [
                {"sectionId": "s1", "blockId": "s1-b1", "block": block(value="Результат залежить від умов " + str(number) + ".")}]}
            s = self.invoke("section_patch", e, s, patch)["state"]
            s = self.invoke("section_review", e, s, review(s, "section", [issue(severity="critical")]))["state"]
        result = self.invoke("advance", e, s)
        s = result["state"]
        self.assertEqual(s["sections"], initial)
        self.assertTrue(s["localBlockers"][0]["id"].startswith("local-"))
        self.assertEqual(s["status"], "running")
        result = self.global_reviews(e, s)
        self.assertEqual(result["status"], "needs_human")
        self.assertIsNone(self.invoke("finalize", e, result["state"])["article_json"])

    def test_minor_feedback_triggers_global_patch_and_all_reviews_are_invalidated(self):
        e, s = self.article()
        result = self.global_reviews(e, s, [issue(severity="minor")])
        self.assertEqual(result["done"], 0)
        s = result["state"]
        patch = {"versionHash": rt.version(s, "global"), "replacements": [
            {"sectionId": "s1", "blockId": "s1-b1", "block": block(value=synthetic_prose("За цих умов результат може змінитися."))}]}
        s = self.invoke("patch", e, s, patch)["state"]
        self.assertEqual(s["reviews"], {})
        final = self.invoke("finalize", e, s)
        self.assertEqual(final["status"], "needs_human")
        self.assertIsNone(final["article_json"])
        s = self.global_reviews(e, s)["state"]
        self.assertEqual(self.invoke("finalize", e, s)["status"], "ready")

    def test_final_requires_all_three_current_reviews(self):
        e, s = self.article()
        s = self.invoke("review", e, s, review(s, "global"), "global")["state"]
        with self.assertRaisesRegex(ValueError, "INCOMPLETE_GLOBAL_REVIEW"):
            self.invoke("decision", e, s)
        final = self.invoke("finalize", e, s)
        self.assertIsNone(final["article_json"])

    def test_closure_must_reference_archived_issue(self):
        e, s = self.article()
        with self.assertRaisesRegex(ValueError, "ISSUE_CLOSURE_REFERENCE"):
            self.invoke("review", e, s, review(s, "global", resolved=["unknown"]), "global")

    def test_exact_adjacent_same_mapping_spans_are_coalesced(self):
        e, s = self.ready_plan()
        b = block()
        b["spans"] = [copy.deepcopy(b["spans"][0]), copy.deepcopy(b["spans"][0])]
        s = self.draft(e, s, [b])
        s = self.invoke("section_review", e, s, review(s, "section"))["state"]
        s = self.invoke("advance", e, s)["state"]
        article = rt.compile_article(e, s)
        children = article["content"]["document"]["content"][1]["content"]
        self.assertEqual(len(children), 1)
        self.assertEqual(children[0]["text"], children[0]["marks"][0]["attrs"]["quote"])

    def test_compilation_groups_lists_and_uses_valid_containers(self):
        e, s = self.ready_plan(fixture(False))
        values = []
        for number, kind in enumerate(("bullet", "bullet", "ordered", "blockquote", "heading", "paragraph"), 1):
            b = block(factual=False, bid="s1-b" + str(number))
            b["type"] = kind
            if kind == "heading":
                b["level"] = 3
            values.append(b)
        s = self.draft(e, s, values)
        s = self.invoke("section_review", e, s, review(s, "section"))["state"]
        s = self.invoke("advance", e, s)["state"]
        doc = rt.compile_article(e, s)["content"]["document"]
        self.assertEqual(doc["content"][1]["type"], "bulletList")
        self.assertEqual(len(doc["content"][1]["content"]), 2)
        self.assertEqual(doc["content"][1]["content"][0]["content"][0]["type"], "paragraph")

    def test_budget_exhaustion_is_terminal(self):
        e, s = self.ready_plan()
        s["calls"] = rt.MAX_CALLS
        result = self.invoke("section_draft", e, s, {"sectionId": "s1", "blocks": [block()]})
        self.assertEqual(result["status"], "needs_human")
        self.assertEqual(result["state"]["calls"], rt.MAX_CALLS)
        self.assertIsNone(self.invoke("finalize", e, result["state"])["article_json"])

    def test_empty_reference_pair_from_schema_is_normalized(self):
        e, s = self.ready_plan(fixture(False))
        b = block(factual=False)
        b["spans"][0].update(claimRevisionId="", evidenceId="")
        s = self.draft(e, s, [b])
        self.assertEqual(s["sections"]["s1"][0]["spans"][0], {"text": b["spans"][0]["text"]})
        e, s = self.ready_plan()
        b = block()
        b["spans"][0]["evidenceId"] = ""
        with self.assertRaisesRegex(ValueError, "SPAN_REFERENCE"):
            self.draft(e, s, [b])

    def test_bookends_have_full_accepted_body(self):
        e, s = self.ready_plan(fixture(True, 3), ["introduction", "body", "conclusion"])
        s = self.draft(e, s)
        s = self.invoke("section_review", e, s, review(s, "section"))["state"]
        s = self.invoke("advance", e, s)["state"]
        request = self.invoke("section_request", e, s)["request"]
        self.assertEqual(request["section"]["role"], "introduction")
        self.assertEqual(request["acceptedSections"][0]["sectionId"], "s2")
        self.assertEqual(request["acceptedSections"][0]["blocks"], s["sections"]["s2"])

    def test_major_frozen_heading_problem_stops_without_patch(self):
        e, s = self.article()
        result = self.global_reviews(e, s, [issue(bid="heading", quote="Розділ")])
        self.assertEqual(result["done"], 1)
        self.assertEqual(result["status"], "needs_human")
        self.assertIsNone(self.invoke("finalize", e, result["state"])["article_json"])

    def test_title_locators_and_minor_readonly_feedback(self):
        e, s = self.article()
        result = self.global_reviews(e, s, [issue(bid="title", quote="Тестова", severity="minor")])
        self.assertEqual(result["done"], 1)
        final = self.invoke("finalize", e, result["state"])
        self.assertEqual(final["status"], "ready")
        self.assertEqual(final["article_json"]["content"]["title"], "Тестова стаття")
        self.assertEqual(final["editorial_report"]["unresolvedIssues"][0]["blockId"], "title")

    def test_doc_evidence_span_limit(self):
        e, s = self.article(True, 2)
        for sid in s["sections"]:
            s["sections"][sid] = [block(sid, bid=sid + "-b" + str(i + 1)) for i in range(101)]
        with self.assertRaisesRegex(ValueError, "ARTICLE_LIMITS"):
            rt.compile_article(e, s)


if __name__ == "__main__":
    unittest.main()
