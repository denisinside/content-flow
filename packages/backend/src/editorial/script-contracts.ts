import { z } from 'zod';

const clean = (max: number) => z.string().max(max).refine(value => !/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/u.test(value));
export const scriptMappingSchema = z.object({ startOffset: z.number().int().nonnegative(), endOffset: z.number().int().positive(),
  quote: clean(3000).min(1), claimRevisionId: z.uuid(), evidenceId: z.uuid() }).strict();
export const scriptSourceMappingSchema = z.object({ startOffset: z.number().int().nonnegative(), endOffset: z.number().int().positive(),
  quote: clean(10000).min(1), passageId: z.uuid(), packetId: z.uuid() }).strict();
export const scriptFrameSchema = z.object({ id: z.uuid(), purpose: clean(200).trim().min(1), text: clean(3000), visualHint: clean(1000),
  transition: clean(300), mappings: z.array(scriptMappingSchema).max(100), sourceMappings: z.array(scriptSourceMappingSchema).max(100).optional() }).strict().superRefine((frame, ctx) => {
  const ranges = [
    ...frame.mappings.map(map => ({ ...map, kind: 'claim' as const })),
    ...(frame.sourceMappings ?? []).map(map => ({ ...map, kind: 'source' as const })),
  ].sort((a, b) => a.startOffset - b.startOffset || a.endOffset - b.endOffset);
  let end = 0;
  for (const map of ranges) {
    if (map.startOffset < end || map.endOffset <= map.startOffset || map.endOffset > frame.text.length
      || map.kind === 'claim' && frame.text.slice(map.startOffset, map.endOffset) !== map.quote) {
      ctx.addIssue({ code: 'custom', message: 'Frame evidence must use bounded, nonoverlapping text ranges; claim quotes must match exactly' });
    }
    end = Math.max(end, map.endOffset);
  }
});
export const scriptContentSchema = z.object({ frames: z.array(scriptFrameSchema).min(1).max(30) }).strict().superRefine((content, ctx) => {
  if (new Set(content.frames.map(frame => frame.id)).size !== content.frames.length) ctx.addIssue({ code: 'custom', message: 'Frame IDs must be unique' });
  if (content.frames.reduce((sum, frame) => sum + frame.text.length, 0) > 30000) ctx.addIssue({ code: 'custom', message: 'Script text exceeds operational bounds' });
  if (content.frames.reduce((sum, frame) => sum + frame.mappings.length + (frame.sourceMappings?.length ?? 0), 0) > 100) ctx.addIssue({ code: 'custom', message: 'Script evidence exceeds operational bounds' });
  if (Buffer.byteLength(JSON.stringify(content), 'utf8') > 280000) ctx.addIssue({ code: 'custom', message: 'Script content exceeds operational bounds' });
});
export const scriptSaveDraftInput = z.object({ expectedRevision: z.number().int().nonnegative(), expectedDraftCounter: z.number().int().nonnegative(),
  parentAdaptationRevisionId: z.uuid(), content: scriptContentSchema }).strict();
export const scriptCheckpointInput = z.object({ expectedRevision: z.number().int().nonnegative(), expectedDraftCounter: z.number().int().nonnegative() }).strict();
export const scriptReviewInput = z.object({ expectedRevision: z.number().int().nonnegative(), expectedReviewCounter: z.number().int().nonnegative().optional(),
  frameIds: z.array(z.uuid()).max(30).optional(), acknowledgeUnmapped: z.boolean().optional(), reason: clean(2000).trim().min(1).optional() }).strict();
export type ScriptContent = z.infer<typeof scriptContentSchema>;
export type ScriptFrame = z.infer<typeof scriptFrameSchema>;
export type ScriptReviewInput = z.infer<typeof scriptReviewInput>;
