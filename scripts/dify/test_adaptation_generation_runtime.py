"""Focused synthetic coverage for the shared M4.2 adaptation contract."""
import copy
import hashlib
import json
import unittest

import adaptation_generation_runtime as rt

CLAIM = "00000000-0000-4000-8000-000000000001"
EVIDENCE = "00000000-0000-4000-8000-000000000002"
SNAPSHOT = "00000000-0000-4000-8000-000000000003"
ARTICLE = "00000000-0000-4000-8000-000000000004"
FRAME_1 = "00000000-0000-4000-8000-000000000005"
FRAME_2 = "00000000-0000-4000-8000-000000000006"


def sha(value):
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def fixture(format_name="TELEGRAM_POST", content_mode="FACTUAL", input_mode="DIRECT", include_link=False):
    source = "Вимірювання підтвердило зміну показника."
    value = {"schemaVersion": "channel-context-v1", "format": format_name,
        "inputMode": input_mode, "contentMode": content_mode, "includeLink": include_link,
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


def model_draft(editorial, text_value="📊 Показник змінився у вимірюванні."):
    factual = editorial["contentMode"] == "FACTUAL"
    segments = [{"text": text_value, "claimRevisionId": CLAIM if factual else "",
                 "evidenceId": EVIDENCE if factual else ""}]
    paragraphs = [{"field": "text", "segments": segments}]
    cover_instruction = ""
    if editorial["format"] in rt.COVER_FORMATS:
        paragraphs.append({"field": "cover", "segments": [{"text": "Показник змінився",
            "claimRevisionId": CLAIM if factual else "", "evidenceId": EVIDENCE if factual else ""}]})
        cover_instruction = "Світлий фон, один виразний заголовок."
    result = {"paragraphs": paragraphs, "coverInstruction": cover_instruction}
    if editorial["format"] in rt.SCRIPT_FORMATS:
        frame_text = "Вимірювання підтвердило зміну показника."
        frame = {"purpose": "Пояснити зміну показника.",
            "segments": [{"text": frame_text, "claimRevisionId": CLAIM if factual else "",
                          "evidenceId": EVIDENCE if factual else ""}],
            "visualHint": "Один великий заголовок і простий графік.",
            "transition": "Плавно перейти до наступного кадру." if editorial["format"] == "INSTAGRAM_STORIES" else ""}
        result["script"] = {"frames": [dict(frame, id=FRAME_1), dict(frame, id=FRAME_2,
            purpose="Повторити ключовий факт.",
            transition="Завершити коротким підсумком." if editorial["format"] == "INSTAGRAM_STORIES" else "")]}
    return result


def invoke(operation, *, editorial=None, state=None, raw=None):
    payload = {}
    if editorial is not None:
        payload["editorial_json"] = json.dumps(editorial, ensure_ascii=False)
    if state is not None:
        payload["state"] = state
    if raw is not None:
        payload["raw"] = json.dumps(raw, ensure_ascii=False) if not isinstance(raw, str) else raw
    return json.loads(rt.main(operation, json.dumps(payload, ensure_ascii=False)))["result"]


class AdaptationRuntimeTests(unittest.TestCase):
    def test_all_formats_routes_and_modes_produce_the_shared_envelope(self):
        for format_name in sorted(rt.FORMATS):
            for content_mode in ("FACTUAL", "CREATIVE"):
                for input_mode in ("DIRECT", "ARTICLE_DERIVED"):
                    with self.subTest(format=format_name, mode=content_mode, route=input_mode):
                        e = fixture(format_name, content_mode, input_mode)
                        prepared = invoke("prepare", editorial=e)
                        self.assertEqual(prepared["request"]["format"], format_name)
                        drafted = invoke("draft", editorial=e, state=prepared["state"], raw=model_draft(e))
                        self.assertEqual(drafted["state"]["status"], "running")
                        reviewed = invoke("review", editorial=e, state=drafted["state"],
                            raw={"status": "ready", "reasons": [], "issues": []})
                        final = invoke("finalize", editorial=e, state=reviewed["state"])
                        candidate = json.loads(final["adaptation_json"])
                        report = json.loads(final["adaptation_report"])
                        self.assertEqual(report["status"], "ready")
                        self.assertEqual(candidate["schemaVersion"], "adaptation-v1")
                        self.assertEqual(candidate["format"], format_name)
                        self.assertEqual(bool(candidate["content"].get("cover")), format_name in rt.COVER_FORMATS)
                        self.assertEqual("script" in candidate, format_name in rt.SCRIPT_FORMATS)
                        if format_name in rt.SCRIPT_FORMATS:
                            frames = candidate["script"]["frames"]
                            self.assertEqual([frame["id"] for frame in frames], [FRAME_1, FRAME_2])
                            self.assertEqual(frames[0]["transition"], "Плавно перейти до наступного кадру."
                                if format_name == "INSTAGRAM_STORIES" else "")
                            if content_mode == "FACTUAL":
                                mapping = frames[0]["mappings"][0]
                                self.assertEqual(frames[0]["text"][mapping["startOffset"]:mapping["endOffset"]], mapping["quote"])
                                self.assertEqual(mapping["quote"], "Вимірювання підтвердило зміну показника.")
                            else:
                                self.assertEqual(frames[0]["mappings"], [])
                        self.assertEqual(report["contentHash"], rt.digest_output(candidate))
                        self.assertEqual(report["validation"]["creativeUnverified"], content_mode == "CREATIVE")
                        if format_name in rt.COVER_FORMATS and content_mode == "FACTUAL":
                            cover_maps = [m for m in candidate["content"]["mappings"] if m.get("field") == "cover"]
                            self.assertEqual(len(cover_maps), 1)
                            self.assertEqual(cover_maps[0]["quote"], "Показник змінився")

    def test_cover_repair_can_target_instruction_without_rewriting_publication(self):
        e = fixture("LINKEDIN_COVER")
        prepared = invoke("prepare", editorial=e)["state"]
        drafted = invoke("draft", editorial=e, state=prepared, raw=model_draft(e))["state"]
        body = drafted["paragraphs"][0]["segments"][0]["text"]
        cover = drafted["paragraphs"][1]["segments"][0]["text"]
        finding = {"status": "needs_human", "reasons": ["Уточніть макет."], "issues": [
            {"severity": "major", "category": "design", "paragraphId": "coverInstruction",
             "quote": drafted["coverInstruction"], "instruction": "Зробіть інструкцію компактнішою."}]}
        reviewed = invoke("review", editorial=e, state=drafted, raw=finding)
        self.assertEqual(reviewed["repair_required"], 1)
        patched = invoke("patch", editorial=e, state=reviewed["state"], raw={
            "replacements": [], "frameReplacements": [], "coverInstruction": "Теплий фон, великий заголовок."})
        self.assertEqual(patched["state"]["status"], "running")
        self.assertEqual(patched["state"]["paragraphs"][0]["segments"][0]["text"], body)
        self.assertEqual(patched["state"]["paragraphs"][1]["segments"][0]["text"], cover)
        second = invoke("review", editorial=e, state=patched["state"],
                        raw={"status": "ready", "reasons": [], "issues": []})
        final = invoke("finalize", editorial=e, state=second["state"])
        candidate = json.loads(final["adaptation_json"])
        self.assertEqual(candidate["content"]["cover"]["instruction"], "Теплий фон, великий заголовок.")

    def test_missing_factual_answer_blocks_candidate_and_nontelegram_link_is_rejected(self):
        e = fixture()
        e["brief"]["centralMessage"] = "З’ясувати, чи курс підвищив рівень знань."
        prepared = invoke("prepare", editorial=e)["state"]
        drafted = invoke("draft", editorial=e, state=prepared, raw=model_draft(e))["state"]
        blocked = invoke("review", editorial=e, state=drafted, raw={
            "status": "insufficient_evidence", "reasons": ["Дозволені факти не підтверджують ефективність курсу."], "issues": []})
        final = invoke("finalize", editorial=e, state=blocked["state"])
        self.assertEqual(final["adaptation_json"], "")
        self.assertEqual(json.loads(final["adaptation_report"])["status"], "insufficient_evidence")
        bad = copy.deepcopy(e)
        bad["format"] = "LINKEDIN_TEXT"
        bad["includeLink"] = True
        with self.assertRaisesRegex(ValueError, "LINK_OPTION_FORMAT"):
            rt.validate_input(bad)

    def test_invalid_cover_evidence_is_blocked_before_reviewer(self):
        e = fixture("INSTAGRAM_COVER")
        raw = model_draft(e)
        raw["paragraphs"][1]["segments"][0]["evidenceId"] = SNAPSHOT
        prepared = invoke("prepare", editorial=e)["state"]
        drafted = invoke("draft", editorial=e, state=prepared, raw=raw)
        self.assertEqual(drafted["state"]["status"], "needs_human")
        self.assertEqual(drafted["state"]["validation"]["candidateValidationError"], "EVIDENCE_REFERENCE")

        raw = model_draft(e)
        raw["coverInstruction"] = ""
        drafted = invoke("draft", editorial=e, state=prepared, raw=raw)
        self.assertEqual(drafted["state"]["status"], "needs_human")
        self.assertEqual(drafted["state"]["validation"]["candidateValidationError"], "TEXT_SHAPE")

    def test_script_frame_repair_is_scoped_and_preserves_stable_id(self):
        e = fixture("INSTAGRAM_STORIES")
        prepared = invoke("prepare", editorial=e)["state"]
        drafted = invoke("draft", editorial=e, state=prepared, raw=model_draft(e))["state"]
        original_caption = drafted["paragraphs"][0]["segments"][0]["text"]
        original_frame = drafted["scriptFrames"][0]
        target = "frame:" + FRAME_1
        reviewed = invoke("review", editorial=e, state=drafted, raw={"status": "needs_human", "reasons": [],
            "issues": [{"severity": "major", "category": "accuracy", "paragraphId": target,
                "quote": original_frame["segments"][0]["text"], "instruction": "Уточніть текст кадру."}]})
        patched = invoke("patch", editorial=e, state=reviewed["state"], raw={
            "replacements": [], "frameReplacements": [{"frameId": FRAME_1,
                "purpose": original_frame["purpose"],
                "segments": [{"text": "Вимірювання підтвердило зміну показника. Так.",
                    "claimRevisionId": CLAIM, "evidenceId": EVIDENCE}],
                "visualHint": original_frame["visualHint"], "transition": original_frame["transition"]}],
            "coverInstruction": ""})
        self.assertEqual(patched["state"]["scriptFrames"][0]["id"], FRAME_1)
        self.assertEqual(patched["state"]["paragraphs"][0]["segments"][0]["text"], original_caption)
        second = invoke("review", editorial=e, state=patched["state"],
                        raw={"status": "ready", "reasons": [], "issues": []})
        candidate = json.loads(invoke("finalize", editorial=e, state=second["state"])["adaptation_json"])
        self.assertEqual(candidate["script"]["frames"][0]["id"], FRAME_1)
        self.assertEqual(candidate["script"]["frames"][0]["mappings"][0]["endOffset"],
                         len(candidate["script"]["frames"][0]["text"].encode("utf-16-le")) // 2)

    def test_script_rejects_unapproved_reference_duplicate_locator_and_missing_story_transition(self):
        e = fixture("LINKEDIN_CAROUSEL")
        raw = model_draft(e)
        raw["script"]["frames"][0]["segments"][0]["evidenceId"] = SNAPSHOT
        prepared = invoke("prepare", editorial=e)["state"]
        result = invoke("draft", editorial=e, state=prepared, raw=raw)
        self.assertEqual(result["state"]["validation"]["candidateValidationError"], "SCRIPT_EVIDENCE_REFERENCE")
        raw = model_draft(e)
        raw["script"]["frames"][1]["id"] = FRAME_1
        result = invoke("draft", editorial=e, state=prepared, raw=raw)
        self.assertEqual(result["state"]["validation"]["candidateValidationError"], "SCRIPT_FRAME_ID")
        e = fixture("INSTAGRAM_STORIES")
        raw = model_draft(e)
        raw["script"]["frames"][0]["transition"] = ""
        result = invoke("draft", editorial=e, state=invoke("prepare", editorial=e)["state"], raw=raw)
        self.assertEqual(result["state"]["validation"]["candidateValidationError"], "TEXT_SHAPE")


if __name__ == "__main__":
    unittest.main()
