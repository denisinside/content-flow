import { randomUUID } from 'node:crypto';
import { HttpException } from '@nestjs/common';
import { z } from 'zod';
import type { Prisma, PrismaClient } from '../generated/prisma/client.js';
import { JobFailure, JobFenceLost, type JobContext, type JobHandler } from '../jobs/contracts.js';
import { canonicalManifestHash } from '../jobs/job-service.js';
import type { FactualBasisService } from '../claims/factual-basis.service.js';
import { canonicalBriefHash, type EditorialService } from './editorial.service.js';
import { outlineInputManifestSchema, outlineOutputSchema, type OutlineInputManifest } from './contracts.js';
import { DifyOutlineProvider, OutlineProviderError, outlineWorkflowSettings, sha256,
  type OutlineProviderInput, type OutlineWorkflowSettings } from './provider.js';

type Provider = Pick<DifyOutlineProvider, 'execute' | 'resume'>;
type Result = { output: unknown; executionId: string; providerRunId: string; model: string | null };
function json(value: unknown): Prisma.InputJsonValue { return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue; }
function fail(error: unknown): never {
  if (error instanceof JobFailure || error instanceof JobFenceLost || error instanceof HttpException) throw error;
  if (error instanceof OutlineProviderError) throw new JobFailure(({ CONFIG: 'CONFIG_CHANGED', AUTH: 'PROVIDER_AUTH',
    INVALID_INPUT: 'INVALID_INPUT', INCOMPATIBLE_CONTRACT: 'INVALID_CONTRACT', QUOTA: 'QUOTA', RATE_LIMIT: 'RATE_LIMIT',
    TRANSIENT_TRANSPORT: 'TRANSIENT_TRANSPORT', TIMEOUT: 'TIMEOUT', UNKNOWN_OUTCOME: 'UNKNOWN_OUTCOME',
    PROVIDER_FAILED: 'PROVIDER_FAILED' })[error.code], error.outcome);
  throw new JobFailure('INVALID_CONTRACT', 'KNOWN_FAILED');
}
function manifestFor(job: JobContext['job']) {
  const parsed = outlineInputManifestSchema.safeParse(job.inputManifest);
  if (job.operation !== 'OUTLINE_GENERATION' || job.contractVersion !== 'outline-v1' || !parsed.success
    || job.inputHash !== canonicalManifestHash({ contractVersion: job.contractVersion, inputManifest: job.inputManifest })) {
    throw new JobFailure('INPUT_INTEGRITY', 'NOT_SUBMITTED');
  }
  return parsed.data;
}

async function frozenContext(tx: Prisma.TransactionClient, projectId: string, manifest: OutlineInputManifest,
  facts: FactualBasisService): Promise<OutlineProviderInput> {
  // All factual-review writes take the exclusive Project lock. Keep a shared
  // lock across this complete eligibility/provenance read, including preflight.
  await tx.$queryRaw`SELECT "id" FROM contextflow."Project" WHERE "id" = ${projectId}::uuid FOR SHARE`;
  const brief = await tx.briefRevision.findFirst({ where: { id: manifest.briefRevisionId, projectId },
    include: { style: true, requiredClaims: true, contextSnapshots: { include: { snapshot: true } } } });
  if (!brief || brief.sha256 !== manifest.briefHash || canonicalBriefHash(brief) !== brief.sha256
    || brief.contentMode !== manifest.contentMode || brief.workspaceId !== manifest.workspaceId
    || brief.workspaceStyleRevision !== manifest.workspaceStyleRevision
    || canonicalManifestHash(brief.contextSnapshots.map(row => row.snapshotId).sort()) !== canonicalManifestHash([...manifest.contextSnapshotIds].sort())) {
    throw new JobFailure('INPUT_INTEGRITY', 'NOT_SUBMITTED');
  }
  const claims: OutlineProviderInput['claims'] = [];
  if (manifest.basisRevisionId) {
    const basis = await facts.inspectBasisRevision(tx, projectId, manifest.basisRevisionId);
    if (!basis.valid || basis.sha256 !== manifest.basisHash) throw new JobFailure('FACTUAL_BASIS_BLOCKED', 'NOT_SUBMITTED');
    const rows = await tx.basisClaim.findMany({ where: { projectId, basisId: basis.id },
      include: { claimRevision: true, evidence: { include: { evidence: true } } }, orderBy: { claimRevisionId: 'asc' } });
    for (const row of rows) claims.push({ claimRevisionId: row.claimRevisionId, wording: row.claimRevision.wording,
      evidence: row.evidence.map(edge => ({ evidenceId: edge.evidenceId, quote: edge.evidence.quote, snapshotId: edge.evidence.snapshotId })) });
    if (brief.requiredClaims.some(row => !claims.some(claim => claim.claimRevisionId === row.claimRevisionId))) throw new JobFailure('INVALID_INPUT', 'NOT_SUBMITTED');
  }
  const context = brief.contextSnapshots.map(row => {
    if (sha256(row.snapshot.normalizedText) !== row.snapshot.sha256) throw new JobFailure('INPUT_INTEGRITY', 'NOT_SUBMITTED');
    return { snapshotId: row.snapshotId, purpose: row.capturedPurpose, sha256: row.snapshot.sha256, text: row.snapshot.normalizedText };
  }).sort((a, b) => a.snapshotId.localeCompare(b.snapshotId));
  const input: OutlineProviderInput = { schemaVersion: 'outline-context-v1', contentMode: brief.contentMode,
    brief: { topic: brief.topic, audience: brief.audience, centralMessage: brief.centralMessage, category: brief.category,
      tone: brief.tone, targetLength: brief.targetLength, cta: brief.cta, exclusions: brief.exclusions, notes: brief.notes,
      requiredClaimRevisionIds: brief.requiredClaims.map(row => row.claimRevisionId).sort() },
    style: { brandbook: brief.style.brandbook, tone: brief.style.tone, settings: brief.style.settings }, claims, context };
  if (Buffer.byteLength(JSON.stringify(input)) > 350000) throw new JobFailure('INVALID_INPUT', 'NOT_SUBMITTED');
  return input;
}

