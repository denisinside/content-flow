import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';
import { z } from 'zod';

const tokenSchema = z.object({
  accessToken: z.string().min(1).max(8192),
  refreshToken: z.string().min(1).max(8192),
  expiresAtMs: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
}).strict();
const verifierSchema = z.object({ verifier: z.string().regex(/^[A-Za-z0-9._~-]{43,128}$/u) }).strict();
const idSchema = z.uuid();
export type StoredGoogleOAuthTokens = z.infer<typeof tokenSchema>;
export interface GoogleOAuthCiphertext { ciphertext: string; keyVersion: number }
export interface GoogleOAuthKeyring { currentVersion: number; keys: ReadonlyMap<number, Buffer> }

/** Separate derived key and authenticated purpose/owner/row prevent cross-session token substitution. */
export class GoogleOAuthCrypto {
  private readonly keys: ReadonlyMap<number, Buffer>;
  private readonly currentVersion: number;

  constructor(keyring: GoogleOAuthKeyring) {
    if (!Number.isSafeInteger(keyring.currentVersion) || keyring.currentVersion < 1 || !keyring.keys.has(keyring.currentVersion)
      || [...keyring.keys].some(([version, key]) => !Number.isSafeInteger(version) || version < 1 || key.length !== 32)) {
      throw new Error('Google OAuth encryption unavailable');
    }
    this.currentVersion = keyring.currentVersion;
    this.keys = new Map([...keyring.keys].map(([version, key]) => [version, Buffer.from(hkdfSync('sha256', key, Buffer.alloc(0), 'contextflow-google-oauth-v1', 32))]));
  }

  get keyVersion(): number { return this.currentVersion; }

  encryptTokens(tokens: StoredGoogleOAuthTokens, userId: string, connectionId: string): GoogleOAuthCiphertext {
    const safe = tokenSchema.safeParse(tokens);
    if (!safe.success) throw new Error('Invalid Google OAuth credentials');
    return this.encrypt(safe.data, 'connection', userId, connectionId);
  }

  decryptTokens(value: GoogleOAuthCiphertext, userId: string, connectionId: string): StoredGoogleOAuthTokens {
    const safe = tokenSchema.safeParse(this.decrypt(value, 'connection', userId, connectionId));
    if (!safe.success) throw new Error('Invalid Google OAuth credentials');
    return safe.data;
  }

  encryptVerifier(verifier: string, userId: string, attemptId: string): GoogleOAuthCiphertext {
    const safe = verifierSchema.safeParse({ verifier });
    if (!safe.success) throw new Error('Invalid Google OAuth verifier');
    return this.encrypt(safe.data, 'attempt', userId, attemptId);
  }

  decryptVerifier(value: GoogleOAuthCiphertext, userId: string, attemptId: string): string {
    const safe = verifierSchema.safeParse(this.decrypt(value, 'attempt', userId, attemptId));
    if (!safe.success) throw new Error('Invalid Google OAuth verifier');
    return safe.data.verifier;
  }

  private aad(purpose: string, userId: string, rowId: string, keyVersion: number): Buffer {
    if (!idSchema.safeParse(userId).success || !idSchema.safeParse(rowId).success) throw new Error('Invalid Google OAuth encryption context');
    return Buffer.from(`contextflow:google-oauth:v1:${purpose}:${userId}:${rowId}:${keyVersion}`, 'utf8');
  }

  private encrypt(value: unknown, purpose: string, userId: string, rowId: string): GoogleOAuthCiphertext {
    const keyVersion = this.currentVersion;
    const key = this.keys.get(keyVersion)!;
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    cipher.setAAD(this.aad(purpose, userId, rowId, keyVersion));
    const bytes = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
    return { keyVersion, ciphertext: Buffer.concat([iv, cipher.getAuthTag(), bytes]).toString('base64') };
  }

  private decrypt(value: GoogleOAuthCiphertext, purpose: string, userId: string, rowId: string): unknown {
    try {
      if (!Number.isSafeInteger(value.keyVersion) || value.keyVersion < 1 || typeof value.ciphertext !== 'string'
        || value.ciphertext.length > 32_768 || !/^[A-Za-z0-9+/]+={0,2}$/u.test(value.ciphertext)) throw new Error();
      const key = this.keys.get(value.keyVersion);
      const bytes = Buffer.from(value.ciphertext, 'base64');
      if (!key || bytes.length < 29 || bytes.toString('base64') !== value.ciphertext) throw new Error();
      const decipher = createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12));
      decipher.setAAD(this.aad(purpose, userId, rowId, value.keyVersion));
      decipher.setAuthTag(bytes.subarray(12, 28));
      return JSON.parse(Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString('utf8')) as unknown;
    } catch { throw new Error('Google OAuth credentials unavailable'); }
  }
}
