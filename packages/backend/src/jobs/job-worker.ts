import { randomUUID } from 'node:crypto';
import { Queue, Worker } from 'bullmq';
import { Redis } from 'ioredis';
import type { PrismaClient } from '../generated/prisma/client.js';
import { canonicalManifestHash, DurableJobService } from './job-service.js';
import { JOB_QUEUE, JobFailure, type JobHandler } from './contracts.js';

type Delivery = { jobId: string; ordinal: number };
export class DurableJobWorker {
  readonly queue: Queue<Delivery>;
  readonly service: DurableJobService;
  private readonly redis: Redis;
  private readonly producerRedis: Redis;
  private readonly owner = randomUUID();
  private worker: Worker<Delivery> | undefined;
  private timer: ReturnType<typeof setInterval> | undefined;
  private ticking = false;
  private closing = false;
  private readonly aborters = new Map<string, AbortController>();
  lastReconcileAt: Date | null = null;
  lastDispatchError: 'DB_UNAVAILABLE' | 'QUEUE_UNAVAILABLE' | null = null;

  constructor(prisma: PrismaClient, redisUrl: string, noticeVersion: string, private readonly handlers: readonly JobHandler[],
    options: { queueName?: string; leaseMs?: number; retryBaseMs?: number; intervalMs?: number } = {}) {
    this.service = new DurableJobService(prisma, { noticeVersion, ...(options.leaseMs ? { leaseMs: options.leaseMs } : {}),
      ...(options.retryBaseMs !== undefined ? { retryBaseMs: options.retryBaseMs } : {}) });
    this.intervalMs = options.intervalMs ?? 1000;
    this.queueName = options.queueName ?? JOB_QUEUE;
    this.redis = new Redis(redisUrl, { maxRetriesPerRequest: null, enableOfflineQueue: true });
    this.redis.on('error', () => {});
    this.producerRedis = new Redis(redisUrl, { maxRetriesPerRequest: 1, commandTimeout: 3000, connectTimeout: 3000, enableOfflineQueue: false });
    this.producerRedis.on('error', () => {});
    this.queue = new Queue<Delivery>(this.queueName, { connection: this.producerRedis, defaultJobOptions: {
      removeOnComplete: { age: 3600, count: 1000 }, removeOnFail: { age: 86400, count: 1000 }, attempts: 1,
    } });
    this.queue.on('error', () => {});
  }
  private readonly intervalMs: number;
  private readonly queueName: string;

