import { createHash } from 'node:crypto';
import { articleContentSchema, articleDocumentDetails, type ArticleContent, type ArticleMark, type ArticleNode } from '../editorial/article-contracts.js';
import {
  articleContentToGoogleRequests,
  googleTabToArticleContent,
  mapGoogleRangeToArticle,
  type GoogleRangeMapSpan,
  type GoogleSuggestionChange,
  type GoogleTabImportResult,
  type UnsupportedArticleFeature,
} from './article-conversion.js';
import type { GoogleDocsDocument, GoogleDocsRange, GoogleDocsRequest } from './google-docs-client.js';

export interface GoogleSyncSuggestionPart {
  type: 'insertion' | 'deletion' | 'style';
  text?: string;
  field?: string;
  value?: unknown;
  scope?: 'text' | 'paragraph';
  startIndex: number;
  endIndex: number;
  tabId: string;
}

export interface GoogleSyncPlan {
  requests: GoogleDocsRequest[];
  writeMode: 'EDIT' | 'SUGGEST';
  beforeCommittedHash: string;
  expectedCommittedContent: ArticleContent;
  expectedPlainText: string;
  targetRanges: GoogleDocsRange[];
  unsupported: UnsupportedArticleFeature[];
  hasChanges: boolean;
  expectedSuggestionParts: GoogleSyncSuggestionPart[];
}

export type GoogleRemoteThread = {
  remoteId: string;
  kind: 'comment' | 'suggestion';
  status: string;
  payload: NonNullable<GoogleDocsDocument['comments']>[number] | NonNullable<GoogleDocsDocument['suggestions']>[number];
  quoteText: string | null;
  ranges: GoogleDocsRange[];
  anchorStatus: 'anchored' | 'unanchored';
  author: { displayName?: string | undefined; user?: string | undefined } | null;
  createdAt: string | null;
  posts: unknown[];
  suggestionParts: GoogleSuggestionChange[];
};

export type GoogleThreadReconciliation =
  | { outcome: 'MATCHED'; thread: GoogleRemoteThread }
  | { outcome: 'UNKNOWN'; matchCount: number };

export interface GoogleThreadExpectation {
  kind: GoogleRemoteThread['kind'];
  status: string;
  quoteText: string | null;
  ranges: GoogleDocsRange[];
  content?: string;
  suggestionParts?: GoogleSyncSuggestionPart[];
}

