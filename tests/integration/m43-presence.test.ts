import { randomBytes, randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DependencyHealthService, loadRuntimeConfig } from '@contextflow/backend';
import { AppModule } from '../../apps/api/src/app.module.js';
import { loadAuthConfig } from '../../apps/api/src/auth/auth-config.js';
import { AuthProvider, type ProviderSession } from '../../apps/api/src/auth/auth-provider.js';
import { CSRF_COOKIE, SESSION_COOKIE } from '../../apps/api/src/auth/csrf.js';
import { SessionService } from '../../apps/api/src/auth/session-service.js';
import { tokenDigest } from '../../apps/api/src/auth/session-crypto.js';

type Identity = { id: string; email: string; cookie: string; providerSession: ProviderSession };
type ApiResult<T = Record<string, unknown>> = { status: number; body: T };

describe('M4.3 project presence', () => {
  const runtime = loadRuntimeConfig(), config = loadAuthConfig();
  const health = new DependencyHealthService(runtime), provider = new AuthProvider(config);
  const sessions = new SessionService(health.prisma, provider, config);
  const identities: Identity[] = [];
  let app!: INestApplication;
  let baseUrl = '';
  let workspaceId = '', projectId = '';

  beforeAll(async () => {
    expect(config.providerUrl).toBe('http://127.0.0.1:54331');
    expect((await health.check()).status).toBe('ready');
    expect((await fetch(config.providerUrl + '/auth/v1/health')).ok).toBe(true);
    app = await NestFactory.create(AppModule, { logger: false });
    await app.init(); await app.listen(0, '127.0.0.1');
    const address = app.getHttpServer().address();
    if (!address || typeof address === 'string') throw new Error('API did not bind a loopback port');
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  async function identity(label: string): Promise<Identity> {
    const email = `cf-presence-${randomUUID()}@example.test`;
    const registered = await provider.register(email, randomBytes(24).toString('base64url'), label);
    if (!registered) throw new Error('TEST GoTrue did not auto-confirm synthetic account');
    const created = await sessions.create(registered, label);
    const value = { id: registered.identity.id, email, cookie: created.cookie, providerSession: registered };
    identities.push(value);
    return value;
  }

  async function protection(identityValue: Identity) {
    const response = await fetch(baseUrl + '/api/auth/session', { headers: { Cookie: `${SESSION_COOKIE}=${identityValue.cookie}` } });
    expect(response.status).toBe(200);
    const payload = await response.json() as { csrfToken: string };
    const csrfCookie = response.headers.getSetCookie().find(value => value.startsWith(CSRF_COOKIE + '='))?.split(';', 1)[0];
    if (!csrfCookie) throw new Error('Session endpoint did not issue its CSRF cookie');
    return { token: payload.csrfToken, csrfCookie };
  }

  async function request<T = Record<string, unknown>>(identityValue: Identity, method: 'GET' | 'POST' | 'DELETE', path: string,
    body?: unknown, csrf = true): Promise<ApiResult<T>> {
    const headers = new Headers({ Cookie: `${SESSION_COOKIE}=${identityValue.cookie}` });
    if (body !== undefined) headers.set('Content-Type', 'application/json');
    if (csrf && method !== 'GET') {
      const pair = await protection(identityValue);
      headers.set('Cookie', `${SESSION_COOKIE}=${identityValue.cookie}; ${pair.csrfCookie}`);
      headers.set('Origin', config.webOrigin);
      headers.set('x-csrf-token', pair.token);
    }
    const response = await fetch(baseUrl + path, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, body: await response.json().catch(() => ({})) as T };
  }

  function path(page: string) { return `/api/v1/projects/${projectId}/presence?page=${encodeURIComponent(page)}`; }
  function presenceBody(page: string, clientId = randomUUID()) { return { page, clientId }; }

  beforeAll(async () => {
    const owner = await identity('Presence owner');
    await health.prisma.workspace.create({ data: { id: (workspaceId = randomUUID()), name: 'Presence test', ownerId: owner.id,
      members: { create: [{ userId: owner.id }] } } });
    await health.prisma.project.create({ data: { id: (projectId = randomUUID()), workspaceId, createdBy: owner.id,
      topic: 'Synthetic presence', formats: ['ARTICLE'] } });
  });

  afterAll(async () => {
    if (projectId) await health.prisma.editorPresence.deleteMany({ where: { projectId } });
    if (projectId) await health.prisma.project.deleteMany({ where: { id: projectId } });
    if (workspaceId) {
      await health.prisma.workspaceMember.deleteMany({ where: { workspaceId } });
      await health.prisma.workspace.deleteMany({ where: { id: workspaceId } });
    }
    const userIds = [...new Set(identities.map(value => value.id))];
    for (const userId of userIds) {
      await health.prisma.appSession.deleteMany({ where: { userId } });
      await health.prisma.userProfile.deleteMany({ where: { id: userId } });
      const secret = process.env['TEST_SUPABASE_SECRET_KEY'] ?? '';
      const response = await fetch(config.providerUrl + '/auth/v1/admin/users/' + userId, {
        method: 'DELETE', headers: { apikey: secret, Authorization: 'Bearer ' + secret },
      });
      if (!response.ok) throw new Error('Synthetic TEST Auth cleanup failed');
    }
    await app?.close(); await health.onModuleDestroy();
  });

  it('tracks same-page active collaborators once and leaves idle activity unchanged on poll, heartbeat and leave', async () => {
    const owner = identities[0]!;
    const member = await identity('Repeated tab member');
    await health.prisma.workspaceMember.create({ data: { workspaceId, userId: member.id } });
    const secondSession = await sessions.create(member.providerSession, 'Repeated tab member');
    const cookies = [member.cookie, secondSession.cookie];
    const ids = await Promise.all(cookies.map(cookie => health.prisma.appSession.findUniqueOrThrow({ where: { cookieDigest: tokenDigest(cookie) }, select: { id: true } })));
    const earlier = new Date(Date.now() - 2 * 60_000);
    await health.prisma.appSession.updateMany({ where: { id: { in: ids.map(row => row.id) } }, data: { lastUserActivityAt: earlier } });

    for (const cookie of cookies) {
      const candidate = identities.find(value => value.cookie === cookie) ?? { ...member, cookie };
      expect((await request(candidate, 'POST', `/api/v1/projects/${projectId}/presence`, presenceBody('article'))).status).toBe(201);
    }
    const ownerList = await request<{ page: string; ttlSeconds: number; people: Array<{ userId: string; displayName: string }> }>(owner, 'GET', path('article'));
    expect(ownerList).toMatchObject({ status: 200, body: { page: 'article', ttlSeconds: 60,
      people: [{ userId: member.id, displayName: 'Repeated tab member' }] } });
    expect(JSON.stringify(ownerList.body)).not.toContain(member.email);
    expect((await health.prisma.appSession.findMany({ where: { id: { in: ids.map(row => row.id) } } })).every(row => row.lastUserActivityAt.getTime() === earlier.getTime())).toBe(true);

    const leaveCandidate = { ...member, cookie: cookies[0]! };
    const rows = await health.prisma.editorPresence.findMany({ where: { projectId, userId: member.id, page: 'article' } });
    const leave = rows[0]!;
    expect((await request(leaveCandidate, 'DELETE', `/api/v1/projects/${projectId}/presence`, { page: 'article', clientId: leave.clientId })).status).toBe(200);
    expect((await health.prisma.appSession.findUniqueOrThrow({ where: { id: ids[0]!.id } })).lastUserActivityAt.getTime()).toBe(earlier.getTime());
  });

  it('rejects invalid pages and missing CSRF, hides foreign projects, and prunes expired rows', async () => {
    const owner = identities[0]!;
    expect((await request(owner, 'POST', `/api/v1/projects/${projectId}/presence`, presenceBody('settings'))).status).toBe(400);
    expect((await request(owner, 'POST', `/api/v1/projects/${projectId}/presence`, presenceBody('article'), false)).status).toBe(403);
    expect((await request(owner, 'GET', path('settings'))).status).toBe(400);
    const outsider = await identity('Presence outsider');
    expect((await request(outsider, 'GET', path('article'))).status).toBe(404);

    const heartbeat = await request(owner, 'POST', `/api/v1/projects/${projectId}/presence`, presenceBody('brief'));
    expect(heartbeat).toMatchObject({ status: 201, body: { ok: true, page: 'brief', ttlSeconds: 60 } });
    await health.prisma.editorPresence.updateMany({ where: { projectId, page: 'brief' }, data: { expiresAt: new Date(Date.now() - 1000) } });
    expect((await request(owner, 'GET', path('brief'))).body).toMatchObject({ people: [] });
    expect(await health.prisma.editorPresence.count({ where: { projectId, page: 'brief' } })).toBe(0);
  });

  it('filters a collaborator immediately after membership departure and after logout', async () => {
    const owner = identities[0]!;
    const member = await identity('Leaving member');
    await health.prisma.workspaceMember.create({ data: { workspaceId, userId: member.id } });
    await request(member, 'POST', `/api/v1/projects/${projectId}/presence`, presenceBody('telegram'));
    await health.prisma.workspaceMember.update({ where: { workspaceId_userId: { workspaceId, userId: member.id } }, data: { leftAt: new Date() } });
    expect((await request(owner, 'GET', path('telegram'))).body).toMatchObject({ people: [] });

    await health.prisma.workspaceMember.update({ where: { workspaceId_userId: { workspaceId, userId: member.id } }, data: { leftAt: null } });
    await request(member, 'POST', `/api/v1/projects/${projectId}/presence`, presenceBody('telegram'));
    await sessions.logout(member.cookie);
    expect((await request(owner, 'GET', path('telegram'))).body).toMatchObject({ people: [] });

    await health.prisma.project.update({ where: { id: projectId }, data: { archivedAt: new Date() } });
    expect((await request(owner, 'GET', path('telegram'))).status).toBe(404);
    await health.prisma.project.update({ where: { id: projectId }, data: { archivedAt: null } });
    const projectTrashedAt = new Date();
    await health.prisma.project.update({ where: { id: projectId }, data: { trashedAt: projectTrashedAt, purgeAfter: new Date(projectTrashedAt.getTime() + 30 * 24 * 60 * 60_000) } });
    expect((await request(owner, 'GET', path('telegram'))).status).toBe(404);
    await health.prisma.project.update({ where: { id: projectId }, data: { trashedAt: null, purgeAfter: null } });
    await health.prisma.workspace.update({ where: { id: workspaceId }, data: { archivedAt: new Date() } });
    expect((await request(owner, 'GET', path('telegram'))).status).toBe(404);
    await health.prisma.workspace.update({ where: { id: workspaceId }, data: { archivedAt: null } });
    const workspaceTrashedAt = new Date();
    await health.prisma.workspace.update({ where: { id: workspaceId }, data: { trashedAt: workspaceTrashedAt, purgeAfter: new Date(workspaceTrashedAt.getTime() + 30 * 24 * 60 * 60_000) } });
    expect((await request(owner, 'GET', path('telegram'))).status).toBe(404);
    await health.prisma.workspace.update({ where: { id: workspaceId }, data: { trashedAt: null, purgeAfter: null } });
  });
});
