import { Inject, Injectable, Optional, ServiceUnavailableException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { lstat, mkdir, open, readFile, unlink } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ConfigurationError, loadRuntimeConfig } from '@contextflow/backend';

export const STORAGE_MAX_BYTES = 1024 * 1024;
const workspaceRoot = fileURLToPath(new URL('../../../../', import.meta.url));
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const objectKeyPattern = /^([0-9a-f-]{36})\/originals\/([0-9a-f-]{36})$/i;

export interface PrivateStorageConfig {
  driver: 'filesystem' | 'supabase';
  directory: string;
  bucket: string;
  providerUrl?: string;
  secretKey?: string;
}

export function privateStorageConfig(env: Record<string, string | undefined>): PrivateStorageConfig {
  // TEST never selects a cloud driver or development directory, even if cloud keys exist.
  if (env['NODE_ENV'] === 'test') return { driver: 'filesystem', directory: resolve(workspaceRoot, '.private-assets-test'), bucket: 'local-originals' };
  const driver = env['PRIVATE_ASSET_DRIVER'] || 'supabase';
  if (driver === 'filesystem' && env['NODE_ENV'] !== 'production') {
    return { driver, directory: resolve(workspaceRoot, '.private-assets'), bucket: 'local-originals' };
  }
  if (driver !== 'supabase') throw new ConfigurationError(['PRIVATE_ASSET_DRIVER']);
  const bucket = env['SUPABASE_ORIGINALS_BUCKET'] || 'contextflow-originals';
  if (!/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(bucket)) throw new ConfigurationError(['SUPABASE_ORIGINALS_BUCKET']);
  return { driver, directory: '', bucket, ...(env['SUPABASE_URL'] ? { providerUrl: env['SUPABASE_URL'] } : {}),
    ...(env['SUPABASE_SECRET_KEY'] ? { secretKey: env['SUPABASE_SECRET_KEY'] } : {}) };
}

@Injectable()
export class PrivateAssetStore {
  readonly config: PrivateStorageConfig;
  constructor(@Optional() @Inject('PRIVATE_STORAGE_CONFIG') config?: PrivateStorageConfig) {
    if (config) this.config = config;
    else { loadRuntimeConfig(); this.config = privateStorageConfig(process.env); }
  }

  private validate(bucket: string, key: string): void {
    const match = objectKeyPattern.exec(key);
    if (bucket !== this.config.bucket || !match || !uuid.test(match[1] ?? '') || !uuid.test(match[2] ?? '')) {
      throw new ServiceUnavailableException('Private file integrity check failed');
    }
  }

  private async localPath(key: string): Promise<string> {
    const parts = key.split('/');
    let current = this.config.directory;
    await mkdir(current, { recursive: true, mode: 0o700 });
    if ((await lstat(current)).isSymbolicLink()) throw new ServiceUnavailableException('Private storage unavailable');
    for (const part of parts.slice(0, -1)) {
      current = resolve(current, part);
      await mkdir(current, { recursive: true, mode: 0o700 });
      const stat = await lstat(current);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new ServiceUnavailableException('Private storage unavailable');
    }
    const path = resolve(current, parts.at(-1)!);
    try {
      const stat = await lstat(path);
      if (!stat.isFile() || stat.isSymbolicLink()) throw new ServiceUnavailableException('Private file integrity check failed');
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
    }
    return path;
  }

