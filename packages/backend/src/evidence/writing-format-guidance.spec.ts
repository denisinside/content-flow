import { describe, expect, it } from 'vitest';
import { guideSourceWritingBrief } from './writing-format-guidance.js';

const brief = { notes: 'Original editorial notes.', tone: 'Warm, precise.' };

describe('source-backed storyboard format guidance', () => {
  it.each(['LINKEDIN_CAROUSEL', 'INSTAGRAM_CAROUSEL', 'INSTAGRAM_STORIES'] as const)(
    'requires both a cited caption and frames for %s, keeping the user brief intact', format => {
      const guided = guideSourceWritingBrief(brief, format);
      expect(guided.notes).toContain(brief.notes);
      expect(guided.notes).toContain('paragraphs');
      expect(guided.notes).toContain('frames');
      expect(guided.notes).toContain('source_passage');
      expect(guided.tone).toBe(brief.tone);
      expect(guided).toEqual(guideSourceWritingBrief(brief, format));
    });

  it('keeps source-writing inputs for nonscripted formats and article work unchanged', () => {
    expect(guideSourceWritingBrief(brief)).toBe(brief);
    expect(guideSourceWritingBrief(brief, 'LINKEDIN_TEXT')).toBe(brief);
    expect(guideSourceWritingBrief(brief, 'LINKEDIN_COVER')).toBe(brief);
  });

  it('preserves long notes by placing guidance in available tone space', () => {
    const original = { notes: 'N'.repeat(10_000), tone: 'Warm.' };
    const result = guideSourceWritingBrief(original, 'INSTAGRAM_STORIES');
    expect(result.notes).toBe(original.notes);
    expect(result.tone).toContain('paragraphs');
    expect(result.tone.startsWith(original.tone)).toBe(true);
    expect(result.tone.length).toBeLessThanOrEqual(10_000);
  });

  it('never truncates a full user-authored brief when no field has room', () => {
    const full = { notes: 'N'.repeat(10_000), tone: 'T'.repeat(10_000) };
    expect(guideSourceWritingBrief(full, 'INSTAGRAM_STORIES')).toBe(full);
  });
});
