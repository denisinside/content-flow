import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { DependencyHealthService, DurableJobService, DurableJobWorker, DifyArticleProvider, ArticleService, EditorialService, FactualBasisService,
  createArticleJobHandler, loadRuntimeConfig, type ArticleProviderInput, type ArticleInputManifest, type SaveBriefInput } from '@contextflow/backend';
import { AppModule } from '../../apps/api/src/app.module.js';
import { loadAuthConfig } from '../../apps/api/src/auth/auth-config.js';
import { AuthProvider } from '../../apps/api/src/auth/auth-provider.js';
import { SessionService } from '../../apps/api/src/auth/session-service.js';
import { CSRF_COOKIE, SESSION_COOKIE } from '../../apps/api/src/auth/csrf.js';
import { EXTERNAL_PROCESSING_NOTICE } from '../../apps/api/src/auth/external-processing.js';

type Identity = { id: string; cookie: string };
type State = Awaited<ReturnType<ArticleService['get']>>;
type Generated = { job: { id: string } };
const workflowId = '186937fe-674d-469e-a0d9-141c0ef3dc39';
const descriptor = JSON.parse(readFileSync(new URL('../../packages/backend/src/editorial/workflows/article-generation/release.json', import.meta.url), 'utf8')) as { configDigest: string; releaseId: string };
const hash = (text: string) => createHash('sha256').update(text).digest('hex');

