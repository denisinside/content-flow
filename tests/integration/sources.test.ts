import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { NestFactory } from '@nestjs/core';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Pool } from 'pg';
import { DependencyHealthService, loadRuntimeConfig } from '@contextflow/backend';
import { AppModule } from '../../apps/api/src/app.module.js';
import { loadAuthConfig } from '../../apps/api/src/auth/auth-config.js';
import { AuthProvider, type ProviderSession } from '../../apps/api/src/auth/auth-provider.js';
import { ExternalProcessingService, EXTERNAL_PROCESSING_NOTICE } from '../../apps/api/src/auth/external-processing.js';
import { CSRF_COOKIE, SESSION_COOKIE } from '../../apps/api/src/auth/csrf.js';
import { SessionService } from '../../apps/api/src/auth/session-service.js';
import { PrivateAssetStore } from '../../apps/api/src/storage/private-asset-store.js';

type Identity = { id: string; cookie: string; session: ProviderSession };
type HttpContext = { baseUrl: string; origin: string };
type Reply<T> = { response: Response; body: T };
type Material = { id: string; projectId: string; kind: string; purpose: string; label: string; included: boolean; revision: number; currentSnapshotId: string | null };
type Snapshot = { id: string; sequence: number; normalizedText?: string; sha256: string; bytes: number; origin: string; previousSnapshotId: string | null; originalAssetId: string | null; fragments?: Array<{ id: string; ordinal: number; startOffset: number; endOffset: number; sha256: string }> };

