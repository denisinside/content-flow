import { createHash } from 'node:crypto';
import { z } from 'zod';

export const EMBEDDING_MODEL = 'gemini-embedding-001';
export const EMBEDDING_DIMENSIONS = 768;
export const MAX_EMBEDDING_TEXT_BYTES = 1536;
export const MAX_EMBEDDING_TEXT_CHARACTERS = 4000;
export const MAX_EMBEDDING_BATCH = 16;
export const MAX_EMBEDDING_REQUEST_BYTES = 64000;
export const MAX_EMBEDDING_RESPONSE_BYTES = 1024 * 1024;

const snapshotSelection = z.array(z.uuid()).min(1).max(100)
  .refine(values => new Set(values).size === values.length);
export const indexSourceEvidenceInput = z.object({ commandKey: z.uuid(), snapshotIds: snapshotSelection }).strict();
export const searchSourceEvidenceInput = indexSourceEvidenceInput.extend({ query: z.string().trim().min(1).max(1000)
  .refine(value => Buffer.byteLength(value, 'utf8') <= MAX_EMBEDDING_TEXT_BYTES
    && Buffer.from(value, 'utf8').toString('utf8') === value
    && !/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/u.test(value)) }).strict();
export type IndexSourceEvidenceInput = z.infer<typeof indexSourceEvidenceInput>;
export type SearchSourceEvidenceInput = z.infer<typeof searchSourceEvidenceInput>;

export function sha256Text(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

const hash = z.string().regex(/^[a-f0-9]{64}$/u);
const canonicalUuid = z.uuid().refine(value => value === value.toLowerCase());
const sourceText = z.string().min(1).refine(value => value.trim().length > 0 && [...value].length <= MAX_EMBEDDING_TEXT_CHARACTERS
  && Buffer.byteLength(value, 'utf8') <= MAX_EMBEDDING_TEXT_BYTES
  && Buffer.from(value, 'utf8').toString('utf8') === value
  && !/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/u.test(value), 'Invalid embedding text');

export const embeddingRequestSchema = z.object({
  schemaVersion: z.literal('source-embedding-request-v1'),
  requestId: canonicalUuid,
  task: z.enum(['DOCUMENT', 'QUERY']),
  texts: z.array(z.object({ id: canonicalUuid, text: sourceText, sha256: hash }).strict())
    .min(1).max(MAX_EMBEDDING_BATCH),
}).strict().superRefine((value, context) => {
  if (new Set(value.texts.map(row => row.id)).size !== value.texts.length
    || value.task === 'QUERY' && value.texts.length !== 1
    || value.texts.some(row => sha256Text(row.text) !== row.sha256)
    || Buffer.byteLength(JSON.stringify(value), 'utf8') > MAX_EMBEDDING_REQUEST_BYTES) {
    context.addIssue({ code: 'custom', message: 'Invalid embedding request identity, text hash or bounds' });
  }
});

export type EmbeddingRequest = z.infer<typeof embeddingRequestSchema>;

// Only the validated string-valued request contract is serialized here. Its
// sorted object keys match Python sort_keys=True/ensure_ascii=False/separators.
export function embeddingRequestHash(input: EmbeddingRequest): string {
  const request = embeddingRequestSchema.parse(input);
  return sha256Text(JSON.stringify({ requestId: request.requestId, schemaVersion: request.schemaVersion,
    task: request.task, texts: request.texts.map(row => ({ id: row.id, sha256: row.sha256, text: row.text })) }));
}

const normalizedVector = z.array(z.number().finite()).length(EMBEDDING_DIMENSIONS).refine(values => {
  const normSquared = values.reduce((sum, value) => sum + value * value, 0);
  return Number.isFinite(normSquared) && Math.abs(normSquared - 1) <= 0.00002;
}, 'Embedding must be finite, nonzero and normalized');

export const embeddingOutputSchema = z.object({
  schemaVersion: z.literal('source-embedding-v1'),
  requestId: z.uuid(),
  requestHash: hash,
  model: z.literal(EMBEDDING_MODEL),
  dimensions: z.literal(EMBEDDING_DIMENSIONS),
  task: z.enum(['DOCUMENT', 'QUERY']),
  embeddings: z.array(z.object({ id: z.uuid(), sha256: hash, values: normalizedVector }).strict())
    .min(1).max(MAX_EMBEDDING_BATCH),
}).strict();

export type EmbeddingOutput = z.infer<typeof embeddingOutputSchema>;

export function validateEmbeddingOutput(raw: unknown, input: EmbeddingRequest): EmbeddingOutput {
  const request = embeddingRequestSchema.parse(input);
  const output = embeddingOutputSchema.parse(raw);
  if (output.requestId !== request.requestId || output.requestHash !== embeddingRequestHash(request)
    || output.task !== request.task || output.embeddings.length !== request.texts.length
    || output.embeddings.some((row, index) => row.id !== request.texts[index]?.id || row.sha256 !== request.texts[index]?.sha256)
    || Buffer.byteLength(JSON.stringify(output), 'utf8') > MAX_EMBEDDING_RESPONSE_BYTES) {
    throw new Error('Invalid source embedding response identity or bounds');
  }
  return output;
}
