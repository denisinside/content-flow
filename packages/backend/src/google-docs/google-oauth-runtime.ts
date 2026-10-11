import { GoogleOAuthClient } from './google-oauth-client.js';
import { GoogleOAuthCrypto, type GoogleOAuthKeyring } from './google-oauth-crypto.js';

export type GoogleOAuthRuntime =
  | { kind: 'disabled' }
  | { kind: 'configured'; client: GoogleOAuthClient; crypto: GoogleOAuthCrypto; docsFetchImpl?: typeof fetch };

function key(value: string | undefined): Buffer | null {
  if (!value || !/^[A-Za-z0-9+/]{43}=$/u.test(value)) return null;
  const decoded = Buffer.from(value, 'base64');
  return decoded.length === 32 && decoded.toString('base64') === value ? decoded : null;
}

function validRedirect(raw: string, nodeEnv: string | undefined, apiHost: string | undefined, apiPort: string | undefined): boolean {
  try {
    const uri = new URL(raw);
    if (uri.username || uri.password || uri.search || uri.hash || uri.pathname !== '/api/v1/google-docs/oauth/callback') return false;
    if (nodeEnv === 'production') return uri.protocol === 'https:';
    if (uri.protocol !== 'http:' || !['localhost', '127.0.0.1'].includes(uri.hostname)) return false;
    if (!apiHost || !apiPort) return true;
    const port = Number(apiPort);
    return uri.port === String(port) && (apiHost === uri.hostname || ['localhost', '127.0.0.1'].includes(apiHost) && ['localhost', '127.0.0.1'].includes(uri.hostname));
  } catch { return false; }
}

/** Optional server-only integration configuration. Invalid or partial credentials fail closed. */
export function loadGoogleOAuthRuntime(env: NodeJS.ProcessEnv = process.env): GoogleOAuthRuntime {
  const prefix = env['NODE_ENV'] === 'test' ? 'TEST_' : '';
  const clientId = env[prefix + 'GOOGLE_DOCS_CLIENT_ID'];
  const clientSecret = env[prefix + 'GOOGLE_DOCS_CLIENT_SECRET'];
  const redirectUri = env[prefix + 'GOOGLE_DOCS_REDIRECT_URI'];
  const keyVersionRaw = env[prefix + 'GOOGLE_DOCS_TOKEN_ENCRYPTION_KEY_VERSION'];
  const currentKey = env[prefix + 'GOOGLE_DOCS_TOKEN_ENCRYPTION_KEY'];
  const previousKeys = env[prefix + 'GOOGLE_DOCS_TOKEN_PREVIOUS_ENCRYPTION_KEYS'];
  const supplied = [clientId, clientSecret, redirectUri, keyVersionRaw, currentKey, previousKeys].some(value => value !== undefined && value !== '');
  if (!supplied) return { kind: 'disabled' };
  if (!clientId || clientId.length > 512 || !clientSecret || clientSecret.length > 8192 || !redirectUri
    || !validRedirect(redirectUri, env['NODE_ENV'], env['API_HOST'], env['API_PORT'])) return { kind: 'disabled' };
  const version = Number(keyVersionRaw ?? '1');
  const current = key(currentKey);
  if (!Number.isSafeInteger(version) || version < 1 || !current) return { kind: 'disabled' };
  const keys = new Map<number, Buffer>([[version, current]]);
  if (previousKeys) {
    try {
      const parsed: unknown = JSON.parse(previousKeys);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { kind: 'disabled' };
      for (const [rawVersion, value] of Object.entries(parsed)) {
        const oldVersion = Number(rawVersion);
        const oldKey = typeof value === 'string' ? key(value) : null;
        if (!/^\d+$/u.test(rawVersion) || !Number.isSafeInteger(oldVersion) || oldVersion < 1 || oldVersion === version || !oldKey) return { kind: 'disabled' };
        keys.set(oldVersion, oldKey);
      }
    } catch { return { kind: 'disabled' }; }
  }
  const ring: GoogleOAuthKeyring = { currentVersion: version, keys };
  try {
    return { kind: 'configured', client: new GoogleOAuthClient({ clientId, clientSecret, redirectUri }), crypto: new GoogleOAuthCrypto(ring) };
  } catch { return { kind: 'disabled' }; }
}
