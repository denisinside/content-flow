import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { canonicalManifestHash } from '../jobs/job-service.js';
import { sourceWritingInputSchema, validateSourceWritingOutput, type SourceWritingInput } from './writing-contracts.js';

function input(task: 'OUTLINE' | 'SECTION' = 'OUTLINE'): SourceWritingInput {
  return sourceWritingInputSchema.parse({ schemaVersion: 'source-writing-input-v1', requestId: randomUUID(), task,
    brief: { topic: 'Сховище доказів', audience: 'Автори', centralMessage: 'Дані мають джерело', category: 'Техніка',
      tone: '', targetLength: 100, cta: '', exclusions: [], notes: '' }, style: { brandbook: '', tone: '', settings: {} }, context: [],
    ...(task === 'SECTION' ? { section: { id: randomUUID(), title: 'Докази', purpose: 'Пояснення', targetWords: 100 } } : {}),
    passages: [{ id: randomUUID(), packetId: randomUUID(), snapshotId: randomUUID(), quote: 'Точна цитата 😀 з першоджерела.' }], requiredClaims: [] });
}
function outline(request: SourceWritingInput) {
  return { schemaVersion: 'source-writing-v1', requestId: request.requestId, inputHash: canonicalManifestHash(request), task: request.task,
    status: 'ready', content: { title: 'Докази', sections: [{ id: randomUUID(), title: 'Джерела', purpose: 'Пояснити походження',
      targetWords: 100, passageIds: [request.passages[0]!.id], requiredClaimRevisionIds: [] }] },
    review: { status: 'ready', issues: [], reasons: [], modelCalls: 2 } };
}
function section(request: SourceWritingInput) {
  const assertionText = 'Твердження про джерела 😀';
  return { ...outline(request), content: { sectionId: request.section!.id, paragraphs: [{ id: randomUUID(),
    text: assertionText + ' слово'.repeat(96), citations: [{ kind: 'source_passage', passageId: request.passages[0]!.id,
      quote: 'Точна цитата 😀', assertionText }] }] } };
}
describe('source writing acceptance boundary', () => {
  it('accepts supported outline without generating an approved claim catalogue', () => {
    const request = input();
    expect(validateSourceWritingOutput(outline(request), request).status).toBe('ready');
    expect(request.requiredClaims).toEqual([]);
  });
  it('assigns a stable UUID to a model-owned outline label with a non-RFC variant', () => {
    const request = input();
    const output = outline(request);
    const label = 'c3d4e5f6-a7b8-4c3d-0e4f-5a6b7c8d9e0f';
    output.content.sections[0]!.id = label;
    const withReview = { ...output, review: { ...output.review,
      issues: [{ id: 'minor', severity: 'minor', sectionId: label, reason: 'Уточнити назву' }] } };
    const parsed = validateSourceWritingOutput(withReview, request);
    if (!parsed.content || !('sections' in parsed.content)) throw new Error('Expected a ready outline');
    const section = parsed.content.sections[0]!;
    expect(z.uuid().safeParse(section.id).success).toBe(true);
    expect(section.id).not.toBe(label);
    expect(parsed.review.issues[0]?.sectionId).toBe(section.id);
    expect(section.passageIds).toEqual([request.passages[0]!.id]);
    expect(validateSourceWritingOutput(parsed, request)).toEqual(parsed);
    expect(validateSourceWritingOutput(withReview, request)).toEqual(parsed);
    output.content.sections[0]!.targetWords = 50;
    output.content.sections.push({ ...output.content.sections[0]! });
    expect(() => validateSourceWritingOutput(withReview, request)).toThrow(/evidence coverage/);
  });
  it('rejects another request/hash, invented passage and word allocation changes', () => {
    const request = input();
    expect(() => validateSourceWritingOutput({ ...outline(request), requestId: randomUUID() }, request)).toThrow();
    expect(() => validateSourceWritingOutput({ ...outline(request), inputHash: '0'.repeat(64) }, request)).toThrow();
    const unknown = outline(request); unknown.content.sections[0]!.passageIds = [randomUUID()];
    expect(() => validateSourceWritingOutput(unknown, request)).toThrow();
    const words = outline(request); words.content.sections[0]!.targetWords = 99;
    expect(() => validateSourceWritingOutput(words, request)).toThrow();
  });
  it('fails atomically on fabricated or ambiguous source/output locators', () => {
    const request = input('SECTION');
    expect(validateSourceWritingOutput(section(request), request).status).toBe('ready');
    const forged = section(request); forged.content.paragraphs[0]!.citations[0]!.quote = 'Інший текст';
    expect(() => validateSourceWritingOutput(forged, request)).toThrow();
    const ambiguous = section(request); ambiguous.content.paragraphs[0]!.text += ' Твердження про джерела 😀';
    expect(() => validateSourceWritingOutput(ambiguous, request)).toThrow();
    const foreign = section(request); foreign.content.paragraphs[0]!.citations[0]!.passageId = randomUUID();
    expect(() => validateSourceWritingOutput(foreign, request)).toThrow();
  });
  it('accepts a reviewed cited section when its length differs from the target', () => {
    const request = input('SECTION');
    const output = section(request);
    output.content.paragraphs[0]!.text = output.content.paragraphs[0]!.citations[0]!.assertionText;
    expect(validateSourceWritingOutput(output, request).status).toBe('ready');
    output.review.status = 'needs_human';
    expect(() => validateSourceWritingOutput(output, request)).toThrow();
  });
  it('requires every explicitly selected legacy claim and its exact evidence', () => {
    const request = input();
    request.requiredClaims = [{ claimRevisionId: randomUUID(), wording: 'Сховище існує', evidence: [{ evidenceId: randomUUID(), quote: 'Сховище існує.' }] }];
    expect(() => validateSourceWritingOutput(outline(request), request)).toThrow();
    const output = outline(request); output.content.sections[0]!.requiredClaimRevisionIds = [request.requiredClaims[0]!.claimRevisionId];
    expect(validateSourceWritingOutput(output, request).status).toBe('ready');
  });
  it('cannot convert unresolved review findings or incomplete review into accepted content', () => {
    const request = input();
    const major = { ...outline(request), review: { ...outline(request).review, issues: [{ id: 'support', severity: 'major', reason: 'Немає підтримки' }] } };
    expect(() => validateSourceWritingOutput(major, request)).toThrow();
    const incomplete = outline(request); incomplete.review.modelCalls = 1;
    expect(() => validateSourceWritingOutput(incomplete, request)).toThrow();
    const unresolved = { ...outline(request), status: 'needs_human', review: { status: 'needs_human', issues: [], reasons: ['Недостатньо підтримки'], modelCalls: 2 } };
    expect(() => validateSourceWritingOutput(unresolved, request)).toThrow();
    expect(validateSourceWritingOutput({ ...unresolved, content: null }, request).content).toBeNull();
  });
  it('rejects malformed Unicode, task shapes and oversized context without truncating sources', () => {
    const request = input();
    expect(sourceWritingInputSchema.safeParse({ ...request, format: 'TELEGRAM_POST' }).success).toBe(false);
    expect(sourceWritingInputSchema.safeParse({ ...request, brief: { ...request.brief, notes: '\ud800' } }).success).toBe(false);
    expect(sourceWritingInputSchema.safeParse({ ...request, passages: [{ ...request.passages[0], quote: 'ї'.repeat(10001) }] }).success).toBe(false);
    const passage = request.passages[0]!;
    expect(sourceWritingInputSchema.safeParse({ ...request, passages: Array.from({ length: 8 }, () => ({ ...passage, id: randomUUID(), quote: 'а'.repeat(9000) })) }).success).toBe(false);
  });
  it('accepts an approved Article only as channel context and keeps its identity in the request hash', () => {
    const request = input();
    const approvedArticle = { versionId: randomUUID(),sha256: 'a'.repeat(64),title: 'Стаття',text: 'Збережений схвалений текст.' };
    expect(sourceWritingInputSchema.safeParse({ ...request,approvedArticle }).success).toBe(false);
    const derived = sourceWritingInputSchema.parse({ ...request,task: 'ADAPTATION',format: 'TELEGRAM_POST',approvedArticle });
    expect(derived.approvedArticle?.text).toBe(approvedArticle.text);
    expect(canonicalManifestHash(derived)).not.toBe(canonicalManifestHash({ ...derived,approvedArticle: { ...approvedArticle,sha256: 'b'.repeat(64) } }));
  });
});
