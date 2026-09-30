import { z } from 'zod';

const hash = z.string().regex(/^[a-f0-9]{64}$/u);
const wording = z.string().trim().min(1).max(2000).refine(value => !/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/u.test(value));
export const evidenceInput = z.object({ snapshotId: z.uuid(), fragmentId: z.uuid(), startOffset: z.number().int().nonnegative(),
  endOffset: z.number().int().positive(), quote: z.string().min(1).max(10000), sha256: hash,
  relation: z.enum(['SUPPORTS', 'CONTRADICTS']) }).strict();
export const createClaimInput = z.object({ wording, evidence: z.array(evidenceInput).min(1).max(10) }).strict();
export const editClaimInput = createClaimInput.extend({ expectedRevision: z.number().int().positive() }).strict();
export const reviewClaimInput = z.object({ expectedRevision: z.number().int().positive(), reason: wording.optional() }).strict();
export const invalidateEvidenceInput = z.object({ expectedRevision: z.number().int().positive(), reason: wording }).strict();
export const createConflictInput = z.object({ revisionIds: z.array(z.uuid()).min(2).max(10), rationale: wording }).strict()
  .refine(value => new Set(value.revisionIds).size === value.revisionIds.length);
export const reopenConflictInput = z.object({ rationale: wording }).strict();
export const resolveConflictInput = z.object({ selectedRevisionId: z.uuid(), selectedEvidenceIds: z.array(z.uuid()).min(1).max(10),
  formulation: wording, rationale: wording }).strict().refine(value => new Set(value.selectedEvidenceIds).size === value.selectedEvidenceIds.length);
export const freezeBasisInput = z.object({ claimRevisionIds: z.array(z.uuid()).min(1).max(100) }).strict()
  .refine(value => new Set(value.claimRevisionIds).size === value.claimRevisionIds.length);
export const extractClaimsInput = z.object({ commandKey: z.string().regex(/^[\w-]{1,128}$/u) }).strict();
export const claimWorkflowReleaseSchema = z.object({ endpoint: z.url(), workflowId: z.string().min(1).max(200),
  releaseId: z.string().min(1).max(100), configDigest: hash, contractVersion: z.literal('claims-v1'),
  promptTemplateVersion: z.string().min(1).max(64) }).strict();
export const claimInputManifestSchema = z.object({ schemaVersion: z.literal('claim-input-v1'),
  snapshots: z.array(z.object({ snapshotId: z.uuid(), materialId: z.uuid(), sha256: hash,
    fragments: z.array(z.object({ id: z.uuid(), startOffset: z.number().int().nonnegative(), endOffset: z.number().int().positive(), sha256: hash }).strict()).min(1).max(1000) }).strict()).min(1).max(100),
  release: claimWorkflowReleaseSchema, noticeVersion: z.string().min(1).max(64), acceptedAt: z.iso.datetime() }).strict();
export const claimsOutputSchema = z.object({ schemaVersion: z.literal('claims-v1'),
  claims: z.array(createClaimInput.extend({ key: z.string().regex(/^[\w-]{1,64}$/u) }).strict()).max(100),
  conflicts: z.array(z.object({ claimKeys: z.array(z.string().regex(/^[\w-]{1,64}$/u)).min(2).max(10), rationale: wording }).strict()).max(100) }).strict();
export type EvidenceInput = z.infer<typeof evidenceInput>;
export type CreateClaimInput = z.infer<typeof createClaimInput>;
export type EditClaimInput = z.infer<typeof editClaimInput>;
export type ClaimWorkflowRelease = z.infer<typeof claimWorkflowReleaseSchema>;
export type ClaimInputManifest = z.infer<typeof claimInputManifestSchema>;
export type ClaimsOutput = z.infer<typeof claimsOutputSchema>;