/** Compile the saved article against the selected tab without overwriting nonempty remote text. */
export function buildGoogleSyncPlan(
  document: GoogleDocsDocument,
  tabId: string,
  sourceArticleContent: ArticleContent | unknown,
  mode: 'PUSH',
): GoogleSyncPlan {
  const expectedCommittedContent = articleContentSchema.parse(sourceArticleContent);
  const expectedPlainText = articleDocumentDetails(expectedCommittedContent).plainText;
  const imported = googleTabToArticleContent(document, tabId);
  const beforeCommittedHash = hashText(imported.plainText);
  const emptyPlan = (unsupported = imported.unsupported): GoogleSyncPlan => ({
    requests: [], writeMode: 'SUGGEST', beforeCommittedHash, expectedCommittedContent,
    expectedPlainText, targetRanges: [], unsupported, hasChanges: false, expectedSuggestionParts: [],
  });
  void mode;

  const sourceBlocks = flattenArticleBlocks(imported.content);
  const targetBlocks = flattenArticleBlocks(expectedCommittedContent);
  const structureMatches = sourceBlocks.length === targetBlocks.length;

  // A no-op never touches or resolves pending Google threads. It is safe even when a
  // separate unsupported suggestion remains visible in the fetched snapshot.
  if (expectedPlainText === imported.plainText && blockFormattingEqual(sourceBlocks, targetBlocks)) return emptyPlan(imported.unsupported);

  if (!imported.inlineCoordinatesValid) return emptyPlan(imported.unsupported.length ? imported.unsupported : [issue('tab', 'ambiguous-coordinates', 'Selected tab does not have a complete text coordinate map')]);

  const representedStylePaths = new Set(imported.suggestions.filter(part => part.type === 'style').map(part => part.path));
  const blockingImportIssues = imported.unsupported.filter(row => !['suggested-text-style', 'suggested-paragraph-style'].includes(row.type) || !representedStylePaths.has(row.path));
  if (blockingImportIssues.length) return emptyPlan(blockingImportIssues);

  const converted = articleContentToGoogleRequests(expectedCommittedContent, { tabId, startIndex: 1 });
  if (converted.unsupported.length) return emptyPlan(converted.unsupported);

  // A truly empty tab has no native comments to preserve around existing text. Use the
  // established full article converter for the one initial EDIT, with an explicit tab.
  if (!imported.plainText) {
    if (!converted.requests.length) return emptyPlan([issue('document', 'empty-target', 'An empty article has no initial text to send')]);
    return {
      requests: converted.requests,
      writeMode: 'EDIT',
      beforeCommittedHash,
      expectedCommittedContent,
      expectedPlainText,
      targetRanges: converted.ranges.map(row => ({ startIndex: row.startIndex, endIndex: row.endIndex, tabId })),
      unsupported: [],
      hasChanges: true,
      expectedSuggestionParts: [],
    };
  }

  if (!structureMatches) return emptyPlan([...imported.unsupported, issue('document', 'ambiguous-style-structure', 'Article block boundaries do not map exactly to the selected Google Docs tab')]);

  const requests: GoogleDocsRequest[] = [];
  const expectedSuggestionParts: GoogleSyncSuggestionPart[] = [];
  const delta = minimalTextDelta(imported.plainText, expectedPlainText);
  let deltaStartIndex: number | null = null, deltaEndIndex: number | null = null;
  if (delta) {
    const startIndex = mapArticleBoundaryToGoogle(delta.startOffset, imported.rangeMap);
    const endIndex = mapArticleBoundaryToGoogle(delta.endOffset, imported.rangeMap);
    if (startIndex === null || endIndex === null || endIndex < startIndex) {
      return emptyPlan([issue('document', 'ambiguous-delta-range', 'The text change crosses a source range that has no exact Google Docs coordinate mapping')]);
    }
    const oldText = imported.plainText.slice(delta.startOffset, delta.endOffset);
    const inlineStart = startIndex - imported.inlineTextStartIndex;
    const inlineEnd = endIndex - imported.inlineTextStartIndex;
    if (inlineStart < 0 || inlineEnd > imported.inlineText.length || imported.inlineText.slice(inlineStart, inlineEnd) !== oldText) {
      return emptyPlan([issue('document', 'ambiguous-delta-range', 'The selected Docs text does not match the committed text at the mapped change range')]);
    }
    if (endIndex > startIndex) {
      requests.push({ deleteContentRange: { range: { startIndex, endIndex, tabId } } });
      expectedSuggestionParts.push({ type: 'deletion', text: oldText, startIndex, endIndex, tabId });
    }
    if (delta.insertText) {
      requests.push({ insertText: { location: { index: startIndex, tabId }, text: delta.insertText } });
      expectedSuggestionParts.push({ type: 'insertion', text: delta.insertText, startIndex, endIndex: startIndex + delta.insertText.length, tabId });
    }
    deltaStartIndex = startIndex;
    deltaEndIndex = endIndex;
  }

  const styleResult = compileFormattingRequests(sourceBlocks, targetBlocks, imported.rangeMap, imported.plainText, expectedPlainText,
    delta, deltaStartIndex, deltaEndIndex, tabId);
  if (styleResult.unsupported.length) return emptyPlan([...imported.unsupported, ...styleResult.unsupported]);
  if (delta && styleResult.parts.length) {
    return emptyPlan([issue('document', 'mixed-text-formatting-change', 'Text and formatting changes cannot be combined safely in one Google Docs suggestion batch')]);
  }
  const allRanges = [...expectedSuggestionParts, ...styleResult.parts].filter(part => part.endIndex > part.startIndex);
  const conflictingSuggestions = imported.suggestions.filter(change => allRanges.some(part => rangesOverlap(part.startIndex, part.endIndex, change.startIndex, change.endIndex)));
  if (conflictingSuggestions.length) {
    return emptyPlan([issue('document', 'overlapping-pending-suggestion', 'A pending text or style suggestion overlaps the requested text or formatting change')]);
  }
  requests.push(...styleResult.requests);
  expectedSuggestionParts.push(...styleResult.parts);
  if (!requests.length || requests.length > 1000) return emptyPlan([issue('document', 'request-limit', 'The text change cannot be represented as a bounded Google Docs batch')]);

  return {
    requests,
    writeMode: 'SUGGEST',
    beforeCommittedHash,
    expectedCommittedContent,
    expectedPlainText,
    targetRanges: expectedSuggestionParts.filter(part => part.endIndex > part.startIndex).map(part => ({ startIndex: part.startIndex, endIndex: part.endIndex, tabId })),
    unsupported: [],
    hasChanges: true,
    expectedSuggestionParts,
  };
}

