import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Pool } from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { AppModule } from '../../apps/api/src/app.module.js';
import { loadAuthConfig } from '../../apps/api/src/auth/auth-config.js';
import { AuthProvider } from '../../apps/api/src/auth/auth-provider.js';
import { CSRF_COOKIE, SESSION_COOKIE } from '../../apps/api/src/auth/csrf.js';
import { EXTERNAL_PROCESSING_NOTICE } from '../../apps/api/src/auth/external-processing.js';
import { SessionService } from '../../apps/api/src/auth/session-service.js';
import { createSourceEvidenceJobHandlers, DependencyHealthService, DurableJobService, DurableJobWorker,
  embeddingRequestHash, loadRuntimeConfig, SourceEvidenceService, validateEmbeddingOutput,
  ArticleService, TelegramService, ScriptService, VisualService, VisualRenderer, ExportService, PrivateAssetStore, createExportJobHandler, SourceArticlePreparationService, EditorialService, FactualBasisService, SourcePreparationService, createSourceWritingJobHandler } from '@contextflow/backend';
import { canonicalManifestHash } from '../../packages/backend/src/jobs/job-service.js';
import type { Prisma } from '../../packages/backend/src/generated/prisma/client.js';
import type { SourceWritingInput } from '../../packages/backend/src/evidence/writing-contracts.js';
import { relevanceInputHash, type RelevanceInput, type RelevanceOutput } from '../../packages/backend/src/evidence/relevance-contracts.js';

type Identity = { id: string; cookie: string };
type Reply<T> = { response: Response; body: T };
type Snapshot = { id: string; sha256: string; normalizedText: string; fragments: Array<{ id: string; startOffset: number; endOffset: number }> };
type Material = { id: string; revision: number; currentSnapshotId: string };
type VectorRequest = { schemaVersion: 'source-embedding-request-v1'; requestId: string; task: 'DOCUMENT' | 'QUERY'; texts: Array<{ id: string; sha256: string; text: string }> };
const sha256 = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');
const WORKFLOW_ID = 'c5fab1a0-4d7a-4b18-b759-23614f219b71';
const WORKFLOW_DIGEST = 'd6b74609adb0e83fdb04110ee14976eadec2c033964289b9190822fe5763973c';
const VECTOR_DIMENSIONS = 768;
const RELEVANCE_WORKFLOW_RELEASE = JSON.parse(readFileSync(new URL('../../packages/backend/src/evidence/workflows/source-relevance/release.json', import.meta.url), 'utf8')) as { configDigest: string };

function syntheticVector(text: string): number[] {
  const values = Array<number>(VECTOR_DIMENSIONS).fill(0);
  // Stable orthogonal topics let the integration test prove semantic retrieval
  // without calling Google or any external workflow.
  values[/database|transaction|база даних/iu.test(text) ? 0 : 1] = 1;
  return values;
}

