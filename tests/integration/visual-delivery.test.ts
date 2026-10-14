import { randomBytes, randomUUID } from 'node:crypto';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { NestFactory } from '@nestjs/core';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Pool } from 'pg';
import { DependencyHealthService, DurableJobService, EditorialService, EXTERNAL_PROCESSING_NOTICE, FactualBasisService, loadRuntimeConfig, PrivateAssetStore, TelegramService, VisualService } from '@contextflow/backend';
import { AppModule } from '../../apps/api/src/app.module.js';
import { loadAuthConfig } from '../../apps/api/src/auth/auth-config.js';
import { AuthProvider, type ProviderSession } from '../../apps/api/src/auth/auth-provider.js';
import { SESSION_COOKIE } from '../../apps/api/src/auth/csrf.js';
import { SessionService } from '../../apps/api/src/auth/session-service.js';
import { tokenDigest } from '../../apps/api/src/auth/session-crypto.js';
import { compositionSchema } from '../../packages/visuals/src/index.js';

type Identity = { id: string; cookie: string; session: ProviderSession; email: string; password: string };
const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aD1sAAAAASUVORK5CYII=';
const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

describe('private visual delivery session boundary', () => {
  const config = loadRuntimeConfig();
  const authConfig = loadAuthConfig();
  const health = new DependencyHealthService(config);
  const provider = new AuthProvider(authConfig);
  const sessions = new SessionService(health.prisma, provider, authConfig);
  const migration = new Pool({ connectionString: config.directDatabaseUrl, ssl: false, max: 2 });
  let owner = '';
  const workspace = randomUUID(), project = randomUUID();
  const identities: Identity[] = [];
  let app!: NestExpressApplication;
  let baseUrl = '';
  let visuals!: VisualService;
  let storage!: PrivateAssetStore;
  let apiSessions!: SessionService;
  let visualAssetId = '';
  let previewAssetId = '';
  let member!: Identity;

  async function identity(): Promise<Identity> {
    const email = `cf-visual-${randomUUID()}@example.test`, password = randomBytes(24).toString('base64url');
    const session = await provider.register(email, password, 'Visual delivery test');
    if (!session) throw new Error('TEST GoTrue did not auto-confirm synthetic account');
    const created = await sessions.create(session, 'Visual delivery test');
    const value = { id: session.identity.id, cookie: created.cookie, session, email, password };
    identities.push(value);
    return value;
  }

  async function get(path: string, cookie: string) {
    return fetch(baseUrl + path, { headers: { Cookie: `${SESSION_COOKIE}=${cookie}` } });
  }

  async function waitForSignal(signal: Promise<void>, description: string): Promise<void> {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([signal, new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error(`Timed out waiting for ${description}`)), 10_000);
      })]);
    } finally { if (timeout) clearTimeout(timeout); }
  }

  beforeAll(async () => {
    expect(authConfig.providerUrl).toBe('http://127.0.0.1:54331');
    expect((await health.check()).status).toBe('ready');
    const user = await identity();
    owner = user.id;
    member = await identity();
    app = await NestFactory.create<NestExpressApplication>(AppModule, { logger: false });
    app.useBodyParser('json', { limit: '1mb' });
    await app.init();
    await app.listen(0, '127.0.0.1');
    const address = app.getHttpServer().address();
    if (!address || typeof address === 'string') throw new Error('API did not bind a loopback port');
    baseUrl = `http://127.0.0.1:${address.port}`;
    visuals = app.get(VisualService);
    storage = app.get(PrivateAssetStore);
    apiSessions = app.get(SessionService);

    await health.prisma.workspace.create({ data: { id: workspace, name: 'Synthetic visual delivery', ownerId: owner,
      members: { create: [{ userId: owner }, { userId: member.id }] }, styles: { create: { revision: 1, createdBy: owner } } } });
    await health.prisma.project.create({ data: { id: project, workspaceId: workspace, createdBy: owner, topic: 'Synthetic visual delivery', formats: ['LINKEDIN_COVER'] } });
    const jobs = new DurableJobService(health.prisma, { noticeVersion: EXTERNAL_PROCESSING_NOTICE.version });
    const facts = new FactualBasisService(health.prisma, jobs);
    const editorial = new EditorialService(health.prisma, jobs, facts);
    const channels = app.get(TelegramService);
    await editorial.saveBrief(owner, project, { expectedRevision: 0, contentMode: 'CREATIVE', topic: 'Місто', audience: 'Мешканці',
      centralMessage: 'Нові ідеї', category: 'Місто', targetLength: 100, cta: '', exclusions: [], notes: '', requiredClaimRevisionIds: [] });
    let channel = await channels.get(owner, project, 'LINKEDIN_COVER');
    channel = await channels.saveDraft(owner, project, { expectedRevision: channel.adaptation?.revision ?? 0, format: 'LINKEDIN_COVER',
      inputMode: 'DIRECT', contentMode: 'CREATIVE', refreshInputs: true, content: { text: 'Міський простір і нові ідеї.', mappings: [],
        cover: { text: 'Українська обкладинка', instruction: 'Лаконічний макет' } } });
    channel = await channels.checkpoint(owner, project, { format: 'LINKEDIN_COVER', expectedRevision: channel.adaptation!.revision });
    const parentRevision = channel.adaptation!.revisions[0]!;
    await channels.review(owner, project, parentRevision.id, 'approve', { format: 'LINKEDIN_COVER', expectedRevision: channel.adaptation!.revision,
      expectedReviewCounter: parentRevision.reviewCounter, acknowledgeUnmapped: true });
    const initial = await visuals.get(owner, project, 'LINKEDIN_COVER');
    let composition = await visuals.initialize(owner, project, 'LINKEDIN_COVER', { parentRevisionId: initial.parent!.id });
    const content = compositionSchema.parse(composition.composition!.draft!.content);
    composition = await visuals.checkpoint(owner, project, 'LINKEDIN_COVER', { expectedRevision: composition.composition!.revision,
      expectedDraftCounter: composition.composition!.draft!.counter });
    const revision = composition.composition!.revisions[0]!;
    const preview = await visuals.preview(owner, project, 'LINKEDIN_COVER', revision.id, content.frames[0]!.id);
    previewAssetId = preview.assetId;
    const asset = await visuals.createAsset(owner, project, 'PROJECT', { filename: 'private.png', mediaType: 'image/png', base64: png });
    visualAssetId = asset.id;
  }, 45_000);

  async function delayedRead(path: string, status: number, invalidate: (cookie: string) => Promise<void> = cookie => sessions.logout(cookie)): Promise<void> {
    let startedResolve!: () => void;
    const started = new Promise<void>(resolve => { startedResolve = resolve; });
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let delayed = false;
    const realRead = storage.read.bind(storage);
    const read = vi.spyOn(storage, 'read').mockImplementation(async (bucket, objectKey, hash) => {
      const bytes = await realRead(bucket, objectKey, hash);
      if (!delayed) { delayed = true; startedResolve(); await gate; }
      return bytes;
    });
    const original = identities[0]!;
    const requestProviderSession = await provider.login(original.email, original.password);
    const continuingProviderSession = await provider.login(original.email, original.password);
    const requestSession = await sessions.create(requestProviderSession, 'Visual delivery request session');
    const continuingSession = await sessions.create(continuingProviderSession, 'Visual delivery continuing session');
    identities.push({ ...original, cookie: requestSession.cookie, session: requestProviderSession },
      { ...original, cookie: continuingSession.cookie, session: continuingProviderSession });
    try {
      const pending = get(path, requestSession.cookie);
      void pending.catch(() => {});
      await waitForSignal(started, `private storage read for ${path}`);
      await invalidate(requestSession.cookie);
      release();
      const response = await pending;
      expect(response.status).toBe(status);
      expect(response.headers.get('content-type')).not.toBe('image/png');
      expect(response.headers.get('set-cookie')).toContain(`${SESSION_COOKIE}=`);
      const denied = Buffer.from(await response.arrayBuffer());
      expect(denied.subarray(0, 8)).not.toEqual(signature);
      read.mockRestore();
      const valid = await get(path, continuingSession.cookie);
      expect(valid.status).toBe(200);
      expect(valid.headers.get('content-type')).toBe('image/png');
      expect(valid.headers.get('cache-control')).toContain('no-store');
      expect(valid.headers.get('x-content-type-options')).toBe('nosniff');
      expect(Buffer.from(await valid.arrayBuffer()).subarray(0, 8)).toEqual(signature);
    } finally { release(); read.mockRestore(); }
  }

  async function expire(cookie: string): Promise<void> {
    await health.prisma.appSession.update({ where: { cookieDigest: tokenDigest(cookie) }, data: {
      createdAt: new Date(Date.now() - 3_600_000), expiresAt: new Date(Date.now() - 1000),
    } });
  }

  it('rechecks the exact session after a private source visual asset read', async () => {
    const authorized = await get(`/api/v1/projects/${project}/visuals/assets/${visualAssetId}?scope=PROJECT`, identities[0]!.cookie);
    expect(authorized.status).toBe(200);
    expect(authorized.headers.get('cache-control')).toContain('no-store');
    expect(authorized.headers.get('x-content-type-options')).toBe('nosniff');
    expect(Buffer.from(await authorized.arrayBuffer()).subarray(0, 8)).toEqual(signature);
    await delayedRead(`/api/v1/projects/${project}/visuals/assets/${visualAssetId}?scope=PROJECT`, 401);
  });

  it('rechecks the exact session after a private rendered preview read', async () => {
    await delayedRead(`/api/v1/projects/${project}/visuals/preview/${previewAssetId}`, 401);
  });

  it('rejects asset delivery when its exact session expires during storage read', async () => {
    await delayedRead(`/api/v1/projects/${project}/visuals/assets/${visualAssetId}?scope=PROJECT`, 401, expire);
  });

  it('rejects preview delivery when its exact session expires during storage read', async () => {
    await delayedRead(`/api/v1/projects/${project}/visuals/preview/${previewAssetId}`, 401, expire);
  });

  it('rechecks Workspace membership after session verification and preserves the private asset', async () => {
    let readCompletedResolve!: () => void;
    const readCompleted = new Promise<void>(resolve => { readCompletedResolve = resolve; });
    const realRead = storage.read.bind(storage);
    const read = vi.spyOn(storage, 'read').mockImplementation(async (bucket, objectKey, hash) => {
      const bytes = await realRead(bucket, objectKey, hash);
      readCompletedResolve();
      return bytes;
    });
    let checkCount = 0;
    let checkStartedResolve!: () => void;
    const checkStarted = new Promise<void>(resolve => { checkStartedResolve = resolve; });
    let releaseCheck!: () => void;
    const checkGate = new Promise<void>(resolve => { releaseCheck = resolve; });
    const realCheck = apiSessions.check.bind(apiSessions);
    const check = vi.spyOn(apiSessions, 'check').mockImplementation(async (cookie, activity) => {
      checkCount++;
      if (checkCount === 2) { checkStartedResolve(); await checkGate; }
      return realCheck(cookie, activity);
    });
    try {
      const pending = get(`/api/v1/projects/${project}/visuals/assets/${visualAssetId}?scope=PROJECT`, member.cookie);
      void pending.catch(() => {});
      await waitForSignal(readCompleted, 'storage read completion');
      await waitForSignal(checkStarted, 'controller session recheck');
      await health.prisma.workspaceMember.update({ where: { workspaceId_userId: { workspaceId: workspace, userId: member.id } }, data: { leftAt: new Date() } });
      releaseCheck();
      const response = await pending;
      expect(response.status).toBe(404);
      expect(response.headers.get('content-type')).not.toBe('image/png');
      expect(Buffer.from(await response.arrayBuffer()).subarray(0, 8)).not.toEqual(signature);
      expect(await health.prisma.project.findUnique({ where: { id: project }, select: { id: true } })).toEqual({ id: project });
      expect(await health.prisma.asset.findFirst({ where: { id: visualAssetId, projectId: project, state: 'AVAILABLE' }, select: { id: true } }))
        .toEqual({ id: visualAssetId });
      const ownerResponse = await get(`/api/v1/projects/${project}/visuals/assets/${visualAssetId}?scope=PROJECT`, identities[0]!.cookie);
      expect(ownerResponse.status).toBe(200);
      expect(Buffer.from(await ownerResponse.arrayBuffer()).subarray(0, 8)).toEqual(signature);
    } finally { releaseCheck(); check.mockRestore(); read.mockRestore(); }
  });

  afterAll(async () => {
    const userIds = [...new Set(identities.map(value => value.id))];
    try {
      const old = new Date(Date.now() - 31 * 86_400_000), purgeAfter = new Date(old.getTime() + 30 * 86_400_000);
      const row = await health.prisma.project.findUnique({ where: { id: project } });
      if (row) {
        await health.prisma.project.update({ where: { id: project }, data: { trashedAt: old, purgeAfter } });
        await health.prisma.$queryRaw`SELECT contextflow.purge_project_graph(${project}::uuid,${owner}::uuid,${row.revision})`;
      }
      const workspaceRow = await health.prisma.workspace.findUnique({ where: { id: workspace } });
      if (workspaceRow) {
        if (member) await health.prisma.workspaceMember.updateMany({ where: { workspaceId: workspace, userId: member.id, leftAt: null }, data: { leftAt: new Date() } });
        await health.prisma.workspace.update({ where: { id: workspace }, data: { trashedAt: old, purgeAfter } });
        await health.prisma.$queryRaw`SELECT contextflow.purge_workspace_graph(${workspace}::uuid,${owner}::uuid,${workspaceRow.lifecycleRevision})`;
      }
      const pending = await health.prisma.privateObjectDeletion.findMany({ where: { requestedBy: { in: userIds } } });
      for (const item of pending) {
        if (storage) await storage.remove(item.bucket, item.objectKey);
        await health.prisma.privateObjectDeletion.update({ where: { id: item.id }, data: { state: 'DELETED', deletedAt: new Date() } });
      }
    } finally {
      try { await app?.close(); }
      finally {
        try {
          if (userIds.length) {
            await health.prisma.appSession.deleteMany({ where: { userId: { in: userIds } } });
            const db = await migration.connect();
            try {
              await db.query('DELETE FROM contextflow."PrivateObjectDeletion" WHERE "requestedBy"=ANY($1::uuid[])', [userIds]);
              await db.query('DELETE FROM contextflow."UserProfile" WHERE "id"=ANY($1::uuid[])', [userIds]);
            } finally { db.release(); }
          }
        } finally {
          try {
            const secret = process.env['TEST_SUPABASE_SECRET_KEY'] ?? '';
            for (const id of userIds) {
              const response = await fetch(authConfig.providerUrl + '/auth/v1/admin/users/' + id, { method: 'DELETE',
                headers: { apikey: secret, Authorization: 'Bearer ' + secret } });
              if (!response.ok) throw new Error('Synthetic TEST Auth cleanup failed');
            }
          } finally { await migration.end(); await health.onModuleDestroy(); }
        }
      }
    }
  });
});
