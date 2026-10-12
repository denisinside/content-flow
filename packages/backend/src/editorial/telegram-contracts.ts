import { z } from 'zod';
import { contentModeSchema } from './contracts.js';
import { scriptContentSchema } from './script-contracts.js';

const hash = z.string().regex(/^[a-f0-9]{64}$/u);
const safeText = (max: number) => z.string().max(max).refine(value => !/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/u.test(value));
export const telegramInputModeSchema = z.enum(['DIRECT', 'ARTICLE_DERIVED']);
export const adaptationFormatSchema = z.enum(['TELEGRAM_POST', 'LINKEDIN_TEXT', 'LINKEDIN_COVER', 'INSTAGRAM_COVER', 'LINKEDIN_CAROUSEL', 'INSTAGRAM_CAROUSEL', 'INSTAGRAM_STORIES']);
export type AdaptationFormat = z.infer<typeof adaptationFormatSchema>;
export const telegramContentSchema = z.object({ text: safeText(10000), mappings: z.array(z.object({
  startOffset: z.number().int().nonnegative(), endOffset: z.number().int().positive(), quote: safeText(10000).min(1),
  claimRevisionId: z.uuid(), evidenceId: z.uuid(), field: z.enum(['text', 'cover']).optional(),
}).strict()).max(100), cover: z.object({ text: safeText(200), instruction: safeText(2000) }).strict().optional() }).strict().superRefine((value, ctx) => {
  for (const field of ['text', 'cover'] as const) {
    const target = field === 'text' ? value.text : value.cover?.text;
    const sorted = value.mappings.filter(mapping => (mapping.field ?? 'text') === field)
      .sort((a, b) => a.startOffset - b.startOffset);
    let previousEnd = 0;
    for (const mapping of sorted) {
      if (!target || mapping.endOffset <= mapping.startOffset || mapping.endOffset > target.length || mapping.startOffset < previousEnd) {
        ctx.addIssue({ code: 'custom', message: 'Evidence ranges must be bounded and nonoverlapping' });
      }
      previousEnd = mapping.endOffset;
    }
  }
});
export function validateFormatContent(format: AdaptationFormat, content: TelegramContent): TelegramContent {
  if (format === 'TELEGRAM_POST' && (content.text.length > 4096 || content.cover)) throw new Error('Invalid Telegram content shape');
  if ((format === 'LINKEDIN_COVER' || format === 'INSTAGRAM_COVER') !== !!content.cover) throw new Error('Cover content is required only for cover formats');
  if (content.mappings.some(mapping => mapping.field === 'cover') && !content.cover) throw new Error('Cover evidence requires cover text');
  return content;
}
export const saveTelegramDraftInput = z.object({ expectedRevision: z.number().int().nonnegative(), content: telegramContentSchema,
  format: adaptationFormatSchema.default('TELEGRAM_POST'), inputMode: telegramInputModeSchema, contentMode: contentModeSchema, includeLink: z.boolean().default(false), refreshInputs: z.boolean().optional() }).strict();
export const checkpointTelegramInput = z.object({ format: adaptationFormatSchema.default('TELEGRAM_POST'), expectedRevision: z.number().int().nonnegative() }).strict();
export const reviewTelegramInput = z.object({ format: adaptationFormatSchema.default('TELEGRAM_POST'), expectedRevision: z.number().int().nonnegative(), acknowledgeUnmapped: z.boolean().optional(),
  expectedReviewCounter: z.number().int().nonnegative().optional(), reason: safeText(2000).trim().min(1).optional() }).strict();
export const rereviewTelegramInput = reviewTelegramInput.extend({ expectedReviewCounter: z.number().int().nonnegative() });
export const generateTelegramInput = z.object({ format: adaptationFormatSchema.default('TELEGRAM_POST'), expectedRevision: z.number().int().nonnegative(), commandKey: z.string().regex(/^[\w-]{1,128}$/u),
  inputMode: telegramInputModeSchema, contentMode: contentModeSchema, includeLink: z.boolean().default(false) }).strict();
export const telegramOutputSchema = z.object({ schemaVersion: z.literal('adaptation-v1'), format: adaptationFormatSchema, content: telegramContentSchema,
  script: scriptContentSchema.optional() }).strict().superRefine((value, ctx) => {
  const needsScript = ['LINKEDIN_CAROUSEL', 'INSTAGRAM_CAROUSEL', 'INSTAGRAM_STORIES'].includes(value.format);
  if (needsScript !== !!value.script) ctx.addIssue({ code: 'custom', message: 'Carousel and stories output must include exactly one script candidate' });
  if (value.format === 'INSTAGRAM_STORIES' && value.script?.frames.some(frame => !frame.transition?.trim())) {
    ctx.addIssue({ code: 'custom', message: 'Every Instagram story frame requires a transition' });
  }
});
export const telegramWorkflowReleaseSchema = z.object({ endpoint: z.url(), workflowId: z.uuid(), releaseId: safeText(100).min(1),
  configDigest: hash, contractVersion: z.literal('adaptation-v1'), promptTemplateVersion: safeText(64).min(1) }).strict();
export const telegramInputManifestSchema = z.object({ schemaVersion: z.literal('adaptation-input-v1'), format: adaptationFormatSchema, adaptationRevision: z.number().int().nonnegative(),
  inputMode: telegramInputModeSchema, contentMode: contentModeSchema, includeLink: z.boolean(), briefRevisionId: z.uuid(), briefHash: hash,
  basisRevisionId: z.uuid().nullable(), basisHash: hash.nullable(), sourceArticleVersionId: z.uuid().nullable(), sourceArticleHash: hash.nullable(),
  workspaceId: z.uuid(), workspaceStyleRevision: z.number().int().positive(), contextSnapshotIds: z.array(z.uuid()).max(100).refine(ids => new Set(ids).size === ids.length),
  release: telegramWorkflowReleaseSchema, noticeVersion: safeText(64).min(1), acceptedAt: z.iso.datetime(),
}).strict().refine(value => value.contentMode === 'FACTUAL' ? !!value.basisRevisionId && !!value.basisHash : value.basisRevisionId === null && value.basisHash === null)
  .refine(value => value.inputMode === 'ARTICLE_DERIVED' ? !!value.sourceArticleVersionId && !!value.sourceArticleHash : value.sourceArticleVersionId === null && value.sourceArticleHash === null);
export type TelegramContent = z.infer<typeof telegramContentSchema>;
export type TelegramOutput = z.infer<typeof telegramOutputSchema>;
export type SaveTelegramDraftInput = z.input<typeof saveTelegramDraftInput>;
export type ReviewTelegramInput = z.input<typeof reviewTelegramInput>;
export type GenerateTelegramInput = z.input<typeof generateTelegramInput>;
export type TelegramInputManifest = z.infer<typeof telegramInputManifestSchema>;
export type TelegramWorkflowRelease = z.infer<typeof telegramWorkflowReleaseSchema>;
