"""Synthetic offline tests for the Telegram workflow controller."""
import copy
import hashlib
import json
import unittest
import uuid

import telegram_generation_runtime as rt

CLAIM = "00000000-0000-4000-8000-000000000001"
EVIDENCE = "00000000-0000-4000-8000-000000000002"
SNAPSHOT = "00000000-0000-4000-8000-000000000003"
ARTICLE = "00000000-0000-4000-8000-000000000004"


def sha(value):
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def fixture(content_mode="FACTUAL", input_mode="DIRECT", include_link=False):
    source = "Вимірювання підтвердило зміну показника."
    value = {"schemaVersion": "telegram-context-v1", "inputMode": input_mode,
        "contentMode": content_mode, "includeLink": include_link,
        "brief": {"topic": "Показник", "audience": "Читачі", "centralMessage": "Зміна підтверджена.",
            "category": "освітній", "requiredClaimRevisionIds": [CLAIM] if content_mode == "FACTUAL" else []},
        "style": {"brandbook": "", "tone": "Проста мова", "settings": {}},
        "claims": ([{"claimRevisionId": CLAIM, "wording": "Показник змінився у вимірюванні.",
            "evidence": [{"evidenceId": EVIDENCE, "quote": source, "snapshotId": SNAPSHOT}]}]
            if content_mode == "FACTUAL" else []),
        "context": [{"snapshotId": SNAPSHOT, "purpose": "EVIDENCE", "sha256": sha(source), "text": source}],
        "article": None}
    if input_mode == "ARTICLE_DERIVED":
        article_text = "У погодженому тексті описано зміну показника."
        value["article"] = {"versionId": ARTICLE, "sha256": "a" * 64, "text": article_text}
    return value


def draft(text_value="📊 Показник змінився у вимірюванні.", *, factual=True):
    return {"paragraphs": [{"segments": [{"text": text_value,
        "claimRevisionId": CLAIM if factual else "", "evidenceId": EVIDENCE if factual else ""}]}]}


def invoke(operation, *, editorial=None, state=None, raw=None):
    payload = {}
    if editorial is not None:
        payload["editorial_json"] = json.dumps(editorial, ensure_ascii=False)
    if state is not None:
        payload["state"] = state
    if raw is not None:
        payload["raw"] = json.dumps(raw, ensure_ascii=False) if not isinstance(raw, str) else raw
    return json.loads(rt.main(operation, json.dumps(payload, ensure_ascii=False)))["result"]


def ready_review():
    return {"status": "ready", "reasons": [], "issues": []}