/** Map only a fully represented, exact quoted article range to one contiguous Docs range. */
export function mapArticleRangeToGoogle(
  imported: GoogleTabImportResult,
  startOffset: number,
  endOffset: number,
  quote: string,
): GoogleDocsRange | null {
  if (!imported.inlineCoordinatesValid || !Number.isSafeInteger(startOffset) || !Number.isSafeInteger(endOffset)
    || startOffset < 0 || endOffset <= startOffset || !isUtf16Boundary(imported.plainText, startOffset)
    || !isUtf16Boundary(imported.plainText, endOffset) || imported.plainText.slice(startOffset, endOffset) !== quote) return null;

  let articleCursor = startOffset;
  let remoteStart: number | undefined;
  let remoteEnd: number | undefined;
  for (const span of imported.rangeMap) {
    if (span.articleEndOffset <= articleCursor || span.articleStartOffset >= endOffset) continue;
    if (span.articleStartOffset > articleCursor) return null;
    const overlapStart = Math.max(articleCursor, span.articleStartOffset);
    const overlapEnd = Math.min(endOffset, span.articleEndOffset);
    const mappedStart = span.remoteStartIndex + overlapStart - span.articleStartOffset;
    const mappedEnd = span.remoteStartIndex + overlapEnd - span.articleStartOffset;
    if (remoteEnd !== undefined && remoteEnd !== mappedStart) return null;
    if (remoteStart === undefined) remoteStart = mappedStart;
    remoteEnd = mappedEnd;
    articleCursor = overlapEnd;
    if (articleCursor === endOffset) break;
  }
  if (articleCursor !== endOffset || remoteStart === undefined || remoteEnd === undefined) return null;
  const remoteQuote = imported.inlineText.slice(remoteStart - imported.inlineTextStartIndex, remoteEnd - imported.inlineTextStartIndex);
  if (remoteQuote !== quote) return null;
  return { startIndex: remoteStart, endIndex: remoteEnd, tabId: imported.tabId };
}

