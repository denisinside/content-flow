import { describe, expect, it } from 'vitest';
import { articleContentToGoogleRequests, googleTabToArticleContent, mapGoogleRangeToArticle, quoteForGoogleRange } from './article-conversion.js';
import type { GoogleDocsDocument } from './google-docs-client.js';

describe('Google Docs article conversion', () => {
  it('compiles Ukrainian and emoji text with UTF-16 ranges and supported formatting', () => {
    const result = articleContentToGoogleRequests({
      title: 'Заголовок',
      document: { type: 'doc', content: [
        { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'Привіт 😀' }] },
        { type: 'paragraph', content: [{ type: 'text', text: 'Світ', marks: [{ type: 'bold' }, { type: 'evidence', attrs: { claimRevisionId: '00000000-0000-4000-8000-000000000001', evidenceId: '00000000-0000-4000-8000-000000000002', quote: 'Світ' } }] }] },
      ] },
    }, { tabId: 'tab-a', startIndex: 1 });
    expect(result.unsupported).toEqual([]);
    expect(result.plainText).toBe('Привіт 😀\nСвіт');
    expect(result.ranges).toEqual([
      { path: 'doc.0', startIndex: 1, endIndex: 10, text: 'Привіт 😀' },
      { path: 'doc.1', startIndex: 11, endIndex: 15, text: 'Світ' },
    ]);
    expect(result.omittedEvidenceMarks).toBe(1);
    expect(result.requests[0]).toMatchObject({ insertText: { location: { index: 1, tabId: 'tab-a' }, text: 'Привіт 😀\nСвіт' } });
    expect(result.requests).toContainEqual({ updateParagraphStyle: { range: { startIndex: 1, endIndex: 11, tabId: 'tab-a' }, paragraphStyle: { namedStyleType: 'HEADING_2' }, fields: 'namedStyleType' } });
    expect(result.requests).toContainEqual({ updateTextStyle: { range: { startIndex: 11, endIndex: 15, tabId: 'tab-a' }, textStyle: { bold: true }, fields: 'bold' } });
  });

  it('fails closed with an explicit issue for unsupported nested list structures', () => {
    const article = {
      title: 'T', document: { type: 'doc', content: [{ type: 'bulletList', content: [{ type: 'listItem', content: [
        { type: 'paragraph', content: [{ type: 'text', text: 'пункт' }] },
        { type: 'bulletList', content: [{ type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'вкладений' }] }] }] },
      ] }] }] },
    };
    const result = articleContentToGoogleRequests(article);
    expect(result.requests).toEqual([]);
    expect(result.unsupported).toMatchObject([{ type: 'nested-or-multiblock-list-item' }]);
  });

  it('imports committed paragraphs and keeps unresolved insertion/deletion IDs separate', () => {
    const document = {
      documentId: 'doc', title: 'Нотатка', revisionId: 'rev', comments: [], suggestions: [],
      tabs: [{ tabProperties: { tabId: 'tab-a' }, documentTab: { lists: {}, body: { content: [
        { startIndex: 1, endIndex: 11, paragraph: { paragraphStyle: { namedStyleType: 'NORMAL_TEXT' }, elements: [
          { startIndex: 1, endIndex: 10, textRun: { content: 'Привіт 😀', textStyle: { bold: true } } },
          { startIndex: 10, endIndex: 11, textRun: { content: '\n' } },
        ] } },
        { startIndex: 11, endIndex: 17, paragraph: { paragraphStyle: { namedStyleType: 'NORMAL_TEXT' }, elements: [
          { startIndex: 11, endIndex: 14, textRun: { content: 'нов', suggestedInsertionIds: ['s-insert'] } },
          { startIndex: 14, endIndex: 17, textRun: { content: 'ий\n', suggestedDeletionIds: ['s-delete'] } },
        ] } },
      ] } } }],
    } as unknown as GoogleDocsDocument;
    const result = googleTabToArticleContent(document, 'tab-a');
    expect(result.content.title).toBe('Нотатка');
    expect(result.content.document.content?.[0]).toMatchObject({ type: 'paragraph', content: [{ type: 'text', text: 'Привіт 😀', marks: [{ type: 'bold' }] }] });
    expect(result.suggestions).toEqual([
      { suggestionId: 's-insert', path: 'tab.tab-a.body.1.elements.0', type: 'insertion', text: 'нов', startIndex: 11, endIndex: 14 },
      { suggestionId: 's-delete', path: 'tab.tab-a.body.1.elements.1', type: 'deletion', text: 'ий', startIndex: 14, endIndex: 17 },
    ]);
    expect(result.plainText).toBe('Привіт 😀\n\nий');
    expect(result.inlineText).toBe('Привіт 😀\nновий\n');
    expect(result.rangeMap).toContainEqual({ remoteStartIndex: 14, remoteEndIndex: 16, articleStartOffset: 11, articleEndOffset: 13 });
    expect(result.unsupported).toEqual([]);
    expect(mapGoogleRangeToArticle({ startIndex: 14, endIndex: 16, tabId: 'tab-a' }, result, 'ий')).toEqual({ startOffset: 11, endOffset: 13, text: 'ий' });
    expect(mapGoogleRangeToArticle({ startIndex: 11, endIndex: 14, tabId: 'tab-a' }, result, 'нов')).toBeNull();
    expect(mapGoogleRangeToArticle({ startIndex: 10, endIndex: 14, tabId: 'tab-a' }, result, '\nнов')).toBeNull();
  });

  it('marks committed links and other unrepresentable inline formatting unsupported', () => {
    const document = {
      documentId: 'doc', title: 'T', revisionId: 'r', comments: [], suggestions: [],
      tabs: [{ tabProperties: { tabId: 't' }, documentTab: { body: { content: [{
        startIndex: 1, endIndex: 6,
        paragraph: { paragraphStyle: { namedStyleType: 'NORMAL_TEXT' }, elements: [
          { startIndex: 1, endIndex: 5, textRun: { content: 'link', textStyle: { link: { url: 'https://example.com' } } } },
          { startIndex: 5, endIndex: 6, textRun: { content: '\n' } },
        ] },
      }] } } }],
    } as unknown as GoogleDocsDocument;
    const imported = googleTabToArticleContent(document, 't');
    expect(imported.unsupported).toMatchObject([{ type: 'unsupported-text-style', path: 'tab.t.body.0.elements.0.textStyle.link' }]);
  });

  it('accepts only the required leading section break and keeps body ranges at index 1', () => {
    const document = {
      documentId: 'doc', title: 'Реальний документ', revisionId: 'rev', comments: [], suggestions: [],
      tabs: [{ tabProperties: { tabId: 'tab-a' }, documentTab: { body: { content: [
        { endIndex: 1, sectionBreak: { sectionStyle: {} } },
        { startIndex: 1, endIndex: 11, paragraph: { paragraphStyle: { namedStyleType: 'NORMAL_TEXT' }, elements: [
          { startIndex: 1, endIndex: 10, textRun: { content: 'Привіт 😀' } },
          { startIndex: 10, endIndex: 11, textRun: { content: '\n' } },
        ] } },
      ] } } }],
    } as unknown as GoogleDocsDocument;
    const result = googleTabToArticleContent(document, 'tab-a');
    expect(result.inlineCoordinatesValid).toBe(true);
    expect(result.inlineTextStartIndex).toBe(1);
    expect(result.inlineText).toBe('Привіт 😀\n');
    expect(result.plainText).toBe('Привіт 😀');
    expect(result.unsupported).toEqual([]);
    expect(mapGoogleRangeToArticle({ startIndex: 8, endIndex: 10, tabId: 'tab-a' }, result, '😀')).toEqual({ startOffset: 7, endOffset: 9, text: '😀' });
  });

  it('fails closed for a later section break or a suggested leading boundary', () => {
    const makeDocument = (content: unknown[]) => ({
      documentId: 'doc', title: 'T', revisionId: 'r', comments: [], suggestions: [],
      tabs: [{ tabProperties: { tabId: 't' }, documentTab: { body: { content } } }],
    }) as unknown as GoogleDocsDocument;
    const paragraph = { startIndex: 1, endIndex: 3, paragraph: { elements: [{ startIndex: 1, endIndex: 3, textRun: { content: 'x\n' } }] } };
    const laterBreak = googleTabToArticleContent(makeDocument([
      { startIndex: 0, endIndex: 1, sectionBreak: { sectionStyle: {} } },
      paragraph,
      { startIndex: 3, endIndex: 4, sectionBreak: { sectionStyle: {} } },
    ]), 't');
    expect(laterBreak.inlineCoordinatesValid).toBe(false);
    expect(laterBreak.unsupported).toMatchObject([{ type: 'unsupported-section-break' }]);

    const suggestedBreak = googleTabToArticleContent(makeDocument([
      { startIndex: 0, endIndex: 1, sectionBreak: { sectionStyle: {}, suggestedInsertionIds: ['s1'] } },
      paragraph,
    ]), 't');
    expect(suggestedBreak.inlineCoordinatesValid).toBe(false);
    expect(suggestedBreak.unsupported).toMatchObject([{ type: 'unsupported-section-break' }]);
  });

  it('rejects unsupported tables explicitly and maps quotes only with exact tab, segment and committed range context', () => {
    const document = { documentId: 'doc', title: 'T', revisionId: 'r', tabs: [{ tabProperties: { tabId: 't' }, documentTab: { body: { content: [{ table: {} }] } } }], comments: [], suggestions: [] } as unknown as GoogleDocsDocument;
    const imported = googleTabToArticleContent(document, 't');
    expect(imported.unsupported).toMatchObject([{ type: 'non-paragraph-structural-element' }]);
    expect(imported.inlineCoordinatesValid).toBe(false);
    const context = { tabId: 't', inlineText: 'Привіт 😀', inlineTextStartIndex: 1, rangeMap: [{ remoteStartIndex: 1, remoteEndIndex: 10, articleStartOffset: 0, articleEndOffset: 9 }], inlineCoordinatesValid: true, plainTextQuote: '😀' };
    expect(quoteForGoogleRange('Привіт 😀', { startIndex: 8, endIndex: 10, tabId: 't' }, context)).toBe('😀');
    expect(quoteForGoogleRange('Привіт 😀', { startIndex: 8, endIndex: 10, tabId: 'other' }, context)).toBeNull();
    expect(quoteForGoogleRange('Привіт 😀', { startIndex: 8, endIndex: 10, tabId: 't', segmentId: 'header-1' }, context)).toBeNull();
    expect(quoteForGoogleRange('Привіт 😀', { startIndex: 500, endIndex: 502, tabId: 't' }, context)).toBeNull();
    expect(quoteForGoogleRange('дубль 😀 і ще 😀', { startIndex: 8, endIndex: 10, tabId: 't' }, { ...context, plainTextQuote: 'не той quote' })).toBeNull();
  });

  it('invalidates all comment anchors when an inline object is omitted before later text', () => {
    const document = {
      documentId: 'doc', title: 'T', revisionId: 'r', comments: [], suggestions: [],
      tabs: [{ tabProperties: { tabId: 't' }, documentTab: { body: { content: [{
        startIndex: 1, endIndex: 5,
        paragraph: { paragraphStyle: { namedStyleType: 'NORMAL_TEXT' }, elements: [
          { startIndex: 1, endIndex: 2, textRun: { content: 'А' } },
          { startIndex: 2, endIndex: 3, inlineObjectElement: { inlineObjectId: 'object-1' } },
          { startIndex: 3, endIndex: 5, textRun: { content: 'Б\n' } },
        ] },
      }] } } }],
    } as unknown as GoogleDocsDocument;
    const result = googleTabToArticleContent(document, 't');
    expect(result.unsupported).toEqual(expect.arrayContaining([expect.objectContaining({ type: 'non-text-element' })]));
    expect(result.inlineCoordinatesValid).toBe(false);
    expect(mapGoogleRangeToArticle({ startIndex: 3, endIndex: 4, tabId: 't' }, result, 'Б')).toBeNull();
  });

  it('reports open suggestions whose changes are only formatting or absent from inline text', () => {
    const document = {
      documentId: 'doc', title: 'T', revisionId: 'r',
      suggestions: [
        { suggestionId: 'style-1', headPost: { postId: 'p1' }, status: 'OPEN', summaryText: 'bold' },
        { suggestionId: 'unknown-1', headPost: { postId: 'p2' }, status: 'OPEN', summaryText: 'unknown change' },
      ],
      tabs: [{
        tabProperties: { tabId: 't' },
        documentTab: {
          lists: {},
          body: { content: [{
            startIndex: 1, endIndex: 7,
            paragraph: {
              paragraphStyle: { namedStyleType: 'NORMAL_TEXT', suggestedParagraphStyleChanges: { 'style-1': { namedStyleType: 'HEADING_2' } } },
              elements: [
                { startIndex: 1, endIndex: 6, textRun: { content: 'слово', suggestedTextStyleChanges: { 'style-1': { bold: true } } } },
                { startIndex: 6, endIndex: 7, textRun: { content: '\n' } },
              ],
            },
          }] },
        },
      }],
    } as unknown as GoogleDocsDocument;
    const result = googleTabToArticleContent(document, 't');
    expect(result.unsupported).toMatchObject([
      { type: 'suggested-text-style' },
      { type: 'suggested-paragraph-style' },
      { type: 'unmapped-suggestion-thread', path: 'suggestions.unknown-1' },
    ]);
  });

  it('represents Google bold with an inherited font-weight side effect but blocks explicit font changes', () => {
    const style: Record<string, unknown> = { bold: true };
    const document = { documentId: 'doc', title: 'T', revisionId: 'r', tabs: [{ tabProperties: { tabId: 't' }, documentTab: {
      body: { content: [{ startIndex: 1, endIndex: 3, paragraph: { elements: [
        { startIndex: 1, endIndex: 2, textRun: { content: 'A', suggestedTextStyleChanges: { s: { textStyle: style,
          textStyleSuggestionState: { boldSuggested: true, weightedFontFamilySuggested: true } } } } },
        { startIndex: 2, endIndex: 3, textRun: { content: '\n' } },
      ] } }] },
    } }] } as unknown as GoogleDocsDocument;
    expect(googleTabToArticleContent(document, 't').suggestions[0]).toMatchObject({ type: 'style', supported: true });
    style['weightedFontFamily'] = { fontFamily: 'Comic Sans MS' };
    expect(googleTabToArticleContent(document, 't').suggestions[0]).toMatchObject({ type: 'style', supported: false });
  });

  it('uses selected-tab list metadata and imports an ordered list', () => {
    const document = {
      documentId: 'doc', title: 'T', revisionId: 'r', lists: { list: { listProperties: { nestingLevels: [{ glyphType: 'BULLET_DISC' }] } } },
      tabs: [{ tabProperties: { tabId: 't' }, documentTab: {
        lists: { ordered: { listProperties: { nestingLevels: [{ glyphType: 'DECIMAL' }] } } },
        body: { content: [
          { startIndex: 1, endIndex: 3, paragraph: { bullet: { listId: 'ordered', nestingLevel: 0 }, paragraphStyle: { namedStyleType: 'NORMAL_TEXT' }, elements: [{ startIndex: 1, endIndex: 2, textRun: { content: 'А' } }, { startIndex: 2, endIndex: 3, textRun: { content: '\n' } }] } },
          { startIndex: 3, endIndex: 5, paragraph: { bullet: { listId: 'ordered', nestingLevel: 0 }, paragraphStyle: { namedStyleType: 'NORMAL_TEXT' }, elements: [{ startIndex: 3, endIndex: 4, textRun: { content: 'Б' } }, { startIndex: 4, endIndex: 5, textRun: { content: '\n' } }] } },
        ] },
      } }],
    } as unknown as GoogleDocsDocument;
    const result = googleTabToArticleContent(document, 't');
    expect(result.content.document.content?.[0]).toMatchObject({ type: 'orderedList', content: [{ type: 'listItem' }, { type: 'listItem' }] });
    expect(result.unsupported).toEqual([]);
  });
});
