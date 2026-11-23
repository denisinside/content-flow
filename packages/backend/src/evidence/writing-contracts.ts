import { z } from 'zod';
import { canonicalManifestHash } from '../jobs/job-service.js';

const hash = z.string().regex(/^[a-f0-9]{64}$/u);
const text = (maximum: number) => z.string().max(maximum).refine(value => Buffer.from(value, 'utf8').toString('utf8') === value
  && !/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/u.test(value));
const nonempty = (maximum: number) => text(maximum).refine(value => !!value.trim());
const ids = z.array(z.uuid()).max(100).refine(value => new Set(value).size === value.length);
export const writingBriefSchema = z.object({ topic: nonempty(500), audience: text(2000), centralMessage: text(4000), category: text(120),
  tone: text(10000), targetLength: z.number().int().min(50).max(20000), cta: text(2000),
  exclusions: z.array(nonempty(500)).max(50), notes: text(10000) }).strict();
const sectionSchema = z.object({ id: z.uuid(), title: nonempty(300), purpose: nonempty(2000),
  targetWords: z.number().int().min(20).max(20000) }).strict();
export const sourceWritingInputSchema = z.object({ schemaVersion: z.literal('source-writing-input-v1'), requestId: z.uuid(),
  task: z.enum(['OUTLINE', 'SECTION', 'ADAPTATION']), brief: writingBriefSchema,
  style: z.object({ brandbook: text(20000), tone: text(10000), settings: z.unknown() }).strict(),
  context: z.array(z.object({ snapshotId: z.uuid(), purpose: z.enum(['NOTES', 'BRANDBOOK', 'STYLE_SAMPLE']),
    sha256: hash, text: text(150000) }).strict()).max(100),
  section: sectionSchema.optional(), approvedOutline: z.object({ title: nonempty(500),
    sections: z.array(sectionSchema).min(1).max(30) }).strict().optional(),
  format: z.enum(['TELEGRAM_POST', 'LINKEDIN_TEXT', 'LINKEDIN_COVER', 'INSTAGRAM_COVER', 'INSTAGRAM_CAROUSEL',
    'INSTAGRAM_STORIES', 'LINKEDIN_CAROUSEL']).optional(),
  approvedArticle: z.object({ versionId: z.uuid(), sha256: hash, title: nonempty(500), text: nonempty(100000) }).strict().optional(),
  passages: z.array(z.object({ id: z.uuid(), packetId: z.uuid(), snapshotId: z.uuid(), quote: nonempty(10000) }).strict()).max(1000),
  requiredClaims: z.array(z.object({ claimRevisionId: z.uuid(), wording: nonempty(2000),
    evidence: z.array(z.object({ evidenceId: z.uuid(), quote: nonempty(10000) }).strict()).min(1).max(10) }).strict()).max(100),
}).strict().superRefine((value, context) => {
  if (value.task === 'OUTLINE' && (value.section || value.approvedOutline || value.format || value.approvedArticle)
    || value.task === 'SECTION' && (!value.section || value.format || value.approvedArticle)
    || value.task === 'ADAPTATION' && (!value.format || value.section || value.approvedOutline)
    || new Set(value.passages.map(row => row.id)).size !== value.passages.length
    || new Set(value.context.map(row => row.snapshotId)).size !== value.context.length
    || value.approvedOutline && (new Set(value.approvedOutline.sections.map(row => row.id)).size !== value.approvedOutline.sections.length
      || value.approvedOutline.sections.reduce((sum,row) => sum+row.targetWords,0) !== value.brief.targetLength
      || !value.section || !value.approvedOutline.sections.some(row => canonicalManifestHash(row) === canonicalManifestHash(value.section)))
    || new Set(value.requiredClaims.map(row => row.claimRevisionId)).size !== value.requiredClaims.length
    || value.requiredClaims.some(row => new Set(row.evidence.map(item => item.evidenceId)).size !== row.evidence.length)
    || Buffer.byteLength(JSON.stringify(value)) > 150000
    || Buffer.byteLength(JSON.stringify({ passages: value.passages, requiredClaims: value.requiredClaims })) > 60000) {
    context.addIssue({ code: 'custom', message: 'Invalid task shape, source identity or writing context budget' });
  }
});
export type SourceWritingInput = z.infer<typeof sourceWritingInputSchema>;

const citationCommon = { quote: nonempty(10000), assertionText: nonempty(10000) };
export const sourceWritingCitationSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('source_passage'), passageId: z.uuid(), ...citationCommon }).strict(),
  z.object({ kind: z.literal('approved_claim'), claimRevisionId: z.uuid(), evidenceId: z.uuid(), ...citationCommon }).strict(),
]);
// The published outline runtime treats model-owned section IDs as lowercase UUID-shaped labels.
const outlineSectionLabel = z.union([
  z.uuid(),
  z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u),
]);
export const sourceOutlineBodySchema = z.object({ title: nonempty(500), sections: z.array(sectionSchema.extend({
  id: outlineSectionLabel, passageIds: ids, requiredClaimRevisionIds: ids }).strict()).min(1).max(30) }).strict();
