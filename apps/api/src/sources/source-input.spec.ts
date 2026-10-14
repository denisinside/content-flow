import { describe, expect, it } from 'vitest';
import { createTextSourceInput, defaultSourceLabel, importDocumentInput, importUrlInput, updateMaterialInput, uploadSourceInput } from './source-input.js';

describe('optional source labels on creation', () => {
  it('normalizes omitted and blank creation labels to the same value', () => {
    const omitted = createTextSourceInput.parse({ purpose: 'NOTES', text: '  Some source text  ' });
    const blank = createTextSourceInput.parse({ label: '   ', purpose: 'NOTES', text: '  Some source text  ' });
    expect(omitted.label).toBeUndefined();
    expect(blank.label).toBeUndefined();
    expect(uploadSourceInput.parse({ purpose: 'NOTES' }).label).toBeUndefined();
    const commandKey = '00000000-0000-4000-8000-000000000001';
    expect(importUrlInput.parse({ purpose: 'NOTES', url: 'https://example.com', commandKey }).label).toBeUndefined();
    expect(importDocumentInput.parse({ purpose: 'NOTES', commandKey }).label).toBeUndefined();
  });

  it('trims and preserves a supplied label while PATCH still rejects blank labels', () => {
    expect(createTextSourceInput.parse({ label: '  Interview  ', purpose: 'NOTES', text: 'Source' }).label).toBe('Interview');
    expect(updateMaterialInput.safeParse({ expectedRevision: 1, label: '   ' }).success).toBe(false);
  });

  it('uses the first 80 collapsed Unicode code points for manual text', () => {
    expect(defaultSourceLabel('TEXT', '  First\n   source  ')).toBe('First source');
    expect(defaultSourceLabel('TEXT', '😀'.repeat(85))).toBe(`${'😀'.repeat(80)}…`);
    expect(defaultSourceLabel('TEXT', 'x'.repeat(80))).toBe('x'.repeat(80));
  });

  it('uses validated file names and canonical URLs within the stored-label bound', () => {
    expect(defaultSourceLabel('FILE', 'інтервʼю.txt')).toBe('інтервʼю.txt');
    expect(defaultSourceLabel('URL', 'https://example.com/story')).toBe('https://example.com/story');
    const longUrl = `https://example.com/${'😀'.repeat(150)}`;
    const fallback = defaultSourceLabel('URL', longUrl);
    expect(fallback.length).toBeLessThanOrEqual(200);
    expect(fallback.endsWith('…')).toBe(true);
  });
});
