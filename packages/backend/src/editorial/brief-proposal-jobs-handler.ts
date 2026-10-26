import { randomUUID } from 'node:crypto';
import { HttpException } from '@nestjs/common';
import { z } from 'zod';
import type { Prisma, PrismaClient, Job } from '../generated/prisma/client.js';
import { JobFailure, JobFenceLost, type JobContext, type JobHandler } from '../jobs/contracts.js';
import { canonicalManifestHash } from '../jobs/job-service.js';
import { EXTERNAL_PROCESSING_NOTICE } from '../external-processing-notice.js';
import { DifyJsonWorkflowProvider, SourceWritingProviderError } from '../evidence/writing-provider.js';
import { briefProposalWorkflowInputSchema, type BriefProposalWorkflowInput } from './brief-proposal-contracts.js';
import { BRIEF_PROPOSAL_CONFIG_DIGEST, BRIEF_PROPOSAL_RELEASE_ID, briefProposalWorkflowSettings,
  briefProposalWorkflowTransport, validateBriefProposalProviderOutput } from './brief-proposal-provider.js';
import { BriefProposalService, type BriefProposalManifest } from './brief-proposal.service.js';

const CONTRACT = 'brief-proposal-v1';
type Provider = Pick<DifyJsonWorkflowProvider, 'execute' | 'resume'>;
type Manifest = BriefProposalManifest;
type Result = { output: unknown; executionId: string; providerRunId: string; model: string | null };

function json(value: unknown): Prisma.InputJsonValue { return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue; }
function failure(error: unknown): never {
  if (error instanceof JobFailure || error instanceof JobFenceLost || error instanceof HttpException) throw error;
  if (error instanceof SourceWritingProviderError) throw new JobFailure(({ CONFIG: 'CONFIG_CHANGED', AUTH: 'PROVIDER_AUTH',
    INVALID_INPUT: 'INVALID_INPUT', INCOMPATIBLE_CONTRACT: 'INVALID_CONTRACT', QUOTA: 'QUOTA', RATE_LIMIT: 'RATE_LIMIT',
    TRANSIENT_TRANSPORT: 'TRANSIENT_TRANSPORT', TIMEOUT: 'TIMEOUT', UNKNOWN_OUTCOME: 'UNKNOWN_OUTCOME', PROVIDER_FAILED: 'PROVIDER_FAILED' })[error.code], error.outcome);
  throw new JobFailure('INVALID_CONTRACT', 'KNOWN_FAILED');
}

function parseManifest(job: Job) {
  const value = job.inputManifest as unknown as Manifest;
  const { requestHash, ...requestBase } = value?.request ?? {} as BriefProposalWorkflowInput;
  if (!value || value.schemaVersion !== 'brief-proposal-job-v1' || job.operation !== 'BRIEF_PROPOSAL' || job.contractVersion !== CONTRACT
    || canonicalManifestHash({ contractVersion: job.contractVersion, inputManifest: job.inputManifest }) !== job.inputHash
    || requestHash !== canonicalManifestHash(requestBase) || value.request?.requestHash !== requestHash
    || value.request?.requestId == null || value.release?.releaseId !== BRIEF_PROPOSAL_RELEASE_ID
    || value.release?.configDigest !== BRIEF_PROPOSAL_CONFIG_DIGEST
    || value.noticeVersion !== EXTERNAL_PROCESSING_NOTICE.version) throw new JobFailure('INPUT_INTEGRITY', 'NOT_SUBMITTED');
  const parsed = briefProposalWorkflowInputSchema.safeParse(value.request);
  if (!parsed.success || parsed.data.requestHash !== requestHash || parsed.data.sources.length !== value.sources.length) throw new JobFailure('INPUT_INTEGRITY', 'NOT_SUBMITTED');
  return value;
}

function providerInput(manifest: Manifest) { return briefProposalWorkflowInputSchema.parse(manifest.request); }