// Published model-owned paragraph/frame labels can have UUID-shaped text without
// RFC version/variant bits. Canonicalize only output IDs; source/claim IDs stay strict.
const outputParagraphLabel = outlineSectionLabel;
const paragraphSchema = z.object({ id: outputParagraphLabel, text: nonempty(20000), citations: z.array(sourceWritingCitationSchema).max(100) }).strict();
export const sourceSectionBodySchema = z.object({ sectionId: z.uuid(), paragraphs: z.array(paragraphSchema).min(1).max(300) }).strict();
export const sourceFrameBodySchema = paragraphSchema.extend({ purpose: nonempty(200),visualHint: text(1000),transition: text(300),text: nonempty(3000) }).strict();
export const sourceAdaptationBodySchema = z.object({ title: nonempty(500).optional(),coverInstruction: text(2000).optional(),
  paragraphs: z.array(paragraphSchema).min(1).max(300),frames: z.array(sourceFrameBodySchema).min(1).max(30).optional() }).strict();
const reviewSchema = z.object({ status: z.enum(['ready', 'needs_human', 'insufficient_evidence']), issues: z.array(z.object({
  id: nonempty(100), severity: z.enum(['minor', 'major', 'critical']), paragraphId: outputParagraphLabel.optional(),
  sectionId: outlineSectionLabel.optional(), reason: nonempty(2000) }).strict()).max(100), reasons: z.array(nonempty(2000)).max(100),
  modelCalls: z.number().int().min(0).max(4) }).strict();
export const sourceWritingOutputSchema = z.object({ schemaVersion: z.literal('source-writing-v1'), requestId: z.uuid(),
  inputHash: hash, task: z.enum(['OUTLINE', 'SECTION', 'ADAPTATION']), status: z.enum(['ready', 'needs_human', 'insufficient_evidence']),
  content: z.unknown().nullable(), review: reviewSchema }).strict();
export type SourceWritingCitation = z.infer<typeof sourceWritingCitationSchema>;
export type SourceOutlineBody = z.infer<typeof sourceOutlineBodySchema>;
export type SourceSectionBody = z.infer<typeof sourceSectionBodySchema>;
export type SourceAdaptationBody = z.infer<typeof sourceAdaptationBodySchema>;

function exactlyOnce(haystack: string, needle: string): boolean {
  const start = haystack.indexOf(needle);
  return start >= 0 && haystack.indexOf(needle, start + 1) < 0;
}

function canonicalOutlineSectionId(requestId: string, label: string): string {
  if (z.uuid().safeParse(label).success) return label;
  const digest = canonicalManifestHash({ requestId, outlineSectionLabel: label });
  // UUIDv8 holds the server-derived ID with the RFC variant.
  return `${digest.slice(0, 8)}-${digest.slice(8, 12)}-8${digest.slice(13, 16)}-8${digest.slice(17, 20)}-${digest.slice(20, 32)}`;
}

function canonicalGeneratedParagraphId(requestId: string, label: string): string {
  if (z.uuid().safeParse(label).success) return label;
  const digest = canonicalManifestHash({ requestId, generatedParagraphLabel: label });
  return `${digest.slice(0, 8)}-${digest.slice(8, 12)}-8${digest.slice(13, 16)}-8${digest.slice(17, 20)}-${digest.slice(20, 32)}`;
}

