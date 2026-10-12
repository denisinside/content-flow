import { randomUUID } from 'node:crypto';
import { HttpException } from '@nestjs/common';
import { z } from 'zod';
import type { Prisma, PrismaClient } from '../generated/prisma/client.js';
import { JobFailure, JobFenceLost, type JobContext, type JobHandler } from '../jobs/contracts.js';
import { canonicalManifestHash } from '../jobs/job-service.js';
import type { FactualBasisService } from '../claims/factual-basis.service.js';
import type { ArticleService } from './article.service.js';
import { articleContentSchema, articleDocumentDetails } from './article-contracts.js';
import type { TelegramService } from './telegram.service.js';
import type { ScriptService } from './script.service.js';
import { telegramInputManifestSchema, telegramOutputSchema, type TelegramInputManifest } from './telegram-contracts.js';
import { DifyTelegramProvider, TelegramProviderError, telegramWorkflowSettings, sha256,
  type TelegramProviderInput, type TelegramWorkflowSettings } from './telegram-provider.js';

type Provider = Pick<DifyTelegramProvider, 'execute' | 'resume'>;
type Result = { output: unknown; executionId: string; providerRunId: string; model: string | null };
function json(value: unknown): Prisma.InputJsonValue { return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue; }
function fail(error: unknown): never {
  if (error instanceof JobFailure || error instanceof JobFenceLost || error instanceof HttpException) throw error;
  if (error instanceof TelegramProviderError) throw new JobFailure(({ CONFIG: 'CONFIG_CHANGED', AUTH: 'PROVIDER_AUTH',
    INVALID_INPUT: 'INVALID_INPUT', INCOMPATIBLE_CONTRACT: 'INVALID_CONTRACT', QUOTA: 'QUOTA', RATE_LIMIT: 'RATE_LIMIT',
    TRANSIENT_TRANSPORT: 'TRANSIENT_TRANSPORT', TIMEOUT: 'TIMEOUT', UNKNOWN_OUTCOME: 'UNKNOWN_OUTCOME',
    PROVIDER_FAILED: 'PROVIDER_FAILED' })[error.code], error.outcome);
  throw new JobFailure('INVALID_CONTRACT', 'KNOWN_FAILED');
}
function manifestFor(job: JobContext['job']): TelegramInputManifest {
  const parsed = telegramInputManifestSchema.safeParse(job.inputManifest);
  if (job.operation === 'TELEGRAM_GENERATION' && job.contractVersion === 'telegram-v1') {
    throw new JobFailure('CONFIG_CHANGED', 'NOT_SUBMITTED');
  }
  if (job.operation !== 'TELEGRAM_GENERATION' || job.contractVersion !== 'adaptation-v1' || !parsed.success
    || job.inputHash !== canonicalManifestHash({ contractVersion: job.contractVersion, inputManifest: job.inputManifest })) {
    throw new JobFailure('INPUT_INTEGRITY', 'NOT_SUBMITTED');
  }
  return parsed.data;
}