export function createOutlineJobHandler(deps: { prisma: PrismaClient; editorial: EditorialService; factualBasis: FactualBasisService;
  provider?: Provider; env?: Record<string, string | undefined> }): JobHandler {
  const provider = deps.provider ?? new DifyOutlineProvider(), env = deps.env ?? process.env;
  async function call(context: JobContext, runId?: string): Promise<Result> {
    try {
      const manifest = manifestFor(context.job);
      const settings: OutlineWorkflowSettings = outlineWorkflowSettings(env);
      const { apiKey: _key, ...release } = settings;
      void _key;
      if (canonicalManifestHash(release) !== canonicalManifestHash(manifest.release)) throw new JobFailure('CONFIG_CHANGED', 'NOT_SUBMITTED');
      const input = await deps.prisma.$transaction(tx => frozenContext(tx, context.job.projectId, manifest, deps.factualBasis));
      const execution = await deps.prisma.aIExecution.upsert({ where: { attemptId: context.attempt.id }, update: {},
        create: { id: randomUUID(), projectId: context.job.projectId, jobId: context.job.id, attemptId: context.attempt.id,
          workflowId: release.workflowId, releaseId: release.releaseId, configDigest: release.configDigest,
          contractVersion: release.contractVersion, promptTemplateVersion: release.promptTemplateVersion,
          inputManifest: json(context.job.inputManifest), inputHash: context.job.inputHash, providerRunId: runId ?? null } });
      let captured = runId;
      const record = async (id: string) => {
        if (captured && captured !== id) throw new OutlineProviderError('INCOMPATIBLE_CONTRACT', 'Outline workflow changed run identity');
        if (!captured) { captured = id; await context.recordProviderRun(id); }
        await deps.prisma.aIExecution.updateMany({ where: { id: execution.id, status: 'RUNNING' }, data: { providerRunId: id } });
      };
      let result: Awaited<ReturnType<Provider['execute']>>;
      if (runId) result = await provider.resume(settings, runId, context.signal);
      else {
        try { result = await provider.execute(settings, context.job.id, input, context.signal, () => context.recordSubmissionIntent(), record); }
        catch (error) {
          if (!captured || !(error instanceof OutlineProviderError) || !['UNKNOWN_OUTCOME', 'TRANSIENT_TRANSPORT', 'TIMEOUT'].includes(error.code)) throw error;
          result = await provider.resume(settings, captured, context.signal);
        }
      }
      if (captured && captured !== result.workflowRunId) throw new OutlineProviderError('INCOMPATIBLE_CONTRACT', 'Outline workflow changed run identity');
      await record(result.workflowRunId);
      return { output: result.output, executionId: execution.id, providerRunId: result.workflowRunId, model: result.model };
    } catch (error) { return fail(error); }
  }
  return { operation: 'OUTLINE_GENERATION',
    async validateSubmission(tx, job) { await frozenContext(tx, job.projectId, manifestFor(job), deps.factualBasis); },
    execute: context => call(context), resume: (context, id) => call(context, id),
    async commit(tx, raw, job) {
      try {
        const result = z.object({ output: outlineOutputSchema, executionId: z.uuid(), providerRunId: z.uuid(),
          model: z.string().max(200).nullable() }).strict().parse(raw);
        await frozenContext(tx, job.projectId, manifestFor(job), deps.factualBasis);
        const refs = await deps.editorial.commitGenerated(tx, job, result.output.content, result.executionId);
        const updated = await tx.aIExecution.updateMany({ where: { id: result.executionId, jobId: job.id, projectId: job.projectId, status: 'RUNNING' },
          data: { status: 'SUCCEEDED', providerRunId: result.providerRunId, model: result.model, finishedAt: new Date(), errorCategory: null } });
        if (updated.count !== 1) throw new JobFailure('INVALID_CONTRACT', 'KNOWN_SUCCEEDED');
        return json({ ...refs, executionId: result.executionId });
      } catch (error) { return fail(error); }
    },
    async failed(context) {
      const job = await deps.prisma.job.findUnique({ where: { id: context.job.id }, select: { providerOutcome: true, errorCategory: true } });
      if (!job) return;
      await deps.prisma.aIExecution.updateMany({ where: { attemptId: context.attempt.id, status: 'RUNNING' }, data: {
        status: ['UNKNOWN', 'MAY_STILL_RUN'].includes(job.providerOutcome) ? 'OUTCOME_UNKNOWN' : 'FAILED',
        errorCategory: job.errorCategory ?? 'EXECUTION_FAILED', finishedAt: new Date() } });
    } };
}