describe('manual sources, immutable snapshots, and private originals', () => {
  const config = loadRuntimeConfig();
  const authConfig = loadAuthConfig();
  const health = new DependencyHealthService(config);
  const provider = new AuthProvider(authConfig);
  const sessions = new SessionService(health.prisma, provider, authConfig);
  const migrationPool = new Pool({ connectionString: config.directDatabaseUrl, ssl: false, max: 2 });
  const identities: Identity[] = [];
  const projects: string[] = [];
  let app!: NestExpressApplication;
  let context!: HttpContext;

  beforeAll(async () => {
    expect(authConfig.providerUrl).toBe('http://127.0.0.1:54331');
    expect((await health.check()).status).toBe('ready');
    expect((await fetch(authConfig.providerUrl + '/auth/v1/health')).ok).toBe(true);
    app = await NestFactory.create<NestExpressApplication>(AppModule, { logger: false });
    app.useBodyParser('json', { limit: '1mb' });
    await app.init();
    await app.listen(0, '127.0.0.1');
    const address = app.getHttpServer().address();
    if (!address || typeof address === 'string') throw new Error('API did not bind a loopback port');
    context = { baseUrl: `http://127.0.0.1:${address.port}`, origin: authConfig.webOrigin };
  });

  async function identity(): Promise<Identity> {
    const email = `cf-source-${randomUUID()}@example.test`;
    const session = await provider.register(email, randomBytes(24).toString('base64url'), 'Source integration');
    if (!session) throw new Error('TEST GoTrue did not auto-confirm synthetic account');
    const created = await sessions.create(session, 'Source integration');
    const value = { id: session.identity.id, cookie: created.cookie, session };
    identities.push(value);
    return value;
  }

  async function csrf(user: Identity) {
    const response = await fetch(context.baseUrl + '/api/auth/session', { headers: { Cookie: `${SESSION_COOKIE}=${user.cookie}` } });
    expect(response.status).toBe(200);
    const body = await response.json() as { csrfToken: string };
    const cookie = response.headers.getSetCookie().find(value => value.startsWith(CSRF_COOKIE + '='))?.split(';', 1)[0];
    if (!cookie) throw new Error('Session endpoint did not issue its CSRF cookie');
    return { token: body.csrfToken, cookie };
  }

  async function request<T = unknown>(user: Identity | undefined, method: string, path: string, body?: unknown): Promise<Reply<T>> {
    const headers = new Headers();
    if (user) headers.set('Cookie', `${SESSION_COOKIE}=${user.cookie}`);
    let requestBody: BodyInit | undefined;
    if (body instanceof FormData) requestBody = body;
    else if (body !== undefined) { headers.set('Content-Type', 'application/json'); requestBody = JSON.stringify(body); }
    if (method !== 'GET' && method !== 'HEAD') {
      if (!user) throw new Error('Mutation requires a synthetic identity');
      const protection = await csrf(user);
      headers.set('Cookie', `${SESSION_COOKIE}=${user.cookie}; ${protection.cookie}`);
      headers.set('x-csrf-token', protection.token);
      headers.set('Origin', context.origin);
    }
    const response = await fetch(context.baseUrl + path, { method, headers, ...(requestBody ? { body: requestBody } : {}) });
    return { response, body: await response.json().catch(() => ({})) as T };
  }

  afterAll(async () => {
    // Migrations own immutable source cleanup; the app's runtime role intentionally cannot delete these rows.
    for (const projectId of projects) {
      const assetRows = await health.prisma.asset.findMany({ where: { projectId }, select: { bucket: true, objectKey: true } });
      const client = await migrationPool.connect();
      await client.query('BEGIN');
      try {
        await client.query('DELETE FROM contextflow."SourceFragment" WHERE "projectId" = $1', [projectId]);
        await client.query('UPDATE contextflow."Material" SET "currentSnapshotId" = NULL, "revision" = "revision" + 1, "updatedAt" = CURRENT_TIMESTAMP WHERE "projectId" = $1', [projectId]);
        await client.query('DELETE FROM contextflow."SourceSnapshot" WHERE "projectId" = $1', [projectId]);
        await client.query('DELETE FROM contextflow."Material" WHERE "projectId" = $1', [projectId]);
        await client.query('DELETE FROM contextflow."Asset" WHERE "projectId" = $1', [projectId]);
        await client.query('DELETE FROM contextflow."ProjectMember" WHERE "projectId" = $1', [projectId]);
        await client.query('DELETE FROM contextflow."Project" WHERE "id" = $1', [projectId]);
        await client.query('COMMIT');
      } catch (error) { await client.query('ROLLBACK'); throw error; }
      finally { client.release(); }
      const storage = app.get(PrivateAssetStore);
      for (const asset of assetRows) await storage.remove(asset.bucket, asset.objectKey);
    }
    const userIds = identities.map(value => value.id);
    if (userIds.length) {
      const workspaces = await health.prisma.workspace.findMany({ where: { ownerId: { in: userIds } }, select: { id: true } });
      for (const workspace of workspaces) {
        await health.prisma.workspaceInvite.deleteMany({ where: { workspaceId: workspace.id } });
        await health.prisma.workspaceStyleRevision.deleteMany({ where: { workspaceId: workspace.id } });
        await health.prisma.workspaceMember.deleteMany({ where: { workspaceId: workspace.id } });
        await health.prisma.workspace.delete({ where: { id: workspace.id } });
      }
      await health.prisma.appSession.deleteMany({ where: { userId: { in: userIds } } });
      await health.prisma.userProfile.deleteMany({ where: { id: { in: userIds } } });
      for (const id of userIds) {
        const secret = process.env['TEST_SUPABASE_SECRET_KEY'] ?? '';
        const response = await fetch(authConfig.providerUrl + '/auth/v1/admin/users/' + id, {
          method: 'DELETE', headers: { apikey: secret, Authorization: 'Bearer ' + secret },
        });
        if (!response.ok) throw new Error('Synthetic TEST Auth cleanup failed');
      }
    }
    await app?.close();
    await migrationPool.end();
    await health.onModuleDestroy();
  });

  it('persists exact manual versions and file originals with equal member access, isolation, and notice acceptance', async () => {
    const owner = await identity();
    const member = await identity();
    const foreign = await identity();
    const workspace = await health.prisma.workspace.create({ data: { name: 'Synthetic source workspace', ownerId: owner.id,
      members: { create: [{ userId: owner.id }, { userId: member.id }] }, styles: { create: { revision: 1, createdBy: owner.id } } } });
    const project = await health.prisma.project.create({ data: { workspaceId: workspace.id, createdBy: owner.id,
      topic: 'Source integration fixture', formats: ['TELEGRAM_POST'] } });
    projects.push(project.id);

    const notice = await request<{ notice: { version: string }; accepted: boolean; acceptedAt: string | null }>(owner, 'GET', '/api/auth/external-processing');
    expect(notice.response.status).toBe(200);
    expect(notice.body).toMatchObject({ notice: { version: EXTERNAL_PROCESSING_NOTICE.version }, accepted: false, acceptedAt: null });
    const processing = app.get(ExternalProcessingService);
    await expect(processing.requireAccepted(owner.id)).rejects.toMatchObject({ status: 403 });
    expect((await request(owner, 'POST', '/api/auth/external-processing', { noticeVersion: 'wrong' })).response.status).toBe(400);
    const accepted = await request<{ notice: { version: string }; accepted: boolean; acceptedAt: string }>(owner, 'POST', '/api/auth/external-processing', { noticeVersion: notice.body.notice.version });
    expect(accepted.response.status).toBe(201);
    expect(accepted.body.accepted).toBe(true);
    const replay = await request<{ acceptedAt: string }>(owner, 'POST', '/api/auth/external-processing', { noticeVersion: notice.body.notice.version });
    expect(replay.body.acceptedAt).toBe(accepted.body.acceptedAt);
    expect((await request(owner, 'GET', '/api/auth/external-processing')).body).toMatchObject({ accepted: true, acceptedAt: accepted.body.acceptedAt });
    await expect(processing.requireAccepted(owner.id)).resolves.toBeUndefined();
    expect((await request(foreign, 'GET', '/api/auth/external-processing')).body).toMatchObject({ accepted: false, acceptedAt: null });

    const firstText = 'Український перший абзац. 😀\r\n\r\nSecond paragraph stays exact.';
    const normalizedFirstText = firstText.replace(/\r\n/g, '\n');
    const created = await request<{ material: Material; snapshot: Snapshot }>(owner, 'POST', `/api/v1/projects/${project.id}/materials`, {
      label: 'Manual source', purpose: 'FACTUAL_SOURCE', text: firstText,
    });
    expect(created.response.status).toBe(201);
    const materialId = created.body.material.id;
    const firstSnapshot = created.body.snapshot;
    expect(created.body.material).toMatchObject({ kind: 'TEXT', included: true, revision: 2, currentSnapshotId: firstSnapshot.id });
    expect(firstSnapshot).toMatchObject({ sequence: 1, origin: 'MANUAL_TEXT', bytes: Buffer.byteLength(normalizedFirstText) });

    const versioned = await request<{ material: Material; snapshot: Snapshot }>(member, 'POST', `/api/v1/projects/${project.id}/materials/${materialId}/snapshots`, {
      expectedRevision: created.body.material.revision, text: 'Edited paragraph.\n\nДругий абзац.',
    });
    expect(versioned.response.status).toBe(201);
    expect(versioned.body.snapshot).toMatchObject({ sequence: 2, previousSnapshotId: firstSnapshot.id, origin: 'MANUAL_TEXT' });
    const old = await request<{ snapshot: Snapshot }>(member, 'GET', `/api/v1/projects/${project.id}/materials/${materialId}/snapshots/${firstSnapshot.id}`);
    expect(old.body.snapshot.normalizedText).toBe(normalizedFirstText);
    expect(old.body.snapshot.bytes).toBe(Buffer.byteLength(old.body.snapshot.normalizedText!, 'utf8'));
    expect(old.body.snapshot.sha256).toBe(createHash('sha256').update(Buffer.from(old.body.snapshot.normalizedText!, 'utf8')).digest('hex'));
    expect(old.body.snapshot.fragments).toHaveLength(2);
    for (const fragment of old.body.snapshot.fragments ?? []) {
      const exact = old.body.snapshot.normalizedText!.slice(fragment.startOffset, fragment.endOffset);
      expect(createHash('sha256').update(Buffer.from(exact, 'utf8')).digest('hex')).toBe(fragment.sha256);
    }
    expect(old.body.snapshot.normalizedText!.slice(old.body.snapshot.fragments?.[0]?.startOffset, old.body.snapshot.fragments?.[0]?.endOffset))
      .toBe('Український перший абзац. 😀');
    const updated = await request<{ material: Material }>(member, 'PATCH', `/api/v1/projects/${project.id}/materials/${materialId}`, {
      expectedRevision: versioned.body.material.revision, included: false, purpose: 'NOTES',
    });
    expect(updated.response.status).toBe(200);
    expect(updated.body.material).toMatchObject({ included: false, purpose: 'NOTES', currentSnapshotId: versioned.body.snapshot.id });
    expect((await request(owner, 'PATCH', `/api/v1/projects/${project.id}/materials/${materialId}`, {
      expectedRevision: versioned.body.material.revision, included: true,
    })).response.status).toBe(409);
    expect((await request(member, 'GET', `/api/v1/projects/${project.id}/materials`)).body).toMatchObject({ materials: [expect.objectContaining({ id: materialId, included: false })] });

    const markdownContent = Buffer.from('# Український документ\r\n\r\nОригінальні байти.\r\n');
    const markdownBytes = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), markdownContent]);
    const form = new FormData();
    form.set('label', 'Uploaded notes');
    form.set('purpose', 'SUPPLIED_ARTICLE');
    form.set('file', new File([markdownBytes], 'джерело.md', { type: 'text/markdown' }));
    const uploaded = await request<{ material: Material; snapshot: Snapshot }>(member, 'POST', `/api/v1/projects/${project.id}/materials/upload`, form);
    expect(uploaded.response.status).toBe(201);
    const fileSnapshot = uploaded.body.snapshot;
    expect(uploaded.body.material.kind).toBe('FILE');
    expect(fileSnapshot).toMatchObject({ origin: 'LOCAL_FILE', originalAssetId: expect.any(String) });
    const fileDetails = await request<{ snapshot: Snapshot }>(member, 'GET', `/api/v1/projects/${project.id}/materials/${uploaded.body.material.id}/snapshots/${fileSnapshot.id}`);
    expect(fileDetails.body.snapshot.normalizedText).toBe('# Український документ\n\nОригінальні байти.\n');
    const sourceRows = await health.prisma.sourceSnapshot.findMany({ where: { projectId: project.id } });
    expect(sourceRows.every(row => !('bucket' in row) && !('objectKey' in row))).toBe(true);
    expect(JSON.stringify(uploaded.body)).not.toMatch(/bucket|objectKey|signedUrl|privateUrl/i);
    const download = await fetch(context.baseUrl + `/api/v1/projects/${project.id}/assets/${fileSnapshot.originalAssetId}/download`, {
      headers: { Cookie: `${SESSION_COOKIE}=${owner.cookie}` },
    });
    expect(download.status).toBe(200);
    expect(download.headers.get('content-disposition')).toContain("filename*=UTF-8''%D0");
    expect(download.headers.get('cache-control')).toBe('no-store');
    expect(download.headers.get('x-content-type-options')).toBe('nosniff');
    const downloadedBytes = Buffer.from(await download.arrayBuffer());
    expect(downloadedBytes).toEqual(markdownBytes);
    expect(createHash('sha256').update(downloadedBytes).digest('hex')).toBe((await health.prisma.asset.findUniqueOrThrow({ where: { id: fileSnapshot.originalAssetId! } })).sha256);
    expect((await request(foreign, 'GET', `/api/v1/projects/${project.id}/assets/${fileSnapshot.originalAssetId}/download`)).response.status).toBe(404);
    expect((await request(member, 'GET', `/api/v1/projects/${project.id}/materials/${materialId}/snapshots/${fileSnapshot.id}`)).response.status).toBe(404);
    expect((await request(member, 'GET', `/api/v1/projects/${randomUUID()}/materials`)).response.status).toBe(404);

    const invalids = [
      { filename: 'bad.txt', type: 'text/plain', bytes: Buffer.from([0xc3, 0x28]) },
      { filename: 'fake.txt', type: 'text/plain', bytes: Buffer.from('%PDF-1.7 fake') },
      { filename: 'notes.txt', type: 'application/pdf', bytes: Buffer.from('hello') },
      { filename: ' trailing.txt', type: 'text/plain', bytes: Buffer.from('unsafe filename') },
      { filename: 'large.txt', type: 'text/plain', bytes: Buffer.alloc(1024 * 1024 + 1, 0x61) },
    ];
    for (const invalid of invalids) {
      const data = new FormData(); data.set('label', 'invalid'); data.set('purpose', 'NOTES');
      data.set('file', new File([invalid.bytes], invalid.filename, { type: invalid.type }));
      expect([400, 413]).toContain((await request(member, 'POST', `/api/v1/projects/${project.id}/materials/upload`, data)).response.status);
    }
    const rejectedText = await request(member, 'POST', `/api/v1/projects/${project.id}/materials`, { label: 'Invalid', purpose: 'NOTES', text: '  \n  ' });
    expect(rejectedText.response.status).toBe(400);
    for (const invalidText of ['line\u0001control', '\ud800', 'a\n\n'.repeat(1000) + 'a', 'x'.repeat(200_001)]) {
      expect((await request(member, 'POST', `/api/v1/projects/${project.id}/materials`, {
        label: 'Invalid boundary', purpose: 'NOTES', text: invalidText,
      })).response.status).toBe(400);
    }
    const maximumText = await request<{ snapshot: Snapshot }>(member, 'POST', `/api/v1/projects/${project.id}/materials`, {
      label: 'Maximum source', purpose: 'NOTES', text: 'x'.repeat(200_000),
    });
    expect(maximumText.response.status).toBe(201);
    expect(maximumText.body.snapshot.bytes).toBe(200_000);
    const doubleBom = new FormData(); doubleBom.set('label', 'BOM source'); doubleBom.set('purpose', 'NOTES');
    doubleBom.set('file', new File([Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf, 0xef, 0xbb, 0xbf]), Buffer.from('kept marker')])], 'bom.txt', { type: 'text/plain' }));
    const bomSource = await request<{ material: Material; snapshot: Snapshot }>(member, 'POST', `/api/v1/projects/${project.id}/materials/upload`, doubleBom);
    expect(bomSource.response.status).toBe(201);
    const bomDetails = await request<{ snapshot: Snapshot }>(member, 'GET', `/api/v1/projects/${project.id}/materials/${bomSource.body.material.id}/snapshots/${bomSource.body.snapshot.id}`);
    expect(bomDetails.body.snapshot.normalizedText).toBe('\ufeffkept marker');

    const storage = app.get(PrivateAssetStore);
    const raceBytes = Buffer.from('delayed storage fixture');
    async function delayedUpload(user: Identity, status: number, revoke?: () => Promise<void>) {
      let startedResolve!: () => void;
      const started = new Promise<void>(resolve => { startedResolve = resolve; });
      let release!: () => void;
      const gate = new Promise<void>(resolve => { release = resolve; });
      let location: { bucket: string; objectKey: string } | undefined;
      const realPut = storage.put.bind(storage);
      const put = vi.spyOn(storage, 'put').mockImplementation(async (projectIdArg, assetIdArg, bytes) => {
        location = await realPut(projectIdArg, assetIdArg, bytes);
        startedResolve();
        await gate;
        return location;
      });
      const formData = new FormData(); formData.set('label', 'Delayed upload'); formData.set('purpose', 'NOTES');
      formData.set('file', new File([raceBytes], 'delayed.txt', { type: 'text/plain' }));
      const materialCount = await health.prisma.material.count({ where: { projectId: project.id } });
      const assetCount = await health.prisma.asset.count({ where: { projectId: project.id } });
      try {
        const pending = request(user, 'POST', `/api/v1/projects/${project.id}/materials/upload`, formData);
        await started;
        await revoke?.();
        release();
        expect((await pending).response.status).toBe(status);
        expect(await health.prisma.material.count({ where: { projectId: project.id } })).toBe(materialCount);
        expect(await health.prisma.asset.count({ where: { projectId: project.id } })).toBe(assetCount);
        expect(location).toBeDefined();
        await expect(storage.read(location!.bucket, location!.objectKey, createHash('sha256').update(raceBytes).digest('hex'))).rejects.toBeDefined();
      } finally { release(); put.mockRestore(); }
    }
    async function delayedDownload(user: Identity, status: number, revoke: () => Promise<void>) {
      let startedResolve!: () => void;
      const started = new Promise<void>(resolve => { startedResolve = resolve; });
      let release!: () => void;
      const gate = new Promise<void>(resolve => { release = resolve; });
      const realRead = storage.read.bind(storage);
      const read = vi.spyOn(storage, 'read').mockImplementation(async (bucket, objectKey, hash) => {
        const bytes = await realRead(bucket, objectKey, hash);
        startedResolve();
        await gate;
        return bytes;
      });
      try {
        const pending = fetch(context.baseUrl + `/api/v1/projects/${project.id}/assets/${fileSnapshot.originalAssetId}/download`, {
          headers: { Cookie: `${SESSION_COOKIE}=${user.cookie}` },
        });
        await started;
        await revoke();
        release();
        const response = await pending;
        expect(response.status).toBe(status);
        expect(response.headers.get('content-type')).not.toBe('text/markdown');
      } finally { release(); read.mockRestore(); }
    }

    const departing = await identity();
    await health.prisma.workspaceMember.create({ data: { workspaceId: workspace.id, userId: departing.id } });
    await delayedUpload(departing, 404, async () => {
      await health.prisma.workspaceMember.update({ where: { workspaceId_userId: { workspaceId: workspace.id, userId: departing.id } }, data: { leftAt: new Date() } });
    });
    const revokedUpload = await identity();
    await health.prisma.workspaceMember.create({ data: { workspaceId: workspace.id, userId: revokedUpload.id } });
    await delayedUpload(revokedUpload, 401, () => sessions.logout(revokedUpload.cookie));
    const leavingDownload = await identity();
    await health.prisma.workspaceMember.create({ data: { workspaceId: workspace.id, userId: leavingDownload.id } });
    await delayedDownload(leavingDownload, 404, async () => {
      await health.prisma.workspaceMember.update({ where: { workspaceId_userId: { workspaceId: workspace.id, userId: leavingDownload.id } }, data: { leftAt: new Date() } });
    });
    const revokedDownload = await identity();
    await health.prisma.workspaceMember.create({ data: { workspaceId: workspace.id, userId: revokedDownload.id } });
    await delayedDownload(revokedDownload, 401, () => sessions.logout(revokedDownload.cookie));

    await expect(health.prisma.sourceSnapshot.update({ where: { projectId_id: { projectId: project.id, id: firstSnapshot.id } }, data: { normalizedText: 'tampered' } })).rejects.toBeDefined();
    expect((await request<{ snapshot: Snapshot }>(member, 'GET', `/api/v1/projects/${project.id}/materials/${materialId}/snapshots/${firstSnapshot.id}`)).body.snapshot.normalizedText)
      .toBe(normalizedFirstText);
  });
});
