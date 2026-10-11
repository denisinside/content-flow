import { describe, expect, it, vi } from 'vitest';
import type { PrismaClient } from '../generated/prisma/client.js';
import { EXTERNAL_PROCESSING_NOTICE } from '../external-processing-notice.js';
import { GoogleOAuthClient, GOOGLE_DOCS_FILE_SCOPE } from './google-oauth-client.js';
import { GoogleOAuthCrypto } from './google-oauth-crypto.js';
import { GoogleSyncCredentials, type GoogleSyncCredentialsContext } from './google-sync-credentials.js';
import type { GoogleOAuthRuntime } from './google-oauth-runtime.js';

const ids = {
  user: '11111111-1111-4111-8111-111111111111', project: '22222222-2222-4222-8222-222222222222',
  binding: '33333333-3333-4333-8333-333333333333', connection: '44444444-4444-4444-8444-444444444444',
  session: '55555555-5555-4555-8555-555555555555',
};

function fixture(options: { background?: boolean; member?: boolean; matchingBinding?: boolean; sessionActive?: boolean; accepted?: boolean; refresh?: 'success' | 'unknown'; docs401?: boolean } = {}) {
  const acceptedAt = new Date('2026-10-11T10:00:00.000Z');
  const context: GoogleSyncCredentialsContext = {
    projectId: ids.project, bindingId: ids.binding, userId: ids.user, connectionId: ids.connection,
    sessionId: options.background ? null : ids.session, noticeAcceptedAt: acceptedAt,
    backgroundGeneration: options.background ? 3 : null,
  };
  const crypto = new GoogleOAuthCrypto({ currentVersion: 2, keys: new Map([[2, Buffer.alloc(32, 7)]]) });
  const accessExpiresAt = Date.now() + (options.docs401 ? 3_600_000 : -10_000);
  const encrypted = crypto.encryptTokens({ accessToken: 'old-access-secret', refreshToken: 'refresh-secret', expiresAtMs: accessExpiresAt }, ids.user, ids.connection);
  const connection = { id: ids.connection, userId: ids.user, generation: 4, encryptedTokens: encrypted.ciphertext,
    tokenKeyVersion: encrypted.keyVersion, accessExpiresAt: new Date(accessExpiresAt), refreshExpiresAt: null,
    revokedAt: null as Date | null, grantedScope: GOOGLE_DOCS_FILE_SCOPE };
  const profile = { idleTimeoutMinutes: 120, externalProcessingNoticeVersion: options.accepted === false ? null : EXTERNAL_PROCESSING_NOTICE.version, externalProcessingAcceptedAt: acceptedAt };
  const session = { expiresAt: new Date(Date.now() + 3_600_000), lastUserActivityAt: new Date() };
  const state = { backgroundConnectionId: ids.connection, backgroundUserId: ids.user, backgroundGeneration: 3,
    backgroundGrantedAt: acceptedAt, backgroundNoticeAcceptedAt: acceptedAt };
  const access = { member: options.member !== false, matchingBinding: options.matchingBinding !== false, sessionActive: options.sessionActive !== false };
  let tail = Promise.resolve();
  const tx = {
    $queryRaw: async (parts: TemplateStringsArray) => {
      const sql = parts.join(' ');
      if (sql.includes('FROM contextflow."AppSession" s JOIN')) return access.sessionActive
        ? [{ ...session, idleTimeoutMinutes: profile.idleTimeoutMinutes }] : [];
      if (sql.includes('FROM contextflow."AppSession"')) return access.sessionActive ? [session] : [];
      if (sql.includes('FROM contextflow."UserProfile"')) return [profile];
      if (sql.includes('FROM contextflow."Project" p')) return access.member ? [{ id: ids.project }] : [];
      if (sql.includes('FROM contextflow."GoogleDocBinding"')) return access.matchingBinding
        ? [{ connectionId: 'original-binder-connection', connectionUserId: 'original-binder-user' }] : [];
      if (sql.includes('FROM contextflow."GoogleDocSyncState"')) return [state];
      if (sql.includes('FROM contextflow."GoogleDriveConnection"') && sql.includes('SELECT "id"')) return [{ id: ids.connection }];
      if (sql.includes('FROM contextflow."GoogleDriveConnection"')) return [connection];
      throw new Error(`Unexpected SQL: ${sql}`);
    },
    googleDriveConnection: {
      findFirst: async () => ({ id: ids.connection }),
      update: async ({ data }: { data: Record<string, unknown> }) => {
        const { generation, ...rest } = data;
        Object.assign(connection, rest);
        if (generation && typeof generation === 'object') connection.generation += 1;
        else if (typeof generation === 'number') connection.generation = generation;
        return { generation: connection.generation };
      },
      updateMany: async ({ data }: { data: Record<string, unknown> }) => {
        const { generation, ...rest } = data;
        Object.assign(connection, rest);
        if (generation && typeof generation === 'object') connection.generation += 1;
        else if (typeof generation === 'number') connection.generation = generation;
        return { count: 1 };
      },
    },
  };
  const prisma = {
    $transaction: async <T>(callback: (client: typeof tx) => Promise<T>) => {
      const waiting = tail;
      let release!: () => void;
      tail = new Promise<void>(resolve => { release = resolve; });
      await waiting;
      try { return await callback(tx); } finally { release(); }
    },
  } as unknown as PrismaClient;
  const refreshFetch = vi.fn<typeof fetch>(async () => {
    if (options.refresh === 'unknown') throw new Error('network details must not escape');
    return new Response(JSON.stringify({ access_token: 'new-access-secret', token_type: 'Bearer', expires_in: 3600,
      refresh_token: 'next-refresh-secret' }), { status: 200, headers: { 'content-type': 'application/json' } });
  });
  const oauth = new GoogleOAuthClient({ clientId: 'client', clientSecret: 'secret',
    redirectUri: 'http://localhost:3001/api/v1/google-docs/oauth/callback', fetchImpl: refreshFetch });
  const docsFetch = vi.fn<typeof fetch>(async () => options.docs401 ? new Response(null, { status: 401 }) : new Response(JSON.stringify({ documentId: 'doc-1', revisionId: 'r1',
    tabs: [{ tabProperties: { tabId: 'tab-1' }, documentTab: { body: { content: [] } } }] }),
  { status: 200, headers: { 'content-type': 'application/json' } }));
  const runtime: GoogleOAuthRuntime = { kind: 'configured', client: oauth, crypto, docsFetchImpl: docsFetch };
  return { context, credentials: new GoogleSyncCredentials(prisma, runtime), connection, crypto, refreshFetch, docsFetch, access };
}

