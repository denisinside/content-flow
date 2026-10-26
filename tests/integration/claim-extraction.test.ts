import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Pool } from 'pg';
import { DependencyHealthService, DurableJobService, DurableJobWorker, DifyClaimProvider, FactualBasisService,
  createClaimJobHandler, loadRuntimeConfig } from '@contextflow/backend';
import { AppModule } from '../../apps/api/src/app.module.js';
import { loadAuthConfig } from '../../apps/api/src/auth/auth-config.js';
import { AuthProvider } from '../../apps/api/src/auth/auth-provider.js';
import { SessionService } from '../../apps/api/src/auth/session-service.js';
import { CSRF_COOKIE, SESSION_COOKIE } from '../../apps/api/src/auth/csrf.js';
import { EXTERNAL_PROCESSING_NOTICE } from '../../apps/api/src/auth/external-processing.js';

type Identity = { id: string; cookie: string };
type Reply<T> = { response: Response; body: T };
type Extracted = { job: { id: string; status: string; errorCategory: string | null } };
const workflowId = 'b21081a2-114a-4ce9-91d8-21241a03b70c';
const configDigest = '48dcd646373cd896776ed639778ca72d3c5a54ccb88df1623693c31379bc8fda';
const readyReport = JSON.stringify({ schemaVersion: 'claims-extraction-report-v1', status: 'ready' });
const sourceText = 'Київ має населення 3 мільйони осіб.';
const hash = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex');

