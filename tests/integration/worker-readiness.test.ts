import { randomUUID } from 'node:crypto';
import { Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { DependencyHealthService, DurableJobWorker, FoundationModule, loadRuntimeConfig } from '@contextflow/backend';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { HealthController } from '../../apps/worker/src/health/health.controller.js';

const queueName = 'cf-readiness-' + randomUUID();

class WorkerReadinessFixtureModule {}

Module({
  imports: [FoundationModule],
  controllers: [HealthController],
  providers: [{
    provide: DurableJobWorker,
    inject: [DependencyHealthService],
    useFactory: (health: DependencyHealthService) => {
      const config = loadRuntimeConfig();
      const worker = new DurableJobWorker(health.prisma, config.redisUrl, 'readiness-fixture-v1', [], { queueName });
      // Nest lifecycle startup runs a global reconcile/dispatch tick; keep the shared TEST job table untouched.
      vi.spyOn(worker, 'onModuleInit').mockResolvedValue();
      return worker;
    },
  }],
})(WorkerReadinessFixtureModule);

describe('worker readiness contract', () => {
  let app: NestExpressApplication | undefined;
  let worker: DurableJobWorker | undefined;
  let baseUrl: string;

  beforeAll(async () => {
    if (process.env['NODE_ENV'] !== 'test') throw new Error('Worker readiness fixture requires NODE_ENV=test');
    app = await NestFactory.create<NestExpressApplication>(WorkerReadinessFixtureModule, { logger: false });
    await app.init();
    await app.listen(0, '127.0.0.1');
    const runtime = app.get(DurableJobWorker);
    worker = runtime;
    await runtime.queue.waitUntilReady();
    const address = app.getHttpServer().address();
    if (!address || typeof address === 'string') throw new Error('Worker readiness fixture must bind loopback');
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterAll(async () => {
    if (worker) await worker.queue.obliterate({ force: true });
    await app?.close();
  });

  it('reports dependency state before a tick and readiness after tick bookkeeping', async () => {
    const runtime = worker!;
    // The production tick scans all durable jobs. Keep this fixture read-only against shared TEST rows;
    // tests/integration/jobs.test.ts covers the real worker dispatch and recovery path.
    vi.spyOn(runtime.service, 'reconcile').mockResolvedValue();
    vi.spyOn(runtime, 'dispatch').mockResolvedValue(0);

    const before = await fetch(baseUrl + '/health/ready');
    expect(before.status).toBe(503);
    expect(await before.json()).toEqual({ status: 'not_ready', checks: { database: 'up', redis: 'up', dispatcher: 'down' } });

    await runtime.tick();

    const after = await fetch(baseUrl + '/health/ready');
    expect(after.status).toBe(200);
    expect(await after.json()).toEqual({ status: 'ready', checks: { database: 'up', redis: 'up', dispatcher: 'up' } });
  });
});
