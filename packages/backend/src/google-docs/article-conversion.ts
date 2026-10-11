import { articleContentSchema, articleDocumentDetails, type ArticleContent, type ArticleMark, type ArticleNode } from '../editorial/article-contracts.js';
import type { GoogleDocsDocument, GoogleDocsRange, GoogleDocsRequest } from './google-docs-client.js';

export interface ArticleToGoogleOptions {
  tabId?: string;
  /** Google Docs body index. For a blank body this is normally 1. */
  startIndex?: number;
  /** Existing body range to replace; callers must pass a range from the same revision used for batchUpdate. */
  replaceRange?: GoogleDocsRange;
}

export interface UnsupportedArticleFeature {
  path: string;
  type: string;
  message: string;
}

export interface ArticleToGoogleResult {
  title: string;
  requests: GoogleDocsRequest[];
  plainText: string;
  ranges: Array<{ path: string; startIndex: number; endIndex: number; text: string }>;
  unsupported: UnsupportedArticleFeature[];
  omittedEvidenceMarks: number;
}

interface TextRun { text: string; marks: ArticleMark[]; path: string }
interface Block { text: string; runs: TextRun[]; path: string; kind: 'paragraph' | 'heading2' | 'heading3' | 'blockquote'; list?: 'bullet' | 'ordered' }

