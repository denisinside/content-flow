import { ConfigurationError, loadRuntimeConfig } from '@contextflow/backend';

export interface AuthConfig {
  providerUrl: string;
  publishableKey: string;
  encryptionKeys: ReadonlyMap<number, Buffer>;
  currentKeyVersion: number;
  csrfKey: Buffer;
  webOrigin: string;
  absoluteTtlMs: number;
  providerTimeoutMs: number;
}

export const SESSION_ABSOLUTE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

function key(value: string | undefined, field: string): Buffer {
  if (!value || !/^[A-Za-z0-9+/]{43}=$/.test(value) || Buffer.from(value, 'base64').length !== 32) {
    throw new ConfigurationError([field]);
  }
  return Buffer.from(value, 'base64');
}

export function parseAuthConfig(env: Record<string, string | undefined>, webOrigin: string): AuthConfig {
  const prefix = env['NODE_ENV'] === 'test' ? 'TEST_' : '';
  const urlField = prefix + 'SUPABASE_URL';
  let url: URL;
  try { url = new URL(env[urlField] ?? ''); } catch { throw new ConfigurationError([urlField]); }
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/'
    || (url.protocol !== 'https:' && !(prefix && url.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(url.hostname)))) {
    throw new ConfigurationError([urlField]);
  }
  if (prefix && env['SUPABASE_URL']?.replace(/\/$/, '') === url.origin) throw new ConfigurationError([urlField + ' (must be isolated)']);
  const publishableKey = env[prefix + 'SUPABASE_PUBLISHABLE_KEY'];
  if (!publishableKey || publishableKey.includes('GENERATE_')) throw new ConfigurationError([prefix + 'SUPABASE_PUBLISHABLE_KEY']);
  const version = Number(env[prefix + 'SESSION_ENCRYPTION_KEY_VERSION'] || '1');
  if (!Number.isSafeInteger(version) || version < 1) throw new ConfigurationError([prefix + 'SESSION_ENCRYPTION_KEY_VERSION']);
  const keys = new Map<number, Buffer>([[version, key(env[prefix + 'SESSION_ENCRYPTION_KEY'], prefix + 'SESSION_ENCRYPTION_KEY')]]);
  const previous = env[prefix + 'SESSION_PREVIOUS_ENCRYPTION_KEYS'];
  if (previous) {
    try {
      const entries: unknown = JSON.parse(previous);
      if (!entries || typeof entries !== 'object' || Array.isArray(entries)) throw new Error();
      for (const [v, value] of Object.entries(entries)) {
        if (!/^\d+$/.test(v) || !Number.isSafeInteger(Number(v)) || Number(v) < 1 || Number(v) === version || typeof value !== 'string') throw new Error();
        keys.set(Number(v), key(value, prefix + 'SESSION_PREVIOUS_ENCRYPTION_KEYS'));
      }
    } catch { throw new ConfigurationError([prefix + 'SESSION_PREVIOUS_ENCRYPTION_KEYS']); }
  }
  const timeout = Number(env['AUTH_PROVIDER_TIMEOUT_MS'] || '5000');
  if (!Number.isInteger(timeout) || timeout < 100 || timeout > 5000) throw new ConfigurationError(['AUTH_PROVIDER_TIMEOUT_MS']);
  let origin: URL;
  try { origin = new URL(webOrigin); } catch { throw new ConfigurationError(['WEB_ORIGIN']); }
  if (origin.href !== origin.origin + '/' || (env['NODE_ENV'] === 'production' && origin.protocol !== 'https:')) throw new ConfigurationError(['WEB_ORIGIN']);
  return { providerUrl: url.origin, publishableKey, encryptionKeys: keys, currentKeyVersion: version,
    csrfKey: key(env[prefix + 'SESSION_CSRF_KEY'], prefix + 'SESSION_CSRF_KEY'), webOrigin: origin.origin,
    absoluteTtlMs: SESSION_ABSOLUTE_TTL_MS, providerTimeoutMs: timeout };
}

export function loadAuthConfig(): AuthConfig {
  const runtime = loadRuntimeConfig();
  return parseAuthConfig(process.env, runtime.webOrigin);
}
