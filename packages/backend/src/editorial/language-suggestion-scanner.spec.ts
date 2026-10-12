import { describe, expect, it } from 'vitest';
import { findTypographySuggestions } from './language-suggestion-scanner.js';

describe('findTypographySuggestions', () => {
  it('finds simple typography edits while skipping quotes, URLs and evidence spans', () => {
    const text = 'Текст  тут , «цитата  так» https://example.test/a';
    const result = findTypographySuggestions(text, [{ start: 0, end: 8 }]);
    expect(result.map(({ originalText, replacementText }) => [originalText, replacementText])).toEqual([[' ,', ',']]);
  });
});
