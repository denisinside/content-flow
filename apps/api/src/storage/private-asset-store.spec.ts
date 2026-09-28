import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rm } from 'node:fs/promises';
import { relative, resolve } from 'node:path';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { PrivateAssetStore, privateStorageConfig, STORAGE_MAX_BYTES } from './private-asset-store.js';

const parent = resolve('coverage/storage-unit');
const directory = resolve(parent, randomUUID());
const store = new PrivateAssetStore({ driver: 'filesystem', bucket: 'local-originals', directory });
const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

afterEach(() => vi.unstubAllGlobals());
afterAll(async () => {
  const target = relative(parent, directory);
  if (!target || target.startsWith('..') || target.includes(':')) throw new Error('Invalid TEST cleanup path');
  await rm(directory, { recursive: true, force: true });
});

describe('private original storage', () => {
  it('isolates TEST from cloud settings and refuses production filesystem storage', () => {
    const config = privateStorageConfig({ NODE_ENV: 'test', PRIVATE_ASSET_DRIVER: 'supabase', SUPABASE_URL: 'https://example.test', SUPABASE_SECRET_KEY: 'test-secret' });
    expect(config.driver).toBe('filesystem');
    expect(config.directory).toMatch(/\.private-assets-test$/);
    expect(config.secretKey).toBeUndefined();
    expect(() => privateStorageConfig({ NODE_ENV: 'production', PRIVATE_ASSET_DRIVER: 'filesystem' })).toThrow();
  });

  it('preserves exact bytes, refuses replacement and checks content integrity', async () => {
    const bytes = Buffer.from('\uFEFFУкраїнський текст\r\n# Заголовок\n', 'utf8');
    const ref = await store.put(randomUUID(), randomUUID(), bytes);
    expect(await store.read(ref.bucket, ref.objectKey, hash(bytes))).toEqual(bytes);
    const ids = ref.objectKey.split('/');
    await expect(store.put(ids[0]!, ids[2]!, Buffer.from('replacement'))).rejects.toThrow();
    expect(await readFile(resolve(directory, ref.objectKey))).toEqual(bytes);
    await expect(store.read(ref.bucket, ref.objectKey, hash(Buffer.from('different')))).rejects.toThrow();
    await store.remove(ref.bucket, ref.objectKey);
    await expect(store.read(ref.bucket, ref.objectKey, hash(bytes))).rejects.toThrow();
  });

  it('denies arbitrary buckets, traversal, empty and oversized objects', async () => {
    await mkdir(directory, { recursive: true });
    await expect(store.read('another-bucket', '../outside', 'a'.repeat(64))).rejects.toThrow();
    await expect(store.remove('local-originals', 'projects/../../outside')).rejects.toThrow();
    await expect(store.put(randomUUID(), randomUUID(), Buffer.alloc(0))).rejects.toThrow();
    await expect(store.put(randomUUID(), randomUUID(), Buffer.alloc(STORAGE_MAX_BYTES + 1))).rejects.toThrow();
  });

  it('refuses a public cloud bucket and sends no object request', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ id: 'contextflow-originals', public: true })));
    vi.stubGlobal('fetch', fetchMock);
    const cloud = new PrivateAssetStore({ driver: 'supabase', bucket: 'contextflow-originals', directory: '', providerUrl: 'https://storage.example.test', secretKey: 'synthetic-key' });
    await expect(cloud.put(randomUUID(), randomUUID(), Buffer.from('test'))).rejects.toThrow();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('uses private immutable uploads and checks downloaded bytes with no public URL', async () => {
    const bytes = Buffer.from('synthetic private original');
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: 'contextflow-originals', public: false })))
      .mockResolvedValueOnce(new Response('{}'))
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: 'contextflow-originals', public: false })))
      .mockResolvedValueOnce(new Response(new Uint8Array(bytes)));
    vi.stubGlobal('fetch', fetchMock);
    const cloud = new PrivateAssetStore({ driver: 'supabase', bucket: 'contextflow-originals', directory: '', providerUrl: 'https://storage.example.test', secretKey: 'synthetic-key' });
    const ref = await cloud.put(randomUUID(), randomUUID(), bytes);
    expect(await cloud.read(ref.bucket, ref.objectKey, hash(bytes))).toEqual(bytes);
    expect(fetchMock.mock.calls[1]?.[1]?.headers).toMatchObject({ 'x-upsert': 'false' });
    expect(String(fetchMock.mock.calls[3]?.[0])).toContain('/object/authenticated/');
  });
});