describe('source evidence indexing and exact passage retrieval', () => {
  const runtime = loadRuntimeConfig();
  const authConfig = loadAuthConfig();
  const health = new DependencyHealthService(runtime);
  const auth = new AuthProvider(authConfig);
  const sessions = new SessionService(health.prisma, auth, authConfig);
  const sql = new Pool({ connectionString: runtime.directDatabaseUrl, ssl: false, max: 2 });
  const identities: Identity[] = [];
  const projectIds: string[] = [];
  let app!: NestExpressApplication;
  let baseUrl = '';
  let owner!: Identity;
  let member!: Identity;
  let outsider!: Identity;
  let projectId = '';
  let denseProjectId = '';
  let workspaceId = '';
  let currentSnapshot!: Snapshot;
  let jobs!: DurableJobService;
  let evidence!: SourceEvidenceService;
  let worker!: DurableJobWorker;
  let lastWorkerFailure: unknown;
  const embeddingCalls: VectorRequest[] = [];
  const relevanceCalls: RelevanceInput[] = [];
  let relevanceMode: 'all' | 'first-only' | 'empty' | 'missing-decision' = 'all';
  const relevanceExecuteRuns: string[] = [];
  const relevanceResumeRuns: string[] = [];
  let nextDocumentHold: { started: () => void; wait: Promise<void> } | undefined;
  let nextRelevanceHold: { started: () => void; wait: Promise<void> } | undefined;
  const env = {
    NODE_ENV: 'test', DIFY_API_BASE_URL: 'https://dify.example.test/v1', DIFY_SOURCE_EMBEDDING_PUBLISHED_WORKFLOW_ID: WORKFLOW_ID,
    DIFY_SOURCE_EMBEDDING_CONFIG_SHA256: WORKFLOW_DIGEST, DIFY_SOURCE_EMBEDDING_API_KEY: 'synthetic-source-evidence-key',
    DIFY_SOURCE_RELEVANCE_PUBLISHED_WORKFLOW_ID: 'c48c06c4-4861-45b4-b0e4-67a6e06e6e1f',
    DIFY_SOURCE_RELEVANCE_CONFIG_SHA256: RELEVANCE_WORKFLOW_RELEASE.configDigest,
    DIFY_SOURCE_RELEVANCE_API_KEY: 'synthetic-source-relevance-key',
  };

  const provider = {
    async execute(_settings: unknown, _jobId: string, request: VectorRequest, _signal: AbortSignal,
      onIntent: () => Promise<void>, onRun: (id: string) => Promise<void>) {
      await onIntent();
      const runId = randomUUID();
      await onRun(runId);
      embeddingCalls.push(request);
      if (request.task === 'DOCUMENT' && nextDocumentHold) {
        const held = nextDocumentHold;
        nextDocumentHold = undefined;
        held.started();
        await held.wait;
      }
      return { workflowRunId: runId, output: embeddingOutput(request), model: 'synthetic-test-model' };
    },
    async resume(_settings: unknown, runId: string, request: VectorRequest) {
      embeddingCalls.push(request);
      return { workflowRunId: runId, output: embeddingOutput(request), model: 'synthetic-test-model' };
    },
  };

  function embeddingOutput(request: VectorRequest) {
    return { schemaVersion: 'source-embedding-v1' as const, requestId: request.requestId, requestHash: embeddingRequestHash(request as never),
      model: 'gemini-embedding-001' as const, dimensions: 768 as const, task: request.task,
      embeddings: request.texts.map(text => ({ id: text.id, sha256: text.sha256, values: syntheticVector(text.text) })) };
  }

  const relevanceProvider = {
    async execute(_settings: unknown, _jobId: string, request: RelevanceInput, _signal: AbortSignal,
      onIntent: () => Promise<void>, onRun: (id: string) => Promise<void>) {
      await onIntent();
      const runId = randomUUID();
      await onRun(runId);
      relevanceExecuteRuns.push(runId);
      relevanceCalls.push(request);
      if (nextRelevanceHold) {
        const held = nextRelevanceHold;
        nextRelevanceHold = undefined;
        held.started();
        await held.wait;
      }
      const useful = relevanceMode === 'all' ? request.candidates
        : relevanceMode === 'first-only' ? request.candidates.slice(0, 1) : [];
      const output: RelevanceOutput = { schemaVersion: 'source-relevance-v1', requestId: request.requestId,
        requestHash: relevanceInputHash(request), decisions: request.candidates.map(candidate => ({ id: candidate.id,
          sha256: candidate.sha256, relevance: useful.some(row => row.id === candidate.id) ? 'DIRECT' : 'IRRELEVANT',
          reason: useful.some(row => row.id === candidate.id) ? 'ANSWERS' : 'NO_QUERY_SUPPORT' })), rankedIds: useful.map(row => row.id) };
      if (relevanceMode === 'missing-decision') output.decisions.pop();
      return { workflowRunId: runId, output, model: 'synthetic-test-relevance-model' };
    },
    async resume(_settings: unknown, runId: string, request: RelevanceInput) {
      relevanceResumeRuns.push(runId);
      relevanceCalls.push(request);
      const useful = request.candidates;
      const output: RelevanceOutput = { schemaVersion: 'source-relevance-v1', requestId: request.requestId,
        requestHash: relevanceInputHash(request), decisions: request.candidates.map(candidate => ({ id: candidate.id, sha256: candidate.sha256,
          relevance: 'DIRECT', reason: 'ANSWERS' })), rankedIds: useful.map(row => row.id) };
      return { workflowRunId: runId, output, model: 'synthetic-test-relevance-model' };
    },
  };

  async function identity(label: string): Promise<Identity> {
    const email = `cf-evidence-${randomUUID()}@example.test`;
    const session = await auth.register(email, randomBytes(24).toString('base64url'), label);
    if (!session) throw new Error('TEST identity provider did not create the synthetic account');
    const local = await sessions.create(session, label);
    const user = { id: session.identity.id, cookie: local.cookie };
    identities.push(user);
    return user;
  }

  async function csrf(user: Identity) {
    const response = await fetch(baseUrl + '/api/auth/session', { headers: { Cookie: `${SESSION_COOKIE}=${user.cookie}` } });
    if (!response.ok) throw new Error('Could not create CSRF token for synthetic identity');
    const body = await response.json() as { csrfToken: string };
    const cookie = response.headers.getSetCookie().find(value => value.startsWith(CSRF_COOKIE + '='))?.split(';', 1)[0];
    if (!cookie) throw new Error('Session response omitted the CSRF cookie');
    return { token: body.csrfToken, cookie };
  }

  async function request<T = unknown>(user: Identity | undefined, method: string, path: string, body?: unknown): Promise<Reply<T>> {
    const headers = new Headers();
    if (user) headers.set('Cookie', `${SESSION_COOKIE}=${user.cookie}`);
    let requestBody: BodyInit | undefined;
    if (body !== undefined) { headers.set('Content-Type', 'application/json'); requestBody = JSON.stringify(body); }
    if (method !== 'GET') {
      if (!user) throw new Error('Mutation needs a synthetic authenticated user');
      const protection = await csrf(user);
      headers.set('Cookie', `${SESSION_COOKIE}=${user.cookie}; ${protection.cookie}`);
      headers.set('x-csrf-token', protection.token);
      headers.set('Origin', authConfig.webOrigin);
    }
    const response = await fetch(baseUrl + path, { method, headers, ...(requestBody ? { body: requestBody } : {}) });
    return { response, body: await response.json().catch(() => ({})) as T };
  }

  async function addSource(user: Identity, label: string, text: string, targetProjectId = projectId): Promise<{ material: Material; snapshot: Snapshot }> {
    const result = await request<{ material: Material; snapshot: Snapshot }>(user, 'POST', `/api/v1/projects/${targetProjectId}/materials`,
      { label, purpose: 'FACTUAL_SOURCE', text });
    expect(result.response.status, JSON.stringify(result.body)).toBe(201);
    return result.body;
  }

  async function processParent(jobId: string) { await worker.process({ jobId, ordinal: 1 }); }
  async function processJob(jobId: string) {
    await processParent(jobId);
    const parent = await health.prisma.job.findUniqueOrThrow({ where: { id: jobId }, select: { status: true, errorCategory: true, resultRefs: true } });
    if (parent.status !== 'SUCCEEDED') {
      const executions = await health.prisma.aIExecution.findMany({ where: { jobId }, select: { status: true, errorCategory: true, providerRunId: true } });
      const failure = lastWorkerFailure as { name?: unknown; code?: unknown; category?: unknown; message?: unknown } | undefined;
      throw new Error(`Synthetic evidence parent ended ${parent.status}/${parent.errorCategory ?? 'none'} executions=${JSON.stringify(executions)} failure=${JSON.stringify({
        name: failure?.name ?? null, code: failure?.code ?? null, category: failure?.category ?? null,
        message: typeof failure?.message === 'string' ? failure.message.replace(/[0-9a-f-]{36}/giu, '[uuid]')
          .replace(/'[^']*'/gu, "'[redacted]'").slice(0, 400) : null })}`);
    }
    const childId = (parent.resultRefs as { relevanceJobId?: string } | null)?.relevanceJobId;
    if (childId) {
      await worker.process({ jobId: childId, ordinal: 1 });
      const child = await health.prisma.job.findUniqueOrThrow({ where: { id: childId },
        select: { status: true, errorCategory: true, providerOutcome: true } });
      if (child.status !== 'SUCCEEDED') throw new Error(`Synthetic evidence relevance ended ${child.status}/${child.errorCategory ?? 'none'}/${child.providerOutcome}`);
    }
  }

  afterEach(() => { relevanceMode = 'all'; });

  beforeAll(async () => {
    expect((await health.check()).status).toBe('ready');
    app = await NestFactory.create<NestExpressApplication>(AppModule, { logger: false });
    app.useBodyParser('json', { limit: '1mb' });
    await app.init();
    await app.listen(0, '127.0.0.1');
    const address = app.getHttpServer().address();
    if (!address || typeof address === 'string') throw new Error('API failed to bind a loopback port');
    baseUrl = `http://127.0.0.1:${address.port}`;

    owner = await identity('Evidence test owner');
    member = await identity('Evidence test member');
    outsider = await identity('Evidence test outsider');
    const workspace = await health.prisma.workspace.create({ data: { name: 'Synthetic evidence workspace', ownerId: owner.id,
      members: { create: [{ userId: owner.id }, { userId: member.id }] }, styles: { create: { revision: 1, createdBy: owner.id } } } });
    workspaceId = workspace.id;
    const project = await health.prisma.project.create({ data: { workspaceId, createdBy: owner.id,
      topic: 'Synthetic source evidence integration', formats: ['TELEGRAM_POST'] } });
    projectId = project.id;
    projectIds.push(projectId);
    const otherProject = await health.prisma.project.create({ data: { workspaceId, createdBy: owner.id,
      topic: 'Second synthetic evidence project', formats: ['TELEGRAM_POST'] } });
    projectIds.push(otherProject.id);
    for (const user of [owner, member]) {
      const accepted = await request(user, 'POST', '/api/auth/external-processing', { noticeVersion: EXTERNAL_PROCESSING_NOTICE.version });
      expect(accepted.response.status).toBe(201);
    }
    const first = await addSource(owner, 'Database requirements', 'Система виконує database transaction атомарно. 😀');
    currentSnapshot = first.snapshot;
    await addSource(owner, 'Access requirements', 'Керування правами визначає доступ користувачів до проєкту.');
    await addSource(owner, 'Private project source', 'Інше джерело з окремим контекстом.', otherProject.id);

    jobs = new DurableJobService(health.prisma, { noticeVersion: EXTERNAL_PROCESSING_NOTICE.version });
    evidence = new SourceEvidenceService(health.prisma, jobs, env);
    worker = new DurableJobWorker(health.prisma, runtime.redisUrl, EXTERNAL_PROCESSING_NOTICE.version,
      createSourceEvidenceJobHandlers({ prisma: health.prisma, evidence, provider, relevanceProvider, env }),
      { queueName: `cf-source-evidence-${randomUUID()}` });
    const originalFail = worker.service.fail.bind(worker.service);
    worker.service.fail = async (job, attempt, error) => { lastWorkerFailure = error; await originalFail(job, attempt, error); };
    await worker.queue.waitUntilReady();
  });

  afterAll(async () => {
    await worker?.close();
    // Purge only projects created by this test through the production scoped
    // purge function. This exercises its explicit source-evidence allowlist and
    // keeps immutable-row triggers enabled.
    for (const id of projectIds) {
      const project = await health.prisma.project.findUnique({ where: { id }, select: { revision: true, workspace: { select: { ownerId: true } } } });
      if (!project) continue;
      const old = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000);
      await health.prisma.project.update({ where: { id }, data: { trashedAt: old, purgeAfter: new Date(old.getTime() + 30 * 24 * 60 * 60 * 1000) } });
      await health.prisma.$queryRaw`SELECT contextflow.purge_project_graph(${id}::uuid,${project.workspace.ownerId}::uuid,${project.revision})`;
    }
    if (workspaceId) {
      const detached = await health.prisma.privateObjectDeletion.findMany({ where: { workspaceId } });
      const assets = new PrivateAssetStore();
      for (const item of detached) {
        await assets.remove(item.bucket,item.objectKey);
        if (item.state !== 'DELETED') await health.prisma.privateObjectDeletion.update({ where: { id: item.id },data: { state: 'DELETED',deletedAt: new Date() } });
      }
      await sql.query('DELETE FROM contextflow."PrivateObjectDeletion" WHERE "workspaceId"=$1 AND "state"=\'DELETED\'',[workspaceId]);
      await health.prisma.workspaceStyleRevision.deleteMany({ where: { workspaceId } });
      await health.prisma.workspaceMember.deleteMany({ where: { workspaceId } });
      await health.prisma.workspace.delete({ where: { id: workspaceId } });
    }
    const userIds = identities.map(user => user.id);
    if (userIds.length) {
      await health.prisma.appSession.deleteMany({ where: { userId: { in: userIds } } });
      await health.prisma.userProfile.deleteMany({ where: { id: { in: userIds } } });
      for (const id of userIds) {
        const secret = process.env['TEST_SUPABASE_SECRET_KEY'] ?? '';
        const response = await fetch(authConfig.providerUrl + '/auth/v1/admin/users/' + id, {
          method: 'DELETE', headers: { apikey: secret, Authorization: `Bearer ${secret}` },
        });
        if (!response.ok) throw new Error('Synthetic TEST Auth cleanup failed');
      }
    }
    await app?.close();
    await sql.end();
    await health.onModuleDestroy();
    vi.unstubAllEnvs();
  });

  it('indexes source chunks and returns exact cross-file evidence with worker-fenced hybrid retrieval', { timeout: 90_000 }, async () => {
    const sources = await health.prisma.material.findMany({ where: { projectId, included: true, purpose: 'FACTUAL_SOURCE' },
      select: { currentSnapshotId: true } });
    const snapshotIds = sources.flatMap(row => row.currentSnapshotId ? [row.currentSnapshotId] : []);
    expect(snapshotIds).toHaveLength(2);

    const indexKey = randomUUID();
    const indexed = await evidence.index(owner.id, projectId, { commandKey: indexKey, snapshotIds });
    expect(indexed.jobs.length).toBeGreaterThan(0);
    const replay = await evidence.index(owner.id, projectId, { commandKey: indexKey, snapshotIds: [...snapshotIds].reverse() });
    expect(replay.jobs.map(job => job.id)).toEqual(indexed.jobs.map(job => job.id));
    for (const job of indexed.jobs) await processJob(job.id);
    expect(embeddingCalls.filter(call => call.task === 'DOCUMENT').length).toBeGreaterThan(0);
    const indexState = await evidence.list(member.id, projectId);
    expect(indexState.materials).toHaveLength(2);
    expect(indexState.materials.every(source => source.indexState === 'READY' && source.chunkCount === source.readyChunkCount)).toBe(true);

    const query = 'database transaction behavior';
    const commandKey = randomUUID();
    const search = await evidence.search(member.id, projectId, { commandKey, snapshotIds, query });
    const sameSearch = await evidence.search(member.id, projectId, { commandKey, snapshotIds: [...snapshotIds].reverse(), query });
    expect(sameSearch.job.id).toBe(search.job.id);
    await expect(evidence.search(member.id, projectId, { commandKey, snapshotIds, query: 'different query' })).rejects.toMatchObject({ status: 409 });
    await processJob(search.job.id);

    const result = await evidence.result(member.id, projectId, search.job.id);
    expect(result.job.status).toBe('SUCCEEDED');
    expect(result.packet?.searchMode).toBe('hybrid');
    const passages = result.packet?.passages as Array<{ snapshotId: string; fragmentId: string; startOffset: number; endOffset: number; quote: string; sha256: string }>;
    expect(passages.length).toBeGreaterThan(0);
    expect(passages.some(span => span.snapshotId === currentSnapshot.id && span.quote.includes('database transaction'))).toBe(true);
    for (const span of passages) {
      const snapshot = await health.prisma.sourceSnapshot.findUniqueOrThrow({ where: { projectId_id: { projectId, id: span.snapshotId } },
        include: { fragments: true } });
      expect(snapshot.normalizedText.slice(span.startOffset, span.endOffset)).toBe(span.quote);
      expect(sha256(span.quote)).toBe(span.sha256);
      expect(snapshot.fragments.some(fragment => fragment.id === span.fragmentId && fragment.startOffset <= span.startOffset
        && fragment.endOffset >= span.endOffset)).toBe(true);
    }
    expect(await health.prisma.claim.count({ where: { projectId } })).toBe(0);
    expect(await health.prisma.sourceEvidencePacket.count({ where: { projectId } })).toBe(1);
    const frozen = await health.prisma.job.findUniqueOrThrow({ where: { id: search.job.id } });
    const legacyManifest = JSON.parse(JSON.stringify(frozen.inputManifest)) as {
      [key: string]: unknown; schemaVersion: string; relevanceRelease?: unknown; commandKey: string;
      retrievalPolicy: { version: string; rankConstant: 60; byteBudget: 30_000; maxPassages: 20; adjacentContextChunks: 1 };
    };
    expect(legacyManifest.retrievalPolicy.version).toBe('hybrid-source-v4');
    legacyManifest.schemaVersion = 'evidence-search-job-v1';
    delete legacyManifest.relevanceRelease;
    for (const version of ['hybrid-source-v1', 'hybrid-source-v2']) {
      legacyManifest.commandKey = randomUUID();
      legacyManifest.retrievalPolicy.version = version;
      const legacy = await health.prisma.$transaction(tx => jobs.create(tx, { projectId, userId: member.id,
        operation: 'EVIDENCE_SEARCH', contractVersion: 'evidence-search-v1', commandKey: legacyManifest.commandKey,
        inputManifest: legacyManifest as unknown as Prisma.InputJsonObject, deadlineMs: 600_000 }));
      await processJob(legacy.id);
      expect((await evidence.result(member.id, projectId, legacy.id)).job.status).toBe('SUCCEEDED');
    }
  });

  it('bounds actual citation spans and suppresses layout-only imported paragraphs across ranked sources', { timeout: 90_000 }, async () => {
    const project = await health.prisma.project.create({ data: { workspaceId, createdBy: owner.id,
      topic: 'Synthetic dense source formatting regression', formats: ['TELEGRAM_POST'] } });
    denseProjectId = project.id;
    projectIds.push(project.id);
    const sourceA = await addSource(owner, 'Dense formatting', [
      'Cover course metadata', '**Зміст**', '&nbsp;', '[Requirements](#requirements-(detail))', '<br>', '[References](#references)', '## Requirements',
      ...Array<string>(220).fill('&nbsp;'),
      ...Array.from({ length: 60 }, (_, i) => `## database transaction ${i} ${'navigation '.repeat(110)}`),
      ...Array.from({ length: 35 }, (_, i) => `database transaction requirement ${i}: a committed record must preserve its exact source evidence and Unicode 😀.`),
    ].join('\n\n'), project.id);
    const sourceB = await addSource(owner, 'Independent source', 'database transaction independent corroborating source evidence.', project.id);
    const snapshotIds = [sourceA.snapshot.id, sourceB.snapshot.id];
    const indexed = await evidence.index(owner.id, project.id, { commandKey: randomUUID(), snapshotIds });
    for (const job of indexed.jobs) await processJob(job.id);
    const searched = await evidence.search(member.id, project.id, { commandKey: randomUUID(), snapshotIds, query: 'database transaction evidence' });
    await processJob(searched.job.id);
    const result = await evidence.result(member.id, project.id, searched.job.id);
    expect(result.job.status).toBe('SUCCEEDED');
    const passages = result.packet!.passages as Array<{ snapshotId: string; fragmentId: string; startOffset: number; endOffset: number; quote: string; sha256: string }>;
    expect(passages.length).toBeGreaterThan(0);
    expect(passages.length).toBeLessThanOrEqual(20);
    expect(passages.every(span => span.quote !== '&nbsp;' && span.quote.includes('database transaction'))).toBe(true);
    expect(new Set(passages.slice(0, 2).map(span => span.snapshotId))).toEqual(new Set(snapshotIds));
    expect(Buffer.byteLength(passages.map(span => span.quote).join(''), 'utf8')).toBeLessThanOrEqual(30_000);
    const densePacket = await health.prisma.sourceEvidencePacket.findFirstOrThrow({ where: { projectId: project.id, jobId: searched.job.id } });
    const denseManifest = densePacket.manifestJson as { candidateCount: number; usefulCandidateCount: number; passages: unknown[] };
    expect(denseManifest.candidateCount).toBeLessThanOrEqual(60);
    expect(denseManifest.usefulCandidateCount).toBeLessThanOrEqual(denseManifest.candidateCount);
    expect(denseManifest.passages.length).toBeLessThanOrEqual(20);
    for (const span of passages) {
      const source = await health.prisma.sourceSnapshot.findUniqueOrThrow({ where: { projectId_id: { projectId: project.id, id: span.snapshotId } } });
      expect(source.normalizedText.slice(span.startOffset, span.endOffset)).toBe(span.quote);
      expect(sha256(span.quote)).toBe(span.sha256);
    }
    const packet = await health.prisma.sourceEvidencePacket.findFirstOrThrow({ where: { projectId: project.id, jobId: searched.job.id } });
    expect(canonicalManifestHash(packet.manifestJson)).toBe(packet.sha256);
  });

  it('keeps the embedding parent packet-free until the relevance child commits a filtered result', { timeout: 90_000 }, async () => {
    relevanceMode = 'first-only';
    const snapshotIds = (await health.prisma.material.findMany({ where: { projectId, included: true, purpose: 'FACTUAL_SOURCE' },
      select: { currentSnapshotId: true } })).flatMap(row => row.currentSnapshotId ? [row.currentSnapshotId] : []);
    const beforeCalls = relevanceCalls.length;
    const commandKey = randomUUID();
    const search = await evidence.search(member.id, projectId, { commandKey, snapshotIds, query: 'database transaction behavior' });
    const replay = await evidence.search(member.id, projectId, { commandKey, snapshotIds: [...snapshotIds].reverse(), query: 'database transaction behavior' });
    expect(replay.job.id).toBe(search.job.id);
    await processParent(search.job.id);
    const parent = await health.prisma.job.findUniqueOrThrow({ where: { id: search.job.id }, select: { status: true, resultRefs: true } });
    expect(parent.status).toBe('SUCCEEDED');
    const childId = (parent.resultRefs as { relevanceJobId?: string } | null)?.relevanceJobId;
    expect(childId).toBeTruthy();
    expect((await evidence.result(member.id, projectId, search.job.id)).packet).toBeNull();
    const child = await health.prisma.job.findUniqueOrThrow({ where: { id: childId! }, select: { status: true, inputManifest: true } });
    expect(child.status).toBe('QUEUED');
    const childManifest = child.inputManifest as { request: RelevanceInput; parentJobId: string };
    expect(childManifest.parentJobId).toBe(search.job.id);
    expect(childManifest.request.candidates.length).toBeGreaterThan(1);
    const children = await health.prisma.job.findMany({ where: { projectId, contractVersion: 'evidence-relevance-v1' },
      select: { id: true, inputManifest: true } });
    expect(children.filter(row => (row.inputManifest as { parentJobId?: string }).parentJobId === search.job.id)).toHaveLength(1);
    expect(relevanceCalls).toHaveLength(beforeCalls);

    await worker.process({ jobId: childId!, ordinal: 1 });
    const result = await evidence.result(member.id, projectId, search.job.id);
    expect(result.job.status).toBe('SUCCEEDED');
    expect(result.packet?.passages).toHaveLength(1);
    expect(relevanceCalls).toHaveLength(beforeCalls + 1);
    const packet = await health.prisma.sourceEvidencePacket.findFirstOrThrow({ where: { projectId, jobId: search.job.id } });
    const packetManifest = packet.manifestJson as { candidateCount: number; usefulCandidateCount: number; relevanceJobId: string };
    expect(packetManifest.usefulCandidateCount).toBeLessThan(packetManifest.candidateCount);
    expect(packetManifest.relevanceJobId).toBe(childId);
    relevanceMode = 'all';
  });

  it('writes a valid empty packet when the relevance stage rejects every candidate', { timeout: 90_000 }, async () => {
    relevanceMode = 'empty';
    const snapshotIds = (await health.prisma.material.findMany({ where: { projectId: denseProjectId, included: true, purpose: 'FACTUAL_SOURCE' },
      select: { currentSnapshotId: true } })).flatMap(row => row.currentSnapshotId ? [row.currentSnapshotId] : []);
    const search = await evidence.search(member.id, denseProjectId, { commandKey: randomUUID(), snapshotIds, query: 'database transaction behavior' });
    await processJob(search.job.id);
    const result = await evidence.result(member.id, denseProjectId, search.job.id);
    expect(result.job.status).toBe('SUCCEEDED');
    expect(result.packet?.passages).toEqual([]);
    const packet = await health.prisma.sourceEvidencePacket.findFirstOrThrow({ where: { projectId: denseProjectId, jobId: search.job.id } });
    expect(packet.manifestJson).toMatchObject({ candidateCount: expect.any(Number), usefulCandidateCount: 0, hasMore: false, passages: [] });
    const parent = await health.prisma.job.findUniqueOrThrow({ where: { id: search.job.id }, select: { resultRefs: true } });
    const childId = (parent.resultRefs as { relevanceJobId?: string } | null)?.relevanceJobId;
    expect(childId).toBeTruthy();
    expect(await health.prisma.job.findUniqueOrThrow({ where: { id: childId! }, select: { status: true } })).toMatchObject({ status: 'SUCCEEDED' });
    const laterSpan = await health.prisma.sourceEvidenceSpan.findFirstOrThrow({ where: { projectId: denseProjectId }, select: { id: true } });
    await expect(sql.query('INSERT INTO contextflow."SourceEvidencePacketItem" ("projectId","packetId","spanId","ordinal") VALUES ($1,$2,$3,$4)',
      [denseProjectId, packet.id, laterSpan.id, 0])).rejects.toMatchObject({ code: '23514' });
    relevanceMode = 'all';
  });

  it('rejects v2 root completion without its child and rejects a cross-project child link', { timeout: 90_000 }, async () => {
    const snapshotIds = (await health.prisma.material.findMany({ where: { projectId, included: true, purpose: 'FACTUAL_SOURCE' },
      select: { currentSnapshotId: true } })).flatMap(row => row.currentSnapshotId ? [row.currentSnapshotId] : []);
    const root = await evidence.search(member.id, projectId, { commandKey: randomUUID(), snapshotIds, query: 'database transaction guard test' });
    await expect(sql.query('UPDATE contextflow."Job" SET "status"=\'SUCCEEDED\',"resultRefs"=\'{}\'::jsonb WHERE "projectId"=$1 AND "id"=$2',
      [projectId, root.job.id])).rejects.toMatchObject({ code: '23514' });

    const foreignParent = await health.prisma.job.findFirstOrThrow({ where: { projectId: denseProjectId, operation: 'EVIDENCE_SEARCH',
      contractVersion: 'evidence-search-v2', status: 'SUCCEEDED' }, select: { resultRefs: true } });
    const foreignRefs = foreignParent.resultRefs as { relevanceJobId?: string; candidateCount?: number; hasMore?: boolean };
    expect(foreignRefs.relevanceJobId).toBeTruthy();
    const crossProjectRefs = JSON.stringify({ relevanceJobId: foreignRefs.relevanceJobId, candidateCount: foreignRefs.candidateCount, hasMore: foreignRefs.hasMore });
    await expect(sql.query('UPDATE contextflow."Job" SET "status"=\'SUCCEEDED\',"resultRefs"=$1::jsonb WHERE "projectId"=$2 AND "id"=$3',
      [crossProjectRefs, projectId, root.job.id])).rejects.toMatchObject({ code: '23514' });
    expect(await health.prisma.job.findUniqueOrThrow({ where: { id: root.job.id }, select: { status: true } })).toMatchObject({ status: 'QUEUED' });
    await jobs.cancel(member.id,projectId,root.job.id);
  });

  it('rejects an incomplete relevance response without persisting a partial packet', { timeout: 90_000 }, async () => {
    relevanceMode = 'missing-decision';
    const snapshotIds = (await health.prisma.material.findMany({ where: { projectId, included: true, purpose: 'FACTUAL_SOURCE' },
      select: { currentSnapshotId: true } })).flatMap(row => row.currentSnapshotId ? [row.currentSnapshotId] : []);
    const search = await evidence.search(member.id, projectId, { commandKey: randomUUID(), snapshotIds, query: 'database transaction behavior' });
    await processParent(search.job.id);
    const parent = await health.prisma.job.findUniqueOrThrow({ where: { id: search.job.id }, select: { resultRefs: true } });
    const childId = (parent.resultRefs as { relevanceJobId?: string } | null)?.relevanceJobId;
    expect(childId).toBeTruthy();
    await worker.process({ jobId: childId!, ordinal: 1 });
    expect(await health.prisma.sourceEvidencePacket.count({ where: { projectId, jobId: search.job.id } })).toBe(0);
    expect(await health.prisma.job.findUniqueOrThrow({ where: { id: childId! }, select: { status: true } })).toMatchObject({ status: 'FAILED' });
    relevanceMode = 'all';
  });

  it('cancels the queued relevance child when the caller cancels its completed embedding parent', { timeout: 90_000 }, async () => {
    relevanceMode = 'all';
    const snapshotIds = (await health.prisma.material.findMany({ where: { projectId, included: true, purpose: 'FACTUAL_SOURCE' },
      select: { currentSnapshotId: true } })).flatMap(row => row.currentSnapshotId ? [row.currentSnapshotId] : []);
    const search = await evidence.search(member.id, projectId, { commandKey: randomUUID(), snapshotIds, query: 'database transaction behavior' });
    await processParent(search.job.id);
    const parent = await health.prisma.job.findUniqueOrThrow({ where: { id: search.job.id }, select: { resultRefs: true } });
    const childId = (parent.resultRefs as { relevanceJobId?: string } | null)?.relevanceJobId;
    expect(childId).toBeTruthy();
    const beforeCalls = relevanceCalls.length;
    const cancelled = await request(member, 'POST', `/api/v1/projects/${projectId}/jobs/${search.job.id}/cancel`);
    expect(cancelled.response.status).toBe(201);
    expect(await health.prisma.job.findUniqueOrThrow({ where: { id: childId! }, select: { status: true } })).toMatchObject({ status: 'CANCELLED' });
    expect(relevanceCalls).toHaveLength(beforeCalls);
    expect(await health.prisma.sourceEvidencePacket.count({ where: { projectId, jobId: search.job.id } })).toBe(0);
  });

  it('resumes the captured relevance run ID after worker lease loss without submitting a sibling run', { timeout: 90_000 }, async () => {
    relevanceMode = 'all';
    const snapshotIds = (await health.prisma.material.findMany({ where: { projectId, included: true, purpose: 'FACTUAL_SOURCE' },
      select: { currentSnapshotId: true } })).flatMap(row => row.currentSnapshotId ? [row.currentSnapshotId] : []);
    const search = await evidence.search(member.id, projectId, { commandKey: randomUUID(), snapshotIds, query: 'database transaction behavior' });
    await processParent(search.job.id);
    const parent = await health.prisma.job.findUniqueOrThrow({ where: { id: search.job.id }, select: { resultRefs: true } });
    const childId = (parent.resultRefs as { relevanceJobId?: string } | null)?.relevanceJobId;
    expect(childId).toBeTruthy();
    const executeStart = relevanceExecuteRuns.length, resumeStart = relevanceResumeRuns.length;
    let signalStarted!: () => void;
    const started = new Promise<void>(resolve => { signalStarted = resolve; });
    let releaseProvider!: () => void;
    const providerGate = new Promise<void>(resolve => { releaseProvider = resolve; });
    nextRelevanceHold = { started: signalStarted, wait: providerGate };
    const lostWorker = worker.process({ jobId: childId!, ordinal: 1 });
    try {
      await started;
      const attempt = await health.prisma.jobAttempt.findFirstOrThrow({ where: { jobId: childId!, finishedAt: null }, select: { id: true } });
      await sql.query('UPDATE contextflow."JobAttempt" SET "leaseExpiresAt"=CURRENT_TIMESTAMP - INTERVAL \'1 second\' WHERE "id"=$1', [attempt.id]);
      await jobs.reconcile(['EVIDENCE_SEARCH']);
      expect(await health.prisma.job.findUniqueOrThrow({ where: { id: childId! }, select: { status: true } })).toMatchObject({ status: 'QUEUED' });
      await worker.process({ jobId: childId!, ordinal: 2 });
    } finally {
      releaseProvider();
      await lostWorker;
    }
    expect(relevanceExecuteRuns).toHaveLength(executeStart + 1);
    expect(relevanceResumeRuns).toHaveLength(resumeStart + 1);
    expect(relevanceResumeRuns.at(-1)).toBe(relevanceExecuteRuns.at(-1));
    expect((await evidence.result(member.id, projectId, search.job.id)).packet?.passages.length).toBeGreaterThan(0);
    relevanceMode = 'all';
  });

  it('rechecks workspace access and source inclusion before relevance provider submission', { timeout: 90_000 }, async () => {
    const source = await addSource(owner, 'Relevance access fence', 'Database transaction evidence is frozen only while included.');
    await evidence.indexNewSnapshot(owner.id, projectId, source.snapshot.id);
    await evidence.indexNewSnapshot(owner.id, projectId, source.snapshot.id);
    const indexed = await evidence.index(owner.id, projectId, { commandKey: source.snapshot.id, snapshotIds: [source.snapshot.id] });
    expect(indexed.jobs).toHaveLength(1);
    for (const job of indexed.jobs) await processJob(job.id);
    const beforeCalls = relevanceCalls.length;
    await expect(evidence.search(outsider.id, projectId, { commandKey: randomUUID(), snapshotIds: [source.snapshot.id], query: 'database transaction' }))
      .rejects.toMatchObject({ status: 404 });
    expect(relevanceCalls).toHaveLength(beforeCalls);

    const search = await evidence.search(member.id, projectId, { commandKey: randomUUID(), snapshotIds: [source.snapshot.id], query: 'database transaction' });
    await processParent(search.job.id);
    const parent = await health.prisma.job.findUniqueOrThrow({ where: { id: search.job.id }, select: { resultRefs: true } });
    const childId = (parent.resultRefs as { relevanceJobId?: string } | null)?.relevanceJobId;
    expect(childId).toBeTruthy();
    const excluded = await request(owner, 'PATCH', `/api/v1/projects/${projectId}/materials/${source.material.id}`,
      { expectedRevision: source.material.revision, included: false, purpose: 'NOTES' });
    expect(excluded.response.status).toBe(200);
    await worker.process({ jobId: childId!, ordinal: 1 });
    expect(relevanceCalls).toHaveLength(beforeCalls);
    expect(await health.prisma.sourceEvidencePacket.count({ where: { projectId, jobId: search.job.id } })).toBe(0);
    expect(await health.prisma.job.findUniqueOrThrow({ where: { id: childId! }, select: { status: true, errorCategory: true } }))
      .toMatchObject({ status: 'FAILED', errorCategory: 'SOURCE_CHANGED' });
  });

  it('enforces membership, current-snapshot selection, configuration and completion before search', async () => {
    const unindexed = await addSource(owner, 'Not indexed yet', 'Пошуковий індекс іще не створений для цього джерела.');
    await expect(evidence.list(outsider.id, projectId)).rejects.toMatchObject({ status: 404 });
    await expect(evidence.index(outsider.id, projectId, { commandKey: randomUUID(), snapshotIds: [unindexed.snapshot.id] })).rejects.toMatchObject({ status: 404 });
    const foreignSnapshot = await health.prisma.material.findFirstOrThrow({ where: { projectId: { not: projectId }, purpose: 'FACTUAL_SOURCE' },
      select: { currentSnapshotId: true } });
    await expect(evidence.index(owner.id, projectId, { commandKey: randomUUID(), snapshotIds: [foreignSnapshot.currentSnapshotId!] })).rejects.toMatchObject({ status: 409 });

    const incompleteKey = randomUUID();
    await expect(evidence.search(owner.id, projectId, { commandKey: incompleteKey, snapshotIds: [unindexed.snapshot.id], query: 'database' })).rejects.toMatchObject({ status: 409 });
    const unconfigured = new SourceEvidenceService(health.prisma, jobs, { NODE_ENV: 'test' });
    expect((await unconfigured.list(owner.id, projectId)).configuration.configured).toBe(false);
    await expect(unconfigured.index(owner.id, projectId, { commandKey: randomUUID(), snapshotIds: [unindexed.snapshot.id] })).rejects.toMatchObject({ status: 409 });

    const stale = await addSource(owner, 'Will be excluded before indexing starts', 'Це джерело вже не можна індексувати після виключення.');
    const queued = await evidence.index(owner.id, projectId, { commandKey: randomUUID(), snapshotIds: [stale.snapshot.id] });
    expect(queued.jobs).toHaveLength(1);
    const excluded = await request(owner, 'PATCH', `/api/v1/projects/${projectId}/materials/${stale.material.id}`,
      { expectedRevision: stale.material.revision, included: false, purpose: 'NOTES' });
    expect(excluded.response.status).toBe(200);
    const callsBefore = embeddingCalls.length;
    await processParent(queued.jobs[0]!.id);
    expect(await health.prisma.job.findUniqueOrThrow({ where: { id: queued.jobs[0]!.id } }))
      .toMatchObject({ status: 'FAILED', errorCategory: 'SOURCE_CHANGED' });
    expect(embeddingCalls).toHaveLength(callsBefore);
  });

  it('rejects direct changes to indexed chunk text and evidence span locators', { timeout: 60_000 }, async () => {
    const chunk = await health.prisma.$queryRaw<Array<{ id: string; text: string }>>`
      SELECT c."id"::text,c."text" FROM contextflow."SourceSearchChunk" c WHERE c."projectId"=${projectId}::uuid LIMIT 1`;
    expect(chunk).toHaveLength(1);
    await expect(sql.query('UPDATE contextflow."SourceSearchChunk" SET "text"=$1 WHERE "projectId"=$2 AND "id"=$3',
      ['tampered', projectId, chunk[0]!.id])).rejects.toBeDefined();

    // A successful result from the preceding test persists exact source spans.
    const span = await health.prisma.$queryRaw<Array<{ id: string; startOffset: number }>>`
      SELECT s."id"::text,s."startOffset" FROM contextflow."SourceEvidenceSpan" s WHERE s."projectId"=${projectId}::uuid LIMIT 1`;
    expect(span.length).toBeGreaterThan(0);
    await expect(sql.query('UPDATE contextflow."SourceEvidenceSpan" SET "startOffset"=$1 WHERE "projectId"=$2 AND "id"=$3',
      [span[0]!.startOffset + 1, projectId, span[0]!.id])).rejects.toBeDefined();

    const packet = await health.prisma.$queryRaw<Array<{ id: string }>>`
      SELECT p."id"::text FROM contextflow."SourceEvidencePacket" p WHERE p."projectId"=${projectId}::uuid LIMIT 1`;
    expect(packet).toHaveLength(1);
    await expect(sql.query('INSERT INTO contextflow."SourceEvidencePacketItem" ("projectId","packetId","spanId","ordinal") VALUES ($1,$2,$3,$4)',
      [projectId, packet[0]!.id, span[0]!.id, 9999])).rejects.toBeDefined();

    const validEmojiSlice = await sql.query('SELECT contextflow.source_evidence_utf16_slice($1,$2,$3) AS value', ['A😀B', 1, 3]);
    expect(validEmojiSlice.rows[0]?.['value']).toBe('😀');
    await expect(sql.query('SELECT contextflow.source_evidence_utf16_slice($1,$2,$3)', ['A😀B', 2, 3])).rejects.toBeDefined();
  });

  it('keeps a cancelled submitted index reserved while its synthetic provider call is still running', { timeout: 60_000 }, async () => {
    const stale = await addSource(owner, 'Submitted provider reservation', 'Провайдер іще обробляє пакет джерела.');
    const initial = await evidence.index(owner.id, projectId, { commandKey: randomUUID(), snapshotIds: [stale.snapshot.id] });
    expect(initial.jobs).toHaveLength(1);

    let signalStarted!: () => void;
    const started = new Promise<void>(resolve => { signalStarted = resolve; });
    let releaseProvider!: () => void;
    const providerGate = new Promise<void>(resolve => { releaseProvider = resolve; });
    nextDocumentHold = { started: signalStarted, wait: providerGate };
    const callsBefore = embeddingCalls.length;
    const executing = processParent(initial.jobs[0]!.id);
    try {
      await started;
      expect(embeddingCalls).toHaveLength(callsBefore + 1);
      const cancelled = await request(owner, 'POST', `/api/v1/projects/${projectId}/jobs/${initial.jobs[0]!.id}/cancel`);
      expect(cancelled.response.status).toBe(201);
      expect(cancelled.body).toMatchObject({ job: { status: 'CANCELLED' } });

      const replayedReservation = await evidence.index(owner.id, projectId, { commandKey: randomUUID(), snapshotIds: [stale.snapshot.id] });
      expect(replayedReservation.jobs).toEqual([{ id: initial.jobs[0]!.id, status: 'CANCELLED' }]);
      expect(embeddingCalls).toHaveLength(callsBefore + 1);
    } finally {
      releaseProvider();
      await executing;
    }
    expect(await health.prisma.job.findUniqueOrThrow({ where: { id: initial.jobs[0]!.id } })).toMatchObject({ status: 'CANCELLED' });
    expect(embeddingCalls).toHaveLength(callsBefore + 1);
  });

  it('rejects unnormalized embeddings before writing vector rows', async () => {
    const invalid = Array<number>(VECTOR_DIMENSIONS).fill(0);
    const vectorRequest: VectorRequest = { schemaVersion: 'source-embedding-request-v1', requestId: randomUUID(), task: 'QUERY',
      texts: [{ id: randomUUID(), text: 'query', sha256: sha256('query') }] };
    const malformed = { schemaVersion: 'source-embedding-v1', requestId: vectorRequest.requestId,
      requestHash: embeddingRequestHash(vectorRequest as never), model: 'gemini-embedding-001', dimensions: VECTOR_DIMENSIONS,
      task: 'QUERY', embeddings: [{ id: vectorRequest.texts[0]!.id, sha256: vectorRequest.texts[0]!.sha256, values: invalid }] };
    expect(() => validateEmbeddingOutput(malformed, vectorRequest as never)).toThrow();
    const before = await health.prisma.$queryRaw<Array<{ count: number }>>`SELECT count(*)::int AS count FROM contextflow."SourceChunkEmbedding" WHERE "projectId"=${projectId}::uuid`;
    await expect(sql.query('SELECT contextflow.parse_source_vector($1)', [`[${invalid.join(',')}]`])).rejects.toBeDefined();
    const after = await health.prisma.$queryRaw<Array<{ count: number }>>`SELECT count(*)::int AS count FROM contextflow."SourceChunkEmbedding" WHERE "projectId"=${projectId}::uuid`;
    expect(after[0]?.count).toBe(before[0]?.count);
  });

  it('prepares and reviews a factual source-grounded outline without a claim catalogue', { timeout: 90_000 }, async () => {
    const p = await health.prisma.project.create({ data: { workspaceId, createdBy: owner.id, topic: 'Synthetic source writing', formats: ['ARTICLE','TELEGRAM_POST'] } });
    projectIds.push(p.id);
    await addSource(owner, 'Atomicity', 'База даних database transaction зберігає атомарність операцій. 😀', p.id);
    const release = JSON.parse(readFileSync(new URL('../../packages/backend/src/evidence/workflows/source-writing/release.json', import.meta.url), 'utf8')) as { configDigest: string };
    const writingEnv = { ...env, DIFY_SOURCE_WRITING_PUBLISHED_WORKFLOW_ID: randomUUID(),
      DIFY_SOURCE_WRITING_CONFIG_SHA256: release.configDigest, DIFY_SOURCE_WRITING_API_KEY: 'synthetic-writing-key' };
    const facts = new FactualBasisService(health.prisma,jobs), editorial = new EditorialService(health.prisma,jobs,facts);
    const articles = new ArticleService(health.prisma,jobs,facts),telegram = new TelegramService(health.prisma,jobs,facts,articles);
    const assets = new PrivateAssetStore(),scripts = new ScriptService(health.prisma,telegram),renderer = new VisualRenderer();
    const visuals = new VisualService(health.prisma,telegram,scripts,renderer,assets);
    const exports = new ExportService(health.prisma,jobs,articles,telegram,assets,visuals);
    await editorial.saveBrief(owner.id,p.id,{ expectedRevision: 0, contentMode: 'FACTUAL', topic: 'database transaction', audience: 'Автори',
      centralMessage: 'Атомарна робота', category: 'Техніка', tone: '', targetLength: 100, cta: '', exclusions: [], notes: '', requiredClaimRevisionIds: [] });
    const preparation = new SourcePreparationService(health.prisma,jobs,evidence,facts,writingEnv);
    let writingCalls = 0;
    let rejectedSectionJob: string | undefined;
    let rejectFirstSection = false;
    const writer = {
      async execute(_settings: unknown,_jobId: string,input: SourceWritingInput,_signal: AbortSignal,before: () => Promise<void>,record: (id: string) => Promise<void>) {
        await before(); const run = randomUUID(); await record(run); writingCalls++;
        if (rejectFirstSection && input.task === 'SECTION' && input.section?.title === 'Робота транзакцій 1') {
          return { workflowRunId: run, model: 'synthetic-reviewed-writer', output: { schemaVersion: 'source-writing-v1',
            requestId: input.requestId, inputHash: canonicalManifestHash(input), task: input.task, status: 'needs_human', content: null,
            review: { status: 'needs_human', issues: [], reasons: ['Не розкрито частину призначення розділу.'], modelCalls: 4 } } };
        }
        if (input.task === 'SECTION' && !rejectedSectionJob) {
          rejectedSectionJob = _jobId;
          return { workflowRunId: run, model: 'synthetic-reviewed-writer', output: { schemaVersion: 'source-writing-v1',
            requestId: input.requestId, inputHash: canonicalManifestHash(input), task: input.task, status: 'needs_human', content: null,
            review: { status: 'needs_human', issues: [], reasons: ['Чернетка не пройшла перевірку структури або доказових посилань: CANDIDATE_TASK_FIELDS'], modelCalls: 1 } } };
        }
        const assertion = 'База даних зберігає атомарність 😀';
        const content = input.task === 'OUTLINE' ? { title: 'Атомарність', sections: [0,1].map(index => ({ id: randomUUID(),
          title: `Робота транзакцій ${index+1}`, purpose: 'Пояснити атомарність. ' + 'transaction example '.repeat(65),
          targetWords: 50, passageIds: [input.passages[0]!.id], requiredClaimRevisionIds: [] })) }
          : { ...(input.task === 'SECTION' ? { sectionId: input.section!.id } : {}),paragraphs: [{ id: randomUUID(),text: assertion+' слово'.repeat(44),citations: [{ kind: 'source_passage',
            passageId: input.passages[0]!.id,quote: input.passages[0]!.quote,assertionText: assertion }] }] };
        if (input.task === 'ADAPTATION' && input.format?.includes('CAROUSEL') && 'paragraphs' in content) {
          Object.assign(content,{ frames: content.paragraphs!.map(paragraph => ({ ...paragraph,id: randomUUID(),purpose: 'Пояснення',visualHint: 'Проста схема',transition: '' })) });
        }
        return { workflowRunId: run, model: 'synthetic-reviewed-writer', output: { schemaVersion: 'source-writing-v1', requestId: input.requestId,
          inputHash: canonicalManifestHash(input), task: input.task, status: 'ready', content,
          review: { status: 'ready', issues: [], reasons: [], modelCalls: 2 } } };
      },
      async resume() { throw new Error('Synthetic fixture must not need reconciliation'); },
    };
    const writingWorker = new DurableJobWorker(health.prisma,runtime.redisUrl,EXTERNAL_PROCESSING_NOTICE.version,
      [...createSourceEvidenceJobHandlers({ prisma: health.prisma,evidence,provider,relevanceProvider,env }),
        createSourceWritingJobHandler({ prisma: health.prisma,editorial,factualBasis: facts,telegram,articles,scripts,provider: writer as never,env: writingEnv }),createExportJobHandler(exports)],
      { queueName: `cf-source-writing-${randomUUID()}` });
    await writingWorker.queue.waitUntilReady();
    try {
      const commandKey = randomUUID();
      const accepted = await preparation.prepareOutline(owner.id,p.id,{ commandKey });
      expect((await preparation.prepareOutline(owner.id,p.id,{ commandKey })).id).toBe(accepted.id);
      await expect(preparation.get(outsider.id,p.id,accepted.id)).rejects.toMatchObject({ status: 404 });
      let completed = await preparation.get(member.id,p.id,accepted.id);
      for (let step=0;step<14 && !['SUCCEEDED','FAILED'].includes(completed.stage);step++) {
        await preparation.pollOnce(new Date(Date.now()+step*30000));
        const pending = await health.prisma.job.findMany({ where: { projectId: p.id,status: { in: ['QUEUED','RETRY_WAIT'] } }, orderBy: { createdAt: 'asc' } });
        for (const child of pending) await writingWorker.process({ jobId: child.id,ordinal: child.attemptCount+1 });
        completed = await preparation.get(owner.id,p.id,accepted.id);
      }
      expect(completed).toMatchObject({ stage: 'SUCCEEDED',errorCategory: null });
      expect(writingCalls).toBe(1);
      const emptyEvidenceProject = await health.prisma.project.create({ data: { workspaceId, createdBy: owner.id,
        topic: 'Synthetic empty relevant evidence', formats: ['ARTICLE'] } });
      projectIds.push(emptyEvidenceProject.id);
      await addSource(owner, 'Unrelated source', 'Біологічний матеріал про мікроорганізми.', emptyEvidenceProject.id);
      await editorial.saveBrief(owner.id,emptyEvidenceProject.id,{ expectedRevision: 0, contentMode: 'FACTUAL', topic: 'database transaction', audience: 'Автори',
        centralMessage: 'Атомарна робота', category: 'Техніка', tone: '', targetLength: 100, cta: '', exclusions: [], notes: '', requiredClaimRevisionIds: [] });
      relevanceMode = 'empty';
      const emptyEvidenceRequest = await preparation.prepareOutline(owner.id,emptyEvidenceProject.id,{ commandKey: randomUUID() });
      let emptyEvidenceState = await preparation.get(owner.id,emptyEvidenceProject.id,emptyEvidenceRequest.id);
      for (let step=0;step<14 && !['SUCCEEDED','FAILED'].includes(emptyEvidenceState.stage);step++) {
        await preparation.pollOnce(new Date(Date.now()+step*30000));
        const pending = await health.prisma.job.findMany({ where: { projectId: emptyEvidenceProject.id,status: { in: ['QUEUED','RETRY_WAIT'] } }, orderBy: { createdAt: 'asc' } });
        for (const child of pending) await writingWorker.process({ jobId: child.id,ordinal: child.attemptCount+1 });
        emptyEvidenceState = await preparation.get(owner.id,emptyEvidenceProject.id,emptyEvidenceRequest.id);
      }
      expect(emptyEvidenceState).toMatchObject({ stage: 'FAILED',errorCategory: 'NO_RELEVANT_SOURCE_EVIDENCE' });
      expect(writingCalls).toBe(1);
      relevanceMode = 'all';
      expect(await health.prisma.claim.count({ where: { projectId: p.id } })).toBe(0);
      expect(await health.prisma.factualBasisRevision.count({ where: { projectId: p.id } })).toBe(0);
      const candidate = await health.prisma.outlineRevision.findFirstOrThrow({ where: { projectId: p.id } });
      expect(candidate).toMatchObject({ contentMode: 'FACTUAL',basisRevisionId: null,sourceEvidenceSealed: true,approvedAt: null });
      expect(candidate.sourceEvidenceSetId).toBeTruthy();
      const citations = await health.prisma.outlineRevisionSourceCitation.findMany({ where: { projectId: p.id,revisionId: candidate.id } });
      expect(citations).toHaveLength(2);
      await expect(sql.query('UPDATE contextflow."OutlineRevision" SET "sourceEvidenceSealed"=false WHERE "id"=$1',[candidate.id])).rejects.toBeDefined();
      await expect(sql.query('UPDATE contextflow."SourceWritingRequest" SET "inputHash"=$1,"revision"="revision"+1 WHERE "id"=$2',['0'.repeat(64),accepted.id])).rejects.toBeDefined();
      const outline = await health.prisma.outline.findUniqueOrThrow({ where: { projectId: p.id } });
      await editorial.reviewOutline(owner.id,p.id,candidate.id,'apply',{ expectedRevision: outline.revision });
      const applied = await health.prisma.outline.findUniqueOrThrow({ where: { projectId: p.id } });
      await editorial.reviewOutline(member.id,p.id,candidate.id,'approve',{ expectedRevision: applied.revision });
      expect(await health.prisma.outlineRevision.findUniqueOrThrow({ where: { id: candidate.id } })).toMatchObject({ approvedBy: member.id });
      const cancelled = await preparation.prepareOutline(owner.id,p.id,{ commandKey: randomUUID() });
      await preparation.cancel(owner.id,p.id,cancelled.id);
      await preparation.pollOnce(new Date(Date.now()+999000));
      expect(await preparation.get(member.id,p.id,cancelled.id)).toMatchObject({ stage: 'CANCELLED' });
      expect(writingCalls).toBe(1);
      const articlePreparation = new SourceArticlePreparationService(health.prisma,jobs,evidence,facts,articles,writingEnv);
      const articleRequest = await articlePreparation.prepareArticle(owner.id,p.id,{ commandKey: randomUUID(),expectedRevision: 0 });
      let articleState = await articlePreparation.get(owner.id,p.id,articleRequest.id);
      for (let step=0;step<16 && !['SUCCEEDED','FAILED'].includes(articleState.stage);step++) {
        await new Promise(resolve => setTimeout(resolve, 2100));
        await articlePreparation.pollOnce();
        const pending = await health.prisma.job.findMany({ where: { projectId: p.id,status: { in: ['QUEUED','RETRY_WAIT'] } }, orderBy: { createdAt: 'asc' } });
        for (const child of pending) await writingWorker.process({ jobId: child.id,ordinal: child.attemptCount+1 });
        articleState = await articlePreparation.get(owner.id,p.id,articleRequest.id);
      }
      expect(articleState).toMatchObject({ stage: 'SUCCEEDED',errorCategory: null });
      expect(writingCalls).toBe(4);
      const attempts = await health.prisma.jobAttempt.findMany({ where: { jobId: rejectedSectionJob! }, orderBy: { ordinal: 'asc' } });
      expect(attempts).toMatchObject([
        { ordinal: 1, providerOutcome: 'KNOWN_SUCCEEDED', errorCategory: 'SECTION_DRAFT_INVALID' },
        { ordinal: 2, providerOutcome: 'KNOWN_SUCCEEDED', errorCategory: null },
      ]);
      expect(attempts[0]?.providerRunId).not.toBe(attempts[1]?.providerRunId);
      const version = await health.prisma.articleVersion.findFirstOrThrow({ where: { projectId: p.id } });
      expect(version).toMatchObject({ sourceEvidenceSealed: true,claimsSealed: true,basisRevisionId: null,approvedAt: null });
      const assembly = await health.prisma.sourceArticleAssembly.findUniqueOrThrow({ where: { articleVersionId: version.id } });
      expect((assembly.manifestJson as { sections: unknown[] }).sections).toHaveLength(2);
      const initialArticle = await articles.get(owner.id,p.id);
      await articles.review(owner.id,p.id,version.id,'apply',{ expectedRevision: initialArticle.article!.revision });
      const afterApply = await articles.get(owner.id,p.id);
      await articles.review(member.id,p.id,version.id,'approve',{ expectedRevision: afterApply.article!.revision,acknowledgeUnmapped: true });
      const approvedArticle = await articles.get(owner.id,p.id);
      expect(approvedArticle.article?.versions.find(row => row.id === version.id)).toMatchObject({ eligible: true,status: 'APPROVED' });
      const project = await health.prisma.project.findUniqueOrThrow({ where: { id: p.id } });
      const exported = await exports.freeze(owner.id,p.id,{ expectedProjectRevision: project.revision,commandKey: randomUUID(),format: 'ZIP',
        items: [{ format: 'ARTICLE',revisionId: version.id,reviewCounter: 0 }] });
      await writingWorker.process({ jobId: exported.jobId,ordinal: 1 });
      const exportRow = await health.prisma.exportRequest.findUniqueOrThrow({ where: { id: exported.exportId } });
      const exportManifest = exportRow.manifest as { sources: Array<{ kind: string; passageId: string; quote: string }>;items: Array<{ provenance: { evidenceMode: string;assembly: unknown } }> };
      expect(exportManifest.sources.length).toBe(2);
      expect(exportManifest.sources.every(source => source.kind === 'source_passage' && source.quote.includes('database transaction'))).toBe(true);
      expect(exportManifest.items[0]!.provenance).toMatchObject({ evidenceMode: 'source-passages-v1' });
      expect(exportManifest.items[0]!.provenance.assembly).toBeTruthy();
      expect(await health.prisma.job.findUniqueOrThrow({ where: { id: exported.jobId } })).toMatchObject({ status: 'SUCCEEDED' });
      expect((await exports.readiness(member.id,p.id)).ready).toBe(false); // The selected Telegram output is still missing.
      await expect(sql.query('UPDATE contextflow."SourceArticleAssembly" SET "sha256"=$1 WHERE "articleVersionId"=$2',['0'.repeat(64),version.id])).rejects.toBeDefined();
      const derived = await preparation.prepareAdaptation(owner.id,p.id,{ commandKey: randomUUID(),format: 'TELEGRAM_POST',expectedRevision: 0,inputMode: 'ARTICLE_DERIVED',includeLink: true });
      let derivedState = await preparation.get(owner.id,p.id,derived.id);
      for (let step=0;step<10 && !['SUCCEEDED','FAILED'].includes(derivedState.stage);step++) {
        await preparation.pollOnce(new Date(Date.now()+step*30000));
        for (const child of await health.prisma.job.findMany({ where: { projectId: p.id,status: { in: ['QUEUED','RETRY_WAIT'] } } })) await writingWorker.process({ jobId: child.id,ordinal: child.attemptCount+1 });
        derivedState = await preparation.get(owner.id,p.id,derived.id);
      }
      expect(derivedState).toMatchObject({ stage: 'SUCCEEDED',errorCategory: null });
      const derivedCandidate = await health.prisma.adaptationRevision.findFirstOrThrow({ where: { projectId: p.id } });
      expect(derivedCandidate).toMatchObject({ inputMode: 'ARTICLE_DERIVED',sourceArticleVersionId: version.id,sourceEvidenceSetId: version.sourceEvidenceSetId,includeLink: true,approvedAt: null });
      expect((derivedCandidate.content as { text: string }).text).toContain('[ПОСИЛАННЯ]');
      const derivedJob = await health.prisma.job.findUniqueOrThrow({ where: { id: derivedCandidate.jobId! } });
      expect(derivedJob.inputManifest).toMatchObject({ request: { approvedArticle: { versionId: version.id,sha256: version.sha256 } } });
      expect(await health.prisma.sourceEvidenceSet.count({ where: { projectId: p.id } })).toBe(2);
      let derivedChannel = await telegram.get(owner.id,p.id);
      await telegram.review(owner.id,p.id,derivedCandidate.id,'apply',{ expectedRevision: derivedChannel.adaptation!.revision });
      derivedChannel = await telegram.get(owner.id,p.id);
      await telegram.review(member.id,p.id,derivedCandidate.id,'approve',{ expectedRevision: derivedChannel.adaptation!.revision,expectedReviewCounter: 0,acknowledgeUnmapped: true });
      expect((await exports.readiness(member.id,p.id)).ready).toBe(true);
      const directProject = await health.prisma.project.create({ data: { workspaceId,createdBy: owner.id,topic: 'Standalone source-based Telegram',formats: ['TELEGRAM_POST','LINKEDIN_CAROUSEL'] } });
      projectIds.push(directProject.id);
      await addSource(owner,'Standalone source','База даних database transaction зберігає атомарність. 😀',directProject.id);
      await editorial.saveBrief(owner.id,directProject.id,{ expectedRevision: 0,contentMode: 'FACTUAL',topic: 'database transaction',audience: '',centralMessage: '',category: '',tone: '',targetLength: 100,cta: '',exclusions: [],notes: '',requiredClaimRevisionIds: [] });
      await expect(editorial.saveBrief(owner.id,directProject.id,{ expectedRevision: 1,contentMode: 'FACTUAL',topic: 'database transaction',audience: '',centralMessage: '',category: '',tone: '',targetLength: 100,cta: '',exclusions: [],notes: '',requiredClaimRevisionIds: [randomUUID()] }))
        .rejects.toThrow('REQUIRED_CLAIMS_RETIRED');
      const direct = await preparation.prepareAdaptation(owner.id,directProject.id,{ commandKey: randomUUID(),format: 'TELEGRAM_POST',expectedRevision: 0 });
      let directState = await preparation.get(owner.id,directProject.id,direct.id);
      for (let step=0;step<14 && !['SUCCEEDED','FAILED'].includes(directState.stage);step++) {
        await preparation.pollOnce(new Date(Date.now()+step*30000));
        const pending = await health.prisma.job.findMany({ where: { projectId: directProject.id,status: { in: ['QUEUED','RETRY_WAIT'] } } });
        for (const child of pending) await writingWorker.process({ jobId: child.id,ordinal: child.attemptCount+1 });
        directState = await preparation.get(owner.id,directProject.id,direct.id);
      }
      expect(directState).toMatchObject({ stage: 'SUCCEEDED',errorCategory: null });
      expect(await health.prisma.outline.count({ where: { projectId: directProject.id } })).toBe(0);
      expect(await health.prisma.article.count({ where: { projectId: directProject.id } })).toBe(0);
      const channelCandidate = await health.prisma.adaptationRevision.findFirstOrThrow({ where: { projectId: directProject.id } });
      const channel = await telegram.get(owner.id,directProject.id);
      await telegram.review(owner.id,directProject.id,channelCandidate.id,'apply',{ expectedRevision: channel.adaptation!.revision,format: 'TELEGRAM_POST' });
      const appliedChannel = await telegram.get(owner.id,directProject.id);
      await telegram.review(member.id,directProject.id,channelCandidate.id,'approve',{ expectedRevision: appliedChannel.adaptation!.revision,expectedReviewCounter: 0,format: 'TELEGRAM_POST',acknowledgeUnmapped: true });
      expect((await telegram.get(owner.id,directProject.id)).adaptation?.revisions[0]).toMatchObject({ status: 'APPROVED',eligible: true });
      const carousel = await preparation.prepareAdaptation(owner.id,directProject.id,{ commandKey: randomUUID(),format: 'LINKEDIN_CAROUSEL',expectedRevision: 0 });
      let carouselState = await preparation.get(owner.id,directProject.id,carousel.id);
      for (let step=0;step<14 && !['SUCCEEDED','FAILED'].includes(carouselState.stage);step++) {
        await preparation.pollOnce(new Date(Date.now()+step*30000));
        for (const child of await health.prisma.job.findMany({ where: { projectId: directProject.id,status: { in: ['QUEUED','RETRY_WAIT'] } } })) await writingWorker.process({ jobId: child.id,ordinal: child.attemptCount+1 });
        carouselState = await preparation.get(owner.id,directProject.id,carousel.id);
      }
      expect(carouselState).toMatchObject({ stage: 'SUCCEEDED' });
      const caption = await health.prisma.adaptationRevision.findFirstOrThrow({ where: { projectId: directProject.id,adaptation: { format: 'LINKEDIN_CAROUSEL' } } });
      let captionState = await telegram.get(owner.id,directProject.id,'LINKEDIN_CAROUSEL');
      await telegram.review(owner.id,directProject.id,caption.id,'apply',{ expectedRevision: captionState.adaptation!.revision,format: 'LINKEDIN_CAROUSEL' });
      captionState = await telegram.get(owner.id,directProject.id,'LINKEDIN_CAROUSEL');
      await telegram.review(owner.id,directProject.id,caption.id,'approve',{ expectedRevision: captionState.adaptation!.revision,expectedReviewCounter: 0,format: 'LINKEDIN_CAROUSEL',acknowledgeUnmapped: true });
      const passage = await health.prisma.adaptationRevisionSourceCitation.findFirstOrThrow({ where: { projectId: directProject.id,revisionId: caption.id } });
      const source = await health.prisma.sourceEvidenceSpan.findUniqueOrThrow({ where: { id: passage.spanId } });
      const frame = { id: randomUUID(),purpose: 'Атомарність',text: source.quote,visualHint: '',transition: '',mappings: [],sourceMappings: [{ passageId: source.id,packetId: passage.packetId,quote: source.quote,startOffset: 0,endOffset: source.quote.length }] };
      const generatedScript = await scripts.get(owner.id,directProject.id,'LINKEDIN_CAROUSEL');
      expect(generatedScript.script!.revisions[0]).toMatchObject({ origin: 'AI',approvedAt: null,parentAdaptationRevisionId: caption.id });
      let scriptState = await scripts.saveDraft(owner.id,directProject.id,'LINKEDIN_CAROUSEL',{ expectedRevision: generatedScript.script!.revision,expectedDraftCounter: 0,parentAdaptationRevisionId: caption.id,content: { frames: [frame] } });
      scriptState = await scripts.checkpoint(owner.id,directProject.id,'LINKEDIN_CAROUSEL',{ expectedRevision: scriptState.script!.revision,expectedDraftCounter: scriptState.script!.draft!.counter });
      const scriptVersion = scriptState.script!.revisions[0]!;
      await scripts.review(member.id,directProject.id,'LINKEDIN_CAROUSEL',scriptVersion.id,'approve',{ expectedRevision: scriptState.script!.revision,expectedReviewCounter: 0,acknowledgeUnmapped: true });
      let visualState = await visuals.initialize(owner.id,directProject.id,'LINKEDIN_CAROUSEL',{ parentRevisionId: scriptVersion.id });
      visualState = await visuals.checkpoint(owner.id,directProject.id,'LINKEDIN_CAROUSEL',{ expectedRevision: visualState.composition!.revision,expectedDraftCounter: visualState.composition!.draft!.counter });
      const visualRevision = visualState.composition!.revisions[0]!;
      const visualContent = visualRevision.content as { frames: Array<{ id: string;layers: Array<{ type: string;sourceMappings?: unknown[] }> }> };
      expect(visualContent.frames[0]!.layers.find(layer => layer.type === 'text')!.sourceMappings).toHaveLength(1);
      await visuals.preview(owner.id,directProject.id,'LINKEDIN_CAROUSEL',visualRevision.id,visualContent.frames[0]!.id);
      const approvedVisual = await visuals.review(member.id,directProject.id,'LINKEDIN_CAROUSEL',visualRevision.id,'approve',{ expectedRevision: visualState.composition!.revision,expectedReviewCounter: 0,acknowledgeUnmapped: true });
      const directRow = await health.prisma.project.findUniqueOrThrow({ where: { id: directProject.id } });
      const pdf = await exports.freeze(owner.id,directProject.id,{ expectedProjectRevision: directRow.revision,commandKey: randomUUID(),format: 'PDF',items: [{ format: 'LINKEDIN_CAROUSEL_VISUAL',revisionId: visualRevision.id,reviewCounter: approvedVisual.composition!.revisions.find(row => row.id === visualRevision.id)!.reviewCounter }] });
      await writingWorker.process({ jobId: pdf.jobId,ordinal: 1 });
      expect(await health.prisma.job.findUniqueOrThrow({ where: { id: pdf.jobId } })).toMatchObject({ status: 'SUCCEEDED' });
      const pdfRequest = await health.prisma.exportRequest.findUniqueOrThrow({ where: { id: pdf.exportId } });
      expect((pdfRequest.manifest as { sources: Array<{ kind: string;passageId: string }> }).sources).toContainEqual(expect.objectContaining({ kind: 'source_passage',passageId: source.id }));
      expect((await health.prisma.scriptRevision.findUniqueOrThrow({ where: { id: scriptVersion.id } })).approvedAt).toBeTruthy();
      expect((await exports.readiness(member.id,directProject.id)).ready).toBe(true);
      expect(await health.prisma.claim.count({ where: { projectId: directProject.id } })).toBe(0);
      expect(await health.prisma.factualBasisRevision.count({ where: { projectId: directProject.id } })).toBe(0);
      rejectFirstSection = true;
      const beforePartial = await health.prisma.article.findUniqueOrThrow({ where: { projectId: p.id } });
      const partialRequest = await articlePreparation.prepareArticle(owner.id,p.id,{ commandKey: randomUUID(),expectedRevision: beforePartial.revision });
      let partialState = await articlePreparation.get(owner.id,p.id,partialRequest.id);
      for (let step=0;step<16 && !['SUCCEEDED','FAILED'].includes(partialState.stage);step++) {
        await new Promise(resolve => setTimeout(resolve, 1600));
        await articlePreparation.pollOnce();
        const pending = await health.prisma.job.findMany({ where: { projectId: p.id,status: { in: ['QUEUED','RETRY_WAIT'] } }, orderBy: { createdAt: 'asc' } });
        for (const child of pending) await writingWorker.process({ jobId: child.id,ordinal: child.attemptCount+1 });
        partialState = await articlePreparation.get(owner.id,p.id,partialRequest.id);
      }
      expect(partialState).toMatchObject({ stage: 'FAILED',errorCategory: 'PARTIAL_ARTICLE',
        partialArticle: { missingSections: ['Робота транзакцій 1'] } });
      expect(JSON.stringify(partialState.partialArticle?.content)).toContain('source_evidence');
      expect(await health.prisma.article.findUnique({ where: { projectId: p.id } })).toEqual(beforePartial);
      expect(await health.prisma.articleVersion.count({ where: { projectId: p.id } })).toBe(1);
    } finally { await writingWorker.close(); await renderer.onModuleDestroy(); }
  });
});
