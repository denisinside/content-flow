import { randomUUID } from 'node:crypto';
import { HttpException } from '@nestjs/common';
import { z } from 'zod';
import type { Prisma, PrismaClient } from '../generated/prisma/client.js';
import type { FactualBasisService } from '../claims/factual-basis.service.js';
import { canonicalBriefHash, type EditorialService } from '../editorial/editorial.service.js';
import { JobFailure, JobFenceLost, type JobContext, type JobHandler } from '../jobs/contracts.js';
import { canonicalManifestHash } from '../jobs/job-service.js';
import { sha256Text } from './contracts.js';
import { SourceGroundingService } from './source-grounding.service.js';
import { outlineContentSchema } from '../editorial/contracts.js';
import { sourceOutlineSections } from './writing-article-content.js';
import { adaptationFormatSchema } from '../editorial/telegram-contracts.js';
import type { TelegramService } from '../editorial/telegram.service.js';
import { assembleSourceAdaptation, assembleSourceScript } from './writing-adaptation-content.js';
import type { ScriptService } from '../editorial/script.service.js';
import { sourceArticleContext } from './source-article-context.js';
import type { ArticleService } from '../editorial/article.service.js';
import { sourceWritingInputSchema, sourceWritingOutputSchema, validateSourceWritingOutput } from './writing-contracts.js';
import { guideSourceWritingBrief } from './writing-format-guidance.js';
import { DifySourceWritingProvider, SourceWritingProviderError, sourceWritingReleaseId, sourceWritingWorkflowSettings } from './writing-provider.js';

const hash = z.string().regex(/^[a-f0-9]{64}$/u);
const commonManifest = { schemaVersion: z.literal('source-writing-job-v1'), requestId: z.uuid(),
  briefRevisionId: z.uuid(), briefHash: hash, workspaceId: z.uuid(),
  workspaceStyleRevision: z.number().int().positive(), expectedRevision: z.number().int().nonnegative(),
  sourceEvidenceSetId: z.uuid(), setHash: hash, request: sourceWritingInputSchema,
  release: z.object({ endpoint: z.url(), workflowId: z.uuid(), releaseId: sourceWritingReleaseId, configDigest: hash }).strict(),
  noticeVersion: z.string().min(1).max(64), acceptedAt: z.iso.datetime() };
export const sourceWritingJobManifestSchema = z.discriminatedUnion('task', [
  z.object({ ...commonManifest, task: z.literal('OUTLINE') }).strict(),
  z.object({ ...commonManifest, task: z.literal('SECTION'), outlineRevisionId: z.uuid(), outlineHash: hash,
    sectionIndex: z.number().int().min(0).max(29), packetId: z.uuid() }).strict(),
  z.object({ ...commonManifest,task: z.literal('ADAPTATION'),format: adaptationFormatSchema,
    inputMode: z.enum(['DIRECT','ARTICLE_DERIVED']).default('DIRECT'),includeLink: z.boolean().default(false) }).strict(),
]);
type Manifest = z.infer<typeof sourceWritingJobManifestSchema>;
type Provider = Pick<DifySourceWritingProvider, 'execute' | 'resume'>;
function json(value: unknown): Prisma.InputJsonValue { return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue; }
function failure(error: unknown, beforeProvider = false): never {
  if (error instanceof JobFailure || error instanceof JobFenceLost || error instanceof HttpException) throw error;
  if (error instanceof SourceWritingProviderError) throw new JobFailure(({ CONFIG: 'CONFIG_CHANGED', AUTH: 'PROVIDER_AUTH',
    INVALID_INPUT: 'INVALID_INPUT', INCOMPATIBLE_CONTRACT: 'INVALID_CONTRACT', QUOTA: 'QUOTA', RATE_LIMIT: 'RATE_LIMIT',
    TRANSIENT_TRANSPORT: 'TRANSIENT_TRANSPORT', TIMEOUT: 'TIMEOUT', UNKNOWN_OUTCOME: 'UNKNOWN_OUTCOME',
    PROVIDER_FAILED: 'PROVIDER_FAILED' })[error.code], error.outcome);
  const detail = error instanceof Error ? error as Error & { code?: string; meta?: { code?: string } } : null;
  if (beforeProvider && (detail?.message.includes('Query read timeout') || detail?.message.includes('timeout exceeded when trying to connect')
    || detail?.meta?.code === '57014'
    || ['P1001', 'P1002', 'P1008', 'P1017', 'P2024', 'P2034'].includes(detail?.code ?? ''))) {
    throw new JobFailure('ENGINE_UNAVAILABLE', 'NOT_SUBMITTED');
  }
  if (error instanceof z.ZodError) throw new JobFailure('INVALID_CONTRACT', 'KNOWN_FAILED');
  throw error;
}
function manifestFor(job: JobContext['job']): Manifest {
  const parsed = sourceWritingJobManifestSchema.safeParse(job.inputManifest);
  if (job.operation !== 'SOURCE_WRITING' || job.contractVersion !== 'source-writing-v1' || !parsed.success
    || job.inputHash !== canonicalManifestHash({ contractVersion: job.contractVersion, inputManifest: job.inputManifest })
    || parsed.data.request.task !== parsed.data.task || parsed.data.request.requestId !== parsed.data.requestId) {
    throw new JobFailure('INPUT_INTEGRITY', 'NOT_SUBMITTED');
  }
  return parsed.data;
}

