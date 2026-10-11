import { z } from 'zod';

const counter = z.number().int().nonnegative();
export const listArticleAnnotationsInput = z.object({ targetVersionId: z.uuid().optional() }).strict();
export const createArticleAnnotationInput = z.object({
  articleVersionId: z.uuid(), contentHash: z.string().regex(/^[a-f0-9]{64}$/),
  anchorStart: z.number().int().nonnegative(), anchorEnd: z.number().int().positive(),
  body: z.string().trim().min(1).max(2000), kind: z.enum(['COMMENT', 'SUGGESTION']),
  replacementText: z.string().max(100000).optional(), commandKey: z.uuid()
}).strict().superRefine((value, ctx) => {
  if (value.anchorEnd <= value.anchorStart) ctx.addIssue({ code: 'custom', message: 'Annotation range must be nonempty' });
  if ((value.kind === 'SUGGESTION') !== (value.replacementText !== undefined)) ctx.addIssue({ code: 'custom', message: 'Suggestions require replacement text; comments do not' });
});
export const replyArticleAnnotationInput = z.object({ expectedRevision: counter, body: z.string().trim().min(1).max(2000) }).strict();
export const actArticleAnnotationInput = z.object({ expectedRevision: counter, action: z.enum(['RESOLVE', 'REOPEN', 'ACCEPT', 'REJECT']), expectedArticleRevision: counter.optional() }).strict().superRefine((value, ctx) => {
  if (value.action === 'ACCEPT' && value.expectedArticleRevision === undefined) ctx.addIssue({ code: 'custom', message: 'Accepting a suggestion requires the current article revision' });
  if (value.action !== 'ACCEPT' && value.expectedArticleRevision !== undefined) ctx.addIssue({ code: 'custom', message: 'Article revision is only used when accepting a suggestion' });
});
export type CreateArticleAnnotationInput = z.infer<typeof createArticleAnnotationInput>;
export type ActArticleAnnotationInput = z.infer<typeof actArticleAnnotationInput>;

/** UTF-16 offsets and block separators match articleDocumentDetails.plainText. */
export function projectAnchor(text: string, quote: string, prefix: string, suffix: string): { status: 'EXACT' | 'UNRESOLVED'; start: number | null; end: number | null } {
  const found: number[] = [];
  for (let from = 0; from <= text.length - quote.length;) {
    const at = text.indexOf(quote, from); if (at < 0) break;
    const before = text.slice(Math.max(0, at - prefix.length), at), after = text.slice(at + quote.length, at + quote.length + suffix.length);
    if (before.endsWith(prefix) && after.startsWith(suffix)) found.push(at);
    from = at + 1;
  }
  return found.length === 1 ? { status: 'EXACT', start: found[0]!, end: found[0]! + quote.length } : { status: 'UNRESOLVED', start: null, end: null };
}
