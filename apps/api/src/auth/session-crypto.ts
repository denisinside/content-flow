import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import type { AuthConfig } from './auth-config.js';

export interface ProviderTokens { accessToken: string; refreshToken: string }
export const opaqueToken = (): string => randomBytes(32).toString('base64url');
export const tokenDigest = (token: string): string => createHash('sha256').update(token).digest('hex');
export const validOpaqueToken = (token: string | undefined): token is string => !!token && /^[A-Za-z0-9_-]{43}$/.test(token);

export class SessionCrypto {
  constructor(private readonly config: AuthConfig) {}

  encrypt(tokens: ProviderTokens, id: string, userId: string): { ciphertext: string; version: number } {
    const version = this.config.currentKeyVersion;
    const encryptionKey = this.config.encryptionKeys.get(version);
    if (!encryptionKey) throw new Error('Session encryption unavailable');
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', encryptionKey, iv);
    cipher.setAAD(Buffer.from(`${id}:${userId}:${version}`));
    const encrypted = Buffer.concat([cipher.update(JSON.stringify(tokens), 'utf8'), cipher.final()]);
    return { ciphertext: Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString('base64'), version };
  }

  decrypt(ciphertext: string, version: number, id: string, userId: string): ProviderTokens {
    const encryptionKey = this.config.encryptionKeys.get(version);
    if (!encryptionKey) throw new Error('Session encryption unavailable');
    const bytes = Buffer.from(ciphertext, 'base64');
    if (bytes.length < 29) throw new Error('Invalid session encryption');
    const decipher = createDecipheriv('aes-256-gcm', encryptionKey, bytes.subarray(0, 12));
    decipher.setAAD(Buffer.from(`${id}:${userId}:${version}`));
    decipher.setAuthTag(bytes.subarray(12, 28));
    const value: unknown = JSON.parse(Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString('utf8'));
    if (!value || typeof value !== 'object' || !('accessToken' in value) || !('refreshToken' in value)
      || typeof value.accessToken !== 'string' || typeof value.refreshToken !== 'string') throw new Error('Invalid session encryption');
    return { accessToken: value.accessToken, refreshToken: value.refreshToken };
  }
}