async function frozenContext(tx: Prisma.TransactionClient, projectId: string, manifest: TelegramInputManifest,
  telegram: TelegramService, facts: FactualBasisService, articles: ArticleService): Promise<TelegramProviderInput> {
  // Factual review, source withdrawal and project archive writers take an
  // exclusive Project lock. Hold a shared lock through the full frozen read.
  await tx.$queryRaw`SELECT "id" FROM contextflow."Project" WHERE "id" = ${projectId}::uuid FOR SHARE`;
  const frozen = await telegram.frozenContext(tx, projectId, manifest);
  const brief = frozen.brief;
  if (!brief || brief.id !== manifest.briefRevisionId || brief.sha256 !== manifest.briefHash
    || canonicalManifestHash(brief.contextSnapshots.map((row: { snapshotId: string }) => row.snapshotId).sort())
      !== canonicalManifestHash([...manifest.contextSnapshotIds].sort())) throw new JobFailure('INPUT_INTEGRITY', 'NOT_SUBMITTED');

  const sourceArticle = frozen.sourceArticle;
  const sourceEvidence = manifest.inputMode === 'ARTICLE_DERIVED' && sourceArticle
    ? new Set(sourceArticle.claims.map((row: { claimRevisionId: string; evidenceId: string }) => `${row.claimRevisionId}:${row.evidenceId}`)) : null;
  const claims: TelegramProviderInput['claims'] = [];
  if (manifest.basisRevisionId) {
    const basis = await facts.inspectBasisRevision(tx, projectId, manifest.basisRevisionId);
    if (!basis.valid || basis.sha256 !== manifest.basisHash) throw new JobFailure('FACTUAL_BASIS_BLOCKED', 'NOT_SUBMITTED');
    const rows = await tx.basisClaim.findMany({ where: { projectId, basisId: basis.id },
      include: { claimRevision: true, evidence: { include: { evidence: true } } }, orderBy: { claimRevisionId: 'asc' } });
    for (const row of rows) {
      const evidence = row.evidence.filter(edge => !sourceEvidence || sourceEvidence.has(`${row.claimRevisionId}:${edge.evidenceId}`))
        .map(edge => ({ evidenceId: edge.evidenceId, quote: edge.evidence.quote, snapshotId: edge.evidence.snapshotId }));
      if (evidence.length) claims.push({ claimRevisionId: row.claimRevisionId, wording: row.claimRevision.wording, evidence });
    }
    if (brief.requiredClaims.some((row: { claimRevisionId: string }) => !claims.some(claim => claim.claimRevisionId === row.claimRevisionId))) {
      throw new JobFailure('INVALID_INPUT', 'NOT_SUBMITTED');
    }
  }
  const contextRows = brief.contextSnapshots;
  const snapshots = await tx.sourceSnapshot.findMany({ where: { projectId, id: { in: contextRows.map((row: { snapshotId: string }) => row.snapshotId) } } });
  if (snapshots.length !== contextRows.length) throw new JobFailure('INPUT_INTEGRITY', 'NOT_SUBMITTED');
  const snapshotById = new Map(snapshots.map(row => [row.id, row]));
  const context = contextRows.map((row: { snapshotId: string; capturedPurpose: string }) => {
    const snapshot = snapshotById.get(row.snapshotId);
    if (!snapshot || sha256(snapshot.normalizedText) !== snapshot.sha256) throw new JobFailure('INPUT_INTEGRITY', 'NOT_SUBMITTED');
    return { snapshotId: row.snapshotId, purpose: row.capturedPurpose, sha256: snapshot.sha256, text: snapshot.normalizedText };
  }).sort((a, b) => a.snapshotId.localeCompare(b.snapshotId));
  if (manifest.inputMode === 'ARTICLE_DERIVED') {
    if (!sourceArticle || sourceArticle.id !== manifest.sourceArticleVersionId || sourceArticle.sha256 !== manifest.sourceArticleHash
      || sourceArticle.contentMode !== manifest.contentMode || !sourceArticle.approvedAt || sourceArticle.withdrawnAt) {
      throw new JobFailure('ARTICLE_BLOCKED', 'NOT_SUBMITTED');
    }
    const articleContent = articleContentSchema.safeParse(sourceArticle.content);
    if (!articleContent.success || articleDocumentDetails(articleContent.data).plainText !== sourceArticle.plainText) {
      throw new JobFailure('INPUT_INTEGRITY', 'NOT_SUBMITTED');
    }
    const inspection = await articles.inspectVersion(tx, projectId, sourceArticle);
    // Submission checks current eligibility. Once accepted, the job uses an
    // immutable article version; dependency changes should make its candidate
    // stale for review, not erase the result. Unsafe evidence or approval
    // failures remain blocking here.
    if (inspection.blockingReasons.length) throw new JobFailure('ARTICLE_BLOCKED', 'NOT_SUBMITTED');
  }
  const input: TelegramProviderInput = { schemaVersion: 'channel-context-v1', format: manifest.format, inputMode: manifest.inputMode,
    contentMode: manifest.contentMode, includeLink: manifest.includeLink,
    brief: { topic: brief.topic, audience: brief.audience, centralMessage: brief.centralMessage, category: brief.category,
      tone: brief.tone, targetLength: brief.targetLength, cta: brief.cta, exclusions: brief.exclusions, notes: brief.notes,
      requiredClaimRevisionIds: brief.requiredClaims.map((row: { claimRevisionId: string }) => row.claimRevisionId).sort() },
    style: { brandbook: frozen.style.brandbook, tone: frozen.style.tone, settings: frozen.style.settings }, claims, context,
    article: sourceArticle ? { versionId: sourceArticle.id, sha256: sourceArticle.sha256, text: sourceArticle.plainText } : null };
  if (Buffer.byteLength(JSON.stringify(input)) > 350000) throw new JobFailure('INVALID_INPUT', 'NOT_SUBMITTED');
  return input;
}