/** Reconstruct the exact selected context before submission and again before commit. */
async function validateFrozen(tx: Prisma.TransactionClient, job: JobContext['job'], manifest: Manifest, facts: FactualBasisService, articles?: ArticleService) {
  const access = await tx.$queryRaw<Array<{ id: string }>>`SELECT p."id" FROM contextflow."Project" p
    JOIN contextflow."Workspace" w ON w."id"=p."workspaceId" JOIN contextflow."WorkspaceMember" m ON m."workspaceId"=w."id"
    WHERE p."id"=${job.projectId}::uuid AND p."archivedAt" IS NULL AND p."trashedAt" IS NULL
      AND w."archivedAt" IS NULL AND w."trashedAt" IS NULL AND m."userId"=${job.requestedBy}::uuid AND m."leftAt" IS NULL
    FOR SHARE OF p,w,m`;
  if (!access.length) throw new JobFailure('ACCESS_REVOKED', 'NOT_SUBMITTED');
  const project = await tx.project.findUniqueOrThrow({ where: { id: job.projectId }, include: { workspace: true } });
  const brief = await tx.brief.findUnique({ where: { projectId: job.projectId }, include: { currentRevision: {
    include: { style: true, requiredClaims: true, contextSnapshots: { include: { snapshot: true } } } } } });
  const frozen = brief?.currentRevision;
  if (!frozen || frozen.id !== manifest.briefRevisionId || frozen.contentMode !== 'FACTUAL'
    || frozen.sha256 !== manifest.briefHash || canonicalBriefHash(frozen) !== frozen.sha256
    || frozen.workspaceId !== manifest.workspaceId || frozen.workspaceStyleRevision !== manifest.workspaceStyleRevision
    || project.workspace.styleRevision !== manifest.workspaceStyleRevision || !project.formats.includes(manifest.task === 'ADAPTATION' ? manifest.format : 'ARTICLE')) {
    throw new JobFailure('STALE_INPUT', 'NOT_SUBMITTED');
  }
  if (frozen.requiredClaims.length) throw new JobFailure('INVALID_CONTRACT', 'NOT_SUBMITTED');
  const outline = await tx.outline.findUnique({ where: { projectId: job.projectId }, include: { currentRevision: true } });
  let sectionContext: { section: NonNullable<z.infer<typeof sourceWritingInputSchema>['section']>;
    approvedOutline: NonNullable<z.infer<typeof sourceWritingInputSchema>['approvedOutline']> } | undefined;
  let requiredIds: Set<string> | undefined;
  if (manifest.task === 'OUTLINE') {
    if ((outline?.revision ?? 0) !== manifest.expectedRevision) throw new JobFailure('STALE_INPUT', 'NOT_SUBMITTED');
  } else if (manifest.task === 'SECTION') {
    const approved = outline?.currentRevision;
    const article = await tx.article.findUnique({ where: { projectId: job.projectId }, select: { revision: true } });
    if (!approved || approved.id !== manifest.outlineRevisionId || outline.currentApprovedRevisionId !== approved.id
      || !approved.approvedAt || approved.withdrawnAt || !approved.sourceEvidenceSealed || !approved.sourceEvidenceSetId
      || approved.briefRevisionId !== frozen.id || approved.sha256 !== manifest.outlineHash
      || canonicalManifestHash(approved.content) !== manifest.outlineHash || (article?.revision ?? 0) !== manifest.expectedRevision) {
      throw new JobFailure('STALE_INPUT', 'NOT_SUBMITTED');
    }
    const normalized = sourceOutlineSections(approved.id,approved.content,frozen.targetLength), section = normalized.sections[manifest.sectionIndex];
    if (!section) throw new JobFailure('INPUT_INTEGRITY', 'NOT_SUBMITTED');
    sectionContext = { section, approvedOutline: normalized };
    requiredIds = new Set(outlineContentSchema.parse(approved.content).sections[manifest.sectionIndex]!.claimRevisionIds);
    if (requiredIds.size) throw new JobFailure('INVALID_CONTRACT', 'NOT_SUBMITTED');
  } else {
    const adaptation = await tx.adaptation.findUnique({ where: { projectId_format: { projectId: job.projectId,format: manifest.format } },select: { revision: true } });
    if ((adaptation?.revision ?? 0) !== manifest.expectedRevision) throw new JobFailure('STALE_INPUT','NOT_SUBMITTED');
  }
  const grounding = await new SourceGroundingService().inspectSet(tx, job.projectId, manifest.sourceEvidenceSetId, frozen.id, true);
  if (grounding.sha256 !== manifest.setHash) throw new JobFailure('INPUT_INTEGRITY', 'NOT_SUBMITTED');
  let approvedArticle;
  if (manifest.task === 'ADAPTATION') {
    if (manifest.includeLink && manifest.format !== 'TELEGRAM_POST') throw new JobFailure('INPUT_INTEGRITY','NOT_SUBMITTED');
    if (manifest.inputMode === 'ARTICLE_DERIVED') {
      if (!articles) throw new JobFailure('INVALID_CONTRACT','NOT_SUBMITTED');
      const parent = await sourceArticleContext(tx,job.projectId,articles);
      if (parent.briefRevisionId !== frozen.id || parent.sourceEvidenceSetId !== manifest.sourceEvidenceSetId) throw new JobFailure('STALE_INPUT','NOT_SUBMITTED');
      approvedArticle = parent.approvedArticle;
    }
  }
  const context = frozen.contextSnapshots.map(row => {
    if (sha256Text(row.snapshot.normalizedText) !== row.snapshot.sha256) throw new JobFailure('INPUT_INTEGRITY', 'NOT_SUBMITTED');
    return { snapshotId: row.snapshotId, purpose: row.capturedPurpose, sha256: row.snapshot.sha256, text: row.snapshot.normalizedText };
  }).sort((a,b) => a.snapshotId.localeCompare(b.snapshotId));
  const request = sourceWritingInputSchema.parse({ schemaVersion: 'source-writing-input-v1', requestId: manifest.requestId, task: manifest.task,
    brief: guideSourceWritingBrief({ topic: frozen.topic, audience: frozen.audience, centralMessage: frozen.centralMessage, category: frozen.category,
      tone: frozen.tone, targetLength: frozen.targetLength, cta: frozen.cta, exclusions: frozen.exclusions, notes: frozen.notes },
    manifest.task === 'ADAPTATION' ? manifest.format : undefined),
    style: { brandbook: frozen.style.brandbook, tone: frozen.style.tone, settings: frozen.style.settings }, context, ...sectionContext,
    ...(manifest.task === 'ADAPTATION' ? { format: manifest.format,...(approvedArticle ? { approvedArticle } : {}) } : {}),
    passages: grounding.passages.filter(row => manifest.task !== 'SECTION' || row.packetId === manifest.packetId)
      .map(row => ({ id: row.id, packetId: row.packetId, snapshotId: row.snapshotId, quote: row.quote })),
    requiredClaims: grounding.requiredClaims.filter(row => !requiredIds || requiredIds.has(row.claimRevisionId)) });
  if (canonicalManifestHash(request) !== canonicalManifestHash(manifest.request)) {
    // Preserve requests already queued before format guidance was introduced.
    // Both accepted shapes must reconstruct the exact original frozen brief.
    const legacyRequest = sourceWritingInputSchema.parse({ ...request,
      brief: { ...request.brief, notes: frozen.notes, tone: frozen.tone } });
    if (canonicalManifestHash(legacyRequest) !== canonicalManifestHash(manifest.request)) {
      throw new JobFailure('INPUT_INTEGRITY', 'NOT_SUBMITTED');
    }
  }
}