class TelegramRuntimeTests(unittest.TestCase):
    def prepare(self, e):
        return invoke("prepare", editorial=e)

    def composed(self, e, raw=None):
        state = self.prepare(e)["state"]
        return invoke("draft", editorial=e, state=state, raw=raw or draft())

    def test_prepare_enforces_modes_hashes_and_required_claims(self):
        e = fixture()
        self.assertEqual(self.prepare(e)["state"]["status"], "running")
        bad = copy.deepcopy(e)
        bad["context"][0]["sha256"] = "0" * 64
        with self.assertRaisesRegex(ValueError, "CONTEXT_HASH"):
            self.prepare(bad)
        bad = copy.deepcopy(e)
        bad["brief"]["requiredClaimRevisionIds"] = [str(uuid.uuid4())]
        with self.assertRaisesRegex(ValueError, "REQUIRED_REFERENCE"):
            self.prepare(bad)
        creative = fixture("CREATIVE")
        creative["claims"] = [copy.deepcopy(e["claims"][0])]
        with self.assertRaisesRegex(ValueError, "CREATIVE_EVIDENCE"):
            self.prepare(creative)
        bad = fixture("FACTUAL", "ARTICLE_DERIVED")
        bad["article"]["sha256"] = "f" * 63
        with self.assertRaisesRegex(ValueError, "ARTICLE_HASH"):
            self.prepare(bad)

    def test_utf16_mappings_are_derived_and_link_is_appended_safely(self):
        e = fixture(include_link=True)
        result = self.composed(e)
        state = result["state"]
        output = rt.candidate_output(state["paragraphs"], rt.validate_input(e))
        content = output["content"]
        quote = "📊 Показник змінився у вимірюванні."
        self.assertEqual(content["text"], quote + "\n\n[ПОСИЛАННЯ]")
        mapping = content["mappings"][0]
        self.assertEqual(mapping["quote"], quote)
        self.assertEqual(mapping["startOffset"], 0)
        self.assertEqual(mapping["endOffset"], len(quote.encode("utf-16-le")) // 2)
        self.assertEqual(mapping["endOffset"], len(quote) + 1)
        self.assertEqual(mapping["claimRevisionId"], CLAIM)

    def test_factual_references_and_coverage_are_exact(self):
        e = fixture()
        bad = draft()
        bad["paragraphs"][0]["segments"][0]["evidenceId"] = SNAPSHOT
        invalid = self.composed(e, bad)
        self.assertEqual(invalid["state"]["status"], "needs_human")
        self.assertEqual(invalid["state"]["validation"]["candidateValidationError"], "EVIDENCE_REFERENCE")
        bad = draft()
        bad["paragraphs"][0]["segments"][0]["claimRevisionId"] = str(uuid.uuid4())
        invalid = self.composed(e, bad)
        self.assertEqual(invalid["state"]["validation"]["candidateValidationError"], "EVIDENCE_REFERENCE")

        second_claim, second_evidence = "00000000-0000-4000-8000-000000000005", "00000000-0000-4000-8000-000000000006"
        e["brief"]["requiredClaimRevisionIds"].append(second_claim)
        e["claims"].append({"claimRevisionId": second_claim, "wording": "Додаткова обов’язкова умова.",
            "evidence": [{"evidenceId": second_evidence, "quote": "Точний текст умови.", "snapshotId": SNAPSHOT}]})
        state = self.composed(e)["state"]
        state.update({"review": ready_review(), "reviewCount": 1, "status": "ready"})
        final = invoke("finalize", editorial=e, state=state)
        self.assertEqual(final["telegram_json"], "")
        report = json.loads(final["telegram_report"])
        self.assertEqual(report["status"], "needs_human")
        self.assertEqual(report["validation"]["finalValidationError"], "REQUIRED_CLAIM_COVERAGE")

    def test_creative_output_has_no_mappings_and_is_marked_unverified(self):
        e = fixture("CREATIVE")
        result = self.composed(e, draft("Уявна історія про новий погляд.", factual=False))
        output = rt.candidate_output(result["state"]["paragraphs"], rt.validate_input(e))
        self.assertEqual(output["content"]["mappings"], [])
        final_state = result["state"]
        final_state.update({"review": ready_review(), "reviewCount": 1, "status": "ready"})
        completed = invoke("finalize", editorial=e, state=final_state)
        report = json.loads(completed["telegram_report"])
        self.assertTrue(report["validation"]["creativeUnverified"])

    def test_one_targeted_repair_then_independent_rereview(self):
        e = fixture()
        state = self.composed(e)["state"]
        quote = rt.paragraph_text(state["paragraphs"][0])
        finding = {"status": "needs_human", "reasons": ["Уточніть твердження."], "issues": [
            {"severity": "major", "category": "accuracy", "paragraphId": "p1", "quote": quote,
             "instruction": "Звірте фразу з дозволеним формулюванням."}]}
        first = invoke("review", editorial=e, state=state, raw=finding)
        self.assertEqual(first["repair_required"], 1)
        patch = {"replacements": [{"paragraphId": "p1", "segments": [{"text": "📊 Вимірювання підтвердило зміну показника.",
            "claimRevisionId": CLAIM, "evidenceId": EVIDENCE}]}]}
        patched = invoke("patch", editorial=e, state=first["state"], raw=patch)["state"]
        self.assertEqual(patched["repairCount"], 1)
        second = invoke("review", editorial=e, state=patched, raw=ready_review())
        self.assertEqual(second["state"]["status"], "ready")
        final = invoke("finalize", editorial=e, state=second["state"])
        output = json.loads(final["telegram_json"])
        report = json.loads(final["telegram_report"])
        self.assertEqual(report["status"], "ready")
        self.assertEqual(report["contentHash"], rt.digest_output(output))
        self.assertEqual(report["validation"]["repairCount"], 1)
        self.assertEqual(report["validation"]["reviewCount"], 2)

    def test_insufficient_and_unresolved_review_return_no_candidate(self):
        e = fixture()
        state = self.composed(e)["state"]
        blocked = invoke("review", editorial=e, state=state,
            raw={"status": "insufficient_evidence", "reasons": ["Не вистачає підтверджень."], "issues": []})
        self.assertEqual(blocked["repair_required"], 0)
        final = invoke("finalize", editorial=e, state=blocked["state"])
        self.assertEqual(final["telegram_json"], "")
        self.assertEqual(json.loads(final["telegram_report"])["status"], "insufficient_evidence")

        state = self.composed(e)["state"]
        quote = rt.paragraph_text(state["paragraphs"][0])
        first = invoke("review", editorial=e, state=state, raw={"status": "needs_human", "reasons": [], "issues": [
            {"severity": "critical", "category": "factual", "paragraphId": "p1", "quote": quote,
             "instruction": "Приберіть непідтверджене твердження."}]})
        failed_patch = invoke("patch", editorial=e, state=first["state"], raw={"replacements": [
            {"paragraphId": "p1", "segments": [{"text": "📊 Показник змінився у вимірюванні.",
                "claimRevisionId": CLAIM, "evidenceId": EVIDENCE}]},
            {"paragraphId": "p2", "segments": [{"text": "Зайве", "claimRevisionId": CLAIM, "evidenceId": EVIDENCE}]}]})
        self.assertEqual(failed_patch["state"]["status"], "needs_human")
        # The graph performs a second review stage; blocked state remains blocked.
        second = invoke("review", editorial=e, state=failed_patch["state"], raw=ready_review())
        final = invoke("finalize", editorial=e, state=second["state"])
        self.assertEqual(final["telegram_json"], "")
        self.assertEqual(json.loads(final["telegram_report"])["status"], "needs_human")

    def test_wrong_link_placeholder_and_utf16_overflow_are_rejected(self):
        e = fixture(include_link=False)
        result = self.composed(e, draft("Допомога: [ПОСИЛАННЯ]", factual=True))
        self.assertEqual(result["state"]["validation"]["candidateValidationError"], "UNREQUESTED_LINK_PLACEHOLDER")
        e = fixture("CREATIVE")
        too_long = "😀" * 2049
        result = self.composed(e, draft(too_long, factual=False))
        self.assertEqual(result["state"]["validation"]["candidateValidationError"], "OUTPUT_TEXT_LIMIT")

    def test_article_derived_factual_route_and_mode_mismatch(self):
        e = fixture(input_mode="ARTICLE_DERIVED")
        self.assertEqual(self.composed(e)["state"]["status"], "running")
        bad = copy.deepcopy(e)
        bad["article"] = None
        with self.assertRaisesRegex(ValueError, "INPUT_MODE"):
            self.prepare(bad)
        bad = fixture(input_mode="DIRECT")
        bad["article"] = {"versionId": ARTICLE, "sha256": "0" * 64, "text": "Текст"}
        with self.assertRaisesRegex(ValueError, "INPUT_MODE"):
            self.prepare(bad)


if __name__ == "__main__":
    unittest.main()
