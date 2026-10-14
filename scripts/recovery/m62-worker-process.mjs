import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { createServer as createHttpServer } from 'node:http';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const backendRequire = createRequire(resolve(root, 'packages/backend/package.json'));
const artifactDir = resolve(root, '.local-checks/m62');
const markerDir = resolve(artifactDir, 'markers');
const prefix = 'cf-m62-worker-' + randomUUID().slice(0, 8);
const pgName = prefix + '-pg';
const redisName = prefix + '-redis';
const pgPassword = randomUUID() + 'A1!';
const pgDatabase = 'contextflow_m62';
const redisTag = 'm62-' + randomUUID().replaceAll('-', '');
const operations = ['WEB_IMPORT', 'ARTICLE_GENERATION', 'VISUAL_BACKGROUND_GENERATION', 'EXPORT_BUILD', 'GOOGLE_DOCS_SYNC', 'CLAIM_EXTRACTION'];
const results = [];
const childProcesses = new Set();

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { cwd: root, encoding: 'utf8', shell: false, ...options });
  if (result.error || result.status !== 0) {
    const output = (result.stdout || '') + (result.stderr || '');
    throw new Error(`${command} ${args[0] ?? ''} failed (${result.status ?? result.error?.message ?? 'unknown'}): ${sanitize(output)}`);
  }
  return (result.stdout || '').trim();
}

