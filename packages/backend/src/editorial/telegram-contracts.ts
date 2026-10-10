import { z } from 'zod';
import { contentModeSchema } from './contracts.js';

const hash = z.string().regex(/^[a-f0-9]{64}$/u);
const safeText = (max: number) => z.string().max(max).refine(value => !/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/u.test(value));
export const telegramInputModeSchema = z.enum(['DIRECT', 'ARTICLE_DERIVED']);
export const telegramContentSchema = z.object({ text: safeText(4096), mappings: z.array(z.object({
  startOffset: z.number().int().nonnegative(), endOffset: z.number().int().positive(), quote: safeText(4096).min(1),
  claimRevisionId: z.uuid(), evidenceId: z.uuid(),
}).strict()).max(100) }).strict().superRefine((value, ctx) => {
  const sorted = [...value.mappings].sort((a, b) => a.startOffset - b.startOffset);
  for (let index = 0; index < sorted.length; index++) {
    const mapping = sorted[index]!;
    if (mapping.endOffset <= mapping.startOffset || mapping.endOffset > value.text.length || index > 0 && mapping.startOffset < sorted[index - 1]!.endOffset) {
      ctx.addIssue({ code: 'custom', message: 'Evidence ranges must be bounded and nonoverlapping' });
    }
  }
});
export const saveTelegramDraftInput = z.object({ expectedRevision: z.number().int().nonnegative(), content: telegramContentSchema,
  inputMode: telegramInputModeSchema, contentMode: contentModeSchema, includeLink: z.boolean(), refreshInputs: z.boolean().optional() }).strict();
export const checkpointTelegramInput = z.object({ expectedRevision: z.number().int().nonnegative() }).strict();
export const reviewTelegramInput = z.object({ expectedRevision: z.number().int().nonnegative(), acknowledgeUnmapped: z.boolean().optional(),
  expectedReviewCounter: z.number().int().nonnegative().optional(), reason: safeText(2000).trim().min(1).optional() }).strict();
export const rereviewTelegramInput = reviewTelegramInput.extend({ expectedReviewCounter: z.number().int().nonnegative() });
export const generateTelegramInput = z.object({ expectedRevision: z.number().int().nonnegative(), commandKey: z.string().regex(/^[\w-]{1,128}$/u),
  inputMode: telegramInputModeSchema, contentMode: contentModeSchema, includeLink: z.boolean() }).strict();
export const telegramOutputSchema = z.object({ schemaVersion: z.literal('telegram-v1'), content: telegramContentSchema }).strict();
export const telegramWorkflowReleaseSchema = z.object({ endpoint: z.url(), workflowId: z.uuid(), releaseId: safeText(100).min(1),
  configDigest: hash, contractVersion: z.literal('telegram-v1'), promptTemplateVersion: safeText(64).min(1) }).strict();
export const telegramInputManifestSchema = z.object({ schemaVersion: z.literal('telegram-input-v1'), adaptationRevision: z.number().int().nonnegative(),
  inputMode: telegramInputModeSchema, contentMode: contentModeSchema, includeLink: z.boolean(), briefRevisionId: z.uuid(), briefHash: hash,
  basisRevisionId: z.uuid().nullable(), basisHash: hash.nullable(), sourceArticleVersionId: z.uuid().nullable(), sourceArticleHash: hash.nullable(),
  workspaceId: z.uuid(), workspaceStyleRevision: z.number().int().positive(), contextSnapshotIds: z.array(z.uuid()).max(100).refine(ids => new Set(ids).size === ids.length),
  release: telegramWorkflowReleaseSchema, noticeVersion: safeText(64).min(1), acceptedAt: z.iso.datetime(),
}).strict().refine(value => value.contentMode === 'FACTUAL' ? !!value.basisRevisionId && !!value.basisHash : value.basisRevisionId === null && value.basisHash === null)
  .refine(value => value.inputMode === 'ARTICLE_DERIVED' ? !!value.sourceArticleVersionId && !!value.sourceArticleHash : value.sourceArticleVersionId === null && value.sourceArticleHash === null);
export type TelegramContent = z.infer<typeof telegramContentSchema>;
export type TelegramOutput = z.infer<typeof telegramOutputSchema>;
export type SaveTelegramDraftInput = z.infer<typeof saveTelegramDraftInput>;
export type ReviewTelegramInput = z.infer<typeof reviewTelegramInput>;
export type GenerateTelegramInput = z.infer<typeof generateTelegramInput>;
export type TelegramInputManifest = z.infer<typeof telegramInputManifestSchema>;
export type TelegramWorkflowRelease = z.infer<typeof telegramWorkflowReleaseSchema>;
