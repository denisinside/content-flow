import { randomBytes, randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { DependencyHealthService, loadRuntimeConfig } from '@contextflow/backend';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../../apps/api/src/app.module.js';
import { loadAuthConfig } from '../../apps/api/src/auth/auth-config.js';
import { AuthProvider, type ProviderSession } from '../../apps/api/src/auth/auth-provider.js';
import { SESSION_COOKIE, CSRF_COOKIE } from '../../apps/api/src/auth/csrf.js';
import { SessionService, IDLE_TIMEOUT_MS } from '../../apps/api/src/auth/session-service.js';

type ProjectDto = {
  id: string;
  workspaceId: string;
  topic: string;
  formats: string[];
  revision: number;
  createdAt: string;
  updatedAt: string;
  archivedAt: string | null;
};

type ApiIdentity = { id: string; email: string; cookie: string; session: ProviderSession };
type WorkspaceDto = { id: string; name: string; ownerId: string; archivedAt: string | null; styleRevision: number; members?: { userId: string }[] };
type HttpContext = { baseUrl: string; origin: string };
type ApiReply<T> = { response: Response; body: T };

const FORMATS = [
  'LINKEDIN_TEXT', 'LINKEDIN_COVER', 'LINKEDIN_CAROUSEL', 'INSTAGRAM_COVER',
  'INSTAGRAM_CAROUSEL', 'INSTAGRAM_STORIES', 'TELEGRAM_POST', 'ARTICLE',
] as const;

describe('isolated project and private asset API', () => {
  const runtime = loadRuntimeConfig();
  const authConfig = loadAuthConfig();
  const provider = new AuthProvider(authConfig);
  const health = new DependencyHealthService(runtime);
  const sessions = new SessionService(health.prisma, provider, authConfig);
  const identities: ApiIdentity[] = [];
  const primaryWorkspaces = new Map<string, string>();
  let app!: INestApplication;
  let context!: HttpContext;

  beforeAll(async () => {
    // Never let an integration test send identities or project data to the owner's cloud provider.
    expect(authConfig.providerUrl).toBe('http://127.0.0.1:54331');
    expect((await health.check()).status).toBe('ready');
    expect((await fetch(authConfig.providerUrl + '/auth/v1/health')).ok).toBe(true);
    app = await NestFactory.create(AppModule, { logger: false });
    await app.init();
    await app.listen(0, '127.0.0.1');
    const address = app.getHttpServer().address();
    if (!address || typeof address === 'string') throw new Error('API did not bind a loopback port');
    context = { baseUrl: `http://127.0.0.1:${address.port}`, origin: authConfig.webOrigin };
  });

  async function identity(): Promise<ApiIdentity> {
    const email = `cf-project-${randomUUID()}@example.test`;
    const password = randomBytes(24).toString('base64url');
    const session = await provider.register(email, password, 'Project integration');
    if (!session) throw new Error('TEST GoTrue did not auto-confirm synthetic account');
    const created = await sessions.create(session, 'Project integration');
    const value = { id: session.identity.id, email, cookie: created.cookie, session };
    identities.push(value);
    return value;
  }

  async function csrf(identityValue: ApiIdentity): Promise<{ token: string; cookie: string }> {
    const response = await fetch(context.baseUrl + '/api/auth/session', {
      headers: { Cookie: `${SESSION_COOKIE}=${identityValue.cookie}` },
    });
    expect(response.status).toBe(200);
    const body = await response.json() as { authenticated: boolean; csrfToken: string };
    expect(body.authenticated).toBe(true);
    const setCookies = response.headers.getSetCookie();
    const csrfSetCookie = setCookies.find(value => value.startsWith(CSRF_COOKIE + '='));
    if (!csrfSetCookie) throw new Error('Session endpoint did not issue its CSRF cookie');
    const cookie = csrfSetCookie.split(';', 1)[0];
    if (!cookie) throw new Error('Malformed CSRF cookie');
    return { token: body.csrfToken, cookie };
  }

  async function anonymousCsrf(): Promise<{ token: string; cookie: string }> {
    const response = await fetch(context.baseUrl + '/api/auth/session');
    expect(response.status).toBe(200);
    const body = await response.json() as { authenticated: boolean; csrfToken: string };
    expect(body.authenticated).toBe(false);
    const csrfSetCookie = response.headers.getSetCookie().find(value => value.startsWith(CSRF_COOKIE + '='));
    if (!csrfSetCookie) throw new Error('Anonymous session endpoint did not issue a CSRF cookie');
    const cookie = csrfSetCookie.split(';', 1)[0];
    if (!cookie) throw new Error('Malformed anonymous CSRF cookie');
    return { token: body.csrfToken, cookie };
  }

  async function request<T = unknown>(identityValue: ApiIdentity | undefined, method: string, path: string, body?: unknown,
    options: { csrf?: boolean; origin?: string } = {}): Promise<ApiReply<T>> {
    const headers = new Headers();
    if (body !== undefined) headers.set('Content-Type', 'application/json');
    if (identityValue) headers.set('Cookie', `${SESSION_COOKIE}=${identityValue.cookie}`);
    if (options.csrf ?? (method !== 'GET' && method !== 'HEAD' && Boolean(identityValue))) {
      const protection = identityValue ? await csrf(identityValue) : await anonymousCsrf();
      headers.set('Cookie', `${identityValue ? `${SESSION_COOKIE}=${identityValue.cookie}; ` : ''}${protection.cookie}`);
      headers.set('x-csrf-token', protection.token);
      headers.set('Origin', options.origin ?? context.origin);
    } else if (options.origin) headers.set('Origin', options.origin);
    const response = await fetch(context.baseUrl + path, {
      method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const value = await response.json().catch(() => ({})) as T;
    return { response, body: value };
  }

  async function createWorkspace(identityValue: ApiIdentity, name = 'Integration Workspace') {
    return request<{ workspace: WorkspaceDto }>(identityValue, 'POST', '/api/v1/workspaces', { name });
  }

  async function primaryWorkspace(identityValue: ApiIdentity) {
    const cached = primaryWorkspaces.get(identityValue.id);
    if (cached) return cached;
    const created = await createWorkspace(identityValue);
    expect(created.response.status).toBe(201);
    primaryWorkspaces.set(identityValue.id, created.body.workspace.id);
    return created.body.workspace.id;
  }

  async function createProject(identityValue: ApiIdentity, topic = 'A project topic', formats: string[] = ['LINKEDIN_TEXT'], workspaceId?: string) {
    return request<{ project: ProjectDto }>(identityValue, 'POST', '/api/v1/projects', { topic, formats, workspaceId: workspaceId ?? await primaryWorkspace(identityValue) });
  }

  afterAll(async () => {
    // Tear down in FK order, restricted to synthetic test identities and their projects.
    const ownerIds = identities.map(value => value.id);
    if (ownerIds.length) {
      const projects = await health.prisma.project.findMany({ where: { createdBy: { in: ownerIds } }, select: { id: true } });
      const projectIds = projects.map(project => project.id);
      if (projectIds.length) {
        await health.prisma.asset.deleteMany({ where: { projectId: { in: projectIds } } });
        await health.prisma.projectMember.deleteMany({ where: { projectId: { in: projectIds } } });
        await health.prisma.project.deleteMany({ where: { id: { in: projectIds } } });
      }
      const workspaces = await health.prisma.workspace.findMany({ where: { ownerId: { in: ownerIds } }, select: { id: true } });
      const workspaceIds = workspaces.map(workspace => workspace.id);
      if (workspaceIds.length) {
        await health.prisma.workspaceInvite.deleteMany({ where: { workspaceId: { in: workspaceIds } } });
        await health.prisma.workspaceStyleRevision.deleteMany({ where: { workspaceId: { in: workspaceIds } } });
        await health.prisma.workspaceMember.deleteMany({ where: { workspaceId: { in: workspaceIds } } });
        await health.prisma.workspace.deleteMany({ where: { id: { in: workspaceIds } } });
      }
      await health.prisma.projectMember.deleteMany({ where: { userId: { in: ownerIds } } });
      await health.prisma.appSession.deleteMany({ where: { userId: { in: ownerIds } } });
      await health.prisma.userProfile.deleteMany({ where: { id: { in: ownerIds } } });
      for (const id of ownerIds) {
        const secret = process.env['TEST_SUPABASE_SECRET_KEY'] ?? '';
        const response = await fetch(authConfig.providerUrl + '/auth/v1/admin/users/' + id, {
          method: 'DELETE', headers: { apikey: secret, Authorization: 'Bearer ' + secret },
        });
        if (!response.ok) throw new Error('Synthetic TEST Auth cleanup failed');
      }
    }
    await app?.close();
    await health.onModuleDestroy();
  });

  it('creates a Project in a chosen Workspace and lists only active Workspace membership', async () => {
    const owner = await identity();
    const outsider = await identity();
    const created = await createProject(owner, '  Campaign planning  ', ['LINKEDIN_TEXT', 'TELEGRAM_POST']);
    expect(created.response.status).toBe(201);
    expect(created.body.project).toMatchObject({ topic: 'Campaign planning', formats: ['LINKEDIN_TEXT', 'TELEGRAM_POST'], revision: 1, archivedAt: null });
    expect(created.body.project.id).toMatch(/^[0-9a-f-]{36}$/i);
    const workspaceId = await primaryWorkspace(owner);
    expect(created.body.project.workspaceId).toBe(workspaceId);
    const rows = await health.prisma.workspaceMember.findMany({ where: { workspaceId } });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ userId: owner.id, leftAt: null });
    expect(await health.prisma.projectMember.count({ where: { projectId: created.body.project.id } })).toBe(0);
    expect((await request<{ projects: ProjectDto[]; nextCursor: string | null }>(owner, 'GET', '/api/v1/projects')).body.projects).toHaveLength(1);
    expect((await request<{ projects: ProjectDto[]; nextCursor: string | null }>(outsider, 'GET', '/api/v1/projects')).body.projects).toHaveLength(0);
    expect((await request(outsider, 'GET', `/api/v1/projects/${created.body.project.id}`)).response.status).toBe(404);
  });

  it('creates and lists named Workspaces while hiding direct foreign IDs', async () => {
    const owner = await identity();
    const outsider = await identity();
    const created = await createWorkspace(owner, '  Editorial team  ');
    expect(created.response.status).toBe(201);
    expect(created.body.workspace).toMatchObject({ name: 'Editorial team', ownerId: owner.id, styleRevision: 1, archivedAt: null });
    expect(created.body.workspace.members).toEqual([{ userId: owner.id, displayName: 'Project integration', joinedAt: expect.any(String) }]);
    expect((await request<{ workspaces: WorkspaceDto[] }>(owner, 'GET', '/api/v1/workspaces')).body.workspaces.map(row => row.id)).toContain(created.body.workspace.id);
    expect((await request<{ workspaces: WorkspaceDto[] }>(outsider, 'GET', '/api/v1/workspaces')).body.workspaces).toEqual([]);
    expect((await request(outsider, 'GET', `/api/v1/workspaces/${created.body.workspace.id}`)).response.status).toBe(404);
    expect((await request(outsider, 'GET', `/api/v1/workspaces/${created.body.workspace.id}/style`)).response.status).toBe(404);
    expect((await request(owner, 'POST', '/api/v1/workspaces', { name: '   ' })).response.status).toBe(400);
  });

  it('requires recipient consent and accepts a targeted invitation only once before expiry', async () => {
    const owner = await identity();
    const recipient = await identity();
    const wrongRecipient = await identity();
    const workspaceId = await primaryWorkspace(owner);
    const project = await createProject(owner, 'Shared project', ['ARTICLE'], workspaceId);
    const invited = await request<{ invite: { id: string; token: string; email: string } }>(owner, 'POST', `/api/v1/workspaces/${workspaceId}/invites`, { email: recipient.email.toUpperCase() });
    expect(invited.response.status).toBe(201);
    expect(invited.body.invite.email).toBe(recipient.email);
    expect((await request(recipient, 'GET', `/api/v1/projects/${project.body.project.id}`)).response.status).toBe(404);
    expect((await request(wrongRecipient, 'POST', '/api/v1/workspace-invites/accept', { token: invited.body.invite.token })).response.status).toBe(403);
    const accepted = await request<{ workspace: WorkspaceDto }>(recipient, 'POST', '/api/v1/workspace-invites/accept', { token: invited.body.invite.token });
    expect(accepted.response.status).toBe(201);
    expect(accepted.body.workspace.members?.map(member => member.userId)).toContain(recipient.id);
    expect((await request(recipient, 'GET', `/api/v1/projects/${project.body.project.id}`)).response.status).toBe(200);
    expect((await request(recipient, 'POST', '/api/v1/workspace-invites/accept', { token: invited.body.invite.token })).response.status).toBe(404);
    const expiring = await request<{ invite: { id: string; token: string } }>(owner, 'POST', `/api/v1/workspaces/${workspaceId}/invites`, { email: wrongRecipient.email });
    expect(expiring.response.status).toBe(201);
    await health.prisma.workspaceInvite.update({ where: { id: expiring.body.invite.id }, data: {
      createdAt: new Date(Date.now() - 72 * 60 * 60 * 1000), expiresAt: new Date(Date.now() - 24 * 60 * 60 * 1000),
    } });
    expect((await request(wrongRecipient, 'POST', '/api/v1/workspace-invites/accept', { token: expiring.body.invite.token })).response.status).toBe(404);
    expect((await request(wrongRecipient, 'GET', `/api/v1/projects/${project.body.project.id}`)).response.status).toBe(404);
  });

  it('shares all nested Projects with members and denies foreign Workspace and asset IDs', async () => {
    const owner = await identity();
    const member = await identity();
    const outsider = await identity();
    const workspaceId = await primaryWorkspace(owner);
    await health.prisma.workspaceMember.create({ data: { workspaceId, userId: member.id } });
    const first = await createProject(owner, 'First shared', ['ARTICLE'], workspaceId);
    const second = await createProject(member, 'Second shared', ['TELEGRAM_POST'], workspaceId);
    const foreign = await createProject(outsider, 'Private elsewhere');
    expect((await request<{ projects: ProjectDto[] }>(member, 'GET', `/api/v1/projects?workspaceId=${workspaceId}`)).body.projects.map(row => row.id).sort()).toEqual([first.body.project.id, second.body.project.id].sort());
    expect((await request(member, 'POST', '/api/v1/projects', { workspaceId: foreign.body.project.workspaceId, topic: 'Injected', formats: ['ARTICLE'] })).response.status).toBe(404);
    expect((await request(member, 'GET', `/api/v1/projects/${foreign.body.project.id}`)).response.status).toBe(404);
    expect((await request(outsider, 'PATCH', `/api/v1/projects/${first.body.project.id}`, { expectedRevision: 1, topic: 'Injected' })).response.status).toBe(404);
    const asset = await health.prisma.asset.create({ data: { id: randomUUID(), projectId: first.body.project.id,
      bucket: 'private-assets', objectKey: `${first.body.project.id}/${randomUUID()}/fixture.txt`, mediaType: 'text/plain',
      bytes: 4n, sha256: 'd'.repeat(64), state: 'AVAILABLE', purpose: 'ORIGINAL', createdBy: owner.id } });
    expect((await request(member, 'GET', `/api/v1/projects/${first.body.project.id}/assets/${asset.id}`)).response.status).toBe(200);
    expect((await request(outsider, 'GET', `/api/v1/projects/${first.body.project.id}/assets/${asset.id}`)).response.status).toBe(404);
    expect((await request(member, 'GET', `/api/v1/projects/${foreign.body.project.id}/assets/${asset.id}`)).response.status).toBe(404);
  });

  it('transfers ownership atomically, lets members leave, and archives/restores sole-owner history', async () => {
    const owner = await identity();
    const member = await identity();
    const otherMember = await identity();
    const workspaceId = await primaryWorkspace(owner);
    const project = await createProject(owner, 'Preserved project', ['ARTICLE'], workspaceId);
    await health.prisma.workspaceMember.createMany({ data: [{ workspaceId, userId: member.id }, { workspaceId, userId: otherMember.id }] });
    expect((await request(owner, 'POST', `/api/v1/workspaces/${workspaceId}/leave`)).response.status).toBe(409);
    expect((await request(owner, 'POST', `/api/v1/workspaces/${workspaceId}/transfer`, { userId: randomUUID() })).response.status).toBe(409);
    const raced = await Promise.all([member, otherMember].map(target => request<{ workspace: WorkspaceDto }>(owner, 'POST', `/api/v1/workspaces/${workspaceId}/transfer`, { userId: target.id })));
    expect(raced.map(result => result.response.status).sort()).toEqual([201, 403]);
    const newOwnerId = raced.find(result => result.response.status === 201)?.body.workspace.ownerId;
    expect([member.id, otherMember.id]).toContain(newOwnerId);
    const newOwner = newOwnerId === member.id ? member : otherMember;
    const remainingMember = newOwnerId === member.id ? otherMember : member;
    expect((await request(owner, 'POST', `/api/v1/workspaces/${workspaceId}/leave`)).response.status).toBe(204);
    expect((await request(owner, 'GET', `/api/v1/projects/${project.body.project.id}`)).response.status).toBe(404);
    expect((await request(remainingMember, 'POST', `/api/v1/workspaces/${workspaceId}/leave`)).response.status).toBe(204);
    expect((await request(newOwner, 'POST', `/api/v1/workspaces/${workspaceId}/leave`)).response.status).toBe(204);
    expect((await request(newOwner, 'POST', '/api/v1/projects', { workspaceId, topic: 'Archived edit', formats: ['ARTICLE'] })).response.status).toBe(404);
    expect((await request(newOwner, 'PATCH', `/api/v1/projects/${project.body.project.id}`, { expectedRevision: 1, topic: 'Archived edit' })).response.status).toBe(404);
    const archived = await health.prisma.workspace.findUniqueOrThrow({ where: { id: workspaceId } });
    expect(archived.archivedAt).not.toBeNull();
    expect(archived.ownerId).toBe(newOwner.id);
    expect((await request(newOwner, 'GET', `/api/v1/projects/${project.body.project.id}`)).response.status).toBe(200);
    expect((await request(newOwner, 'POST', `/api/v1/workspaces/${workspaceId}/restore`)).response.status).toBe(201);
    expect((await createProject(newOwner, 'After restore', ['ARTICLE'], workspaceId)).response.status).toBe(201);
  });

  it('keeps immutable Workspace style revisions with member edits and stale-update conflicts', async () => {
    const owner = await identity();
    const member = await identity();
    const workspaceId = await primaryWorkspace(owner);
    await health.prisma.workspaceMember.create({ data: { workspaceId, userId: member.id } });
    const initial = await request<{ style: { revision: number; tone: string } }>(member, 'GET', `/api/v1/workspaces/${workspaceId}/style`);
    expect(initial.body.style).toMatchObject({ revision: 1, tone: '' });
    const updated = await request<{ style: { revision: number; tone: string } }>(member, 'PATCH', `/api/v1/workspaces/${workspaceId}/style`, { expectedRevision: 1, tone: 'Clear and concise' });
    expect(updated.response.status).toBe(200);
    expect(updated.body.style).toMatchObject({ revision: 2, tone: 'Clear and concise' });
    expect((await request(owner, 'PATCH', `/api/v1/workspaces/${workspaceId}/style`, { expectedRevision: 1, tone: 'Stale' })).response.status).toBe(409);
    expect((await health.prisma.workspaceStyleRevision.findUniqueOrThrow({ where: { workspaceId_revision: { workspaceId, revision: 1 } } })).tone).toBe('');
    expect((await request(owner, 'POST', `/api/v1/workspaces/${workspaceId}/archive`)).response.status).toBe(409);
    expect((await request(member, 'POST', `/api/v1/workspaces/${workspaceId}/leave`)).response.status).toBe(204);
    expect((await request(owner, 'POST', `/api/v1/workspaces/${workspaceId}/archive`)).response.status).toBe(201);
    expect((await request(owner, 'PATCH', `/api/v1/workspaces/${workspaceId}/style`, { expectedRevision: 2, tone: 'Blocked' })).response.status).toBe(409);
  });

  it('denies missing, expired, logged-out and idle sessions on project routes', async () => {
    const owner = await identity();
    const created = await createProject(owner);
    expect(created.response.status).toBe(201);
    expect((await request(undefined, 'GET', '/api/v1/projects')).response.status).toBe(401);
    expect((await request(undefined, 'POST', '/api/v1/projects', { topic: 'x', formats: ['LINKEDIN_TEXT'] })).response.status).toBe(403);
    expect((await request(undefined, 'POST', '/api/v1/projects', { topic: 'x', formats: ['LINKEDIN_TEXT'] }, { csrf: true })).response.status).toBe(401);
    expect((await request(owner, 'GET', `/api/v1/projects/${randomUUID()}`)).response.status).toBe(404);

    const priorActivity = new Date(Date.now() - 31_000);
    await health.prisma.appSession.updateMany({ where: { userId: owner.id }, data: { lastUserActivityAt: priorActivity } });
    await request(owner, 'GET', `/api/v1/projects/${created.body.project.id}`);
    expect((await health.prisma.appSession.findFirstOrThrow({ where: { userId: owner.id } })).lastUserActivityAt).toEqual(priorActivity);
    expect((await request(owner, 'PATCH', `/api/v1/projects/${created.body.project.id}`, { expectedRevision: 1, topic: 'Active session edit' })).response.status).toBe(200);
    expect((await health.prisma.appSession.findFirstOrThrow({ where: { userId: owner.id } })).lastUserActivityAt.getTime()).toBeGreaterThan(priorActivity.getTime());

    await health.prisma.appSession.updateMany({ where: { userId: owner.id }, data: { lastUserActivityAt: new Date(Date.now() - IDLE_TIMEOUT_MS - 1000) } });
    expect((await request(owner, 'GET', `/api/v1/projects/${created.body.project.id}`)).response.status).toBe(401);
    const loggedOut = await identity();
    expect((await request(loggedOut, 'POST', '/api/auth/logout')).response.status).toBe(201);
    expect((await request(loggedOut, 'GET', '/api/v1/projects')).response.status).toBe(401);
  });

  it('rejects unsafe requests without a valid same-origin CSRF proof and validates strict project input', async () => {
    const owner = await identity();
    const workspaceId = await primaryWorkspace(owner);
    expect((await request(undefined, 'POST', '/api/v1/projects', { topic: 'valid', formats: ['LINKEDIN_TEXT'] })).response.status).toBe(403);
    expect((await request(owner, 'POST', '/api/v1/projects', { workspaceId, topic: 'valid', formats: ['LINKEDIN_TEXT'] }, { csrf: false })).response.status).toBe(403);
    expect((await request(owner, 'POST', '/api/v1/projects', { workspaceId, topic: 'valid', formats: ['LINKEDIN_TEXT'] }, { origin: 'https://attacker.example' })).response.status).toBe(403);
    expect((await request(owner, 'POST', '/api/v1/projects', { topic: 'valid', formats: ['LINKEDIN_TEXT'] })).response.status).toBe(400);
    for (const value of [
      { topic: '   ', formats: ['LINKEDIN_TEXT'] },
      { topic: 'x'.repeat(501), formats: ['LINKEDIN_TEXT'] },
      { topic: 'valid', formats: [] },
      { topic: 'valid', formats: ['LINKEDIN_TEXT', 'LINKEDIN_TEXT'] },
      { topic: 'valid', formats: ['ARTICLE', null] },
      { topic: 'valid', formats: null },
      { topic: 'valid', formats: [...FORMATS, 'ARTICLE'] },
      { topic: 'valid', formats: ['INVALID_FORMAT'] },
      { topic: 'valid', formats: ['LINKEDIN_TEXT'], extra: true },
    ]) expect((await request(owner, 'POST', '/api/v1/projects', { workspaceId, ...value })).response.status).toBe(400);
    expect((await request(owner, 'POST', '/api/v1/projects', { workspaceId, topic: 'valid', formats: ['LINKEDIN_TEXT'] })).response.status).toBe(201);
    const allFormats = await request<{ project: ProjectDto }>(owner, 'POST', '/api/v1/projects', { workspaceId, topic: 'All formats', formats: FORMATS });
    expect(allFormats.response.status).toBe(201);
    expect(allFormats.body.project.formats).toEqual(FORMATS);
  });

  it('persists article-only, channel-only and mixed selections through API create and patch', async () => {
    const owner = await identity();
    const articleOnly = await createProject(owner, 'Article only', ['ARTICLE']);
    expect(articleOnly.response.status).toBe(201);
    expect(articleOnly.body.project.formats).toEqual(['ARTICLE']);
    expect((await health.prisma.project.findUniqueOrThrow({ where: { id: articleOnly.body.project.id } })).formats).toEqual(['ARTICLE']);

    const channelsOnly = await createProject(owner, 'Channels only', ['LINKEDIN_TEXT', 'TELEGRAM_POST']);
    expect(channelsOnly.response.status).toBe(201);
    expect(channelsOnly.body.project.formats).toEqual(['LINKEDIN_TEXT', 'TELEGRAM_POST']);
    const channelsProject = await health.prisma.project.findUniqueOrThrow({ where: { id: channelsOnly.body.project.id } });
    expect(channelsProject.formats).toEqual(['LINKEDIN_TEXT', 'TELEGRAM_POST']);
    const asset = await health.prisma.asset.create({ data: {
      id: randomUUID(), projectId: channelsOnly.body.project.id, bucket: 'private-assets',
      objectKey: `${channelsOnly.body.project.id}/${randomUUID()}/preserved.txt`, mediaType: 'text/plain',
      bytes: 4n, sha256: 'c'.repeat(64), state: 'AVAILABLE', purpose: 'ORIGINAL', createdBy: owner.id,
    } });

    const mixed = await request<{ project: ProjectDto }>(owner, 'PATCH', `/api/v1/projects/${channelsOnly.body.project.id}`, {
      expectedRevision: 1, formats: ['ARTICLE', 'LINKEDIN_TEXT', 'TELEGRAM_POST'],
    });
    expect(mixed.response.status).toBe(200);
    expect(mixed.body.project.formats).toEqual(['ARTICLE', 'LINKEDIN_TEXT', 'TELEGRAM_POST']);
    expect((await health.prisma.project.findUniqueOrThrow({ where: { id: channelsOnly.body.project.id } })).formats)
      .toEqual(['ARTICLE', 'LINKEDIN_TEXT', 'TELEGRAM_POST']);
    expect(await health.prisma.asset.findUniqueOrThrow({ where: { id: asset.id } })).toEqual(asset);

    const articleRemoved = await request<{ project: ProjectDto }>(owner, 'PATCH', `/api/v1/projects/${channelsOnly.body.project.id}`, {
      expectedRevision: 2, formats: ['LINKEDIN_TEXT', 'TELEGRAM_POST'],
    });
    expect(articleRemoved.response.status).toBe(200);
    expect(articleRemoved.body.project.formats).toEqual(['LINKEDIN_TEXT', 'TELEGRAM_POST']);
    const persisted = await health.prisma.project.findUniqueOrThrow({ where: { id: channelsOnly.body.project.id } });
    expect(persisted.formats).toEqual(['LINKEDIN_TEXT', 'TELEGRAM_POST']);
    expect(persisted.createdAt).toEqual(channelsProject.createdAt);
    expect(await health.prisma.asset.findUniqueOrThrow({ where: { id: asset.id } })).toEqual(asset);
  });

  it('paginates newest projects with an opaque UUID cursor and stable 50-row pages', async () => {
    const owner = await identity();
    const workspaceId = await primaryWorkspace(owner);
    const createdIds: string[] = [];
    for (let index = 0; index < 51; index++) {
      const projectId = randomUUID();
      const createdAt = new Date(Date.now() - (50 - index) * 1000);
      await health.prisma.project.create({ data: {
        id: projectId, topic: `Page ${index}`, formats: ['LINKEDIN_TEXT'], revision: 1,
        workspaceId, createdAt, updatedAt: createdAt, createdBy: owner.id,
      } });
      createdIds.push(projectId);
    }
    const first = await request<{ projects: ProjectDto[]; nextCursor: string | null }>(owner, 'GET', '/api/v1/projects');
    expect(first.response.status).toBe(200);
    expect(first.body.projects).toHaveLength(50);
    expect(first.body.nextCursor).toMatch(/^[0-9a-f-]{36}$/i);
    expect(first.body.projects.map(project => project.id)).toEqual(createdIds.slice(1).reverse());
    expect(first.body.projects.map(project => project.createdAt)).toEqual([...first.body.projects.map(project => project.createdAt)].sort().reverse());
    const second = await request<{ projects: ProjectDto[]; nextCursor: string | null }>(owner, 'GET', `/api/v1/projects?cursor=${first.body.nextCursor}`);
    expect(second.body.projects).toHaveLength(1);
    expect(second.body.nextCursor).toBeNull();
    expect(second.body.projects[0]?.id).toBe(createdIds[0]);
    expect(new Set([...first.body.projects, ...second.body.projects].map(project => project.id))).toEqual(new Set(createdIds));
    expect((await request(owner, 'GET', '/api/v1/projects?cursor=not-a-uuid')).response.status).toBe(400);
  });

  it('edits project settings with optimistic revisions and preserves allowed formats', async () => {
    const owner = await identity();
    const created = await createProject(owner, 'Initial', ['LINKEDIN_TEXT']);
    const projectId = created.body.project.id;
    const updated = await request<{ project: ProjectDto }>(owner, 'PATCH', `/api/v1/projects/${projectId}`, {
      expectedRevision: 1, topic: ' Revised topic ', formats: ['LINKEDIN_TEXT', 'INSTAGRAM_COVER'],
    });
    expect(updated.response.status).toBe(200);
    expect(updated.body.project).toMatchObject({ id: projectId, topic: 'Revised topic', formats: ['LINKEDIN_TEXT', 'INSTAGRAM_COVER'], revision: 2 });
    const conflicts = await Promise.all([
      request<{ project?: ProjectDto }>(owner, 'PATCH', `/api/v1/projects/${projectId}`, { expectedRevision: 2, topic: 'Winner one' }),
      request<{ project?: ProjectDto }>(owner, 'PATCH', `/api/v1/projects/${projectId}`, { expectedRevision: 2, topic: 'Winner two' }),
    ]);
    expect(conflicts.map(result => result.response.status).sort()).toEqual([200, 409]);
    const stored = await health.prisma.project.findUniqueOrThrow({ where: { id: projectId } });
    expect(stored.revision).toBe(3);
    expect(['Winner one', 'Winner two']).toContain(stored.topic);
    for (const body of [
      {}, { expectedRevision: 0, topic: 'x' }, { expectedRevision: 2, topic: 'stale' },
      { expectedRevision: 3, unknown: true }, { expectedRevision: 3, formats: [] },
      { expectedRevision: 3, formats: ['TELEGRAM_POST', 'TELEGRAM_POST'] },
      { expectedRevision: 3, topic: 'x'.repeat(501) },
    ]) expect([400, 409]).toContain((await request(owner, 'PATCH', `/api/v1/projects/${projectId}`, body)).response.status);
  });

  it('checks Workspace membership revocation and asset ancestry on each read', async () => {
    const owner = await identity();
    const member = await identity();
    const foreignOwner = await identity();
    const first = await createProject(owner, 'Project one');
    const second = await createProject(foreignOwner, 'Project two');
    const firstAsset = await health.prisma.asset.create({ data: {
      id: randomUUID(),
      projectId: first.body.project.id, bucket: 'private-assets', objectKey: `${first.body.project.id}/${randomUUID()}/fixture.txt`,
      mediaType: 'image/png', bytes: 4n, sha256: 'a'.repeat(64), state: 'AVAILABLE', purpose: 'ORIGINAL', createdBy: owner.id,
    } });
    const foreignAsset = await health.prisma.asset.create({ data: {
      id: randomUUID(),
      projectId: second.body.project.id, bucket: 'private-assets', objectKey: `${second.body.project.id}/${randomUUID()}/fixture.txt`,
      mediaType: 'image/png', bytes: 4n, sha256: 'b'.repeat(64), state: 'AVAILABLE', purpose: 'ORIGINAL', createdBy: foreignOwner.id,
    } });
    const originalAssetMetadata = await health.prisma.asset.findUniqueOrThrow({ where: { id: firstAsset.id } });
    await health.prisma.workspaceMember.create({ data: { workspaceId: first.body.project.workspaceId, userId: member.id } });
    const accessible = await request<{ asset: Record<string, unknown> }>(member, 'GET', `/api/v1/projects/${first.body.project.id}/assets/${firstAsset.id}`);
    expect(accessible.response.status).toBe(200);
    expect(Object.keys(accessible.body.asset).sort()).toEqual(['bytes', 'createdAt', 'id', 'mediaType', 'projectId', 'purpose', 'sha256', 'state'].sort());
    expect(accessible.body.asset).not.toHaveProperty('bucket');
    expect(accessible.body.asset).not.toHaveProperty('objectKey');
    const memberEdit = await request<{ project: ProjectDto }>(member, 'PATCH', `/api/v1/projects/${first.body.project.id}`, {
      expectedRevision: 1, topic: 'Changed by admitted member',
    });
    expect(memberEdit.response.status).toBe(200);
    expect(memberEdit.body.project.revision).toBe(2);
    expect(await health.prisma.asset.findUniqueOrThrow({ where: { id: firstAsset.id } })).toEqual(originalAssetMetadata);
    expect((await request(member, 'GET', `/api/v1/projects/${first.body.project.id}/assets/${foreignAsset.id}`)).response.status).toBe(404);
    expect((await request(owner, 'GET', `/api/v1/projects/${first.body.project.id}/assets/${randomUUID()}`)).response.status).toBe(404);
    for (const state of ['STAGED', 'QUARANTINED'] as const) {
      const unavailable = await health.prisma.asset.create({ data: {
        id: randomUUID(),
        projectId: first.body.project.id, bucket: 'private-assets', objectKey: `${first.body.project.id}/${randomUUID()}/fixture.txt`,
        mediaType: 'image/png', bytes: 4n, sha256: randomBytes(32).toString('hex'), state, purpose: 'NORMALIZED', createdBy: owner.id,
      } });
      expect((await request(owner, 'GET', `/api/v1/projects/${first.body.project.id}/assets/${unavailable.id}`)).response.status).toBe(404);
    }
    await health.prisma.project.update({ where: { id: first.body.project.id }, data: { archivedAt: new Date() } });
    expect((await request(owner, 'PATCH', `/api/v1/projects/${first.body.project.id}`, { expectedRevision: 2, topic: 'archived edit' })).response.status).toBe(409);
    await health.prisma.workspaceMember.update({ where: { workspaceId_userId: { workspaceId: first.body.project.workspaceId, userId: member.id } }, data: { leftAt: new Date() } });
    expect((await request(member, 'GET', `/api/v1/projects/${first.body.project.id}/assets/${firstAsset.id}`)).response.status).toBe(404);
    const idleAt = new Date(Date.now() - IDLE_TIMEOUT_MS - 1000);
    await health.prisma.appSession.updateMany({ where: { userId: owner.id }, data: { lastUserActivityAt: idleAt } });
    expect((await request(owner, 'GET', `/api/v1/projects/${first.body.project.id}/assets/${firstAsset.id}`)).response.status).toBe(401);
  });

  it('enforces asset constraints and preserves creator attribution to a UserProfile', async () => {
    const owner = await identity();
    const outsider = await identity();
    const project = await createProject(owner, 'Constraint fixture');
    const base = {
      id: randomUUID(),
      projectId: project.body.project.id, bucket: 'private-assets', objectKey: `${project.body.project.id}/${randomUUID()}/fixture.bin`,
      mediaType: 'application/octet-stream', bytes: 1n, sha256: randomBytes(32).toString('hex'),
      state: 'STAGED' as const, purpose: 'ORIGINAL' as const, createdBy: owner.id,
    };
    await expect(health.prisma.project.create({ data: {
      id: randomUUID(), workspaceId: project.body.project.workspaceId, topic: 'Invalid empty formats', formats: [], createdBy: owner.id,
    } })).rejects.toBeDefined();
    await expect(health.prisma.project.create({ data: {
      id: randomUUID(), workspaceId: project.body.project.workspaceId, topic: 'Invalid duplicate formats', formats: ['LINKEDIN_TEXT', 'LINKEDIN_TEXT'], createdBy: owner.id,
    } })).rejects.toBeDefined();
    await expect(health.prisma.$executeRaw`
      INSERT INTO contextflow."Project" ("id", "workspaceId", "topic", "formats", "createdBy")
      VALUES (${randomUUID()}::uuid, ${project.body.project.workspaceId}::uuid, 'Invalid null format', ARRAY[NULL]::contextflow."ProjectFormat"[], ${owner.id}::uuid)
    `).rejects.toBeDefined();
    await expect(health.prisma.$executeRaw`
      INSERT INTO contextflow."Project" ("id", "workspaceId", "topic", "formats", "createdBy")
      VALUES (${randomUUID()}::uuid, ${project.body.project.workspaceId}::uuid, 'Invalid more than eight formats',
        ARRAY['ARTICLE','LINKEDIN_TEXT','LINKEDIN_COVER','LINKEDIN_CAROUSEL','INSTAGRAM_COVER','INSTAGRAM_CAROUSEL','INSTAGRAM_STORIES','TELEGRAM_POST','ARTICLE']::contextflow."ProjectFormat"[],
        ${owner.id}::uuid)
    `).rejects.toBeDefined();
    for (const invalid of [
      { ...base, bytes: -1n },
      { ...base, bytes: BigInt(Number.MAX_SAFE_INTEGER) + 1n },
      { ...base, sha256: 'not-a-hash' },
      { ...base, objectKey: `other-project/${randomUUID()}/fixture.bin` },
      { ...base, objectKey: `${project.body.project.id}/../fixture.bin` },
      { ...base, objectKey: `${project.body.project.id}\\nested\\fixture.bin` },
      { ...base, bucket: 'Private Bucket' },
    ]) await expect(health.prisma.asset.create({ data: { ...invalid, id: randomUUID() } })).rejects.toBeDefined();
    const attribution = await health.prisma.asset.create({ data: { ...base, id: randomUUID(), createdBy: outsider.id } });
    expect(attribution.createdBy).toBe(outsider.id);
  });
});