describe('GoogleSyncCredentials', () => {
  it('serializes refresh and pins one encrypted connection generation for concurrent Docs calls', async () => {
    const f = fixture();
    const results = await Promise.all([1, 2].map(() => f.credentials.withClient(f.context, client => client.getDocument('doc-1'))));
    expect(results).toHaveLength(2);
    expect(f.refreshFetch).toHaveBeenCalledTimes(1);
    expect(f.docsFetch).toHaveBeenCalledTimes(2);
    expect(f.connection.generation).toBe(5);
    expect(f.connection.tokenKeyVersion).toBe(2);
    expect(JSON.stringify(results)).not.toContain('access-secret');
  });

  it.each([
    ['workspace membership is gone', { member: false }],
    ['binding changed', { matchingBinding: false }],
    ['session expired', { sessionActive: false }],
    ['current Q-14 acceptance is absent', { accepted: false }],
  ])('stops before Docs access when %s', async (_label, invalid) => {
    const f = fixture(invalid);
    await expect(f.credentials.withClient(f.context, client => client.getDocument('doc-1'))).rejects.toThrow();
    expect(f.refreshFetch).not.toHaveBeenCalled();
    expect(f.docsFetch).not.toHaveBeenCalled();
  });

  it('requires exact background binding, user, connection, generation, and current notice consent', async () => {
    const f = fixture({ background: true });
    await f.credentials.withClient(f.context, client => client.getDocument('doc-1'));
    const invalid = fixture({ background: true });
    invalid.context.backgroundGeneration = 2;
    await expect(invalid.credentials.withClient(invalid.context, client => client.getDocument('doc-1'))).rejects.toThrow();
    expect(invalid.docsFetch).not.toHaveBeenCalled();
  });

  it('quarantines an uncertain refresh while retaining ciphertext for explicit disconnect', async () => {
    const f = fixture({ refresh: 'unknown' });
    const ciphertext = f.connection.encryptedTokens;
    await expect(f.credentials.withClient(f.context, async () => 'never dispatched')).rejects.toThrow(/authorization expired/u);
    expect(f.refreshFetch).toHaveBeenCalledTimes(1);
    expect(f.connection.encryptedTokens).toBe(ciphertext);
    expect(f.connection.refreshExpiresAt?.getTime()).toBeLessThanOrEqual(Date.now());
    expect(f.connection.generation).toBe(5);
    expect(f.docsFetch).not.toHaveBeenCalled();
  });

  it('marks a Docs 401 grant expired and retains its encrypted credentials', async () => {
    const f = fixture({ docs401: true });
    const ciphertext = f.connection.encryptedTokens;
    await expect(f.credentials.withClient(f.context, client => client.getDocument('doc-1'))).rejects.toMatchObject({ kind: 'unauthenticated', status: 401 });
    expect(f.connection.encryptedTokens).toBe(ciphertext);
    expect(f.connection.refreshExpiresAt?.getTime()).toBeLessThanOrEqual(Date.now());
    expect(f.connection.generation).toBe(5);
  });
});
