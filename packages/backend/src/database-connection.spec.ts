import { describe, expect, it } from 'vitest';
import { parseRuntimeConfig } from './config.js';
import { migrationConnectionUrl } from './database-connection.js';

const cloud = {
  DATABASE_URL: 'postgresql://cf_runtime:synthetic@db.projectalpha.supabase.co/postgres?schema=contextflow&sslmode=require',
  DIRECT_DATABASE_URL: 'postgresql://cf_migrate:synthetic@db.projectalpha.supabase.co/postgres?schema=contextflow&sslmode=verify-full',
  REDIS_URL: 'rediss://default:synthetic@synthetic.upstash.io:6379'
};
describe('Prisma7 migration TLS boundary', () => {
  it('converts pg verification modes into strict Prisma engine TLS options', () => {
    const url = new URL(migrationConnectionUrl(parseRuntimeConfig(cloud)));
    expect(url.searchParams.get('sslmode')).toBe('require');
    expect(url.searchParams.get('sslaccept')).toBe('strict');
  });
  it('maps optional CA into the pinned engine certificate field', () => {
    const url = new URL(migrationConnectionUrl(parseRuntimeConfig({ ...cloud, DATABASE_SSL_CA_FILE: 'tests/fixtures/provider-ca.pem' })));
    expect(url.searchParams.get('sslmode')).toBe('require');
    expect(url.searchParams.get('sslaccept')).toBe('strict');
    expect(url.searchParams.get('sslcert')).toMatch(/provider-ca\.pem$/);
    expect(url.searchParams.has('sslrootcert')).toBe(false);
  });
  it('keeps the local model-free setup usable without TLS', () => {
    const config = parseRuntimeConfig({
      DATABASE_URL: 'postgresql://cf_runtime:synthetic@127.0.0.1/dev?schema=contextflow',
      DIRECT_DATABASE_URL: 'postgresql://cf_migrate:synthetic@127.0.0.1/dev?schema=contextflow',
      REDIS_URL: 'redis://127.0.0.1:6379'
    });
    expect(new URL(migrationConnectionUrl(config)).searchParams.has('sslmode')).toBe(false);
  });
});
