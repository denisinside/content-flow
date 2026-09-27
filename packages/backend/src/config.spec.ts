import { describe, expect, it } from 'vitest';
import { ConfigurationError, parseRuntimeConfig } from './config.js';

const valid = {
  DATABASE_URL: 'postgresql://runtime:local@127.0.0.1:54329/dev?schema=contextflow',
  DIRECT_DATABASE_URL: 'postgresql://migrate:local@127.0.0.1:54329/dev?schema=contextflow',
  REDIS_URL: 'redis://127.0.0.1:63829/0',
  TEST_DATABASE_URL: 'postgresql://runtime:test@127.0.0.1:54330/test?schema=contextflow',
  TEST_DIRECT_DATABASE_URL: 'postgresql://migrate:test@127.0.0.1:54330/test?schema=contextflow',
  TEST_REDIS_URL: 'redis://127.0.0.1:63830/0'
};

describe('environment trust boundary', () => {
  it('selects isolated services in test mode', () => {
    const config = parseRuntimeConfig({ ...valid, NODE_ENV: 'test' });
    expect(config.databaseUrl).toBe(valid.TEST_DATABASE_URL);
    expect(config.directDatabaseUrl).toBe(valid.TEST_DIRECT_DATABASE_URL);
    expect(config.redisUrl).toBe(valid.TEST_REDIS_URL);
  });
  it('never falls back to development credentials when test config is missing', () => {
    expect(() => parseRuntimeConfig({ ...valid, NODE_ENV: 'test', TEST_DATABASE_URL: undefined })).toThrow('TEST_DATABASE_URL');
  });
  it('denies tests against the same database even with another user', () => {
    expect(() => parseRuntimeConfig({
      ...valid, NODE_ENV: 'test', TEST_DATABASE_URL: valid.DIRECT_DATABASE_URL,
      TEST_DIRECT_DATABASE_URL: valid.DATABASE_URL
    })).toThrow('separate database');
  });
  it('denies tests against the same Redis service', () => {
    expect(() => parseRuntimeConfig({ ...valid, NODE_ENV: 'test', TEST_REDIS_URL: valid.REDIS_URL })).toThrow('separate Redis');
  });
  it('denies Supabase direct/session aliases of the same development project', () => {
    expect(() => parseRuntimeConfig({
      ...valid, NODE_ENV: 'test',
      DATABASE_URL: 'postgresql://cf_runtime:secret@db.projectalpha.supabase.co:5432/postgres?schema=contextflow&sslmode=require',
      DIRECT_DATABASE_URL: 'postgresql://cf_migrate:secret@db.projectalpha.supabase.co:5432/postgres?schema=contextflow&sslmode=require',
      TEST_DIRECT_DATABASE_URL: 'postgresql://cf_migrate.projectalpha:secret@eu.pooler.supabase.com:5432/postgres?schema=contextflow&sslmode=require'
    })).toThrow('separate database');
  });
  it('denies percent-encoded aliases and topology overrides', () => {
    const cloud = 'postgresql://cf_runtime:secret@db.projectalpha.supabase.co:5432/postgres?schema=contextflow&sslmode=require';
    expect(() => parseRuntimeConfig({
      ...valid, NODE_ENV: 'test', DATABASE_URL: cloud, DIRECT_DATABASE_URL: cloud,
      TEST_DIRECT_DATABASE_URL: 'postgresql://cf_migrate%2Eprojectalpha:secret@eu.pooler.supabase.com:5432/%70ostgres?schema=contextflow&sslmode=require'
    })).toThrow('separate database');
    for (const value of [
      valid.TEST_DIRECT_DATABASE_URL + '&host=127.0.0.1&port=54329',
      valid.TEST_DIRECT_DATABASE_URL + '&user=cf_runtime',
      valid.TEST_DIRECT_DATABASE_URL + '&schema=auth',
      valid.TEST_DIRECT_DATABASE_URL.replace('/test?', '/dev/ignored?')
    ]) {
      expect(() => parseRuntimeConfig({ ...valid, NODE_ENV: 'test', TEST_DIRECT_DATABASE_URL: value })).toThrow('TEST_DIRECT_DATABASE_URL');
    }
  });
  it('permits distinct Supabase projects behind the same pooler host', () => {
    expect(parseRuntimeConfig({
      ...valid, NODE_ENV: 'test',
      DATABASE_URL: 'postgresql://cf_runtime.projectalpha:secret@eu.pooler.supabase.com:5432/postgres?schema=contextflow&sslmode=require',
      DIRECT_DATABASE_URL: 'postgresql://cf_migrate:secret@db.projectalpha.supabase.co:5432/postgres?schema=contextflow&sslmode=require',
      TEST_DATABASE_URL: 'postgresql://cf_runtime.projectbeta:secret@eu.pooler.supabase.com:5432/postgres?schema=contextflow&sslmode=require',
      TEST_DIRECT_DATABASE_URL: 'postgresql://cf_migrate:secret@db.projectbeta.supabase.co:5432/postgres?schema=contextflow&sslmode=require'
    }).nodeEnv).toBe('test');
  });
  it('denies alternate spelling of the same Redis database and loopback host', () => {
    expect(() => parseRuntimeConfig({ ...valid, NODE_ENV: 'test', TEST_REDIS_URL: 'redis://localhost:63829/00' })).toThrow('separate Redis');
  });
  it('rejects query-based Redis overrides and invalid database indices', () => {
    for (const value of ['redis://127.0.0.1:63829/invalid', 'redis://127.0.0.1:63829/1?db=0']) {
      expect(() => parseRuntimeConfig({ ...valid, REDIS_URL: value })).toThrow('REDIS_URL');
    }
  });
  it('allows TLS managed Redis and denies HTTP REST or cleartext remote Redis', () => {
    expect(parseRuntimeConfig({ ...valid, REDIS_URL: 'rediss://default:test@synthetic.upstash.io:6379' }).redisUrl).toContain('rediss:');
    for (const value of ['https://synthetic.upstash.io', 'redis://default:test@synthetic.upstash.io:6379']) {
      expect(() => parseRuntimeConfig({ ...valid, REDIS_URL: value })).toThrow('REDIS_URL');
    }
  });
  it('requires TLS and the app schema for remote PostgreSQL', () => {
    expect(() => parseRuntimeConfig({ ...valid, DATABASE_URL: 'postgresql://user:secret@synthetic.supabase.co/db?schema=contextflow' })).toThrow('DATABASE_URL');
    expect(() => parseRuntimeConfig({ ...valid, DATABASE_URL: 'postgresql://user:secret@127.0.0.1/db?schema=auth' })).toThrow('DATABASE_URL');
  });
  it('reports variable names without exposing supplied passwords or URL values', () => {
    try { parseRuntimeConfig({ ...valid, DATABASE_URL: 'secret-in-invalid-url', API_PORT: '70000' }); }
    catch (error) {
      expect(error).toBeInstanceOf(ConfigurationError);
      expect(String(error)).toContain('DATABASE_URL');
      expect(String(error)).not.toContain('secret-in-invalid-url');
      return;
    }
    throw new Error('Expected invalid environment to fail');
  });
});