/** Validates location and allowed evidence, not semantic truth or human approval. */
export function validateSourceWritingOutput(raw: unknown, input: SourceWritingInput) {
  const request = sourceWritingInputSchema.parse(input), output = sourceWritingOutputSchema.parse(raw);
  if (output.requestId !== request.requestId || output.task !== request.task || output.inputHash !== canonicalManifestHash(request)
    || output.review.status !== output.status || Buffer.byteLength(JSON.stringify(output)) > 500000) throw new Error('Writing output identity or bounds mismatch');
  if ((request.task !== 'OUTLINE' || output.status !== 'ready')
    && output.review.issues.some(issue => issue.sectionId && !z.uuid().safeParse(issue.sectionId).success)) {
    throw new Error('Writing review contains an invalid section identity');
  }
  if (output.status !== 'ready') {
    if (output.content !== null) throw new Error('An unresolved writing output cannot contain accepted content');
    return { ...output, content: null };
  }
  if (output.review.modelCalls < 2 || output.review.issues.some(issue => issue.severity !== 'minor')
    || !request.passages.length && !request.requiredClaims.length) throw new Error('Writing output lacks a completed supporting review');
  const passageIds = new Set(request.passages.map(row => row.id));
  const requiredIds = new Set(request.requiredClaims.map(row => row.claimRevisionId));
  if (request.task === 'OUTLINE') {
    const content = sourceOutlineBodySchema.parse(output.content);
    const sectionIds = new Map(content.sections.map(row => [row.id, canonicalOutlineSectionId(request.requestId, row.id)]));
    if (new Set(sectionIds.values()).size !== content.sections.length
      || content.sections.some(row => row.passageIds.some(id => !passageIds.has(id))
        || row.requiredClaimRevisionIds.some(id => !requiredIds.has(id)))
      || content.sections.reduce((sum, row) => sum + row.targetWords, 0) !== request.brief.targetLength
      || request.requiredClaims.some(claim => !content.sections.some(row => row.requiredClaimRevisionIds.includes(claim.claimRevisionId)))
      || !content.sections.some(row => row.passageIds.length || row.requiredClaimRevisionIds.length)) throw new Error('Outline contains invalid evidence coverage or word allocation');
    const sections = content.sections.map(row => ({ ...row, id: sectionIds.get(row.id)! }));
    const issues = output.review.issues.map(issue => issue.sectionId
      ? { ...issue, sectionId: z.uuid().parse(sectionIds.get(issue.sectionId) ?? issue.sectionId) }
      : issue);
    return { ...output, content: { ...content, sections }, review: { ...output.review, issues } };
  }
  const parsed = request.task === 'SECTION' ? sourceSectionBodySchema.parse(output.content) : sourceAdaptationBodySchema.parse(output.content);
  const rows = [...parsed.paragraphs, ...('frames' in parsed ? parsed.frames ?? [] : [])];
  const canonicalIds = new Map(rows.map(row => [row.id, canonicalGeneratedParagraphId(request.requestId, row.id)]));
  if (canonicalIds.size !== rows.length || new Set(canonicalIds.values()).size !== rows.length) {
    throw new Error('Duplicate paragraph or frame identity');
  }
  const content = { ...parsed,
    paragraphs: parsed.paragraphs.map(row => ({ ...row, id: canonicalIds.get(row.id)! })),
    ...('frames' in parsed && parsed.frames
      ? { frames: parsed.frames.map(row => ({ ...row, id: canonicalIds.get(row.id)! })) } : {}) };
  if (request.task === 'SECTION' && (!('sectionId' in content) || content.sectionId !== request.section?.id)) throw new Error('Section identity changed');
  const frames = 'frames' in content ? content.frames ?? [] : [];
  if (request.task === 'ADAPTATION') {
    const scripted = ['LINKEDIN_CAROUSEL','INSTAGRAM_CAROUSEL','INSTAGRAM_STORIES'].includes(request.format!);
    const cover = request.format!.includes('COVER');
    const prose = content.paragraphs.map(row => row.text).join('\n\n');
    if (scripted !== (frames.length > 0) || prose.length > (request.format === 'TELEGRAM_POST' ? 4080 : 10000)
      || cover && (!('title' in content) || !content.title?.trim() || content.title.length > 200 || !('coverInstruction' in content) || !content.coverInstruction?.trim())
      || !cover && 'coverInstruction' in content
      || frames.reduce((sum,row) => sum+row.text.length,0) > 30000
      || frames.reduce((sum,row) => sum+row.citations.length,0) > 100
      || frames.some(row => request.format === 'INSTAGRAM_STORIES' ? !row.transition.trim() : !!row.transition)
      || scripted && !frames.some(row => row.citations.some(citation => citation.kind === 'source_passage'))
      || request.requiredClaims.some(claim => scripted && !frames.some(row => row.citations.some(citation => citation.kind === 'approved_claim' && citation.claimRevisionId === claim.claimRevisionId)))) throw new Error('Channel output has invalid format or script coverage');
  }
  const paragraphs = [...content.paragraphs,...frames];
  if (new Set(paragraphs.map(row => row.id)).size !== paragraphs.length) throw new Error('Duplicate paragraph or frame identity');
  const citedClaims = new Set<string>();
  for (const paragraph of paragraphs) {
    const ranges: { start: number; end: number }[] = [];
    for (const citation of paragraph.citations) {
    const quote = citation.kind === 'source_passage' ? request.passages.find(row => row.id === citation.passageId)?.quote
      : request.requiredClaims.find(row => row.claimRevisionId === citation.claimRevisionId)?.evidence.find(row => row.evidenceId === citation.evidenceId)?.quote;
    if (!quote || !exactlyOnce(quote, citation.quote) || !exactlyOnce(paragraph.text, citation.assertionText)) throw new Error('Citation does not resolve to exact allowed source and output text');
    if (request.task === 'ADAPTATION' && citation.kind === 'approved_claim' && (citation.quote !== quote || citation.assertionText !== quote)) throw new Error('Legacy channel evidence must preserve its entire approved quotation');
    const start = paragraph.text.indexOf(citation.assertionText), end = start + citation.assertionText.length;
    if (ranges.some(range => start < range.end && end > range.start)) throw new Error('Citation output ranges overlap');
    ranges.push({ start, end });
    if (citation.kind === 'approved_claim') citedClaims.add(citation.claimRevisionId);
  }
  }
  if (request.requiredClaims.some(row => !citedClaims.has(row.claimRevisionId))
    || !content.paragraphs.some(row => row.citations.length)) throw new Error('Writing output omits its required supporting evidence');
  const issues = output.review.issues.map(issue => {
    if (!issue.paragraphId) return issue;
    const mapped = canonicalIds.get(issue.paragraphId);
    if (!mapped) throw new Error('Writing review references an unknown paragraph or frame');
    return { ...issue, paragraphId: mapped };
  });
  return { ...output, content, review: { ...output.review, issues } };
}
