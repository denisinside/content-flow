import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { DependencyHealthService, loadRuntimeConfig } from '@contextflow/backend';
import { loadAuthConfig } from '../../apps/api/src/auth/auth-config.js';
import { AuthProvider, ProviderFailure, type ProviderSession } from '../../apps/api/src/auth/auth-provider.js';
import { SessionCrypto, tokenDigest } from '../../apps/api/src/auth/session-crypto.js';
import { SessionService } from '../../apps/api/src/auth/session-service.js';
import { AuthRateLimit } from '../../apps/api/src/auth/auth-rate-limit.js';

describe('real isolated Supabase Auth / PostgreSQL sessions', () => {
  const health = new DependencyHealthService(loadRuntimeConfig());
  const config = loadAuthConfig();
  const provider = new AuthProvider(config);
  const sessions = new SessionService(health.prisma, provider, config);
  const users = new Set<string>();
  beforeAll(async () => {
    // Tests may never target the owner's cloud provider.
    expect(config.providerUrl).toBe('http://127.0.0.1:54331');
    expect((await health.check()).status).toBe('ready');
    expect((await fetch(config.providerUrl + '/auth/v1/health')).ok).toBe(true);
  });
  async function fixture(): Promise<{ session: ProviderSession; cookie: string; id: string; email: string; password: string }> {
    const email = `cf-${randomUUID()}@example.test`;
    const password = randomBytes(24).toString('base64url');
    const session = await provider.register(email, password, 'Тест');
    if (!session) throw new Error('TEST GoTrue did not auto-confirm synthetic account');
    users.add(session.identity.id);
    const created = await sessions.create(session, 'Тест');
    const row = await health.prisma.appSession.findUniqueOrThrow({ where: { cookieDigest: tokenDigest(created.cookie) } });
    return { session, cookie: created.cookie, id: row.id, email, password };
  }
  afterAll(async () => {
    vi.restoreAllMocks();
    for (const id of users) {
      await health.prisma.appSession.deleteMany({ where: { userId: id } });
      await health.prisma.userProfile.delete({ where: { id } });
      const reply = await fetch(config.providerUrl + '/auth/v1/admin/users/' + id, {
        method: 'DELETE', headers: { apikey: process.env['TEST_SUPABASE_SECRET_KEY'] ?? '', Authorization: 'Bearer ' + (process.env['TEST_SUPABASE_SECRET_KEY'] ?? '') }
      });
      if (!reply.ok) throw new Error('Synthetic TEST Auth cleanup failed');
    }
    await health.onModuleDestroy();
  });
  it('registers and logs in with verified identity, opaque digest, encrypted tokens and no password columns', async () => {
    const fixtureData = await fixture();
    const row = await health.prisma.appSession.findUniqueOrThrow({ where: { id: fixtureData.id } });
    expect(row.cookieDigest.includes(fixtureData.cookie)).toBe(false);
    expect(row.encryptedProviderTokens?.includes(fixtureData.session.tokens.accessToken)).toBe(false);
    expect(row.encryptedProviderTokens?.includes(fixtureData.session.tokens.refreshToken)).toBe(false);
    expect(JSON.stringify(row).includes(fixtureData.password)).toBe(false);
    expect((await sessions.check(fixtureData.cookie)).kind).toBe('active');
    expect((await provider.login(fixtureData.email, fixtureData.password)).identity.id).toBe(fixtureData.session.identity.id);
    await expect(provider.login(fixtureData.email, 'wrong-password')).rejects.toBeInstanceOf(ProviderFailure);
    expect((await sessions.check('forged-cookie')).kind).toBe('expired');
  });
  it('does not extend activity for polling, but authenticated interaction does; idle expiry cannot be revived', async () => {
    const data = await fixture();
    const earlier = new Date(Date.now() - 2 * 60_000);
    await health.prisma.appSession.update({ where: { id: data.id }, data: { lastUserActivityAt: earlier } });
    await sessions.check(data.cookie);
    expect((await health.prisma.appSession.findUniqueOrThrow({ where: { id: data.id } })).lastUserActivityAt.getTime()).toBe(earlier.getTime());
    expect((await sessions.check(data.cookie, true)).kind).toBe('active');
    expect((await health.prisma.appSession.findUniqueOrThrow({ where: { id: data.id } })).lastUserActivityAt.getTime()).toBeGreaterThan(earlier.getTime());
    await health.prisma.appSession.update({ where: { id: data.id }, data: { lastUserActivityAt: new Date(Date.now() - 60 * 60_000 - 1000) } });
    expect((await sessions.check(data.cookie, true)).kind).toBe('expired');
    const revoked = await health.prisma.appSession.findUniqueOrThrow({ where: { id: data.id } });
    expect(revoked.revokedAt).not.toBeNull(); expect(revoked.encryptedProviderTokens).toBeNull();
  });
  it('enforces absolute expiry and rejects corrupted ciphertext before contacting the provider', async () => {
    const data = await fixture();
    await health.prisma.appSession.update({ where: { id: data.id }, data: { createdAt: new Date(Date.now() - 3_600_000), expiresAt: new Date(Date.now() - 1000) } });
    expect((await sessions.check(data.cookie)).kind).toBe('expired');
    const corrupt = await fixture();
    await health.prisma.appSession.update({ where: { id: corrupt.id }, data: { encryptedProviderTokens: 'invalid' } });
    const spy = vi.spyOn(provider, 'verify');
    expect((await sessions.check(corrupt.cookie)).kind).toBe('expired');
    expect(spy).not.toHaveBeenCalled(); spy.mockRestore();
  });
  it('serializes two concurrent refreshes and stores the rotated pair once without extending idle', async () => {
    const data = await fixture();
    const previous = await health.prisma.appSession.findUniqueOrThrow({ where: { id: data.id } });
    await health.prisma.appSession.update({ where: { id: data.id }, data: { providerTokenExpiresAt: new Date(Date.now() + 10_000) } });
    const spy = vi.spyOn(provider, 'refresh');
    expect((await Promise.all([sessions.check(data.cookie), sessions.check(data.cookie)])).map(item => item.kind)).toEqual(['active', 'active']);
    expect(spy).toHaveBeenCalledTimes(1); spy.mockRestore();
    const next = await health.prisma.appSession.findUniqueOrThrow({ where: { id: data.id } });
    expect(next.encryptedProviderTokens === previous.encryptedProviderTokens).toBe(false);
    expect(next.lastUserActivityAt).toEqual(previous.lastUserActivityAt);
    const tokens = new SessionCrypto(config).decrypt(next.encryptedProviderTokens ?? '', next.tokenKeyVersion, next.id, next.userId);
    expect((await provider.verify(tokens)).id).toBe(next.userId);
  });
  it('fails closed on remote provider revocation even with an unexpired access JWT', async () => {
    const data = await fixture();
    await provider.logout(data.session.tokens);
    expect((await sessions.check(data.cookie)).kind).toBe('expired');
  });
  it('rejects altered signatures, expired claims and another issuer/audience', async () => {
    const data = await fixture();
    const [header, payload] = data.session.tokens.accessToken.split('.');
    const claims = JSON.parse(Buffer.from(payload ?? '', 'base64url').toString('utf8')) as Record<string, unknown>;
    for (const change of [{ iss: 'https://wrong-provider.example/auth/v1' }, { aud: 'wrong-audience' }, { exp: Math.floor(Date.now() / 1000) - 100 }]) {
      const body = Buffer.from(JSON.stringify({ ...claims, ...change })).toString('base64url');
      const unsigned = header + '.' + body;
      const accessToken = unsigned + '.' + createHmac('sha256', process.env['TEST_AUTH_JWT_SECRET'] ?? '').update(unsigned).digest('base64url');
      await expect(provider.verify({ ...data.session.tokens, accessToken })).rejects.toBeInstanceOf(ProviderFailure);
    }
    const invalidSignature = data.session.tokens.accessToken.split('.').slice(0, 2).join('.') + '.' + randomBytes(32).toString('base64url');
    await expect(provider.verify({ ...data.session.tokens, accessToken: invalidSignature })).rejects.toBeInstanceOf(ProviderFailure);
  });
  it('fails closed when the provider bans the account', async () => {
    const data = await fixture();
    const reply = await fetch(config.providerUrl + '/auth/v1/admin/users/' + data.session.identity.id, {
      method: 'PUT', headers: { 'Content-Type': 'application/json', apikey: process.env['TEST_SUPABASE_SECRET_KEY'] ?? '', Authorization: 'Bearer ' + (process.env['TEST_SUPABASE_SECRET_KEY'] ?? '') },
      body: JSON.stringify({ ban_duration: '24h' })
    });
    expect(reply.ok).toBe(true);
    expect((await sessions.check(data.cookie)).kind).toBe('expired');
  });
  it('keeps local access revoked if provider sign-out fails and the old cookie is replayed', async () => {
    const data = await fixture();
    const spy = vi.spyOn(provider, 'logout').mockRejectedValue(new ProviderFailure(true));
    await sessions.logout(data.cookie); spy.mockRestore();
    expect((await sessions.check(data.cookie)).kind).toBe('expired');
    expect((await health.prisma.appSession.findUniqueOrThrow({ where: { id: data.id } })).encryptedProviderTokens).toBeNull();
  });
  it('allows logout to revoke after a concurrent slow provider verification beyond the SQL deadline', async () => {
    const data = await fixture();
    const verified = data.session.identity;
    let started: (() => void) | undefined;
    const ready = new Promise<void>(resolve => { started = resolve; });
    const spy = vi.spyOn(provider, 'verify').mockImplementationOnce(async () => { started?.(); await delay(3500); return verified; });
    const checking = sessions.check(data.cookie); await ready;
    const logout = sessions.logout(data.cookie);
    expect((await checking).kind).toBe('active'); await logout; spy.mockRestore();
    expect((await sessions.check(data.cookie)).kind).toBe('expired');
  });
  it('returns unavailable without accepting a session or extending idle during provider outage', async () => {
    const data = await fixture();
    const previous = await health.prisma.appSession.findUniqueOrThrow({ where: { id: data.id } });
    const spy = vi.spyOn(provider, 'verify').mockRejectedValue(new ProviderFailure(true));
    expect((await sessions.check(data.cookie, true)).kind).toBe('unavailable'); spy.mockRestore();
    const next = await health.prisma.appSession.findUniqueOrThrow({ where: { id: data.id } });
    expect(next.lastUserActivityAt).toEqual(previous.lastUserActivityAt);
    expect((await sessions.check(data.cookie)).kind).toBe('active');
  });
  it('rewrites old encryption versions on valid access without changing activity', async () => {
    const data = await fixture();
    const rotated = { ...config, currentKeyVersion: 2, encryptionKeys: new Map([...config.encryptionKeys, [2, randomBytes(32)]]) };
    const nextService = new SessionService(health.prisma, provider, rotated);
    expect((await nextService.check(data.cookie)).kind).toBe('active');
    expect((await health.prisma.appSession.findUniqueOrThrow({ where: { id: data.id } })).tokenKeyVersion).toBe(2);
    expect((await sessions.check(data.cookie)).kind).toBe('expired');
  });
  it('rate limits repeated credential attempts by hashed account keys', async () => {
    const limiter = new AuthRateLimit(loadRuntimeConfig().redisUrl, config);
    try {
      const email = randomUUID() + '@example.test';
      for (let count = 0; count < 10; count++) await limiter.require(randomUUID(), email);
      await expect(limiter.require(randomUUID(), email)).rejects.toMatchObject({ status: 429 });
    } finally { limiter.onModuleDestroy(); }
  });
});
