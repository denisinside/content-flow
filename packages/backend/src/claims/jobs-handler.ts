import { randomUUID } from 'node:crypto';
import { HttpException } from '@nestjs/common';
import { z } from 'zod';
import type { Prisma, PrismaClient } from '../generated/prisma/client.js';
import { JobFailure, JobFenceLost, type JobContext, type JobHandler } from '../jobs/contracts.js';
import { canonicalManifestHash } from '../jobs/job-service.js';
import { CLAIMS_CONTRACT, ClaimProviderError, DifyClaimProvider, claimWorkflowSettings, sha256,
  type ClaimSourceInput, type ClaimWorkflowSettings } from './provider.js';
import { claimInputManifestSchema, claimsOutputSchema, type ClaimInputManifest } from './contracts.js';
import type { FactualBasisService } from './factual-basis.service.js';

function prismaJson(value: unknown): Prisma.InputJsonValue { return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue; }
function providerCategory(code: ClaimProviderError['code']): string {
  return ({ CONFIG: 'CONFIG_CHANGED', AUTH: 'PROVIDER_AUTH', INVALID_INPUT: 'INVALID_INPUT', INCOMPATIBLE_CONTRACT: 'INVALID_CONTRACT',
    QUOTA: 'QUOTA', RATE_LIMIT: 'RATE_LIMIT', TRANSIENT_TRANSPORT: 'TRANSIENT_TRANSPORT', TIMEOUT: 'TIMEOUT',
    UNKNOWN_OUTCOME: 'UNKNOWN_OUTCOME', PROVIDER_FAILED: 'PROVIDER_FAILED' })[code];
}
function failure(error: unknown): never {
  if (error instanceof JobFailure || error instanceof JobFenceLost || error instanceof HttpException) throw error;
  if (error instanceof ClaimProviderError) throw new JobFailure(providerCategory(error.code),
    error.outcome === 'UNKNOWN' ? 'UNKNOWN' : error.outcome);
  throw new JobFailure('INVALID_CONTRACT', 'KNOWN_FAILED');
}

type HandlerResult = { output: unknown; executionId: string; providerRunId: string; model: string | null };
type Provider = Pick<DifyClaimProvider, 'execute' | 'resume'>;

async function resolvedSettings(manifest: ClaimInputManifest, env: Record<string, string | undefined>): Promise<ClaimWorkflowSettings> {
  let settings: ClaimWorkflowSettings;
  try { settings = claimWorkflowSettings(env); } catch (error) { return failure(error); }
  if (canonicalManifestHash(manifest.release) !== canonicalManifestHash({ endpoint: settings.endpoint, workflowId: settings.workflowId,
    releaseId: settings.releaseId, configDigest: settings.configDigest, contractVersion: settings.contractVersion,
    promptTemplateVersion: settings.promptTemplateVersion })) {
    throw new JobFailure('CONFIG_CHANGED', 'NOT_SUBMITTED');
  }
  return settings;
}

async function frozenSources(db: PrismaClient | Prisma.TransactionClient, projectId: string, manifest: ClaimInputManifest): Promise<ClaimSourceInput[]> {
  if (new Set(manifest.snapshots.map(item => item.snapshotId)).size !== manifest.snapshots.length) throw new JobFailure('INVALID_INPUT', 'NOT_SUBMITTED');
  const snapshots = await db.sourceSnapshot.findMany({ where: { projectId, id: { in: manifest.snapshots.map(item => item.snapshotId) } },
    select: { id: true, materialId: true, normalizedText: true, sha256: true, fragments: { select: { id: true, startOffset: true, endOffset: true, sha256: true } } } });
  if (snapshots.length !== manifest.snapshots.length) throw new JobFailure('INVALID_SOURCE', 'NOT_SUBMITTED');
  const byId = new Map(snapshots.map(snapshot => [snapshot.id, snapshot]));
  const output: ClaimSourceInput[] = [];
  for (const frozen of manifest.snapshots) {
    const snapshot = byId.get(frozen.snapshotId);
    if (!snapshot || snapshot.materialId !== frozen.materialId || snapshot.sha256 !== frozen.sha256
      || sha256(snapshot.normalizedText) !== frozen.sha256 || new Set(frozen.fragments.map(fragment => fragment.id)).size !== frozen.fragments.length) {
      throw new JobFailure('INVALID_SOURCE', 'NOT_SUBMITTED');
    }
    const actual = new Map(snapshot.fragments.map(fragment => [fragment.id, fragment]));
    const fragments: ClaimSourceInput['fragments'] = [];
    for (const item of frozen.fragments) {
      const fragment = actual.get(item.id);
      if (!fragment || fragment.startOffset !== item.startOffset || fragment.endOffset !== item.endOffset || fragment.sha256 !== item.sha256
        || item.endOffset > snapshot.normalizedText.length || item.startOffset >= item.endOffset) throw new JobFailure('INVALID_SOURCE', 'NOT_SUBMITTED');
      const text = snapshot.normalizedText.slice(item.startOffset, item.endOffset);
      if (sha256(text) !== item.sha256) throw new JobFailure('INVALID_SOURCE', 'NOT_SUBMITTED');
      fragments.push({ id: item.id, startOffset: item.startOffset, endOffset: item.endOffset, sha256: item.sha256, text });
    }
    output.push({ snapshotId: frozen.snapshotId, materialId: frozen.materialId, sha256: frozen.sha256, fragments });
  }
  if (Buffer.byteLength(JSON.stringify(output)) > 1024 * 1024) throw new JobFailure('INVALID_INPUT', 'NOT_SUBMITTED');
  return output;
}