/** Compile supported article JSON into deterministic, revision-relative Docs requests. */
export function articleContentToGoogleRequests(raw: ArticleContent | unknown, options: ArticleToGoogleOptions = {}): ArticleToGoogleResult {
  const content = articleContentSchema.parse(raw);
  const unsupported: UnsupportedArticleFeature[] = [];
  const blocks: Block[] = [];
  let omittedEvidenceMarks = 0;
  const tabId = options.tabId;
  const startIndex = options.replaceRange?.startIndex ?? options.startIndex ?? 1;
  if (!Number.isSafeInteger(startIndex) || startIndex < 1) throw new RangeError('Google Docs body index must be a positive integer');

  const textRuns = (nodes: ArticleNode[], path: string): TextRun[] => nodes.flatMap((node, index) => {
    const nodePath = `${path}.${index}`;
    if (node.type === 'hardBreak') return [{ text: '\n', marks: [], path: nodePath }];
    if (node.type !== 'text') {
      unsupported.push({ path: nodePath, type: node.type, message: 'Expected inline text or hard break' });
      return [];
    }
    const marks = node.marks ?? [];
    omittedEvidenceMarks += marks.filter(mark => mark.type === 'evidence').length;
    return [{ text: node.text ?? '', marks, path: nodePath }];
  });

  const addParagraph = (node: ArticleNode, path: string, context: { quote: boolean; list?: 'bullet' | 'ordered' }) => {
    if (node.type !== 'paragraph' && node.type !== 'heading') {
      unsupported.push({ path, type: node.type, message: 'Google Docs conversion requires paragraphs or supported headings here' });
      return;
    }
    blocks.push({
      text: '', runs: textRuns(node.content ?? [], path), path,
      kind: context.quote ? 'blockquote' : node.type === 'heading' ? (node.attrs?.level === 2 ? 'heading2' : 'heading3') : 'paragraph',
      ...(context.list ? { list: context.list } : {}),
    });
  };

  const walk = (nodes: ArticleNode[], path: string, context: { quote: boolean; list?: 'bullet' | 'ordered' } = { quote: false }) => {
    nodes.forEach((node, index) => {
      const nodePath = `${path}.${index}`;
      if (node.type === 'paragraph' || node.type === 'heading') addParagraph(node, nodePath, context);
      else if (node.type === 'blockquote') walk(node.content ?? [], nodePath, { quote: true });
      else if (node.type === 'bulletList' || node.type === 'orderedList') {
        const list = node.type === 'bulletList' ? 'bullet' : 'ordered';
        (node.content ?? []).forEach((item, itemIndex) => {
          const itemPath = `${nodePath}.${itemIndex}`;
          if (item.type !== 'listItem') {
            unsupported.push({ path: itemPath, type: item.type, message: 'Google Docs lists require listItem nodes' });
            return;
          }
          const children = item.content ?? [];
          if (children.length !== 1 || children[0]?.type !== 'paragraph') {
            unsupported.push({ path: itemPath, type: 'nested-or-multiblock-list-item', message: 'Nested and multi-paragraph list items need explicit conversion support' });
            return;
          }
          addParagraph(children[0], `${itemPath}.0`, { quote: false, list });
        });
      } else {
        unsupported.push({ path: nodePath, type: node.type, message: 'Unsupported block structure for Google Docs conversion' });
      }
    });
  };
  walk(content.document.content ?? [], 'doc');

  // Never generate a partial export that silently omits an unsupported node.
  if (unsupported.length) return { title: content.title, requests: [], plainText: '', ranges: [], unsupported, omittedEvidenceMarks };

  for (const block of blocks) block.text = block.runs.map(run => run.text).join('');
  const plainText = blocks.map(block => block.text).join('\n');
  const requests: GoogleDocsRequest[] = [];
  if (!plainText.length) {
    unsupported.push({ path: 'document', type: 'empty-body', message: 'An empty article body has no text updates to send' });
    return { title: content.title, requests, plainText, ranges: [], unsupported, omittedEvidenceMarks };
  }
  const insertionIndex = options.replaceRange?.startIndex ?? startIndex;
  if (options.replaceRange) requests.push({ deleteContentRange: { range: withTab(options.replaceRange, tabId) } });
  if (plainText.length) requests.push({ insertText: { location: { index: insertionIndex, ...(tabId ? { tabId } : {}) }, text: plainText } });

  const ranges: ArticleToGoogleResult['ranges'] = [];
  let cursor = startIndex;
  const listGroups: Array<{ kind: 'bullet' | 'ordered'; startIndex: number; endIndex: number }> = [];
  for (const [blockIndex, block] of blocks.entries()) {
    const blockStart = cursor;
    const blockEnd = blockStart + block.text.length;
    const paragraphEnd = blockEnd + (blockIndex < blocks.length - 1 ? 1 : 0);
    ranges.push({ path: block.path, startIndex: blockStart, endIndex: blockEnd, text: block.text });
    const paragraphRange = { startIndex: blockStart, endIndex: Math.max(blockStart + 1, paragraphEnd), ...(tabId ? { tabId } : {}) };
    if (block.kind === 'heading2' || block.kind === 'heading3') {
      requests.push({ updateParagraphStyle: { range: paragraphRange, paragraphStyle: { namedStyleType: block.kind === 'heading2' ? 'HEADING_2' : 'HEADING_3' }, fields: 'namedStyleType' } });
    } else if (block.kind === 'blockquote') {
      requests.push({ updateParagraphStyle: { range: paragraphRange, paragraphStyle: { indentStart: { magnitude: 36, unit: 'PT' } }, fields: 'indentStart' } });
    }
    let runCursor = blockStart;
    for (const run of block.runs) {
      const runEnd = runCursor + run.text.length;
      const style: { bold?: boolean; italic?: boolean; strikethrough?: boolean } = {};
      if (run.marks.some(mark => mark.type === 'bold')) style.bold = true;
      if (run.marks.some(mark => mark.type === 'italic')) style.italic = true;
      if (run.marks.some(mark => mark.type === 'strike')) style.strikethrough = true;
      if (Object.keys(style).length && runEnd > runCursor) {
        requests.push({ updateTextStyle: { range: { startIndex: runCursor, endIndex: runEnd, ...(tabId ? { tabId } : {}) }, textStyle: style, fields: Object.keys(style).join(',') } });
      }
      runCursor = runEnd;
    }
    if (block.list) {
      const previous = listGroups.at(-1);
      if (previous && previous.kind === block.list && previous.endIndex === blockStart) previous.endIndex = paragraphEnd;
      else listGroups.push({ kind: block.list, startIndex: blockStart, endIndex: paragraphEnd });
    }
    cursor = paragraphEnd;
  }
  for (const group of listGroups) {
    requests.push({ createParagraphBullets: { range: { startIndex: group.startIndex, endIndex: Math.max(group.startIndex + 1, group.endIndex), ...(tabId ? { tabId } : {}) }, bulletPreset: group.kind === 'bullet' ? 'BULLET_DISC_CIRCLE_SQUARE' : 'NUMBERED_DECIMAL_ALPHA_ROMAN' } });
  }
  if (requests.length > 1000) {
    unsupported.push({ path: 'document', type: 'request-limit', message: 'The converted document needs more than 1000 API requests and cannot be sent as one safe batch' });
    return { title: content.title, requests: [], plainText, ranges, unsupported, omittedEvidenceMarks };
  }
  return { title: content.title, requests, plainText, ranges, unsupported, omittedEvidenceMarks };
}

