import { randomUUID } from 'node:crypto';
import { HttpException } from '@nestjs/common';
import { z } from 'zod';
import type { Prisma, PrismaClient } from '../generated/prisma/client.js';
import { canonicalManifestHash } from '../jobs/job-service.js';
import { JobFailure, JobFenceLost, type JobContext, type JobHandler } from '../jobs/contracts.js';
import { embeddingOutputSchema, embeddingRequestSchema } from './contracts.js';
import { DifyEmbeddingProvider, EmbeddingProviderError, embeddingWorkflowSettings,
  type EmbeddingWorkflowSettings } from './embedding-provider.js';
import { EvidenceServiceError, SourceEvidenceService } from './evidence.service.js';
import { DifySourceRelevanceProvider, SourceRelevanceProviderError, sourceRelevanceWorkflowSettings } from './relevance-provider.js';
import { relevanceOutputSchema } from './relevance-contracts.js';
import { evidenceSearchV2ManifestSchema, evidenceRelevanceManifestSchema,
  type EvidenceSearchV2Manifest, type EvidenceRelevanceManifest } from './relevance-job-contracts.js';

const frozenReleaseSchema = z.object({ endpoint: z.string().url(), workflowId: z.uuid(), releaseId: z.literal('source-embedding-2026-10-20.1'),
  configDigest: z.string().regex(/^[a-f0-9]{64}$/u) }).strict();
const frozenSnapshotSchema = z.object({ snapshotId: z.uuid(), materialId: z.uuid(), snapshotSha256: z.string().regex(/^[a-f0-9]{64}$/u),
  sequence: z.number().int().positive(), label: z.string().min(1).max(200) }).strict();
const retrievalPolicySchema = z.object({ version: z.enum(['hybrid-source-v1', 'hybrid-source-v2', 'hybrid-source-v3']), rankConstant: z.literal(60), byteBudget: z.literal(30_000),
  maxPassages: z.literal(20), adjacentContextChunks: z.literal(1) }).strict();
const indexManifestSchema = z.object({ schemaVersion: z.literal('source-embedding-job-v1'), commandKey: z.uuid(), requestSnapshotIds: z.array(z.uuid()).min(1).max(100),
  indexId: z.uuid(), snapshot: frozenSnapshotSchema, request: embeddingRequestSchema, release: frozenReleaseSchema,
  noticeVersion: z.string().min(1).max(64), acceptedAt: z.iso.datetime() }).strict();
const searchManifestSchema = z.object({ schemaVersion: z.literal('evidence-search-job-v1'), commandKey: z.uuid(), query: z.string().min(1).max(1000),
  snapshots: z.array(frozenSnapshotSchema).min(1).max(100), indexes: z.array(z.object({ indexId: z.uuid(), snapshotId: z.uuid(),
    snapshotSha256: z.string().regex(/^[a-f0-9]{64}$/u), configDigest: z.string().regex(/^[a-f0-9]{64}$/u) }).strict()).min(1).max(100),
  retrievalPolicy: retrievalPolicySchema, request: embeddingRequestSchema, release: frozenReleaseSchema,
  noticeVersion: z.string().min(1).max(64), acceptedAt: z.iso.datetime() }).strict();

type FrozenRelease = z.infer<typeof frozenReleaseSchema>;
type IndexManifest = z.infer<typeof indexManifestSchema>;
type SearchManifest = z.infer<typeof searchManifestSchema>;
type OperationManifest = IndexManifest | SearchManifest | EvidenceSearchV2Manifest;
type ExecutionResult = { output: unknown; executionId: string; providerRunId: string; model: string | null };
type Provider = Pick<DifyEmbeddingProvider, 'execute' | 'resume'>;

function json(value: unknown): Prisma.InputJsonValue { return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue; }

function parseManifest(context: JobContext): OperationManifest {
  const schema = context.job.operation === 'SOURCE_EMBEDDING' && context.job.contractVersion === 'source-embedding-v1'
    ? indexManifestSchema : context.job.operation === 'EVIDENCE_SEARCH' && context.job.contractVersion === 'evidence-search-v1'
      ? searchManifestSchema : context.job.operation === 'EVIDENCE_SEARCH' && context.job.contractVersion === 'evidence-search-v2'
        ? evidenceSearchV2ManifestSchema : null;
  if (!schema) throw new JobFailure('INVALID_CONTRACT', 'NOT_SUBMITTED');
  const parsed = schema.safeParse(context.job.inputManifest);
  if (!parsed.success || context.job.inputHash !== canonicalManifestHash({ contractVersion: context.job.contractVersion,
    inputManifest: context.job.inputManifest })) throw new JobFailure('INPUT_INTEGRITY', 'NOT_SUBMITTED');
  return parsed.data as OperationManifest;
}