describe('article API, pinned Dify SSE provider and durable candidate persistence', () => {
  const config = loadRuntimeConfig(), authConfig = loadAuthConfig(), health = new DependencyHealthService(config);
  const auth = new AuthProvider(authConfig), sessions = new SessionService(health.prisma, auth, authConfig);
  const sql = new Pool({ connectionString: config.directDatabaseUrl, ssl: false, max: 2 });
  const jobs = new DurableJobService(health.prisma, { noticeVersion: EXTERNAL_PROCESSING_NOTICE.version });
  const facts = new FactualBasisService(health.prisma, jobs), editorial = new EditorialService(health.prisma, jobs, facts), articles = new ArticleService(health.prisma, jobs, facts);
  const identities: Identity[] = [], projects: string[] = [];
  let app!: NestExpressApplication, worker!: DurableJobWorker, baseUrl = '', workspaceId = '', factualProject = '', creativeProject = '';
  let owner!: Identity, member!: Identity, outsider!: Identity, requiredClaim = '';
  let notesSnapshot = '', excludedSnapshot = '', suppliedSnapshot = '', extraFactSnapshot = '';
  let mode: 'valid' | 'malformed' | 'foreign' | 'missingRequired' | 'wrongRelease' | 'brokenStream' | 'blocked' | 'invalidateBeforeSubmit' = 'valid';
  let sent!: ArticleProviderInput, lastOutput: unknown, lastRunId = '';
  let postStarted: (() => void) | undefined;
  const blocker = { release: () => {} };
  const transport = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url.includes('/workflows/run/')) return new Response(JSON.stringify({ id: lastRunId, workflow_id: workflowId, status: 'succeeded',
      outputs: { article_json: JSON.stringify(lastOutput) }, error: null }), { status: 200, headers: { 'content-type': 'application/json' } });
    const body = JSON.parse(String(init?.body)) as { inputs: { editorial_json: string }; response_mode: string };
    expect(body.response_mode).toBe('streaming'); sent = JSON.parse(body.inputs.editorial_json) as ArticleProviderInput;
    const cited = sent.claims.flatMap(claim => claim.evidence.slice(0, 1).map(evidence => ({ claimRevisionId: claim.claimRevisionId, evidenceId: mode === 'foreign' ? randomUUID() : evidence.evidenceId, quote: claim.wording })));
    const paragraphs = sent.contentMode === 'FACTUAL' && mode !== 'missingRequired' ? cited.map(attrs => ({ type: 'paragraph', content: [{ type: 'text', text: attrs.quote, marks: [{ type: 'evidence', attrs }] }] })) : [{ type: 'paragraph', content: [{ type: 'text', text: 'Авторський погляд на тему.' }] }];
    lastOutput = { schemaVersion: 'article-v1', content: { title: 'Кандидат статті', document: { type: 'doc', content: mode === 'malformed' ? [{ type: 'script', text: 'forbidden' }] : paragraphs } } };
    lastRunId = randomUUID();
    const started = `data: ${JSON.stringify({ event: 'workflow_started', workflow_run_id: lastRunId })}\r\n\r\n`;
    const finished = `data: ${JSON.stringify({ event: 'workflow_finished', workflow_run_id: lastRunId,
      data: { workflow_id: mode === 'wrongRelease' ? randomUUID() : workflowId, status: 'succeeded', outputs: { article_json: JSON.stringify(lastOutput) } } })}\r\n\r\n`;
    if (mode === 'brokenStream') return new Response(new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new TextEncoder().encode(started)); },
      pull(controller) { controller.error(new TypeError('Synthetic disconnected stream')); } }), { headers: { 'content-type': 'text/event-stream' } });
    if (mode === 'blocked') { postStarted?.(); await new Promise<void>(resolve => { blocker.release = resolve; }); }
    return new Response(new ReadableStream<Uint8Array>({ start(controller) {
      controller.enqueue(new TextEncoder().encode(started)); controller.enqueue(new TextEncoder().encode(finished)); controller.close();
    } }), { headers: { 'content-type': 'text/event-stream' } });
  });
  async function identity(label: string): Promise<Identity> {
    const account = await auth.register(`cf-outline-${randomUUID()}@example.test`, randomBytes(24).toString('base64url'), label);
    if (!account) throw new Error('TEST account creation failed');
    const session = await sessions.create(account, label), result = { id: account.identity.id, cookie: session.cookie };
    identities.push(result); return result;
  }
  async function request<T = unknown>(user: Identity, method: string, path: string, body?: unknown) {
    const headers = new Headers({ Cookie: `${SESSION_COOKIE}=${user.cookie}` });
    if (method !== 'GET') {
      const session = await fetch(baseUrl + '/api/auth/session', { headers });
      const protection = await session.json() as { csrfToken: string };
      const cookie = session.headers.getSetCookie().find(value => value.startsWith(CSRF_COOKIE + '='))?.split(';', 1)[0];
      if (!cookie) throw new Error('CSRF cookie missing');
      headers.set('Cookie', `${SESSION_COOKIE}=${user.cookie}; ${cookie}`); headers.set('x-csrf-token', protection.csrfToken); headers.set('Origin', authConfig.webOrigin);
    }
    if (body !== undefined) headers.set('Content-Type', 'application/json');
    const response = await fetch(baseUrl + path, { method, headers, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    return { response, body: await response.json().catch(() => ({})) as T };
  }
  const path = (project: string, route: string) => `/api/v1/projects/${project}/${route}`;
  const brief = (contentMode: 'FACTUAL' | 'CREATIVE', expectedRevision: number, topic = 'Український контекст'): SaveBriefInput => ({ expectedRevision, contentMode,
    topic, audience: 'Читачі', centralMessage: 'Пояснити тему', category: 'Освіта', targetLength: 1000, cta: '', exclusions: [], notes: 'Авторська думка',
    requiredClaimRevisionIds: contentMode === 'FACTUAL' ? [requiredClaim] : [] });
  async function start(project: string, user = owner) {
    const state = await articles.get(user.id, project);
    const response = await request<Generated>(user, 'POST', path(project, 'article/generate'), { commandKey: randomUUID(), expectedRevision: state.article?.revision ?? 0 });
    expect(response.response.status, JSON.stringify(response.body)).toBe(201); return response.body.job.id;
  }
  async function material(project: string, label: string, purpose: 'FACTUAL_SOURCE' | 'NOTES' | 'STYLE_SAMPLE' | 'SUPPLIED_ARTICLE', included = true) {
    const response = await request(owner, 'POST', path(project, 'materials'), { label, purpose, text: label });
    expect(response.response.status).toBe(201);
    const row = await health.prisma.material.findFirstOrThrow({ where: { projectId: project, label }, include: { currentSnapshot: { include: { fragments: true } } } });
    if (!included) await health.prisma.material.update({ where: { id: row.id }, data: { included: false, revision: { increment: 1 }, updatedAt: new Date() } });
    return row;
  }
  beforeAll(async () => {
    vi.stubEnv('TEST_DIFY_API_BASE_URL', 'https://dify.example.test/v1');
    vi.stubEnv('TEST_DIFY_ARTICLE_GENERATION_PUBLISHED_WORKFLOW_ID', workflowId);
    vi.stubEnv('TEST_DIFY_ARTICLE_GENERATION_CONFIG_SHA256', descriptor.configDigest);
    vi.stubEnv('TEST_DIFY_ARTICLE_GENERATION_API_KEY', 'synthetic-outline-key');
    expect((await health.check()).status).toBe('ready');
    app = await NestFactory.create<NestExpressApplication>(AppModule, { logger: false });
    app.useBodyParser('json', { limit: '1mb' }); await app.init(); await app.listen(0, '127.0.0.1');
    const address = app.getHttpServer().address(); if (!address || typeof address === 'string') throw new Error('API did not bind');
    baseUrl = `http://127.0.0.1:${address.port}`;
    owner = await identity('Outline owner'); member = await identity('Outline member'); outsider = await identity('Outline outsider');
    const workspace = await health.prisma.workspace.create({ data: { name: 'Outline TEST', ownerId: owner.id,
      members: { create: [{ userId: owner.id }, { userId: member.id }] }, styles: { create: { revision: 1, tone: 'Спокійний', brandbook: 'Точні слова', createdBy: owner.id } } } }); workspaceId = workspace.id;
    for (const topic of ['Factual outline', 'Creative outline']) {
      const project = await health.prisma.project.create({ data: { workspaceId, createdBy: owner.id, topic, formats: ['ARTICLE'] } }); projects.push(project.id);
    }
    [factualProject, creativeProject] = [projects[0]!, projects[1]!];
    for (const user of [owner, member]) expect((await request(user, 'POST', '/api/auth/external-processing', { noticeVersion: EXTERNAL_PROCESSING_NOTICE.version })).response.ok).toBe(true);
    const source = await material(factualProject, 'Перевірене фактичне джерело.', 'FACTUAL_SOURCE'), snapshot = source.currentSnapshot!, fragment = snapshot.fragments[0]!;
    const claim = await facts.create(owner.id, factualProject, { wording: 'Перевірене твердження', evidence: [{ snapshotId: snapshot.id, fragmentId: fragment.id,
      startOffset: fragment.startOffset, endOffset: fragment.endOffset, quote: snapshot.normalizedText, sha256: hash(snapshot.normalizedText), relation: 'SUPPORTS' }] });
    requiredClaim = claim.claim.currentRevision!.id;
    await facts.review(owner.id, factualProject, claim.claim.id, requiredClaim, 'approve', { expectedRevision: claim.claim.revision });
    await facts.freezeBasis(owner.id, factualProject, { claimRevisionIds: [requiredClaim] });
    notesSnapshot = (await material(factualProject, 'Контекстні нотатки без перевірених фактів.', 'NOTES')).currentSnapshotId!;
    excludedSnapshot = (await material(factualProject, 'Виключений матеріал.', 'NOTES', false)).currentSnapshotId!;
    suppliedSnapshot = (await material(factualProject, 'Готова стаття.', 'SUPPLIED_ARTICLE')).currentSnapshotId!;
    extraFactSnapshot = (await material(factualProject, 'Не входить у затверджену фактологічну базу.', 'FACTUAL_SOURCE')).currentSnapshotId!;
    await material(creativeProject, 'Зразок авторського стилю.', 'STYLE_SAMPLE');
    for (const [project, contentMode] of [[factualProject, 'FACTUAL'], [creativeProject, 'CREATIVE']] as const) {
      expect((await request(owner, 'POST', path(project, 'brief'), brief(contentMode, 0))).response.status).toBe(201);
    }
    for (const project of [factualProject, creativeProject]) {
      const state = await editorial.get(owner.id, project);
      const manual = await editorial.manualOutline(owner.id, project, { expectedRevision: 0, briefRevisionId: state.brief!.currentRevision!.id,
        content: { title: 'Погоджена структура', sections: [{ title: 'Вступ', purpose: 'Пояснити тему', claimRevisionIds: project === factualProject ? [requiredClaim] : [] }] } });
      await editorial.reviewOutline(owner.id, project, manual.outline!.currentRevision!.id, 'approve', { expectedRevision: manual.outline!.revision });
    }
    const provider = new DifyArticleProvider(transport);
    const controlledProvider = { async execute(...args: Parameters<DifyArticleProvider['execute']>) {
      if (mode === 'invalidateBeforeSubmit') {
        const claim = await health.prisma.claim.findFirstOrThrow({ where: { projectId: factualProject, currentRevisionId: requiredClaim }, include: { currentRevision: { include: { evidence: true } } } });
        await facts.invalidate(owner.id, factualProject, claim.id, claim.currentRevision!.evidence[0]!.id, { expectedRevision: claim.revision, reason: 'Invalidated after context preparation' });
      }
      return provider.execute(...args);
    }, resume: (...args: Parameters<DifyArticleProvider['resume']>) => provider.resume(...args) };
    worker = new DurableJobWorker(health.prisma, config.redisUrl, EXTERNAL_PROCESSING_NOTICE.version,
      [createArticleJobHandler({ prisma: health.prisma, editorial: articles, factualBasis: facts, provider: controlledProvider })],
      { queueName: 'cf-article-test-' + randomUUID() }); await worker.queue.waitUntilReady();
  });
  afterAll(async () => {
    blocker.release(); await worker?.close();
    if (workspaceId) {
      const client = await sql.connect();
      try {
        await client.query('BEGIN');
        const editorialTables = ['Brief', 'BriefRevision', 'BriefRequiredClaim', 'BriefContextSnapshot', 'Outline', 'OutlineRevision'];
        for (const table of editorialTables) await client.query(`ALTER TABLE contextflow."${table}" DISABLE TRIGGER "${table}_no_delete"`);
        await client.query('ALTER TABLE contextflow."Brief" DISABLE TRIGGER "Brief_pointer_guard"');
        const articleTables = ['Article', 'ArticleDraft', 'ArticleVersion', 'ArticleVersionClaim'];
        for (const table of articleTables) await client.query(`ALTER TABLE contextflow."${table}" DISABLE TRIGGER USER`);
        for (const project of projects) {
          await client.query('UPDATE contextflow."Article" SET "currentApprovedVersionId"=NULL WHERE "projectId"=$1', [project]);
          for (const table of ['ArticleDraft', 'ArticleVersionClaim', 'ArticleVersion', 'Article']) await client.query(`DELETE FROM contextflow."${table}" WHERE "projectId"=$1`, [project]);

          await client.query('UPDATE contextflow."Outline" SET "currentRevisionId"=NULL,"currentApprovedRevisionId"=NULL,"revision"="revision"+1 WHERE "projectId"=$1', [project]);
          await client.query('UPDATE contextflow."Brief" SET "currentRevisionId"=NULL,"revision"="revision"+1 WHERE "projectId"=$1', [project]);
          for (const table of ['OutlineRevision', 'Outline', 'BriefRequiredClaim', 'BriefContextSnapshot', 'BriefRevision', 'Brief', 'BasisClaimEvidence', 'BasisClaim', 'FactualBasisRevision', 'ClaimEvidence']) await client.query(`DELETE FROM contextflow."${table}" WHERE "projectId"=$1`, [project]);
          await client.query('UPDATE contextflow."Claim" SET "currentRevisionId"=NULL,"revision"="revision"+1 WHERE "projectId"=$1', [project]);
          for (const table of ['ClaimRevision', 'Claim', 'AIExecution']) await client.query(`DELETE FROM contextflow."${table}" WHERE "projectId"=$1`, [project]);
          await client.query('DELETE FROM contextflow."JobAttempt" WHERE "jobId" IN (SELECT "id" FROM contextflow."Job" WHERE "projectId"=$1)', [project]);
          await client.query('DELETE FROM contextflow."Job" WHERE "projectId"=$1', [project]);
          await client.query('UPDATE contextflow."Material" SET "currentSnapshotId"=NULL,"revision"="revision"+1 WHERE "projectId"=$1', [project]);
          for (const table of ['SourceFragment', 'SourceSnapshot', 'Material']) await client.query(`DELETE FROM contextflow."${table}" WHERE "projectId"=$1`, [project]);
          await client.query('DELETE FROM contextflow."Project" WHERE "id"=$1', [project]);
        }
        await client.query('DELETE FROM contextflow."WorkspaceStyleRevision" WHERE "workspaceId"=$1', [workspaceId]);
        for (const table of ['WorkspaceMember', 'Workspace']) await client.query(`DELETE FROM contextflow."${table}" WHERE "${table === 'Workspace' ? 'id' : 'workspaceId'}"=$1`, [workspaceId]);
        for (const table of editorialTables) await client.query(`ALTER TABLE contextflow."${table}" ENABLE TRIGGER "${table}_no_delete"`);
        await client.query('ALTER TABLE contextflow."Brief" ENABLE TRIGGER "Brief_pointer_guard"');
        for (const table of articleTables) await client.query(`ALTER TABLE contextflow."${table}" ENABLE TRIGGER USER`);
        await client.query('COMMIT');
      } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
    }
    const ids = identities.map(user => user.id);
    await health.prisma.appSession.deleteMany({ where: { userId: { in: ids } } }); await health.prisma.userProfile.deleteMany({ where: { id: { in: ids } } });
    for (const user of identities) {
      const secret = process.env['TEST_SUPABASE_SECRET_KEY'] ?? '';
      expect((await fetch(authConfig.providerUrl + '/auth/v1/admin/users/' + user.id, { method: 'DELETE', headers: { apikey: secret, Authorization: `Bearer ${secret}` } })).ok).toBe(true);
    }
    await app?.close(); await sql.end(); await health.onModuleDestroy(); vi.unstubAllEnvs();
  });
  it('freezes only approved factual claims and included captured context, preserving source roles', async () => {
    mode = 'valid';
    const id = await start(factualProject, member), job = await health.prisma.job.findUniqueOrThrow({ where: { id } });
    const manifest = job.inputManifest as unknown as ArticleInputManifest;
    expect(manifest).toMatchObject({ contentMode: 'FACTUAL', basisRevisionId: expect.any(String), basisHash: expect.any(String), contextSnapshotIds: [notesSnapshot] });
    const materialRow = await health.prisma.material.findFirstOrThrow({ where: { currentSnapshotId: notesSnapshot, projectId: factualProject } });
    await health.prisma.material.update({ where: { id: materialRow.id }, data: { purpose: 'FACTUAL_SOURCE', revision: { increment: 1 }, updatedAt: new Date() } });
    await worker.process({ jobId: id, ordinal: 1 });
    expect(sent).toMatchObject({ contentMode: 'FACTUAL', claims: [{ claimRevisionId: requiredClaim }], context: [{ snapshotId: notesSnapshot, purpose: 'NOTES' }] });
    for (const excluded of [excludedSnapshot, suppliedSnapshot, extraFactSnapshot]) expect(JSON.stringify(sent)).not.toContain(excluded);
    expect(await health.prisma.job.findUniqueOrThrow({ where: { id } })).toMatchObject({ status: 'SUCCEEDED' });
    expect(await health.prisma.article.findUniqueOrThrow({ where: { projectId: factualProject } })).toMatchObject({ revision: 0, currentApprovedVersionId: null });
    expect(await health.prisma.articleDraft.count({ where: { projectId: factualProject } })).toBe(0);
    expect(manifest).toMatchObject({ outlineRevisionId: expect.any(String), outlineHash: expect.any(String), articleRevision: 0 });
    expect(await health.prisma.aIExecution.findFirstOrThrow({ where: { jobId: id } })).toMatchObject({ status: 'SUCCEEDED', releaseId: descriptor.releaseId, configDigest: descriptor.configDigest, providerRunId: lastRunId });
    expect(JSON.stringify(job.inputManifest)).not.toContain('synthetic-outline-key');
    expect((await request(outsider, 'POST', path(factualProject, 'article/generate'), { commandKey: randomUUID(), expectedRevision: 0 })).response.status).toBe(404);
  });
  it('applies exact AI bytes explicitly and checkpoints later edits as a new manual version', async () => {
    const candidate = await health.prisma.articleVersion.findFirstOrThrow({ where: { projectId: factualProject, origin: 'AI' } });
    const before = await articles.get(owner.id, factualProject);
    const applied = await request<State>(owner, 'POST', path(factualProject, `article/${candidate.id}/apply`), { expectedRevision: before.article!.revision });
    expect(applied.response.status, JSON.stringify(applied.body)).toBe(201);
    expect(applied.body.article!.draft!.content).toEqual(candidate.content);
    const aiApproved = await request<State>(owner, 'POST', path(factualProject, `article/${candidate.id}/approve`), { expectedRevision: applied.body.article!.revision, acknowledgeUnmapped: true });
    expect(aiApproved.response.status, JSON.stringify(aiApproved.body)).toBe(201);
    const withdrawn = await request<State>(owner, 'POST', path(factualProject, `article/${candidate.id}/withdraw`), { expectedRevision: aiApproved.body.article!.revision });
    expect(withdrawn.response.status).toBe(201);
    const restored = await request<State>(owner, 'POST', path(factualProject, 'article/checkpoint'), { expectedRevision: withdrawn.body.article!.revision });
    expect(restored.response.status, JSON.stringify(restored.body)).toBe(201);
    expect(restored.body.article!.versions[0]!.origin).toBe('MANUAL');
    const content = structuredClone(candidate.content) as { title: string; document: unknown }; content.title = 'Ручний заголовок';
    const edited = await request<State>(owner, 'POST', path(factualProject, 'article/draft'), { expectedRevision: restored.body.article!.revision, contentMode: 'FACTUAL', content });
    expect(edited.response.status, JSON.stringify(edited.body)).toBe(201);
    const checkpoint = await request<State>(owner, 'POST', path(factualProject, 'article/checkpoint'), { expectedRevision: edited.body.article!.revision });
    expect(checkpoint.response.status, JSON.stringify(checkpoint.body)).toBe(201);
    const manual = await health.prisma.articleVersion.findFirstOrThrow({ where: { projectId: factualProject, origin: 'MANUAL' }, orderBy: { number: 'desc' } });
    expect(manual.content).toEqual(content); expect(manual.jobId).toBeNull();
    expect(await health.prisma.articleVersionClaim.count({ where: { articleVersionId: manual.id } })).toBe(1);
    const approved = await request<State>(owner, 'POST', path(factualProject, `article/${manual.id}/approve`), { expectedRevision: checkpoint.body.article!.revision, acknowledgeUnmapped: true });
    expect(approved.response.status, JSON.stringify(approved.body)).toBe(201);
    expect(approved.body.article!.currentApprovedVersionId).toBe(manual.id);
    expect(await health.prisma.articleVersion.findUniqueOrThrow({ where: { id: candidate.id } })).toMatchObject({ approvedAt: expect.any(Date), withdrawnAt: expect.any(Date) });
  });
  it('uses explicit creative mode without a factual basis or factual citations', async () => {
    mode = 'valid'; const id = await start(creativeProject); await worker.process({ jobId: id, ordinal: 1 });
    expect(sent).toMatchObject({ contentMode: 'CREATIVE', claims: [], context: [{ purpose: 'STYLE_SAMPLE' }] });
    expect((await health.prisma.job.findUniqueOrThrow({ where: { id } })).inputManifest).toMatchObject({ basisRevisionId: null, basisHash: null });
    expect(await health.prisma.articleVersion.findUniqueOrThrow({ where: { jobId: id } })).toMatchObject({ contentMode: 'CREATIVE', approvedAt: null });
  });
  it('fails malformed outputs, foreign fact IDs, omitted mandatory facts and wrong workflow versions atomically', async () => {
    const count = await health.prisma.articleVersion.count({ where: { projectId: factualProject } });
    for (const value of ['malformed', 'foreign', 'missingRequired', 'wrongRelease'] as const) {
      mode = value; const id = await start(factualProject); await worker.process({ jobId: id, ordinal: 1 });
      expect(await health.prisma.job.findUniqueOrThrow({ where: { id } })).toMatchObject({ status: 'FAILED', errorCategory: 'INVALID_CONTRACT' });
      expect(await health.prisma.articleVersion.count({ where: { projectId: factualProject } })).toBe(count);
      expect(await health.prisma.aIExecution.findFirstOrThrow({ where: { jobId: id } })).toMatchObject({ status: 'FAILED' });
    }
  });
  it('resumes a captured SSE run without a second provider submission', async () => {
    mode = 'brokenStream'; const posts = transport.mock.calls.filter(([, init]) => init?.method === 'POST').length;
    const id = await start(creativeProject); await worker.process({ jobId: id, ordinal: 1 });
    expect(transport.mock.calls.filter(([, init]) => init?.method === 'POST').length - posts).toBe(1);
    expect(transport.mock.calls.some(([url]) => String(url).endsWith('/' + lastRunId))).toBe(true);
    expect(await health.prisma.job.findUniqueOrThrow({ where: { id } })).toMatchObject({ status: 'SUCCEEDED' });
  });
  it('retains late manual edits while persisting AI output as an unapplied candidate', async () => {
    mode = 'blocked'; const id = await start(creativeProject), started = new Promise<void>(resolve => { postStarted = resolve; });
    const processing = worker.process({ jobId: id, ordinal: 1 }); await started;
    try {
      const before = await articles.get(owner.id, creativeProject);
      const content = { title: 'Ручна стаття', document: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Збережена ручна робота.' }] }] } };
      const edited = await request<State>(owner, 'POST', path(creativeProject, 'article/draft'), { expectedRevision: before.article?.revision ?? 0, contentMode: 'CREATIVE', content });
      expect(edited.response.status, JSON.stringify(edited.body)).toBe(201);
      blocker.release(); await processing;
      const after = await articles.get(member.id, creativeProject);
      expect(after.article!.draft!.content).toEqual(content);
      const candidate = await health.prisma.articleVersion.findUniqueOrThrow({ where: { jobId: id } });
      expect(candidate.sourceArticleRevision).toBe(before.article?.revision ?? 0);
      expect((await request(owner, 'POST', path(creativeProject, `article/${candidate.id}/apply`), { expectedRevision: after.article!.revision })).response.status).toBe(409);
      expect(after.article!.currentApprovedVersionId).toBeNull();
    } finally { blocker.release(); await processing; postStarted = undefined; }
  });
  it('fences a cancelled late response before it can persist an outline candidate', async () => {
    mode = 'blocked'; const id = await start(creativeProject), count = await health.prisma.articleVersion.count({ where: { projectId: creativeProject } });
    const started = new Promise<void>(resolve => { postStarted = resolve; }), processing = worker.process({ jobId: id, ordinal: 1 }); await started;
    try { expect((await request(owner, 'POST', path(creativeProject, `jobs/${id}/cancel`))).response.status).toBe(201); }
    finally { blocker.release(); await processing; postStarted = undefined; }
    expect(await health.prisma.job.findUniqueOrThrow({ where: { id } })).toMatchObject({ status: 'CANCELLED' });
    expect(await health.prisma.articleVersion.count({ where: { projectId: creativeProject } })).toBe(count);
    expect(await health.prisma.articleVersion.count({ where: { jobId: id } })).toBe(0);
  });
  it('fences a withdrawn outline during generation and blocks subsequent submissions', async () => {
    mode = 'blocked'; const id = await start(creativeProject), count = await health.prisma.articleVersion.count({ where: { projectId: creativeProject } });
    const started = new Promise<void>(resolve => { postStarted = resolve; }), processing = worker.process({ jobId: id, ordinal: 1 }); await started;
    try {
      const state = await editorial.get(owner.id, creativeProject);
      await editorial.reviewOutline(owner.id, creativeProject, state.outline!.currentRevision!.id, 'withdraw', { expectedRevision: state.outline!.revision });
    } finally { blocker.release(); await processing; postStarted = undefined; }
    expect((await health.prisma.job.findUniqueOrThrow({ where: { id } })).status).toBe('FAILED');
    expect(await health.prisma.articleVersion.count({ where: { projectId: creativeProject } })).toBe(count);
    const state = await articles.get(owner.id, creativeProject);
    expect((await request(owner, 'POST', path(creativeProject, 'article/generate'), { expectedRevision: state.article!.revision, commandKey: randomUUID() })).response.status).toBe(409);
  });
  it('revalidates evidence at submission intent after context preparation, before any provider call', async () => {
    mode = 'invalidateBeforeSubmit';
    const calls = transport.mock.calls.length, count = await health.prisma.articleVersion.count({ where: { projectId: factualProject } });
    const id = await start(factualProject); await worker.process({ jobId: id, ordinal: 1 });
    expect(transport.mock.calls).toHaveLength(calls);
    expect(await health.prisma.job.findUniqueOrThrow({ where: { id } })).toMatchObject({ status: 'FAILED', errorCategory: 'FACTUAL_BASIS_BLOCKED', providerOutcome: 'NOT_SUBMITTED' });
    expect(await health.prisma.articleVersion.count({ where: { projectId: factualProject } })).toBe(count);
    expect(await health.prisma.aIExecution.findFirstOrThrow({ where: { jobId: id } })).toMatchObject({ status: 'FAILED' });
  });
});