export type GoogleSuggestionChange = {
  suggestionId: string;
  path: string;
  type: 'insertion' | 'deletion';
  text: string;
  startIndex: number;
  endIndex: number;
} | {
  suggestionId: string;
  path: string;
  type: 'style';
  text: string;
  startIndex: number;
  endIndex: number;
  scope: 'text' | 'paragraph';
  supported: boolean;
  style: unknown;
};

export interface GoogleRangeMapSpan {
  remoteStartIndex: number;
  remoteEndIndex: number;
  articleStartOffset: number;
  articleEndOffset: number;
}

export interface GoogleTabImportResult {
  tabId: string;
  content: ArticleContent;
  suggestions: GoogleSuggestionChange[];
  unsupported: UnsupportedArticleFeature[];
  /** Committed article text, excluding unresolved insertions and Docs paragraph terminators. */
  plainText: string;
  /** Exact inline text from the selected Docs tab in UTF-16 code units. */
  inlineText: string;
  inlineTextStartIndex: number;
  inlineCoordinatesValid: boolean;
  /** Only ranges with a one-to-one mapping into committed article text are included. */
  rangeMap: GoogleRangeMapSpan[];
}

/** Import committed text from a selected Docs tab. Open insertions/deletions stay separate suggestions. */
export function googleTabToArticleContent(document: GoogleDocsDocument, tabId: string): GoogleTabImportResult {
  const tab = findTab(document.tabs, tabId);
  if (!tab) throw new RangeError('Google Docs tab does not exist in the fetched document');
  const unsupported: UnsupportedArticleFeature[] = [];
  const suggestions: GoogleSuggestionChange[] = [];
  const children = (tab.documentTab.body as { content?: unknown[] }).content ?? [];
  const paragraphNodes: Array<{ node: ArticleNode; bullet?: { id: string; kind?: 'bullet' | 'ordered' }; quote: boolean; path: string; committedText: string; mapRuns: Array<{ remoteStartIndex: number; text: string }>; terminalNewlineIndex?: number }> = [];
  const lists = (tab.documentTab as { lists?: Record<string, { listProperties?: { nestingLevels?: Array<{ glyphType?: string }> } }> }).lists ?? {};
  const consumedSuggestionIds = new Set<string>();
  const inlineParts: string[] = [];
  let expectedRemoteIndex: number | undefined;
  let inlineCoordinatesValid = true;
  let hasSeenParagraph = false;

  for (const [index, rawElement] of children.entries()) {
    if (rawElement && typeof rawElement === 'object' && 'sectionBreak' in rawElement) {
      const sectionElement = rawElement as { startIndex?: number; endIndex?: number; sectionBreak?: Record<string, unknown> };
      const sectionBreak = sectionElement.sectionBreak;
      const isRequiredLeadingBoundary = index === 0
        && !hasSeenParagraph
        && (sectionElement.startIndex ?? 0) === 0
        && sectionElement.endIndex === 1
        && !!sectionBreak
        && !('suggestedInsertionIds' in sectionBreak)
        && !('suggestedDeletionIds' in sectionBreak)
        && !hasSuggestedStyleMetadata(sectionBreak);
      if (isRequiredLeadingBoundary) {
        // Docs body always reserves [0, 1) for its leading section break. The
        // sectionStyle is ordinary document metadata; it contributes no text.
        expectedRemoteIndex = 1;
        continue;
      }
      inlineCoordinatesValid = false;
      unsupported.push({ path: `tab.${tabId}.body.${index}`, type: 'unsupported-section-break', message: 'Only the required empty leading section break at [0, 1) is supported' });
      continue;
    }
    if (!rawElement || typeof rawElement !== 'object' || !('paragraph' in rawElement)) {
      inlineCoordinatesValid = false;
      unsupported.push({ path: `tab.${tabId}.body.${index}`, type: 'non-paragraph-structural-element', message: 'Tables and other structural elements are not imported' });
      continue;
    }
    const element = rawElement as { paragraph?: { elements?: unknown[]; paragraphStyle?: Record<string, unknown>; bullet?: { listId?: string; nestingLevel?: number } }; startIndex?: number; endIndex?: number };
    const paragraph = element.paragraph;
    if (!paragraph) continue;
    const path = `tab.${tabId}.body.${index}`;
    const startIndex = element.startIndex ?? 1;
    if (!hasSeenParagraph && startIndex !== 1) {
      inlineCoordinatesValid = false;
      unsupported.push({ path, type: 'body-index-origin', message: 'Selected tab body does not start at the expected Google Docs body index' });
    }
    hasSeenParagraph = true;
    if (expectedRemoteIndex !== undefined && startIndex !== expectedRemoteIndex) {
      inlineCoordinatesValid = false;
      unsupported.push({ path, type: 'body-index-gap', message: 'A structural gap in Docs body coordinates makes comment anchors across this point ambiguous' });
    }
    const paragraphRuns: Array<{ run: string; start: number; end: number; insertion: boolean; marks: ArticleMark[] }> = [];
    let cursor = startIndex;
    let terminalNewlineIndex: number | undefined;
    for (const [runIndex, rawRun] of (paragraph.elements ?? []).entries()) {
      if (!rawRun || typeof rawRun !== 'object' || !('textRun' in rawRun)) {
        inlineCoordinatesValid = false;
        unsupported.push({ path: `${path}.elements.${runIndex}`, type: 'non-text-element', message: 'Inline objects and non-text elements are not imported' });
        continue;
      }
      const runElement = rawRun as { startIndex?: number; endIndex?: number; textRun?: { content?: string; textStyle?: Record<string, unknown>; suggestedInsertionIds?: string[]; suggestedDeletionIds?: string[]; suggestedTextStyleChanges?: Record<string, unknown> } };
      const run = runElement.textRun;
      if (!run || typeof run.content !== 'string') {
        inlineCoordinatesValid = false;
        unsupported.push({ path: `${path}.elements.${runIndex}`, type: 'malformed-text-run', message: 'A Docs text run is missing its text content and cannot preserve inline coordinates' });
        continue;
      }
      const insertions = run.suggestedInsertionIds ?? [];
      const deletions = run.suggestedDeletionIds ?? [];
      const runStart = runElement.startIndex ?? cursor;
      const runEnd = runElement.endIndex ?? runStart + run.content.length;
      if (runStart !== cursor || runEnd - runStart !== run.content.length) {
        inlineCoordinatesValid = false;
        unsupported.push({ path: `${path}.elements.${runIndex}`, type: 'text-index-mismatch', message: 'Docs text run coordinates do not match its UTF-16 text length' });
      }
      cursor = runEnd;
      inlineParts.push(run.content);
      if (run.content.endsWith('\n')) terminalNewlineIndex = runEnd - 1;
      const suggestedTextStyleChanges = (run as { suggestedTextStyleChanges?: Record<string, unknown> }).suggestedTextStyleChanges;
      if (suggestedTextStyleChanges && Object.keys(suggestedTextStyleChanges).length) {
        for (const [suggestionId, style] of Object.entries(suggestedTextStyleChanges)) {
          consumedSuggestionIds.add(suggestionId);
          const supported = supportedTextStyleSuggestion(style);
          const stylePath = `${path}.elements.${runIndex}`;
          suggestions.push({ suggestionId, path: stylePath, type: 'style', text: run.content.replace(/\n$/, ''), startIndex: runStart, endIndex: runEnd, scope: 'text', supported, style });
          if (!supported) unsupported.push({ path: stylePath, type: 'suggested-text-style', message: `Formatting suggestion ${suggestionId} uses a style field that cannot be safely represented` });
        }
      }
      if (insertions.length || deletions.length) {
        if (insertions.length && deletions.length) {
          unsupported.push({ path: `${path}.elements.${runIndex}`, type: 'overlapping-suggestions', message: 'Text marked as both inserted and deleted needs review outside article import' });
        } else {
          const ids = insertions.length ? insertions : deletions;
          const type = insertions.length ? 'insertion' : 'deletion';
          for (const suggestionId of ids) {
            consumedSuggestionIds.add(suggestionId);
            suggestions.push({ suggestionId, path: `${path}.elements.${runIndex}`, type, text: run.content.replace(/\n$/, ''), startIndex: runStart, endIndex: runEnd });
          }
          if (insertions.length) continue;
        }
      }
      const marks: ArticleMark[] = [];
      if (run.textStyle?.bold === true) marks.push({ type: 'bold' });
      if (run.textStyle?.italic === true) marks.push({ type: 'italic' });
      if (run.textStyle?.strikethrough === true) marks.push({ type: 'strike' });
      const unsupportedCommittedStyle = unsupportedCommittedTextStyle(run.textStyle);
      if (unsupportedCommittedStyle) unsupported.push({ path: `${path}.elements.${runIndex}.textStyle.${unsupportedCommittedStyle}`, type: 'unsupported-text-style', message: `Committed Google Docs ${unsupportedCommittedStyle} formatting has no safe article representation` });
      paragraphRuns.push({ run: run.content, start: runStart, end: runEnd, insertion: insertions.length > 0, marks });
    }
    const runs: ArticleNode[] = [];
    let committedText = '';
    for (const [runIndex, row] of paragraphRuns.entries()) {
      let text = row.run;
      // A paragraph's final newline is a Docs structural terminator. Between imported
      // paragraphs it becomes the single article newline added below.
      if (runIndex === paragraphRuns.length - 1 && text.endsWith('\n')) text = text.slice(0, -1);
      if (row.insertion) continue;
      const marks: ArticleMark[] = [];
      marks.push(...row.marks);
      const pieces = text.split('\n');
      pieces.forEach((piece, pieceIndex) => {
        if (piece) { runs.push({ type: 'text', text: piece, ...(marks.length ? { marks } : {}) }); committedText += piece; }
        if (pieceIndex < pieces.length - 1) { runs.push({ type: 'hardBreak' }); committedText += '\n'; }
      });
    }
    const style = paragraph.paragraphStyle ?? {};
    const paragraphSuggestionChanges = (paragraph as { suggestedParagraphStyleChanges?: Record<string, unknown> }).suggestedParagraphStyleChanges
      ?? (style.suggestedParagraphStyleChanges as Record<string, unknown> | undefined);
    if (paragraphSuggestionChanges) {
      for (const [suggestionId, suggestion] of Object.entries(paragraphSuggestionChanges)) {
        consumedSuggestionIds.add(suggestionId);
        suggestions.push({ suggestionId, path: `${path}.paragraphStyle`, type: 'style', text: committedText, startIndex, endIndex: cursor, scope: 'paragraph', supported: false, style: suggestion });
      }
      unsupported.push({ path: `${path}.paragraphStyle`, type: 'suggested-paragraph-style', message: 'Paragraph formatting suggestions remain visible but cannot be safely applied to article text' });
    } else if (hasSuggestedStyleMetadata(style) || hasSuggestedStyleMetadata(paragraph)) {
      unsupported.push({ path: `${path}.paragraphStyle`, type: 'suggested-paragraph-style', message: 'Paragraph formatting suggestions remain visible but cannot be safely applied to article text' });
    }
    const namedStyleType = typeof style.namedStyleType === 'string' ? style.namedStyleType : 'NORMAL_TEXT';
    let node: ArticleNode;
    if (namedStyleType === 'HEADING_2' || namedStyleType === 'HEADING_3') node = { type: 'heading', attrs: { level: namedStyleType === 'HEADING_2' ? 2 : 3 }, content: runs.length ? runs : [{ type: 'text', text: ' ' }] };
    else if (namedStyleType === 'NORMAL_TEXT' || namedStyleType === 'TITLE' || namedStyleType === 'SUBTITLE') node = { type: 'paragraph', ...(runs.length ? { content: runs } : {}) };
    else {
      unsupported.push({ path: `${path}.paragraphStyle.namedStyleType`, type: namedStyleType, message: 'This Google paragraph style has no supported article equivalent' });
      node = { type: 'paragraph', ...(runs.length ? { content: runs } : {}) };
    }
    const indent = style.indentStart;
    const quote = !!indent && typeof indent === 'object' && 'magnitude' in indent && typeof indent.magnitude === 'number' && indent.magnitude > 0;
    const mapRuns: Array<{ remoteStartIndex: number; text: string }> = [];
    paragraphRuns.forEach((row, rowIndex) => {
      if (row.insertion) return;
      let text = row.run;
      if (rowIndex === paragraphRuns.length - 1 && text.endsWith('\n')) text = text.slice(0, -1);
      if (text) mapRuns.push({ remoteStartIndex: row.start, text });
    });
    const paragraphNode = { node, quote, path, committedText, mapRuns, ...(terminalNewlineIndex !== undefined ? { terminalNewlineIndex } : {}) };
    if (paragraph.bullet) {
      if ((paragraph.bullet.nestingLevel ?? 0) !== 0 || !paragraph.bullet.listId) unsupported.push({ path: `${path}.bullet`, type: 'nested-list', message: 'Nested Google Docs list nesting is not supported' });
      const id = paragraph.bullet.listId ?? '';
      const glyph = lists[id]?.listProperties?.nestingLevels?.[0]?.glyphType;
      const kind = glyph && ['DECIMAL', 'ZERO_DECIMAL', 'UPPER_ALPHA', 'ALPHA', 'UPPER_ROMAN', 'ROMAN'].includes(glyph) ? 'ordered' : glyph?.startsWith('BULLET_') ? 'bullet' : undefined;
      if (!kind) unsupported.push({ path: `${path}.bullet`, type: 'list-kind', message: 'Google Docs list kind is missing or unsupported' });
      paragraphNodes.push({ ...paragraphNode, bullet: { id, ...(kind ? { kind } : {}) } });
    } else paragraphNodes.push(paragraphNode);
    expectedRemoteIndex = cursor;
  }

  const rangeMap: GoogleRangeMapSpan[] = [];
  let plainText = '';
  let articleBlockOffset = 0;
  for (const [paragraphIndex, paragraph] of paragraphNodes.entries()) {
    const articleParagraphStart = articleBlockOffset;
    let paragraphMappedLength = 0;
    for (const row of paragraph.mapRuns) {
      if (row.text.length === 0) continue;
      const articleStartOffset = articleParagraphStart + paragraphMappedLength;
      rangeMap.push({ remoteStartIndex: row.remoteStartIndex, remoteEndIndex: row.remoteStartIndex + row.text.length, articleStartOffset, articleEndOffset: articleStartOffset + row.text.length });
      paragraphMappedLength += row.text.length;
    }
    if (paragraphMappedLength !== paragraph.committedText.length) unsupported.push({ path: paragraph.path, type: 'article-range-map-gap', message: 'A committed paragraph contains text that cannot be mapped one-to-one to Docs UTF-16 coordinates' });
    if (paragraphIndex < paragraphNodes.length - 1) {
      // The article contract separates blocks with two LF code units, while
      // Google Docs exposes one paragraph terminator. Map only the first LF;
      // the second is local canonical spacing and remains an intentional gap.
      if (paragraph.terminalNewlineIndex !== undefined) {
        const separatorOffset = articleParagraphStart + paragraph.committedText.length;
        rangeMap.push({ remoteStartIndex: paragraph.terminalNewlineIndex, remoteEndIndex: paragraph.terminalNewlineIndex + 1, articleStartOffset: separatorOffset, articleEndOffset: separatorOffset + 1 });
      }
      else unsupported.push({ path: paragraph.path, type: 'missing-paragraph-terminator', message: 'The Docs paragraph boundary has no text coordinate to map into the article' });
      articleBlockOffset = articleParagraphStart + paragraph.committedText.length + 2;
    } else {
      articleBlockOffset = articleParagraphStart + paragraph.committedText.length;
    }
  }
  plainText = paragraphNodes.map(paragraph => paragraph.committedText).join('\n\n');

  const remoteSuggestionThreads = document.suggestions ?? [];
  for (const thread of remoteSuggestionThreads) {
    if (thread.status === 'OPEN' && !consumedSuggestionIds.has(thread.suggestionId)) unsupported.push({ path: `suggestions.${thread.suggestionId}`, type: 'unmapped-suggestion-thread', message: 'An open Google suggestion is not represented by supported inline text changes in the selected tab' });
  }

  const contentNodes: ArticleNode[] = [];
  for (let index = 0; index < paragraphNodes.length;) {
    const current = paragraphNodes[index]!;
    if (!current.bullet) { contentNodes.push(current.quote ? { type: 'blockquote', content: [current.node] } : current.node); index++; continue; }
    const listId = current.bullet.id;
    const items: ArticleNode[] = [];
    const kind = current.bullet.kind;
    while (index < paragraphNodes.length && paragraphNodes[index]!.bullet?.id === listId && paragraphNodes[index]!.bullet?.kind === kind) {
      const row = paragraphNodes[index]!;
      items.push({ type: 'listItem', content: [row.quote ? { type: 'blockquote', content: [row.node] } : row.node] });
      index++;
    }
    contentNodes.push({ type: kind === 'ordered' ? 'orderedList' : 'bulletList', content: items });
  }

  if (!contentNodes.length) contentNodes.push({ type: 'paragraph' });
  const title = document.title?.trim() || 'Imported document';
  if (title.length > 500) unsupported.push({ path: 'title', type: 'title-too-long', message: 'Google document title exceeds the article title limit' });
  const parsed = articleContentSchema.safeParse({ title: title.length <= 500 ? title : 'Imported document', document: { type: 'doc', content: contentNodes } });
  const firstParagraphStartIndex = children.find(child => child && typeof child === 'object' && 'paragraph' in child) as { startIndex?: number } | undefined;
  const inlineTextStartIndex = firstParagraphStartIndex?.startIndex ?? 1;
  if (!parsed.success) {
    unsupported.push({ path: 'document', type: 'article-schema', message: 'The imported structure does not satisfy the supported article schema' });
    return { tabId, content: { title: title.length <= 500 ? title : 'Imported document', document: { type: 'doc', content: [{ type: 'paragraph' }] } }, suggestions, unsupported, plainText, inlineText: inlineParts.join(''), inlineTextStartIndex, rangeMap, inlineCoordinatesValid };
  }
  const canonicalPlainText = articleDocumentDetails(parsed.data).plainText;
  if (canonicalPlainText !== plainText) {
    inlineCoordinatesValid = false;
    unsupported.push({ path: 'document', type: 'article-plain-text-mismatch', message: 'Imported block text does not match canonical article text and comment offsets cannot be trusted' });
  }
  plainText = canonicalPlainText;
  return { tabId, content: parsed.data, suggestions, unsupported, plainText, inlineText: inlineParts.join(''), inlineTextStartIndex, rangeMap, inlineCoordinatesValid };
}