function sanitize(text) {
  return text.replace(/postgres(?:ql)?:\/\/[^\s"'<>]+/giu, '[database URL redacted]')
    .replace(/redis(?:s)?:\/\/[^\s"'<>]+/giu, '[redis URL redacted]');
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}


function containerPort(name, containerPortValue) {
  const value = run('docker', ['port', name, `${containerPortValue}/tcp`]);
  const match = /:(\d+)$/u.exec(value);
  if (!match) throw new Error(`Docker did not report a published port for ${name}`);
  return Number(match[1]);
}

async function waitFor(check, description, timeoutMs = 20_000) {
  const until = Date.now() + timeoutMs;
  let last;
  while (Date.now() < until) {
    try { last = await check(); if (last) return last; } catch { /* Dependency is still starting. */ }
    await new Promise(resolveWait => setTimeout(resolveWait, 100));
  }
  throw new Error(`Timed out waiting for ${description}`);
}

async function waitMarker(name, timeoutMs = 10_000) {
  return waitFor(async () => {
    try { return await readFile(resolve(markerDir, name), 'utf8'); } catch { return null; }
  }, `worker marker ${name}`, timeoutMs);
}

function startWorker(jobId, mode, durationMs = 0) {
  const childEnv = Object.fromEntries(['PATH', 'SystemRoot', 'SYSTEMROOT', 'TEMP', 'TMP', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA']
    .filter(key => process.env[key]).map(key => [key, process.env[key]]));
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), '--child', jobId, mode, String(durationMs)], {
    cwd: root, env: { ...childEnv, CONTEXTFLOW_ENV_FILE: resolve(artifactDir, 'synthetic-empty.env'), NODE_ENV: 'development', REDIS_URL: process.env.M62_REDIS_URL,
      DATABASE_URL: process.env.M62_DATABASE_URL, DIRECT_DATABASE_URL: process.env.M62_DATABASE_URL,
      DATABASE_SSL_CA_FILE: '',
      M62_MARKER_DIR: markerDir, M62_QUEUE_NAME: redisTag, M62_SYNTHETIC_ENDPOINT: process.env.M62_SYNTHETIC_ENDPOINT },
    stdio: 'ignore', windowsHide: true,
  });
  childProcesses.add(child);
  child.once('exit', () => childProcesses.delete(child));
  return child;
}

async function stopProcess(child, force = false) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  if (force) child.kill('SIGKILL'); else child.kill('SIGTERM');
  await Promise.race([new Promise(resolveExit => child.once('exit', resolveExit)), new Promise(resolveTimeout => setTimeout(resolveTimeout, 5000))]);
  if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  childProcesses.delete(child);
}

async function record(name, detail) {
  results.push({ scenario: name, result: detail });
}

async function childMain() {
  const [{ DependencyHealthService, DurableJobWorker, loadRuntimeConfig }, { JobOperation }] = await Promise.all([
    import('../../packages/backend/dist/index.js'), import('../../packages/backend/dist/generated/prisma/enums.js'),
  ]);
  const [jobId, mode, durationText] = process.argv.slice(3);
  const durationMs = Number(durationText);
  const config = loadRuntimeConfig();
  const health = new DependencyHealthService(config);
  const queueName = process.env.M62_QUEUE_NAME;
  const markerPath = process.env.M62_MARKER_DIR;
  const writeMarker = async (name, value = 'ready') => writeFile(resolve(markerPath, `${jobId}-${name}`), value, { mode: 0o600 });
  const hold = () => new Promise(() => {});
  const realFetch = globalThis.fetch;
  globalThis.fetch = (input, init) => {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input.toString() : input.url);
    if (url.origin !== process.env.M62_SYNTHETIC_ENDPOINT || url.hostname !== '127.0.0.1') {
      return Promise.reject(new Error('External network calls are disabled in this synthetic recovery drill'));
    }
    return realFetch(input, init);
  };
  const handlers = operations.map(operation => ({
    operation: JobOperation[operation],
    async execute(context) {
      const target = context.job.id === jobId;
      if (!target) return { accepted: true, operation };
      if (mode === 'before-submit') { await writeMarker('before-submit'); return hold(); }
      await context.recordSubmissionIntent();
      const submitReply = await fetch(`${process.env.M62_SYNTHETIC_ENDPOINT}/submit`, { method: 'POST',
        headers: { 'content-type': 'application/json', 'x-job-id': context.job.id }, body: JSON.stringify({ operation }) });
      if (!submitReply.ok) throw new Error('Synthetic endpoint rejected the local test submission');
      const syntheticRunId = (await submitReply.json()).id;
      if (mode === 'unknown-after-intent') { await writeMarker('after-intent'); return hold(); }
      if (mode === 'captured-run') {
        await context.recordProviderRun(syntheticRunId);
        await writeMarker('captured-id');
        return hold();
      }
      if (mode === 'cancel-fence') { await writeMarker('cancel-ready'); return hold(); }
      if (mode === 'deadline-fence') { await writeMarker('deadline-ready'); return hold(); }
      return { accepted: true, operation, jobId };
    },
    async resume(context, providerRunId) {
      if (context.job.id !== jobId || mode !== 'restart-captured') return { accepted: true, operation, resumed: true };
      const resumed = await fetch(`${process.env.M62_SYNTHETIC_ENDPOINT}/runs/${encodeURIComponent(providerRunId)}`);
      if (!resumed.ok) throw new Error('Synthetic endpoint could not reconcile captured run');
      await writeMarker('resumed', providerRunId);
      return { accepted: true, operation, resumed: true, providerRunId };
    },
    async commit(_tx, result) { return { synthetic: true, operation, ...result }; },
    async completed(context, result) {
      if (context.job.id === jobId && mode === 'commit-crash') { await writeMarker('after-commit', JSON.stringify(result)); await hold(); }
    },
  }));
  const worker = new DurableJobWorker(health.prisma, config.redisUrl, '2026-09-28-v1', handlers,
    { queueName, intervalMs: 60, leaseMs: 900, retryBaseMs: 0 });
  const onSignal = () => { void worker.close().finally(() => health.onModuleDestroy()).finally(() => process.exit(0)); };
  process.once('SIGTERM', onSignal);
  process.once('SIGINT', onSignal);
  await worker.start();
  if (mode === 'drain') await new Promise(resolveTimer => setTimeout(resolveTimer, durationMs));
  if (mode === 'restart-captured' || mode === 'restart-safe') {
    await waitFor(async () => {
      const job = await health.prisma.job.findUnique({ where: { id: jobId }, select: { status: true } });
      return job?.status === 'SUCCEEDED' || job?.status === 'OUTCOME_UNKNOWN' || job?.status === 'FAILED';
    }, 'recovered job terminal state', 15_000);
  }
  if (mode === 'restart-captured' || mode === 'restart-safe' || mode === 'drain') {
    await worker.close(); await health.onModuleDestroy(); process.exit(0);
  }
  await new Promise(() => {});
}

