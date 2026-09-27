import type { PoolConfig } from 'pg';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { ConfigurationError, workspaceRoot } from './config.js';
import type { BackendConfig } from './config.js';

export function databasePoolOptions(config: BackendConfig): PoolConfig {
  const url = new URL(config.databaseUrl);
  let ssl: { ca: string; rejectUnauthorized: true } | undefined;
  if (config.databaseSslCaFile) {
    try { ssl = { ca: readFileSync(resolve(workspaceRoot, config.databaseSslCaFile), 'utf8'), rejectUnauthorized: true }; }
    catch { throw new ConfigurationError([config.nodeEnv === 'test' ? 'TEST_DATABASE_SSL_CA_FILE' : 'DATABASE_SSL_CA_FILE']); }
    for (const name of ['sslmode', 'sslcert', 'sslkey', 'sslrootcert']) url.searchParams.delete(name);
  }
  return {
    connectionString: url.toString(), max: 2, idleTimeoutMillis: 10000,
    connectionTimeoutMillis: config.dependencyTimeoutMs,
    query_timeout: config.dependencyTimeoutMs,
    statement_timeout: config.dependencyTimeoutMs,
    ...(ssl ? { ssl } : {})
  };
}

// Prisma7's native migration engine has a different SSL URL contract from pg.
// Normalize at this CLI boundary; never pass pg verify-full/sslrootcert unchanged.
export function migrationConnectionUrl(config: BackendConfig): string {
  const url = new URL(config.directDatabaseUrl);
  const certificate = config.databaseSslCaFile || url.searchParams.get('sslrootcert');
  const mode = url.searchParams.get('sslmode');
  const remote = !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  url.searchParams.delete('sslrootcert');
  if (remote || certificate || (mode && ['require', 'verify-ca', 'verify-full'].includes(mode))) {
    url.searchParams.set('sslmode', 'require');
    url.searchParams.set('sslaccept', 'strict');
    if (certificate) url.searchParams.set('sslcert', resolve(workspaceRoot, certificate));
  }
  return url.toString();
}
