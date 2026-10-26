import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { canonicalManifestHash } from '../jobs/job-service.js';
import { articleDocumentDetails } from '../editorial/article-contracts.js';
import { assembleSourceArticle, sourceOutlineSections } from './writing-article-content.js';
import type { SourceWritingInput } from './writing-contracts.js';

function section() {
  const input: SourceWritingInput = { schemaVersion: 'source-writing-input-v1',requestId: randomUUID(),task: 'SECTION',
    brief: { topic: 'Докази',audience: '',centralMessage: '',category: '',tone: '',targetLength: 50,cta: '',exclusions: [],notes: '' },
    style: { brandbook: '',tone: '',settings: {} },context: [],section: { id: randomUUID(),title: 'Походження',purpose: 'Пояснити',targetWords: 50 },
    passages: [{ id: randomUUID(),packetId: randomUUID(),snapshotId: randomUUID(),quote: 'Оригінальне джерело 😀.' }],requiredClaims: [] };
  const text = 'Пояснення 😀 з посиланням'+' слово'.repeat(46);
  const output = { schemaVersion: 'source-writing-v1',requestId: input.requestId,inputHash: canonicalManifestHash(input),task: input.task,
    status: 'ready',content: { sectionId: input.section!.id,paragraphs: [{ id: randomUUID(),text,citations: [{ kind: 'source_passage',
      passageId: input.passages[0]!.id,quote: 'джерело 😀',assertionText: 'Пояснення 😀' }] }] },
    review: { status: 'ready',issues: [],reasons: [],modelCalls: 2 } };
  return { input,output,text };
}
describe('source-written article composition', () => {
  it('preserves all prose and Unicode assertions as exact source marks', () => {
    const fixture = section(), content = assembleSourceArticle('Назва',[fixture]), details = articleDocumentDetails(content);
    expect(details.plainText).toBe('Походження\n\n'+fixture.text);
    expect(details.sourceMappings).toEqual([{ passageId: fixture.input.passages[0]!.id,packetId: fixture.input.passages[0]!.packetId,
      quote: 'джерело 😀',text: 'Пояснення 😀',locator: 'doc.1.0' }]);
    expect(details.mappings).toEqual([]);
    expect(details.hasUnmapped).toBe(true);
  });
  it('rejects overlapping citations instead of losing one during rich-text assembly', () => {
    const fixture = section(); fixture.output.content.paragraphs[0]!.citations.push({ ...fixture.output.content.paragraphs[0]!.citations[0]! });
    expect(() => assembleSourceArticle('Назва',[fixture])).toThrow(/overlap/u);
  });
  it('normalizes manual outline section identities deterministically and allocates exact total words', () => {
    const id = randomUUID(), content = { title: 'План',sections: [{ title: 'А',purpose: 'Пояснення А',claimRevisionIds: [] },{ title: 'Б',purpose: 'Пояснення Б',claimRevisionIds: [] }] };
    expect(sourceOutlineSections(id,content,51)).toEqual(sourceOutlineSections(id,content,51));
    expect(sourceOutlineSections(id,content,51).sections.map(row => row.targetWords)).toEqual([26,25]);
    expect(() => sourceOutlineSections(id,content,39)).toThrow();
  });
});
