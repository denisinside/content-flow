import { z } from 'zod';

const text = (max: number) => z.string().trim().max(max).refine(value => !/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/u.test(value));
const rawText = (max: number) => z.string().max(max).refine(value => !/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/u.test(value));
const hash = z.string().regex(/^[a-f0-9]{64}$/u);

export const briefProposalFieldsSchema = z.object({
  topic: text(500),
  audience: text(2000),
  centralMessage: text(4000),
  category: text(120),
  tone: text(10000),
  targetLength: z.number().int().min(50).max(20000),
  cta: text(2000),
  exclusions: z.array(text(500).min(1)).max(50),
  notes: text(10000),
}).strict();

export const briefProposalCommandSchema = z.object({
  commandKey: z.uuid(),
  expectedRevision: z.number().int().nonnegative(),
  contentMode: z.enum(['FACTUAL', 'CREATIVE']),
  currentBrief: briefProposalFieldsSchema,
}).strict();

export const briefProposalWorkflowInputSchema = z.object({
  schemaVersion: z.literal('brief-proposal-input-v1'),
  requestId: z.uuid(),
  topic: rawText(500).min(1),
  contentMode: z.enum(['FACTUAL', 'CREATIVE']),
  currentBrief: briefProposalFieldsSchema,
  style: z.object({ tone: rawText(10000), brandbook: rawText(50000) }).strict(),
  sources: z.array(z.object({ snapshotId: z.uuid(), sha256: hash, label: rawText(200).min(1),
    excerpt: rawText(60000).min(1), sampled: z.boolean() }).strict()).max(20),
  requestHash: hash,
}).strict().superRefine((value, context) => {
  if ((value.contentMode === 'FACTUAL' && !value.sources.length)
    || new Set(value.sources.map(source => source.snapshotId)).size !== value.sources.length
    || value.sources.some(source => Buffer.byteLength(source.excerpt, 'utf8') > 60_000)
    || value.sources.reduce((total, source) => total + Buffer.byteLength(source.excerpt, 'utf8'), 0) > 60_000
    || Buffer.byteLength(JSON.stringify(value), 'utf8') > 120_000) {
    context.addIssue({ code: 'custom', message: 'Invalid brief proposal request bounds or source identities' });
  }
});

export const briefProposalOutputSchema = z.object({
  schemaVersion: z.literal('brief-proposal-output-v1'),
  requestId: z.uuid(),
  requestHash: hash,
  releaseId: text(100).min(1),
  configDigest: hash,
  status: z.enum(['ready', 'needs_human']),
  brief: briefProposalFieldsSchema.nullable(),
  assumptions: z.array(text(1000).min(1)).max(10),
}).strict().superRefine((value, context) => {
  if (value.status === 'needs_human' && value.assumptions.length === 0) {
    context.addIssue({ code: 'custom', message: 'Human review output must explain what needs review' });
  }
  if (value.status === 'ready' && (!value.brief || !value.brief.audience || !value.brief.centralMessage || !value.brief.category || !value.brief.tone)) {
    context.addIssue({ code: 'custom', message: 'Ready brief proposal must provide its key editorial fields' });
  }
});

export type BriefProposalFields = z.infer<typeof briefProposalFieldsSchema>;
export type BriefProposalCommand = z.infer<typeof briefProposalCommandSchema>;
export type BriefProposalWorkflowInput = z.infer<typeof briefProposalWorkflowInputSchema>;
export type BriefProposalWorkflowOutput = z.infer<typeof briefProposalOutputSchema>;

export function validateBriefProposalOutput(raw: unknown, input: BriefProposalWorkflowInput, releaseId: string, configDigest: string): BriefProposalWorkflowOutput {
  const output = briefProposalOutputSchema.parse(raw);
  if (output.requestId !== input.requestId || output.requestHash !== input.requestHash || output.releaseId !== releaseId || output.configDigest !== configDigest
    || (output.status === 'ready') !== (output.brief !== null)) throw new Error('Brief proposal output did not match its frozen request');
  if (output.status === 'ready' && output.brief) {
    const candidate = output.brief;
    if (candidate.topic !== (input.currentBrief.topic || input.topic) || candidate.targetLength !== input.currentBrief.targetLength
      || JSON.stringify(candidate.exclusions) !== JSON.stringify(input.currentBrief.exclusions) || candidate.notes !== input.currentBrief.notes) {
      throw new Error('Brief proposal changed fields owned by the editor');
    }
  }
  return output;
}