export function createBriefProposalJobHandler(deps: { prisma: PrismaClient; proposals: BriefProposalService;
  provider?: Provider; env?: Record<string, string | undefined> }): JobHandler {
  const provider = deps.provider ?? briefProposalWorkflowTransport;
  const env = deps.env ?? process.env;
  async function call(context: JobContext, runId?: string): Promise<Result> {
    try {
      const manifest = parseManifest(context.job);
      const settings = briefProposalWorkflowSettings(env);
      const { apiKey: _apiKey, ...release } = settings;
      void _apiKey;
      if (canonicalManifestHash(release) !== canonicalManifestHash(manifest.release)) throw new JobFailure('CONFIG_CHANGED', 'NOT_SUBMITTED');
      const current = await deps.prisma.$transaction(tx => deps.proposals.isCurrent(tx, context.job.projectId, manifest));
      if (!current) throw new JobFailure('STALE_INPUT', 'NOT_SUBMITTED');
      const request = providerInput(manifest);
      const execution = await deps.prisma.aIExecution.upsert({ where: { attemptId: context.attempt.id }, update: {}, create: {
        id: randomUUID(), projectId: context.job.projectId, jobId: context.job.id, attemptId: context.attempt.id,
        workflowId: release.workflowId, releaseId: release.releaseId, configDigest: release.configDigest,
        contractVersion: CONTRACT, promptTemplateVersion: 'brief-proposal-prompt-v1',
        inputManifest: json(context.job.inputManifest), inputHash: context.job.inputHash, providerRunId: runId ?? null,
      } });
      let captured = runId;
      const record = async (id: string) => {
        if (captured && captured !== id) throw new SourceWritingProviderError('INCOMPATIBLE_CONTRACT', 'Brief proposal workflow changed run identity');
        if (!captured) { captured = id; await context.recordProviderRun(id); }
        await deps.prisma.aIExecution.updateMany({ where: { id: execution.id, status: 'RUNNING' }, data: { providerRunId: id } });
      };
      let result: Awaited<ReturnType<Provider['execute']>>;
      if (runId) result = await provider.resume(settings, runId, request, context.signal);
      else {
        try { result = await provider.execute(settings, context.job.id, request, context.signal, () => context.recordSubmissionIntent(), record); }
        catch (error) {
          if (!captured || !(error instanceof SourceWritingProviderError)
            || !['UNKNOWN_OUTCOME', 'TRANSIENT_TRANSPORT', 'TIMEOUT'].includes(error.code)) throw error;
          result = await provider.resume(settings, captured, request, context.signal);
        }
      }
      if (captured && captured !== result.workflowRunId) throw new SourceWritingProviderError('INCOMPATIBLE_CONTRACT', 'Brief proposal workflow changed run identity');
      await record(result.workflowRunId);
      const output = validateBriefProposalProviderOutput(result.output, request);
      return { output, executionId: execution.id, providerRunId: result.workflowRunId, model: result.model };
    } catch (error) { return failure(error); }
  }

  return { operation: 'BRIEF_PROPOSAL',
    async validateSubmission(tx, job) {
      const manifest = parseManifest(job);
      if (!await deps.proposals.isCurrent(tx, job.projectId, manifest)) throw new JobFailure('STALE_INPUT', 'NOT_SUBMITTED');
    },
    execute: context => call(context),
    resume: (context, id) => call(context, id),
    async commit(tx, raw, job) {
      try {
        const result = z.object({ output: z.unknown(), executionId: z.uuid(),
          providerRunId: z.uuid(), model: z.string().max(200).nullable() }).strict().parse(raw) as Result;
        const manifest = parseManifest(job);
        if (!await deps.proposals.isCurrent(tx, job.projectId, manifest)) throw new JobFailure('STALE_INPUT', 'KNOWN_SUCCEEDED');
        const request = providerInput(manifest);
        const output = validateBriefProposalProviderOutput(result.output, request);
        const updated = await tx.aIExecution.updateMany({ where: { id: result.executionId, jobId: job.id, projectId: job.projectId, status: 'RUNNING' },
          data: { status: 'SUCCEEDED', providerRunId: result.providerRunId, model: result.model, finishedAt: new Date(), errorCategory: null } });
        if (updated.count !== 1) throw new JobFailure('INVALID_CONTRACT', 'KNOWN_SUCCEEDED');
        return json({ schemaVersion: 'brief-proposal-result-v1', output, aiExecutionId: result.executionId, requestHash: request.requestHash,
          sources: manifest.sources.map(({ snapshotId, label, sampled, sourceBytes, excerptBytes }) => ({ snapshotId, label, sampled, sourceBytes, excerptBytes })) });
      } catch (error) { return failure(error); }
    },
    async failed(context) {
      const job = await deps.prisma.job.findUnique({ where: { id: context.job.id }, select: { providerOutcome: true, errorCategory: true } });
      if (!job) return;
      await deps.prisma.aIExecution.updateMany({ where: { attemptId: context.attempt.id, status: 'RUNNING' }, data: {
        status: ['UNKNOWN', 'MAY_STILL_RUN'].includes(job.providerOutcome) ? 'OUTCOME_UNKNOWN' : 'FAILED',
        errorCategory: job.errorCategory ?? 'EXECUTION_FAILED', finishedAt: new Date() } });
    } };
}