function isIndexManifest(manifest: OperationManifest): manifest is IndexManifest {
  return manifest.schemaVersion === 'source-embedding-job-v1';
}

function convertFailure(error: unknown, beforeProvider = false): never {
  if (error instanceof JobFailure || error instanceof JobFenceLost || error instanceof HttpException) throw error;
  if (error instanceof EvidenceServiceError) throw new JobFailure(error.category, error.outcome);
  if (error instanceof EmbeddingProviderError || error instanceof SourceRelevanceProviderError) {
    const categories: Record<EmbeddingProviderError['code'], string> = { CONFIG: 'CONFIG_CHANGED', AUTH: 'PROVIDER_AUTH', INVALID_INPUT: 'INVALID_INPUT',
      INCOMPATIBLE_CONTRACT: 'INVALID_CONTRACT', QUOTA: 'QUOTA', RATE_LIMIT: 'RATE_LIMIT', TRANSIENT_TRANSPORT: 'TRANSIENT_TRANSPORT',
      TIMEOUT: 'TIMEOUT', UNKNOWN_OUTCOME: 'UNKNOWN_OUTCOME', PROVIDER_FAILED: 'PROVIDER_FAILED' };
    throw new JobFailure(categories[error.code], error.outcome);
  }
  // Log only fixed metadata. Driver and validator messages can contain inputs.
  const detail = error instanceof Error ? error as Error & { code?: unknown; meta?: { code?: unknown } } : null;
  const driverCode = typeof detail?.code === 'string' && /^(?:P\d{4}|[0-9A-Z]{5})$/u.test(detail.code) ? detail.code : undefined;
  const sqlCode = typeof detail?.meta?.code === 'string' && /^[0-9A-Z]{5}$/u.test(detail.meta.code) ? detail.meta.code : undefined;
  const queryTimedOut = !!detail?.message.includes('Query read timeout')
    || !!detail?.message.includes('timeout exceeded when trying to connect') || sqlCode === '57014';
  const type = queryTimedOut ? 'QUERY_READ_TIMEOUT' : detail instanceof z.ZodError ? 'SCHEMA_VALIDATION' : 'UNEXPECTED';
  console.warn('Source evidence job step failed', { type, driverCode, sqlCode });
  if (beforeProvider && (queryTimedOut || driverCode && ['P1001', 'P1002', 'P1008', 'P1017', 'P2024', 'P2034'].includes(driverCode))) {
    throw new JobFailure('ENGINE_UNAVAILABLE', 'NOT_SUBMITTED');
  }
  if (detail instanceof z.ZodError) throw new JobFailure('INVALID_CONTRACT', 'KNOWN_FAILED');
  throw error;
}

function releaseMatches(settings: EmbeddingWorkflowSettings, release: FrozenRelease): boolean {
  return canonicalManifestHash({ endpoint: settings.endpoint, workflowId: settings.workflowId, releaseId: settings.releaseId,
    configDigest: settings.configDigest }) === canonicalManifestHash(release);
}

