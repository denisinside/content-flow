import { createHash, randomUUID } from 'node:crypto';
import { fromMarkdown } from 'mdast-util-from-markdown';
import { ImportValidationError } from './document-validation.js';

const MAX_TEXT_CODE_UNITS = 200_000;
const INVALID_TEXT_CONTROLS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/u;
const UNPAIRED_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u;
const NBSP_ENTITIES = /&(?:nbsp|NonBreakingSpace);|&#0*160;|&#x0*a0;/giu;
const REPEATED_BREAKS = /(?:<br\s*\/?>[ \t]*)+/giu;
const EMPTY_LAYOUT_ELEMENT_LINES = /(^|\n)[ \t]*<(p|div|span)>[ \t]*<\/\2>[ \t]*(?=\n|$)/giu;
const EXCESS_BLANK_LINES = /\n(?:[ \t]*\n){2,}/gu;
const TRAILING_BLANK_LINES = /\n(?:[ \t]*\n)+$/u;

type MarkdownNode = {
  type: string;
  position?: { start: { offset?: number }; end: { offset?: number } };
  children?: MarkdownNode[];
};
type Range = { start: number; end: number };

/** Normalize newly imported text before it is hashed or split into fragments. */
export function normalizeImportedText(value: string): string {
  // Bound untrusted input before cleanup can shrink an oversized payload.
  if (typeof value !== 'string' || value.length > MAX_TEXT_CODE_UNITS) invalidText();

  const text = value.replace(/^\uFEFF/u, '').replace(/\r\n?/gu, '\n');
  if (Buffer.from(text, 'utf8').toString('utf8') !== text
    || UNPAIRED_SURROGATE.test(text) || INVALID_TEXT_CONTROLS.test(text)) invalidText();

  // The Markdown parser supplies authoritative source ranges for every inline and
  // block code node, including code nested in quotes/lists and unclosed fences.
  const tree = fromMarkdown(text) as MarkdownNode;
  const protectedRanges = codeRanges(tree, text.length);
  let normalized = '';
  let cursor = 0;
  for (const range of protectedRanges) {
    normalized += normalizeProseSegment(text.slice(cursor, range.start));
    normalized += text.slice(range.start, range.end);
    cursor = range.end;
  }
  normalized += normalizeProseSegment(text.slice(cursor));

  // Remove redundant trailing prose-only blank lines but preserve code through EOF.
  if (protectedRanges.at(-1)?.end !== text.length) {
    const terminalNewline = normalized.endsWith('\n');
    normalized = normalized.replace(TRAILING_BLANK_LINES, terminalNewline ? '\n' : '');
  }
  if (!normalized.trim() || normalized.length > MAX_TEXT_CODE_UNITS) invalidText();
  return normalized;
}

function codeRanges(root: MarkdownNode, sourceLength: number): Range[] {
  const ranges: Range[] = [];
  const visit = (node: MarkdownNode): void => {
    if (node.type === 'code' || node.type === 'inlineCode') {
      const start = node.position?.start.offset;
      const end = node.position?.end.offset;
      if (!Number.isInteger(start) || !Number.isInteger(end) || start! < 0 || end! < start! || end! > sourceLength) {
        throw new Error('Markdown parser returned a code node without valid source offsets');
      }
      ranges.push({ start: start!, end: end! });
      return;
    }
    for (const child of node.children ?? []) visit(child);
  };
  visit(root);
  ranges.sort((left, right) => left.start - right.start || right.end - left.end);
  const merged: Range[] = [];
  for (const range of ranges) {
    const previous = merged.at(-1);
    if (previous && range.start < previous.end) previous.end = Math.max(previous.end, range.end);
    else merged.push({ ...range });
  }
  return merged;
}

function normalizeProseSegment(value: string): string {
  return value
    .replace(NBSP_ENTITIES, '\u0000')
    .replace(/[\u00A0\u2007\u202F\uFEFF]/gu, '\u0000')
    // Avoid leaving doubled spaces when the source already has a normal space
    // beside an imported non-breaking-space artifact.
    .replace(/[ \t]*\u0000+[ \t]*/gu, ' ')
    // Remove only empty, standalone layout wrappers. Content-bearing or attributed
    // HTML is retained verbatim; code ranges never reach this prose-only pass.
    .replace(EMPTY_LAYOUT_ELEMENT_LINES, '$1')
    .replace(REPEATED_BREAKS, '\n')
    .replace(EXCESS_BLANK_LINES, '\n\n');
}

function invalidText(): never {
  throw new ImportValidationError('INVALID_TEXT', 'Source text is empty, too long, or contains unsupported control characters');
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