export function createSourceWritingJobHandler(deps: { prisma: PrismaClient; editorial: EditorialService; factualBasis: FactualBasisService;
  telegram?: TelegramService; articles?: ArticleService; scripts?: ScriptService; provider?: Provider; env?: Record<string, string | undefined> }): JobHandler {
  const provider = deps.provider ?? new DifySourceWritingProvider(), env = deps.env ?? process.env;
  async function call(context: JobContext, runId?: string) {
    let beforeProvider = !runId;
    try {
      const manifest = manifestFor(context.job), settings = sourceWritingWorkflowSettings(env);
      const { apiKey: _key, ...release } = settings; void _key;
      if (canonicalManifestHash(release) !== canonicalManifestHash(manifest.release)) throw new JobFailure('CONFIG_CHANGED', 'NOT_SUBMITTED');
      // New submissions validate under the provider-intent lock immediately before sending.
      if (runId) await deps.prisma.$transaction(tx => validateFrozen(tx, context.job, manifest, deps.factualBasis,deps.articles),
        { maxWait: 10000, timeout: 20000 });
      const execution = await deps.prisma.aIExecution.upsert({ where: { attemptId: context.attempt.id }, update: {}, create: {
        id: randomUUID(), projectId: context.job.projectId, jobId: context.job.id, attemptId: context.attempt.id,
        workflowId: release.workflowId, releaseId: release.releaseId, configDigest: release.configDigest, contractVersion: 'source-writing-v1',
        promptTemplateVersion: release.releaseId === 'source-writing-2026-10-20.1' ? 'source-writing-prompt-v1'
          : release.releaseId === 'source-writing-2026-11-07.1' ? 'source-writing-prompt-v2' : 'source-writing-prompt-v3',
        inputManifest: json(context.job.inputManifest), inputHash: context.job.inputHash,
        providerRunId: runId ?? null } });
      let captured = runId;
      const recordRun = async (id: string) => {
        if (captured && captured !== id) throw new SourceWritingProviderError('INCOMPATIBLE_CONTRACT', 'Writing workflow changed run identity');
        if (!captured) { captured = id; await context.recordProviderRun(id); }
        await deps.prisma.aIExecution.updateMany({ where: { id: execution.id, attemptId: context.attempt.id, status: 'RUNNING' }, data: { providerRunId: id } });
      };
      let response: Awaited<ReturnType<Provider['execute']>>;
      if (runId) response = await provider.resume(settings, runId, manifest.request, context.signal);
      else {
        try { response = await provider.execute(settings, context.job.id, manifest.request, context.signal,
          async () => { await context.recordSubmissionIntent(); beforeProvider = false; }, recordRun); }
        catch (error) {
          if (!captured || !(error instanceof SourceWritingProviderError) || !['UNKNOWN_OUTCOME', 'TRANSIENT_TRANSPORT', 'TIMEOUT'].includes(error.code)) throw error;
          response = await provider.resume(settings, captured, manifest.request, context.signal);
        }
      }
      if (captured && captured !== response.workflowRunId) throw new SourceWritingProviderError('INCOMPATIBLE_CONTRACT', 'Writing workflow returned another run');
      await recordRun(response.workflowRunId);
      return { output: response.output, executionId: execution.id, providerRunId: response.workflowRunId, model: response.model };
    } catch (error) { return failure(error, beforeProvider); }
  }
  return { operation: 'SOURCE_WRITING',
    async validateSubmission(tx, job) { await validateFrozen(tx, job, manifestFor(job), deps.factualBasis,deps.articles); },
    execute: context => call(context), resume: (context, id) => call(context, id),
    async commit(tx, raw, job) {
      try {
        const result = z.object({ output: sourceWritingOutputSchema, executionId: z.uuid(), providerRunId: z.uuid(), model: z.string().max(200).nullable() }).strict().parse(raw);
        const manifest = manifestFor(job);
        await validateFrozen(tx, job, manifest, deps.factualBasis,deps.articles);
        const output = validateSourceWritingOutput(result.output, manifest.request);
        if (output.status !== 'ready' || !output.content) {
          if (output.status === 'needs_human' && output.review.modelCalls === 1 && output.review.issues.length === 0
            && output.review.reasons.some(reason => /: (?:ARRAY_BOUNDS|CANDIDATE_TASK_FIELDS|QUOTE_LOCATOR_NOT_UNIQUE|ASSERTION_LOCATOR_NOT_UNIQUE|ASSERTION_LOCATOR_OVERLAP|MISSING_CITATIONS|SECTION_WORD_BUDGET)$/u.test(reason))) {
            throw new JobFailure(manifest.task === 'SECTION' ? 'SECTION_DRAFT_INVALID' : 'WRITING_DRAFT_INVALID', 'KNOWN_SUCCEEDED');
          }
          throw new JobFailure(output.status === 'insufficient_evidence' ? 'INSUFFICIENT_EVIDENCE' : 'NEEDS_HUMAN', 'KNOWN_SUCCEEDED');
        }
        let refs: unknown;
        if (manifest.task === 'OUTLINE') refs = await deps.editorial.commitSourceGenerated(tx,job,output.content,result.executionId,manifest.sourceEvidenceSetId);
        else if (manifest.task === 'SECTION') refs = { content: output.content,output,outputHash: canonicalManifestHash(output) };
        else {
          if (!deps.telegram) throw new JobFailure('INVALID_CONTRACT','NOT_SUBMITTED');
          const caption = await deps.telegram.appendSourceCandidate(tx,job.requestedBy,job.projectId,manifest.format,
            assembleSourceAdaptation(manifest.request,output,manifest.includeLink),{ inputMode: manifest.inputMode,contentMode: 'FACTUAL',briefRevisionId: manifest.briefRevisionId,
              basisRevisionId: null,sourceEvidenceSetId: manifest.sourceEvidenceSetId,sourceArticleVersionId: manifest.request.approvedArticle?.versionId ?? null,workspaceId: manifest.workspaceId,
              workspaceStyleRevision: manifest.workspaceStyleRevision,includeLink: manifest.includeLink },manifest.expectedRevision,job.id,result.executionId);
          const script = assembleSourceScript(manifest.request,output);
          if (script && !deps.scripts) throw new JobFailure('INVALID_CONTRACT','NOT_SUBMITTED');
          refs = { ...caption,...(script ? await deps.scripts!.commitGenerated(tx,job,caption.adaptationRevisionId,script,result.executionId) : {}) };
        }
        const updated = await tx.aIExecution.updateMany({ where: { id: result.executionId, jobId: job.id, projectId: job.projectId, status: 'RUNNING' },
          data: { status: 'SUCCEEDED', providerRunId: result.providerRunId, model: result.model, finishedAt: new Date(), errorCategory: null } });
        if (updated.count !== 1) throw new JobFailure('INVALID_CONTRACT', 'KNOWN_SUCCEEDED');
        return json({ ...refs as Record<string,unknown>, executionId: result.executionId, review: output.review });
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
