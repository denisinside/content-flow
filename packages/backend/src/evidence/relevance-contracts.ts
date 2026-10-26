import { z } from 'zod';
import { sha256Text } from './contracts.js';

export const RELEVANCE_LIMITS = Object.freeze({ maxCandidates: 60, candidateBytes: 60_000,
  inputBytes: 100_000, maxPassages: 20, outputBytes: 40_000 });
const hash = z.string().regex(/^[a-f0-9]{64}$/u);
const sourceText = z.string().min(1).refine(value => value.trim().length > 0
  && Buffer.from(value, 'utf8').toString('utf8') === value
  && !/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/u.test(value));
export const relevanceCandidateSchema = z.object({ id: hash, snapshotId: z.uuid(), fragmentId: z.uuid(),
  startOffset: z.number().int().safe().nonnegative(), endOffset: z.number().int().safe().positive(),
  quote: sourceText.refine(value => Buffer.byteLength(value, 'utf8') <= 1536), sha256: hash,
  snapshotSha256: hash, label: z.string().min(1).max(200) }).strict();
export const relevanceInputSchema = z.object({ schemaVersion: z.literal('source-relevance-request-v1'),
  requestId: z.uuid(), query: sourceText.refine(value => value.length <= 1000 && Buffer.byteLength(value, 'utf8') <= 1536),
  candidates: z.array(relevanceCandidateSchema).min(1).max(RELEVANCE_LIMITS.maxCandidates),
}).strict().superRefine((value, context) => {
  if (new Set(value.candidates.map(row => row.id)).size !== value.candidates.length
    || value.candidates.some(row => row.endOffset <= row.startOffset || row.endOffset - row.startOffset !== row.quote.length
      || sha256Text(row.quote) !== row.sha256)
    || value.candidates.reduce((bytes, row) => bytes + Buffer.byteLength(row.quote, 'utf8'), 0) > RELEVANCE_LIMITS.candidateBytes
    || Buffer.byteLength(JSON.stringify(value), 'utf8') > RELEVANCE_LIMITS.inputBytes) {
    context.addIssue({ code: 'custom', message: 'Invalid relevance candidate identity, exact range, hash or bounds' });
  }
});
export type RelevanceInput = z.infer<typeof relevanceInputSchema>;
export type RelevanceCandidate = z.infer<typeof relevanceCandidateSchema>;

// Sorted keys, UTF-8 JSON and no insignificant whitespace match the Python node.
export function relevanceInputHash(raw: RelevanceInput): string {
  const input = relevanceInputSchema.parse(raw);
  return sha256Text(JSON.stringify({ candidates: input.candidates.map(row => ({ endOffset: row.endOffset,
    fragmentId: row.fragmentId, id: row.id, label: row.label, quote: row.quote, sha256: row.sha256,
    snapshotId: row.snapshotId, snapshotSha256: row.snapshotSha256, startOffset: row.startOffset })),
  query: input.query, requestId: input.requestId, schemaVersion: input.schemaVersion }));
}

export const relevanceOutputSchema = z.object({ schemaVersion: z.literal('source-relevance-v1'), requestId: z.uuid(), requestHash: hash,
  decisions: z.array(z.object({ id: hash, sha256: hash,
    relevance: z.enum(['DIRECT', 'PARTIAL', 'IRRELEVANT']), reason: z.enum(['ANSWERS', 'RELEVANT_CONDITION', 'NO_QUERY_SUPPORT', 'BOILERPLATE', 'DUPLICATE'])
  }).strict()).min(1).max(RELEVANCE_LIMITS.maxCandidates),
  rankedIds: z.array(hash).max(RELEVANCE_LIMITS.maxCandidates),
}).strict();
export type RelevanceOutput = z.infer<typeof relevanceOutputSchema>;

/** The model may classify/rank supplied candidates; it cannot invent or change a quote. */
export function validateRelevanceOutput(raw: unknown, rawInput: RelevanceInput): RelevanceOutput {
  const input = relevanceInputSchema.parse(rawInput), output = relevanceOutputSchema.parse(raw);
  const candidates = new Map(input.candidates.map(row => [row.id, row]));
  const decisions = new Map(output.decisions.map(row => [row.id, row]));
  const useful = output.decisions.filter(row => row.relevance !== 'IRRELEVANT').map(row => row.id);
  if (output.requestId !== input.requestId || output.requestHash !== relevanceInputHash(input)
    || decisions.size !== candidates.size || output.decisions.length !== candidates.size
    || output.decisions.some(row => candidates.get(row.id)?.sha256 !== row.sha256
      || (row.relevance === 'IRRELEVANT') !== ['NO_QUERY_SUPPORT', 'BOILERPLATE', 'DUPLICATE'].includes(row.reason))
    || new Set(output.rankedIds).size !== output.rankedIds.length || output.rankedIds.length !== useful.length
    || output.rankedIds.some(id => !useful.includes(id))
    || Buffer.byteLength(JSON.stringify(output), 'utf8') > RELEVANCE_LIMITS.outputBytes) {
    throw new TypeError('Relevance result does not match the exact frozen candidate set');
  }
  return output;
}
