import { describe, expect, it } from 'vitest';
import { googleTabToArticleContent } from './article-conversion.js';
import {
  buildGoogleSyncPlan,
  extractGoogleThreads,
  mapArticleRangeToGoogle,
  reconcileGoogleCreatedThread,
} from './sync-conversion.js';
import type { GoogleDocsDocument } from './google-docs-client.js';

type Run = { content: string; textStyle?: Record<string, unknown>; suggestedInsertionIds?: string[]; suggestedDeletionIds?: string[]; suggestedTextStyleChanges?: Record<string, unknown> };

function documentWith(paragraphRuns: Run[][], extra: Record<string, unknown> = {}): GoogleDocsDocument {
  let cursor = 1;
  const content = paragraphRuns.map(runs => {
    const startIndex = cursor;
    const elements = runs.map(run => {
      const start = cursor;
      cursor += run.content.length;
      return { startIndex: start, endIndex: cursor, textRun: run };
    });
    if (!runs.at(-1)?.content.endsWith('\n')) {
      const start = cursor++;
      elements.push({ startIndex: start, endIndex: cursor, textRun: { content: '\n' } });
    }
    const row = { startIndex, endIndex: cursor, paragraph: { paragraphStyle: { namedStyleType: 'NORMAL_TEXT' }, elements } };
    return row;
  });
  return {
    documentId: 'doc-1', title: 'Article', revisionId: 'rev-1',
    tabs: [{ tabProperties: { tabId: 'tab-1' }, documentTab: { body: { content } } }],
    comments: [], suggestions: [], ...extra,
  } as unknown as GoogleDocsDocument;
}

function article(paragraphs: string[]) {
  return { title: 'Article', document: { type: 'doc' as const, content: paragraphs.map(text => ({ type: 'paragraph' as const, content: [{ type: 'text' as const, text }] })) } };
}