async function orchestrate() {
  await mkdir(markerDir, { recursive: true });
  await writeFile(resolve(artifactDir, 'synthetic-empty.env'), '# Synthetic worker: no provider credentials\n', { mode: 0o600 });
  await rm(markerDir, { recursive: true, force: true });
  await mkdir(markerDir, { recursive: true });
  run('docker', ['pull', 'postgres:17.11-alpine@sha256:b0f9560a2de083e2cc7382e75f808c7381a32852a7ec49117deedb300e552b24']);
  run('docker', ['pull', 'redis:7.4.11-alpine@sha256:858f009f9709ce576febc734aa78b8f6d624b82571f9ddb6bda4377c833b3499']);
  run('docker', ['run', '-d', '--name', pgName, '-e', `POSTGRES_PASSWORD=${pgPassword}`, '-e', `POSTGRES_DB=${pgDatabase}`,
    '-p', '127.0.0.1::5432', 'postgres:17.11-alpine@sha256:b0f9560a2de083e2cc7382e75f808c7381a32852a7ec49117deedb300e552b24']);
  let redisStarted = false;
  let api;
  let syntheticServer;
  try {
    const postgresPort = containerPort(pgName, 5432);
    const postgresUrl = `postgresql://postgres:${encodeURIComponent(pgPassword)}@127.0.0.1:${postgresPort}/${pgDatabase}?schema=contextflow`;
    await waitFor(() => {
      const probe = spawnSync('docker', ['exec', pgName, 'psql', '-h', '127.0.0.1', '-U', 'postgres', '-d', pgDatabase, '-tAc', 'SELECT 1'], { encoding: 'utf8' });
      return probe.status === 0;
    }, 'disposable PostgreSQL readiness');
    run('docker', ['exec', pgName, 'psql', '-U', 'postgres', '-d', pgDatabase, '-v', 'ON_ERROR_STOP=1', '-c', 'CREATE ROLE cf_runtime NOLOGIN;']);
    run('docker', ['run', '-d', '--name', redisName, '--network', 'bridge', '-p', '127.0.0.1::6379',
      'redis:7.4.11-alpine@sha256:858f009f9709ce576febc734aa78b8f6d624b82571f9ddb6bda4377c833b3499', 'redis-server', '--save', '', '--appendonly', 'no']);
    redisStarted = true;
    const redisPort = containerPort(redisName, 6379);
    let redisUrl = `redis://127.0.0.1:${redisPort}/0`;
    const replaceRedis = () => {
      if (redisStarted) { run('docker', ['rm', '-f', redisName]); redisStarted = false; }
      run('docker', ['run', '-d', '--name', redisName, '-p', '127.0.0.1::6379',
        'redis:7.4.11-alpine@sha256:858f009f9709ce576febc734aa78b8f6d624b82571f9ddb6bda4377c833b3499', 'redis-server', '--save', '', '--appendonly', 'no']);
      redisStarted = true;
      redisUrl = `redis://127.0.0.1:${containerPort(redisName, 6379)}/0`;
      process.env.M62_REDIS_URL = redisUrl; process.env.REDIS_URL = redisUrl;
      return redisUrl;
    };
    process.env.M62_DATABASE_URL = postgresUrl;
    process.env.M62_REDIS_URL = redisUrl;
    process.env.DATABASE_URL = postgresUrl;
    process.env.DIRECT_DATABASE_URL = postgresUrl;
    process.env.REDIS_URL = redisUrl;
    process.env.NODE_ENV = 'development';
    process.env.DATABASE_SSL_CA_FILE = '';
    run(process.execPath, ['node_modules/prisma/build/index.js', 'migrate', 'deploy', '--config', 'prisma7.config.ts'], { env: process.env });
    const backend = await import('../../packages/backend/dist/index.js');
    const { JobOperation } = await import('../../packages/backend/dist/generated/prisma/enums.js');
    const config = backend.loadRuntimeConfig();
    api = new backend.DependencyHealthService(config);
    const syntheticSubmissions = new Map();
    const syntheticPolls = new Map();
    syntheticServer = createHttpServer((request, response) => {
      const jobId = request.headers['x-job-id'];
      const parts = [];
      request.on('data', part => parts.push(part));
      request.on('end', () => {
        if (request.method === 'POST' && request.url === '/submit' && typeof jobId === 'string') {
          syntheticSubmissions.set(jobId, (syntheticSubmissions.get(jobId) ?? 0) + 1);
          response.writeHead(202, { 'content-type': 'application/json' });
          response.end(JSON.stringify({ id: `synthetic-${jobId}` }));
          return;
        }
        if (request.method === 'GET' && typeof request.url === 'string' && request.url.startsWith('/runs/')) {
          const id = decodeURIComponent(request.url.slice('/runs/'.length));
          syntheticPolls.set(id, (syntheticPolls.get(id) ?? 0) + 1);
          response.writeHead(200, { 'content-type': 'application/json' }); response.end('{"status":"succeeded"}'); return;
        }
        response.writeHead(404); response.end();
      });
    });
    await new Promise((resolveListen, rejectListen) => syntheticServer.listen(0, '127.0.0.1', resolveListen).once('error', rejectListen));
    const syntheticAddress = syntheticServer.address();
    if (!syntheticAddress || typeof syntheticAddress === 'string') throw new Error('Synthetic local provider did not bind a port');
    process.env.M62_SYNTHETIC_ENDPOINT = `http://127.0.0.1:${syntheticAddress.port}`;
    const owner = randomUUID(); const workspaceId = randomUUID(); const projectId = randomUUID();
    await api.prisma.userProfile.create({ data: { id: owner, externalProcessingNoticeVersion: '2026-09-28-v1', externalProcessingAcceptedAt: new Date() } });
    await api.prisma.workspace.create({ data: { id: workspaceId, name: 'Synthetic recovery drill', ownerId: owner, members: { create: { userId: owner } } } });
    await api.prisma.project.create({ data: { id: projectId, workspaceId, createdBy: owner, topic: 'M6.2 process recovery', formats: ['TELEGRAM_POST'] } });
    const service = new backend.DurableJobService(api.prisma, { noticeVersion: '2026-09-28-v1', leaseMs: 900, retryBaseMs: 0 });
    const create = (operation, deadlineMs = 60_000) => api.prisma.$transaction(tx => service.create(tx, {
      projectId, userId: owner, operation: JobOperation[operation], contractVersion: 'm62-synthetic-v1', commandKey: randomUUID(),
      inputManifest: { source: 'synthetic recovery fixture', operation }, deadlineMs,
    }));
    const startAndCrash = async (job, mode, marker) => {
      const process = startWorker(job.id, mode);
      await waitMarker(`${job.id}-${marker}`);
      await stopProcess(process, true);
      return process;
    };
    const startRestart = async (job, mode) => {
      const process = startWorker(job.id, mode);
      await waitFor(async () => (await service.get(owner, projectId, job.id)).status !== 'RUNNING'
        && (await service.get(owner, projectId, job.id)).status !== 'QUEUED', `job ${job.id} restart completion`);
      await stopProcess(process);
      return process;
    };

    const importJob = await create('WEB_IMPORT');
    await startAndCrash(importJob, 'before-submit', 'before-submit');
    replaceRedis();
    await waitFor(async () => {
      await service.reconcile();
      return (await service.get(owner, projectId, importJob.id)).attemptCount === 1;
    }, 'unsubmitted lease reconciliation');
    await startRestart(importJob, 'restart-safe');
    let state = await service.get(owner, projectId, importJob.id);
    assert(state.status === 'SUCCEEDED' && state.attemptCount === 2, 'Import did not safely resume after a pre-submit process death');
    await record('import-before-submit-restart', { status: state.status, attempts: state.attemptCount, providerOutcome: state.providerOutcome });
    assert((syntheticSubmissions.get(importJob.id) ?? 0) === 1, 'Import safe restart did not produce exactly one local synthetic submission');

    const textJob = await create('ARTICLE_GENERATION');
    await startAndCrash(textJob, 'unknown-after-intent', 'after-intent');
    replaceRedis();
    await waitFor(async () => {
      await service.reconcile();
      return (await service.get(owner, projectId, textJob.id)).status === 'OUTCOME_UNKNOWN';
    }, 'unknown text-generation result');
    const textBefore = await service.get(owner, projectId, textJob.id);
    const textRestart = startWorker(textJob.id, 'restart-safe');
    await new Promise(resolveDelay => setTimeout(resolveDelay, 1300));
    await stopProcess(textRestart);
    state = await service.get(owner, projectId, textJob.id);
    assert(state.status === 'OUTCOME_UNKNOWN' && state.attemptCount === textBefore.attemptCount, 'Unknown text result was resubmitted');
    assert((syntheticSubmissions.get(textJob.id) ?? 0) === 1, 'Unknown text outcome caused a duplicate local synthetic submission');
    await record('text-unknown-no-resubmit', { status: state.status, attempts: state.attemptCount, providerOutcome: state.providerOutcome });

    const imageJob = await create('VISUAL_BACKGROUND_GENERATION');
    await startAndCrash(imageJob, 'unknown-after-intent', 'after-intent');
    replaceRedis();
    await waitFor(async () => {
      await service.reconcile();
      return (await service.get(owner, projectId, imageJob.id)).status === 'OUTCOME_UNKNOWN';
    }, 'unknown image-generation result');
    const imageWorker = startWorker(imageJob.id, 'drain', 1200);
    await new Promise(resolveDelay => setTimeout(resolveDelay, 1400));
    await stopProcess(imageWorker);
    state = await service.get(owner, projectId, imageJob.id);
    assert(state.status === 'OUTCOME_UNKNOWN' && state.attemptCount === 1 && (syntheticSubmissions.get(imageJob.id) ?? 0) === 1,
      'Unknown image outcome was resubmitted after a process and Redis restart');
    await record('image-unknown-no-resubmit', { status: state.status, attemptCount: state.attemptCount, providerOutcome: state.providerOutcome });

    const exportJob = await create('EXPORT_BUILD');
    const exportWorker = startWorker(exportJob.id, 'commit-crash');
    await waitMarker(`${exportJob.id}-after-commit`);
    await stopProcess(exportWorker, true);
    state = await service.get(owner, projectId, exportJob.id);
    assert(state.status === 'SUCCEEDED' && state.attemptCount === 1, 'Export canonical commit was not durable before process death');
    const newRedisUrl = replaceRedis();
    const { Queue } = backendRequire('bullmq');
    const { Redis } = backendRequire('ioredis');
    const redis = new Redis(newRedisUrl); const queue = new Queue(redisTag, { connection: redis });
    await queue.waitUntilReady();
    await queue.add('duplicate-after-commit', { jobId: exportJob.id, ordinal: 1 }, { jobId: `${exportJob.id}-1` });
    const duplicateWorker = startWorker(exportJob.id, 'drain', 1500);
    await new Promise(resolveDelay => setTimeout(resolveDelay, 1800));
    await stopProcess(duplicateWorker);
    state = await service.get(owner, projectId, exportJob.id);
    assert(state.status === 'SUCCEEDED' && state.attemptCount === 1, 'Redis reconstruction or duplicate delivery duplicated an accepted export result');
    await queue.close(); redis.disconnect();
    await record('export-commit-redis-loss-duplicate', { status: state.status, attempts: state.attemptCount, canonicalResult: state.resultRefs });

    const reconstructed = await create('WEB_IMPORT');
    replaceRedis();
    const reconstructedWorker = startWorker(reconstructed.id, 'restart-safe');
    await waitFor(async () => (await service.get(owner, projectId, reconstructed.id)).status === 'SUCCEEDED', 'DB queued intent after Redis loss');
    await stopProcess(reconstructedWorker);
    const reconstructedState = await service.get(owner, projectId, reconstructed.id);
    assert(reconstructedState.attemptCount === 1 && (syntheticSubmissions.get(reconstructed.id) ?? 0) === 1, 'Queued intent was lost or duplicated with Redis');
    await record('queued-intent-reconstructed-after-redis-loss', { status: reconstructedState.status, attempts: reconstructedState.attemptCount });

    const googleJob = await create('GOOGLE_DOCS_SYNC');
    await startAndCrash(googleJob, 'captured-run', 'captured-id');
    replaceRedis();
    await waitFor(async () => {
      await service.reconcile([JobOperation.GOOGLE_DOCS_SYNC]);
      const recovered = await service.get(owner, projectId, googleJob.id);
      return recovered.status === 'QUEUED' && recovered.providerOutcome === 'MAY_STILL_RUN';
    }, 'captured Google run reconciliation');
    const googleWorker = startWorker(googleJob.id, 'restart-captured');
    const resumedId = await waitMarker(`${googleJob.id}-resumed`);
    await waitFor(async () => (await service.get(owner, projectId, googleJob.id)).status === 'SUCCEEDED', 'Google write continuation completion');
    await stopProcess(googleWorker);
    state = await service.get(owner, projectId, googleJob.id);
    assert(resumedId === `synthetic-${googleJob.id}` && state.status === 'SUCCEEDED' && state.attemptCount === 2,
      'Google reconciliation did not resume the captured synthetic run');
    assert((syntheticSubmissions.get(googleJob.id) ?? 0) === 1 && (syntheticPolls.get(resumedId) ?? 0) === 1,
      'Google reconciliation resubmitted instead of polling the captured local synthetic run');
    await record('google-write-captured-run-reconciliation', { status: state.status, attempts: state.attemptCount, resumedProviderRunId: resumedId });

    const cancelJob = await create('GOOGLE_DOCS_SYNC');
    await startAndCrash(cancelJob, 'cancel-fence', 'cancel-ready');
    await service.cancel(owner, projectId, cancelJob.id);
    replaceRedis();
    const cancelRestart = startWorker(cancelJob.id, 'drain', 1200);
    await new Promise(resolveDelay => setTimeout(resolveDelay, 1400));
    await stopProcess(cancelRestart);
    state = await service.get(owner, projectId, cancelJob.id);
    assert(state.status === 'CANCELLED' && state.cancelRequestedAt, 'Persistent cancellation fence did not survive worker restart');
    await record('persisted-cancel-fence', { status: state.status, cancelRequestedAt: state.cancelRequestedAt.toISOString(), providerOutcome: state.providerOutcome });

    const deadlineJob = await create('CLAIM_EXTRACTION', 8000);
    const deadlineWorker = startWorker(deadlineJob.id, 'deadline-fence');
    await waitMarker(`${deadlineJob.id}-deadline-ready`);
    await waitFor(async () => (await service.get(owner, projectId, deadlineJob.id)).status === 'OUTCOME_UNKNOWN', 'persisted provider deadline fence', 8000);
    await stopProcess(deadlineWorker, true);
    replaceRedis();
    state = await service.get(owner, projectId, deadlineJob.id);
    assert(state.status === 'OUTCOME_UNKNOWN' && state.errorCategory === 'TIMEOUT', 'Deadline did not preserve the unknown provider outcome');
    const fenceRestart = startWorker(deadlineJob.id, 'drain', 1400);
    await new Promise(resolveDelay => setTimeout(resolveDelay, 1500));
    await stopProcess(fenceRestart);
    state = await service.get(owner, projectId, deadlineJob.id);
    assert(state.status === 'OUTCOME_UNKNOWN' && state.attemptCount === 1, 'Persisted deadline fence allowed a late resubmission');
    await record('persisted-deadline-fence', { status: state.status, errorCategory: state.errorCategory, attempts: state.attemptCount });

    const rows = await api.prisma.job.findMany({ where: { projectId }, select: { operation: true, status: true } });
    assert(operations.slice(0, 5).every(operation => rows.some(row => row.operation === JobOperation[operation])), 'Operation coverage fixture was incomplete');
    const receipt = { date: new Date().toISOString(), isolation: { postgresContainer: pgName, postgresDatabase: pgDatabase,
      redisContainer: redisName, queueName: redisTag, externalCalls: 'loopback synthetic endpoint only' },
      scenarios: results, coverage: { operations: [...new Set(rows.map(row => row.operation))], workerProcessesKilled: true,
        redisReplacedWithEmptyContainer: true, providerLiveCoverage: false } };
    await writeFile(resolve(artifactDir, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n', { mode: 0o600 });
    console.log(JSON.stringify({ receipt: resolve(artifactDir, 'receipt.json'), scenarios: results.length,
      operationCount: receipt.coverage.operations.length, redisReplaced: true, providerLiveCoverage: false }, null, 2));
  } finally {
    await Promise.all([...childProcesses].map(child => stopProcess(child, true).catch(() => {})));
    if (syntheticServer) await new Promise(resolveClose => syntheticServer.close(resolveClose));
    if (api) await api.onModuleDestroy();
    if (redisStarted) { try { run('docker', ['rm', '-f', redisName]); } catch { /* Already removed. */ } }
    try { run('docker', ['rm', '-f', pgName]); } catch { /* Container may not have been created. */ }
  }
}

if (process.argv[2] === '--child') await childMain();
else await orchestrate();
