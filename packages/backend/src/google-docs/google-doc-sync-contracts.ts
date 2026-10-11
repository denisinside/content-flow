import { z } from 'zod';

const uuid = z.uuid();
const articleRevision = z.number().int().min(0).max(2_147_483_647);
const commandKey = uuid;
const commentBody = z.string().trim().min(1).max(10_000);

export const googleSyncPreviewKindSchema = z.enum([
  'PUSH', 'COMMENT_CREATE', 'COMMENT_REPLY', 'COMMENT_RESOLVE', 'COMMENT_REOPEN',
  'SUGGESTION_CREATE', 'SUGGESTION_ACCEPT', 'SUGGESTION_REJECT',
]);
export type GoogleSyncPreviewKind = z.infer<typeof googleSyncPreviewKindSchema>;

export const googleSyncPreviewInputSchema = z.object({
  connectionId: uuid,
  sourceVersionId: uuid.nullable(),
  kind: googleSyncPreviewKindSchema,
  annotationId: uuid.optional(),
  threadId: uuid.optional(),
  localPostId: uuid.optional(),
  body: commentBody.optional(),
  rangeStart: z.number().int().min(0).optional(),
  rangeEnd: z.number().int().min(1).optional(),
  replacementText: z.string().max(20_000).optional(),
  expectedArticleRevision: articleRevision,
}).strict().superRefine((input, context) => {
  const needsAnnotation = ['COMMENT_CREATE', 'SUGGESTION_CREATE'].includes(input.kind);
  const needsThread = ['COMMENT_REPLY', 'COMMENT_RESOLVE', 'COMMENT_REOPEN', 'SUGGESTION_ACCEPT', 'SUGGESTION_REJECT'].includes(input.kind);
  const needsBody = ['COMMENT_CREATE', 'COMMENT_REPLY'].includes(input.kind);
  const needsRange = input.kind === 'COMMENT_CREATE' || input.kind === 'SUGGESTION_CREATE';
  if (needsAnnotation && !input.annotationId) context.addIssue({ code: 'custom', path: ['annotationId'], message: 'This operation requires a local annotation' });
  if (needsThread && !input.threadId) context.addIssue({ code: 'custom', path: ['threadId'], message: 'This operation requires a remote thread' });
  if (needsBody && !input.body) context.addIssue({ code: 'custom', path: ['body'], message: 'This operation requires text' });
  if (needsRange && (!Number.isSafeInteger(input.rangeStart) || !Number.isSafeInteger(input.rangeEnd) || input.rangeEnd! <= input.rangeStart!)) {
    context.addIssue({ code: 'custom', path: ['rangeStart'], message: 'This operation requires a nonempty exact article range' });
  }
  if (input.localPostId && input.kind !== 'COMMENT_REPLY') context.addIssue({ code: 'custom', path: ['localPostId'], message: 'A local post only applies to a reply' });
  if (input.localPostId && !input.annotationId) context.addIssue({ code: 'custom', path: ['annotationId'], message: 'A local post requires its local annotation' });
  if (input.kind !== 'SUGGESTION_CREATE' && input.replacementText !== undefined) context.addIssue({ code: 'custom', path: ['replacementText'], message: 'Replacement text only applies to suggestion creation' });
}).transform(input => ({ ...input, sourceVersionId: input.sourceVersionId ?? null }));
export type GoogleSyncPreviewInput = z.infer<typeof googleSyncPreviewInputSchema>;

export const googleSyncConfirmInputSchema = z.object({ previewId: uuid, commandKey, expectedArticleRevision: articleRevision }).strict();
export type GoogleSyncConfirmInput = z.infer<typeof googleSyncConfirmInputSchema>;

export const googleSyncPullInputSchema = z.object({ connectionId: uuid, sourceVersionId: uuid.nullable().optional(), commandKey, expectedArticleRevision: articleRevision }).strict();
export type GoogleSyncPullInput = z.infer<typeof googleSyncPullInputSchema>;

export const googleSyncReconcileInputSchema = z.object({ operationId: uuid, connectionId: uuid, commandKey }).strict();
export type GoogleSyncReconcileInput = z.infer<typeof googleSyncReconcileInputSchema>;

export const googleSyncBackgroundInputSchema = z.object({ connectionId: uuid, enabled: z.boolean(), expectedGeneration: z.number().int().min(0).max(2_147_483_647) }).strict();
export type GoogleSyncBackgroundInput = z.infer<typeof googleSyncBackgroundInputSchema>;

export interface GoogleSyncActor {
  userId: string;
  sessionId: string;
  noticeAcceptedAt: Date;
}

export interface GoogleSyncThreadView {
  id: string;
  remoteId: string;
  kind: 'comment' | 'suggestion';
  status: string;
  payload: unknown;
  quoteText: string | null;
  ranges: unknown[];
  anchorStatus: 'anchored' | 'unanchored';
  author: unknown;
  localAnnotationId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface GoogleSyncStatus {
  binding: unknown;
  state: unknown;
  threads: GoogleSyncThreadView[];
  localAnnotations: unknown[];
  versions: unknown[];
  operations: unknown[];
  baseline: unknown;
  localPreview: unknown;
  remotePreview: unknown;
}

export interface GoogleSyncPreview {
  previewId: string;
  kind: GoogleSyncPreviewKind;
  sourceVersionId: string | null;
  remoteRevision: string;
  localContent: unknown;
  remoteContent: unknown;
  baselineContent: unknown;
  hasConflict: boolean;
  unsupported: unknown[];
  writeMode: 'EDIT' | 'SUGGEST' | null;
  summary: string;
  expiresAt: string;
}
