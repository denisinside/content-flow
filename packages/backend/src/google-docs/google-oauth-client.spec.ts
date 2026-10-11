import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { GOOGLE_DOCS_FILE_SCOPE, GoogleOAuthClient, GoogleOAuthError } from './google-oauth-client.js';

const verifier = 'a'.repeat(64), state = 's'.repeat(48);
function response(value: unknown, status = 200) {
  return new Response(typeof value === 'string' ? value : JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
}
const tokens = { access_token: 'access-secret', token_type: 'Bearer', expires_in: 3600, refresh_token: 'refresh-secret', refresh_token_expires_in: 15_552_000, scope: GOOGLE_DOCS_FILE_SCOPE };
function client(fetchImpl: typeof fetch, extra: Record<string, unknown> = {}) {
  return new GoogleOAuthClient({ clientId: 'client-id', clientSecret: 'client-secret', redirectUri: 'http://localhost:3000/api/v1/google-docs/oauth/callback', fetchImpl, ...extra });
}

describe('Google OAuth provider adapter', () => {
  it('creates a fixed authorization URL with only drive.file, offline access, and PKCE S256', () => {
    const url = new URL(client(vi.fn<typeof fetch>()).authorizationUrl(state, verifier));
    expect(url.origin + url.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    expect(url.searchParams.get('scope')).toBe(GOOGLE_DOCS_FILE_SCOPE);
    expect(url.searchParams.get('access_type')).toBe('offline');
    expect(url.searchParams.get('prompt')).toBe('consent');
    expect(url.searchParams.get('state')).toBe(state);
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('code_challenge')).toBe(createHash('sha256').update(verifier).digest('base64url'));
    expect(url.searchParams.get('redirect_uri')).toBe('http://localhost:3000/api/v1/google-docs/oauth/callback');
    expect([...url.searchParams.keys()].sort()).toEqual(['access_type', 'client_id', 'code_challenge', 'code_challenge_method', 'include_granted_scopes', 'prompt', 'redirect_uri', 'response_type', 'scope', 'state'].sort());
    expect(() => client(vi.fn<typeof fetch>()).authorizationUrl('short', verifier)).toThrow(GoogleOAuthError);
    expect(() => client(vi.fn<typeof fetch>()).authorizationUrl(state, 'invalid')).toThrow(GoogleOAuthError);
  });

  it('exchanges and refreshes with fixed endpoints and exact redirect; refresh token remains optional', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValueOnce(response(tokens)).mockResolvedValueOnce(response({ ...tokens, refresh_token: undefined }));
    const oauth = client(fetchImpl);
    await expect(oauth.exchangeAuthorizationCode('one-time-code', verifier)).resolves.toEqual(tokens);
    await expect(oauth.refreshAccessToken('refresh-secret')).resolves.toMatchObject({ access_token: 'access-secret', token_type: 'Bearer' });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    const [exchangeUrl, exchangeInit] = fetchImpl.mock.calls[0]!;
    expect(exchangeUrl).toBe('https://oauth2.googleapis.com/token');
    expect(exchangeInit?.redirect).toBe('error');
    const exchange = new URLSearchParams(String(exchangeInit?.body));
    expect(Object.fromEntries(exchange)).toMatchObject({ grant_type: 'authorization_code', code: 'one-time-code', code_verifier: verifier,
      redirect_uri: 'http://localhost:3000/api/v1/google-docs/oauth/callback', client_id: 'client-id', client_secret: 'client-secret' });
    const refresh = new URLSearchParams(String(fetchImpl.mock.calls[1]![1]?.body));
    expect(refresh.get('grant_type')).toBe('refresh_token');
    expect(refresh.get('refresh_token')).toBe('refresh-secret');
    expect(refresh.has('redirect_uri')).toBe(false);
  });

  it('rejects malformed token contracts, scope expansion, and oversized responses categorically', async () => {
    for (const invalid of [
      { ...tokens, access_token: '' }, { ...tokens, token_type: 'MAC' }, { ...tokens, expires_in: 0 },
      { ...tokens, expires_in: 90_000 }, { ...tokens, scope: `${GOOGLE_DOCS_FILE_SCOPE} https://www.googleapis.com/auth/drive` },
      { ...tokens, scope: 'openid' },
    ]) {
      await expect(client(vi.fn<typeof fetch>().mockResolvedValue(response(invalid))).exchangeAuthorizationCode('code', verifier))
        .rejects.toMatchObject({ kind: 'INVALID_RESPONSE' });
    }
    await expect(client(vi.fn<typeof fetch>().mockResolvedValue(response('x'.repeat(2048))), { maxResponseBytes: 1024 })
      .exchangeAuthorizationCode('code', verifier)).rejects.toMatchObject({ kind: 'INVALID_RESPONSE' });
    const withoutRefresh = await client(vi.fn<typeof fetch>().mockResolvedValue(response({ access_token: 'a', token_type: 'Bearer', expires_in: 3600 })))
      .exchangeAuthorizationCode('code', verifier);
    expect(withoutRefresh).toEqual({ access_token: 'a', token_type: 'Bearer', expires_in: 3600 });
  });

  it('categorizes HTTP and transport failures without retaining provider text or credentials', async () => {
    const failed = client(vi.fn<typeof fetch>().mockResolvedValue(response({ error: 'invalid_grant', error_description: 'access-secret refresh-secret client-secret' }, 400)));
    let caught: unknown;
    try { await failed.exchangeAuthorizationCode('code', verifier); } catch (error) { caught = error; }
    expect(caught).toBeInstanceOf(GoogleOAuthError);
    expect(caught).toMatchObject({ kind: 'HTTP', status: 400 });
    expect(String(caught)).not.toMatch(/access-secret|refresh-secret|client-secret|invalid_grant/u);
    expect(JSON.stringify(caught)).not.toMatch(/access-secret|refresh-secret|client-secret/u);
    await expect(client(vi.fn<typeof fetch>().mockRejectedValue(new Error('refresh-secret network detail')))
      .refreshAccessToken('refresh-secret')).rejects.toMatchObject({ kind: 'TRANSPORT' });
  });

  it('bounds total exchange time including body reads and revokes at the fixed endpoint', async () => {
    const slowFetch = vi.fn<typeof fetch>().mockImplementation(() => new Promise<Response>(() => {}));
    await expect(client(slowFetch, { timeoutMs: 100 }).exchangeAuthorizationCode('code', verifier)).rejects.toMatchObject({ kind: 'TIMEOUT' });

    const slowBody = new ReadableStream<Uint8Array>({ start() {} });
    await expect(client(vi.fn<typeof fetch>().mockResolvedValue(new Response(slowBody)), { timeoutMs: 100 })
      .exchangeAuthorizationCode('code', verifier)).rejects.toMatchObject({ kind: 'TIMEOUT' });

    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 200 }));
    await expect(client(fetchImpl).revokeToken('refresh-secret')).resolves.toBeUndefined();
    expect(fetchImpl.mock.calls[0]![0]).toBe('https://oauth2.googleapis.com/revoke');
    expect(new URLSearchParams(String(fetchImpl.mock.calls[0]![1]?.body)).get('token')).toBe('refresh-secret');
  });

  it('allows only the exact localhost HTTP callback and rejects unsafe redirect configuration', async () => {
    expect(() => new GoogleOAuthClient({ clientId: 'id', clientSecret: 'secret', redirectUri: 'http://example.test/api/v1/google-docs/oauth/callback' })).toThrow(GoogleOAuthError);
    expect(() => new GoogleOAuthClient({ clientId: 'id', clientSecret: 'secret', redirectUri: 'http://localhost/api/v1/google-docs/oauth/callback?next=secret' })).toThrow(GoogleOAuthError);
    expect(() => new GoogleOAuthClient({ clientId: 'id', clientSecret: 'secret', redirectUri: 'http://127.0.0.1/api/v1/google-docs/oauth/callback#fragment' })).toThrow(GoogleOAuthError);
    expect(() => new GoogleOAuthClient({ clientId: 'id', clientSecret: 'secret', redirectUri: 'http://localhost/oauth/callback' })).toThrow(GoogleOAuthError);
    expect(() => new GoogleOAuthClient({ clientId: 'id', clientSecret: 'secret', redirectUri: 'http://user:pass@localhost/api/v1/google-docs/oauth/callback' })).toThrow(GoogleOAuthError);
    expect(() => new GoogleOAuthClient({ clientId: 'id', clientSecret: 'secret', redirectUri: 'http://127.0.0.1:3000/api/v1/google-docs/oauth/callback' })).not.toThrow();
    expect(() => new GoogleOAuthClient({ clientId: 'id', clientSecret: 'secret', redirectUri: 'https://app.example.test/api/v1/google-docs/oauth/callback' })).not.toThrow();
    expect(() => new GoogleOAuthClient({ clientId: 'id', clientSecret: 'secret', redirectUri: 'https://app.example.test/api/v1/google-docs/oauth/callback?next=x' })).toThrow(GoogleOAuthError);
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(response({ error: 'secret refresh-token' }, 503));
    await expect(client(fetchImpl).revokeToken('refresh-token')).rejects.toMatchObject({ kind: 'HTTP', status: 503 });
  });
});