/** Keep every native thread, including threads whose anchors cannot be mapped safely. */
export function extractGoogleThreads(document: GoogleDocsDocument, tabId: string): GoogleRemoteThread[] {
  const imported = googleTabToArticleContent(document, tabId);
  const tab = findTab(document.tabs, tabId);
  if (!tab) throw new RangeError('Google Docs tab does not exist in the fetched document');
  const suggestionParts = new Map<string, GoogleSuggestionChange[]>();
  for (const part of imported.suggestions) {
    const rows = suggestionParts.get(part.suggestionId) ?? [];
    rows.push(part);
    suggestionParts.set(part.suggestionId, rows);
  }
  const comments = (document.comments ?? []).filter(thread => {
    if (!thread.anchorId) return true;
    const selectedAnchor = tab.documentTab.commentAnchors?.[thread.anchorId];
    const selectedHasAnchor = !!selectedAnchor;
    if (selectedAnchor?.ranges.length && selectedAnchor.ranges.every(range => !!range.tabId && range.tabId !== tabId)) return false;
    return selectedHasAnchor || !findAnchorInOtherTabs(document.tabs, tabId, thread.anchorId);
  }).map(thread => {
    const anchors = thread.anchorId ? tab.documentTab.commentAnchors?.[thread.anchorId]?.ranges ?? [] : [];
    const ranges = selectedRanges(anchors, tabId);
    const quoted = thread.plainTextQuote ?? null;
    const exact = ranges.length > 0 && quoted !== null && ranges.every(range => mapGoogleRangeToArticle(range, imported, quoted) !== null);
    const head = thread.headPost;
    return {
      remoteId: thread.commentId, kind: 'comment' as const, status: thread.status, payload: thread,
      quoteText: quoted, ranges, anchorStatus: exact ? 'anchored' as const : 'unanchored' as const,
      author: head.author ? { ...(head.author.displayName ? { displayName: head.author.displayName } : {}), ...(head.author.user ? { user: head.author.user } : {}) } : null,
      createdAt: head.createTime ?? null, posts: [head, ...(thread.replies ?? [])], suggestionParts: [],
    };
  });
  const selectedSuggestionIds = new Set(imported.suggestions.map(part => part.suggestionId));
  const suggestions = (document.suggestions ?? []).filter(thread => selectedSuggestionIds.has(thread.suggestionId)
    || !findSuggestionInOtherTabs(document.tabs, tabId, thread.suggestionId)).map(thread => {
    const parts = suggestionParts.get(thread.suggestionId) ?? [];
    const ranges = parts.every(part => part.startIndex >= imported.inlineTextStartIndex
      && part.endIndex > part.startIndex
      && part.endIndex <= imported.inlineTextStartIndex + imported.inlineText.length)
      ? parts.map(part => ({ startIndex: part.startIndex, endIndex: part.endIndex, tabId })) : [];
    const quoteText = thread.summaryText ?? (parts.length ? parts.map(part => part.text).join('') : null);
    const head = thread.headPost;
    return {
      remoteId: thread.suggestionId, kind: 'suggestion' as const, status: thread.status, payload: thread,
      quoteText, ranges, anchorStatus: ranges.length ? 'anchored' as const : 'unanchored' as const,
      author: head.author ? { ...(head.author.displayName ? { displayName: head.author.displayName } : {}), ...(head.author.user ? { user: head.author.user } : {}) } : null,
      createdAt: head.createTime ?? null, posts: [head, ...(thread.replies ?? [])], suggestionParts: parts,
    };
  });
  return [...comments, ...suggestions];
}

/** Reconcile a lost create response only when exactly one new native ID matches every frozen detail. */
export function reconcileGoogleCreatedThread(
  before: GoogleRemoteThread[],
  after: GoogleRemoteThread[],
  expected: GoogleThreadExpectation,
): GoogleThreadReconciliation {
  const priorIds = new Set(before.filter(row => row.kind === expected.kind).map(row => row.remoteId));
  const matches = after.filter(row => row.kind === expected.kind && !priorIds.has(row.remoteId)
    && row.status === expected.status && row.quoteText === expected.quoteText && rangesEqual(row.ranges, expected.ranges)
    && (expected.kind !== 'comment' || (expected.content !== undefined && row.posts.some(post => isRecord(post) && post.content === expected.content)))
    && (expected.kind !== 'suggestion' || suggestionPartsEqual(row.suggestionParts, expected.suggestionParts ?? [])));
  return matches.length === 1 ? { outcome: 'MATCHED', thread: matches[0]! } : { outcome: 'UNKNOWN', matchCount: matches.length };
}

function minimalTextDelta(before: string, after: string): { startOffset: number; endOffset: number; insertText: string } | null {
  if (before === after) return null;
  let prefix = 0;
  while (prefix < before.length && prefix < after.length && before.charCodeAt(prefix) === after.charCodeAt(prefix)) prefix++;
  while (prefix > 0 && (!isUtf16Boundary(before, prefix) || !isUtf16Boundary(after, prefix))) prefix--;
  let suffix = 0;
  while (suffix < before.length - prefix && suffix < after.length - prefix
    && before.charCodeAt(before.length - suffix - 1) === after.charCodeAt(after.length - suffix - 1)) suffix++;
  while (suffix > 0 && (!isUtf16Boundary(before, before.length - suffix) || !isUtf16Boundary(after, after.length - suffix))) suffix--;
  return { startOffset: prefix, endOffset: before.length - suffix, insertText: after.slice(prefix, after.length - suffix) };
}

interface ArticleBlockStyle {
  text: string;
  startOffset: number;
  kind: 'paragraph' | 'heading2' | 'heading3';
  quote: boolean;
  list: 'bullet' | 'ordered' | null;
  marks: Array<{ start: number; end: number; bold: boolean; italic: boolean; strikethrough: boolean }>;
}

