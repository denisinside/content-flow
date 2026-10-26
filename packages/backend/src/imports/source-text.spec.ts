import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { ImportValidationError } from './document-validation.js';
import { importedFragments, normalizeImportedText } from './source-text.js';

describe('normalizeImportedText', () => {
  it('cleans common non-breaking layout artifacts outside Markdown code', () => {
    const source = '\uFEFFЗаголовок\u00A0текст &nbsp;ще &#160;текст\r\n\r\n\u202F\r\nНовий<br>рядок';
    const normalized = normalizeImportedText(source);
    expect(normalized).toBe('Заголовок текст ще текст\n\nНовий\nрядок');
    expect(normalizeImportedText(normalized)).toBe(normalized);
  });

  it('removes only standalone empty layout wrappers after NBSP cleanup', () => {
    const source = 'Before\n<p>&nbsp;</p>\n<div> &#160; </div>\n<span>\u00A0</span>\nAfter';
    const normalized = normalizeImportedText(source);
    expect(normalized).toBe('Before\n\nAfter');
    expect(normalizeImportedText(normalized)).toBe(normalized);
    expect(normalizeImportedText('<p>text</p>\n<div>real content</div>\n<span>label</span>'))
      .toBe('<p>text</p>\n<div>real content</div>\n<span>label</span>');
  });

  it('preserves entity spellings and whitespace inside inline and fenced code', () => {
    const source = [
      'Речення `x&nbsp;  y` і ``a\u00A0  b``.',
      '',
      '```html',
      '&nbsp;\u00A0  <br>',
      '<p>&nbsp;</p>',
      '',
      '```',
      '',
      '~~~',
      '&nbsp;  \u202F',
      '',
      '~~~',
    ].join('\n');
    const normalized = normalizeImportedText(source);
    expect(normalized).toBe(source.replace(/^\uFEFF/u, ''));
  });

  it('preserves multiline code spans and does not let unmatched delimiters consume a later fence', () => {
    const source = [
      'Before `first&nbsp;',
      '\u00A0  second` after &nbsp; text.',
      '',
      'An unmatched ` stays prose &nbsp;.',
      '```txt',
      '&nbsp;  literal',
      '```',
      '<tag>&lt; still literal HTML text',
    ].join('\n');
    expect(normalizeImportedText(source)).toBe([
      'Before `first&nbsp;',
      '\u00A0  second` after text.',
      '',
      'An unmatched ` stays prose .',
      '```txt',
      '&nbsp;  literal',
      '```',
      '<tag>&lt; still literal HTML text',
    ].join('\n'));
  });

  it('preserves indented Markdown code blocks, including blank lines', () => {
    const source = 'Example:\n\n    x&nbsp;  y\n\n\tkeep\u00A0exact\n\nAfter &nbsp; code.';
    expect(normalizeImportedText(source)).toBe('Example:\n\n    x&nbsp;  y\n\n\tkeep\u00A0exact\n\nAfter code.');
  });

  it('preserves nested and unclosed fenced code ranges from CommonMark source positions', () => {
    const quoted = '> ```\n> &nbsp;  code';
    const listed = '- ```\n  &nbsp;  code';
    expect(normalizeImportedText(quoted)).toBe(quoted);
    expect(normalizeImportedText(listed)).toBe(listed);
  });

  it('caps layout-only blank lines without changing Markdown blocks', () => {
    expect(normalizeImportedText('# Title\n\n\n\n- item\n\n\nNext')).toBe('# Title\n\n- item\n\nNext');
  });

  it('builds fragment offsets and hashes from the canonical normalized text', () => {
    const text = normalizeImportedText('A&nbsp;😀\n\nB\u202FC');
    const fragments = importedFragments(text);
    expect(text).toBe('A 😀\n\nB C');
    expect(fragments.map(({ startOffset, endOffset }) => text.slice(startOffset, endOffset))).toEqual(['A 😀', 'B C']);
    expect(fragments.map(({ sha256 }) => sha256)).toEqual(
      fragments.map(({ startOffset, endOffset }) => createHash('sha256').update(text.slice(startOffset, endOffset), 'utf8').digest('hex')),
    );
  });

  it('bounds raw input and rejects artifact-only or malformed text', () => {
    for (const value of ['&nbsp;\n&#160;', 'x'.repeat(200_001), 'bad\u0000text', '\uD800']) {
      expect(() => normalizeImportedText(value)).toThrow(ImportValidationError);
    }
  });
});
