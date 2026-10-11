import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { DependencyHealthService, GOOGLE_DOCS_FILE_SCOPE, loadRuntimeConfig, type GoogleDocsClient } from '@contextflow/backend';
import { ExternalProcessingService, EXTERNAL_PROCESSING_NOTICE } from '../../apps/api/src/auth/external-processing.js';
import { SESSION_COOKIE } from '../../apps/api/src/auth/csrf.js';
import { tokenDigest } from '../../apps/api/src/auth/session-crypto.js';
import type { AuthenticatedRequest } from '../../apps/api/src/auth/session.guard.js';
import { SessionService } from '../../apps/api/src/auth/session-service.js';
import { loadGoogleOAuthRuntime } from '../../apps/api/src/google-docs/google-oauth.config.js';
import { GoogleOAuthService } from '../../apps/api/src/google-docs/google-oauth.service.js';

const testKey = Buffer.alloc(32, 19).toString('base64');
const testConfig = {
  NODE_ENV: 'test', TEST_API_HOST: '127.0.0.1', TEST_API_PORT: '3000',
  TEST_GOOGLE_DOCS_CLIENT_ID: 'synthetic-oauth-client', TEST_GOOGLE_DOCS_CLIENT_SECRET: 'synthetic-oauth-secret',
  TEST_GOOGLE_DOCS_REDIRECT_URI: 'http://localhost:3000/api/v1/google-docs/oauth/callback',
  TEST_GOOGLE_DOCS_TOKEN_ENCRYPTION_KEY: testKey, TEST_GOOGLE_DOCS_TOKEN_ENCRYPTION_KEY_VERSION: '1',
};
const response = (value: unknown, status = 200) => new Response(value === null ? null : JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
const tokenSet = (access: string, refresh?: string) => ({ access_token: access, token_type: 'Bearer', expires_in: 3600,
  ...(refresh ? { refresh_token: refresh, refresh_token_expires_in: 86_400 } : {}), scope: GOOGLE_DOCS_FILE_SCOPE });

describe('Google OAuth personal connection runtime on isolated TEST PostgreSQL', () => {
  const config = loadRuntimeConfig();
  const health = new DependencyHealthService(config);
  const sql = new Pool({ connectionString: config.directDatabaseUrl, ssl: false, max: 2 });
  const users: string[] = [];
  const sessions: Array<{ id: string; cookie: string; userId: string; active: boolean }> = [];
  const exchanges: Array<ReturnType<typeof tokenSet> | { access_token: string; token_type: string; expires_in: number; scope: string }> = [];
  const refreshes: Array<{ payload: unknown; status: number; delayMs?: number; transportFailure?: boolean }> = [];
  const accounts: Array<{ permissionId: string; displayName: string }> = [];
  const documentReads: Array<{ authorization: string | null }> = [];
  const documentStatuses: number[] = [];
  let revokeStatus = 200;
  let onExchange: (() => void | Promise<void>) | null = null;
  let onRefresh: (() => void | Promise<void>) | null = null;
  let onDocument: (() => void | Promise<void>) | null = null;

  beforeAll(async () => {
    expect(config.nodeEnv).toBe('test');
    expect(new URL(config.databaseUrl).port).toBe('54330');
    expect((await health.check()).status).toBe('ready');
    const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
      const url = String(input);
      if (url === 'https://oauth2.googleapis.com/token') {
        const form = new URLSearchParams(String(init?.body));
        if (form.get('grant_type') === 'refresh_token') {
          await onRefresh?.(); onRefresh = null;
          const next = refreshes.shift();
          if (!next) return response({ error: 'missing synthetic refresh fixture' }, 500);
          if (next.delayMs) await new Promise(resolve => setTimeout(resolve, next.delayMs));
          if (next.transportFailure) throw new Error('synthetic network reset containing private fixture data');
          return response(next.payload, next.status);
        }
        await onExchange?.(); onExchange = null;
        const tokens = exchanges.shift();
        if (!tokens) return response({ error: 'missing synthetic token fixture' }, 500);
        return response(tokens);
      }
      if (url.startsWith('https://www.googleapis.com/drive/v3/about?')) {
        const account = accounts.shift();
        return account ? response({ user: account }) : response({ error: 'missing synthetic account fixture' }, 500);
      }
      if (url === 'https://oauth2.googleapis.com/revoke' && init?.method === 'POST') return response(null, revokeStatus);
      if (url.startsWith('https://docs.googleapis.com/v1/documents/')) {
        documentReads.push({ authorization: new Headers(init?.headers).get('authorization') });
        await onDocument?.(); onDocument = null;
        const status = documentStatuses.shift() ?? 200;
        if (status !== 200) return response({ error: 'synthetic Docs provider failure' }, status);
        return response({ documentId: 'synthetic-document', title: 'Synthetic', revisionId: 'synthetic-rev-1',
          tabs: [{ tabProperties: { tabId: 'synthetic-tab' }, documentTab: { body: { content: [] } } }] });
      }
      throw new Error('unexpected mocked OAuth request');
    });
    vi.stubGlobal('fetch', fetchMock);
  });

  async function fixture(options: { accepted?: boolean; expiresAt?: Date } = {}) {
    const userId = randomUUID(), sessionId = randomUUID(), cookie = randomBytes(32).toString('base64url');
    users.push(userId);
    await health.prisma.userProfile.create({ data: { id: userId,
      ...(options.accepted === false ? {} : { externalProcessingNoticeVersion: EXTERNAL_PROCESSING_NOTICE.version, externalProcessingAcceptedAt: new Date() }) } });
    await health.prisma.appSession.create({ data: { id: sessionId, cookieDigest: tokenDigest(cookie), userId, tokenKeyVersion: 1,
      providerTokenExpiresAt: new Date(Date.now() + 60 * 60_000), expiresAt: options.expiresAt ?? new Date(Date.now() + 60 * 60_000),
      encryptedProviderTokens: 'synthetic-session-ciphertext',
      lastUserActivityAt: new Date(), createdAt: new Date(Date.now() - 60_000) } });
    const record = { id: sessionId, cookie, userId, active: true };
    sessions.push(record);
    const checker = { check: vi.fn(async (rawCookie: string) => {
      const current = sessions.find(item => item.cookie === rawCookie);
      return current?.active ? { kind: 'active', user: { id: current.userId, email: 'synthetic@example.test', displayName: 'Synthetic' } } : { kind: 'expired' };
    }) };
    const runtime = loadGoogleOAuthRuntime(testConfig);
    if (runtime.kind !== 'configured') throw new Error('Synthetic OAuth configuration unavailable');
    const service = new GoogleOAuthService(health, checker as unknown as SessionService, new ExternalProcessingService(health), runtime);
    const request = { headers: { cookie: `${SESSION_COOKIE}=${cookie}` }, sessionUser: { id: userId, email: 'synthetic@example.test', displayName: 'Synthetic' } } as unknown as AuthenticatedRequest;
    return { service, request, userId, cookie, record, runtime, sessionCheck: checker };
  }

  async function sessionFor(userId: string) {
    const cookie = randomBytes(32).toString('base64url'), id = randomUUID();
    await health.prisma.appSession.create({ data: { id, cookieDigest: tokenDigest(cookie), userId, tokenKeyVersion: 1,
      providerTokenExpiresAt: new Date(Date.now() + 60 * 60_000), expiresAt: new Date(Date.now() + 60 * 60_000),
      encryptedProviderTokens: 'synthetic-session-ciphertext', lastUserActivityAt: new Date(), createdAt: new Date(Date.now() - 60_000) } });
    const record = { id, cookie, userId, active: true };
    sessions.push(record);
    const checker = { check: vi.fn(async (rawCookie: string) => {
      const current = sessions.find(item => item.cookie === rawCookie);
      return current?.active ? { kind: 'active', user: { id: current.userId, email: 'synthetic@example.test', displayName: 'Synthetic' } } : { kind: 'expired' };
    }) };
    const runtime = loadGoogleOAuthRuntime(testConfig);
    if (runtime.kind !== 'configured') throw new Error('Synthetic OAuth configuration unavailable');
    const service = new GoogleOAuthService(health, checker as unknown as SessionService, new ExternalProcessingService(health), runtime);
    const request = { headers: { cookie: `${SESSION_COOKIE}=${cookie}` }, sessionUser: { id: userId, email: 'synthetic@example.test', displayName: 'Synthetic' } } as unknown as AuthenticatedRequest;
    return { service, request, record, sessionCheck: checker };
  }

  async function start(service: GoogleOAuthService, request: AuthenticatedRequest): Promise<{ state: string }> {
    const started = await service.start(request);
    return { state: new URL(started.authorizationUrl).searchParams.get('state')! };
  }

  async function callback(service: GoogleOAuthService, request: AuthenticatedRequest, state: string) {
    return service.callback(request, { state, code: 'synthetic-one-time-code', scope: GOOGLE_DOCS_FILE_SCOPE, iss: 'https://accounts.google.com' });
  }

  function queue(permissionId: string, access: string, refresh?: string) {
    exchanges.push(tokenSet(access, refresh));
    accounts.push({ permissionId, displayName: 'Synthetic Google account' });
  }

  afterAll(async () => {
    for (const userId of users) {
      await sql.query('DELETE FROM contextflow."GoogleOAuthAttempt" WHERE "userId"=$1', [userId]);
      await sql.query('DELETE FROM contextflow."GoogleDriveConnection" WHERE "userId"=$1', [userId]);
      await sql.query('DELETE FROM contextflow."AppSession" WHERE "userId"=$1', [userId]);
      await sql.query('DELETE FROM contextflow."UserProfile" WHERE "id"=$1', [userId]);
    }
    await sql.end();
    await health.onModuleDestroy();
    vi.unstubAllGlobals(); vi.restoreAllMocks();
  });

  it('binds one-use state to the exact user and session and exposes no provider credentials', async () => {
    const owner = await fixture(), other = await fixture();
    const { state } = await start(owner.service, owner.request);
    await expect(callback(other.service, other.request, state)).rejects.toMatchObject({ status: 400 });
    queue('synthetic-owner-permission', 'synthetic-access-token', 'synthetic-refresh-token');
    const connected = await callback(owner.service, owner.request, state);
    expect(connected.connection.googlePermissionId).toBe('synthetic-owner-permission');
    expect(JSON.stringify(connected)).not.toMatch(/synthetic-(access|refresh)-token/u);
    const row = await health.prisma.googleDriveConnection.findUniqueOrThrow({ where: { id: connected.connection.id } });
    expect(row.encryptedTokens).not.toContain('synthetic-refresh-token');
    const stored = owner.runtime.crypto.decryptTokens({ ciphertext: row.encryptedTokens!, keyVersion: row.tokenKeyVersion }, owner.userId, row.id);
    expect(stored).toMatchObject({ accessToken: 'synthetic-access-token', refreshToken: 'synthetic-refresh-token' });
    await expect(callback(owner.service, owner.request, state)).rejects.toMatchObject({ status: 400 });
    expect(exchanges).toHaveLength(0);
    expect(await health.prisma.googleOAuthAttempt.count({ where: { userId: owner.userId, consumedAt: { not: null }, encryptedVerifier: null } })).toBe(1);
  });

  it('rejects expired attempts and sessions and stops a late OAuth response after logout', async () => {
    const expiredSession = await fixture({ expiresAt: new Date(Date.now() - 1_000) });
    const state = await start(expiredSession.service, expiredSession.request).catch(() => null);
    expect(state).toBeNull();

    const owner = await fixture();
    await start(owner.service, owner.request);
    const attempt = await health.prisma.googleOAuthAttempt.findFirstOrThrow({ where: { userId: owner.userId } });
    const staleCreatedAt = new Date(Date.now() - 12 * 60_000), staleExpiry = new Date(Date.now() - 2 * 60_000);
    const expiredState = randomBytes(32).toString('base64url');
    const expiredAttemptId = randomUUID();
    const sealedVerifier = owner.runtime.crypto.encryptVerifier('s'.repeat(64), owner.userId, expiredAttemptId);
    await sql.query(`INSERT INTO contextflow."GoogleOAuthAttempt" ("id","userId","appSessionId","stateDigest","encryptedVerifier","tokenKeyVersion","createdAt","expiresAt")
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`, [expiredAttemptId, owner.userId, attempt.appSessionId,
      createHash('sha256').update(expiredState, 'ascii').digest('hex'), sealedVerifier.ciphertext, sealedVerifier.keyVersion, staleCreatedAt, staleExpiry]);
    await expect(callback(owner.service, owner.request, expiredState)).rejects.toMatchObject({ status: 400 });

    const late = await fixture();
    const lateStart = await start(late.service, late.request);
    queue('synthetic-late-permission', 'synthetic-late-access', 'synthetic-late-refresh');
    onExchange = () => { late.record.active = false; };
    await expect(callback(late.service, late.request, lateStart.state)).rejects.toMatchObject({ status: 401 });
    expect(await health.prisma.googleDriveConnection.count({ where: { userId: late.userId } })).toBe(0);
    expect(late.sessionCheck.check).toHaveBeenCalled();
  });

  it('preserves an existing refresh token when Google omits one and clears it locally when revocation fails', async () => {
    const owner = await fixture();
    const permissionId = `synthetic-reconnect-${randomUUID()}`;
    const first = await start(owner.service, owner.request);
    queue(permissionId, 'synthetic-first-access', 'synthetic-stable-refresh');
    const created = await callback(owner.service, owner.request, first.state);
    const reconnect = await start(owner.service, owner.request);
    exchanges.push({ access_token: 'synthetic-next-access', token_type: 'Bearer', expires_in: 3600, scope: GOOGLE_DOCS_FILE_SCOPE });
    accounts.push({ permissionId, displayName: 'Synthetic Google account' });
    const next = await callback(owner.service, owner.request, reconnect.state);
    expect(next.connection.id).toBe(created.connection.id);
    expect(next.connection.generation).toBe(2);
    const row = await health.prisma.googleDriveConnection.findUniqueOrThrow({ where: { id: next.connection.id } });
    expect(owner.runtime.crypto.decryptTokens({ ciphertext: row.encryptedTokens!, keyVersion: row.tokenKeyVersion }, owner.userId, row.id))
      .toMatchObject({ accessToken: 'synthetic-next-access', refreshToken: 'synthetic-stable-refresh' });

    revokeStatus = 503;
    const disconnected = await owner.service.disconnect(owner.request, next.connection.id);
    expect(disconnected.providerRevocation).toBe('pending');
    const cleared = await health.prisma.googleDriveConnection.findUniqueOrThrow({ where: { id: next.connection.id } });
    expect(cleared).toMatchObject({ encryptedTokens: null, revokedAt: expect.any(Date), generation: 3 });
    revokeStatus = 200;

    const firstConnection = await fixture();
    const noRefresh = await start(firstConnection.service, firstConnection.request);
    exchanges.push({ access_token: 'synthetic-no-refresh-access', token_type: 'Bearer', expires_in: 3600, scope: GOOGLE_DOCS_FILE_SCOPE });
    accounts.push({ permissionId: `synthetic-no-refresh-${randomUUID()}`, displayName: 'Synthetic Google account' });
    await expect(callback(firstConnection.service, firstConnection.request, noRefresh.state)).rejects.toMatchObject({ status: 400 });
    expect(await health.prisma.googleDriveConnection.count({ where: { userId: firstConnection.userId } })).toBe(0);
  });

  it('allows local disconnection after the external-processing notice is no longer accepted', async () => {
    const owner = await fixture();
    const connected = await start(owner.service, owner.request);
    queue('synthetic-accepted-account', 'synthetic-account-access', 'synthetic-account-refresh');
    const result = await callback(owner.service, owner.request, connected.state);
    await health.prisma.userProfile.update({ where: { id: owner.userId }, data: { externalProcessingNoticeVersion: null, externalProcessingAcceptedAt: null } });
    const disconnected = await owner.service.disconnect(owner.request, result.connection.id);
    expect(disconnected.connection.status).toBe('disconnected');
    expect(disconnected.providerRevocation).toBe('confirmed');
  });

  it('rejects another session of the same user and a changed notice during code exchange', async () => {
    const owner = await fixture();
    const started = await start(owner.service, owner.request);
    const cookie = randomBytes(32).toString('base64url');
    await health.prisma.appSession.create({ data: { id: randomUUID(), cookieDigest: tokenDigest(cookie), userId: owner.userId,
      encryptedProviderTokens: 'synthetic-session-ciphertext', tokenKeyVersion: 1,
      providerTokenExpiresAt: new Date(Date.now() + 3_600_000), expiresAt: new Date(Date.now() + 3_600_000) } });
    sessions.push({ id: randomUUID(), cookie, userId: owner.userId, active: true });
    const alternate = { ...owner.request, headers: { cookie: `${SESSION_COOKIE}=${cookie}` } } as AuthenticatedRequest;
    await expect(callback(owner.service, alternate, started.state)).rejects.toMatchObject({ status: 400 });
    queue(`synthetic-notice-${randomUUID()}`, 'synthetic-notice-access', 'synthetic-notice-refresh');
    onExchange = async () => {
      await health.prisma.userProfile.update({ where: { id: owner.userId }, data: { externalProcessingNoticeVersion: null, externalProcessingAcceptedAt: null } });
    };
    await expect(callback(owner.service, owner.request, started.state)).rejects.toMatchObject({ status: 403 });
    expect(await health.prisma.googleDriveConnection.count({ where: { userId: owner.userId } })).toBe(0);
  });

  it('clears credentials despite missing key configuration and denies another user disconnection', async () => {
    const owner = await fixture(), other = await fixture();
    const started = await start(owner.service, owner.request);
    queue(`synthetic-disabled-${randomUUID()}`, 'synthetic-disabled-access', 'synthetic-disabled-refresh');
    const result = await callback(owner.service, owner.request, started.state);
    await expect(other.service.disconnect(other.request, result.connection.id)).rejects.toMatchObject({ status: 400 });
    const disabled = new GoogleOAuthService(health, owner.sessionCheck as unknown as SessionService, new ExternalProcessingService(health), { kind: 'disabled' });
    expect(await disabled.disconnect(owner.request, result.connection.id)).toMatchObject({ connection: { status: 'disconnected' }, providerRevocation: 'pending' });
    expect(await health.prisma.googleDriveConnection.findUniqueOrThrow({ where: { id: result.connection.id } })).toMatchObject({ encryptedTokens: null });
    expect(await disabled.list(owner.request)).toMatchObject({ connections: [{ status: 'disconnected', providerAccess: 'verify_in_google_account' }] });
  });

  it('does not restore a connection using a known expired refresh grant', async () => {
    const owner = await fixture();
    const permissionId = `synthetic-expired-refresh-${randomUUID()}`;
    const first = await start(owner.service, owner.request);
    queue(permissionId, 'synthetic-expiring-access', 'synthetic-expiring-refresh');
    const connected = await callback(owner.service, owner.request, first.state);
    await health.prisma.googleDriveConnection.update({ where: { id: connected.connection.id }, data: {
      generation: { increment: 1 }, updatedAt: new Date(), refreshExpiresAt: new Date(Date.now() - 1000),
    } });
    const second = await start(owner.service, owner.request);
    queue(permissionId, 'synthetic-new-access');
    await expect(callback(owner.service, owner.request, second.state)).rejects.toMatchObject({ status: 400 });
    expect(await health.prisma.googleDriveConnection.findUniqueOrThrow({ where: { id: connected.connection.id } })).toMatchObject({ generation: 2 });
    expect(await owner.service.list(owner.request)).toMatchObject({ connections: [{ status: 'needs_connection', providerAccess: 'reauthorize' }] });
  });

  it('reuses a fresh access token without refreshing and returns only a server client result', async () => {
    const owner = await fixture();
    const started = await start(owner.service, owner.request);
    queue(`synthetic-cached-${randomUUID()}`, 'synthetic-initial-access', 'synthetic-initial-refresh');
    const connected = await callback(owner.service, owner.request, started.state);
    const row = await health.prisma.googleDriveConnection.findUniqueOrThrow({ where: { id: connected.connection.id } });
    const encrypted = owner.runtime.crypto.encryptTokens({ accessToken: 'synthetic-cached-access', refreshToken: 'synthetic-initial-refresh', expiresAtMs: Date.now() + 3_600_000 }, owner.userId, row.id);
    await health.prisma.googleDriveConnection.update({ where: { id: row.id }, data: { encryptedTokens: encrypted.ciphertext,
      tokenKeyVersion: encrypted.keyVersion, accessExpiresAt: new Date(Date.now() + 3_600_000), generation: { increment: 1 }, updatedAt: new Date() } });
    const beforeRefresh = refreshes.length, beforeDocs = documentReads.length;
    let escapedClient: GoogleDocsClient | undefined;
    const result = await owner.service.withOwnGoogleDocsClient(owner.request, row.id, client => {
      escapedClient = client;
      return client.getDocument('synthetic-document');
    });
    expect(result).toMatchObject({ documentId: 'synthetic-document' });
    expect(documentReads.slice(beforeDocs)).toEqual([{ authorization: 'Bearer synthetic-cached-access' }]);
    expect(refreshes).toHaveLength(beforeRefresh);
    expect(JSON.stringify(result)).not.toMatch(/synthetic-cached-access|synthetic-initial-refresh/u);
    await expect(escapedClient!.getDocument('synthetic-document')).rejects.toMatchObject({ kind: 'unauthenticated' });
    expect(documentReads.slice(beforeDocs)).toHaveLength(1);
  });

  it('rewrites a fresh legacy-key grant without provider refresh and rejects mixed generations within one operation', async () => {
    const owner = await fixture();
    const started = await start(owner.service, owner.request);
    const permissionId = `synthetic-key-rotation-${randomUUID()}`;
    queue(permissionId, 'synthetic-old-key-access', 'synthetic-old-key-refresh');
    const connected = await callback(owner.service, owner.request, started.state);
    const oldRow = await health.prisma.googleDriveConnection.findUniqueOrThrow({ where: { id: connected.connection.id } });
    const rotatedKey = Buffer.alloc(32, 23).toString('base64');
    const rotatedConfig = { ...testConfig, TEST_GOOGLE_DOCS_TOKEN_ENCRYPTION_KEY: rotatedKey,
      TEST_GOOGLE_DOCS_TOKEN_ENCRYPTION_KEY_VERSION: '2',
      TEST_GOOGLE_DOCS_TOKEN_PREVIOUS_ENCRYPTION_KEYS: JSON.stringify({ '1': testKey }) };
    const rotatedRuntime = loadGoogleOAuthRuntime(rotatedConfig);
    if (rotatedRuntime.kind !== 'configured') throw new Error('Synthetic rotated OAuth configuration unavailable');
    const rotatedService = new GoogleOAuthService(health, owner.sessionCheck as unknown as SessionService,
      new ExternalProcessingService(health), rotatedRuntime);
    const refreshCount = refreshes.length;
    const docsStart = documentReads.length;
    await rotatedService.withOwnGoogleDocsClient(owner.request, oldRow.id, client => client.getDocument('synthetic-document'));
    const rewritten = await health.prisma.googleDriveConnection.findUniqueOrThrow({ where: { id: oldRow.id } });
    expect(rewritten).toMatchObject({ tokenKeyVersion: 2, generation: oldRow.generation + 1 });
    expect(rotatedRuntime.crypto.decryptTokens({ ciphertext: rewritten.encryptedTokens!, keyVersion: rewritten.tokenKeyVersion }, owner.userId, rewritten.id))
      .toMatchObject({ accessToken: 'synthetic-old-key-access', refreshToken: 'synthetic-old-key-refresh' });
    expect(refreshes).toHaveLength(refreshCount);
    expect(documentReads.slice(docsStart)).toEqual([{ authorization: 'Bearer synthetic-old-key-access' }]);

    let returnedFirstResult: unknown;
    await expect(rotatedService.withOwnGoogleDocsClient(owner.request, oldRow.id, async client => {
      returnedFirstResult = await client.getDocument('synthetic-document');
      await health.prisma.googleDriveConnection.update({ where: { id: oldRow.id }, data: { generation: { increment: 1 }, updatedAt: new Date() } });
      try { await client.getDocument('synthetic-document'); } catch { /* The facade must reject even if a caller swallows a mixed-generation failure. */ }
      return returnedFirstResult;
    })).rejects.toMatchObject({ status: 401 });
    expect(documentReads.slice(docsStart)).toHaveLength(2);
  });

  it('serializes refresh across two active sessions for one personal account', async () => {
    const owner = await fixture();
    const started = await start(owner.service, owner.request);
    queue(`synthetic-shared-${randomUUID()}`, 'synthetic-before-expiry', 'synthetic-shared-refresh');
    const connected = await callback(owner.service, owner.request, started.state);
    const row = await health.prisma.googleDriveConnection.findUniqueOrThrow({ where: { id: connected.connection.id } });
    const expired = owner.runtime.crypto.encryptTokens({ accessToken: 'synthetic-expired-access', refreshToken: 'synthetic-shared-refresh', expiresAtMs: Date.now() - 1 }, owner.userId, row.id);
    await health.prisma.googleDriveConnection.update({ where: { id: row.id }, data: { encryptedTokens: expired.ciphertext,
      tokenKeyVersion: expired.keyVersion, accessExpiresAt: new Date(Date.now() - 1), generation: { increment: 1 }, updatedAt: new Date() } });
    const secondSession = await sessionFor(owner.userId);
    refreshes.push({ payload: tokenSet('synthetic-refreshed-access'), status: 200, delayMs: 200 });
    const beforeRefresh = refreshes.length;
    const before = documentReads.length;
    const [sameSessionFirst, sameSessionSecond, secondBrowser] = await Promise.all([
      owner.service.withOwnGoogleDocsClient(owner.request, row.id, client => client.getDocument('synthetic-document')),
      owner.service.withOwnGoogleDocsClient(owner.request, row.id, client => client.getDocument('synthetic-document')),
      secondSession.service.withOwnGoogleDocsClient(secondSession.request, row.id, client => client.getDocument('synthetic-document')),
    ]);
    expect(sameSessionFirst).toMatchObject({ documentId: 'synthetic-document' });
    expect(sameSessionSecond).toMatchObject({ documentId: 'synthetic-document' });
    expect(secondBrowser).toMatchObject({ documentId: 'synthetic-document' });
    expect(refreshes).toHaveLength(beforeRefresh - 1);
    expect(documentReads.slice(before)).toHaveLength(3);
    expect(documentReads.slice(before).every(item => item.authorization === 'Bearer synthetic-refreshed-access')).toBe(true);
    expect(await health.prisma.googleDriveConnection.findUniqueOrThrow({ where: { id: row.id } })).toMatchObject({ generation: 3 });
  });

  it('rejects foreign, revoked, Q14-disabled, and expired refresh grants before Google calls', async () => {
    const owner = await fixture(), foreign = await fixture();
    const started = await start(owner.service, owner.request);
    queue(`synthetic-private-${randomUUID()}`, 'synthetic-private-access', 'synthetic-private-refresh');
    const connected = await callback(owner.service, owner.request, started.state);
    const before = documentReads.length;
    await expect(foreign.service.withOwnGoogleDocsClient(foreign.request, connected.connection.id, client => client.getDocument('synthetic-document')))
      .rejects.toMatchObject({ status: 403 });
    await health.prisma.userProfile.update({ where: { id: owner.userId }, data: { externalProcessingNoticeVersion: null, externalProcessingAcceptedAt: null } });
    await expect(owner.service.withOwnGoogleDocsClient(owner.request, connected.connection.id, client => client.getDocument('synthetic-document')))
      .rejects.toMatchObject({ status: 403 });
    await health.prisma.userProfile.update({ where: { id: owner.userId }, data: { externalProcessingNoticeVersion: EXTERNAL_PROCESSING_NOTICE.version, externalProcessingAcceptedAt: new Date() } });
    await owner.service.disconnect(owner.request, connected.connection.id);
    await expect(owner.service.withOwnGoogleDocsClient(owner.request, connected.connection.id, client => client.getDocument('synthetic-document')))
      .rejects.toMatchObject({ status: 403 });
    const expiredOwner = await fixture();
    const expiredStart = await start(expiredOwner.service, expiredOwner.request);
    queue(`synthetic-expired-provider-grant-${randomUUID()}`, 'synthetic-expired-provider-access', 'synthetic-expired-provider-refresh');
    const expiredConnection = await callback(expiredOwner.service, expiredOwner.request, expiredStart.state);
    await health.prisma.googleDriveConnection.update({ where: { id: expiredConnection.connection.id }, data: {
      refreshExpiresAt: new Date(Date.now() - 1), generation: { increment: 1 }, updatedAt: new Date(),
    } });
    await expect(expiredOwner.service.withOwnGoogleDocsClient(expiredOwner.request, expiredConnection.connection.id,
      client => client.getDocument('synthetic-document'))).rejects.toMatchObject({ status: 403 });
    expect(documentReads).toHaveLength(before);
  });

  it('preserves the last encrypted grant on transient refresh failure and quarantines unknown outcomes without retry', async () => {
    const owner = await fixture();
    const started = await start(owner.service, owner.request);
    queue(`synthetic-transient-${randomUUID()}`, 'synthetic-old-access', 'synthetic-stable-refresh');
    const connected = await callback(owner.service, owner.request, started.state);
    const row = await health.prisma.googleDriveConnection.findUniqueOrThrow({ where: { id: connected.connection.id } });
    const expired = owner.runtime.crypto.encryptTokens({ accessToken: 'synthetic-old-access', refreshToken: 'synthetic-stable-refresh', expiresAtMs: Date.now() - 1 }, owner.userId, row.id);
    await health.prisma.googleDriveConnection.update({ where: { id: row.id }, data: { encryptedTokens: expired.ciphertext,
      tokenKeyVersion: expired.keyVersion, accessExpiresAt: new Date(Date.now() - 1), generation: { increment: 1 }, updatedAt: new Date() } });
    const before = await health.prisma.googleDriveConnection.findUniqueOrThrow({ where: { id: row.id } });
    refreshes.push({ payload: { error: 'temporary provider outage with synthetic secret' }, status: 503 });
    await expect(owner.service.withOwnGoogleDocsClient(owner.request, row.id, client => client.getDocument('synthetic-document')))
      .rejects.toMatchObject({ status: 503 });
    const transient = await health.prisma.googleDriveConnection.findUniqueOrThrow({ where: { id: row.id } });
    expect(transient).toMatchObject({ encryptedTokens: before.encryptedTokens, generation: before.generation, refreshExpiresAt: before.refreshExpiresAt });

    refreshes.push({ payload: {}, status: 0, transportFailure: true });
    await expect(owner.service.withOwnGoogleDocsClient(owner.request, row.id, client => client.getDocument('synthetic-document')))
      .rejects.toMatchObject({ status: 403 });
    const unknown = await health.prisma.googleDriveConnection.findUniqueOrThrow({ where: { id: row.id } });
    expect(unknown).toMatchObject({ encryptedTokens: before.encryptedTokens, generation: before.generation + 1, refreshExpiresAt: expect.any(Date) });
    await expect(owner.service.withOwnGoogleDocsClient(owner.request, row.id, client => client.getDocument('synthetic-document')))
      .rejects.toMatchObject({ status: 403 });
    expect(refreshes).toHaveLength(0);
  });

  it('marks only an exact Google Docs 401 as needs_connection and preserves the grant ciphertext', async () => {
    const owner = await fixture();
    const started = await start(owner.service, owner.request);
    queue(`synthetic-docs-401-${randomUUID()}`, 'synthetic-docs-401-access', 'synthetic-docs-401-refresh');
    const connected = await callback(owner.service, owner.request, started.state);
    const before = await health.prisma.googleDriveConnection.findUniqueOrThrow({ where: { id: connected.connection.id } });

    documentStatuses.push(403);
    await expect(owner.service.withOwnGoogleDocsClient(owner.request, before.id, client => client.getDocument('synthetic-document')))
      .rejects.toMatchObject({ kind: 'forbidden', status: 403 });
    expect(await health.prisma.googleDriveConnection.findUniqueOrThrow({ where: { id: before.id } }))
      .toMatchObject({ encryptedTokens: before.encryptedTokens, generation: before.generation, refreshExpiresAt: before.refreshExpiresAt });

    documentStatuses.push(401);
    await expect(owner.service.withOwnGoogleDocsClient(owner.request, before.id, client => client.getDocument('synthetic-document')))
      .rejects.toMatchObject({ kind: 'unauthenticated', status: 401 });
    const needsConnection = await health.prisma.googleDriveConnection.findUniqueOrThrow({ where: { id: before.id } });
    expect(needsConnection).toMatchObject({ encryptedTokens: before.encryptedTokens, generation: before.generation + 1, refreshExpiresAt: expect.any(Date) });
    expect((await owner.service.list(owner.request)).connections[0]).toMatchObject({ status: 'needs_connection', providerAccess: 'reauthorize' });
  });

  it('does not persist a late refresh after the session expires and discards results after disconnect fences the generation', async () => {
    const owner = await fixture();
    const started = await start(owner.service, owner.request);
    queue(`synthetic-fenced-${randomUUID()}`, 'synthetic-fenced-access', 'synthetic-fenced-refresh');
    const connected = await callback(owner.service, owner.request, started.state);
    const row = await health.prisma.googleDriveConnection.findUniqueOrThrow({ where: { id: connected.connection.id } });
    const expired = owner.runtime.crypto.encryptTokens({ accessToken: 'synthetic-before-fence', refreshToken: 'synthetic-fenced-refresh', expiresAtMs: Date.now() - 1 }, owner.userId, row.id);
    await health.prisma.googleDriveConnection.update({ where: { id: row.id }, data: { encryptedTokens: expired.ciphertext,
      tokenKeyVersion: expired.keyVersion, accessExpiresAt: new Date(Date.now() - 1), generation: { increment: 1 }, updatedAt: new Date() } });
    const before = await health.prisma.googleDriveConnection.findUniqueOrThrow({ where: { id: row.id } });
    await health.prisma.appSession.update({ where: { id: owner.record.id }, data: { expiresAt: new Date(Date.now() + 150) } });
    refreshes.push({ payload: tokenSet('synthetic-too-late-access'), status: 200, delayMs: 250 });
    await expect(owner.service.withOwnGoogleDocsClient(owner.request, row.id, client => client.getDocument('synthetic-document')))
      .rejects.toMatchObject({ status: 401 });
    const afterExpiry = await health.prisma.googleDriveConnection.findUniqueOrThrow({ where: { id: row.id } });
    expect(afterExpiry).toMatchObject({ encryptedTokens: before.encryptedTokens, generation: before.generation + 1, refreshExpiresAt: expect.any(Date) });
    expect(documentReads.at(-1)?.authorization).not.toBe('Bearer synthetic-too-late-access');

    const active = await fixture();
    const freshStart = await start(active.service, active.request);
    queue(`synthetic-disconnect-${randomUUID()}`, 'synthetic-pre-disconnect-access', 'synthetic-disconnect-refresh');
    const freshConnection = await callback(active.service, active.request, freshStart.state);
    const freshRow = await health.prisma.googleDriveConnection.findUniqueOrThrow({ where: { id: freshConnection.connection.id } });
    onDocument = async () => { await active.service.disconnect(active.request, freshRow.id); };
    await expect(active.service.withOwnGoogleDocsClient(active.request, freshRow.id, client => client.getDocument('synthetic-document')))
      .rejects.toMatchObject({ kind: 'unauthenticated' });
    expect(await health.prisma.googleDriveConnection.findUniqueOrThrow({ where: { id: freshRow.id } })).toMatchObject({ encryptedTokens: null, revokedAt: expect.any(Date) });
  });

  it('waits for a bounded refresh before another browser disconnects and rejects its in-flight document result', async () => {
    const owner = await fixture();
    const started = await start(owner.service, owner.request);
    queue(`synthetic-long-refresh-${randomUUID()}`, 'synthetic-long-old-access', 'synthetic-long-refresh-token');
    const connected = await callback(owner.service, owner.request, started.state);
    const row = await health.prisma.googleDriveConnection.findUniqueOrThrow({ where: { id: connected.connection.id } });
    const expired = owner.runtime.crypto.encryptTokens({ accessToken: 'synthetic-long-old-access', refreshToken: 'synthetic-long-refresh-token', expiresAtMs: Date.now() - 1 }, owner.userId, row.id);
    await health.prisma.googleDriveConnection.update({ where: { id: row.id }, data: { encryptedTokens: expired.ciphertext,
      tokenKeyVersion: expired.keyVersion, accessExpiresAt: new Date(Date.now() - 1), generation: { increment: 1 }, updatedAt: new Date() } });
    const otherBrowser = await sessionFor(owner.userId);
    let releaseStarted!: () => void;
    const refreshStarted = new Promise<void>(resolve => { releaseStarted = resolve; });
    onRefresh = () => releaseStarted();
    refreshes.push({ payload: tokenSet('synthetic-long-new-access'), status: 200, delayMs: 3_200 });
    let releaseDocument!: () => void, markDocumentStarted!: () => void;
    const documentStarted = new Promise<void>(resolve => { markDocumentStarted = resolve; });
    const documentGate = new Promise<void>(resolve => { releaseDocument = resolve; });
    onDocument = async () => { markDocumentStarted(); await documentGate; };
    const operation = owner.service.withOwnGoogleDocsClient(owner.request, row.id, client => client.getDocument('synthetic-document'));
    await refreshStarted;
    const disconnectOperation = otherBrowser.service.disconnect(otherBrowser.request, row.id);
    await documentStarted;
    const disconnected = await disconnectOperation;
    expect(disconnected.connection.status).toBe('disconnected');
    releaseDocument();
    await expect(operation).rejects.toMatchObject({ kind: 'unauthenticated' });
    expect(await health.prisma.googleDriveConnection.findUniqueOrThrow({ where: { id: row.id } })).toMatchObject({ encryptedTokens: null, revokedAt: expect.any(Date) });
  });
});