export interface GoogleRangeResolution {
  startOffset: number;
  endOffset: number;
  text: string;
}

/** Map an inline Docs body range into committed text only when every UTF-16 unit maps exactly. */
export function mapGoogleRangeToArticle(range: GoogleDocsRange, imported: GoogleTabImportResult, plainTextQuote: string): GoogleRangeResolution | null {
  if (!imported.inlineCoordinatesValid || range.tabId !== imported.tabId || range.segmentId !== undefined) return null;
  if (!Number.isSafeInteger(range.startIndex) || !Number.isSafeInteger(range.endIndex) || range.endIndex <= range.startIndex) return null;
  const inlineStart = range.startIndex - imported.inlineTextStartIndex;
  const inlineEnd = range.endIndex - imported.inlineTextStartIndex;
  if (inlineStart < 0 || inlineEnd > imported.inlineText.length) return null;
  const inlineQuote = imported.inlineText.slice(inlineStart, inlineEnd);
  if (!inlineQuote || inlineQuote !== plainTextQuote) return null;

  let remoteCursor = range.startIndex;
  let articleStart: number | undefined;
  let articleEnd: number | undefined;
  for (const span of imported.rangeMap) {
    if (span.remoteEndIndex <= remoteCursor || span.remoteStartIndex >= range.endIndex) continue;
    if (span.remoteStartIndex > remoteCursor) return null;
    const overlapStart = Math.max(remoteCursor, span.remoteStartIndex);
    const overlapEnd = Math.min(range.endIndex, span.remoteEndIndex);
    const mappedStart = span.articleStartOffset + overlapStart - span.remoteStartIndex;
    const mappedEnd = span.articleStartOffset + overlapEnd - span.remoteStartIndex;
    if (articleEnd !== undefined && articleEnd !== mappedStart) return null;
    if (articleStart === undefined) articleStart = mappedStart;
    articleEnd = mappedEnd;
    remoteCursor = overlapEnd;
    if (remoteCursor === range.endIndex) break;
  }
  if (remoteCursor !== range.endIndex || articleStart === undefined || articleEnd === undefined) return null;
  const text = imported.plainText.slice(articleStart, articleEnd);
  if (text !== inlineQuote) return null;
  return { startOffset: articleStart, endOffset: articleEnd, text };
}

