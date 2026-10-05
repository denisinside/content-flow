import type { Prisma, Job, JobAttempt, JobOperation, ProviderOutcome } from '../generated/prisma/client.js';

export const JOB_QUEUE = 'contextflow-execution';
export const SAFE_RETRY_CATEGORIES = new Set(['TRANSIENT_TRANSPORT', 'ENGINE_UNAVAILABLE', 'RATE_LIMIT', 'PROVIDER_5XX']);
export interface CreateJobInput {
  projectId: string; userId: string; operation: JobOperation; contractVersion: string; commandKey: string;
  inputManifest: Prisma.InputJsonObject; deadlineMs?: number;
}
export interface JobContext {
  job: Job; attempt: JobAttempt; signal: AbortSignal;
  recordSubmissionIntent(): Promise<void>;
  recordProviderRun(id: string): Promise<void>;
  setProgress(stage: string): Promise<void>;
}
export type JobCommitResult = Prisma.InputJsonValue;
export interface JobHandler {
  operation: JobOperation;
  validateSubmission?(tx: Prisma.TransactionClient, job: Job): Promise<void>;
  execute(context: JobContext): Promise<unknown>;
  resume?(context: JobContext, providerRunId: string): Promise<unknown>;
  failed?(context: JobContext, error: unknown): Promise<void>;
  commit(tx: Prisma.TransactionClient, result: unknown, job: Job): Promise<JobCommitResult>;
}
export class JobFailure extends Error {
  constructor(readonly category: string, readonly outcome: ProviderOutcome = 'KNOWN_FAILED', readonly retryAfterMs = 0) {
    super(category); this.name = 'JobFailure';
  }
}
export class JobFenceLost extends Error {
  constructor() { super('Job execution lease was fenced'); this.name = 'JobFenceLost'; }
}
export function retryAllowed(job: Pick<Job, 'status' | 'attemptCount' | 'errorCategory' | 'providerOutcome' | 'deadlineAt'>): boolean {
  return job.status === 'FAILED' && job.attemptCount < 3 && job.deadlineAt.getTime() > Date.now()
    && SAFE_RETRY_CATEGORIES.has(job.errorCategory ?? '') && ['NOT_SUBMITTED', 'KNOWN_FAILED'].includes(job.providerOutcome);
}
export function jobView(job: Job & { attempts?: JobAttempt[] }) {
  const input = typeof job.inputManifest === 'object' && job.inputManifest !== null && !Array.isArray(job.inputManifest) ? job.inputManifest : {};
  const inputSummary = Object.fromEntries(['materialId', 'label', 'sourceUrl', 'originalAssetId', 'originalFilename']
    .filter(key => typeof input[key] === 'string').map(key => [key, input[key]]));
  return {
    id: job.id, projectId: job.projectId, operation: job.operation, status: job.status, progressStage: job.progressStage,
    attemptCount: job.attemptCount, maxAttempts: 3, nextAttemptAt: job.nextAttemptAt.toISOString(), deadlineAt: job.deadlineAt.toISOString(),
    cancelRequestedAt: job.cancelRequestedAt?.toISOString() ?? null, resultRefs: job.resultRefs,
    errorCategory: job.errorCategory, providerOutcome: job.providerOutcome, retryAllowed: retryAllowed(job), inputSummary,
    createdAt: job.createdAt.toISOString(), updatedAt: job.updatedAt.toISOString(),
    attempts: job.attempts?.map(attempt => ({ ordinal: attempt.ordinal, providerOutcome: attempt.providerOutcome,
      errorCategory: attempt.errorCategory, startedAt: attempt.startedAt.toISOString(), finishedAt: attempt.finishedAt?.toISOString() ?? null })) ?? [],
  };
}
