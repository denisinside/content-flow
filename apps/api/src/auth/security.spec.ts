import { randomBytes } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { describe, expect, it, vi } from 'vitest';
import { parseAuthConfig } from './auth-config.js';
import { CsrfProtection, CSRF_COOKIE } from './csrf.js';
import { SessionCrypto, opaqueToken } from './session-crypto.js';
import { AuthProvider } from './auth-provider.js';

function config() {
  return parseAuthConfig({ NODE_ENV: 'test', TEST_SUPABASE_URL: 'http://127.0.0.1:54331', TEST_SUPABASE_PUBLISHABLE_KEY: 'test-public',
    TEST_SESSION_ENCRYPTION_KEY: randomBytes(32).toString('base64'), TEST_SESSION_CSRF_KEY: randomBytes(32).toString('base64') }, 'http://localhost:4173');
}
describe('session security boundaries', () => {
  it('surfaces provider configuration failures instead of falsely promising a confirmation email', async () => {
    for (const status of [401, 403]) {
      vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ msg: 'Invalid API key' }), { status, headers: { 'Content-Type': 'application/json' } }));
      try { await expect(new AuthProvider(config()).register('test@example.test', 'TestPassword!123')).rejects.toMatchObject({ unavailable: true }); }
      finally { vi.unstubAllGlobals(); }
    }
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ code: 'user_already_exists', msg: 'User already registered' }), {
      status: 422, headers: { 'Content-Type': 'application/json', 'X-Supabase-Api-Version': '2024-01-01' }
    }));
    try { expect(await new AuthProvider(config()).register('test@example.test', 'TestPassword!123')).toBeNull(); }
    finally { vi.unstubAllGlobals(); }
  });
  it('uses PKCE for signup, so confirmation does not request implicit browser access/refresh tokens', async () => {
    let requestBody = '';
    vi.stubGlobal('fetch', async (_url: unknown, init?: RequestInit) => {
      requestBody = String(init?.body ?? '');
      return new Response(JSON.stringify({ user: null, session: null }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    });
    try {
      expect(await new AuthProvider(config()).register('test@example.test', 'TestPassword!123')).toBeNull();
      const body = JSON.parse(requestBody) as Record<string, unknown>;
      expect(body['code_challenge_method']).toBe('s256');
      expect(typeof body['code_challenge']).toBe('string');
    } finally { vi.unstubAllGlobals(); }
  });
  it('requires isolated TEST credentials and valid encryption keys', () => {
    expect(() => parseAuthConfig({ NODE_ENV: 'test', SUPABASE_URL: 'https://development.example' }, 'http://localhost:4173')).toThrow('TEST_SUPABASE_URL');
    expect(() => parseAuthConfig({ NODE_ENV: 'production', SUPABASE_URL: 'http://remote.example' }, 'https://web.example')).toThrow('SUPABASE_URL');
  });
  it('encrypts both tokens with random IVs and rejects tampering, wrong record and unknown keys', () => {
    const crypto = new SessionCrypto(config());
    const tokens = { accessToken: 'synthetic-access', refreshToken: 'synthetic-refresh' };
    const first = crypto.encrypt(tokens, 'id', 'user');
    expect(first.ciphertext.includes(tokens.accessToken)).toBe(false);
    expect(first.ciphertext).not.toBe(crypto.encrypt(tokens, 'id', 'user').ciphertext);
    expect(crypto.decrypt(first.ciphertext, 1, 'id', 'user')).toEqual(tokens);
    expect(() => crypto.decrypt(first.ciphertext, 1, 'other', 'user')).toThrow();
    expect(() => crypto.decrypt(first.ciphertext, 2, 'id', 'user')).toThrow();
    const bytes = Buffer.from(first.ciphertext, 'base64'); bytes[28] = (bytes[28] ?? 0) ^ 1;
    expect(() => crypto.decrypt(bytes.toString('base64'), 1, 'id', 'user')).toThrow();
  });
  it('can decrypt the previous key version during controlled rotation', () => {
    const old = config();
    const encrypted = new SessionCrypto(old).encrypt({ accessToken: 'a', refreshToken: 'r' }, 'id', 'user');
    const rotated = { ...old, currentKeyVersion: 2, encryptionKeys: new Map([...old.encryptionKeys, [2, randomBytes(32)]]) };
    const crypto = new SessionCrypto(rotated);
    expect(crypto.decrypt(encrypted.ciphertext, 1, 'id', 'user').refreshToken).toBe('r');
    expect(crypto.encrypt({ accessToken: 'a', refreshToken: 'r' }, 'id', 'user').version).toBe(2);
  });
  it('binds CSRF to the session and Origin, rejects forgery, and lasts through the absolute authenticated lifetime', () => {
    const protection = new CsrfProtection(config());
    const session = opaqueToken();
    const headers = new Map<string, string | string[]>();
    const response = { getHeader: (name: string) => headers.get(name), setHeader: (name: string, value: string | string[]) => headers.set(name, value) } as unknown as ServerResponse;
    const request = { headers: {} } as IncomingMessage;
    const token = protection.token(request, response, session);
    const set = headers.get('Set-Cookie') as string[];
    const csrfCookie = set[0]?.split(';')[0];
    expect(csrfCookie?.startsWith(CSRF_COOKIE + '=')).toBe(true);
    const valid = { headers: { cookie: `__Host-contextflow=${session}; ${csrfCookie}`, origin: 'http://localhost:4173', 'x-csrf-token': token } } as IncomingMessage;
    expect(() => protection.require(valid)).not.toThrow();
    expect(() => protection.require({ headers: { ...valid.headers, origin: 'https://attacker.example' } } as IncomingMessage)).toThrow();
    expect(() => protection.require({ headers: { ...valid.headers, 'x-csrf-token': opaqueToken() } } as IncomingMessage)).toThrow();
    expect(() => protection.require({ headers: { ...valid.headers, cookie: `__Host-contextflow=${opaqueToken()}; ${csrfCookie}` } } as IncomingMessage)).toThrow();
    const now = Date.now();
    const spy = vi.spyOn(Date, 'now').mockReturnValue(now + 61 * 60_000);
    try {
      expect(() => protection.require(valid)).not.toThrow();
      spy.mockReturnValue(now + 7 * 24 * 3_600_000);
      expect(() => protection.require(valid)).toThrow();
    } finally { spy.mockRestore(); }
  });
});
