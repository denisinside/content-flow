import { describe, expect, it } from 'vitest';
import { EMBEDDING_DIMENSIONS, MAX_EMBEDDING_TEXT_BYTES, embeddingOutputSchema, embeddingRequestHash,
  embeddingRequestSchema, sha256Text, validateEmbeddingOutput, type EmbeddingRequest } from './contracts.js';

const ids = ['10000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000002'];
function request(text = 'Джерело 😀: 42 мс\nУмова збережена.'): EmbeddingRequest {
  return { schemaVersion: 'source-embedding-request-v1', requestId: '10000000-0000-4000-8000-000000000000',
    task: 'DOCUMENT', texts: [{ id: ids[0]!, text, sha256: sha256Text(text) }] };
}
function output(input: EmbeddingRequest = request()) {
  return { schemaVersion: 'source-embedding-v1' as const, requestId: input.requestId,
    requestHash: embeddingRequestHash(input), model: 'gemini-embedding-001' as const,
    dimensions: 768 as const, task: input.task,
    embeddings: input.texts.map(row => ({ id: row.id, sha256: row.sha256,
      values: Array.from({ length: EMBEDDING_DIMENSIONS }, (_, index) => index === 0 ? 1 : 0) })) };
}

describe('source embedding trust boundary', () => {
  it('preserves exact Unicode text and validates a normalized response tied to the request', () => {
    const input = request();
    expect(embeddingRequestSchema.parse(input).texts[0]!.text).toBe(input.texts[0]!.text);
    expect(validateEmbeddingOutput(output(input), input).embeddings[0]!.id).toBe(ids[0]);
    const reordered = { texts: input.texts.map(row => ({ sha256: row.sha256, text: row.text, id: row.id })),
      task: input.task, requestId: input.requestId, schemaVersion: input.schemaVersion };
    expect(embeddingRequestHash(reordered)).toBe(embeddingRequestHash(input));
    expect(embeddingRequestHash(input)).toBe('e28903c85d85b772aee7b07f818409c48bb9f9ac032981f5f851b4d615195385');
  });

  it('rejects malformed or forged input before any external call', () => {
    const input = request();
    expect(embeddingRequestSchema.safeParse({ ...input, extra: 'untrusted' }).success).toBe(false);
    expect(embeddingRequestSchema.safeParse({ ...input, texts: [{ ...input.texts[0], sha256: '0'.repeat(64) }] }).success).toBe(false);
    expect(embeddingRequestSchema.safeParse({ ...input, texts: [input.texts[0], input.texts[0]] }).success).toBe(false);
    expect(embeddingRequestSchema.safeParse(request('\ud800')).success).toBe(false);
    expect(embeddingRequestSchema.safeParse(request('a\u0000b')).success).toBe(false);
    expect(embeddingRequestSchema.safeParse(request('')).success).toBe(false);
    expect(embeddingRequestSchema.safeParse(request('  \n\t ')).success).toBe(false);
    expect(embeddingRequestSchema.safeParse(request('ї'.repeat(MAX_EMBEDDING_TEXT_BYTES / 2 + 1))).success).toBe(false);
    expect(embeddingRequestSchema.safeParse(request('a'.repeat(MAX_EMBEDDING_TEXT_BYTES))).success).toBe(true);
  });

  it('requires a single query and distinct document identities within the batch', () => {
    const input = request();
    const texts = [input.texts[0]!, { ...input.texts[0]!, id: ids[1]! }];
    expect(embeddingRequestSchema.safeParse({ ...input, task: 'QUERY', texts }).success).toBe(false);
    expect(embeddingRequestSchema.safeParse({ ...input, texts }).success).toBe(true);
    expect(embeddingRequestSchema.safeParse({ ...input, texts: Array.from({ length: 17 }, () => texts[0]) }).success).toBe(false);
  });

  it('rejects responses from another input, task, order, model or dimensions', () => {
    const input = request();
    for (const patch of [{ requestId: ids[1] }, { requestHash: '0'.repeat(64) }, { task: 'QUERY' },
      { dimensions: 3072 }, { model: 'another-space' }, { embeddings: [] }]) {
      expect(() => validateEmbeddingOutput({ ...output(input), ...patch }, input)).toThrow();
    }
    const multi = { ...input, texts: [input.texts[0]!, { ...input.texts[0]!, id: ids[1]! }] };
    const valid = output(multi);
    expect(() => validateEmbeddingOutput({ ...valid, embeddings: [...valid.embeddings].reverse() }, multi)).toThrow();
    expect(() => validateEmbeddingOutput({ ...valid, embeddings: valid.embeddings.slice(1) }, multi)).toThrow();
  });

  it('rejects zero, truncated, non-finite and incorrectly normalized vectors', () => {
    const valid = output();
    for (const values of [Array(768).fill(0), Array(767).fill(0), Array(768).fill(NaN),
      Array(768).fill(Infinity), Array(768).fill(1), Array(768).fill(Number.MAX_VALUE)]) {
      expect(embeddingOutputSchema.safeParse({ ...valid, embeddings: [{ ...valid.embeddings[0], values }] }).success).toBe(false);
    }
  });
});
