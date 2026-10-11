import { randomBytes, randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { databasePoolOptions, loadRuntimeConfig } from '@contextflow/backend';

describe('Google OAuth schema guards on the isolated TEST runtime role', () => {
  const config = loadRuntimeConfig();
  const pool = new Pool(databasePoolOptions(config));
  const userId = randomUUID();
  const otherUserId = randomUUID();
  const sessionId = randomUUID();
  const otherSessionId = randomUUID();
  const attemptId = randomUUID();
  const connectionId = randomUUID();
  const permissionId = `synthetic-${randomUUID()}`;
  const timestamp = '2026-10-11T12:00:00.000Z';
  const scope = 'https://www.googleapis.com/auth/drive.file';

  beforeAll(async () => {
    const result = await pool.query<{ current_user: string }>('SELECT current_user');
    expect(result.rows[0]?.current_user).toBe('cf_runtime');
  });

  afterAll(async () => { await pool.end(); });

  it('binds OAuth attempts to the same session user, limits TTL to ten minutes, and consumes the verifier once', async () => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('INSERT INTO contextflow."UserProfile" ("id") VALUES ($1), ($2)', [userId, otherUserId]);
      await client.query(
        `INSERT INTO contextflow."AppSession"
          ("id", "cookieDigest", "userId", "encryptedProviderTokens", "tokenKeyVersion", "providerTokenExpiresAt", "expiresAt")
         VALUES ($1, $2, $3, $4, 1, $5, $6), ($7, $8, $9, $4, 1, $5, $6)`,
        [sessionId, randomBytes(32).toString('hex'), userId, 'synthetic-session-ciphertext', timestamp, '2026-10-12T12:00:00.000Z', otherSessionId, randomBytes(32).toString('hex'), otherUserId]
      );
      const createAttempt = async (id: string, owner: string, session: string, expiresAt: string) => client.query(
        `INSERT INTO contextflow."GoogleOAuthAttempt"
          ("id", "userId", "appSessionId", "stateDigest", "encryptedVerifier", "tokenKeyVersion", "createdAt", "expiresAt")
         VALUES ($1, $2, $3, $4, $5, 1, $6, $7)`,
        [id, owner, session, randomBytes(32).toString('hex'), `encrypted-verifier-${randomUUID()}-long-enough`, timestamp, expiresAt]
      );
      const reject = async (code: string, query: () => Promise<unknown>) => {
        await client.query('SAVEPOINT oauth_constraint');
        try { await expect(query()).rejects.toMatchObject({ code }); }
        finally {
          await client.query('ROLLBACK TO SAVEPOINT oauth_constraint');
          await client.query('RELEASE SAVEPOINT oauth_constraint');
        }
      };

      await createAttempt(attemptId, userId, sessionId, '2026-10-11T12:10:00.000Z');
      await reject('23503', () => createAttempt(randomUUID(), userId, otherSessionId, '2026-10-11T12:05:00.000Z'));
      await reject('23514', () => createAttempt(randomUUID(), userId, sessionId, '2026-10-11T12:10:00.001Z'));

      await reject('23514', () => client.query(
        `UPDATE contextflow."GoogleOAuthAttempt" SET "stateDigest" = $2 WHERE "id" = $1`,
        [attemptId, randomBytes(32).toString('hex')]
      ));

      const consumedAt = '2026-10-11T12:01:00.000Z';
      await client.query(
        `UPDATE contextflow."GoogleOAuthAttempt" SET "consumedAt" = $2, "encryptedVerifier" = NULL WHERE "id" = $1`,
        [attemptId, consumedAt]
      );
      expect((await client.query<{ encryptedVerifier: string | null; consumedAt: Date }>(
        `SELECT "encryptedVerifier", "consumedAt" FROM contextflow."GoogleOAuthAttempt" WHERE "id" = $1`, [attemptId]
      )).rows[0]).toMatchObject({ encryptedVerifier: null, consumedAt: new Date(consumedAt) });
      await reject('23514', () => client.query(
        `UPDATE contextflow."GoogleOAuthAttempt" SET "consumedAt" = $2 WHERE "id" = $1`,
        [attemptId, '2026-10-11T12:02:00.000Z']
      ));
      await client.query('ROLLBACK');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally { client.release(); }
  });

  it('keeps Drive connections personal, scope-limited, generation-bound, revocable, and non-deletable by runtime', async () => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('INSERT INTO contextflow."UserProfile" ("id") VALUES ($1), ($2)', [userId, otherUserId]);
      const insertConnection = async (id: string, owner: string, googlePermissionId: string, grantedScope = scope) => client.query(
        `INSERT INTO contextflow."GoogleDriveConnection"
          ("id", "userId", "googlePermissionId", "encryptedTokens", "tokenKeyVersion", "grantedScope", "accessExpiresAt", "refreshExpiresAt", "connectedAt", "updatedAt")
         VALUES ($1, $2, $3, $4, 1, $5, $6, $7, $8, $8)`,
        [id, owner, googlePermissionId, `encrypted-token-payload-${randomUUID()}-long-enough`, grantedScope, '2026-10-11T13:00:00.000Z', '2026-11-11T12:00:00.000Z', timestamp]
      );
      const reject = async (code: string, query: () => Promise<unknown>) => {
        await client.query('SAVEPOINT connection_constraint');
        try { await expect(query()).rejects.toMatchObject({ code }); }
        finally {
          await client.query('ROLLBACK TO SAVEPOINT connection_constraint');
          await client.query('RELEASE SAVEPOINT connection_constraint');
        }
      };

      await insertConnection(connectionId, userId, permissionId);
      await reject('23505', () => insertConnection(randomUUID(), userId, permissionId));
      await reject('23514', () => insertConnection(randomUUID(), userId, `synthetic-${randomUUID()}`, 'https://www.googleapis.com/auth/drive'));

      await reject('23514', () => client.query(
        `UPDATE contextflow."GoogleDriveConnection" SET "displayName" = 'changed without generation' WHERE "id" = $1`, [connectionId]
      ));
      await reject('23514', () => client.query(
        `UPDATE contextflow."GoogleDriveConnection" SET "generation" = 2, "userId" = $2 WHERE "id" = $1`, [connectionId, otherUserId]
      ));

      await client.query(
        `UPDATE contextflow."GoogleDriveConnection"
         SET "generation" = 2, "revokedAt" = $2, "encryptedTokens" = NULL, "updatedAt" = $2 WHERE "id" = $1`,
        [connectionId, '2026-10-11T12:30:00.000Z']
      );
      expect((await client.query<{ encryptedTokens: string | null; generation: number; revokedAt: Date }>(
        `SELECT "encryptedTokens", "generation", "revokedAt" FROM contextflow."GoogleDriveConnection" WHERE "id" = $1`, [connectionId]
      )).rows[0]).toMatchObject({ encryptedTokens: null, generation: 2, revokedAt: new Date('2026-10-11T12:30:00.000Z') });

      await reject('23514', () => client.query(
        `UPDATE contextflow."GoogleDriveConnection" SET "generation" = 3, "encryptedTokens" = 'ciphertext-added-after-revoke', "updatedAt" = $2 WHERE "id" = $1`,
        [connectionId, '2026-10-11T12:31:00.000Z']
      ));
      await reject('42501', () => client.query(`DELETE FROM contextflow."GoogleDriveConnection" WHERE "id" = $1`, [connectionId]));
      await reject('42501', () => client.query(`DELETE FROM contextflow."GoogleOAuthAttempt" WHERE "id" = $1`, [attemptId]));

      const privileges = await client.query<{ can_delete_attempt: boolean; can_delete_connection: boolean }>(
        `SELECT has_table_privilege(current_user, 'contextflow."GoogleOAuthAttempt"', 'DELETE') AS can_delete_attempt,
                has_table_privilege(current_user, 'contextflow."GoogleDriveConnection"', 'DELETE') AS can_delete_connection`
      );
      expect(privileges.rows[0]).toEqual({ can_delete_attempt: false, can_delete_connection: false });
      await client.query('ROLLBACK');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally { client.release(); }
  });
});
