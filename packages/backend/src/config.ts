import { config as loadDotenv } from 'dotenv';
import { fileURLToPath } from 'node:url';
import { isAbsolute, resolve } from 'node:path';
import { z } from 'zod';

export const workspaceRoot = fileURLToPath(new URL('../../..', import.meta.url));

export class ConfigurationError extends Error {
  constructor(fields: readonly string[]) {
    super('Invalid or missing environment variables: ' + [...new Set(fields)].join(', '));
    this.name = 'ConfigurationError';
  }
}

const loopbackHosts = new Set(['localhost', '127.0.0.1', '[::1]']);
function isDatabaseUrl(value: string): boolean {
  try {
    const url = new URL(value);
    const parameters = [...url.searchParams.keys()];
    const allowed = new Set(['schema', 'sslmode', 'sslrootcert', 'connection_limit', 'connect_timeout', 'pool_timeout']);
    if (parameters.some(key => !allowed.has(key)) || new Set(parameters).size !== parameters.length) return false;
    decodeURIComponent(url.username);
    decodeURIComponent(url.password);
    decodeURIComponent(url.pathname);
    return ['postgres:', 'postgresql:'].includes(url.protocol)
      && url.pathname.length > 1 && !url.pathname.slice(1).includes('/') && url.hash === ''
      && url.searchParams.get('schema') === 'contextflow'
      && !value.includes('GENERATE_')
      && (loopbackHosts.has(url.hostname)
        || ['require', 'verify-ca', 'verify-full'].includes(url.searchParams.get('sslmode') ?? ''));
  } catch { return false; }
}
function isRedisUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (url.protocol === 'rediss:' || (url.protocol === 'redis:' && loopbackHosts.has(url.hostname)))
      && url.search === '' && url.hash === ''
      && /^\/?\d*$/.test(url.pathname)
      && Number.isSafeInteger(Number(url.pathname.slice(1) || '0'))
      && !value.includes('GENERATE_');
  } catch { return false; }
}
function databaseIdentity(value: string): string {
  const url = new URL(value);
  const host = loopbackHosts.has(url.hostname) ? 'loopback' : url.hostname;
  const directProject = /^db\.([a-z0-9]+)\.supabase\.co$/.exec(url.hostname)?.[1];
  const pooledProject = url.hostname.endsWith('.pooler.supabase.com') ? decodeURIComponent(url.username).split('.').slice(1).join('.') : undefined;
  const project = directProject || pooledProject;
  const database = decodeURIComponent(url.pathname);
  if (project) return 'supabase:' + project + database;
  return host + ':' + (url.port || '5432') + database;
}
function redisIdentity(value: string): string {
  const url = new URL(value);
  const host = loopbackHosts.has(url.hostname) ? 'loopback' : url.hostname;
  return host + ':' + (url.port || '6379') + '/' + Number(url.pathname.slice(1) || '0');
}
const port = z.coerce.number().int().min(1).max(65535);
const optionalUrl = z.preprocess(value => value === '' ? undefined : value, z.url().optional());
const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  API_HOST: z.string().min(1).default('127.0.0.1'),
  API_PORT: port.default(3000),
  WORKER_HEALTH_HOST: z.string().min(1).default('127.0.0.1'),
  WORKER_HEALTH_PORT: port.default(3001),
  WEB_ORIGIN: z.url().default('http://localhost:5173'),
  DEPENDENCY_TIMEOUT_MS: z.coerce.number().int().min(100).max(30000).default(3000),
  DATABASE_URL: z.string().refine(isDatabaseUrl),
  DIRECT_DATABASE_URL: z.string().refine(isDatabaseUrl),
  DATABASE_SSL_CA_FILE: z.string().optional(),
  REDIS_URL: z.string().refine(isRedisUrl),
  SUPABASE_URL: optionalUrl
});

export interface BackendConfig {
  nodeEnv: 'development' | 'test' | 'production';
  apiHost: string;
  apiPort: number;
  workerHealthHost: string;
  workerHealthPort: number;
  webOrigin: string;
  dependencyTimeoutMs: number;
  databaseUrl: string;
  directDatabaseUrl: string;
  databaseSslCaFile: string | undefined;
  redisUrl: string;
}

export function parseRuntimeConfig(input: Record<string, string | undefined>): BackendConfig {
  const testMode = input['NODE_ENV'] === 'test';
  const selected = {
    ...input,
    DATABASE_URL: testMode ? input['TEST_DATABASE_URL'] : input['DATABASE_URL'],
    DIRECT_DATABASE_URL: testMode ? input['TEST_DIRECT_DATABASE_URL'] : input['DIRECT_DATABASE_URL'],
    DATABASE_SSL_CA_FILE: testMode ? input['TEST_DATABASE_SSL_CA_FILE'] : input['DATABASE_SSL_CA_FILE'],
    REDIS_URL: testMode ? input['TEST_REDIS_URL'] : input['REDIS_URL']
  };
  const parsed = schema.safeParse(selected);
  if (!parsed.success) {
    throw new ConfigurationError(parsed.error.issues.map(issue => {
      const key = String(issue.path[0] ?? 'configuration');
      return testMode && ['DATABASE_URL', 'DIRECT_DATABASE_URL', 'DATABASE_SSL_CA_FILE', 'REDIS_URL'].includes(key) ? 'TEST_' + key : key;
    }));
  }
  const env = parsed.data;
  if (testMode) {
    const developmentDatabases = [input['DATABASE_URL'], input['DIRECT_DATABASE_URL']].filter((value): value is string => !!value && isDatabaseUrl(value));
    if (developmentDatabases.some(value => [env.DATABASE_URL, env.DIRECT_DATABASE_URL].some(testUrl => databaseIdentity(testUrl) === databaseIdentity(value)))) {
      throw new ConfigurationError(['TEST_DATABASE_URL (must use a separate database)']);
    }
    if (input['REDIS_URL'] && isRedisUrl(input['REDIS_URL'])
      && redisIdentity(env.REDIS_URL) === redisIdentity(input['REDIS_URL'])) {
      throw new ConfigurationError(['TEST_REDIS_URL (must use a separate Redis database)']);
    }
  }
  return {
    nodeEnv: env.NODE_ENV, apiHost: env.API_HOST, apiPort: env.API_PORT,
    workerHealthHost: env.WORKER_HEALTH_HOST, workerHealthPort: env.WORKER_HEALTH_PORT,
    webOrigin: env.WEB_ORIGIN, dependencyTimeoutMs: env.DEPENDENCY_TIMEOUT_MS,
    databaseUrl: env.DATABASE_URL, directDatabaseUrl: env.DIRECT_DATABASE_URL,
    databaseSslCaFile: env.DATABASE_SSL_CA_FILE || undefined, redisUrl: env.REDIS_URL
  };
}

export function loadRuntimeConfig(): BackendConfig {
  const filename = process.env['CONTEXTFLOW_ENV_FILE'] || '.env';
  loadDotenv({ path: isAbsolute(filename) ? filename : resolve(workspaceRoot, filename), quiet: true });
  return parseRuntimeConfig(process.env);
}