export function createTelegramJobHandler(deps: { prisma: PrismaClient; telegram: TelegramService; scripts: ScriptService; factualBasis: FactualBasisService;
  articles: ArticleService; provider?: Provider; env?: Record<string, string | undefined> }): JobHandler {
  const provider = deps.provider ?? new DifyTelegramProvider(), env = deps.env ?? process.env;
  async function call(context: JobContext, runId?: string): Promise<Result> {
    try {
      const manifest = manifestFor(context.job);
      const settings: TelegramWorkflowSettings = telegramWorkflowSettings(env);
      const { apiKey: _key, ...release } = settings;
      void _key;
      if (canonicalManifestHash(release) !== canonicalManifestHash(manifest.release)) throw new JobFailure('CONFIG_CHANGED', 'NOT_SUBMITTED');
      const input = await deps.prisma.$transaction(tx => frozenContext(tx, context.job.projectId, manifest, deps.telegram, deps.factualBasis, deps.articles));
      const execution = await deps.prisma.aIExecution.upsert({ where: { attemptId: context.attempt.id }, update: {},
        create: { id: randomUUID(), projectId: context.job.projectId, jobId: context.job.id, attemptId: context.attempt.id,
          workflowId: release.workflowId, releaseId: release.releaseId, configDigest: release.configDigest,
          contractVersion: release.contractVersion, promptTemplateVersion: release.promptTemplateVersion,
          inputManifest: json(context.job.inputManifest), inputHash: context.job.inputHash, providerRunId: runId ?? null } });
      let captured = runId;
      const record = async (id: string) => {
        if (captured && captured !== id) throw new TelegramProviderError('INCOMPATIBLE_CONTRACT', 'Telegram workflow changed run identity');
        if (!captured) { captured = id; await context.recordProviderRun(id); }
        await deps.prisma.aIExecution.updateMany({ where: { id: execution.id, status: 'RUNNING' }, data: { providerRunId: id } });
      };
      let result: Awaited<ReturnType<Provider['execute']>>;
      if (runId) result = await provider.resume(settings, runId, context.signal);
      else {
        try { result = await provider.execute(settings, context.job.id, input, context.signal, () => context.recordSubmissionIntent(), record); }
        catch (error) {
          if (!captured || !(error instanceof TelegramProviderError) || !['UNKNOWN_OUTCOME', 'TRANSIENT_TRANSPORT', 'TIMEOUT'].includes(error.code)) throw error;
          result = await provider.resume(settings, captured, context.signal);
        }
      }
      if (captured && captured !== result.workflowRunId) throw new TelegramProviderError('INCOMPATIBLE_CONTRACT', 'Telegram workflow changed run identity');
      await record(result.workflowRunId);
      return { output: result.output, executionId: execution.id, providerRunId: result.workflowRunId, model: result.model };
    } catch (error) { return fail(error); }
  }
  return { operation: 'TELEGRAM_GENERATION',
    async validateSubmission(tx, job) { await frozenContext(tx, job.projectId, manifestFor(job), deps.telegram, deps.factualBasis, deps.articles); },
    execute: context => call(context), resume: (context, id) => call(context, id),
    async commit(tx, raw, job) {
      try {
        const result = z.object({ output: telegramOutputSchema, executionId: z.uuid(), providerRunId: z.uuid(),
          model: z.string().max(200).nullable() }).strict().parse(raw);
        const manifest = manifestFor(job);
        await frozenContext(tx, job.projectId, manifest, deps.telegram, deps.factualBasis, deps.articles);
        if (result.output.format !== manifest.format) throw new JobFailure('INVALID_CONTRACT', 'KNOWN_SUCCEEDED');
        const refs = await deps.telegram.commitGenerated(tx, job, result.output.content, result.executionId);
        if (result.output.script) await deps.scripts.commitGenerated(tx, job, refs.adaptationRevisionId, result.output.script, result.executionId);
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
