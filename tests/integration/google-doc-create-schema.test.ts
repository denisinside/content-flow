import { randomBytes, randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { databasePoolOptions, loadRuntimeConfig } from '@contextflow/backend';

describe('Google Docs create command durability on isolated TEST PostgreSQL', () => {
  const pool = new Pool(databasePoolOptions(loadRuntimeConfig()));
  const scope = 'https://www.googleapis.com/auth/drive.file';

  beforeAll(async () => {
    const result = await pool.query<{ current_user: string }>('SELECT current_user');
    expect(result.rows[0]?.current_user).toBe('cf_runtime');
  });

  afterAll(async () => { await pool.end(); });

  async function fixture(client: import('pg').PoolClient) {
    const user = randomUUID(), secondUser = randomUUID(), workspace = randomUUID();
    const project = randomUUID(), secondProject = randomUUID();
    const connection = randomUUID(), secondConnection = randomUUID();
    await client.query('INSERT INTO contextflow."UserProfile" ("id") VALUES ($1), ($2)', [user, secondUser]);
    await client.query(`INSERT INTO contextflow."Workspace" ("id", "name", "ownerId") VALUES ($1, 'Create command fixture', $2)`, [workspace, user]);
    await client.query(`INSERT INTO contextflow."WorkspaceMember" ("workspaceId", "userId") VALUES ($1, $2)`, [workspace, user]);
    await client.query(`INSERT INTO contextflow."WorkspaceStyleRevision" ("workspaceId", "revision", "createdBy") VALUES ($1, 1, $2)`, [workspace, user]);
    await client.query(
      `INSERT INTO contextflow."Project" ("id", "workspaceId", "topic", "formats", "createdBy")
       VALUES ($1, $3, 'Synthetic create project', ARRAY['ARTICLE']::contextflow."ProjectFormat"[], $2),
              ($4, $3, 'Second synthetic create project', ARRAY['ARTICLE']::contextflow."ProjectFormat"[], $2)`,
      [project, user, workspace, secondProject]
    );
    const insertConnection = (id: string, owner: string) => client.query(
      `INSERT INTO contextflow."GoogleDriveConnection"
        ("id", "userId", "googlePermissionId", "encryptedTokens", "tokenKeyVersion", "grantedScope", "accessExpiresAt", "refreshExpiresAt")
       VALUES ($1, $2, $3, $4, 1, $5, '2026-10-11T13:00:00Z', '2026-11-11T12:00:00Z')`,
      [id, owner, `permission-${randomUUID()}`, `synthetic-encrypted-token-${randomBytes(32).toString('hex')}`, scope]
    );
    await insertConnection(connection, user);
    await insertConnection(secondConnection, secondUser);
    return { user, secondUser, project, secondProject, connection, secondConnection };
  }

  async function reject(client: import('pg').PoolClient, code: string, query: () => Promise<unknown>) {
    await client.query('SAVEPOINT google_doc_create_constraint');
    try { await expect(query()).rejects.toMatchObject({ code }); }
    finally {
      await client.query('ROLLBACK TO SAVEPOINT google_doc_create_constraint');
      await client.query('RELEASE SAVEPOINT google_doc_create_constraint');
    }
  }

  const insertCommand = (client: import('pg').PoolClient, data: Awaited<ReturnType<typeof fixture>>, fields: {
    id?: string; projectId?: string; userId?: string; connectionId?: string; commandKey?: string; title?: string;
  } = {}) => client.query(
    `INSERT INTO contextflow."GoogleDocCreateCommand"
      ("id", "projectId", "userId", "connectionId", "commandKey", "payloadHash", "title")
     VALUES ($1, $2, $3, $4, $5, repeat('a', 64), $6)`,
    [fields.id ?? randomUUID(), fields.projectId ?? data.project, fields.userId ?? data.user, fields.connectionId ?? data.connection, fields.commandKey ?? randomUUID(), fields.title ?? 'Synthetic Google document']
  );

  it('limits each project to one unresolved remote create and records only allowed outcomes', async () => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const data = await fixture(client), commandId = randomUUID(), commandKey = randomUUID();
      await insertCommand(client, data, { id: commandId, commandKey });
      await reject(client, '23505', () => insertCommand(client, data, { userId: data.secondUser, connectionId: data.secondConnection }));

      let updatedAt = new Date(Date.now() + 60_000).toISOString();
      await client.query(`UPDATE contextflow."GoogleDocCreateCommand" SET "state" = 'UNKNOWN', "updatedAt" = $2 WHERE "id" = $1`, [commandId, updatedAt]);
      await reject(client, '23505', () => insertCommand(client, data, { userId: data.secondUser, connectionId: data.secondConnection }));
      updatedAt = new Date(Date.parse(updatedAt) + 60_000).toISOString();
      await client.query(`UPDATE contextflow."GoogleDocCreateCommand" SET "state" = 'UNKNOWN', "updatedAt" = $2 WHERE "id" = $1`, [commandId, updatedAt]);
      await reject(client, '23514', () => client.query(`UPDATE contextflow."GoogleDocCreateCommand" SET "state" = 'FAILED', "updatedAt" = $2 WHERE "id" = $1`, [commandId, new Date(Date.parse(updatedAt) + 60_000).toISOString()]));
      await reject(client, '23514', () => client.query(`UPDATE contextflow."GoogleDocCreateCommand" SET "state" = 'CREATED', "documentId" = NULL, "updatedAt" = $2 WHERE "id" = $1`, [commandId, new Date(Date.parse(updatedAt) + 60_000).toISOString()]));

      const documentId = 'd'.repeat(129);
      updatedAt = new Date(Date.parse(updatedAt) + 60_000).toISOString();
      await client.query(`UPDATE contextflow."GoogleDocCreateCommand" SET "state" = 'CREATED', "documentId" = $2, "updatedAt" = $3 WHERE "id" = $1`, [commandId, documentId, updatedAt]);
      expect((await client.query<{ documentId: string }>(`SELECT "documentId" FROM contextflow."GoogleDocCreateCommand" WHERE "id" = $1`, [commandId])).rows[0]?.documentId).toBe(documentId);
      await reject(client, '23514', () => client.query(`UPDATE contextflow."GoogleDocCreateCommand" SET "state" = 'FAILED', "documentId" = NULL, "updatedAt" = $2 WHERE "id" = $1`, [commandId, new Date(Date.parse(updatedAt) + 60_000).toISOString()]));

      const secondId = randomUUID();
      await insertCommand(client, data, { id: secondId, userId: data.secondUser, connectionId: data.secondConnection });
      updatedAt = new Date(Date.now() + 120_000).toISOString();
      await client.query(`UPDATE contextflow."GoogleDocCreateCommand" SET "state" = 'FAILED', "updatedAt" = $2 WHERE "id" = $1`, [secondId, updatedAt]);
      await reject(client, '23514', () => client.query(`UPDATE contextflow."GoogleDocCreateCommand" SET "state" = 'UNKNOWN', "updatedAt" = $2 WHERE "id" = $1`, [secondId, new Date(Date.parse(updatedAt) + 60_000).toISOString()]));
      await client.query('ROLLBACK');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally { client.release(); }
  });

  it('binds command to its personal connection and preserves request fields and replay history', async () => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const data = await fixture(client), commandId = randomUUID(), commandKey = randomUUID();
      await insertCommand(client, data, { id: commandId, commandKey });
      await reject(client, '23503', () => insertCommand(client, data, { projectId: data.secondProject, userId: data.secondUser, connectionId: data.connection }));
      await reject(client, '23505', () => insertCommand(client, data, { userId: data.user, commandKey }));
      await reject(client, '23514', () => client.query(
        `UPDATE contextflow."GoogleDocCreateCommand" SET "title" = 'mutated request', "updatedAt" = $2 WHERE "id" = $1`,
        [commandId, new Date(Date.now() + 60_000).toISOString()]
      ));
      await reject(client, '42501', () => client.query(`DELETE FROM contextflow."GoogleDocCreateCommand" WHERE "id" = $1`, [commandId]));
      const privileges = await client.query<{ can_delete: boolean; can_update: boolean }>(
        `SELECT has_table_privilege(current_user, 'contextflow."GoogleDocCreateCommand"', 'DELETE') AS can_delete,
                has_table_privilege(current_user, 'contextflow."GoogleDocCreateCommand"', 'UPDATE') AS can_update`
      );
      expect(privileges.rows[0]).toEqual({ can_delete: false, can_update: true });
      await client.query('ROLLBACK');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally { client.release(); }
  });
});