/** Return a comment quote only when the full remote range maps to the supplied committed text. */
export function quoteForGoogleRange(plainText: string, range: GoogleDocsRange, context?: { tabId: string; inlineText: string; inlineTextStartIndex: number; rangeMap: GoogleRangeMapSpan[]; inlineCoordinatesValid: boolean; plainTextQuote: string }): string | null {
  if (!context) return null;
  const imported: GoogleTabImportResult = {
    tabId: context.tabId,
    inlineText: context.inlineText,
    inlineTextStartIndex: context.inlineTextStartIndex,
    rangeMap: context.rangeMap,
    inlineCoordinatesValid: context.inlineCoordinatesValid,
    plainText,
    suggestions: [],
    unsupported: [],
    content: { title: 'Anchor lookup', document: { type: 'doc', content: [{ type: 'paragraph' }] } },
  };
  return mapGoogleRangeToArticle(range, imported, context.plainTextQuote)?.text ?? null;
}

function withTab(range: GoogleDocsRange, tabId?: string): GoogleDocsRange {
  return { ...range, ...(range.tabId || !tabId ? {} : { tabId }) };
}

function supportedTextStyleSuggestion(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const style = (value as { textStyle?: unknown }).textStyle;
  const state = (value as { textStyleSuggestionState?: unknown }).textStyleSuggestionState;
  if (!style || typeof style !== 'object' || Array.isArray(style) || !state || typeof state !== 'object' || Array.isArray(state)) return false;
  const supportedFields = new Map<string, string>([
    ['boldSuggested', 'bold'], ['italicSuggested', 'italic'], ['strikethroughSuggested', 'strikethrough'],
  ]);
  const values = style as Record<string, unknown>;
  // Google couples bold with font weight. An absent weightedFontFamily value
  // means no explicit family change; the bold field represents that proposal.
  const changed = Object.entries(state).filter(([field, suggested]) => suggested === true
    && !(field === 'weightedFontFamilySuggested' && !('weightedFontFamily' in values)
      && typeof values['bold'] === 'boolean' && (state as Record<string, unknown>)['boldSuggested'] === true));
  if (!changed.length || changed.some(([field]) => !supportedFields.has(field))) return false;
  return changed.every(([field]) => typeof (style as Record<string, unknown>)[supportedFields.get(field)!] === 'boolean');
}

function findTab(tabs: GoogleDocsDocument['tabs'], tabId: string): GoogleDocsDocument['tabs'][number] | undefined {
  for (const tab of tabs) {
    if (tab.tabProperties.tabId === tabId) return tab;
    const nested = findTab(tab.childTabs ?? [], tabId);
    if (nested) return nested;
  }
  return undefined;
}

function hasSuggestedStyleMetadata(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  return Object.keys(value).some(key => /suggested.*(style|bullet)|(?:style|bullet).*suggestion/i.test(key));
}

function unsupportedCommittedTextStyle(value: unknown): string | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const style = value as Record<string, unknown>;
  if (style.link !== undefined && style.link !== null) return 'link';
  if (style.underline === true) return 'underline';
  if (style.smallCaps === true) return 'smallCaps';
  if (style.baselineOffset !== undefined && style.baselineOffset !== 'NONE') return 'baselineOffset';
  if (style.foregroundColor !== undefined && style.foregroundColor !== null) return 'foregroundColor';
  if (style.backgroundColor !== undefined && style.backgroundColor !== null) return 'backgroundColor';
  return null;
}