function flattenArticleBlocks(content: ArticleContent): ArticleBlockStyle[] {
  const blocks: ArticleBlockStyle[] = [];
  let offset = 0;
  const walk = (nodes: ArticleNode[], context: { quote: boolean; list: ArticleBlockStyle['list'] }) => {
    for (const node of nodes) {
      if (node.type === 'blockquote') { walk(node.content ?? [], { ...context, quote: true }); continue; }
      if (node.type === 'bulletList' || node.type === 'orderedList') {
        walk(node.content ?? [], { quote: false, list: node.type === 'bulletList' ? 'bullet' : 'ordered' }); continue;
      }
      if (node.type === 'listItem') { walk(node.content ?? [], context); continue; }
      if (node.type !== 'paragraph' && node.type !== 'heading') continue;
      const block: ArticleBlockStyle = { text: '', startOffset: offset, kind: node.type === 'heading' ? (node.attrs?.level === 2 ? 'heading2' : 'heading3') : 'paragraph', quote: context.quote, list: context.list, marks: [] };
      const inline = (children: ArticleNode[]) => {
        for (const child of children) {
          if (child.type === 'hardBreak') { block.text += '\n'; continue; }
          if (child.type !== 'text') continue;
          const start = block.text.length, value = child.text ?? '';
          block.text += value;
          const style = marksToStyle(child.marks ?? []);
          if (value && Object.values(style).some(Boolean)) block.marks.push({ start, end: start + value.length, ...style });
        }
      };
      inline(node.content ?? []);
      blocks.push(block);
      offset += block.text.length + 2;
    }
  };
  walk(content.document.content ?? [], { quote: false, list: null });
  return blocks;
}

function marksToStyle(marks: ArticleMark[]): { bold: boolean; italic: boolean; strikethrough: boolean } {
  return {
    bold: marks.some(mark => mark.type === 'bold'),
    italic: marks.some(mark => mark.type === 'italic'),
    strikethrough: marks.some(mark => mark.type === 'strike'),
  };
}

function blockFormattingEqual(left: ArticleBlockStyle[], right: ArticleBlockStyle[]): boolean {
  return left.length === right.length && left.every((block, index) => {
    const other = right[index];
    if (!other || block.kind !== other.kind || block.quote !== other.quote || block.list !== other.list) return false;
    for (let offset = 0; offset < block.text.length; offset++) {
      const styleAt = (row: ArticleBlockStyle) => {
        const mark = row.marks.find(range => offset >= range.start && offset < range.end);
        return mark ? `${mark.bold}:${mark.italic}:${mark.strikethrough}` : 'false:false:false';
      };
      if (styleAt(block) !== styleAt(other)) return false;
    }
    return true;
  });
}

