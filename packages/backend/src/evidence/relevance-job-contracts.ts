import { z } from 'zod';
import { embeddingRequestSchema } from './contracts.js';
import { relevanceInputSchema } from './relevance-contracts.js';

const sha256 = z.string().regex(/^[a-f0-9]{64}$/u);
const frozenSnapshotSchema = z.object({ snapshotId: z.uuid(), materialId: z.uuid(), snapshotSha256: sha256,
  sequence: z.number().int().positive(), label: z.string().min(1).max(200) }).strict();
const frozenIndexSchema = z.object({ indexId: z.uuid(), snapshotId: z.uuid(), snapshotSha256: sha256,
  configDigest: sha256 }).strict();
const frozenReleaseSchema = z.object({ endpoint: z.string().url(), workflowId: z.uuid(),
  releaseId: z.string().min(1).max(100), configDigest: sha256 }).strict();
const embeddingReleaseSchema = frozenReleaseSchema.extend({ releaseId: z.literal('source-embedding-2026-10-20.1') }).strict();
const relevanceReleaseSchema = z.union([
  frozenReleaseSchema.extend({ releaseId: z.literal('source-relevance-2026-10-22.1'),
    configDigest: z.literal('239be78994f5b3d2b1e5cfdf119a4b91d6de943d12aebe0c52594fcc55457c9b') }).strict(),
  frozenReleaseSchema.extend({ releaseId: z.literal('source-relevance-2026-10-24.1'),
    configDigest: z.literal('40153b6847d3f6a6da168afd7b5ec930492c35458582a8aec32aba3e431582c0') }).strict(),
]);
const frozenSearchPolicySchema = z.object({ version: z.literal('hybrid-source-v4'), rankConstant: z.literal(60),
  byteBudget: z.literal(30_000), maxPassages: z.literal(20), adjacentContextChunks: z.literal(1) }).strict();

export const evidenceSearchV2ManifestSchema = z.object({ schemaVersion: z.literal('evidence-search-job-v2'),
  commandKey: z.string().min(1).max(128), query: z.string().min(1).max(1000),
  snapshots: z.array(frozenSnapshotSchema).min(1).max(100), indexes: z.array(frozenIndexSchema).min(1).max(100),
  retrievalPolicy: frozenSearchPolicySchema, request: embeddingRequestSchema,
  release: embeddingReleaseSchema, relevanceRelease: relevanceReleaseSchema,
  noticeVersion: z.string().min(1).max(100), acceptedAt: z.iso.datetime() }).strict().superRefine((value, context) => {
  if (value.request.task !== 'QUERY' || value.request.texts.length !== 1 || value.request.texts[0]?.text !== value.query
    || new Set(value.snapshots.map(row => row.snapshotId)).size !== value.snapshots.length
    || new Set(value.indexes.map(row => row.snapshotId)).size !== value.indexes.length
    || value.snapshots.length !== value.indexes.length
    || value.snapshots.some(snapshot => !value.indexes.some(index => index.snapshotId === snapshot.snapshotId
      && index.snapshotSha256 === snapshot.snapshotSha256))) {
    context.addIssue({ code: 'custom', message: 'Search manifest must freeze one query and matching unique source indexes' });
  }
});
export type EvidenceSearchV2Manifest = z.infer<typeof evidenceSearchV2ManifestSchema>;

export const evidenceRelevanceManifestSchema = z.object({ schemaVersion: z.literal('evidence-relevance-job-v1'),
  commandKey: z.string().min(1).max(128), parentJobId: z.uuid(), parentInputHash: sha256,
  query: z.string().min(1).max(1000), snapshots: z.array(frozenSnapshotSchema).min(1).max(100),
  indexes: z.array(frozenIndexSchema).min(1).max(100), retrievalPolicy: frozenSearchPolicySchema,
  embeddingRelease: embeddingReleaseSchema, release: relevanceReleaseSchema,
  request: relevanceInputSchema, candidateCount: z.number().int().nonnegative(), hasMore: z.boolean(),
  noticeVersion: z.string().min(1).max(100), acceptedAt: z.iso.datetime() }).strict().superRefine((value, context) => {
  if (value.request.query !== value.query || value.request.candidates.length > value.candidateCount
    || new Set(value.snapshots.map(row => row.snapshotId)).size !== value.snapshots.length
    || new Set(value.indexes.map(row => row.snapshotId)).size !== value.indexes.length
    || value.snapshots.length !== value.indexes.length
    || value.snapshots.some(snapshot => !value.indexes.some(index => index.snapshotId === snapshot.snapshotId
      && index.snapshotSha256 === snapshot.snapshotSha256))
    || value.request.candidates.some(candidate => !value.snapshots.some(snapshot => snapshot.snapshotId === candidate.snapshotId
      && snapshot.snapshotSha256 === candidate.snapshotSha256 && snapshot.label === candidate.label))) {
    context.addIssue({ code: 'custom', message: 'Relevance manifest must preserve the parent source and query scope' });
  }
});
export type EvidenceRelevanceManifest = z.infer<typeof evidenceRelevanceManifestSchema>;

export const EVIDENCE_SEARCH_V2_CONTRACT = 'evidence-search-v2';
export const EVIDENCE_RELEVANCE_CONTRACT = 'evidence-relevance-v1';
export const HYBRID_SOURCE_V4_POLICY = Object.freeze({ version: 'hybrid-source-v4' as const, rankConstant: 60 as const,
  byteBudget: 30_000 as const, maxPassages: 20 as const, adjacentContextChunks: 1 as const });

