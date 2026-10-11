import { randomBytes, randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { DependencyHealthService, GOOGLE_DOCS_FILE_SCOPE, loadRuntimeConfig, type GoogleDocsClient } from '@contextflow/backend';
import { EXTERNAL_PROCESSING_NOTICE, ExternalProcessingService } from '../../apps/api/src/auth/external-processing.js';
import { SESSION_COOKIE } from '../../apps/api/src/auth/csrf.js';
import { tokenDigest } from '../../apps/api/src/auth/session-crypto.js';
import type { AuthenticatedRequest } from '../../apps/api/src/auth/session.guard.js';
import { SessionService } from '../../apps/api/src/auth/session-service.js';
import { GoogleDocCreateService } from '../../apps/api/src/google-docs/google-doc-create.service.js';
import { loadGoogleOAuthRuntime } from '../../apps/api/src/google-docs/google-oauth.config.js';
import { GoogleOAuthService } from '../../apps/api/src/google-docs/google-oauth.service.js';

const testKey = Buffer.alloc(32, 32).toString('base64');
const runtimeEnv = {
  NODE_ENV: 'test', TEST_API_HOST: '127.0.0.1', TEST_API_PORT: '3000',
  TEST_GOOGLE_DOCS_CLIENT_ID: 'synthetic-create-client', TEST_GOOGLE_DOCS_CLIENT_SECRET: 'synthetic-create-secret',
  TEST_GOOGLE_DOCS_REDIRECT_URI: 'http://localhost:3000/api/v1/google-docs/oauth/callback',
  TEST_GOOGLE_DOCS_TOKEN_ENCRYPTION_KEY: testKey, TEST_GOOGLE_DOCS_TOKEN_ENCRYPTION_KEY_VERSION: '1',
};
const response = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
type Created = { documentId: string; title: string; marker: string };

describe('Google Docs create journal on isolated TEST PostgreSQL', () => {
  const config = loadRuntimeConfig(), health = new DependencyHealthService(config);
  const migration = new Pool({ connectionString: config.directDatabaseUrl, ssl: false, max: 1 });
  const fixtureUsers: string[] = [], fixtureWorkspaces: string[] = [], fixtureProjects: string[] = [], fixtureConnections: string[] = [], fixtureSessions: string[] = [];
  const sessions: Array<{ id: string; cookie: string; userId: string; active: boolean }> = [];
  const remote: Created[] = [];
  let oauthRuntime: ReturnType<typeof loadGoogleOAuthRuntime>;
  let service: GoogleDocCreateService;
  let postCount = 0;
  let hideFinderResults = false;
  let losePostResponse = false;
  let onPost: (() => Promise<void>) | null = null;

  beforeEach(() => { remote.length = 0; postCount = 0; hideFinderResults = false; losePostResponse = false; onPost = null; });

  beforeAll(async () => {
    expect(config.nodeEnv).toBe('test');
    expect(new URL(config.databaseUrl).port).toBe('54330');
    expect((await health.check()).status).toBe('ready');
    vi.stubGlobal('fetch', vi.fn<typeof fetch>(async (input, init) => {
      const url = String(input), method = init?.method ?? 'GET';
      if (url.startsWith('https://www.googleapis.com/drive/v3/files?') && method === 'POST') {
        postCount++;
        const body = JSON.parse(String(init?.body)) as { name: string; appProperties: { contextFlowCreate: string } };
        const created = { documentId: `synthetic-doc-${postCount}`, title: body.name, marker: body.appProperties.contextFlowCreate };
        remote.push(created);
        const hook = onPost; onPost = null; await hook?.();
        if (losePostResponse) throw new Error('simulated lost provider response');
        return response({ id: created.documentId, name: created.title, mimeType: 'application/vnd.google-apps.document',
          appProperties: { contextFlowCreate: created.marker } });
      }
      if (url.startsWith('https://www.googleapis.com/drive/v3/files?') && method === 'GET') {
        const matches = hideFinderResults ? [] : remote.map(item => ({ id: item.documentId, name: item.title,
          mimeType: 'application/vnd.google-apps.document', appProperties: { contextFlowCreate: item.marker } }));
        return response({ files: matches });
      }
      throw new Error('unexpected synthetic provider URL');
    }));
    oauthRuntime = loadGoogleOAuthRuntime(runtimeEnv);
    if (oauthRuntime.kind !== 'configured') throw new Error('Synthetic OAuth configuration unavailable');
    const oauth = new GoogleOAuthService(health, {
      check: vi.fn(async (cookie: string) => {
        const row = sessions.find(item => item.cookie === cookie);
        return row?.active ? { kind: 'active', user: { id: row.userId, email: 'synthetic@example.test', displayName: 'Synthetic' } } : { kind: 'expired' };
      }),
    } as unknown as SessionService, new ExternalProcessingService(health), oauthRuntime);
    service = new GoogleDocCreateService(health, oauth);
  });

  async function fixture(options: { member?: boolean; formats?: Array<'ARTICLE' | 'TELEGRAM_POST'> } = {}) {
    if (oauthRuntime.kind !== 'configured') throw new Error('Synthetic OAuth configuration unavailable');
    const userId = randomUUID(), sessionId = randomUUID(), cookie = randomBytes(32).toString('base64url');
    const workspaceId = randomUUID(), projectId = randomUUID(), connectionId = randomUUID();
    fixtureUsers.push(userId); fixtureWorkspaces.push(workspaceId); fixtureProjects.push(projectId); fixtureConnections.push(connectionId); fixtureSessions.push(sessionId);
    await health.prisma.userProfile.create({ data: { id: userId, externalProcessingNoticeVersion: EXTERNAL_PROCESSING_NOTICE.version,
      externalProcessingAcceptedAt: new Date() } });
    await health.prisma.workspace.create({ data: { id: workspaceId, name: 'Synthetic Google create workspace', ownerId: userId,
      members: { create: options.member === false ? [] : [{ userId }] }, styles: { create: { revision: 1, createdBy: userId } } } });
    await health.prisma.project.create({ data: { id: projectId, workspaceId, topic: 'Synthetic Article', formats: options.formats ?? ['ARTICLE'], createdBy: userId } });
    await health.prisma.appSession.create({ data: { id: sessionId, cookieDigest: tokenDigest(cookie), userId, tokenKeyVersion: 1,
      encryptedProviderTokens: 'synthetic-session-ciphertext', providerTokenExpiresAt: new Date(Date.now() + 3_600_000),
      expiresAt: new Date(Date.now() + 3_600_000), lastUserActivityAt: new Date() } });
    const sealed = oauthRuntime.crypto.encryptTokens({ accessToken: 'synthetic-create-access', refreshToken: 'synthetic-create-refresh', expiresAtMs: Date.now() + 3_600_000 }, userId, connectionId);
    await health.prisma.googleDriveConnection.create({ data: { id: connectionId, userId, googlePermissionId: `synthetic-account-${userId}`,
      encryptedTokens: sealed.ciphertext, tokenKeyVersion: sealed.keyVersion, grantedScope: GOOGLE_DOCS_FILE_SCOPE,
      accessExpiresAt: new Date(Date.now() + 3_600_000), refreshExpiresAt: new Date(Date.now() + 86_400_000) } });
    const record = { id: sessionId, cookie, userId, active: true }; sessions.push(record);
    const request = { headers: { cookie: `${SESSION_COOKIE}=${cookie}` }, sessionUser: { id: userId, email: 'synthetic@example.test', displayName: 'Synthetic' } } as unknown as AuthenticatedRequest;
    return { userId, workspaceId, projectId, connectionId, sessionId, cookie, record, request };
  }

  async function addWorkspaceMember(owner: Awaited<ReturnType<typeof fixture>>) {
    if (oauthRuntime.kind !== 'configured') throw new Error('Synthetic OAuth configuration unavailable');
    const userId = randomUUID(), sessionId = randomUUID(), cookie = randomBytes(32).toString('base64url'), connectionId = randomUUID();
    fixtureUsers.push(userId); fixtureConnections.push(connectionId); fixtureSessions.push(sessionId);
    await health.prisma.userProfile.create({ data: { id: userId, displayName: 'Recovery member',
      externalProcessingNoticeVersion: EXTERNAL_PROCESSING_NOTICE.version, externalProcessingAcceptedAt: new Date() } });
    await health.prisma.workspaceMember.create({ data: { workspaceId: owner.workspaceId, userId } });
    await health.prisma.appSession.create({ data: { id: sessionId, cookieDigest: tokenDigest(cookie), userId, tokenKeyVersion: 1,
      encryptedProviderTokens: 'synthetic-member-session-ciphertext', providerTokenExpiresAt: new Date(Date.now() + 3_600_000),
      expiresAt: new Date(Date.now() + 3_600_000), lastUserActivityAt: new Date() } });
    const sealed = oauthRuntime.crypto.encryptTokens({ accessToken: 'synthetic-member-access', refreshToken: 'synthetic-member-refresh',
      expiresAtMs: Date.now() + 3_600_000 }, userId, connectionId);
    await health.prisma.googleDriveConnection.create({ data: { id: connectionId, userId, googlePermissionId: `synthetic-account-${userId}`,
      encryptedTokens: sealed.ciphertext, tokenKeyVersion: sealed.keyVersion, grantedScope: GOOGLE_DOCS_FILE_SCOPE,
      accessExpiresAt: new Date(Date.now() + 3_600_000), refreshExpiresAt: new Date(Date.now() + 86_400_000) } });
    const record = { id: sessionId, cookie, userId, active: true }; sessions.push(record);
    const request = { headers: { cookie: `${SESSION_COOKIE}=${cookie}` }, sessionUser: { id: userId,
      email: 'member@example.test', displayName: 'Recovery member' } } as unknown as AuthenticatedRequest;
    return { userId, connectionId, request };
  }

  const input = (owner: Awaited<ReturnType<typeof fixture>>, overrides: Record<string, unknown> = {}) => ({
    connectionId: owner.connectionId, commandKey: randomUUID(), title: 'Synthetic article', expectedArticleRevision: 0, ...overrides,
  });

  afterAll(async () => {
    const db = await migration.connect();
    try {
      await db.query('BEGIN');
      await db.query('ALTER TABLE contextflow."GoogleDocBinding" DISABLE TRIGGER USER');
      await db.query('ALTER TABLE contextflow."GoogleDocCreateCommand" DISABLE TRIGGER USER');
      await db.query('DELETE FROM contextflow."GoogleDocBinding" WHERE "projectId"=ANY($1::uuid[])', [fixtureProjects]);
      await db.query('DELETE FROM contextflow."GoogleDocCreateCommand" WHERE "projectId"=ANY($1::uuid[])', [fixtureProjects]);
      await db.query('DELETE FROM contextflow."GoogleDriveConnection" WHERE "id"=ANY($1::uuid[])', [fixtureConnections]);
      await db.query('DELETE FROM contextflow."AppSession" WHERE "id"=ANY($1::uuid[])', [fixtureSessions]);
      await db.query('DELETE FROM contextflow."Project" WHERE "id"=ANY($1::uuid[])', [fixtureProjects]);
      await db.query('DELETE FROM contextflow."WorkspaceStyleRevision" WHERE "workspaceId"=ANY($1::uuid[])', [fixtureWorkspaces]);
      await db.query('DELETE FROM contextflow."WorkspaceMember" WHERE "workspaceId"=ANY($1::uuid[])', [fixtureWorkspaces]);
      await db.query('DELETE FROM contextflow."Workspace" WHERE "id"=ANY($1::uuid[])', [fixtureWorkspaces]);
      await db.query('DELETE FROM contextflow."UserProfile" WHERE "id"=ANY($1::uuid[])', [fixtureUsers]);
      await db.query('ALTER TABLE contextflow."GoogleDocBinding" ENABLE TRIGGER USER');
      await db.query('ALTER TABLE contextflow."GoogleDocCreateCommand" ENABLE TRIGGER USER');
      await db.query('COMMIT');
    } catch (error) { await db.query('ROLLBACK'); throw error; }
    finally { db.release(); await migration.end(); await health.onModuleDestroy(); vi.unstubAllGlobals(); vi.restoreAllMocks(); }
  });

  it('creates exactly once and replays by command key, including concurrent same-key requests', async () => {
    const owner = await fixture(), body = input(owner);
    const [first, raced] = await Promise.all([
      service.create(owner.request, owner.projectId, body), service.create(owner.request, owner.projectId, body),
    ]);
    expect([first.command.state, raced.command.state].every(state => state === 'SUBMITTED' || state === 'CREATED')).toBe(true);
    expect(new Set([first.command.id, raced.command.id]).size).toBe(1);
    expect(first.command.commandKey).toBe(body.commandKey);
    expect(postCount).toBe(1);
    expect(await health.prisma.googleDocCreateCommand.findUniqueOrThrow({ where: { id: first.command.id } })).toMatchObject({ state: 'CREATED', documentId: 'synthetic-doc-1' });
    await expect(service.create(owner.request, owner.projectId, { ...body, title: 'Changed payload' })).rejects.toMatchObject({ status: 409 });
    expect(postCount).toBe(1);
    expect((await service.list(owner.request, owner.projectId)).commands).toHaveLength(1);
  });

  it('keeps the create result when a concurrent reconciliation finds the marker before POST response returns', async () => {
    const owner = await fixture();
    onPost = async () => {
      const marker = remote[0]!;
      const observed = await service.reconcile(owner.request, owner.projectId, marker.marker, { connectionId: owner.connectionId });
      expect(observed.command).toMatchObject({ state: 'CREATED', documentId: marker.documentId });
    };
    const result = await service.create(owner.request, owner.projectId, input(owner));
    expect(result.command).toMatchObject({ state: 'CREATED', documentId: 'synthetic-doc-1' });
    expect(postCount).toBe(1);
  });

  it('keeps an uncertain POST unresolved and reconciles zero then one exact marker without another POST', async () => {
    const owner = await fixture(), body = input(owner);
    losePostResponse = true;
    await expect(service.create(owner.request, owner.projectId, body)).rejects.toMatchObject({ status: 503 });
    expect((await service.list(owner.request, owner.projectId)).commands[0]).toMatchObject({ state: 'UNKNOWN', documentId: null });
    hideFinderResults = true;
    const none = await service.reconcile(owner.request, owner.projectId, (await service.list(owner.request, owner.projectId)).commands[0]!.id,
      { connectionId: owner.connectionId });
    expect(none.command.state).toBe('UNKNOWN');
    hideFinderResults = false;
    const found = await service.reconcile(owner.request, owner.projectId, none.command.id, { connectionId: owner.connectionId });
    expect(found.command).toMatchObject({ state: 'CREATED', documentId: 'synthetic-doc-1' });
    expect(postCount).toBe(1);
  });

  it('lets another active Workspace member reconcile an unknown create with their own Google connection', async () => {
    const creator = await fixture(), member = await addWorkspaceMember(creator), body = input(creator);
    losePostResponse = true;
    await expect(service.create(creator.request, creator.projectId, body)).rejects.toMatchObject({ status: 503 });
    const unresolved = (await service.list(member.request, creator.projectId)).commands[0]!;
    expect(unresolved).toMatchObject({ state: 'UNKNOWN', recoverableByOwnConnection: true,
      createdBy: { userId: creator.userId, displayName: null } });
    expect(unresolved).not.toHaveProperty('encryptedTokens');

    const recovered = await service.reconcile(member.request, creator.projectId, unresolved.id, { connectionId: member.connectionId });
    expect(recovered.command).toMatchObject({ state: 'CREATED', documentId: 'synthetic-doc-1', recoverableByOwnConnection: false });
    expect((await health.prisma.googleDocCreateCommand.findUniqueOrThrow({ where: { id: unresolved.id } }))
      ).toMatchObject({ userId: creator.userId, connectionId: creator.connectionId, state: 'CREATED' });
    expect(postCount).toBe(1);
  });

  it('does not expose or reconcile an unresolved command to a member of another Workspace', async () => {
    const creator = await fixture(), stranger = await fixture();
    const body = input(creator);
    losePostResponse = true;
    await expect(service.create(creator.request, creator.projectId, body)).rejects.toMatchObject({ status: 503 });
    const commandId = (await service.list(creator.request, creator.projectId)).commands[0]!.id;
    await expect(service.list(stranger.request, creator.projectId)).rejects.toMatchObject({ status: 404 });
    await expect(service.reconcile(stranger.request, creator.projectId, commandId, { connectionId: stranger.connectionId }))
      .rejects.toMatchObject({ status: 404 });
    expect(postCount).toBe(1);
  });

  it('denies a non-member and another user’s connection before any provider write', async () => {
    const owner = await fixture(), stranger = await fixture();
    await expect(service.create(stranger.request, owner.projectId, input(stranger, { connectionId: owner.connectionId }))).rejects.toMatchObject({ status: 404 });
    await expect(service.create(owner.request, owner.projectId, input(owner, { connectionId: stranger.connectionId }))).rejects.toMatchObject({ status: 404 });
    expect(postCount).toBe(0);
  });

  it('preserves a known document ID when logout wins the OAuth post-operation fence', async () => {
    const owner = await fixture(), body = input(owner);
    onPost = async () => { await health.prisma.appSession.update({ where: { id: owner.sessionId }, data: { revokedAt: new Date(), encryptedProviderTokens: null } }); };
    await expect(service.create(owner.request, owner.projectId, body)).rejects.toMatchObject({ status: 401 });
    const saved = await health.prisma.googleDocCreateCommand.findFirstOrThrow({ where: { projectId: owner.projectId } });
    expect(saved).toMatchObject({ state: 'CREATED', documentId: 'synthetic-doc-1' });
    expect(postCount).toBe(1);
  });

  it('marks the command FAILED when the session disappears before token acquisition and dispatch', async () => {
    const owner = await fixture(), body = input(owner);
    const oauth = (service as unknown as { oauth: GoogleOAuthService }).oauth;
    const original = oauth.withOwnGoogleDocsClient.bind(oauth);
    const spy = vi.spyOn(oauth, 'withOwnGoogleDocsClient').mockImplementation((async (request, connectionId, operation) =>
      original(request, connectionId, client => operation({ ...client, createBlankDocument: async (operationId, title, onDispatch) => {
        await health.prisma.appSession.update({ where: { id: owner.sessionId }, data: { revokedAt: new Date(), encryptedProviderTokens: null } });
        return client.createBlankDocument(operationId, title, onDispatch);
      } } as GoogleDocsClient))) as typeof oauth.withOwnGoogleDocsClient);
    await expect(service.create(owner.request, owner.projectId, body)).rejects.toMatchObject({ status: 401 });
    spy.mockRestore();
    const saved = await health.prisma.googleDocCreateCommand.findFirstOrThrow({ where: { projectId: owner.projectId } });
    expect(saved).toMatchObject({ state: 'FAILED', documentId: null });
    expect(postCount).toBe(0);
  });

  it('rejects a stale Article counter and active binding before writing to Google', async () => {
    const stale = await fixture();
    await expect(service.create(stale.request, stale.projectId, input(stale, { expectedArticleRevision: 1 }))).rejects.toMatchObject({ status: 409 });
    const bound = await fixture();
    await health.prisma.googleDocBinding.create({ data: { id: randomUUID(), projectId: bound.projectId, connectionId: bound.connectionId,
      connectionUserId: bound.userId, documentId: 'already-bound-document', tabId: 'tab', createdBy: bound.userId } });
    await expect(service.create(bound.request, bound.projectId, input(bound))).rejects.toMatchObject({ status: 409 });
    expect(postCount).toBe(0);
  });
});