function compileFormattingRequests(
  source: ArticleBlockStyle[], target: ArticleBlockStyle[], rangeMap: GoogleRangeMapSpan[], beforeText: string, afterText: string,
  delta: ReturnType<typeof minimalTextDelta>, deltaStartIndex: number | null, deltaEndIndex: number | null, tabId: string,
): { requests: GoogleDocsRequest[]; parts: GoogleSyncSuggestionPart[]; unsupported: UnsupportedArticleFeature[] } {
  const requests: GoogleDocsRequest[] = [], parts: GoogleSyncSuggestionPart[] = [], unsupported: UnsupportedArticleFeature[] = [];
  const boundary = (targetOffset: number): number | null => {
    if (!delta) return mapArticleBoundaryToGoogle(targetOffset, rangeMap);
    const oldLength = delta.endOffset - delta.startOffset, newLength = delta.insertText.length;
    if (targetOffset <= delta.startOffset) return mapArticleBoundaryToGoogle(targetOffset, rangeMap);
    if (targetOffset < delta.startOffset + newLength) return deltaStartIndex === null ? null : deltaStartIndex + targetOffset - delta.startOffset;
    const oldOffset = targetOffset - newLength + oldLength;
    const original = mapArticleBoundaryToGoogle(oldOffset, rangeMap);
    return original === null ? null : original + newLength - oldLength;
  };
  for (const [index, block] of target.entries()) {
    const old = source[index]!;
    const rangeStart = boundary(block.startOffset), rangeEnd = boundary(block.startOffset + block.text.length);
    if (rangeStart === null || rangeEnd === null || rangeEnd <= rangeStart) {
      if (block.kind !== old.kind || block.quote !== old.quote || block.list !== old.list) unsupported.push(issue(`document.blocks.${index}`, 'ambiguous-paragraph-range', 'Paragraph formatting change has no exact Docs range'));
      if (!sameInlineStyles(old, block)) unsupported.push(issue(`document.blocks.${index}`, 'ambiguous-text-style-range', 'Inline formatting change has no exact Docs range'));
      continue;
    }
    const paragraphRange = { startIndex: rangeStart, endIndex: rangeEnd, tabId };
    if (block.kind !== old.kind) {
      const namedStyleType = block.kind === 'heading2' ? 'HEADING_2' : block.kind === 'heading3' ? 'HEADING_3' : 'NORMAL_TEXT';
      requests.push({ updateParagraphStyle: { range: paragraphRange, paragraphStyle: { namedStyleType }, fields: 'namedStyleType' } });
      parts.push({ type: 'style', field: 'namedStyleType', value: namedStyleType, scope: 'paragraph', startIndex: rangeStart, endIndex: rangeEnd, tabId });
    }
    if (block.quote !== old.quote) {
      requests.push({ updateParagraphStyle: { range: paragraphRange, paragraphStyle: { indentStart: { magnitude: block.quote ? 36 : 0, unit: 'PT' } }, fields: 'indentStart' } });
      parts.push({ type: 'style', field: 'indentStart', value: { magnitude: block.quote ? 36 : 0, unit: 'PT' }, scope: 'paragraph', startIndex: rangeStart, endIndex: rangeEnd, tabId });
    }
    if (block.list !== old.list) {
      if (!old.list && block.list) {
        requests.push({ createParagraphBullets: { range: paragraphRange, bulletPreset: block.list === 'bullet' ? 'BULLET_DISC_CIRCLE_SQUARE' : 'NUMBERED_DECIMAL_ALPHA_ROMAN' } });
        parts.push({ type: 'style', field: 'bulletPreset', value: block.list === 'bullet' ? 'BULLET_DISC_CIRCLE_SQUARE' : 'NUMBERED_DECIMAL_ALPHA_ROMAN', scope: 'paragraph', startIndex: rangeStart, endIndex: rangeEnd, tabId });
      } else unsupported.push(issue(`document.blocks.${index}`, 'unsupported-list-transition', 'Removing or changing an existing Docs list cannot be represented safely as a suggestion'));
    }
    const textCursor = block.startOffset;
    const changed: Array<{ field: 'bold' | 'italic' | 'strikethrough'; value: boolean; start: number; end: number }> = [];
    for (const field of ['bold', 'italic', 'strikethrough'] as const) {
      let open: { value: boolean; start: number; end: number } | undefined;
      for (let local = 0; local < block.text.length; local++) {
        const targetOffset = block.startOffset + local;
        const oldOffset = targetToSourceOffset(targetOffset, delta);
        const oldStyle = oldOffset === null
          ? inheritedStyleAtSourceOffset(old, delta, targetOffset)
          : styleAtSourceOffset(source, oldOffset, old);
        const oldValue = oldStyle[field], newValue = styleAt(block, local)[field];
        if (oldValue !== newValue) {
          if (open && open.value === newValue && open.end === textCursor + local) open.end++;
          else {
            if (open) changed.push({ field, ...open });
            open = { value: newValue, start: textCursor + local, end: textCursor + local + 1 };
          }
        } else if (open) { changed.push({ field, ...open }); open = undefined; }
      }
      if (open) changed.push({ field, ...open });
    }
    for (const change of changed) {
      const start = boundary(change.start), end = boundary(change.end);
      if (start === null || end === null || end <= start) {
        unsupported.push(issue(`document.blocks.${index}`, 'ambiguous-text-style-range', 'Inline formatting change has no exact Docs range'));
        continue;
      }
      const field = change.field === 'strikethrough' ? 'strikethrough' : change.field;
      requests.push({ updateTextStyle: { range: { startIndex: start, endIndex: end, tabId }, textStyle: { [field]: change.value }, fields: field } });
      parts.push({ type: 'style', field, value: change.value, scope: 'text', startIndex: start, endIndex: end, tabId });
    }
  }
  if (beforeText !== afterText && (deltaStartIndex === null || deltaEndIndex === null)) unsupported.push(issue('document', 'ambiguous-style-delta', 'Text and formatting changes do not share a validated delta range'));
  return { requests, parts, unsupported };
}