describe('Dify claims extraction over API, PostgreSQL and durable worker', () => {
  const config = loadRuntimeConfig();
  const authConfig = loadAuthConfig();
  const health = new DependencyHealthService(config);
  const auth = new AuthProvider(authConfig);
  const sessions = new SessionService(health.prisma, auth, authConfig);
  const sql = new Pool({ connectionString: config.directDatabaseUrl, ssl: false, max: 2 });
  const identities: Identity[] = [];
  let app!: NestExpressApplication;
  let baseUrl = '';
  let owner!: Identity;
  let member!: Identity;
  let foreign!: Identity;
  let workspaceId = '';
  let projectId = '';
  let worker: DurableJobWorker;
  let sentSources: unknown[] = [];
  let outputMode: 'valid' | 'forged' | 'foreign' | 'malformed' | 'blocked' | 'breakAfterId' | 'reviewBlocked' | 'large' | 'largeForgedLast' | 'empty' = 'valid';
  let lastRunId = '';
  let lastWorkflowOutput: unknown;
  let postStarted: (() => void) | undefined;
  const blockedPost = { release: () => {} };
  const service = new DurableJobService(health.prisma, { noticeVersion: EXTERNAL_PROCESSING_NOTICE.version });
  const facts = new FactualBasisService(health.prisma, service);

  const transport = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
    const url = _input instanceof Request ? _input.url : String(_input);
    if (url.includes('/workflows/run/')) return new Response(JSON.stringify({ id: lastRunId, workflow_id: workflowId, status: 'succeeded',
      outputs: { claims_json: JSON.stringify(lastWorkflowOutput), extraction_report: readyReport }, error: null }), { status: 200, headers: { 'content-type': 'application/json' } });
    const body = JSON.parse(String(init?.body)) as { inputs: { sources_json: string } };
    sentSources = JSON.parse(body.inputs.sources_json) as unknown[];
    const source = sentSources[0] as { snapshotId: string; fragments: Array<{ id: string; startOffset: number; endOffset: number; text: string }> };
    const fragment = source.fragments[0]!;
    const wording = `Твердження: ${fragment.text}`;
    const quote = outputMode === 'forged' ? 'це вигадана цитата' : fragment.text;
    const output: unknown = outputMode === 'empty' ? { schemaVersion: 'claims-v1', claims: [], conflicts: [] }
      : outputMode === 'malformed' ? { schemaVersion: 'claims-v1', claims: [{ key: 'claim-1', wording }], conflicts: [] }
      : outputMode === 'large' || outputMode === 'largeForgedLast' ? { schemaVersion: 'claims-v1', claims: Array.from({ length: 500 }, (_, index) => {
        const quote = outputMode === 'largeForgedLast' && index === 499 ? 'підроблена цитата' : fragment.text;
        return { key: `claim-${index}`, wording: `Синтетичне перевірене твердження ${index}: ${fragment.text}`,
          evidence: [{ snapshotId: source.snapshotId, fragmentId: fragment.id, startOffset: fragment.startOffset, endOffset: fragment.endOffset,
            quote, sha256: hash(quote), relation: 'SUPPORTS' }] };
      }), conflicts: [] }
      : { schemaVersion: 'claims-v1', claims: [{ key: 'claim-1', wording,
        evidence: [{ snapshotId: outputMode === 'foreign' ? randomUUID() : source.snapshotId, fragmentId: fragment.id,
          startOffset: fragment.startOffset, endOffset: fragment.endOffset, quote, sha256: hash(quote), relation: 'SUPPORTS' }] }], conflicts: [] };
    lastWorkflowOutput = output;
    lastRunId = randomUUID();
    const providerRunId = lastRunId;
    const started = `data: ${JSON.stringify({ event: 'workflow_started', workflow_run_id: providerRunId })}\r\n\r\n`;
    const finished = `data: ${JSON.stringify({ event: 'workflow_finished', workflow_run_id: providerRunId,
      data: { workflow_id: workflowId, status: 'succeeded', outputs: { claims_json: JSON.stringify(output),
        extraction_report: outputMode === 'reviewBlocked' ? JSON.stringify({ schemaVersion: 'claims-extraction-report-v1', status: 'needs_human' }) : readyReport } } })}\r\n\r\n`;
    if (outputMode === 'breakAfterId') return new Response(new ReadableStream<Uint8Array>({ start(controller) {
      controller.enqueue(new TextEncoder().encode(started));
    }, pull(controller) {
      controller.error(new TypeError('synthetic dropped stream'));
    } }), { status: 200, headers: { 'content-type': 'text/event-stream' } });
    if (outputMode === 'blocked') {
      postStarted?.();
      await new Promise<void>(resolve => { blockedPost.release = resolve; });
    }
    return new Response(new ReadableStream<Uint8Array>({ start(controller) {
      controller.enqueue(new TextEncoder().encode(started));
      controller.enqueue(new TextEncoder().encode(finished));
      controller.close();
    } }), { status: 200, headers: { 'content-type': 'text/event-stream' } });
  });

  async function identity(label: string): Promise<Identity> {
    const email = `cf-claim-${randomUUID()}@example.test`;
    const session = await auth.register(email, randomBytes(24).toString('base64url'), label);
    if (!session) throw new Error('TEST identity provider did not create an account');
    const local = await sessions.create(session, label);
    const result = { id: session.identity.id, cookie: local.cookie };
    identities.push(result);
    return result;
  }
  async function csrf(user: Identity) {
    const response = await fetch(baseUrl + '/api/auth/session', { headers: { Cookie: `${SESSION_COOKIE}=${user.cookie}` } });
    if (!response.ok) throw new Error('Could not get a CSRF token');
    const body = await response.json() as { csrfToken: string };
    const cookie = response.headers.getSetCookie().find(value => value.startsWith(CSRF_COOKIE + '='))?.split(';', 1)[0];
    if (!cookie) throw new Error('Session endpoint did not issue its CSRF cookie');
    return { token: body.csrfToken, cookie };
  }
  async function request<T = unknown>(user: Identity | undefined, method: string, path: string, body?: unknown): Promise<Reply<T>> {
    const headers = new Headers();
    if (user) headers.set('Cookie', `${SESSION_COOKIE}=${user.cookie}`);
    let requestBody: BodyInit | undefined;
    if (body !== undefined) { headers.set('Content-Type', 'application/json'); requestBody = JSON.stringify(body); }
    if (method !== 'GET') {
      if (!user) throw new Error('Mutation requires identity');
      const protection = await csrf(user);
      headers.set('Cookie', `${SESSION_COOKIE}=${user.cookie}; ${protection.cookie}`);
      headers.set('x-csrf-token', protection.token);
      headers.set('Origin', authConfig.webOrigin);
    }
    const response = await fetch(baseUrl + path, { method, headers, ...(requestBody ? { body: requestBody } : {}) });
    return { response, body: await response.json().catch(() => ({})) as T };
  }
  const extractPath = () => `/api/v1/projects/${projectId}/claims/extract`;
  async function startExtraction(user = owner): Promise<Extracted> {
    const result = await request<Extracted>(user, 'POST', extractPath(), { commandKey: randomUUID() });
    expect(result.response.status).toBe(201);
    return result.body;
  }
  async function run(jobId: string): Promise<void> { await worker.process({ jobId, ordinal: 1 }); }

  beforeAll(async () => {
    vi.stubEnv('DIFY_API_BASE_URL', 'https://dify.example.test/v1');
    vi.stubEnv('DIFY_CLAIM_EXTRACTION_PUBLISHED_WORKFLOW_ID', workflowId);
    vi.stubEnv('DIFY_CLAIM_EXTRACTION_CONFIG_SHA256', configDigest);
    vi.stubEnv('DIFY_CLAIM_EXTRACTION_API_KEY', 'synthetic-claim-key');
    expect((await health.check()).status).toBe('ready');
    app = await NestFactory.create<NestExpressApplication>(AppModule, { logger: false });
    app.useBodyParser('json', { limit: '1mb' }); await app.init(); await app.listen(0, '127.0.0.1');
    const address = app.getHttpServer().address(); if (!address || typeof address === 'string') throw new Error('API did not bind');
    baseUrl = `http://127.0.0.1:${address.port}`;
    owner = await identity('Claim owner'); member = await identity('Claim member'); foreign = await identity('Foreign user');
    const workspace = await health.prisma.workspace.create({ data: { ownerId: owner.id, name: 'Claims TEST workspace',
      members: { create: [{ userId: owner.id }, { userId: member.id }] } } }); workspaceId = workspace.id;
    const project = await health.prisma.project.create({ data: { workspaceId, createdBy: owner.id, topic: 'Claims TEST project', formats: ['TELEGRAM_POST'] } }); projectId = project.id;
    for (const user of [owner, member]) await request(user, 'POST', '/api/auth/external-processing', { noticeVersion: EXTERNAL_PROCESSING_NOTICE.version });
    await request(owner, 'POST', `/api/v1/projects/${projectId}/materials`, { label: 'Included source', purpose: 'FACTUAL_SOURCE', text: sourceText });
    await request(owner, 'POST', `/api/v1/projects/${projectId}/materials`, { label: 'Brand reference', purpose: 'BRANDBOOK', text: 'This is presentation guidance, not factual evidence.' });
    await request(owner, 'POST', `/api/v1/projects/${projectId}/materials`, { label: 'Unchecked notes', purpose: 'NOTES', text: 'An unchecked number: 999.' });
    worker = new DurableJobWorker(health.prisma, config.redisUrl, EXTERNAL_PROCESSING_NOTICE.version,
      [createClaimJobHandler({ prisma: health.prisma, factualBasis: facts, provider: new DifyClaimProvider(transport) })],
      { queueName: 'cf-claims-extract-' + randomUUID() });
    await worker.queue.waitUntilReady();
  });

  afterAll(async () => {
    await worker?.close();
    if (projectId) {
      const client = await sql.connect();
      try {
        await client.query('BEGIN');
        await client.query('DELETE FROM contextflow."BasisClaimEvidence" WHERE "projectId"=$1', [projectId]);
        await client.query('DELETE FROM contextflow."BasisClaim" WHERE "projectId"=$1', [projectId]);
        await client.query('DELETE FROM contextflow."FactualBasisRevision" WHERE "projectId"=$1', [projectId]);
        await client.query('DELETE FROM contextflow."ConflictResolutionEvidence" WHERE "projectId"=$1', [projectId]);
        await client.query('DELETE FROM contextflow."ClaimConflictParticipant" WHERE "projectId"=$1', [projectId]);
        await client.query('DELETE FROM contextflow."ClaimConflict" WHERE "projectId"=$1', [projectId]);
        await client.query('DELETE FROM contextflow."ClaimEvidence" WHERE "projectId"=$1', [projectId]);
        await client.query('UPDATE contextflow."Claim" SET "currentRevisionId"=NULL,"revision"="revision"+1 WHERE "projectId"=$1', [projectId]);
        await client.query('DELETE FROM contextflow."ClaimRevision" WHERE "projectId"=$1', [projectId]);
        await client.query('DELETE FROM contextflow."Claim" WHERE "projectId"=$1', [projectId]);
        await client.query('DELETE FROM contextflow."AIExecution" WHERE "projectId"=$1', [projectId]);
        await client.query('DELETE FROM contextflow."JobAttempt" WHERE "jobId" IN (SELECT id FROM contextflow."Job" WHERE "projectId"=$1)', [projectId]);
        await client.query('DELETE FROM contextflow."Job" WHERE "projectId"=$1', [projectId]);
        await client.query('DELETE FROM contextflow."SourceFragment" WHERE "projectId"=$1', [projectId]);
        await client.query('UPDATE contextflow."Material" SET "currentSnapshotId"=NULL,"revision"="revision"+1 WHERE "projectId"=$1', [projectId]);
        await client.query('DELETE FROM contextflow."SourceSnapshot" WHERE "projectId"=$1', [projectId]);
        await client.query('DELETE FROM contextflow."Material" WHERE "projectId"=$1', [projectId]);
        await client.query('DELETE FROM contextflow."Project" WHERE "id"=$1', [projectId]);
        await client.query('COMMIT');
      } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
    }
    if (workspaceId) {
      await health.prisma.workspaceMember.deleteMany({ where: { workspaceId } });
      await health.prisma.workspace.delete({ where: { id: workspaceId } });
    }
    const userIds = identities.map(user => user.id);
    await health.prisma.appSession.deleteMany({ where: { userId: { in: userIds } } });
    await health.prisma.userProfile.deleteMany({ where: { id: { in: userIds } } });
    for (const user of identities) {
      const secret = process.env['TEST_SUPABASE_SECRET_KEY'] ?? '';
      const response = await fetch(authConfig.providerUrl + '/auth/v1/admin/users/' + user.id, { method: 'DELETE', headers: { apikey: secret, Authorization: `Bearer ${secret}` } });
      if (!response.ok) throw new Error('Synthetic account cleanup failed');
    }
    await app?.close(); await sql.end(); await health.onModuleDestroy(); vi.unstubAllEnvs();
  });

  it('serves authenticated claim, conflict and mode-aware basis prerequisites for a new Project', async () => {
    for (const route of ['/claims', '/conflicts', '/basis?mode=FACTUAL', '/basis?mode=CREATIVE']) {
      const result = await request(member, 'GET', `/api/v1/projects/${projectId}${route}`);
      expect(result.response.status, JSON.stringify({ route, body: result.body })).toBe(200);
      if (route.endsWith('FACTUAL')) expect(result.body).toMatchObject({ mode: 'FACTUAL', basis: null, missingBasis: true });
      if (route.endsWith('CREATIVE')) expect(result.body).toMatchObject({ mode: 'CREATIVE', basis: null, missingBasis: false, unverified: true });
    }
  });

  it('freezes only included factual fragments and atomically stores an unapproved, evidence-linked candidate plus run metadata', async () => {
    outputMode = 'valid';
    const job = await startExtraction(member); await run(job.job.id);
    expect((await request(foreign, 'GET', `/api/v1/projects/${projectId}/claims`)).response.status).toBe(404);
    const saved = await health.prisma.job.findUniqueOrThrow({ where: { id: job.job.id } });
    expect(saved.status).toBe('SUCCEEDED');
    expect(saved.deadlineAt.getTime() - saved.createdAt.getTime()).toBe(3_600_000);
    const manifest = saved.inputManifest as { snapshots: Array<{ materialId: string; snapshotId: string; fragments: Array<{ id: string }> }> };
    expect(manifest.snapshots).toHaveLength(1);
    expect(sentSources).toHaveLength(1);
    expect((sentSources[0] as { fragments: Array<{ text: string }> }).fragments[0]?.text).toBe(sourceText);
    const candidate = await health.prisma.claim.findFirstOrThrow({ where: { projectId }, include: { currentRevision: { include: { evidence: true } } } });
    expect(candidate.currentRevision).toMatchObject({ status: 'PROPOSED', approvedBy: null, approvedAt: null });
    expect(candidate.currentRevision?.evidence).toHaveLength(1);
    expect(candidate.currentRevision?.evidence[0]).toMatchObject({ snapshotId: manifest.snapshots[0]?.snapshotId, relation: 'SUPPORTS', quote: sourceText });
    const execution = await health.prisma.aIExecution.findFirstOrThrow({ where: { jobId: job.job.id } });
    expect(execution).toMatchObject({ status: 'SUCCEEDED', provider: 'dify', providerRunId: expect.any(String), model: null,
      releaseId: 'claim-extraction-2026-10-14.3', configDigest });
    expect(JSON.stringify(execution.inputManifest)).not.toContain('synthetic-claim-key');
  });

  it('accepts an empty candidate set without issuing empty bulk writes or changing canonical claims', async () => {
    outputMode = 'empty';
    const before = await health.prisma.claim.count({ where: { projectId } });
    const job = await startExtraction(); await run(job.job.id);
    expect(await health.prisma.job.findUniqueOrThrow({ where: { id: job.job.id } })).toMatchObject({ status: 'SUCCEEDED' });
    expect(await health.prisma.claim.count({ where: { projectId } })).toBe(before);
    expect(await health.prisma.claimRevision.count({ where: { projectId, jobId: job.job.id } })).toBe(0);
  });

  it('rejects malformed contracts, forged quotes and foreign IDs without inserting partial claims', async () => {
    for (const mode of ['malformed', 'forged', 'foreign'] as const) {
      outputMode = mode;
      const job = await startExtraction(); await run(job.job.id);
      expect(await health.prisma.job.findUniqueOrThrow({ where: { id: job.job.id } })).toMatchObject({ status: 'FAILED', errorCategory: 'INVALID_CONTRACT' });
      expect(await health.prisma.claim.count({ where: { projectId } })).toBe(1);
      expect(await health.prisma.claimConflict.count({ where: { projectId } })).toBe(0);
      const execution = await health.prisma.aIExecution.findFirstOrThrow({ where: { jobId: job.job.id } });
      expect(execution.status).toBe('FAILED');
    }
  });

  it('resumes a captured run after its streaming connection drops without submitting again', async () => {
    outputMode = 'breakAfterId';
    const beforePosts = transport.mock.calls.filter(([url]) => String(url).includes('/workflows/') && !String(url).includes('/workflows/run/')).length;
    const beforeGets = transport.mock.calls.filter(([url]) => String(url).includes('/workflows/run/')).length;
    const job = await startExtraction(); await run(job.job.id);
    const afterPosts = transport.mock.calls.filter(([url]) => String(url).includes('/workflows/') && !String(url).includes('/workflows/run/')).length;
    const afterGets = transport.mock.calls.filter(([url]) => String(url).includes('/workflows/run/')).length;
    expect(afterPosts - beforePosts).toBe(1);
    expect(afterGets - beforeGets).toBe(1);
    expect(await health.prisma.job.findUniqueOrThrow({ where: { id: job.job.id } })).toMatchObject({ status: 'SUCCEEDED' });
    expect(await health.prisma.aIExecution.findFirstOrThrow({ where: { jobId: job.job.id } })).toMatchObject({ status: 'SUCCEEDED', providerRunId: lastRunId });
    expect(await health.prisma.claim.count({ where: { projectId } })).toBe(2);
  });

  it('fails a nonready extraction report without storing otherwise valid candidates', async () => {
    outputMode = 'reviewBlocked';
    const before = await health.prisma.claim.count({ where: { projectId } });
    const job = await startExtraction(); await run(job.job.id);
    expect(await health.prisma.job.findUniqueOrThrow({ where: { id: job.job.id } }))
      .toMatchObject({ status: 'FAILED', errorCategory: 'PROVIDER_FAILED', providerOutcome: 'KNOWN_FAILED' });
    expect(await health.prisma.claim.count({ where: { projectId } })).toBe(before);
    expect(await health.prisma.aIExecution.findFirstOrThrow({ where: { jobId: job.job.id } }))
      .toMatchObject({ status: 'FAILED', errorCategory: 'PROVIDER_FAILED', providerRunId: lastRunId });
  });

  it('fences cancellation after submission so late Dify output creates no canonical candidate', async () => {
    outputMode = 'blocked'; blockedPost.release = () => {};
    const cancelled = await startExtraction();
    const started = new Promise<void>(resolve => { postStarted = resolve; });
    const processing = run(cancelled.job.id);
    await started;
    const cancellation = await request(owner, 'POST', `/api/v1/projects/${projectId}/jobs/${cancelled.job.id}/cancel`);
    expect(cancellation.response.status).toBe(201);
    blockedPost.release();
    await processing;
    expect(await health.prisma.job.findUniqueOrThrow({ where: { id: cancelled.job.id } })).toMatchObject({ status: 'CANCELLED' });
    expect(await health.prisma.claim.count({ where: { projectId } })).toBe(2);
    const execution = await health.prisma.aIExecution.findFirstOrThrow({ where: { jobId: cancelled.job.id } });
    expect(['FAILED', 'OUTCOME_UNKNOWN']).toContain(execution.status);
  });

  it('fences a late result when Workspace membership is removed during provider work', async () => {
    outputMode = 'blocked'; postStarted = undefined; blockedPost.release = () => {};
    const submitted = await startExtraction(member);
    const started = new Promise<void>(resolve => { postStarted = resolve; });
    const processing = run(submitted.job.id);
    await started;
    await health.prisma.workspaceMember.update({ where: { workspaceId_userId: { workspaceId, userId: member.id } }, data: { leftAt: new Date() } });
    blockedPost.release(); await processing;
    const outcome = await health.prisma.job.findUniqueOrThrow({ where: { id: submitted.job.id } });
    if (outcome.errorCategory !== 'ACCESS_REVOKED') {
      const [attempt, execution] = await Promise.all([health.prisma.jobAttempt.findFirstOrThrow({ where: { jobId: submitted.job.id } }),
        health.prisma.aIExecution.findFirstOrThrow({ where: { jobId: submitted.job.id } })]);
      throw new Error(JSON.stringify({ job: { status: outcome.status, errorCategory: outcome.errorCategory, providerOutcome: outcome.providerOutcome },
        attempt: { errorCategory: attempt.errorCategory, providerOutcome: attempt.providerOutcome, providerRunId: attempt.providerRunId },
        execution: { status: execution.status, errorCategory: execution.errorCategory, providerRunId: execution.providerRunId } }));
    }
    expect(outcome).toMatchObject({ status: 'OUTCOME_UNKNOWN', errorCategory: 'ACCESS_REVOKED' });
    expect(await health.prisma.claim.count({ where: { projectId } })).toBe(2);
    expect(await health.prisma.aIExecution.findFirstOrThrow({ where: { jobId: submitted.job.id } })).toMatchObject({ status: 'OUTCOME_UNKNOWN', errorCategory: 'ACCESS_REVOKED' });
  });

  it('rejects forged evidence on the final row of a 500-candidate output without partial inserts', async () => {
    outputMode = 'largeForgedLast';
    const before = await health.prisma.claim.count({ where: { projectId } });
    const job = await startExtraction(owner); await run(job.job.id);
    expect(await health.prisma.job.findUniqueOrThrow({ where: { id: job.job.id } }))
      .toMatchObject({ status: 'FAILED', errorCategory: 'INVALID_CONTRACT', providerOutcome: 'KNOWN_SUCCEEDED' });
    expect(await health.prisma.claim.count({ where: { projectId } })).toBe(before);
    expect(await health.prisma.claimRevision.count({ where: { projectId, jobId: job.job.id } })).toBe(0);
  });

  it('atomically commits 500 synthetic proposals, keeps them unapproved, then freezes a valid 500-claim basis after review', async () => {
    outputMode = 'large';
    const job = await startExtraction(owner); await run(job.job.id);
    expect(await health.prisma.job.findUniqueOrThrow({ where: { id: job.job.id } })).toMatchObject({ status: 'SUCCEEDED' });
    const proposals = await health.prisma.claim.findMany({ where: { projectId, currentRevision: { jobId: job.job.id } },
      include: { currentRevision: { include: { evidence: true } } } });
    expect(proposals).toHaveLength(500);
    for (const proposal of proposals) {
      expect(proposal.currentRevision).toMatchObject({ status: 'PROPOSED', approvedBy: null, approvedAt: null });
      expect(proposal.currentRevision?.evidence).toHaveLength(1);
      expect(proposal.currentRevision?.evidence[0]).toMatchObject({ relation: 'SUPPORTS', quote: sourceText, capturedPurpose: 'FACTUAL_SOURCE' });
    }

    for (const proposal of proposals) await facts.review(owner.id, projectId, proposal.id, proposal.currentRevisionId!, 'approve', { expectedRevision: 1 });
    const revisionIds = proposals.map(proposal => proposal.currentRevisionId!);
    const frozenInput = { claimRevisionIds: revisionIds };
    expect(revisionIds).toHaveLength(500);
    const frozenReply = await request<{ basis: { id: string; valid: boolean; manifest: unknown } }>(owner, 'POST', `/api/v1/projects/${projectId}/basis`, frozenInput);
    expect(frozenReply.response.status, JSON.stringify(frozenReply.body)).toBe(201);
    const frozen = frozenReply.body;
    expect(frozen.basis).toMatchObject({ valid: true, manifest: { claims: expect.any(Array) } });
    expect((frozen.basis.manifest as { claims: unknown[] }).claims).toHaveLength(500);
    expect(await health.prisma.basisClaim.count({ where: { projectId, basisId: frozen.basis.id } })).toBe(500);
  }, 180_000);
});