  private async providerRequest(path: string, init: RequestInit, maxBytes: number): Promise<Buffer> {
    const { providerUrl, secretKey } = this.config;
    if (!providerUrl || !secretKey || secretKey.includes('GENERATE_')) throw new ServiceUnavailableException('Private storage is not configured');
    let url: URL;
    try {
      url = new URL(providerUrl);
      if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error();
    } catch { throw new ServiceUnavailableException('Private storage is not configured'); }
    const response = await fetch(`${url.origin}/storage/v1/${path}`, {
      ...init, redirect: 'error', signal: AbortSignal.timeout(10000),
      headers: { apikey: secretKey, Authorization: `Bearer ${secretKey}`, ...init.headers },
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new ServiceUnavailableException('Private storage request failed');
    }
    const reader = response.body?.getReader();
    if (!reader) return Buffer.alloc(0);
    const chunks: Buffer[] = [];
    let size = 0;
    try {
      while (true) {
        const item = await reader.read();
        if (item.done) break;
        size += item.value.length;
        if (size > maxBytes) {
          await reader.cancel();
          throw new ServiceUnavailableException('Private file exceeds its size limit');
        }
        chunks.push(Buffer.from(item.value));
      }
      return Buffer.concat(chunks, size);
    } finally { reader.releaseLock(); }
  }

  private async requirePrivateBucket(): Promise<void> {
    const bytes = await this.providerRequest(`bucket/${this.config.bucket}`, { method: 'GET' }, 16384);
    const metadata: unknown = JSON.parse(bytes.toString('utf8'));
    if (!metadata || typeof metadata !== 'object' || !('public' in metadata) || metadata.public !== false
      || !('id' in metadata) || metadata.id !== this.config.bucket) throw new ServiceUnavailableException('Storage bucket must be private');
  }

  async put(projectId: string, assetId: string, bytes: Buffer): Promise<{ bucket: string; objectKey: string }> {
    if (!uuid.test(projectId) || !uuid.test(assetId) || !bytes.length || bytes.length > STORAGE_MAX_BYTES) {
      throw new ServiceUnavailableException('Private file integrity check failed');
    }
    const bucket = this.config.bucket;
    const objectKey = `${projectId}/originals/${assetId}`;
    this.validate(bucket, objectKey);
    let createdPath: string | undefined;
    try {
      if (this.config.driver === 'filesystem') {
        const path = await this.localPath(objectKey);
        const file = await open(path, 'wx', 0o600);
        createdPath = path;
        try { await file.writeFile(bytes); await file.sync(); } finally { await file.close(); }
      } else {
        await this.requirePrivateBucket();
        await this.providerRequest(`object/${bucket}/${objectKey}`, { method: 'POST', headers: {
          'Content-Type': 'application/octet-stream', 'x-upsert': 'false', 'Cache-Control': 'no-store',
        }, body: new Uint8Array(bytes) }, 16384);
      }
      return { bucket, objectKey };
    } catch {
      if (createdPath) {
        try { await unlink(createdPath); }
        catch { throw new ServiceUnavailableException('Private original staging failed; cleanup is required'); }
      }
      throw new ServiceUnavailableException('Unable to store the private original');
    }
  }

  async read(bucket: string, objectKey: string, expectedSha256: string): Promise<Buffer> {
    this.validate(bucket, objectKey);
    if (!/^[a-f0-9]{64}$/.test(expectedSha256)) throw new ServiceUnavailableException('Private file integrity check failed');
    try {
      let bytes: Buffer;
      if (this.config.driver === 'filesystem') {
        const path = await this.localPath(objectKey);
        const stat = await lstat(path);
        if (stat.size > STORAGE_MAX_BYTES) throw new Error('Size limit');
        bytes = await readFile(path);
      } else {
        await this.requirePrivateBucket();
        bytes = await this.providerRequest(`object/authenticated/${bucket}/${objectKey}`, { method: 'GET' }, STORAGE_MAX_BYTES);
      }
      if (bytes.length > STORAGE_MAX_BYTES || createHash('sha256').update(bytes).digest('hex') !== expectedSha256) throw new Error('Integrity');
      return bytes;
    } catch { throw new ServiceUnavailableException('Unable to read the private original'); }
  }

  // Called only for this request's unreferenced staged object, or isolated TEST cleanup.
  async remove(bucket: string, objectKey: string): Promise<void> {
    this.validate(bucket, objectKey);
    try {
      if (this.config.driver === 'filesystem') await unlink(await this.localPath(objectKey));
      else {
        await this.requirePrivateBucket();
        await this.providerRequest(`object/${bucket}`, { method: 'DELETE', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ prefixes: [objectKey] }) }, 16384);
      }
    } catch { throw new ServiceUnavailableException('Private staged-file cleanup failed'); }
  }
}