function styleAt(block: ArticleBlockStyle, offset: number): { bold: boolean; italic: boolean; strikethrough: boolean } {
  const mark = block.marks.find(range => offset >= range.start && offset < range.end);
  return mark ? { bold: mark.bold, italic: mark.italic, strikethrough: mark.strikethrough } : { bold: false, italic: false, strikethrough: false };
}

function targetToSourceOffset(targetOffset: number, delta: ReturnType<typeof minimalTextDelta>): number | null {
  if (!delta) return targetOffset;
  const insertedEnd = delta.startOffset + delta.insertText.length;
  if (targetOffset < delta.startOffset) return targetOffset;
  if (targetOffset < insertedEnd) return null;
  return targetOffset - delta.insertText.length + delta.endOffset - delta.startOffset;
}

function styleAtSourceOffset(blocks: ArticleBlockStyle[], sourceOffset: number, fallback: ArticleBlockStyle): ReturnType<typeof styleAt> {
  const found = blocks.find(block => sourceOffset >= block.startOffset && sourceOffset < block.startOffset + block.text.length);
  return found ? styleAt(found, sourceOffset - found.startOffset) : styleAt(fallback, 0);
}

function inheritedStyleAtSourceOffset(block: ArticleBlockStyle, delta: ReturnType<typeof minimalTextDelta>, targetOffset: number): ReturnType<typeof styleAt> {
  if (!delta) return styleAt(block, 0);
  const insertionStart = delta.startOffset;
  const insertionEnd = insertionStart + delta.insertText.length;
  if (targetOffset < insertionStart || targetOffset >= insertionEnd) return styleAt(block, 0);
  const localBefore = insertionStart - block.startOffset - 1;
  if (localBefore >= 0 && localBefore < block.text.length) return styleAt(block, localBefore);
  const localAfter = delta.endOffset - block.startOffset;
  if (localAfter >= 0 && localAfter < block.text.length) return styleAt(block, localAfter);
  return { bold: false, italic: false, strikethrough: false };
}

function sameInlineStyles(left: ArticleBlockStyle, right: ArticleBlockStyle): boolean {
  if (left.text.length !== right.text.length) return false;
  for (let i = 0; i < left.text.length; i++) {
    const a = styleAt(left, i), b = styleAt(right, i);
    if (a.bold !== b.bold || a.italic !== b.italic || a.strikethrough !== b.strikethrough) return false;
  }
  return true;
}

function mapArticleBoundaryToGoogle(offset: number, spans: GoogleRangeMapSpan[]): number | null {
  const candidates = spans.filter(span => offset >= span.articleStartOffset && offset <= span.articleEndOffset)
    .map(span => span.remoteStartIndex + offset - span.articleStartOffset);
  const distinct = [...new Set(candidates)];
  return distinct.length === 1 ? distinct[0]! : null;
}

function selectedRanges(ranges: GoogleDocsRange[], tabId: string): GoogleDocsRange[] {
  if (!ranges.length || ranges.some(range => range.segmentId !== undefined || (range.tabId !== undefined && range.tabId !== tabId)
    || !Number.isSafeInteger(range.startIndex) || !Number.isSafeInteger(range.endIndex) || range.endIndex <= range.startIndex)) return [];
  const ordered = [...ranges].sort((left, right) => left.startIndex - right.startIndex || left.endIndex - right.endIndex);
  if (ordered.some((range, index) => index > 0 && range.startIndex < ordered[index - 1]!.endIndex)) return [];
  return ordered.map(range => ({ ...range, tabId }));
}

function findTab(tabs: GoogleDocsDocument['tabs'], tabId: string): GoogleDocsDocument['tabs'][number] | undefined {
  for (const tab of tabs) {
    if (tab.tabProperties.tabId === tabId) return tab;
    const nested = findTab(tab.childTabs ?? [], tabId);
    if (nested) return nested;
  }
  return undefined;
}

