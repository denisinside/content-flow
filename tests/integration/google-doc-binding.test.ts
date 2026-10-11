import { randomBytes, randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { DependencyHealthService, GOOGLE_DOCS_FILE_SCOPE, loadRuntimeConfig, type GoogleDocsDocument } from '@contextflow/backend';
import { EXTERNAL_PROCESSING_NOTICE, ExternalProcessingService } from '../../apps/api/src/auth/external-processing.js';
import { SESSION_COOKIE } from '../../apps/api/src/auth/csrf.js';
import { tokenDigest } from '../../apps/api/src/auth/session-crypto.js';
import type { AuthenticatedRequest } from '../../apps/api/src/auth/session.guard.js';
import { SessionService } from '../../apps/api/src/auth/session-service.js';
import { loadGoogleOAuthRuntime } from '../../apps/api/src/google-docs/google-oauth.config.js';
import { GoogleDocBindingService } from '../../apps/api/src/google-docs/google-doc-binding.service.js';
import { GoogleOAuthService } from '../../apps/api/src/google-docs/google-oauth.service.js';

const testKey = Buffer.alloc(32, 31).toString('base64');
const runtimeEnv = {
  NODE_ENV: 'test', TEST_API_HOST: '127.0.0.1', TEST_API_PORT: '3000',
  TEST_GOOGLE_DOCS_CLIENT_ID: 'synthetic-binding-client', TEST_GOOGLE_DOCS_CLIENT_SECRET: 'synthetic-binding-secret',
  TEST_GOOGLE_DOCS_REDIRECT_URI: 'http://localhost:3000/api/v1/google-docs/oauth/callback',
  TEST_GOOGLE_DOCS_TOKEN_ENCRYPTION_KEY: testKey, TEST_GOOGLE_DOCS_TOKEN_ENCRYPTION_KEY_VERSION: '1',
};
const textDocument = (documentId: string, tabId = 'synthetic-tab') => ({
  documentId, title: 'Synthetic Doc', revisionId: 'synthetic-revision-1', comments: [], suggestions: [],
  tabs: [{ tabProperties: { tabId, title: 'Selected text' }, documentTab: { body: { content: [
    { startIndex: 1, endIndex: 7, paragraph: { elements: [{ startIndex: 1, endIndex: 7, textRun: { content: 'Hello\n' } }] } },
  ] } } }],
});
const response = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });

describe('Google Docs document binding on isolated TEST PostgreSQL', () => {
  const config = loadRuntimeConfig();
  const health = new DependencyHealthService(config);
  const migration = new Pool({ connectionString: config.directDatabaseUrl, ssl: false, max: 1 });
  const fixtureUsers: string[] = [], fixtureWorkspaces: string[] = [], fixtureProjects: string[] = [], fixtureConnections: string[] = [], fixtureSessions: string[] = [];
  const sessions: Array<{ id: string; cookie: string; userId: string; active: boolean }> = [];
  const documentReads: Array<{ documentId: string; authorization: string | null }> = [];
  let document: GoogleDocsDocument = textDocument('synthetic-document') as GoogleDocsDocument;
  let onDocument: (() => Promise<void>) | null = null;
  let service: GoogleDocBindingService;
  let oauthRuntime: ReturnType<typeof loadGoogleOAuthRuntime>;

  beforeEach(() => {
    document = textDocument('synthetic-document') as GoogleDocsDocument;
    onDocument = null;
  });

  beforeAll(async () => {
    expect(config.nodeEnv).toBe('test');
    expect(new URL(config.databaseUrl).port).toBe('54330');
    expect((await health.check()).status).toBe('ready');
    vi.stubGlobal('fetch', vi.fn<typeof fetch>(async (input, init) => {
      const url = String(input);
      const match = url.match(/^https:\/\/docs\.googleapis\.com\/v1\/documents\/([^?]+)/u);
      if (!match) throw new Error('unexpected synthetic provider URL');
      const requestedId = decodeURIComponent(match[1]!);
      documentReads.push({ documentId: requestedId, authorization: new Headers(init?.headers).get('authorization') });
      await onDocument?.(); onDocument = null;
      if (requestedId !== document.documentId) return new Response(null, { status: 404 });
      return response(document);
    }));
    oauthRuntime = loadGoogleOAuthRuntime(runtimeEnv);
    if (oauthRuntime.kind !== 'configured') throw new Error('Synthetic OAuth configuration unavailable');
    service = new GoogleDocBindingService(health, new GoogleOAuthService(health, {
      check: vi.fn(async (cookie: string) => {
        const row = sessions.find(item => item.cookie === cookie);
        return row?.active ? { kind: 'active', user: { id: row.userId, email: 'synthetic@example.test', displayName: 'Synthetic' } } : { kind: 'expired' };
      }),
    } as unknown as SessionService, new ExternalProcessingService(health), oauthRuntime));
  });

  async function fixture(options: { member?: boolean; formats?: Array<'ARTICLE' | 'TELEGRAM_POST'> } = {}) {
    if (oauthRuntime.kind !== 'configured') throw new Error('Synthetic OAuth configuration unavailable');
    const userId = randomUUID(), sessionId = randomUUID(), cookie = randomBytes(32).toString('base64url');
    const workspaceId = randomUUID(), projectId = randomUUID(), connectionId = randomUUID();
    fixtureUsers.push(userId); fixtureWorkspaces.push(workspaceId); fixtureProjects.push(projectId); fixtureConnections.push(connectionId); fixtureSessions.push(sessionId);
    await health.prisma.userProfile.create({ data: { id: userId, externalProcessingNoticeVersion: EXTERNAL_PROCESSING_NOTICE.version,
      externalProcessingAcceptedAt: new Date() } });
    await health.prisma.workspace.create({ data: { id: workspaceId, name: 'Synthetic Google Docs workspace', ownerId: userId,
      members: { create: options.member === false ? [] : [{ userId }] }, styles: { create: { revision: 1, createdBy: userId } } } });
    await health.prisma.project.create({ data: { id: projectId, workspaceId, topic: 'Synthetic Article', formats: options.formats ?? ['ARTICLE'], createdBy: userId } });
    await health.prisma.appSession.create({ data: { id: sessionId, cookieDigest: tokenDigest(cookie), userId, tokenKeyVersion: 1,
      encryptedProviderTokens: 'synthetic-session-ciphertext', providerTokenExpiresAt: new Date(Date.now() + 3_600_000),
      expiresAt: new Date(Date.now() + 3_600_000), lastUserActivityAt: new Date() } });
    const sealed = oauthRuntime.crypto.encryptTokens({ accessToken: 'synthetic-binding-access', refreshToken: 'synthetic-binding-refresh', expiresAtMs: Date.now() + 3_600_000 }, userId, connectionId);
    await health.prisma.googleDriveConnection.create({ data: { id: connectionId, userId, googlePermissionId: `synthetic-account-${userId}`,
      encryptedTokens: sealed.ciphertext, tokenKeyVersion: sealed.keyVersion, grantedScope: GOOGLE_DOCS_FILE_SCOPE,
      accessExpiresAt: new Date(Date.now() + 3_600_000), refreshExpiresAt: new Date(Date.now() + 86_400_000) } });
    const record = { id: sessionId, cookie, userId, active: true }; sessions.push(record);
    const request = { headers: { cookie: `${SESSION_COOKIE}=${cookie}` }, sessionUser: { id: userId, email: 'synthetic@example.test', displayName: 'Synthetic' } } as unknown as AuthenticatedRequest;
    return { userId, workspaceId, projectId, connectionId, sessionId, cookie, record, request };
  }

  function bindInput(owner: Awaited<ReturnType<typeof fixture>>, overrides: Record<string, unknown> = {}) {
    return { connectionId: owner.connectionId, documentId: 'synthetic-document', tabId: 'synthetic-tab', commandKey: randomUUID(),
      expectedArticleRevision: 0, acknowledgeWorkspaceSharing: true, ...overrides };
  }

  afterAll(async () => {
    const db = await migration.connect();
    try {
      await db.query('BEGIN');
      for (const table of ['GoogleDocBinding', 'GoogleDocSnapshot', 'GoogleDocBindCommand']) await db.query(`ALTER TABLE contextflow."${table}" DISABLE TRIGGER USER`);
      await db.query('DELETE FROM contextflow."GoogleDocSnapshot" WHERE "projectId"=ANY($1::uuid[])', [fixtureProjects]);
      await db.query('DELETE FROM contextflow."GoogleDocBindCommand" WHERE "projectId"=ANY($1::uuid[])', [fixtureProjects]);
      await db.query('DELETE FROM contextflow."GoogleDocBinding" WHERE "projectId"=ANY($1::uuid[])', [fixtureProjects]);
      await db.query('DELETE FROM contextflow."GoogleDriveConnection" WHERE "id"=ANY($1::uuid[])', [fixtureConnections]);
      await db.query('DELETE FROM contextflow."AppSession" WHERE "id"=ANY($1::uuid[])', [fixtureSessions]);
      await db.query('DELETE FROM contextflow."Project" WHERE "id"=ANY($1::uuid[])', [fixtureProjects]);
      await db.query('DELETE FROM contextflow."WorkspaceStyleRevision" WHERE "workspaceId"=ANY($1::uuid[])', [fixtureWorkspaces]);
      await db.query('DELETE FROM contextflow."WorkspaceMember" WHERE "workspaceId"=ANY($1::uuid[])', [fixtureWorkspaces]);
      await db.query('DELETE FROM contextflow."Workspace" WHERE "id"=ANY($1::uuid[])', [fixtureWorkspaces]);
      await db.query('DELETE FROM contextflow."UserProfile" WHERE "id"=ANY($1::uuid[])', [fixtureUsers]);
      for (const table of ['GoogleDocBinding', 'GoogleDocSnapshot', 'GoogleDocBindCommand']) await db.query(`ALTER TABLE contextflow."${table}" ENABLE TRIGGER USER`);
      await db.query('COMMIT');
    } catch (error) { await db.query('ROLLBACK'); throw error; }
    finally { db.release(); await migration.end(); await health.onModuleDestroy(); vi.unstubAllGlobals(); vi.restoreAllMocks(); }
  });

  it('inspects only safe document metadata, binds an explicit tab, captures full immutable payload and replays exactly', async () => {
    const owner = await fixture();
    const inspected = await service.inspect(owner.request, owner.projectId, { connectionId: owner.connectionId, documentId: 'synthetic-document' });
    expect(inspected).toEqual({ document: { documentId: 'synthetic-document', title: 'Synthetic Doc', revisionId: 'synthetic-revision-1', tabs: [{ tabId: 'synthetic-tab', title: 'Selected text' }] } });
    expect(JSON.stringify(inspected)).not.toContain('Hello');
    const input = bindInput(owner);
    await expect(service.bind(owner.request, owner.projectId, { ...input, acknowledgeWorkspaceSharing: false })).rejects.toMatchObject({ status: 400 });
    const bound = await service.bind(owner.request, owner.projectId, input);
    expect(bound).toMatchObject({ replayed: false, binding: { projectId: owner.projectId, connectionId: owner.connectionId,
      documentId: 'synthetic-document', tabId: 'synthetic-tab', endedAt: null, snapshot: { remoteRevision: 'synthetic-revision-1',
        converted: { plainText: 'Hello', inlineCoordinatesValid: true, unsupported: [] } } } });
    const saved = await health.prisma.googleDocSnapshot.findFirstOrThrow({ where: { bindingId: bound.binding.id } });
    expect(saved.payload).toMatchObject({ documentId: 'synthetic-document', tabs: [{ documentTab: { body: { content: [{ paragraph: { elements: [{ textRun: { content: 'Hello\n' } }] } }] } } }] });
    expect(await health.prisma.article.findUnique({ where: { projectId: owner.projectId } })).toBeNull();
    const reads = documentReads.length;
    const replay = await service.bind(owner.request, owner.projectId, input);
    expect(replay).toMatchObject({ replayed: true, binding: { id: bound.binding.id } });
    expect(documentReads).toHaveLength(reads);
    await expect(service.bind(owner.request, owner.projectId, { ...input, expectedArticleRevision: 1 })).rejects.toMatchObject({ status: 409 });
    const unbound = await service.unbind(owner.request, owner.projectId, { expectedBindingId: bound.binding.id });
    expect(unbound.binding).toMatchObject({ id: bound.binding.id, endedAt: expect.any(String) });
    expect(await service.get(owner.request, owner.projectId)).toEqual({ binding: null });
    expect(await health.prisma.googleDocBinding.count({ where: { projectId: owner.projectId } })).toBe(1);
    await health.prisma.project.update({ where: { id: owner.projectId }, data: { formats: ['TELEGRAM_POST'] } });
    await health.prisma.userProfile.update({ where: { id: owner.userId }, data: { externalProcessingNoticeVersion: null, externalProcessingAcceptedAt: null } });
    const historicalReplay = await service.bind(owner.request, owner.projectId, input);
    expect(historicalReplay).toMatchObject({ replayed: true, binding: { id: bound.binding.id, endedAt: expect.any(String) } });
  });

  it('retains full unsupported structures as snapshot flags without creating or changing the Article', async () => {
    const owner = await fixture();
    const documentId = 'synthetic-unsupported-document';
    document = { documentId, title: 'Synthetic Doc', revisionId: 'synthetic-revision-unsupported', comments: [], suggestions: [], tabs: [
      { tabProperties: { tabId: 'synthetic-table-tab', title: 'Table tab' }, documentTab: { body: { content: [
        { startIndex: 1, endIndex: 3, table: { tableRows: [{ tableCells: [] }] } },
      ] } } },
    ] } as unknown as GoogleDocsDocument;
    const responseValue = await service.bind(owner.request, owner.projectId, bindInput(owner, { documentId, tabId: 'synthetic-table-tab' }));
    expect(responseValue.binding.snapshot?.converted.unsupported).toEqual(expect.arrayContaining([expect.objectContaining({ type: 'non-paragraph-structural-element' })]));
    const saved = await health.prisma.googleDocSnapshot.findFirstOrThrow({ where: { bindingId: responseValue.binding.id } });
    expect(saved.payload).toMatchObject({ tabs: [expect.objectContaining({ documentTab: expect.objectContaining({
      body: expect.objectContaining({ content: [expect.objectContaining({ table: { tableRows: [{ tableCells: [] }] } })] }),
    }) })] });
    expect(await health.prisma.article.findUnique({ where: { projectId: owner.projectId } })).toBeNull();
  });

  it('rejects foreign projects and another member’s personal Drive connection before reading Docs', async () => {
    const owner = await fixture(), member = await fixture();
    await health.prisma.workspaceMember.create({ data: { workspaceId: owner.workspaceId, userId: member.userId } });
    const before = documentReads.length;
    await expect(service.inspect(member.request, owner.projectId, { connectionId: owner.connectionId, documentId: 'synthetic-document' }))
      .rejects.toMatchObject({ status: 404 });
    await expect(service.inspect(owner.request, member.projectId, { connectionId: member.connectionId, documentId: 'synthetic-document' }))
      .rejects.toMatchObject({ status: 404 });
    const foreignProject = await health.prisma.project.create({ data: { workspaceId: member.workspaceId, topic: 'No Article', formats: ['TELEGRAM_POST'], createdBy: member.userId } });
    fixtureProjects.push(foreignProject.id);
    await expect(service.inspect(member.request, foreignProject.id, { connectionId: member.connectionId, documentId: 'synthetic-document' }))
      .rejects.toMatchObject({ status: 409 });
    expect(documentReads).toHaveLength(before);
  });

  it('rejects duplicate active document tabs and preserves the first binding', async () => {
    const owner = await fixture();
    const secondProject = await health.prisma.project.create({ data: { workspaceId: owner.workspaceId, topic: 'Second article', formats: ['ARTICLE'], createdBy: owner.userId } });
    fixtureProjects.push(secondProject.id);
    const first = await service.bind(owner.request, owner.projectId, bindInput(owner));
    await expect(service.bind(owner.request, secondProject.id, bindInput(owner))).rejects.toMatchObject({ status: 409 });
    expect(await health.prisma.googleDocBinding.count({ where: { endedAt: null, documentId: 'synthetic-document', tabId: 'synthetic-tab' } })).toBe(1);
    expect(await health.prisma.googleDocBindCommand.count({ where: { projectId: secondProject.id } })).toBe(0);
    expect(first.binding.endedAt).toBeNull();
  });

  it('rechecks membership and Article selection after remote reads before committing', async () => {
    const owner = await fixture();
    const input = bindInput(owner);
    onDocument = async () => {
      await health.prisma.workspaceMember.update({ where: { workspaceId_userId: { workspaceId: owner.workspaceId, userId: owner.userId } }, data: { leftAt: new Date() } });
    };
    await expect(service.bind(owner.request, owner.projectId, input)).rejects.toMatchObject({ status: 404 });
    expect(await health.prisma.googleDocBinding.count({ where: { projectId: owner.projectId } })).toBe(0);
  });

  it('does not commit a binding if the session is revoked after the Google read returns', async () => {
    const owner = await fixture();
    const oauth = service['oauth'] as GoogleOAuthService;
    const original = oauth.withOwnGoogleDocsClient.bind(oauth);
    vi.spyOn(oauth, 'withOwnGoogleDocsClient').mockImplementation((async (request, connectionId, operation) => {
      const fetched = await original(request, connectionId, operation);
      await health.prisma.appSession.update({ where: { id: owner.sessionId }, data: { revokedAt: new Date(), encryptedProviderTokens: null } });
      return fetched;
    }) as typeof oauth.withOwnGoogleDocsClient);
    await expect(service.bind(owner.request, owner.projectId, bindInput(owner))).rejects.toMatchObject({ status: 401 });
    expect(await health.prisma.googleDocBinding.count({ where: { projectId: owner.projectId } })).toBe(0);
    expect(await health.prisma.googleDocSnapshot.count({ where: { projectId: owner.projectId } })).toBe(0);
  });
});
