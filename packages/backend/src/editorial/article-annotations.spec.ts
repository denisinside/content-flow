import { describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { actArticleAnnotationInput, createArticleAnnotationInput, projectAnchor } from './article-annotations.js';
import { applyInlineReplacement } from './article-annotation.service.js';
import type { ArticleContent } from './article-contracts.js';

describe('article annotations', () => {
  it('validates comment and suggestion payload pairing and article revision for acceptance', () => {
    const base = { articleVersionId: randomUUID(), contentHash: 'a'.repeat(64), anchorStart: 0, anchorEnd: 1, body: 'Review this', commandKey: randomUUID() };
    expect(createArticleAnnotationInput.safeParse({ ...base, kind: 'COMMENT' }).success).toBe(true);
    expect(createArticleAnnotationInput.safeParse({ ...base, kind: 'SUGGESTION' }).success).toBe(false);
    expect(createArticleAnnotationInput.safeParse({ ...base, kind: 'SUGGESTION', replacementText: 'Edit' }).success).toBe(true);
    expect(actArticleAnnotationInput.safeParse({ expectedRevision: 0, action: 'ACCEPT' }).success).toBe(false);
    expect(actArticleAnnotationInput.safeParse({ expectedRevision: 0, action: 'ACCEPT', expectedArticleRevision: 3 }).success).toBe(true);
  });
  it('projects only a unique quote whose saved UTF-16 context still matches', () => {
    expect(projectAnchor('😀 Intro. Selected phrase. End.', 'Selected phrase', '😀 Intro. ', '. End.')).toEqual({ status: 'EXACT', start: 10, end: 25 });
    expect(projectAnchor('Start Selected phrase. Middle Selected phrase. End', 'Selected phrase', '', '')).toEqual({ status: 'UNRESOLVED', start: null, end: null });
    expect(projectAnchor('aaa', 'aa', '', '')).toEqual({ status: 'UNRESOLVED', start: null, end: null });
    expect(projectAnchor('Prefix changed Selected phrase. End', 'Selected phrase', 'old ', '. End')).toEqual({ status: 'UNRESOLVED', start: null, end: null });
  });
  it('keeps unselected formatting, removes evidence from changed text and rejects structural crossings', () => {
    const evidence = { type: 'evidence' as const, attrs: { claimRevisionId: randomUUID(), evidenceId: randomUUID(), quote: 'Selected' } };
    const content: ArticleContent = { title: 'Title', document: { type: 'doc', content: [{ type: 'paragraph', content: [
      { type: 'text', text: 'Before ', marks: [{ type: 'bold' }] },
      { type: 'text', text: 'Selected', marks: [evidence, { type: 'italic' }] },
      { type: 'text', text: ' after', marks: [{ type: 'bold' }] }
    ] }, { type: 'paragraph', content: [{ type: 'text', text: 'Next block' }] }] } };
    const changed = applyInlineReplacement(content, { start: 7, end: 15 }, 'Changed');
    expect(changed.document.content?.[0]?.content).toEqual([
      { type: 'text', text: 'Before ', marks: [{ type: 'bold' }] },
      { type: 'text', text: 'Changed', marks: [{ type: 'italic' }] },
      { type: 'text', text: ' after', marks: [{ type: 'bold' }] }
    ]);
    expect(changed.document.content?.[1]).toEqual(content.document.content?.[1]);
    expect(() => applyInlineReplacement(content, { start: 12, end: 24 }, 'cross')).toThrow(/block boundaries/u);
  });
});
