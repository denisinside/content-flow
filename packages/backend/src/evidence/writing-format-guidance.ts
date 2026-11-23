import type { AdaptationFormat } from '../editorial/telegram-contracts.js';

/**
 * Published source-writing workflows require both a cited caption paragraph and
 * a frame array for scripted formats. The model sometimes omits the caption,
 * producing ARRAY_BOUNDS before the independent factual review can run.
 *
 * These are format rules, never additional factual evidence. Keep the user's
 * original notes/tone intact, and apply the same deterministic guide when the
 * job is created and when its frozen input is validated.
 */
const FORMAT_GUIDANCE: Partial<Record<AdaptationFormat, string>> = {
  LINKEDIN_CAROUSEL: '\nФормат LinkedIn-каруселі: обов’язково підготуй непорожній підпис paragraphs (принаймні один абзац із точним source_passage citation) ТА послідовність кадрів frames (зазвичай шість, якщо бриф не вимагає іншого). Кожен кадр має purpose, text, visualHint, citations; transition має бути порожнім. Ніколи не залишай paragraphs порожнім, навіть якщо основний формат — карусель.',
  INSTAGRAM_CAROUSEL: '\nФормат Instagram-каруселі: обов’язково підготуй непорожній підпис paragraphs (принаймні один абзац із точним source_passage citation) ТА послідовність кадрів frames (зазвичай шість, якщо бриф не вимагає іншого). Кожен кадр має purpose, text, visualHint, citations; transition має бути порожнім. Ніколи не залишай paragraphs порожнім, навіть якщо основний формат — карусель.',
  INSTAGRAM_STORIES: '\nФормат Instagram Stories: обов’язково згенеруй непорожній підпис paragraphs (принаймні один абзац із точним source_passage citation) і короткі кадри frames (зазвичай чотири, якщо бриф не вимагає іншого). Для кожного кадру згенеруй purpose, text, visualHint, transition та citations. Ніколи не залишай paragraphs порожнім, навіть якщо матеріал передусім призначено для Stories.',
};

const MAX_NOTES_LENGTH = 10_000;
const MAX_TONE_LENGTH = 10_000;

export function guideSourceWritingBrief<T extends { notes: string; tone: string }>(
  brief: T, format?: AdaptationFormat,
): T {
  const guidance = format ? FORMAT_GUIDANCE[format] : undefined;
  if (!guidance) return brief;
  if (brief.notes.length + guidance.length <= MAX_NOTES_LENGTH) {
    return { ...brief, notes: brief.notes + guidance };
  }
  // Never truncate user-authored notes to make room for internal format guidance.
  if (brief.tone.length + guidance.length <= MAX_TONE_LENGTH) {
    return { ...brief, tone: brief.tone + guidance };
  }
  return brief;
}
