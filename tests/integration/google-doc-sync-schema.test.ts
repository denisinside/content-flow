import { randomBytes, randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { databasePoolOptions, loadRuntimeConfig } from '@contextflow/backend';

describe('Google Docs synchronization schema on isolated TEST PostgreSQL', () => {
  const pool = new Pool(databasePoolOptions(loadRuntimeConfig()));
  const scope = 'https://www.googleapis.com/auth/drive.file';
  const now = () => new Date().toISOString();
  const later = (value: string, milliseconds = 60_000) => new Date(Date.parse(value) + milliseconds).toISOString();

  beforeAll(async () => {
    const result = await pool.query<{ current_user: string }>('SELECT current_user');
    expect(result.rows[0]?.current_user).toBe('cf_runtime');
  });

  afterAll(async () => { await pool.end(); });

  async function fixture(client: import('pg').PoolClient) {
    const user = randomUUID(), otherUser = randomUUID(), workspace = randomUUID();
    const project = randomUUID(), otherProject = randomUUID();
    const connection = randomUUID(), otherConnection = randomUUID();
    const session = randomUUID(), otherSession = randomUUID();
    const binding = randomUUID(), otherBinding = randomUUID();
    const snapshot = randomUUID(), otherSnapshot = randomUUID();
    const makeConnection = (id: string, owner: string) => client.query(
      `INSERT INTO contextflow."GoogleDriveConnection"
        ("id", "userId", "googlePermissionId", "encryptedTokens", "tokenKeyVersion", "grantedScope", "accessExpiresAt", "refreshExpiresAt")
       VALUES ($1, $2, $3, $4, 1, $5, $6, $7)`,
      [id, owner, `permission-${randomUUID()}`, `synthetic-token-${randomBytes(32).toString('hex')}`, scope, later(now(), 3_600_000), later(now(), 30 * 86_400_000)]
    );
    const makeSession = (id: string, owner: string) => client.query(
      `INSERT INTO contextflow."AppSession"
        ("id", "cookieDigest", "userId", "encryptedProviderTokens", "tokenKeyVersion", "providerTokenExpiresAt", "expiresAt")
       VALUES ($1, $2, $3, 'synthetic-session-ciphertext', 1, $4, $5)`,
      [id, randomBytes(32).toString('hex'), owner, later(now(), 3_600_000), later(now(), 86_400_000)]
    );
    await client.query('INSERT INTO contextflow."UserProfile" ("id") VALUES ($1), ($2)', [user, otherUser]);
    await client.query(`INSERT INTO contextflow."Workspace" ("id", "name", "ownerId") VALUES ($1, 'Sync fixture', $2)`, [workspace, user]);
    await client.query(`INSERT INTO contextflow."WorkspaceMember" ("workspaceId", "userId") VALUES ($1, $2)`, [workspace, user]);
    await client.query(`INSERT INTO contextflow."WorkspaceStyleRevision" ("workspaceId", "revision", "createdBy") VALUES ($1, 1, $2)`, [workspace, user]);
    await client.query(
      `INSERT INTO contextflow."Project" ("id", "workspaceId", "topic", "formats", "createdBy")
       VALUES ($1, $3, 'Synthetic sync project', ARRAY['ARTICLE']::contextflow."ProjectFormat"[], $2),
              ($4, $3, 'Second synthetic sync project', ARRAY['ARTICLE']::contextflow."ProjectFormat"[], $2)`,
      [project, user, workspace, otherProject]
    );
    await makeConnection(connection, user);
    await makeConnection(otherConnection, otherUser);
    await makeSession(session, user);
    await makeSession(otherSession, otherUser);
    const makeBinding = (id: string, projectId: string, connectionId: string, connectionUserId: string) => client.query(
      `INSERT INTO contextflow."GoogleDocBinding"
        ("id", "projectId", "connectionId", "connectionUserId", "documentId", "tabId", "createdBy")
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [id, projectId, connectionId, connectionUserId, `synthetic-doc-${randomUUID()}`, `tab-${randomUUID()}`, user]
    );
    await makeBinding(binding, project, connection, user);
    await makeBinding(otherBinding, otherProject, otherConnection, otherUser);
    const makeSnapshot = (id: string, projectId: string, bindingId: string, capturedBy: string) => client.query(
      `INSERT INTO contextflow."GoogleDocSnapshot"
        ("id", "projectId", "bindingId", "remoteRevision", "payload", "converted", "contentHash", "capturedBy")
       VALUES ($1, $2, $3, $4, '{"synthetic":true}'::jsonb, '{"text":"fixture"}'::jsonb, repeat('a', 64), $5)`,
      [id, projectId, bindingId, `revision-${randomUUID()}`, capturedBy]
    );
    await makeSnapshot(snapshot, project, binding, user);
    await makeSnapshot(otherSnapshot, otherProject, otherBinding, otherUser);
    return { user, otherUser, project, otherProject, connection, otherConnection, session, otherSession, binding, otherBinding, snapshot, otherSnapshot };
  }

  async function reject(client: import('pg').PoolClient, code: string, query: () => Promise<unknown>) {
    await client.query('SAVEPOINT google_doc_sync_constraint');
    try { await expect(query()).rejects.toMatchObject({ code }); }
    finally {
      await client.query('ROLLBACK TO SAVEPOINT google_doc_sync_constraint');
      await client.query('RELEASE SAVEPOINT google_doc_sync_constraint');
    }
  }

  async function job(client: import('pg').PoolClient, projectId: string, requestedBy: string) {
    const id = randomUUID();
    await client.query(
      `INSERT INTO contextflow."Job"
        ("id", "projectId", "requestedBy", "operation", "contractVersion", "commandKey", "inputManifest", "inputHash", "deadlineAt")
       VALUES ($1, $2, $3, 'GOOGLE_DOCS_SYNC', 'google-doc-sync-v1', $4, '{}'::jsonb, repeat('a', 64), $5)`,
      [id, projectId, requestedBy, `sync-${randomUUID()}`, later(now(), 3_600_000)]
    );
    return id;
  }

  it('freezes sync previews and rejects cross-project, session, and personal-connection references', async () => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const data = await fixture(client), previewId = randomUUID();
      const insertPreview = (fields: { id?: string; connectionId?: string; sessionId?: string; projectId?: string; snapshotId?: string } = {}) => client.query(
        `INSERT INTO contextflow."GoogleDocSyncPreview"
          ("id", "projectId", "bindingId", "requestedBy", "connectionId", "sessionId", "noticeAcceptedAt", "remoteSnapshotId", "expectedArticleRevision", "kind", "frozenJson", "payloadHash", "createdAt", "expiresAt")
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 1, 'PUSH', '{"synthetic":true}'::jsonb, repeat('b', 64), $9, $10)`,
        [fields.id ?? randomUUID(), fields.projectId ?? data.project, data.binding, data.user, fields.connectionId ?? data.connection, fields.sessionId ?? data.session, new Date(Date.now() - 60_000).toISOString(), fields.snapshotId ?? data.snapshot, now(), later(now())]
      );
      await insertPreview({ id: previewId });
      await reject(client, '23503', () => insertPreview({ connectionId: data.otherConnection }));
      await reject(client, '23503', () => insertPreview({ sessionId: data.otherSession }));
      await reject(client, '23503', () => insertPreview({ snapshotId: data.otherSnapshot }));
      await reject(client, '42501', () => client.query(`UPDATE contextflow."GoogleDocSyncPreview" SET "payloadHash" = repeat('c', 64) WHERE "id" = $1`, [previewId]));
      await reject(client, '42501', () => client.query(`DELETE FROM contextflow."GoogleDocSyncPreview" WHERE "id" = $1`, [previewId]));
      const privileges = await client.query<{ can_delete: boolean; can_update: boolean }>(
        `SELECT has_table_privilege(current_user, 'contextflow."GoogleDocSyncPreview"', 'DELETE') AS can_delete,
                has_table_privilege(current_user, 'contextflow."GoogleDocSyncPreview"', 'UPDATE') AS can_update`
      );
      expect(privileges.rows[0]).toEqual({ can_delete: false, can_update: false });
      await client.query('ROLLBACK');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally { client.release(); }
  });

  it('enforces operation ancestry and forbids resubmission after an uncertain effect', async () => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const data = await fixture(client), jobId = await job(client, data.project, data.user), operationId = randomUUID();
      const insertOperation = (fields: { id?: string; jobId?: string; projectId?: string; bindingId?: string; connectionId?: string; sessionId?: string } = {}) => client.query(
        `INSERT INTO contextflow."GoogleDocSyncOperation"
          ("id", "projectId", "bindingId", "requestedBy", "connectionId", "sessionId", "noticeAcceptedAt", "commandKey", "kind", "state", "manifestJson", "payloadHash", "jobId")
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'PUSH', 'QUEUED', '{}'::jsonb, repeat('d', 64), $9)`,
        [fields.id ?? randomUUID(), fields.projectId ?? data.project, fields.bindingId ?? data.binding, data.user, fields.connectionId ?? data.connection, fields.sessionId ?? data.session, new Date(Date.now() - 60_000).toISOString(), randomUUID(), fields.jobId ?? jobId]
      );
      await insertOperation({ id: operationId });
      await reject(client, '23514', () => client.query(`UPDATE contextflow."GoogleDocSyncOperation" SET "state" = 'SUCCEEDED', "updatedAt" = $2 WHERE "id" = $1`, [operationId, later(now())]));
      await reject(client, '23503', async () => insertOperation({ connectionId: data.otherConnection, jobId: await job(client, data.project, data.user) }));
      await reject(client, '23503', async () => insertOperation({ sessionId: data.otherSession, jobId: await job(client, data.project, data.user) }));
      await reject(client, '23503', async () => insertOperation({ projectId: data.otherProject, bindingId: data.binding, jobId: await job(client, data.otherProject, data.user) }));

      let updatedAt = later(now());
      await client.query(`UPDATE contextflow."GoogleDocSyncOperation" SET "state" = 'SUBMITTED', "submittedAt" = $2, "updatedAt" = $3 WHERE "id" = $1`, [operationId, updatedAt, updatedAt]);
      updatedAt = later(updatedAt);
      await client.query(`UPDATE contextflow."GoogleDocSyncOperation" SET "state" = 'UNKNOWN', "outcomeJson" = '{"effect":"uncertain"}'::jsonb, "updatedAt" = $2 WHERE "id" = $1`, [operationId, updatedAt]);
      await reject(client, '23514', () => client.query(`UPDATE contextflow."GoogleDocSyncOperation" SET "state" = 'SUBMITTED', "updatedAt" = $2 WHERE "id" = $1`, [operationId, later(updatedAt)]));
      updatedAt = later(updatedAt);
      await client.query(`UPDATE contextflow."GoogleDocSyncOperation" SET "state" = 'PARTIAL', "updatedAt" = $2 WHERE "id" = $1`, [operationId, updatedAt]);
      await reject(client, '23514', () => client.query(`UPDATE contextflow."GoogleDocSyncOperation" SET "manifestJson" = '{"changed":true}'::jsonb, "updatedAt" = $2 WHERE "id" = $1`, [operationId, later(updatedAt)]));
      const privileges = await client.query<{ can_delete: boolean; can_update: boolean }>(
        `SELECT has_table_privilege(current_user, 'contextflow."GoogleDocSyncOperation"', 'DELETE') AS can_delete,
                has_table_privilege(current_user, 'contextflow."GoogleDocSyncOperation"', 'UPDATE') AS can_update`
      );
      expect(privileges.rows[0]).toEqual({ can_delete: false, can_update: true });
      await client.query('ROLLBACK');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally { client.release(); }
  });

  it('keeps sync state mutable but undeletable and records immutable annotation events by binding hash', async () => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const data = await fixture(client), threadId = randomUUID(), eventId = randomUUID();
      await client.query(
        `INSERT INTO contextflow."GoogleDocSyncState" ("bindingId", "projectId", "baselineSnapshotId", "status") VALUES ($1, $2, $3, 'CURRENT')`,
        [data.binding, data.project, data.snapshot]
      );
      await reject(client, '23503', () => client.query(
        `INSERT INTO contextflow."GoogleDocSyncState" ("bindingId", "projectId", "status") VALUES ($1, $2, 'CURRENT')`,
        [randomUUID(), data.otherProject]
      ));
      await client.query(`UPDATE contextflow."GoogleDocSyncState" SET "latestSnapshotId" = $2, "lastReadAt" = $3, "updatedAt" = $3 WHERE "bindingId" = $1`, [data.binding, data.snapshot, now()]);
      await reject(client, '42501', () => client.query(`DELETE FROM contextflow."GoogleDocSyncState" WHERE "bindingId" = $1`, [data.binding]));

      await client.query(
        `INSERT INTO contextflow."GoogleDocRemoteThread"
          ("id", "projectId", "bindingId", "remoteId", "kind", "status", "payloadJson", "quoteText", "rangesJson", "authorJson", "latestSnapshotId")
         VALUES ($1, $2, $3, $4, 'COMMENT', 'OPEN', '{"synthetic":true}'::jsonb, 'synthetic quote', '[]'::jsonb, '{}'::jsonb, $5)`,
        [threadId, data.project, data.binding, `remote-${randomUUID()}`, data.snapshot]
      );
      await client.query(
        `INSERT INTO contextflow."GoogleDocAnnotationEvent" ("id", "projectId", "bindingId", "threadId", "snapshotId", "eventHash", "payloadJson")
         VALUES ($1, $2, $3, $4, $5, repeat('e', 64), '{"event":"created"}'::jsonb)`,
        [eventId, data.project, data.binding, threadId, data.snapshot]
      );
      await reject(client, '23503', () => client.query(
        `INSERT INTO contextflow."GoogleDocAnnotationEvent" ("id", "projectId", "bindingId", "threadId", "snapshotId", "eventHash", "payloadJson")
         VALUES ($1, $2, $3, $4, $5, repeat('f', 64), '{}'::jsonb)`,
        [randomUUID(), data.otherProject, data.otherBinding, threadId, data.otherSnapshot]
      ));
      await reject(client, '23505', () => client.query(
        `INSERT INTO contextflow."GoogleDocAnnotationEvent" ("id", "projectId", "bindingId", "threadId", "snapshotId", "eventHash", "payloadJson")
         VALUES ($1, $2, $3, $4, $5, repeat('e', 64), '{"event":"duplicate"}'::jsonb)`,
        [randomUUID(), data.project, data.binding, threadId, data.snapshot]
      ));
      await reject(client, '42501', () => client.query(`UPDATE contextflow."GoogleDocAnnotationEvent" SET "payloadJson" = '{}'::jsonb WHERE "id" = $1`, [eventId]));
      const privileges = await client.query<{ event_delete: boolean; event_update: boolean; thread_delete: boolean; thread_update: boolean }>(
        `SELECT has_table_privilege(current_user, 'contextflow."GoogleDocAnnotationEvent"', 'DELETE') AS event_delete,
                has_table_privilege(current_user, 'contextflow."GoogleDocAnnotationEvent"', 'UPDATE') AS event_update,
                has_table_privilege(current_user, 'contextflow."GoogleDocRemoteThread"', 'DELETE') AS thread_delete,
                has_table_privilege(current_user, 'contextflow."GoogleDocRemoteThread"', 'UPDATE') AS thread_update`
      );
      expect(privileges.rows[0]).toEqual({ event_delete: false, event_update: false, thread_delete: false, thread_update: true });
      await client.query('ROLLBACK');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally { client.release(); }
  });
});
