import { z } from 'zod';

const text = (max: number) => z.string().trim().max(max).refine(value => !/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/u.test(value));
const ids = z.array(z.uuid()).max(100).refine(value => new Set(value).size === value.length);
const hash = z.string().regex(/^[a-f0-9]{64}$/u);
export const contentModeSchema = z.enum(['FACTUAL', 'CREATIVE']);
export const saveBriefInput = z.object({ expectedRevision: z.number().int().nonnegative(), contentMode: contentModeSchema,
  topic: text(500).min(1), audience: text(2000), centralMessage: text(4000), category: text(120), tone: text(10000).optional(),
  targetLength: z.number().int().min(50).max(20000), cta: text(2000), exclusions: z.array(text(500).min(1)).max(50),
  notes: text(10000), requiredClaimRevisionIds: ids }).strict()
  .refine(value => value.contentMode === 'FACTUAL' || value.requiredClaimRevisionIds.length === 0);
export const outlineContentSchema = z.object({ title: text(500).min(1), sections: z.array(z.object({
  title: text(300).min(1), purpose: text(2000).min(1), claimRevisionIds: ids }).strict()).min(1).max(30) }).strict();
export const outlineOutputSchema = z.object({ schemaVersion: z.literal('outline-v1'), content: outlineContentSchema }).strict();
export const manualOutlineInput = z.object({ expectedRevision: z.number().int().nonnegative(), briefRevisionId: z.uuid(),
  content: outlineContentSchema }).strict();
export const reviewOutlineInput = z.object({ expectedRevision: z.number().int().positive(), reason: text(2000).min(1).optional() }).strict();
export const generateOutlineInput = z.object({ commandKey: z.string().regex(/^[\w-]{1,128}$/u) }).strict();
export const outlineWorkflowReleaseSchema = z.object({ endpoint: z.url(), workflowId: z.uuid(), releaseId: text(100).min(1),
  configDigest: hash, contractVersion: z.literal('outline-v1'), promptTemplateVersion: text(64).min(1) }).strict();
export const outlineInputManifestSchema = z.object({ schemaVersion: z.literal('outline-input-v1'), briefRevisionId: z.uuid(),
  briefHash: hash, workspaceId: z.uuid(), workspaceStyleRevision: z.number().int().positive(), contentMode: contentModeSchema,
  basisRevisionId: z.uuid().nullable(), basisHash: hash.nullable(), contextSnapshotIds: ids,
  release: outlineWorkflowReleaseSchema, noticeVersion: text(64).min(1), acceptedAt: z.iso.datetime() }).strict()
  .refine(value => value.contentMode === 'FACTUAL' ? !!value.basisRevisionId && !!value.basisHash
    : value.basisRevisionId === null && value.basisHash === null);
export type SaveBriefInput = z.infer<typeof saveBriefInput>;
export type ManualOutlineInput = z.infer<typeof manualOutlineInput>;
export type ReviewOutlineInput = z.infer<typeof reviewOutlineInput>;
export type OutlineContent = z.infer<typeof outlineContentSchema>;
export type OutlineOutput = z.infer<typeof outlineOutputSchema>;
export type OutlineWorkflowRelease = z.infer<typeof outlineWorkflowReleaseSchema>;
export type OutlineInputManifest = z.infer<typeof outlineInputManifestSchema>;
