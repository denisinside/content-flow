import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DependencyHealthService, loadRuntimeConfig, databasePoolOptions } from '@contextflow/backend';
import { Pool } from 'pg';
import { Redis } from 'ioredis';
import { randomUUID } from 'node:crypto';

const config = loadRuntimeConfig();
const health = new DependencyHealthService(config);
const runtimePool = new Pool(databasePoolOptions(config));
const redis = new Redis(config.redisUrl, { lazyConnect: true, maxRetriesPerRequest: 1, retryStrategy: () => null });
redis.on('error', () => {});

describe('isolated real PostgreSQL/Redis foundation', () => {
  beforeAll(async () => { await redis.connect(); });
  afterAll(async () => { redis.disconnect(); await runtimePool.end(); await health.onModuleDestroy(); });
  it('queries through generated Prisma7 and pings Redis', async () => {
    expect(await health.check()).toEqual({ status: 'ready', checks: { database: 'up', redis: 'up' } });
  });
  it('uses a runtime role without schema/role privileges', async () => {
    const result = await runtimePool.query<{ rolsuper: boolean; rolcreatedb: boolean; rolcreaterole: boolean; rolbypassrls: boolean; can_create: boolean }>(
      "SELECT rolsuper, rolcreatedb, rolcreaterole, rolbypassrls, has_schema_privilege(current_user, 'contextflow', 'CREATE') AS can_create FROM pg_roles WHERE rolname = current_user"
    );
    expect(result.rows[0]).toEqual({ rolsuper: false, rolcreatedb: false, rolcreaterole: false, rolbypassrls: false, can_create: false });
    const client = await runtimePool.connect();
    try {
      await client.query('BEGIN');
      await expect(client.query('CREATE TABLE contextflow.runtime_must_not_create (id integer)')).rejects.toThrow();
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  });
  it('cannot read or modify Prisma migration metadata', async () => {
    const result = await runtimePool.query<{ can_read: boolean; can_write: boolean }>(
      "SELECT has_table_privilege(current_user, 'contextflow._prisma_migrations', 'SELECT') AS can_read, has_table_privilege(current_user, 'contextflow._prisma_migrations', 'UPDATE') AS can_write"
    );
    expect(result.rows[0]).toEqual({ can_read: false, can_write: false });
  });
  it('cannot read the provider-owned TEST Auth schema', async () => {
    const result = await runtimePool.query<{ can_use: boolean; can_read: boolean }>(
      "SELECT has_schema_privilege(current_user, n.oid, 'USAGE') AS can_use, has_table_privilege(current_user, c.oid, 'SELECT') AS can_read FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'auth' AND c.relname = 'users'"
    );
    expect(result.rows[0]).toEqual({ can_use: false, can_read: false });
  });
  it('round-trips only an isolated expiring synthetic Redis key', async () => {
    const key = 'contextflow:test:' + randomUUID();
    try {
      expect(await redis.set(key, 'synthetic', 'EX', 30)).toBe('OK');
      expect(await redis.get(key)).toBe('synthetic');
    } finally { await redis.del(key); }
  });
});
