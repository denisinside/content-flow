import { z } from 'zod';

export type ArticleMark = { type: 'bold' | 'italic' | 'strike' } | { type: 'evidence'; attrs: { claimRevisionId: string; evidenceId: string; quote: string } }
  | { type: 'source_evidence'; attrs: { passageId: string; packetId: string; quote: string } };
export type ArticleNode = { type: 'doc' | 'paragraph' | 'heading' | 'bulletList' | 'orderedList' | 'listItem' | 'blockquote' | 'text' | 'hardBreak'; attrs?: { level: 2 | 3 }; text?: string; marks?: ArticleMark[]; content?: ArticleNode[] };
const evidenceMark = z.object({ type: z.literal('evidence'), attrs: z.object({ claimRevisionId: z.uuid(), evidenceId: z.uuid(), quote: z.string().min(1).max(10000) }).strict() }).strict();
const sourceEvidenceMark = z.object({ type: z.literal('source_evidence'), attrs: z.object({ passageId: z.uuid(), packetId: z.uuid(), quote: z.string().min(1).max(10000) }).strict() }).strict();
const mark = z.union([evidenceMark, sourceEvidenceMark, z.object({ type: z.enum(['bold', 'italic', 'strike']) }).strict()]);
const node: z.ZodType<ArticleNode> = z.lazy(() => z.object({ type: z.enum(['doc', 'paragraph', 'heading', 'bulletList', 'orderedList', 'listItem', 'blockquote', 'text', 'hardBreak']), attrs: z.object({ level: z.union([z.literal(2), z.literal(3)]) }).strict().optional(), text: z.string().min(1).max(100000).optional(), marks: z.array(mark).max(4).optional(), content: z.array(node).max(1000).optional() }).strict()) as z.ZodType<ArticleNode>;
const boundedJson = z.unknown().superRefine((value, ctx) => {
  const stack: { value: unknown; depth: number }[] = [{ value, depth: 0 }]; let count = 0;
  while (stack.length) {
    const entry = stack.pop()!;
    if (++count > 30000 || entry.depth > 30) { ctx.addIssue({ code: 'custom', message: 'Article exceeds JSON limits' }); return; }
    if (entry.value && typeof entry.value === 'object') for (const child of Object.values(entry.value)) stack.push({ value: child, depth: entry.depth + 1 });
  }
  if (Buffer.byteLength(JSON.stringify(value) ?? '') > 500000) ctx.addIssue({ code: 'custom', message: 'Article exceeds byte limit' });
});
export const articleContentSchema = boundedJson.pipe(z.object({ title: z.string().trim().min(1).max(500), document: node }).strict().superRefine((value, ctx) => {
  let count = 0, evidenceNodes = 0,legacyEvidenceNodes = 0;
  function walk(current: ArticleNode, depth: number, parent?: ArticleNode['type']) {
    if (++count > 5000 || depth > 12) { ctx.addIssue({ code: 'custom', message: 'Article exceeds document limits' }); return; }
    const inline = current.type === 'text' || current.type === 'hardBreak';
    if ((current.type === 'doc') !== (depth === 0) || (current.type === 'text') !== (current.text !== undefined) || (current.type === 'heading') !== (current.attrs !== undefined)
      || (current.marks !== undefined && current.type !== 'text') || (inline && current.content !== undefined)) ctx.addIssue({ code: 'custom', message: 'Invalid article node shape' });
    if (current.marks && new Set(current.marks.map(row => row.type)).size !== current.marks.length) ctx.addIssue({ code: 'custom', message: 'Duplicate marks' });
    if (current.marks?.some(row => row.type === 'evidence') && current.marks.some(row => row.type === 'source_evidence')) ctx.addIssue({ code: 'custom', message: 'A text span cannot carry both claim and source evidence' });
    if (current.marks?.some(row => row.type === 'evidence') && ++legacyEvidenceNodes > 200) ctx.addIssue({ code: 'custom',message: 'Article accepts at most 200 approved-claim evidence spans' });
    if (current.marks?.some(row => row.type === 'evidence' || row.type === 'source_evidence') && ++evidenceNodes > 1000) ctx.addIssue({ code: 'custom', message: 'Article accepts at most 1000 evidence spans' });
    if (['doc', 'bulletList', 'orderedList', 'listItem', 'blockquote'].includes(current.type) && !current.content?.length) ctx.addIssue({ code: 'custom', message: 'Container cannot be empty' });
    if (current.type === 'listItem' && current.content?.[0]?.type !== 'paragraph') ctx.addIssue({ code: 'custom', message: 'List item starts with paragraph' });
    if (parent === 'paragraph' || parent === 'heading') { if (!inline) ctx.addIssue({ code: 'custom', message: 'Block requires inline content' }); }
    else if (parent === 'bulletList' || parent === 'orderedList') { if (current.type !== 'listItem') ctx.addIssue({ code: 'custom', message: 'List requires items' }); }
    else if (parent && (inline || current.type === 'listItem')) ctx.addIssue({ code: 'custom', message: 'Invalid block child' });
    for (const child of current.content ?? []) walk(child, depth + 1, current.type);
  }
  walk(value.document, 0);
  if (Buffer.byteLength(JSON.stringify(value)) > 500000) ctx.addIssue({ code: 'custom', message: 'Article exceeds byte limit' });
}));
export type ArticleContent = z.infer<typeof articleContentSchema>;
export type ArticleMapping = { claimRevisionId: string; evidenceId: string; quote: string; text: string; locator: string };
export type ArticleSourceMapping = { passageId: string; packetId: string; quote: string; text: string; locator: string };
export function articleDocumentDetails(content: ArticleContent): { plainText: string; mappings: ArticleMapping[]; sourceMappings: ArticleSourceMapping[]; hasUnmapped: boolean } {
  const blocks: string[] = [], mappings: ArticleMapping[] = [], sourceMappings: ArticleSourceMapping[] = []; let hasUnmapped = content.title.trim().length > 0;
  function walk(current: ArticleNode, path: string) {
    if (current.type === 'paragraph' || current.type === 'heading') {
      let block = '', activeClaim: ArticleMapping | undefined;
      for (const [index, child] of (current.content ?? []).entries()) {
        const text = child.type === 'hardBreak' ? '\n' : child.text ?? ''; block += text;
        const claimEvidence = child.marks?.find((row): row is Extract<ArticleMark, { type: 'evidence' }> => row.type === 'evidence');
        const sourceEvidence = child.marks?.find((row): row is Extract<ArticleMark, { type: 'source_evidence' }> => row.type === 'source_evidence');
        if (claimEvidence && sourceEvidence) throw new Error('A text span cannot carry both claim and source evidence marks');
        if (claimEvidence) {
          if (activeClaim && activeClaim.claimRevisionId === claimEvidence.attrs.claimRevisionId && activeClaim.evidenceId === claimEvidence.attrs.evidenceId && activeClaim.quote === claimEvidence.attrs.quote) activeClaim.text += text;
          else { activeClaim = { ...claimEvidence.attrs, text, locator: `${path}.${index}` }; mappings.push(activeClaim); }
        } else if (sourceEvidence) {
          activeClaim = undefined;
          sourceMappings.push({ ...sourceEvidence.attrs, text, locator: `${path}.${index}` });
        } else { activeClaim = undefined; if (text.trim()) hasUnmapped = true; }
      }
      blocks.push(block);
    } else for (const [index, child] of (current.content ?? []).entries()) walk(child, `${path}.${index}`);
  }
  walk(content.document, 'doc');
  return { plainText: blocks.join('\n\n'), mappings, sourceMappings, hasUnmapped };
}
const revision = z.number().int().min(0);
export const saveArticleDraftInput = z.object({ expectedRevision: revision, contentMode: z.enum(['FACTUAL', 'CREATIVE']), content: articleContentSchema, refreshInputs: z.boolean().optional() }).strict();
export const importArticleInput = z.object({ expectedRevision: revision, contentMode: z.enum(['FACTUAL', 'CREATIVE']).default('CREATIVE'), content: articleContentSchema.optional(), snapshotId: z.uuid().optional() }).strict().refine(value => !!value.content !== !!value.snapshotId, 'Provide content or supplied snapshot');
export const checkpointArticleInput = z.object({ expectedRevision: revision }).strict();
export const reviewArticleInput = z.object({ expectedRevision: revision, reason: z.string().trim().min(1).max(2000).optional(), acknowledgeUnmapped: z.boolean().optional() }).strict();
export const generateArticleInput = z.object({ expectedRevision: revision, commandKey: z.uuid() }).strict();
export const articleWorkflowReleaseSchema = z.object({ endpoint: z.url(), workflowId: z.uuid(), releaseId: z.string().min(1).max(100), configDigest: z.string().regex(/^[a-f0-9]{64}$/), contractVersion: z.literal('article-v1'), promptTemplateVersion: z.string().min(1).max(64) }).strict();
export type ArticleWorkflowRelease = z.infer<typeof articleWorkflowReleaseSchema>;
export const articleInputManifestSchema = z.object({ schemaVersion: z.literal('article-input-v1'), articleRevision: revision, briefRevisionId: z.uuid(), briefHash: z.string().regex(/^[a-f0-9]{64}$/), outlineRevisionId: z.uuid(), outlineHash: z.string().regex(/^[a-f0-9]{64}$/), workspaceId: z.uuid(), workspaceStyleRevision: z.number().int().positive(), contentMode: z.enum(['FACTUAL', 'CREATIVE']), basisRevisionId: z.uuid().nullable(), basisHash: z.string().regex(/^[a-f0-9]{64}$/).nullable(), contextSnapshotIds: z.array(z.uuid()).max(100).refine(ids => new Set(ids).size === ids.length), release: articleWorkflowReleaseSchema, noticeVersion: z.string().min(1), acceptedAt: z.iso.datetime() }).strict().refine(value => value.contentMode === 'FACTUAL' ? !!value.basisRevisionId && !!value.basisHash : value.basisRevisionId === null && value.basisHash === null);
export const articleOutputSchema = z.object({ schemaVersion: z.literal('article-v1'), content: articleContentSchema }).strict();
export type ArticleOutput = z.infer<typeof articleOutputSchema>;
export type ArticleInputManifest = z.infer<typeof articleInputManifestSchema>;
export type SaveArticleDraftInput = z.infer<typeof saveArticleDraftInput>;
export type ImportArticleInput = z.infer<typeof importArticleInput>;
export type ReviewArticleInput = z.infer<typeof reviewArticleInput>;