export function createSourceEvidenceJobHandlers(dependencies: { prisma: PrismaClient; evidence: SourceEvidenceService;
  provider?: Provider; relevanceProvider?: Pick<DifySourceRelevanceProvider, 'execute' | 'resume'>;
  env?: Record<string, string | undefined> }): JobHandler[] {
  const provider = dependencies.provider ?? new DifyEmbeddingProvider();
  const relevanceProvider = dependencies.relevanceProvider ?? new DifySourceRelevanceProvider();
  const env = dependencies.env ?? process.env;

  async function run(context: JobContext, providerRunId?: string): Promise<ExecutionResult> {
    let beforeProvider = !providerRunId;
    try {
      const manifest = parseManifest(context);
      const settings = embeddingWorkflowSettings(env);
      if (!releaseMatches(settings, manifest.release)) throw new EvidenceServiceError('CONFIG_CHANGED', 'NOT_SUBMITTED');
      // First submissions are fenced and fully revalidated atomically by
      // recordSubmissionIntent immediately before the provider POST. Resumed
      // runs use a provider GET instead, so retain the source fence here.
      if (providerRunId) await dependencies.evidence.validateEmbeddingSubmission(context.job.projectId, manifest);
      const current = await dependencies.prisma.aIExecution.findUnique({ where: { attemptId: context.attempt.id }, select: { id: true } });
      const executionId = current?.id ?? randomUUID();
      if (!current) await dependencies.prisma.aIExecution.create({ data: { id: executionId, projectId: context.job.projectId,
        jobId: context.job.id, attemptId: context.attempt.id, workflowId: settings.workflowId, releaseId: settings.releaseId,
        configDigest: settings.configDigest, contractVersion: context.job.contractVersion,
        promptTemplateVersion: 'source-embedding-v1', inputManifest: json(context.job.inputManifest), inputHash: context.job.inputHash,
        providerRunId: providerRunId ?? null } });
      let capturedId = providerRunId;
      const recordRun = async (id: string) => {
        if (capturedId && capturedId !== id) throw new EmbeddingProviderError('INCOMPATIBLE_CONTRACT', 'Embedding workflow changed its run identity');
        if (!capturedId) { capturedId = id; await context.recordProviderRun(id); }
        await dependencies.prisma.aIExecution.updateMany({ where: { id: executionId, projectId: context.job.projectId,
          attemptId: context.attempt.id, status: 'RUNNING' }, data: { providerRunId: id } });
      };
      let response: Awaited<ReturnType<Provider['execute']>>;
      if (providerRunId) response = await provider.resume(settings, providerRunId, manifest.request, context.signal);
      else {
        try {
          response = await provider.execute(settings, context.job.id, manifest.request, context.signal,
            async () => { await context.recordSubmissionIntent(); beforeProvider = false; }, recordRun);
        } catch (error) {
          if (!capturedId || !(error instanceof EmbeddingProviderError)
            || !['UNKNOWN_OUTCOME', 'TRANSIENT_TRANSPORT', 'TIMEOUT'].includes(error.code)) throw error;
          response = await provider.resume(settings, capturedId, manifest.request, context.signal);
        }
      }
      if (capturedId && capturedId !== response.workflowRunId) throw new EmbeddingProviderError('INCOMPATIBLE_CONTRACT', 'Embedding workflow returned another run');
      if (!capturedId) await recordRun(response.workflowRunId);
      return { output: response.output, executionId, providerRunId: response.workflowRunId, model: response.model };
    } catch (error) { return convertFailure(error, beforeProvider); }
  }

  function relevanceManifest(context: Pick<JobContext, 'job'>): EvidenceRelevanceManifest {
    const parsed = evidenceRelevanceManifestSchema.safeParse(context.job.inputManifest);
    if (context.job.operation !== 'EVIDENCE_SEARCH' || context.job.contractVersion !== 'evidence-relevance-v1'
      || !parsed.success || context.job.inputHash !== canonicalManifestHash({ contractVersion: context.job.contractVersion,
        inputManifest: context.job.inputManifest })) throw new JobFailure('INPUT_INTEGRITY', 'NOT_SUBMITTED');
    return parsed.data;
  }

  async function runRelevance(context: JobContext, providerRunId?: string) {
    let beforeProvider = !providerRunId;
    try {
      const manifest = relevanceManifest(context);
      const settings = sourceRelevanceWorkflowSettings(env);
      const release = { endpoint: settings.endpoint, workflowId: settings.workflowId,
        releaseId: settings.releaseId, configDigest: settings.configDigest };
      if (canonicalManifestHash(release) !== canonicalManifestHash(manifest.release)) throw new EvidenceServiceError('CONFIG_CHANGED', 'NOT_SUBMITTED');
      // The initial POST invokes validateSubmission inside the fenced
      // providerIntent transaction. A resumed GET has no beforeSubmit hook,
      // therefore it must repeat the full source/parent/child validation.
      if (providerRunId) await dependencies.evidence.validateRelevanceSubmission(context.job.projectId, manifest);
      const [, current] = await Promise.all([
        context.setProgress('CHECKING_RELEVANCE'),
        dependencies.prisma.aIExecution.findUnique({ where: { attemptId: context.attempt.id }, select: { id: true } }),
      ]);
      const executionId = current?.id ?? randomUUID();
      if (!current) await dependencies.prisma.aIExecution.create({ data: { id: executionId, projectId: context.job.projectId,
        jobId: context.job.id, attemptId: context.attempt.id, workflowId: settings.workflowId, releaseId: settings.releaseId,
        configDigest: settings.configDigest, contractVersion: context.job.contractVersion,
        promptTemplateVersion: settings.releaseId === 'source-relevance-2026-10-24.1'
          ? 'source-relevance-prompt-v2' : 'source-relevance-prompt-v1',
        inputManifest: json(context.job.inputManifest), inputHash: context.job.inputHash,
        providerRunId: providerRunId ?? null } });
      let capturedId = providerRunId;
      const recordRun = async (id: string) => {
        if (capturedId && capturedId !== id) throw new SourceRelevanceProviderError('INCOMPATIBLE_CONTRACT', 'Relevance workflow changed its run identity');
        if (!capturedId) { capturedId = id; await context.recordProviderRun(id); }
        await dependencies.prisma.aIExecution.updateMany({ where: { id: executionId, projectId: context.job.projectId,
          attemptId: context.attempt.id, status: 'RUNNING' }, data: { providerRunId: id } });
      };
      let response: Awaited<ReturnType<typeof relevanceProvider.execute>>;
      if (providerRunId) response = await relevanceProvider.resume(settings, providerRunId, manifest.request, context.signal);
      else {
        try { response = await relevanceProvider.execute(settings, context.job.id, manifest.request, context.signal,
          async () => { await context.recordSubmissionIntent(); beforeProvider = false; }, recordRun); }
        catch (error) {
          if (!capturedId || !(error instanceof SourceRelevanceProviderError)
            || !['UNKNOWN_OUTCOME', 'TRANSIENT_TRANSPORT', 'TIMEOUT'].includes(error.code)) throw error;
          response = await relevanceProvider.resume(settings, capturedId, manifest.request, context.signal);
        }
      }
      if (capturedId && capturedId !== response.workflowRunId) throw new SourceRelevanceProviderError('INCOMPATIBLE_CONTRACT', 'Relevance workflow returned another run');
      if (!capturedId) await recordRun(response.workflowRunId);
      return { output: response.output, executionId, providerRunId: response.workflowRunId, model: response.model };
    } catch (error) { return convertFailure(error, beforeProvider); }
  }

  const operations: JobHandler[] = [];
  for (const operation of ['SOURCE_EMBEDDING', 'EVIDENCE_SEARCH'] as const) {
    operations.push({ operation,
      async validateSubmission(tx, job) {
        try {
          if (job.contractVersion === 'evidence-relevance-v1') await dependencies.evidence.validateRelevanceSubmission(job.projectId, relevanceManifest({ job }), tx);
          else await dependencies.evidence.validateEmbeddingSubmission(job.projectId, parseManifest({ job } as JobContext), tx);
        }
        catch (error) { convertFailure(error); }
        await tx.$queryRaw`SELECT "id" FROM contextflow."Project" WHERE "id"=${job.projectId}::uuid FOR SHARE`;
      },
      async execute(context) {
        return context.job.contractVersion === 'evidence-relevance-v1' ? runRelevance(context) : run(context);
      },
      async resume(context, runId) { return context.job.contractVersion === 'evidence-relevance-v1' ? runRelevance(context, runId) : run(context, runId); },
      async commit(tx, raw, job) {
        try {
          const result = z.object({ output: z.unknown(), executionId: z.uuid(), providerRunId: z.uuid(), model: z.string().max(200).nullable() }).strict().parse(raw);
          let refs: Record<string, unknown>;
          if (job.contractVersion === 'evidence-relevance-v1') {
            if (operation !== 'EVIDENCE_SEARCH') throw new EvidenceServiceError('INVALID_CONTRACT', 'KNOWN_FAILED');
            refs = await dependencies.evidence.commitRelevance(tx, job.projectId, job.id, job.requestedBy,
              relevanceManifest({ job }), relevanceOutputSchema.parse(result.output));
          } else {
            const manifest = parseManifest({ job } as JobContext);
            const output = embeddingOutputSchema.parse(result.output);
            if (isIndexManifest(manifest)) {
              if (operation !== 'SOURCE_EMBEDDING' || manifest.request.task !== 'DOCUMENT') throw new EvidenceServiceError('INVALID_CONTRACT', 'KNOWN_FAILED');
              await dependencies.evidence.commitEmbedding(tx, job.projectId, job.id, manifest, output);
              refs = { indexId: manifest.indexId };
            } else {
              if (operation !== 'EVIDENCE_SEARCH' || manifest.request.task !== 'QUERY') throw new EvidenceServiceError('INVALID_CONTRACT', 'KNOWN_FAILED');
              refs = await dependencies.evidence.commitSearch(tx, job.projectId, job.id, job.requestedBy, manifest, output);
            }
          }
          const updated = await tx.aIExecution.updateMany({ where: { id: result.executionId, projectId: job.projectId,
            jobId: job.id, status: 'RUNNING' }, data: { providerRunId: result.providerRunId, model: result.model,
            status: 'SUCCEEDED', finishedAt: new Date(), errorCategory: null } });
          if (updated.count !== 1) throw new EvidenceServiceError('INVALID_CONTRACT', 'KNOWN_SUCCEEDED');
          return json({ ...refs, executionId: result.executionId });
        } catch (error) { return convertFailure(error); }
      },
      async failed(context) {
        const job = await dependencies.prisma.job.findUnique({ where: { id: context.job.id }, select: { errorCategory: true, providerOutcome: true } });
        if (!job) return;
        await dependencies.prisma.aIExecution.updateMany({ where: { attemptId: context.attempt.id, status: 'RUNNING' }, data: {
          status: ['UNKNOWN','MAY_STILL_RUN'].includes(job.providerOutcome) ? 'OUTCOME_UNKNOWN' : 'FAILED',
          finishedAt: new Date(), errorCategory: job.errorCategory ?? 'EXECUTION_FAILED' } });
      },
    });
  }
  return operations;
}