function rangesOverlap(leftStart: number, leftEnd: number, rightStart: number, rightEnd: number): boolean {
  return leftStart === leftEnd ? leftStart >= rightStart && leftStart < rightEnd : leftStart < rightEnd && rightStart < leftEnd;
}

function rangesEqual(left: GoogleDocsRange[], right: GoogleDocsRange[]): boolean {
  return left.length === right.length && left.every((range, index) => {
    const other = right[index];
    return !!other && range.startIndex === other.startIndex && range.endIndex === other.endIndex
      && (range.tabId ?? '') === (other.tabId ?? '') && (range.segmentId ?? '') === (other.segmentId ?? '');
  });
}

function suggestionPartsEqual(left: GoogleSuggestionChange[], right: GoogleSyncSuggestionPart[]): boolean {
  if (left.length !== right.length) return false;
  const remaining = [...left];
  return right.every(other => {
    const index = remaining.findIndex(part => part.type === other.type && part.startIndex === other.startIndex && part.endIndex === other.endIndex
      && (part.type === 'style' ? other.field !== undefined && deepEqual(styleValue(part.style, other.field), other.value) : part.text === other.text));
    if (index < 0) return false;
    remaining.splice(index, 1);
    return true;
  });
}

function deepEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) || Array.isArray(right)) return Array.isArray(left) && Array.isArray(right)
    && left.length === right.length && left.every((value, index) => deepEqual(value, right[index]));
  if (!isRecord(left) || !isRecord(right)) return false;
  const leftKeys = Object.keys(left).sort(), rightKeys = Object.keys(right).sort();
  return leftKeys.length === rightKeys.length && leftKeys.every((key, index) => key === rightKeys[index] && deepEqual(left[key], right[key]));
}

function styleValue(style: unknown, field: string): unknown {
  if (!isRecord(style)) return undefined;
  if (isRecord(style.textStyle) && field in style.textStyle) return style.textStyle[field];
  if (isRecord(style.paragraphStyle) && field in style.paragraphStyle) return style.paragraphStyle[field];
  return style[field];
}

function findAnchorInOtherTabs(tabs: GoogleDocsDocument['tabs'], selectedTabId: string, anchorId: string): boolean {
  const walk = (rows: GoogleDocsDocument['tabs'], inSelectedTree: boolean): boolean => rows.some(row => {
    const selected = inSelectedTree || row.tabProperties.tabId === selectedTabId;
    if (!selected && row.documentTab.commentAnchors?.[anchorId]) return true;
    return walk(row.childTabs ?? [], selected);
  });
  return walk(tabs, false);
}

function findSuggestionInOtherTabs(tabs: GoogleDocsDocument['tabs'], selectedTabId: string, suggestionId: string): boolean {
  const walk = (rows: GoogleDocsDocument['tabs'], inSelectedTree: boolean): boolean => rows.some(row => {
    const selected = inSelectedTree || row.tabProperties.tabId === selectedTabId;
    if (!selected && hasSuggestionId(row.documentTab, suggestionId)) return true;
    return walk(row.childTabs ?? [], selected);
  });
  return walk(tabs, false);
}

function hasSuggestionId(value: unknown, suggestionId: string): boolean {
  if (!isRecord(value)) return false;
  for (const key of ['suggestedInsertionIds', 'suggestedDeletionIds']) {
    const ids = value[key];
    if (Array.isArray(ids) && ids.includes(suggestionId)) return true;
  }
  for (const key of ['suggestedTextStyleChanges', 'suggestedParagraphStyleChanges']) {
    const changes = value[key];
    if (isRecord(changes) && suggestionId in changes) return true;
  }
  return Object.values(value).some(child => Array.isArray(child)
    ? child.some(item => hasSuggestionId(item, suggestionId))
    : hasSuggestionId(child, suggestionId));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isUtf16Boundary(value: string, offset: number): boolean {
  if (offset <= 0 || offset >= value.length) return true;
  const previous = value.charCodeAt(offset - 1), next = value.charCodeAt(offset);
  return !(previous >= 0xd800 && previous <= 0xdbff && next >= 0xdc00 && next <= 0xdfff);
}

function hashText(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function issue(path: string, type: string, message: string): UnsupportedArticleFeature {
  return { path, type, message };
}