describe('Google Docs sync conversion', () => {
  it('uses the existing EDIT converter only for an empty selected tab', () => {
    const blank = documentWith([[]]);
    const plan = buildGoogleSyncPlan(blank, 'tab-1', article(['First', 'Second']), 'PUSH');
    expect(plan.writeMode).toBe('EDIT');
    expect(plan.requests).toContainEqual({ insertText: { location: { index: 1, tabId: 'tab-1' }, text: 'First\nSecond' } });
    expect(plan.requests.some(request => 'deleteContentRange' in request)).toBe(false);
    expect(plan.expectedPlainText).toBe('First\n\nSecond');
    expect(plan.hasChanges).toBe(true);
  });

  it('uses one minimal SUGGEST replacement with UTF-16-safe emoji boundaries', () => {
    const document = documentWith([[{ content: 'Hello 😀 world' }]]);
    const plan = buildGoogleSyncPlan(document, 'tab-1', article(['Hello 🌎 world']), 'PUSH');
    expect(plan.writeMode).toBe('SUGGEST');
    expect(plan.requests).toEqual([
      { deleteContentRange: { range: { startIndex: 7, endIndex: 9, tabId: 'tab-1' } } },
      { insertText: { location: { index: 7, tabId: 'tab-1' }, text: '🌎' } },
    ]);
    expect(plan.expectedSuggestionParts).toEqual([
      { type: 'deletion', text: '😀', startIndex: 7, endIndex: 9, tabId: 'tab-1' },
      { type: 'insertion', text: '🌎', startIndex: 7, endIndex: 9, tabId: 'tab-1' },
    ]);
  });

  it('maps a later-paragraph edit through imported ranges without replacing the whole body', () => {
    const document = documentWith([[{ content: 'First' }], [{ content: 'Second' }]]);
    const plan = buildGoogleSyncPlan(document, 'tab-1', article(['First', 'Changed']), 'PUSH');
    expect(plan.writeMode).toBe('SUGGEST');
    expect(plan.requests).toEqual([
      { deleteContentRange: { range: { startIndex: 7, endIndex: 12, tabId: 'tab-1' } } },
      { insertText: { location: { index: 7, tabId: 'tab-1' }, text: 'Change' } },
    ]);
    expect(plan.expectedPlainText).toBe('First\n\nChanged');
  });

  it('maps only exact continuous quoted article ranges back to the selected tab', () => {
    const imported = googleTabToArticleContent(documentWith([[{ content: 'A😀B' }]]), 'tab-1');
    expect(mapArticleRangeToGoogle(imported, 1, 3, '😀')).toEqual({ startIndex: 2, endIndex: 4, tabId: 'tab-1' });
    expect(mapArticleRangeToGoogle(imported, 1, 2, '😀')).toBeNull();
    expect(mapArticleRangeToGoogle(imported, 1, 3, 'wrong')).toBeNull();
    expect(mapArticleRangeToGoogle(imported, 0, 5, 'A😀B\n')).toBeNull();
  });

  it('blocks a text patch overlapping a pending suggestion but keeps an identical committed no-op', () => {
    const document = documentWith([[{ content: 'Hello' }, { content: 'X', suggestedInsertionIds: ['s-insert'] }]], {
      suggestions: [{ suggestionId: 's-insert', headPost: { postId: 'p1' }, replies: [], status: 'OPEN', summaryText: 'X' }],
    });
    const blocked = buildGoogleSyncPlan(document, 'tab-1', article(['HelloY']), 'PUSH');
    expect(blocked.requests).toEqual([]);
    expect(blocked.unsupported).toMatchObject([{ type: 'overlapping-pending-suggestion' }]);
    const noOp = buildGoogleSyncPlan(document, 'tab-1', article(['Hello']), 'PUSH');
    expect(noOp).toMatchObject({ requests: [], hasChanges: false, unsupported: [] });

    const styled = documentWith(
      [[{ content: 'Hello', suggestedTextStyleChanges: { style1: { textStyle: { bold: true }, textStyleSuggestionState: { boldSuggested: true } } } }]],
      { suggestions: [{ suggestionId: 'style1', headPost: { postId: 'p1' }, replies: [], status: 'OPEN', summaryText: 'bold' }] },
    );
    const styleBlocked = buildGoogleSyncPlan(styled, 'tab-1', article(['Xello']), 'PUSH');
    expect(styleBlocked.requests).toEqual([]);
    expect(styleBlocked.unsupported).toMatchObject([{ type: 'overlapping-pending-suggestion' }]);
  });

  it('retains grouped suggestion parts and unsupported structures as explicit blockers', () => {
    const grouped = documentWith([[{ content: 'ab', suggestedInsertionIds: ['s1'] }, { content: 'cd', suggestedInsertionIds: ['s1'] }]], {
      suggestions: [{ suggestionId: 's1', headPost: { postId: 'p1' }, replies: [], status: 'OPEN', summaryText: 'abcd' }],
    });
    const threads = extractGoogleThreads(grouped, 'tab-1');
    expect(threads[0]).toMatchObject({ kind: 'suggestion', remoteId: 's1', anchorStatus: 'anchored', suggestionParts: [{ text: 'ab' }, { text: 'cd' }] });

    const unsupported = documentWith([[]]);
    (unsupported.tabs[0]!.documentTab.body as { content: unknown[] }).content = [{ table: {} }];
    const blocked = buildGoogleSyncPlan(unsupported, 'tab-1', article(['Target']), 'PUSH');
    expect(blocked.requests).toEqual([]);
    expect(blocked.unsupported).toMatchObject([{ type: 'non-paragraph-structural-element' }]);
  });

  it('retains unanchored native threads and reconciles only one exact new ID', () => {
    const document = documentWith([[{ content: 'A😀B' }]], {
      comments: [{
        commentId: 'comment-1', anchorId: 'anchor-1', status: 'OPEN', plainTextQuote: '😀',
        headPost: { postId: 'post-1', content: 'Check', author: { displayName: 'Editor', user: 'users/1' }, createTime: '2026-10-11T08:00:00Z' },
        replies: [{ postId: 'post-2', content: 'Reply' }],
      }],
    });
    const selectedTab = document.tabs[0]!.documentTab as unknown as { commentAnchors: Record<string, unknown> };
    selectedTab.commentAnchors = { 'anchor-1': { anchorId: 'anchor-1', ranges: [{ startIndex: 2, endIndex: 4, tabId: 'tab-1' }] } };
    const before = extractGoogleThreads(document, 'tab-1');
    expect(before[0]).toMatchObject({ anchorStatus: 'anchored', quoteText: '😀', author: { displayName: 'Editor' }, posts: [{ postId: 'post-1' }, { postId: 'post-2' }] });

    selectedTab.commentAnchors = { 'anchor-1': { anchorId: 'anchor-1', ranges: [{ startIndex: 2, endIndex: 4, tabId: 'another-tab' }] } };
    const unanchored = extractGoogleThreads(document, 'tab-1');
    expect(unanchored).toEqual([]);
    selectedTab.commentAnchors = { 'anchor-1': { anchorId: 'anchor-1', ranges: [{ startIndex: 2, endIndex: 4, tabId: 'tab-1', segmentId: 'header-1' }] } };
    expect(extractGoogleThreads(document, 'tab-1')[0]).toMatchObject({ remoteId: 'comment-1', anchorStatus: 'unanchored' });

    const newThread = { ...before[0]!, remoteId: 'comment-2', payload: { ...before[0]!.payload, commentId: 'comment-2' } };
    const expected = { kind: 'comment' as const, status: 'OPEN', content: 'Check', quoteText: '😀', ranges: [{ startIndex: 2, endIndex: 4, tabId: 'tab-1' }] };
    expect(reconcileGoogleCreatedThread(before, [...before, newThread], expected)).toMatchObject({ outcome: 'MATCHED', thread: { remoteId: 'comment-2' } });
    expect(reconcileGoogleCreatedThread(before, [...before, newThread], { ...expected, content: 'different' })).toEqual({ outcome: 'UNKNOWN', matchCount: 0 });
    expect(reconcileGoogleCreatedThread(before, before, expected)).toEqual({ outcome: 'UNKNOWN', matchCount: 0 });
    expect(reconcileGoogleCreatedThread(before, [...before, newThread, { ...newThread, remoteId: 'comment-3' }], expected)).toEqual({ outcome: 'UNKNOWN', matchCount: 2 });
  });

  it('retains supported style changes as suggestion parts and unsupported styles as visible blockers', () => {
    const supported = documentWith([[{
      content: 'word', suggestedTextStyleChanges: { style1: { textStyle: { bold: true }, textStyleSuggestionState: { boldSuggested: true } } },
    }]], { suggestions: [{ suggestionId: 'style1', headPost: { postId: 'p1' }, replies: [], status: 'OPEN', summaryText: 'bold' }] });
    const imported = googleTabToArticleContent(supported, 'tab-1');
    expect(imported.suggestions).toMatchObject([{ suggestionId: 'style1', type: 'style', scope: 'text', supported: true }]);
    expect(imported.unsupported).toEqual([]);

    const unsupported = documentWith([[{
      content: 'word', suggestedTextStyleChanges: { style2: { textStyle: { foregroundColor: { color: { rgbColor: { red: 1 } } } }, textStyleSuggestionState: { foregroundColorSuggested: true } } },
    }]], { suggestions: [{ suggestionId: 'style2', headPost: { postId: 'p2' }, replies: [], status: 'OPEN', summaryText: 'color' }] });
    const unsupportedImport = googleTabToArticleContent(unsupported, 'tab-1');
    expect(unsupportedImport.suggestions).toMatchObject([{ suggestionId: 'style2', type: 'style', supported: false }]);
    expect(unsupportedImport.unsupported).toMatchObject([{ type: 'suggested-text-style' }]);
  });

  it('suggests same-text inline and paragraph formatting changes with exact ranges', () => {
    const document = documentWith([[{ content: 'word' }]]);
    const boldTarget = { title: 'Article', document: { type: 'doc' as const, content: [{ type: 'paragraph' as const, content: [{ type: 'text' as const, text: 'word', marks: [{ type: 'bold' as const }] }] }] } };
    const boldPlan = buildGoogleSyncPlan(document, 'tab-1', boldTarget, 'PUSH');
    expect(boldPlan.writeMode).toBe('SUGGEST');
    expect(boldPlan.requests).toContainEqual({ updateTextStyle: { range: { startIndex: 1, endIndex: 5, tabId: 'tab-1' }, textStyle: { bold: true }, fields: 'bold' } });
    expect(boldPlan.expectedSuggestionParts).toContainEqual({ type: 'style', field: 'bold', value: true, scope: 'text', startIndex: 1, endIndex: 5, tabId: 'tab-1' });

    const headingTarget = { title: 'Article', document: { type: 'doc' as const, content: [{ type: 'heading' as const, attrs: { level: 2 as const }, content: [{ type: 'text' as const, text: 'word' }] }] } };
    const headingPlan = buildGoogleSyncPlan(document, 'tab-1', headingTarget, 'PUSH');
    expect(headingPlan.requests).toContainEqual({ updateParagraphStyle: { range: { startIndex: 1, endIndex: 5, tabId: 'tab-1' }, paragraphStyle: { namedStyleType: 'HEADING_2' }, fields: 'namedStyleType' } });

    const quoteTarget = { title: 'Article', document: { type: 'doc' as const, content: [{ type: 'blockquote' as const, content: [{ type: 'paragraph' as const, content: [{ type: 'text' as const, text: 'word' }] }] }] } };
    const quotePlan = buildGoogleSyncPlan(document, 'tab-1', quoteTarget, 'PUSH');
    expect(quotePlan.requests).toContainEqual({ updateParagraphStyle: { range: { startIndex: 1, endIndex: 5, tabId: 'tab-1' }, paragraphStyle: { indentStart: { magnitude: 36, unit: 'PT' } }, fields: 'indentStart' } });

    const listTarget = { title: 'Article', document: { type: 'doc' as const, content: [{ type: 'bulletList' as const, content: [{ type: 'listItem' as const, content: [{ type: 'paragraph' as const, content: [{ type: 'text' as const, text: 'word' }] }] }] }] } };
    const listPlan = buildGoogleSyncPlan(document, 'tab-1', listTarget, 'PUSH');
    expect(listPlan.requests).toContainEqual({ createParagraphBullets: { range: { startIndex: 1, endIndex: 5, tabId: 'tab-1' }, bulletPreset: 'BULLET_DISC_CIRCLE_SQUARE' } });

    const pending = documentWith([[{
      content: 'word', suggestedTextStyleChanges: { pendingStyle: { textStyle: { bold: true }, textStyleSuggestionState: { boldSuggested: true } } },
    }]], { suggestions: [{ suggestionId: 'pendingStyle', headPost: { postId: 'pending-post' }, replies: [], status: 'OPEN', summaryText: 'bold' }] });
    const overlapping = buildGoogleSyncPlan(pending, 'tab-1', boldTarget, 'PUSH');
    expect(overlapping.requests).toEqual([]);
    expect(overlapping.unsupported).toMatchObject([{ type: 'overlapping-pending-suggestion' }]);
  });

  it('blocks formatting changes in the same batch as a text replacement', () => {
    const document = documentWith([[{ content: 'word' }]]);
    const target = { title: 'Article', document: { type: 'doc' as const, content: [{ type: 'paragraph' as const, content: [{ type: 'text' as const, text: 'new', marks: [{ type: 'italic' as const }] }] }] } };
    const plan = buildGoogleSyncPlan(document, 'tab-1', target, 'PUSH');
    expect(plan.requests).toEqual([]);
    expect(plan.unsupported).toMatchObject([{ type: 'mixed-text-formatting-change' }]);
  });

  it('blocks article sync when the selected tab contains a committed hyperlink it cannot preserve', () => {
    const document = documentWith([[{ content: 'word', textStyle: { link: { url: 'https://example.com' } } }]]);
    const plan = buildGoogleSyncPlan(document, 'tab-1', article(['changed']), 'PUSH');
    expect(plan.requests).toEqual([]);
    expect(plan.unsupported).toMatchObject([{ type: 'unsupported-text-style', path: 'tab.tab-1.body.0.elements.0.textStyle.link' }]);
  });

  it('filters only threads proven to belong to another tab', () => {
    const document = documentWith([[{ content: 'selected' }]], {
      comments: [{ commentId: 'other-comment', anchorId: 'other-anchor', status: 'OPEN', plainTextQuote: 'remote', headPost: { postId: 'p1' }, replies: [] }],
      suggestions: [{ suggestionId: 'other-suggestion', headPost: { postId: 'p2' }, replies: [], status: 'OPEN', summaryText: 'remote' }],
    });
    const mutable = document as unknown as { tabs: Array<Record<string, unknown>> };
    mutable.tabs.push({ tabProperties: { tabId: 'tab-2' }, documentTab: {
      body: { content: [{ paragraph: { elements: [{ textRun: { content: 'remote', suggestedInsertionIds: ['other-suggestion'] } }] } }] },
      commentAnchors: { 'other-anchor': { anchorId: 'other-anchor', ranges: [{ startIndex: 1, endIndex: 7, tabId: 'tab-2' }] } },
    } });
    expect(extractGoogleThreads(document, 'tab-1')).toEqual([]);
    const ambiguous = documentWith([[{ content: 'selected' }]], {
      comments: [{ commentId: 'unknown-comment', status: 'OPEN', headPost: { postId: 'p3' }, replies: [] }],
      suggestions: [{ suggestionId: 'unknown-suggestion', headPost: { postId: 'p4' }, replies: [], status: 'OPEN', summaryText: 'unknown' }],
    });
    expect(extractGoogleThreads(ambiguous, 'tab-1').map(thread => thread.remoteId)).toEqual(['unknown-comment', 'unknown-suggestion']);
  });
});