  async start(): Promise<void> {
    this.timer = setInterval(() => { void this.tick(); }, this.intervalMs);
    this.timer.unref();
    this.worker = new Worker<Delivery>(this.queueName, delivery => this.process(delivery.data), {
      connection: this.redis, concurrency: 2, lockDuration: Math.max(30_000, this.service.leaseMs * 2),
    });
    this.worker.on('error', () => { this.lastDispatchError = 'QUEUE_UNAVAILABLE'; });
    try { await this.bounded(this.queue.setGlobalConcurrency(2)); await this.bounded(this.worker.waitUntilReady()); }
    catch { this.lastDispatchError = 'QUEUE_UNAVAILABLE'; }
    void this.tick();
  }
  private async bounded<T>(operation: Promise<T>): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try { return await Promise.race([operation, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('Dependency deadline')), 3000); timer.unref();
    })]); } finally { if (timer) clearTimeout(timer); }
  }

  async tick(): Promise<void> {
    if (this.ticking || this.closing) return;
    this.ticking = true;
    try {
      try { await this.service.reconcile(this.handlers.filter(handler => handler.resume).map(handler => handler.operation)); this.lastReconcileAt = new Date(); }
      catch { this.lastDispatchError = 'DB_UNAVAILABLE'; return; }
      try { await this.bounded(this.dispatch()); this.lastDispatchError = null; }
      catch { this.lastDispatchError = 'QUEUE_UNAVAILABLE'; }
    }
    finally { this.ticking = false; }
  }
  async dispatch(): Promise<number> {
    const rows = await this.service.prisma.$transaction(tx => tx.$queryRaw<Array<{ id: string; attemptCount: number }>>`
      SELECT "id", "attemptCount" FROM contextflow."Job" WHERE "status" IN ('QUEUED', 'RETRY_WAIT')
      AND "nextAttemptAt" <= CURRENT_TIMESTAMP AND "deadlineAt" > CURRENT_TIMESTAMP AND "attemptCount" < 3
      AND "cancelRequestedAt" IS NULL ORDER BY "nextAttemptAt", "id" LIMIT 50 FOR UPDATE SKIP LOCKED`);
    let count = 0;
    for (const row of rows) {
      const ordinal = row.attemptCount + 1;
      const id = row.id + '-' + ordinal;
      const existing = await this.queue.getJob(id);
      if (existing && ['completed', 'failed'].includes(await existing.getState())) await existing.remove();
      // Same ID survives publish/ack races. DB lease and ordinal fence duplicate queue deliveries.
      await this.queue.add('execute', { jobId: row.id, ordinal }, { jobId: id });
      await this.service.prisma.job.updateMany({ where: { id: row.id, status: { in: ['QUEUED', 'RETRY_WAIT'] },
        attemptCount: row.attemptCount }, data: { publishedAt: new Date(), updatedAt: new Date() } });
      count++;
    }
    return count;
  }
  async process(delivery: Delivery): Promise<void> {
    const claimed = await this.service.claim(delivery.jobId, delivery.ordinal, this.owner);
    if (!claimed) return;
    const { job, attempt } = claimed;
    const controller = new AbortController();
    this.aborters.set(job.id, controller);
    let heartbeatRunning = false;
    const heartbeat = setInterval(() => {
      if (heartbeatRunning) return;
      heartbeatRunning = true;
      void this.service.heartbeat(job, attempt).catch(() => controller.abort()).finally(() => { heartbeatRunning = false; });
    }, Math.max(50, Math.floor(this.service.leaseMs / 3)));
    heartbeat.unref();
    const deadline = setTimeout(() => controller.abort(), Math.max(1, job.deadlineAt.getTime() - Date.now()));
    deadline.unref();
    const handler = this.handlers.find(candidate => candidate.operation === job.operation);
    const context = { job, attempt, signal: controller.signal,
      recordSubmissionIntent: () => this.service.providerIntent(job, attempt, undefined,
        handler?.validateSubmission ? tx => handler.validateSubmission!(tx, job) : undefined),
      recordProviderRun: (id: string) => this.service.providerIntent(job, attempt, id),
      setProgress: (stage: string) => this.service.progress(job, attempt, stage) };
    try {
      if (!handler) throw new JobFailure('PROVIDER_NOT_CONFIGURED', 'NOT_SUBMITTED');
      if (job.inputHash !== canonicalManifestHash({ contractVersion: job.contractVersion, inputManifest: job.inputManifest })) {
        throw new JobFailure('INPUT_INTEGRITY', 'NOT_SUBMITTED');
      }
      const execution = attempt.providerRunId
        ? handler.resume ? handler.resume(context, attempt.providerRunId) : Promise.reject(new JobFailure('WORKER_LOST', 'UNKNOWN'))
        : handler.execute(context);
      // A non-cooperative provider cannot keep this worker alive past cancellation/deadline.
      const aborted = new Promise<never>((_, reject) => {
        if (controller.signal.aborted) reject(new Error('Execution aborted'));
        else controller.signal.addEventListener('abort', () => reject(new Error('Execution aborted')), { once: true });
      });
      const result = await Promise.race([execution, aborted]);
      await this.service.succeed(job, attempt, handler, result);
    } catch (error) {
      if (controller.signal.aborted) await this.service.reconcile();
      await this.service.fail(job, attempt, error);
      if (handler?.failed) await handler.failed(context, error);
    } finally { clearTimeout(deadline); clearInterval(heartbeat); this.aborters.delete(job.id); }
  }
  async close(): Promise<void> {
    this.closing = true;
    if (this.timer) clearInterval(this.timer);
    for (const controller of this.aborters.values()) controller.abort();
    await this.worker?.close();
    await this.queue.close();
    this.redis.disconnect();
    this.producerRedis.disconnect();
  }
  async onModuleInit(): Promise<void> { await this.start(); }
  async onModuleDestroy(): Promise<void> { await this.close(); }
}
