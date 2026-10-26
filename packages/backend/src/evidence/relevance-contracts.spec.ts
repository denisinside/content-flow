import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { relevanceInputHash, relevanceInputSchema, validateRelevanceOutput, type RelevanceInput } from './relevance-contracts.js';
import { sha256Text } from './contracts.js';

function makeInput(count = 2, quote = 'A concise source statement.') : RelevanceInput {
  return relevanceInputSchema.parse({ schemaVersion: 'source-relevance-request-v1', requestId: '5bb9b880-3283-4fb6-9a61-ff1b88f62e07',
    query: 'What does the source establish?', candidates: Array.from({ length: count }, (_, index) => ({
      id: index.toString(16).padStart(64, '0'), snapshotId: `10000000-0000-4000-8000-${index.toString().padStart(12, '0')}`,
      fragmentId: `20000000-0000-4000-8000-${index.toString().padStart(12, '0')}`, startOffset: 10, endOffset: 10 + quote.length,
      quote, sha256: sha256Text(quote), snapshotSha256: 'a'.repeat(64), label: `Section ${index + 1}` })) });
}

function output(input: RelevanceInput, relevance: 'DIRECT' | 'PARTIAL' | 'IRRELEVANT' = 'DIRECT') {
  return { schemaVersion: 'source-relevance-v1', requestId: input.requestId, requestHash: relevanceInputHash(input),
    decisions: input.candidates.map(row => ({ id: row.id, sha256: row.sha256, relevance,
      reason: relevance === 'DIRECT' ? 'ANSWERS' : relevance === 'PARTIAL' ? 'RELEVANT_CONDITION' : 'NO_QUERY_SUPPORT' })),
    rankedIds: relevance === 'IRRELEVANT' ? [] : input.candidates.map(row => row.id) };
}

describe('frozen source relevance contract', () => {
  it('rejects invalid exact ranges, text hashes, duplicate candidate ids and excess candidates', () => {
    const valid = makeInput();
    expect(relevanceInputSchema.safeParse({ ...valid, candidates: [{ ...valid.candidates[0], endOffset: 9 }, valid.candidates[1]] }).success).toBe(false);
    expect(relevanceInputSchema.safeParse({ ...valid, candidates: [{ ...valid.candidates[0], sha256: 'b'.repeat(64) }, valid.candidates[1]] }).success).toBe(false);
    expect(relevanceInputSchema.safeParse({ ...valid, candidates: [valid.candidates[0], { ...valid.candidates[1], id: valid.candidates[0].id }] }).success).toBe(false);
    const tooMany = { ...valid, candidates: Array.from({ length: 61 }, (_, index) => ({ ...valid.candidates[0],
      id: index.toString(16).padStart(64, '0'), snapshotId: `10000000-0000-4000-8000-${index.toString().padStart(12, '0')}`,
      fragmentId: `20000000-0000-4000-8000-${index.toString().padStart(12, '0')}` })) };
    expect(relevanceInputSchema.safeParse(tooMany).success).toBe(false);
  });

  it('requires an exact exhaustive classification, valid usefulness labels and ranking of every useful item', () => {
    const input = makeInput();
    const valid = output(input);
    expect(validateRelevanceOutput(valid, input)).toEqual(valid);
    expect(() => validateRelevanceOutput({ ...valid, decisions: valid.decisions.slice(1) }, input)).toThrow();
    expect(() => validateRelevanceOutput({ ...valid, decisions: [...valid.decisions, valid.decisions[0]] }, input)).toThrow();
    expect(() => validateRelevanceOutput({ ...valid, decisions: [{ ...valid.decisions[0], id: 'f'.repeat(64) }, valid.decisions[1]] }, input)).toThrow();
    expect(() => validateRelevanceOutput({ ...valid, rankedIds: valid.rankedIds.slice(1) }, input)).toThrow();
    expect(() => validateRelevanceOutput({ ...valid, rankedIds: [valid.candidates[0].id, valid.candidates[0].id] }, input)).toThrow();
    expect(() => validateRelevanceOutput({ ...valid, decisions: [{ ...valid.decisions[0], relevance: 'IRRELEVANT', reason: 'ANSWERS' }, valid.decisions[1]] }, input)).toThrow();
    expect(() => validateRelevanceOutput({ ...valid, requestHash: '0'.repeat(64) }, input)).toThrow();
    expect(() => validateRelevanceOutput({ ...valid, requestId: randomUUID() }, input)).toThrow();
  });

  it('permits an explicitly empty useful set while keeping every candidate classified', () => {
    const input = makeInput();
    const result = output(input, 'IRRELEVANT');
    expect(validateRelevanceOutput(result, input).rankedIds).toEqual([]);
    expect(() => validateRelevanceOutput({ ...result, rankedIds: [input.candidates[0].id] }, input)).toThrow();
  });

  it('uses UTF-16 offsets for Unicode source ranges and hashes canonical sorted-key JSON stably', () => {
    const quote = '🧪 українська цитата';
    const input = makeInput(1, quote);
    expect(input.candidates[0].endOffset - input.candidates[0].startOffset).toBe(quote.length);
    const canonical = JSON.stringify({ candidates: input.candidates.map(row => ({ endOffset: row.endOffset, fragmentId: row.fragmentId,
      id: row.id, label: row.label, quote: row.quote, sha256: row.sha256, snapshotId: row.snapshotId,
      snapshotSha256: row.snapshotSha256, startOffset: row.startOffset })), query: input.query, requestId: input.requestId,
    schemaVersion: input.schemaVersion });
    expect(relevanceInputHash(input)).toBe(sha256Text(canonical));
    // Golden digest produced by Python json.dumps(sort_keys=True, ensure_ascii=False, separators=(',', ':')).
    expect(relevanceInputHash(input)).toBe('4ee3a4546c4fe20a0299a6ccba4dec00428b9c0c3563a002067914f4bf24087c');
    expect(relevanceInputHash(input)).toBe(relevanceInputHash(JSON.parse(JSON.stringify(input)) as RelevanceInput));
  });

  it('accepts the full frozen candidate limit without changing the request hash', () => {
    const input = makeInput(60);
    expect(input.candidates).toHaveLength(60);
    expect(validateRelevanceOutput(output(input), input).decisions).toHaveLength(60);
  });
});
