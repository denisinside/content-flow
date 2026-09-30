import { createHash, randomUUID } from 'node:crypto';
import { ImportValidationError } from './document-validation.js';

export function normalizeImportedText(value: string): string {
  const normalized = value.replace(/^\uFEFF/u, '').replace(/\r\n?/gu, '\n');
  if (!normalized.trim() || normalized.length > 200_000 || Buffer.from(normalized).toString('utf8') !== normalized
    || /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/u.test(normalized)) {
    throw new ImportValidationError('INVALID_TEXT', 'Source text is empty, too long, or contains unsupported control characters');
  }
  return normalized;
}
export function importedFragments(text: string) {
  const ranges: Array<[number, number]> = []; let start = 0;
  for (const match of text.matchAll(/\n(?:[ \t]*\n)+/gu)) {
    if (match.index > start) ranges.push([start, match.index]);
    start = match.index + match[0].length;
  }
  if (start < text.length) ranges.push([start, text.length]);
  if (!ranges.length || ranges.length > 1000) throw new ImportValidationError('INVALID_TEXT', 'Source must contain between 1 and 1000 paragraphs');
  return ranges.map(([startOffset, endOffset], index) => ({ id: randomUUID(), ordinal: index + 1, startOffset, endOffset,
    sha256: createHash('sha256').update(Buffer.from(text.slice(startOffset, endOffset))).digest('hex') }));
}