function manifestFor(job: JobContext['job']): ClaimInputManifest {
  if (job.operation !== 'CLAIM_EXTRACTION' || job.contractVersion !== CLAIMS_CONTRACT) throw new JobFailure('INVALID_CONTRACT', 'NOT_SUBMITTED');
  const parsed = claimInputManifestSchema.safeParse(job.inputManifest);
  if (!parsed.success || job.inputHash !== canonicalManifestHash({ contractVersion: job.contractVersion, inputManifest: job.inputManifest })) {
    throw new JobFailure('INPUT_INTEGRITY', 'NOT_SUBMITTED');
  }
  return parsed.data;
}

export function createClaimJobHandler(dependencies: { prisma: PrismaClient; factualBasis: FactualBasisService; provider?: Provider;
  env?: Record<string, string | undefined> }): JobHandler {
  const provider = dependencies.provider ?? new DifyClaimProvider();
  const env = dependencies.env ?? process.env;

  async function startExecution(context: JobContext, manifest: ClaimInputManifest, runId?: string): Promise<string> {
    const existing = await dependencies.prisma.aIExecution.findUnique({ where: { attemptId: context.attempt.id }, select: { id: true } });
    if (existing) {
      if (runId) await dependencies.prisma.aIExecution.updateMany({ where: { id: existing.id, status: 'RUNNING' }, data: { providerRunId: runId } });
      return existing.id;
    }
    const executionId = randomUUID();
    await dependencies.prisma.aIExecution.create({ data: { id: executionId, projectId: context.job.projectId, jobId: context.job.id,
      attemptId: context.attempt.id, workflowId: manifest.release.workflowId, releaseId: manifest.release.releaseId,
      configDigest: manifest.release.configDigest, contractVersion: manifest.release.contractVersion,
      promptTemplateVersion: manifest.release.promptTemplateVersion,
      inputManifest: prismaJson(context.job.inputManifest), inputHash: context.job.inputHash, providerRunId: runId ?? null } });
    return executionId;
  }

  async function callProvider(context: JobContext, manifest: ClaimInputManifest, runId?: string): Promise<HandlerResult> {
    try {
      const executionId = await startExecution(context, manifest, runId);
      const settings = await resolvedSettings(manifest, env);
      const sources = await frozenSources(dependencies.prisma, context.job.projectId, manifest);
      let capturedRunId = runId;
      const recordRun = async (id: string) => {
        if (capturedRunId && capturedRunId !== id) throw new ClaimProviderError('INCOMPATIBLE_CONTRACT', 'Claim workflow changed its run identity');
        if (!capturedRunId) {
          capturedRunId = id;
          await context.recordProviderRun(id);
          await dependencies.prisma.aIExecution.updateMany({ where: { id: executionId, attemptId: context.attempt.id, status: 'RUNNING' }, data: { providerRunId: id } });
        }
      };
      let result: Awaited<ReturnType<Provider['execute']>>;
      if (runId) result = await provider.resume(settings, runId, context.signal);
      else {
        try {
          result = await provider.execute(settings, context.job.id, sources, context.signal,
            () => context.recordSubmissionIntent(), recordRun);
        } catch (error) {
          // A started stream can break after the provider run ID is durable.
          // Poll that run under the same deadline; never issue a second POST.
          if (!capturedRunId || !(error instanceof ClaimProviderError)
            || !['UNKNOWN_OUTCOME', 'TRANSIENT_TRANSPORT', 'TIMEOUT'].includes(error.code)) throw error;
          result = await provider.resume(settings, capturedRunId, context.signal);
        }
      }
      if (capturedRunId && capturedRunId !== result.workflowRunId) throw new ClaimProviderError('INCOMPATIBLE_CONTRACT', 'Claim workflow returned a different run identity');
      if (!capturedRunId) await recordRun(result.workflowRunId);
      return { output: result.output, executionId, providerRunId: result.workflowRunId, model: result.model };
    } catch (error) { return failure(error); }
  }

  return {
    operation: 'CLAIM_EXTRACTION',
    async execute(context) { return callProvider(context, manifestFor(context.job)); },
    async resume(context, providerRunId) { return callProvider(context, manifestFor(context.job), providerRunId); },
    async commit(tx, raw, job) {
      try {
        const result = z.object({ output: claimsOutputSchema, executionId: z.uuid(), providerRunId: z.uuid(), model: z.string().max(200).nullable() }).strict().parse(raw) as HandlerResult;
        const manifest = manifestFor(job as JobContext['job']);
        // Repeat frozen-source integrity checks inside the same canonical commit transaction.
        await frozenSources(tx, job.projectId, manifest);
        const refs = await dependencies.factualBasis.commitExtracted(tx, job, result.output);
        const updated = await tx.aIExecution.updateMany({ where: { id: result.executionId, projectId: job.projectId, jobId: job.id, status: 'RUNNING' },
          data: { providerRunId: result.providerRunId, model: result.model, status: 'SUCCEEDED', finishedAt: new Date(), errorCategory: null } });
        if (updated.count !== 1) throw new JobFailure('INVALID_CONTRACT', 'KNOWN_FAILED');
        return prismaJson({ ...refs, executionId: result.executionId });
      } catch (error) { return failure(error); }
    },
    async failed(context, error) {
      void error;
      const job = await dependencies.prisma.job.findUnique({ where: { id: context.job.id }, select: { status: true, errorCategory: true, providerOutcome: true } });
      if (!job) return;
      const category = job.errorCategory ?? 'EXECUTION_FAILED';
      await dependencies.prisma.aIExecution.updateMany({ where: { attemptId: context.attempt.id, status: 'RUNNING' },
        data: { status: job.providerOutcome === 'UNKNOWN' || job.providerOutcome === 'MAY_STILL_RUN' ? 'OUTCOME_UNKNOWN' : 'FAILED',
          finishedAt: new Date(), errorCategory: category } });
    },
  };
}
