import { BadRequestException, ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import type { Prisma, PrismaClient, Job, JobAttempt } from '../generated/prisma/client.js';
import { JobFailure, JobFenceLost, SAFE_RETRY_CATEGORIES, retryAllowed, type CreateJobInput, type JobHandler } from './contracts.js';

export function canonicalManifestHash(value: unknown): string {
  function canonical(input: unknown): string {
    if (input === null || typeof input === 'string' || typeof input === 'boolean') return JSON.stringify(input);
    if (typeof input === 'number' && Number.isFinite(input)) return JSON.stringify(input);
    if (Array.isArray(input)) return '[' + input.map(canonical).join(',') + ']';
    if (typeof input === 'object' && input !== null) return '{' + Object.keys(input).sort().map(key =>
      JSON.stringify(key) + ':' + canonical((input as Record<string, unknown>)[key])).join(',') + '}';
    throw new BadRequestException('Job input must contain JSON values');
  }
  return createHash('sha256').update(canonical(value)).digest('hex');
}

export function jobDeadlineMs(input: Pick<CreateJobInput, 'operation' | 'deadlineMs'>): number {
  const deadlineMs = input.deadlineMs ?? (input.operation === 'WEB_IMPORT' ? 60_000 : 600_000);
  // Article generation and evidence extraction run bounded revision loops. Other
  // operations retain their existing ten-minute maximum.
  const maximum = input.operation === 'ARTICLE_GENERATION' || input.operation === 'CLAIM_EXTRACTION' ? 3_600_000 : 600_000;
  if (!Number.isSafeInteger(deadlineMs) || deadlineMs < 1 || deadlineMs > maximum) {
    throw new BadRequestException('Invalid job deadline');
  }
  return deadlineMs;
}

export class DurableJobService {
  constructor(readonly prisma: PrismaClient, private readonly options: { noticeVersion: string; leaseMs?: number; retryBaseMs?: number }) {}
  get leaseMs(): number { return this.options.leaseMs ?? 30_000; }

  async assertEffects(tx: Prisma.TransactionClient, projectId: string, userId: string, requiresExternalProcessing = true): Promise<void> {
    const access = await tx.$queryRaw<Array<{ id: string }>>`SELECT p."id" FROM contextflow."Project" p
      JOIN contextflow."Workspace" w ON w."id" = p."workspaceId"
      JOIN contextflow."WorkspaceMember" m ON m."workspaceId" = w."id"
      JOIN contextflow."UserProfile" u ON u."id" = m."userId"
      WHERE p."id" = ${projectId}::uuid AND p."archivedAt" IS NULL AND p."trashedAt" IS NULL AND w."archivedAt" IS NULL AND w."trashedAt" IS NULL
      AND m."userId" = ${userId}::uuid AND m."leftAt" IS NULL
      AND (NOT ${requiresExternalProcessing} OR (u."externalProcessingNoticeVersion" = ${this.options.noticeVersion} AND u."externalProcessingAcceptedAt" IS NOT NULL))
      FOR SHARE OF p, w, m, u`;
    if (!access.length) throw new ForbiddenException('Project access or external-processing acceptance is no longer valid');
  }

  async create(tx: Prisma.TransactionClient, input: CreateJobInput): Promise<Job> {
    if (!/^[\w-]{1,128}$/u.test(input.commandKey) || !input.contractVersion || input.contractVersion.length > 64) {
      throw new BadRequestException('Invalid job command key or contract');
    }
    const deadlineMs = jobDeadlineMs(input);
    await this.assertEffects(tx, input.projectId, input.userId, input.operation !== 'EXPORT_BUILD');
    const hash = canonicalManifestHash({ contractVersion: input.contractVersion, inputManifest: input.inputManifest });
    // A transaction advisory lock serializes replay before insert, avoiding an aborted transaction on unique conflict.
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${input.projectId + input.operation + input.commandKey}, 0))::text`;
    const where = { projectId_operation_commandKey: { projectId: input.projectId, operation: input.operation, commandKey: input.commandKey } };
    const existing = await tx.job.findUnique({ where });
    if (existing) {
      if (existing.inputHash !== hash) throw new ConflictException('Command key already belongs to different frozen inputs');
      return existing;
    }
    const now = new Date();
    return tx.job.create({ data: { id: randomUUID(), projectId: input.projectId, requestedBy: input.userId,
      operation: input.operation, contractVersion: input.contractVersion, commandKey: input.commandKey,
      inputManifest: input.inputManifest, inputHash: hash, createdAt: now, deadlineAt: new Date(now.getTime() + deadlineMs) } });
  }

  private async lock(tx: Prisma.TransactionClient, id: string): Promise<Job | null> {
    await tx.$queryRaw`SELECT "id" FROM contextflow."Job" WHERE "id" = ${id}::uuid FOR UPDATE`;
    return tx.job.findUnique({ where: { id } });
  }
  private async readable(userId: string, projectId: string): Promise<void> {
    if (!await this.prisma.project.findFirst({ where: { id: projectId, trashedAt: null, workspace: { trashedAt: null, members: { some: { userId, leftAt: null } } } }, select: { id: true } })) {
      throw new NotFoundException('Project not found');
    }
  }
  async list(userId: string, projectId: string) {
    await this.readable(userId, projectId);
    return this.prisma.job.findMany({ where: { projectId }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: 50 });
  }
  async get(userId: string, projectId: string, id: string) {
    await this.readable(userId, projectId);
    const job = await this.prisma.job.findFirst({ where: { id, projectId }, include: { attempts: { orderBy: { ordinal: 'asc' } } } });
    if (!job) throw new NotFoundException('Job not found');
    return job;
  }
  async cancel(userId: string, projectId: string, id: string): Promise<Job> {
    await this.get(userId, projectId, id);
    return this.prisma.$transaction(async tx => {
      let job = await this.lock(tx, id);
      if (!job || job.projectId !== projectId) throw new NotFoundException('Job not found');
      const membership = await tx.$queryRaw<Array<{ id: string }>>`SELECT p."id" FROM contextflow."Project" p
        JOIN contextflow."Workspace" w ON w."id" = p."workspaceId"
        JOIN contextflow."WorkspaceMember" m ON m."workspaceId" = p."workspaceId"
        WHERE p."id" = ${projectId}::uuid AND p."trashedAt" IS NULL AND w."trashedAt" IS NULL AND m."userId" = ${userId}::uuid AND m."leftAt" IS NULL FOR SHARE OF p, w, m`;
      if (!membership.length) throw new NotFoundException('Project not found');
      job = await this.searchActionTarget(tx, job);
      if (['SUCCEEDED', 'FAILED', 'CANCELLED', 'OUTCOME_UNKNOWN'].includes(job.status)) return job;
      const now = new Date();
      const activeAttempts = await tx.jobAttempt.findMany({ where: { jobId: job.id, finishedAt: null }, select: { id: true, providerSubmittedAt: true } });
      for (const attempt of activeAttempts) await tx.aIExecution.updateMany({ where: { attemptId: attempt.id, status: 'RUNNING' }, data: {
        status: attempt.providerSubmittedAt ? 'OUTCOME_UNKNOWN' : 'FAILED', finishedAt: now, errorCategory: 'CANCELLED' } });
      await tx.jobAttempt.updateMany({ where: { jobId: job.id, finishedAt: null }, data: { finishedAt: now, errorCategory: 'CANCELLED' } });
      return tx.job.update({ where: { id: job.id }, data: { status: 'CANCELLED', cancelRequestedAt: now, progressStage: 'CANCELLED',
        fencingToken: { increment: 1 }, errorCategory: 'CANCELLED', updatedAt: now } });
    });
  }
  async retry(userId: string, projectId: string, id: string): Promise<Job> {
    await this.get(userId, projectId, id);
    return this.prisma.$transaction(async tx => {
      let job = await this.lock(tx, id);
      if (!job || job.projectId !== projectId) throw new NotFoundException('Job not found');
      await this.assertEffects(tx, projectId, userId, job.operation !== 'EXPORT_BUILD');
      job = await this.searchActionTarget(tx, job);
      if (!retryAllowed(job)) throw new ConflictException('This job cannot be safely retried; explicitly start a new run');
      return tx.job.update({ where: { id: job.id }, data: { status: 'QUEUED', nextAttemptAt: new Date(), publishedAt: null,
        errorCategory: null, progressStage: 'WAITING', updatedAt: new Date() } });
    });
  }

  /** A completed retrieval stage may still own an active relevance stage. */
  private async searchActionTarget(tx: Prisma.TransactionClient, parent: Job): Promise<Job> {
    if (parent.operation !== 'EVIDENCE_SEARCH' || parent.contractVersion !== 'evidence-search-v2' || parent.status !== 'SUCCEEDED') return parent;
    const refs = parent.resultRefs as { relevanceJobId?: unknown } | null;
    if (!refs?.relevanceJobId) return parent;
    if (typeof refs.relevanceJobId !== 'string' || !/^[a-f0-9-]{36}$/u.test(refs.relevanceJobId)) {
      throw new ConflictException('Evidence search stage identity is invalid');
    }
    const child = await this.lock(tx, refs.relevanceJobId);
    const input = child?.inputManifest as { parentJobId?: unknown; parentInputHash?: unknown } | null;
    if (!child || child.projectId !== parent.projectId || child.requestedBy !== parent.requestedBy
      || child.operation !== 'EVIDENCE_SEARCH' || child.contractVersion !== 'evidence-relevance-v1'
      || input?.parentJobId !== parent.id || input.parentInputHash !== parent.inputHash) {
      throw new ConflictException('Evidence search stage does not match its frozen parent');
    }
    return child;
  }

  async claim(id: string, ordinal: number, owner: string): Promise<{ job: Job; attempt: JobAttempt } | null> {
    return this.prisma.$transaction(async tx => {
      const job = await this.lock(tx, id);
      const now = new Date();
      if (!job || !['QUEUED', 'RETRY_WAIT'].includes(job.status) || job.nextAttemptAt > now
        || job.cancelRequestedAt || job.deadlineAt <= now || job.attemptCount >= 3 || ordinal !== job.attemptCount + 1) return null;
      // DB advisory locks impose aggregate external-work <=2 and document conversion <=1 even after Redis loss.
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(7142201)::text`;
      const active = await tx.$queryRaw<Array<{ id: string; operation: string }>>`SELECT "id", "operation" FROM contextflow."Job"
        WHERE "status" = 'RUNNING' AND "deadlineAt" > CURRENT_TIMESTAMP`;
      const running = await tx.job.count({ where: { status: 'RUNNING', deadlineAt: { gt: now } } });
      if (running >= 2 || (job.operation === 'DOCUMENT_IMPORT' && active.some(row => row.operation === 'DOCUMENT_IMPORT'))) return null;
      try { await this.assertEffects(tx, job.projectId, job.requestedBy, job.operation !== 'EXPORT_BUILD'); }
      catch {
        await tx.job.update({ where: { id }, data: { status: 'FAILED', errorCategory: 'ACCESS_REVOKED', updatedAt: now, progressStage: 'FAILED' } });
        return null;
      }
      const token = job.fencingToken + 1;
      const previous = await tx.jobAttempt.findFirst({ where: { jobId: id }, orderBy: { ordinal: 'desc' } });
      const resume = job.providerOutcome === 'MAY_STILL_RUN' && previous?.providerRunId;
      const attempt = await tx.jobAttempt.create({ data: { id: randomUUID(), jobId: id, ordinal, fencingToken: token,
        leaseOwner: owner, heartbeatAt: now, leaseExpiresAt: new Date(now.getTime() + this.leaseMs),
        ...(resume ? { providerRunId: previous.providerRunId, providerSubmittedAt: previous.providerSubmittedAt, providerOutcome: 'MAY_STILL_RUN' } : {}) } });
      const claimed = await tx.job.update({ where: { id }, data: { status: 'RUNNING', attemptCount: ordinal,
        fencingToken: token, providerOutcome: resume ? 'MAY_STILL_RUN' : 'NOT_SUBMITTED', progressStage: 'PREPARING', errorCategory: null, updatedAt: now } });
      return { job: claimed, attempt };
    });
  }

  private async owned(tx: Prisma.TransactionClient, job: Job, attempt: JobAttempt): Promise<Job> {
    const current = await this.lock(tx, job.id);
    const now = new Date();
    const lease = await tx.jobAttempt.findUnique({ where: { id: attempt.id } });
    if (!current || current.status !== 'RUNNING' || current.fencingToken !== attempt.fencingToken || current.cancelRequestedAt
      || current.deadlineAt <= now || !lease || lease.finishedAt || lease.leaseExpiresAt <= now) throw new JobFenceLost();
    return current;
  }
  async heartbeat(job: Job, attempt: JobAttempt): Promise<void> {
    await this.prisma.$transaction(async tx => {
      await this.owned(tx, job, attempt);
      await this.assertEffects(tx, job.projectId, job.requestedBy, job.operation !== 'EXPORT_BUILD');
      const now = new Date();
      await tx.jobAttempt.update({ where: { id: attempt.id }, data: { heartbeatAt: now, leaseExpiresAt: new Date(now.getTime() + this.leaseMs) } });
    });
  }
  async progress(job: Job, attempt: JobAttempt, stage: string): Promise<void> {
    if (!/^[A-Z_]{1,64}$/u.test(stage)) throw new JobFailure('INVALID_CONTRACT', 'NOT_SUBMITTED');
    await this.prisma.$transaction(async tx => { await this.owned(tx, job, attempt);
      await tx.job.update({ where: { id: job.id }, data: { progressStage: stage, updatedAt: new Date() } }); });
  }
  async providerIntent(job: Job, attempt: JobAttempt, runId?: string, validate?: (tx: Prisma.TransactionClient) => Promise<void>): Promise<void> {
    if (runId !== undefined && (!runId || runId.length > 200)) throw new JobFailure('INVALID_CONTRACT');
    await this.prisma.$transaction(async tx => {
      await this.owned(tx, job, attempt);
      await this.assertEffects(tx, job.projectId, job.requestedBy, job.operation !== 'EXPORT_BUILD');
      if (validate) await validate(tx);
      await tx.jobAttempt.update({ where: { id: attempt.id }, data: { providerSubmittedAt: new Date(),
        providerOutcome: 'MAY_STILL_RUN', ...(runId ? { providerRunId: runId } : {}) } });
      await tx.job.update({ where: { id: job.id }, data: { providerOutcome: 'MAY_STILL_RUN', progressStage: 'PROCESSING', updatedAt: new Date() } });
    });
  }
  async succeed(job: Job, attempt: JobAttempt, handler: JobHandler, result: unknown): Promise<void> {
    await this.prisma.$transaction(async tx => {
      const current = await this.owned(tx, job, attempt);
      // Claim commits serialize with review/basis edits before acquiring shared
      // ancestry locks, avoiding concurrent shared-to-exclusive lock upgrades.
      if (job.operation === 'VISUAL_BACKGROUND_GENERATION' || job.operation === 'SOURCE_EMBEDDING' || job.operation === 'EVIDENCE_SEARCH' || job.operation === 'SOURCE_WRITING'
        || job.operation === 'CLAIM_EXTRACTION' || job.operation === 'OUTLINE_GENERATION' || job.operation === 'ARTICLE_GENERATION' || job.operation === 'TELEGRAM_GENERATION' || job.operation === 'EXPORT_BUILD' || job.operation === 'GOOGLE_DOCS_SYNC' || job.operation === 'BRIEF_PROPOSAL') {
        await tx.$queryRaw`SELECT "id" FROM contextflow."Project" WHERE "id" = ${job.projectId}::uuid FOR UPDATE`;
      }
      await this.assertEffects(tx, job.projectId, job.requestedBy, job.operation !== 'EXPORT_BUILD');
      const resultRefs = await handler.commit(tx, result, current);
      await this.owned(tx, job, attempt);
      const now = new Date();
      await tx.jobAttempt.update({ where: { id: attempt.id }, data: { finishedAt: now, providerOutcome: 'KNOWN_SUCCEEDED' } });
      await tx.job.update({ where: { id: job.id }, data: { status: 'SUCCEEDED', resultRefs,
        progressStage: 'COMPLETE', providerOutcome: 'KNOWN_SUCCEEDED', updatedAt: now } });
    });
  }
  async fail(job: Job, attempt: JobAttempt, error: unknown): Promise<void> {
    await this.prisma.$transaction(async tx => {
      const current = await this.lock(tx, job.id);
      if (!current || current.status !== 'RUNNING' || current.fencingToken !== attempt.fencingToken) return;
      const recorded = await tx.jobAttempt.findUniqueOrThrow({ where: { id: attempt.id } });
      let failure = error instanceof JobFailure ? error : new JobFailure(error instanceof ForbiddenException ? 'ACCESS_REVOKED' : 'EXECUTION_FAILED',
        recorded.providerSubmittedAt ? 'UNKNOWN' : 'NOT_SUBMITTED');
      if (current.deadlineAt <= new Date() || recorded.leaseExpiresAt <= new Date()) {
        failure = new JobFailure(current.deadlineAt <= new Date() ? 'TIMEOUT' : 'WORKER_LOST', recorded.providerSubmittedAt ? 'UNKNOWN' : 'NOT_SUBMITTED');
      }
      const unknown = ['MAY_STILL_RUN', 'UNKNOWN'].includes(failure.outcome);
      const now = new Date();
      const delay = Math.max(failure.retryAfterMs, (this.options.retryBaseMs ?? 2000) * 5 ** (attempt.ordinal - 1));
      const safeRetry = ['NOT_SUBMITTED', 'KNOWN_FAILED'].includes(failure.outcome) && SAFE_RETRY_CATEGORIES.has(failure.category)
        && attempt.ordinal < 3 && now.getTime() + delay < current.deadlineAt.getTime();
      await tx.jobAttempt.update({ where: { id: attempt.id }, data: { finishedAt: now, providerOutcome: failure.outcome, errorCategory: failure.category } });
      await tx.job.update({ where: { id: job.id }, data: { status: unknown ? 'OUTCOME_UNKNOWN' : safeRetry ? 'RETRY_WAIT' : 'FAILED',
        nextAttemptAt: new Date(now.getTime() + delay), publishedAt: null, errorCategory: failure.category,
        providerOutcome: failure.outcome, progressStage: safeRetry ? 'RETRY_WAIT' : 'FAILED', fencingToken: { increment: 1 }, updatedAt: now } });
    });
  }
  async reconcile(resumableOperations: readonly string[] = []): Promise<void> {
    const stale = await this.prisma.job.findMany({ where: { status: { in: ['QUEUED', 'RETRY_WAIT', 'RUNNING'] }, OR: [
      { deadlineAt: { lte: new Date() } }, { status: 'RUNNING', attempts: { some: { finishedAt: null, leaseExpiresAt: { lte: new Date() } } } }
    ] }, take: 100 });
    for (const candidate of stale) await this.prisma.$transaction(async tx => {
      const job = await this.lock(tx, candidate.id);
      if (!job || !['QUEUED', 'RETRY_WAIT', 'RUNNING'].includes(job.status)) return;
      const now = new Date();
      const attempt = await tx.jobAttempt.findFirst({ where: { jobId: job.id, finishedAt: null }, orderBy: { ordinal: 'desc' } });
      const timedOut = job.deadlineAt <= now;
      if (!timedOut && (!attempt || attempt.leaseExpiresAt > now)) return;
      const unknown = !!attempt?.providerSubmittedAt;
      const resume = !timedOut && !!attempt?.providerRunId && resumableOperations.includes(job.operation) && job.attemptCount < 3;
      const retry = !timedOut && (!unknown || resume) && job.attemptCount < 3;
      const category = timedOut ? 'TIMEOUT' : 'WORKER_LOST';
      if (attempt) await tx.jobAttempt.update({ where: { id: attempt.id }, data: { finishedAt: now,
        providerOutcome: unknown ? 'UNKNOWN' : 'NOT_SUBMITTED', errorCategory: category } });
      if (attempt) await tx.aIExecution.updateMany({ where: { attemptId: attempt.id, status: 'RUNNING' }, data: {
        status: unknown ? 'OUTCOME_UNKNOWN' : 'FAILED', finishedAt: now, errorCategory: category } });
      await tx.job.update({ where: { id: job.id }, data: { status: resume ? 'QUEUED' : unknown ? 'OUTCOME_UNKNOWN' : retry ? 'QUEUED' : 'FAILED',
        errorCategory: category, providerOutcome: resume ? 'MAY_STILL_RUN' : unknown ? 'UNKNOWN' : 'NOT_SUBMITTED', nextAttemptAt: now,
        publishedAt: null, progressStage: retry ? 'WAITING' : 'FAILED', fencingToken: { increment: 1 }, updatedAt: now } });
    });
  }
}
