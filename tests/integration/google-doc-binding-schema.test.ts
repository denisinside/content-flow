import { randomBytes, randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { databasePoolOptions, loadRuntimeConfig } from '@contextflow/backend';

describe('Google Docs bindings and snapshots on isolated TEST PostgreSQL', () => {
  const config = loadRuntimeConfig();
  const pool = new Pool(databasePoolOptions(config));
  const scope = 'https://www.googleapis.com/auth/drive.file';
  const remoteRevision = `synthetic-revision-${randomUUID()}`;

  beforeAll(async () => {
    const result = await pool.query<{ current_user: string }>('SELECT current_user');
    expect(result.rows[0]?.current_user).toBe('cf_runtime');
  });

  afterAll(async () => { await pool.end(); });

  async function fixture(client: import('pg').PoolClient) {
    const owner = randomUUID(), otherUser = randomUUID(), workspace = randomUUID();
    const project = randomUUID(), otherProject = randomUUID();
    const connection = randomUUID(), otherConnection = randomUUID();
    await client.query('INSERT INTO contextflow."UserProfile" ("id") VALUES ($1), ($2)', [owner, otherUser]);
    await client.query(`INSERT INTO contextflow."Workspace" ("id", "name", "ownerId") VALUES ($1, 'Binding fixture', $2)`, [workspace, owner]);
    await client.query(`INSERT INTO contextflow."WorkspaceMember" ("workspaceId", "userId") VALUES ($1, $2)`, [workspace, owner]);
    await client.query(`INSERT INTO contextflow."WorkspaceStyleRevision" ("workspaceId", "revision", "createdBy") VALUES ($1, 1, $2)`, [workspace, owner]);
    await client.query(
      `INSERT INTO contextflow."Project" ("id", "workspaceId", "topic", "formats", "createdBy")
       VALUES ($1, $3, 'Synthetic binding project', ARRAY['ARTICLE']::contextflow."ProjectFormat"[], $2),
              ($4, $3, 'Second synthetic binding project', ARRAY['ARTICLE']::contextflow."ProjectFormat"[], $2)`,
      [project, owner, workspace, otherProject]
    );
    const makeConnection = (id: string, userId: string, permissionId: string) => client.query(
      `INSERT INTO contextflow."GoogleDriveConnection"
        ("id", "userId", "googlePermissionId", "encryptedTokens", "tokenKeyVersion", "grantedScope", "accessExpiresAt", "refreshExpiresAt")
       VALUES ($1, $2, $3, $4, 1, $5, '2026-10-11T13:00:00Z', '2026-11-11T12:00:00Z')`,
      [id, userId, permissionId, `synthetic-encrypted-token-${randomBytes(32).toString('hex')}`, scope]
    );
    await makeConnection(connection, owner, `permission-${randomUUID()}`);
    await makeConnection(otherConnection, otherUser, `permission-${randomUUID()}`);
    return { owner, otherUser, project, otherProject, connection, otherConnection };
  }

  async function reject(client: import('pg').PoolClient, code: string, query: () => Promise<unknown>) {
    await client.query('SAVEPOINT google_doc_constraint');
    try { await expect(query()).rejects.toMatchObject({ code }); }
    finally {
      await client.query('ROLLBACK TO SAVEPOINT google_doc_constraint');
      await client.query('RELEASE SAVEPOINT google_doc_constraint');
    }
  }

  it('enforces one active binding per project and remote tab, then allows one-way closure', async () => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const data = await fixture(client);
      const bindingId = randomUUID(), sharedDocument = `doc-${randomUUID()}`, tabId = `tab-${randomUUID()}`;
      const insertBinding = (id: string, projectId: string, connectionId: string, connectionUserId: string, documentId: string, tab: string) => client.query(
        `INSERT INTO contextflow."GoogleDocBinding"
          ("id", "projectId", "connectionId", "connectionUserId", "documentId", "tabId", "createdBy")
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [id, projectId, connectionId, connectionUserId, documentId, tab, data.owner]
      );
      await insertBinding(bindingId, data.project, data.connection, data.owner, sharedDocument, tabId);
      await reject(client, '23505', () => insertBinding(randomUUID(), data.project, data.connection, data.owner, `doc-${randomUUID()}`, `tab-${randomUUID()}`));
      await reject(client, '23505', () => insertBinding(randomUUID(), data.otherProject, data.otherConnection, data.otherUser, sharedDocument, tabId));
      await reject(client, '23514', () => client.query(`UPDATE contextflow."GoogleDocBinding" SET "documentId" = 'changed' WHERE "id" = $1`, [bindingId]));

      const endedAt = new Date(Date.now() + 60_000).toISOString();
      await client.query(`UPDATE contextflow."GoogleDocBinding" SET "endedAt" = $2 WHERE "id" = $1`, [bindingId, endedAt]);
      const replayedEndAt = new Date(Date.parse(endedAt) + 60_000).toISOString();
      await reject(client, '23514', () => client.query(`UPDATE contextflow."GoogleDocBinding" SET "endedAt" = $2 WHERE "id" = $1`, [bindingId, replayedEndAt]));
      await insertBinding(randomUUID(), data.project, data.connection, data.owner, `doc-${randomUUID()}`, `tab-${randomUUID()}`);
      await insertBinding(randomUUID(), data.otherProject, data.otherConnection, data.otherUser, sharedDocument, tabId);
      await client.query('ROLLBACK');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally { client.release(); }
  });

  it('keeps connection, project, snapshot and bind-command ancestry and history immutable', async () => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const data = await fixture(client);
      const bindingId = randomUUID(), documentId = `doc-${randomUUID()}`, tabId = `tab-${randomUUID()}`;
      await client.query(
        `INSERT INTO contextflow."GoogleDocBinding"
          ("id", "projectId", "connectionId", "connectionUserId", "documentId", "tabId", "createdBy")
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [bindingId, data.project, data.connection, data.owner, documentId, tabId, data.owner]
      );
      await reject(client, '23503', () => client.query(
        `INSERT INTO contextflow."GoogleDocBinding"
          ("id", "projectId", "connectionId", "connectionUserId", "documentId", "tabId", "createdBy")
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [randomUUID(), data.otherProject, data.otherConnection, data.owner, `doc-${randomUUID()}`, `tab-${randomUUID()}`, data.owner]
      ));

      const snapshotId = randomUUID();
      const snapshot = (projectId: string, id = snapshotId) => client.query(
        `INSERT INTO contextflow."GoogleDocSnapshot"
          ("id", "projectId", "bindingId", "remoteRevision", "payload", "converted", "contentHash", "capturedBy")
         VALUES ($1, $2, $3, $4, '{"synthetic":true}'::jsonb, '{"converted":true}'::jsonb, repeat('a', 64), $5)`,
        [id, projectId, bindingId, remoteRevision, data.owner]
      );
      await snapshot(data.project);
      await reject(client, '23503', () => snapshot(data.otherProject, randomUUID()));
      await reject(client, '42501', () => client.query(`UPDATE contextflow."GoogleDocSnapshot" SET "payload" = '{"changed":true}' WHERE "id" = $1`, [snapshotId]));
      await reject(client, '42501', () => client.query(`DELETE FROM contextflow."GoogleDocSnapshot" WHERE "id" = $1`, [snapshotId]));

      const commandKey = randomUUID(), payloadHash = 'b'.repeat(64);
      const command = (projectId: string) => client.query(
        `INSERT INTO contextflow."GoogleDocBindCommand" ("projectId", "createdBy", "commandKey", "payloadHash", "bindingId")
         VALUES ($1, $2, $3, $4, $5)`,
        [projectId, data.owner, commandKey, payloadHash, bindingId]
      );
      await command(data.project);
      await reject(client, '23505', () => command(data.project));
      await reject(client, '23503', () => command(data.otherProject));
      await reject(client, '42501', () => client.query(`UPDATE contextflow."GoogleDocBindCommand" SET "payloadHash" = repeat('c', 64) WHERE "commandKey" = $1`, [commandKey]));
      await reject(client, '42501', () => client.query(`DELETE FROM contextflow."GoogleDocBindCommand" WHERE "commandKey" = $1`, [commandKey]));
      await client.query('ROLLBACK');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally { client.release(); }
  });
});
