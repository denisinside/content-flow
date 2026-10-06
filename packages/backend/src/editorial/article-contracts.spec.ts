import { describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { articleContentSchema, articleDocumentDetails } from './article-contracts.js';
describe('bounded article document and exact linked wording', () => {
  it('rejects deep input before recursive node validation and forbids executable or unknown editor content', () => {
    let nested: unknown = { type: 'text', text: 'Deep' };
    for (let i = 0; i < 10000; i++) nested = { type: 'blockquote', content: [nested] };
    expect(articleContentSchema.safeParse({ title: 'Title', document: nested }).success).toBe(false);
    for (const node of [{ type: 'image', attrs: { src: 'https://example.com' } }, { type: 'text', text: 'Click', marks: [{ type: 'link', attrs: { href: 'javascript:alert(1)' } }] }, { type: 'heading', attrs: { level: 1 }, content: [] }]) {
      expect(articleContentSchema.safeParse({ title: 'Title', document: { type: 'doc', content: [node] } }).success).toBe(false);
    }
    expect(articleContentSchema.safeParse({ title: 'Title', document: { type: 'doc', content: [] } }).success).toBe(false);
  });
  it('combines contiguous marked text across typography and treats changed wording and the title as separately unverified', () => {
    const attrs = { claimRevisionId: randomUUID(), evidenceId: randomUUID(), quote: 'Linked wording' };
    const content = articleContentSchema.parse({ title: 'Title', document: { type: 'doc', content: [{ type: 'paragraph', content: [
      { type: 'text', text: 'Linked ', marks: [{ type: 'evidence', attrs }] },
      { type: 'text', text: 'wording', marks: [{ type: 'bold' }, { type: 'evidence', attrs }] },
      { type: 'text', text: ' other prose' },
      { type: 'text', text: 'Drifted wording', marks: [{ type: 'evidence', attrs }] },
    ] }] } });
    const detail = articleDocumentDetails(content);
    expect(detail.mappings).toMatchObject([{ text: 'Linked wording', quote: 'Linked wording', locator: 'doc.0.0' }, { text: 'Drifted wording', quote: 'Linked wording', locator: 'doc.0.3' }]);
    expect(detail.hasUnmapped).toBe(true);
    expect(detail.plainText).toBe('Linked wording other proseDrifted wording');
  });
  it('requires valid list item containers and limits evidence spans', () => {
    expect(articleContentSchema.safeParse({ title: 'Title', document: { type: 'doc', content: [{ type: 'bulletList', content: [{ type: 'listItem', content: [{ type: 'heading', attrs: { level: 2 } }] }] }] } }).success).toBe(false);
    const attrs = { claimRevisionId: randomUUID(), evidenceId: randomUUID(), quote: 'Word' };
    const document = { type: 'doc', content: [{ type: 'paragraph', content: Array.from({ length: 201 }, () => ({ type: 'text', text: 'Word', marks: [{ type: 'evidence', attrs }] })) }] };
    expect(articleContentSchema.safeParse({ title: 'Title', document }).success).toBe(false);
  });
});
