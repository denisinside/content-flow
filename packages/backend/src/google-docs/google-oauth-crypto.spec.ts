import { randomBytes, randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { GoogleOAuthCrypto } from './google-oauth-crypto.js';

describe('Google OAuth credential isolation', () => {
  const userId = randomUUID(), rowId = randomUUID();
  const tokens = { accessToken: 'SYNTHETIC_ACCESS', refreshToken: 'SYNTHETIC_REFRESH', expiresAtMs: 1_900_000_000_000 };
  const oldKey = randomBytes(32), newKey = randomBytes(32);
  const crypto = new GoogleOAuthCrypto({ currentVersion: 1, keys: new Map([[1, oldKey]]) });

  it('authenticates owner, row, purpose, key version and ciphertext without exposing credentials', () => {
    const encrypted = crypto.encryptTokens(tokens, userId, rowId);
    expect(crypto.decryptTokens(encrypted, userId, rowId)).toEqual(tokens);
    expect(encrypted.ciphertext).not.toContain(tokens.accessToken);
    expect(crypto.encryptTokens(tokens, userId, rowId).ciphertext).not.toBe(encrypted.ciphertext);
    for (const read of [
      () => crypto.decryptTokens(encrypted, randomUUID(), rowId),
      () => crypto.decryptTokens(encrypted, userId, randomUUID()),
      () => crypto.decryptVerifier(encrypted, userId, rowId),
      () => crypto.decryptTokens({ ...encrypted, keyVersion: 2 }, userId, rowId),
      () => crypto.decryptTokens({ ...encrypted, ciphertext: 'A' + encrypted.ciphertext.slice(1, -4) + 'AAAA' }, userId, rowId),
    ]) expect(read).toThrow('Google OAuth credentials unavailable');
  });

  it('reads old keys during rotation, writes only the current key and isolates PKCE', () => {
    const old = crypto.encryptTokens(tokens, userId, rowId);
    const rotated = new GoogleOAuthCrypto({ currentVersion: 2, keys: new Map([[1, oldKey], [2, newKey]]) });
    expect(rotated.decryptTokens(old, userId, rowId)).toEqual(tokens);
    expect(rotated.encryptTokens(tokens, userId, rowId).keyVersion).toBe(2);
    const verifier = 'v'.repeat(43);
    const encrypted = rotated.encryptVerifier(verifier, userId, rowId);
    expect(rotated.decryptVerifier(encrypted, userId, rowId)).toBe(verifier);
    expect(() => rotated.decryptTokens(encrypted, userId, rowId)).toThrow('credentials unavailable');
    expect(() => new GoogleOAuthCrypto({ currentVersion: 2, keys: new Map([[2, newKey]]) }).decryptTokens(old, userId, rowId)).toThrow('credentials unavailable');
  });

  it('fails closed on invalid keys, tokens and context', () => {
    expect(() => new GoogleOAuthCrypto({ currentVersion: 1, keys: new Map([[1, Buffer.alloc(16)]]) })).toThrow('encryption unavailable');
    expect(() => crypto.encryptTokens({ ...tokens, refreshToken: '' }, userId, rowId)).toThrow('Invalid Google OAuth credentials');
    expect(() => crypto.encryptTokens(tokens, 'invalid', rowId)).toThrow('Invalid Google OAuth encryption context');
    expect(() => crypto.encryptVerifier('short', userId, rowId)).toThrow('Invalid Google OAuth verifier');
  });
});
