import { randomUUID } from 'node:crypto';
import { createServer, createConnection, type Socket } from 'node:net';
import { once } from 'node:events';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DependencyHealthService, DurableJobService, DurableJobWorker, JobFailure, loadRuntimeConfig, type JobHandler } from '@contextflow/backend';

describe('PostgreSQL durable execution and disposable BullMQ state', () => {
  const config = loadRuntimeConfig();
  const health = new DependencyHealthService(config);
  const owner = randomUUID();
  const member = randomUUID();
  const foreign = randomUUID();
  const workspaceId = randomUUID();
  const projectId = randomUUID();
  const service = new DurableJobService(health.prisma, { noticeVersion: '2026-09-28-v1', leaseMs: 500, retryBaseMs: 0 });
  const migration = new Pool({ connectionString: config.directDatabaseUrl, ssl: false, max: 2 });
  let commits = 0;
  const handler: JobHandler = { operation: 'WEB_IMPORT', execute: async () => ({ snapshotId: randomUUID() }),
    commit: async (_tx, result) => { commits++; return result as { snapshotId: string }; } };
  const worker = new DurableJobWorker(health.prisma, config.redisUrl, '2026-09-28-v1', [handler],
    { queueName: 'cf-fixture-' + randomUUID(), leaseMs: 500, retryBaseMs: 0 });

  beforeAll(async () => {
    expect((await health.check()).status).toBe('ready');
    await health.prisma.userProfile.createMany({ data: [owner, member, foreign].map(id => ({ id,
      externalProcessingNoticeVersion: '2026-09-28-v1', externalProcessingAcceptedAt: new Date() })) });
    await health.prisma.workspace.create({ data: { id: workspaceId, name: 'Durable fixture', ownerId: owner,
      members: { create: [{ userId: owner }, { userId: member }] } } });
    await health.prisma.project.create({ data: { id: projectId, workspaceId, createdBy: owner, topic: 'Durable jobs', formats: ['TELEGRAM_POST'] } });
    await worker.queue.waitUntilReady();
  });
  afterAll(async () => {
    await worker.queue.obliterate({ force: true });
    await worker.close();
    await migration.query('DELETE FROM contextflow."JobAttempt" WHERE "jobId" IN (SELECT "id" FROM contextflow."Job" WHERE "projectId"=$1)', [projectId]);
    await migration.query('DELETE FROM contextflow."Job" WHERE "projectId"=$1', [projectId]);
    await health.prisma.project.delete({ where: { id: projectId } });
    await health.prisma.workspaceMember.deleteMany({ where: { workspaceId } });
    await health.prisma.workspace.delete({ where: { id: workspaceId } });
    await health.prisma.userProfile.deleteMany({ where: { id: { in: [owner, member, foreign] } } });
    await migration.end();
    await health.onModuleDestroy();
  });
  const create = (commandKey = randomUUID(), inputManifest = { fixture: 'durable' }, deadlineMs = 60_000) => health.prisma.$transaction(tx => service.create(tx,
    { projectId, userId: owner, operation: 'WEB_IMPORT', contractVersion: 'test-v1', commandKey, inputManifest, deadlineMs }));
  const expiredLease = (id: string) => migration.query('UPDATE contextflow."JobAttempt" SET "leaseExpiresAt"=CURRENT_TIMESTAMP - INTERVAL \'1 second\' WHERE "jobId"=$1', [id]);

  it('replays one command, rejects changed payload, and denies foreign ancestry or missing notice', async () => {
    const key = randomUUID();
    const [first, replay] = await Promise.all([create(key), create(key)]);
    expect(replay.id).toBe(first.id);
    await expect(create(key, { fixture: 'different' })).rejects.toMatchObject({ status: 409 });
    await expect(service.get(foreign, projectId, first.id)).rejects.toMatchObject({ status: 404 });
    await expect(service.get(owner, randomUUID(), first.id)).rejects.toMatchObject({ status: 404 });
    await health.prisma.userProfile.update({ where: { id: owner }, data: { externalProcessingNoticeVersion: null, externalProcessingAcceptedAt: null } });
    await expect(create()).rejects.toMatchObject({ status: 403 });
    await health.prisma.userProfile.update({ where: { id: owner }, data: { externalProcessingNoticeVersion: '2026-09-28-v1', externalProcessingAcceptedAt: new Date() } });
    await service.cancel(owner, projectId, first.id);
  });
  it('accepts one result under concurrent duplicate delivery and reconstructs an empty Redis queue', async () => {
    const job = await create();
    await worker.dispatch();
    const queueId = job.id + '-1';
    expect(await worker.queue.getJob(queueId)).not.toBeUndefined();
    await worker.queue.obliterate({ force: true });
    expect(await worker.queue.getJob(queueId)).toBeUndefined();
    await worker.dispatch();
    const delivery = await worker.queue.getJob(queueId);
    expect(delivery?.data).toEqual({ jobId: job.id, ordinal: 1 });
    const prior = commits;
    await Promise.all([worker.process(delivery!.data), worker.process(delivery!.data)]);
    expect(commits - prior).toBe(1);
    expect((await service.get(member, projectId, job.id)).status).toBe('SUCCEEDED');
    expect(await health.prisma.jobAttempt.count({ where: { jobId: job.id } })).toBe(1);
  });
  it('fences crashed/stale workers and safely resumes only before submission', async () => {
    const job = await create();
    const first = await service.claim(job.id, 1, 'crashed');
    expect(first).not.toBeNull();
    await expiredLease(job.id);
    await service.reconcile();
    const second = await service.claim(job.id, 2, 'restart');
    expect(second).not.toBeNull();
    await expect(service.succeed(first!.job, first!.attempt, handler, {})).rejects.toThrow('fenced');
    await service.succeed(second!.job, second!.attempt, handler, { snapshotId: randomUUID() });
    expect((await service.get(owner, projectId, job.id)).status).toBe('SUCCEEDED');
  });
  it('preserves unknown outcome after submit without an ID, instead of resubmitting', async () => {
    const job = await create();
    const claim = await service.claim(job.id, 1, 'lost-after-submit');
    await service.providerIntent(claim!.job, claim!.attempt);
    await expiredLease(job.id);
    await service.reconcile();
    const stored = await service.get(owner, projectId, job.id);
    expect(stored).toMatchObject({ status: 'OUTCOME_UNKNOWN', providerOutcome: 'UNKNOWN', attemptCount: 1 });
    expect(await service.claim(job.id, 2, 'blind-retry')).toBeNull();
    await expect(service.retry(owner, projectId, job.id)).rejects.toMatchObject({ status: 409 });
  });
  it('carries a captured provider run into a continuation without a new submit', async () => {
    const job = await create();
    const claim = await service.claim(job.id, 1, 'lost-with-id');
    await service.providerIntent(claim!.job, claim!.attempt, 'captured-run');
    await expiredLease(job.id);
    await service.reconcile(['WEB_IMPORT']);
    const continuation = await service.claim(job.id, 2, 'poll-known-run');
    expect(continuation?.attempt.providerRunId).toBe('captured-run');
    expect(continuation?.attempt.providerOutcome).toBe('MAY_STILL_RUN');
    await service.succeed(continuation!.job, continuation!.attempt, handler, {});
  });
  it('limits known transient failures to three total attempts', async () => {
    const job = await create();
    for (let ordinal = 1; ordinal <= 3; ordinal++) {
      const claim = await service.claim(job.id, ordinal, 'attempt-' + ordinal);
      expect(claim).not.toBeNull();
      await service.fail(claim!.job, claim!.attempt, new JobFailure('PROVIDER_5XX', 'KNOWN_FAILED'));
    }
    expect(await service.get(owner, projectId, job.id)).toMatchObject({ status: 'FAILED', attemptCount: 3 });
    expect(await service.claim(job.id, 4, 'fourth')).toBeNull();
  });
  it('fences cancellation, deadlines and lost membership before canonical commit', async () => {
    const cancelled = await create();
    const claim = await service.claim(cancelled.id, 1, 'late');
    await service.providerIntent(claim!.job, claim!.attempt);
    await service.cancel(member, projectId, cancelled.id);
    await expect(service.succeed(claim!.job, claim!.attempt, handler, {})).rejects.toThrow('fenced');
    const short = await create(randomUUID(), { fixture: 'deadline' }, 100);
    const timed = await service.claim(short.id, 1, 'deadline');
    await service.providerIntent(timed!.job, timed!.attempt);
    await new Promise(resolve => setTimeout(resolve, 120));
    await service.reconcile();
    expect(await service.get(owner, projectId, short.id)).toMatchObject({ status: 'OUTCOME_UNKNOWN', errorCategory: 'TIMEOUT' });
    await expect(service.succeed(timed!.job, timed!.attempt, handler, {})).rejects.toThrow('fenced');
    const revoked = await create();
    const active = await service.claim(revoked.id, 1, 'membership');
    await health.prisma.workspaceMember.update({ where: { workspaceId_userId: { workspaceId, userId: owner } }, data: { leftAt: new Date() } });
    await expect(service.succeed(active!.job, active!.attempt, handler, {})).rejects.toMatchObject({ status: 403 });
    await health.prisma.workspaceMember.update({ where: { workspaceId_userId: { workspaceId, userId: owner } }, data: { leftAt: null } });
    await service.cancel(member, projectId, revoked.id);
    const archived = await create();
    await health.prisma.workspace.update({ where: { id: workspaceId }, data: { archivedAt: new Date() } });
    expect(await service.claim(archived.id, 1, 'archived')).toBeNull();
    expect(await service.get(owner, projectId, archived.id)).toMatchObject({ status: 'FAILED', errorCategory: 'ACCESS_REVOKED' });
    await health.prisma.workspace.update({ where: { id: workspaceId }, data: { archivedAt: null } });
  });
  it('enforces aggregate concurrency two and document conversion one using PostgreSQL', async () => {
    const jobs = await Promise.all([create(), create(), create()]);
    const claims = await Promise.all(jobs.map(job => service.claim(job.id, 1, 'budget')));
    expect(claims.filter(Boolean)).toHaveLength(2);
    for (const job of jobs) await service.cancel(owner, projectId, job.id);
    const documents = await Promise.all([1, 2].map(() => health.prisma.$transaction(tx => service.create(tx,
      { projectId, userId: owner, operation: 'DOCUMENT_IMPORT', contractVersion: 'test-v1', commandKey: randomUUID(), inputManifest: { fixture: 'budget' } }))));
    const heavy = await Promise.all(documents.map(job => service.claim(job.id, 1, 'document-budget')));
    expect(heavy.filter(Boolean)).toHaveLength(1);
    for (const job of documents) await service.cancel(owner, projectId, job.id);
  });
  it('rolls back canonical writes when a deadline passes inside the result transaction', async () => {
    const job = await create(randomUUID(), { fixture: 'late-transaction' }, 150);
    const claim = await service.claim(job.id, 1, 'slow-commit');
    expect(claim).not.toBeNull();
    await service.providerIntent(claim!.job, claim!.attempt);
    const assetId = randomUUID();
    const slow: JobHandler = { operation: 'WEB_IMPORT', execute: async () => ({}), commit: async tx => {
      await tx.asset.create({ data: { id: assetId, projectId, bucket: 'synthetic-private', objectKey: projectId + '/generated/' + assetId,
        mediaType: 'text/plain', bytes: 1n, sha256: '0'.repeat(64), purpose: 'GENERATED', createdBy: owner } });
      await new Promise(resolve => setTimeout(resolve, 160));
      return { assetId };
    } };
    await expect(service.succeed(claim!.job, claim!.attempt, slow, {})).rejects.toThrow('fenced');
    expect(await health.prisma.asset.count({ where: { id: assetId } })).toBe(0);
    await service.reconcile();
    expect(await service.get(owner, projectId, job.id)).toMatchObject({ status: 'OUTCOME_UNKNOWN', resultRefs: null, errorCategory: 'TIMEOUT' });
  });
  it('starts while Redis is unavailable, reconciles DB independently, and consumes after recovery', async () => {
    const target = new URL(config.redisUrl);
    let unavailable = true;
    const sockets = new Set<Socket>();
    const proxy = createServer(client => {
      sockets.add(client);
      if (unavailable) { client.on('error', () => {}); client.on('close', () => sockets.delete(client)); return; }
      const upstream = createConnection({ host: target.hostname, port: Number(target.port || '6379') });
      sockets.add(upstream);
      client.pipe(upstream); upstream.pipe(client);
      client.on('error', () => upstream.destroy()); upstream.on('error', () => client.destroy());
      client.on('close', () => { sockets.delete(client); upstream.destroy(); });
      upstream.on('close', () => { sockets.delete(upstream); client.destroy(); });
    });
    proxy.listen(0, '127.0.0.1');
    await once(proxy, 'listening');
    const address = proxy.address();
    if (!address || typeof address === 'string') throw new Error('Redis proxy must bind loopback');
    const proxyUrl = new URL(config.redisUrl); proxyUrl.hostname = '127.0.0.1'; proxyUrl.port = String(address.port);
    const runtime = new DurableJobWorker(health.prisma, proxyUrl.toString(), '2026-09-28-v1', [handler],
      { queueName: 'cf-startup-' + randomUUID(), intervalMs: 100, leaseMs: 1000 });
    const job = await create();
    try {
      const started = Date.now();
      await runtime.start();
      expect(Date.now() - started).toBeLessThan(7000);
      expect(runtime.lastReconcileAt).not.toBeNull();
      expect(runtime.lastDispatchError).toBe('QUEUE_UNAVAILABLE');
      expect((await service.get(owner, projectId, job.id)).status).toBe('QUEUED');
      unavailable = false;
      for (const socket of sockets) socket.destroy();
      const until = Date.now() + 6000;
      while (Date.now() < until && (await service.get(owner, projectId, job.id)).status !== 'SUCCEEDED') {
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      expect((await service.get(owner, projectId, job.id)).status).toBe('SUCCEEDED');
      expect(runtime.lastDispatchError).toBeNull();
      await runtime.queue.obliterate({ force: true });
    } finally {
      unavailable = false;
      for (const socket of sockets) socket.destroy();
      await runtime.close();
      await new Promise<void>(resolve => proxy.close(() => resolve()));
    }
  });
});
