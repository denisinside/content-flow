import { createHash, randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { briefProposalWorkflowInputSchema, validateBriefProposalOutput, type BriefProposalWorkflowInput } from './brief-proposal-contracts.js';

const sha256 = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex');
const releaseId = 'brief-proposal-test-v1';
const configDigest = sha256('brief-proposal-test-release');

function request(overrides: Partial<BriefProposalWorkflowInput> = {}): BriefProposalWorkflowInput {
  const excerpt = 'Дослідження охопило 120 учасників.';
  const base = {
    schemaVersion: 'brief-proposal-input-v1' as const,
    requestId: randomUUID(),
    topic: 'Доступність міського транспорту',
    contentMode: 'FACTUAL' as const,
    currentBrief: { topic: 'Доступність міського транспорту', audience: '', centralMessage: '', category: '', tone: '', targetLength: 800, cta: '', exclusions: [], notes: '' },
    style: { tone: '', brandbook: '' },
    sources: [{ snapshotId: randomUUID(), sha256: sha256(excerpt), label: 'Дослідження', excerpt, sampled: false }],
    requestHash: sha256('request'),
  };
  return { ...base, ...overrides } as BriefProposalWorkflowInput;
}

function output(input: BriefProposalWorkflowInput, overrides: Record<string, unknown> = {}) {
  return { schemaVersion: 'brief-proposal-output-v1', requestId: input.requestId, requestHash: input.requestHash, releaseId, configDigest,
    status: 'ready', brief: { topic: input.currentBrief.topic || input.topic, audience: 'Мешканці міста', centralMessage: 'Пояснити доступність на прикладах джерел.',
      category: 'Міське життя', tone: 'Точно й зрозуміло', targetLength: input.currentBrief.targetLength, cta: 'Ознайомитися з результатами.',
      exclusions: input.currentBrief.exclusions, notes: input.currentBrief.notes },
    assumptions: [], ...overrides };
}

describe('AI brief proposal contract', () => {
  it('accepts a bounded, source-backed request with an optional current brief', () => {
    const input = request();
    expect(briefProposalWorkflowInputSchema.parse(input)).toEqual(input);
  });

  it('rejects duplicate snapshots and source excerpts over the 60 KB aggregate limit', () => {
    const input = request();
    expect(briefProposalWorkflowInputSchema.safeParse({ ...input, sources: [input.sources[0], input.sources[0]] }).success).toBe(false);
    const oversized = 'x'.repeat(31_000);
    const first = { ...input.sources[0]!, excerpt: oversized };
    const second = { ...first, snapshotId: randomUUID() };
    expect(briefProposalWorkflowInputSchema.safeParse({ ...input, sources: [first, second] }).success).toBe(false);
  });

  it('rejects a workflow result that belongs to another request or workflow release', () => {
    const input = request();
    expect(validateBriefProposalOutput(output(input), input, releaseId, configDigest).status).toBe('ready');
    expect(() => validateBriefProposalOutput(output(input, { requestId: randomUUID() }), input, releaseId, configDigest)).toThrow();
    expect(() => validateBriefProposalOutput(output(input, { requestHash: sha256('different') }), input, releaseId, configDigest)).toThrow();
    expect(() => validateBriefProposalOutput(output(input, { releaseId: 'another-release' }), input, releaseId, configDigest)).toThrow();
    expect(() => validateBriefProposalOutput(output(input, { configDigest: sha256('another-config') }), input, releaseId, configDigest)).toThrow();
  });

  it('requires needs-human output to carry no proposed brief and a ready result to carry one', () => {
    const input = request();
    expect(() => validateBriefProposalOutput(output(input, { status: 'needs_human', brief: null,
      assumptions: ['У джерелах недостатньо даних для аудиторії.'] }), input, releaseId, configDigest)).not.toThrow();
    expect(() => validateBriefProposalOutput(output(input, { status: 'needs_human' }), input, releaseId, configDigest)).toThrow();
    expect(() => validateBriefProposalOutput(output(input, { brief: null }), input, releaseId, configDigest)).toThrow();
  });

  it('does not let the model rewrite fields the editor already supplied', () => {
    const input = request();
    const candidate = output(input).brief;
    expect(() => validateBriefProposalOutput(output(input, { brief: { ...candidate, topic: 'Інша тема' } }), input, releaseId, configDigest)).toThrow();
    expect(() => validateBriefProposalOutput(output(input, { brief: { ...candidate, targetLength: 1200 } }), input, releaseId, configDigest)).toThrow();
  });
});
