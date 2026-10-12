import { z } from 'zod';

export const BACKGROUND_CONTRACT = 'visual-background-v1';
export const BACKGROUND_MODEL = 'gemini-nano-banana-2.1';
export const backgroundFormatSchema = z.enum(['LINKEDIN_COVER', 'INSTAGRAM_COVER', 'LINKEDIN_CAROUSEL', 'INSTAGRAM_CAROUSEL', 'INSTAGRAM_STORIES']);
export const backgroundRequestSchema = z.object({
  schemaVersion: z.literal(BACKGROUND_CONTRACT), frameId: z.uuid(), visualBrief: z.string().trim().min(1).max(2000),
  width: z.literal(1080), height: z.union([z.literal(1080), z.literal(1350), z.literal(1920)]),
  templateId: z.enum(['editorial', 'statement', 'photo-caption', 'fact']),
  palette: z.object({ background: z.string().regex(/^#[\da-f]{6}$/i), text: z.string().regex(/^#[\da-f]{6}$/i), accent: z.string().regex(/^#[\da-f]{6}$/i) }).strict(),
}).strict();
export const backgroundReleaseSchema = z.object({ endpoint: z.string().url(), workflowId: z.uuid(), releaseId: z.string().min(1).max(100), configDigest: z.string().regex(/^[a-f0-9]{64}$/), contractVersion: z.literal(BACKGROUND_CONTRACT), promptTemplateVersion: z.string().min(1).max(100) }).strict();
export const backgroundManifestSchema = z.object({
  schemaVersion: z.literal(BACKGROUND_CONTRACT), format: backgroundFormatSchema,
  compositionRevisionId: z.uuid(), compositionHash: z.string().regex(/^[a-f0-9]{64}$/), frameId: z.uuid(), frameHash: z.string().regex(/^[a-f0-9]{64}$/),
  parentKind: z.enum(['ADAPTATION', 'SCRIPT']), parentRevisionId: z.uuid(), parentRevisionHash: z.string().regex(/^[a-f0-9]{64}$/), parentReviewCounter: z.number().int().nonnegative(),
  workspaceStyleRevision: z.number().int().positive(), request: backgroundRequestSchema, release: backgroundReleaseSchema,
}).strict().refine(input => input.frameId === input.request.frameId, 'Frame identity mismatch');
export const backgroundReportSchema = z.object({
  schemaVersion: z.literal('visual-background-report-v1'), frameId: z.uuid(), width: z.literal(1080), height: z.union([z.literal(1080),z.literal(1350),z.literal(1920)]),
  model: z.literal(BACKGROUND_MODEL), ready: z.boolean(), hasText: z.boolean(), usable: z.boolean(), reason: z.string().max(1000),
}).strict();
export const backgroundGenerateSchema = z.object({ expectedRevision: z.number().int().nonnegative(), expectedDraftCounter: z.number().int().nonnegative(), compositionRevisionId: z.uuid(), frameId: z.uuid(), visualBrief: z.string().trim().min(1).max(2000), commandKey: z.string().regex(/^[\w-]{1,128}$/) }).strict();
export const backgroundApplySchema = z.object({ expectedRevision: z.number().int().nonnegative(), expectedDraftCounter: z.number().int().nonnegative(), commandKey: z.string().regex(/^[\w-]{1,128}$/), acknowledgeBackgroundReview: z.literal(true) }).strict();
export type BackgroundRequest = z.infer<typeof backgroundRequestSchema>;
export type BackgroundManifest = z.infer<typeof backgroundManifestSchema>;
export type BackgroundReport = z.infer<typeof backgroundReportSchema>;
export type BackgroundRelease = z.infer<typeof backgroundReleaseSchema>;
export type BackgroundGenerateInput = z.infer<typeof backgroundGenerateSchema>;
export type BackgroundApplyInput = z.infer<typeof backgroundApplySchema>;
export interface BackgroundWorkflowSettings extends BackgroundRelease { apiKey: string; fileOrigins: string[] }
