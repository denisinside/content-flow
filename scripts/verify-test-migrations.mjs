import { randomBytes } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import pg from 'pg';

const { Client } = pg;
const root = new URL('../', import.meta.url);
const require = createRequire(import.meta.url);
let stage = 'configuration';
let admin;
let databaseName;
let databaseCreated = false;

function safeFailure(error) {
  const code = typeof error?.code === 'string' ? error.code : 'unknown';
  const constraint = typeof error?.constraint === 'string' ? error.constraint.replace(/[^A-Za-z0-9_]/g, '').slice(0, 96) : 'none';
  const reason = code === 'unknown' && typeof error?.message === 'string'
    ? error.message.replace(/[^A-Za-z0-9 _-]/g, '').slice(0, 100)
    : 'none';
  process.stderr.write(`Test migration verification failed at ${stage} (db-code=${code}, constraint=${constraint}, reason=${reason || 'none'}).\n`);
  process.exitCode = 1;
}

function envValue(contents, name) {
  for (const line of contents.split(/\r?\n/)) {
    const match = line.match(/^\s*([^#=\s]+)\s*=\s*(.*?)\s*$/);
    if (!match || match[1] !== name) continue;
    let value = match[2];
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    } else {
      value = value.replace(/\s+#.*$/, '').trim();
    }
    return value;
  }
  return undefined;
}

function validateTestUrl(raw, expectedRole) {
  let url;
  try { url = new URL(raw); } catch { throw new Error('invalid-url'); }
  if (!['postgres:', 'postgresql:'].includes(url.protocol)
      || url.hostname !== '127.0.0.1' || url.port !== '54330'
      || decodeURIComponent(url.pathname) !== '/contextflow_test'
      || decodeURIComponent(url.username) !== expectedRole
      || url.hash !== '' || url.searchParams.get('schema') !== 'contextflow') {
    throw new Error('unexpected-url-target');
  }
  const allowed = new Set(['schema', 'connect_timeout', 'pool_timeout', 'connection_limit']);
  if ([...url.searchParams.keys()].some(key => !allowed.has(key))) throw new Error('unexpected-url-options');
  return url;
}

function disposableUrl(source, name) {
  const url = new URL(source);
  url.pathname = `/${name}`;
  return url.toString();
}

async function checkRuntime(runtimeUrl) {
  const runtime = new Client({ connectionString: runtimeUrl, ssl: false, application_name: 'contextflow-migration-verifier-runtime', connectionTimeoutMillis: 5000 });
  try {
    await runtime.connect();
    stage = 'runtime-permission-matrix';
    const permissions = await runtime.query(`
      SELECT current_user = 'cf_runtime' AS expected_role,
        has_schema_privilege(current_user, 'contextflow', 'USAGE') AS can_use_schema,
        has_schema_privilege(current_user, 'contextflow', 'CREATE') AS can_create_schema,
        to_regnamespace('auth') IS NOT NULL AS auth_schema_exists
    `);
    const state = permissions.rows[0];
    if (!state.expected_role) { stage = 'runtime-role'; throw new Error('runtime-role'); }
    if (!state.can_use_schema) { stage = 'runtime-schema-usage'; throw new Error('runtime-schema-usage'); }
    if (state.can_create_schema) { stage = 'runtime-schema-create-privilege'; throw new Error('runtime-schema-create'); }
    if (state.auth_schema_exists) { stage = 'provider-auth-schema'; throw new Error('provider-auth'); }

    stage = 'runtime-table-permissions';
    const tablePermissions = await runtime.query(`
      SELECT
        has_table_privilege(current_user, 'contextflow."UserProfile"', 'SELECT') AS profile_select,
        has_table_privilege(current_user, 'contextflow."UserProfile"', 'INSERT') AS profile_insert,
        has_table_privilege(current_user, 'contextflow."UserProfile"', 'UPDATE') AS profile_update,
        has_table_privilege(current_user, 'contextflow."UserProfile"', 'DELETE') AS profile_delete,
        has_table_privilege(current_user, 'contextflow."AppSession"', 'SELECT') AS session_select,
        has_table_privilege(current_user, 'contextflow."AppSession"', 'INSERT') AS session_insert,
        has_table_privilege(current_user, 'contextflow."AppSession"', 'UPDATE') AS session_update,
        has_table_privilege(current_user, 'contextflow."AppSession"', 'DELETE') AS session_delete,
        has_table_privilege(current_user, 'contextflow."_prisma_migrations"', 'SELECT') AS migration_select,
        has_table_privilege(current_user, 'contextflow."_prisma_migrations"', 'INSERT') AS migration_insert,
        has_table_privilege(current_user, 'contextflow."_prisma_migrations"', 'UPDATE') AS migration_update,
        has_table_privilege(current_user, 'contextflow."_prisma_migrations"', 'DELETE') AS migration_delete
    `);
    const tableState = tablePermissions.rows[0];
    for (const privilege of ['select', 'insert', 'update', 'delete']) {
      if (!tableState[`profile_${privilege}`]) { stage = `runtime-profile-${privilege}-privilege`; throw new Error('runtime-profile-privilege'); }
      if (!tableState[`session_${privilege}`]) { stage = `runtime-session-${privilege}-privilege`; throw new Error('runtime-session-privilege'); }
      if (tableState[`migration_${privilege}`]) { stage = `runtime-metadata-${privilege}-privilege`; throw new Error('runtime-metadata-privilege'); }
    }

    stage = 'runtime-app-dml';
    for (const table of ['Workspace', 'WorkspaceMember', 'WorkspaceInvite', 'WorkspaceStyleRevision', 'Project', 'ProjectMember', 'Asset']) {
      for (const privilege of ['SELECT', 'INSERT', 'UPDATE', 'DELETE']) {
        const allowed = await runtime.query('SELECT has_table_privilege(current_user, $1, $2) AS allowed', [`contextflow."${table}"`, privilege]);
        if (!allowed.rows[0]?.allowed) throw new Error('project-table-privilege');
      }
    }
    for (const [table, privileges] of [
      ['Material', ['SELECT', 'INSERT', 'UPDATE']],
      ['SourceSnapshot', ['SELECT', 'INSERT']],
      ['SourceFragment', ['SELECT', 'INSERT']],
    ]) {
      for (const privilege of ['SELECT', 'INSERT', 'UPDATE', 'DELETE']) {
        const result = await runtime.query('SELECT has_table_privilege(current_user, $1, $2) AS allowed', [`contextflow."${table}"`, privilege]);
        if (Boolean(result.rows[0]?.allowed) !== privileges.includes(privilege)) throw new Error('source-table-privilege');
      }
    }
    await runtime.query('BEGIN');
    await runtime.query(`INSERT INTO contextflow."UserProfile" ("id", "displayName") VALUES ('00000000-0000-4000-8000-000000000001', 'migration verifier')`);
    const preferenceDefault = await runtime.query(`SELECT "idleTimeoutMinutes" FROM contextflow."UserProfile" WHERE "id" = '00000000-0000-4000-8000-000000000001'`);
    if (preferenceDefault.rows[0]?.idleTimeoutMinutes !== 1440) throw new Error('personal-idle-default');
    for (const invalid of [0, 10081]) {
      await runtime.query('SAVEPOINT personal_idle_check');
      let rejected = false;
      try { await runtime.query(`UPDATE contextflow."UserProfile" SET "idleTimeoutMinutes" = $1 WHERE "id" = '00000000-0000-4000-8000-000000000001'`, [invalid]); }
      catch (error) { rejected = error?.code === '23514'; }
      await runtime.query('ROLLBACK TO SAVEPOINT personal_idle_check');
      await runtime.query('RELEASE SAVEPOINT personal_idle_check');
      if (!rejected) throw new Error('personal-idle-check-constraint');
    }
    await runtime.query('SAVEPOINT external_acceptance_check');
    let unpairedAcceptanceRejected = false;
    try { await runtime.query(`UPDATE contextflow."UserProfile" SET "externalProcessingNoticeVersion" = 'notice-v1' WHERE "id" = '00000000-0000-4000-8000-000000000001'`); }
    catch (error) { unpairedAcceptanceRejected = error?.code === '23514'; }
    await runtime.query('ROLLBACK TO SAVEPOINT external_acceptance_check');
    await runtime.query('RELEASE SAVEPOINT external_acceptance_check');
    if (!unpairedAcceptanceRejected) throw new Error('external-processing-acceptance-pair-check');
    await runtime.query(`UPDATE contextflow."UserProfile" SET "externalProcessingNoticeVersion" = 'notice-v1', "externalProcessingAcceptedAt" = CURRENT_TIMESTAMP WHERE "id" = '00000000-0000-4000-8000-000000000001'`);
    await runtime.query(`INSERT INTO contextflow."AppSession" ("id", "cookieDigest", "userId", "encryptedProviderTokens", "tokenKeyVersion", "providerTokenExpiresAt", "expiresAt") VALUES ('00000000-0000-4000-8000-000000000002', repeat('a', 64), '00000000-0000-4000-8000-000000000001', 'test-only-ciphertext-placeholder', 1, CURRENT_TIMESTAMP + interval '1 hour', CURRENT_TIMESTAMP + interval '1 day')`);
    await runtime.query(`UPDATE contextflow."UserProfile" SET "displayName" = 'migration verifier updated' WHERE "id" = '00000000-0000-4000-8000-000000000001'`);
    const projectId = '00000000-0000-4000-8000-000000000003';
    const secondProjectId = '00000000-0000-4000-8000-000000000011';
    const userId = '00000000-0000-4000-8000-000000000001';
    const workspaceId = '00000000-0000-4000-8000-000000000009';
    await runtime.query(`INSERT INTO contextflow."Workspace" ("id", "name", "ownerId") VALUES ($1, 'migration verifier', $2)`, [workspaceId, userId]);
    await runtime.query(`INSERT INTO contextflow."WorkspaceMember" ("workspaceId", "userId") VALUES ($1, $2)`, [workspaceId, userId]);
    await runtime.query(`INSERT INTO contextflow."WorkspaceStyleRevision" ("workspaceId", "revision", "createdBy") VALUES ($1, 1, $2)`, [workspaceId, userId]);
    await runtime.query(`INSERT INTO contextflow."WorkspaceInvite" ("id", "workspaceId", "email", "tokenDigest", "invitedBy", "expiresAt") VALUES ('00000000-0000-4000-8000-000000000010', $1, 'recipient@example.test', repeat('b', 64), $2, CURRENT_TIMESTAMP + interval '1 day')`, [workspaceId, userId]);
    await runtime.query(`INSERT INTO contextflow."Project" ("id", "workspaceId", "topic", "formats", "createdBy") VALUES ($1, $2, 'synthetic article project', ARRAY['ARTICLE']::contextflow."ProjectFormat"[], $3)`, [projectId, workspaceId, userId]);
    await runtime.query(`INSERT INTO contextflow."Project" ("id", "workspaceId", "topic", "formats", "createdBy") VALUES ($1, $2, 'second synthetic project', ARRAY['ARTICLE']::contextflow."ProjectFormat"[], $3)`, [secondProjectId, workspaceId, userId]);
    await runtime.query(`INSERT INTO contextflow."ProjectMember" ("projectId", "userId") VALUES ('00000000-0000-4000-8000-000000000003', '00000000-0000-4000-8000-000000000001')`);
    const allFormats = ['ARTICLE', 'LINKEDIN_TEXT', 'LINKEDIN_COVER', 'LINKEDIN_CAROUSEL', 'INSTAGRAM_COVER', 'INSTAGRAM_CAROUSEL', 'INSTAGRAM_STORIES', 'TELEGRAM_POST'];
    const eightSelection = await runtime.query(`UPDATE contextflow."Project" SET "formats" = $1::contextflow."ProjectFormat"[] WHERE "id" = $2 RETURNING cardinality("formats") AS format_count, 'ARTICLE' = ANY("formats") AS article_selected`, [allFormats, projectId]);
    if (Number(eightSelection.rows[0]?.format_count) !== 8 || !eightSelection.rows[0]?.article_selected) throw new Error('article-eight-format-selection');

    const invalidSelections = [
      { id: '00000000-0000-4000-8000-000000000005', formats: [] },
      { id: '00000000-0000-4000-8000-000000000006', formats: ['ARTICLE', 'ARTICLE'] },
      { id: '00000000-0000-4000-8000-000000000007', formats: [null] },
      { id: '00000000-0000-4000-8000-000000000008', formats: [...allFormats, 'ARTICLE'] },
    ];
    for (const invalid of invalidSelections) {
      await runtime.query('SAVEPOINT project_format_check');
      let checkRejected = false;
      try {
        await runtime.query(`INSERT INTO contextflow."Project" ("id", "workspaceId", "topic", "formats", "createdBy") VALUES ($1, $2, 'invalid format selection', $3::contextflow."ProjectFormat"[], $4)`, [invalid.id, workspaceId, invalid.formats, userId]);
      } catch (error) { checkRejected = error?.code === '23514'; }
      await runtime.query('ROLLBACK TO SAVEPOINT project_format_check');
      await runtime.query('RELEASE SAVEPOINT project_format_check');
      if (!checkRejected) throw new Error('project-format-check-constraint');
    }
    await runtime.query(`INSERT INTO contextflow."Asset" ("id", "projectId", "bucket", "objectKey", "mediaType", "bytes", "sha256", "purpose", "createdBy") VALUES ('00000000-0000-4000-8000-000000000004', '00000000-0000-4000-8000-000000000003', 'private-assets', '00000000-0000-4000-8000-000000000003/fixture.txt', 'text/plain', 1, repeat('a', 64), 'ORIGINAL', '00000000-0000-4000-8000-000000000001')`);
    stage = 'runtime-source-second-asset';
    await runtime.query(`INSERT INTO contextflow."Asset" ("id", "projectId", "bucket", "objectKey", "mediaType", "bytes", "sha256", "purpose", "createdBy") VALUES ('00000000-0000-4000-8000-000000000012', $1, 'private-assets', $1::uuid::text || '/fixture.txt', 'text/plain', 3, repeat('c', 64), 'ORIGINAL', $2)`, [secondProjectId, userId]);
    stage = 'runtime-source-materials';
    const materialId = '00000000-0000-4000-8000-000000000013';
    const otherMaterialId = '00000000-0000-4000-8000-000000000014';
    const snapshotId = '00000000-0000-4000-8000-000000000015';
    const secondSnapshotId = '00000000-0000-4000-8000-000000000016';
    const otherSnapshotId = '00000000-0000-4000-8000-000000000017';
    await runtime.query(`INSERT INTO contextflow."Material" ("id", "projectId", "kind", "purpose", "label", "createdBy") VALUES ($1, $2, 'TEXT', 'FACTUAL_SOURCE', 'Synthetic source', $3), ($4, $5, 'FILE', 'FACTUAL_SOURCE', 'Other project source', $3)`, [materialId, projectId, userId, otherMaterialId, secondProjectId]);
    stage = 'runtime-source-snapshots';
    await runtime.query(`INSERT INTO contextflow."SourceSnapshot" ("id", "projectId", "materialId", "sequence", "normalizedText", "sha256", "bytes", "origin", "originalAssetId", "originalFilename", "createdBy") VALUES ($1, $2, $3, 1, 'abc', encode(sha256(convert_to('abc', 'UTF8')), 'hex'), 3, 'LOCAL_FILE', '00000000-0000-4000-8000-000000000004', 'fixture.txt', $4)`, [snapshotId, projectId, materialId, userId]);
    await runtime.query(`UPDATE contextflow."Material" SET "currentSnapshotId" = $1, "revision" = "revision" + 1, "updatedAt" = CURRENT_TIMESTAMP WHERE "id" = $2`, [snapshotId, materialId]);
    await runtime.query(`INSERT INTO contextflow."SourceSnapshot" ("id", "projectId", "materialId", "sequence", "normalizedText", "sha256", "bytes", "origin", "previousSnapshotId", "createdBy") VALUES ($1, $2, $3, 2, 'abcd', encode(sha256(convert_to('abcd', 'UTF8')), 'hex'), 4, 'MANUAL_TEXT', $4, $5)`, [secondSnapshotId, projectId, materialId, snapshotId, userId]);
    await runtime.query(`INSERT INTO contextflow."SourceSnapshot" ("id", "projectId", "materialId", "sequence", "normalizedText", "sha256", "bytes", "origin", "createdBy") VALUES ($1, $2, $3, 1, 'xyz', encode(sha256(convert_to('xyz', 'UTF8')), 'hex'), 3, 'MANUAL_TEXT', $4)`, [otherSnapshotId, secondProjectId, otherMaterialId, userId]);
    await runtime.query(`INSERT INTO contextflow."SourceFragment" ("id", "projectId", "snapshotId", "ordinal", "startOffset", "endOffset", "sha256") VALUES ('00000000-0000-4000-8000-000000000018', $1, $2, 1, 0, 3, encode(sha256(convert_to('abc', 'UTF8')), 'hex'))`, [projectId, snapshotId]);

    const assertRejected = async (savepoint, expectedCode, action, failure) => {
      await runtime.query(`SAVEPOINT ${savepoint}`);
      let rejected = false;
      try { await action(); } catch (error) { rejected = error?.code === expectedCode; }
      await runtime.query(`ROLLBACK TO SAVEPOINT ${savepoint}`);
      await runtime.query(`RELEASE SAVEPOINT ${savepoint}`);
      if (!rejected) throw new Error(failure);
    };
    await assertRejected('source_cross_asset', '23503', () => runtime.query(`INSERT INTO contextflow."SourceSnapshot" ("id", "projectId", "materialId", "sequence", "normalizedText", "sha256", "bytes", "origin", "originalAssetId", "originalFilename", "previousSnapshotId", "createdBy") VALUES ('00000000-0000-4000-8000-000000000019', $1, $2, 3, 'abc', encode(sha256(convert_to('abc', 'UTF8')), 'hex'), 3, 'MANUAL_TEXT', '00000000-0000-4000-8000-000000000012', 'other.txt', $3, $4)`, [projectId, materialId, secondSnapshotId, userId]), 'cross-project-original-asset-fk');
    await assertRejected('source_cross_previous', '23514', () => runtime.query(`INSERT INTO contextflow."SourceSnapshot" ("id", "projectId", "materialId", "sequence", "normalizedText", "sha256", "bytes", "origin", "previousSnapshotId", "createdBy") VALUES ('00000000-0000-4000-8000-000000000020', $1, $2, 3, 'abc', encode(sha256(convert_to('abc', 'UTF8')), 'hex'), 3, 'MANUAL_TEXT', $3, $4)`, [projectId, materialId, otherSnapshotId, userId]), 'cross-project-previous-snapshot-rejected');
    await assertRejected('source_cross_fragment', '23503', () => runtime.query(`INSERT INTO contextflow."SourceFragment" ("id", "projectId", "snapshotId", "ordinal", "startOffset", "endOffset", "sha256") VALUES ('00000000-0000-4000-8000-000000000021', $1, $2, 1, 0, 1, repeat('a', 64))`, [projectId, otherSnapshotId]), 'cross-project-fragment-snapshot-fk');
    await assertRejected('source_cross_current', '23503', () => runtime.query(`UPDATE contextflow."Material" SET "currentSnapshotId" = $1, "revision" = "revision" + 1 WHERE "id" = $2`, [otherSnapshotId, materialId]), 'cross-project-material-current-snapshot-fk');
    await assertRejected('source_snapshot_immutable', '42501', () => runtime.query(`UPDATE contextflow."SourceSnapshot" SET "normalizedText" = 'edited' WHERE "id" = $1`, [snapshotId]), 'runtime-source-snapshot-update-denied');
    await assertRejected('source_fragment_immutable', '42501', () => runtime.query(`UPDATE contextflow."SourceFragment" SET "endOffset" = 2 WHERE "snapshotId" = $1`, [snapshotId]), 'runtime-source-fragment-update-denied');
    await assertRejected('source_referenced_asset', '23514', () => runtime.query(`UPDATE contextflow."Asset" SET "objectKey" = $1 WHERE "id" = '00000000-0000-4000-8000-000000000004'`, [projectId + '/changed.txt']), 'referenced-source-original-metadata-immutable');
    await assertRejected('source_invalid_range', '23514', () => runtime.query(`INSERT INTO contextflow."SourceFragment" ("id", "projectId", "snapshotId", "ordinal", "startOffset", "endOffset", "sha256") VALUES ('00000000-0000-4000-8000-000000000022', $1, $2, 1, 4, 3, repeat('a', 64))`, [projectId, snapshotId]), 'source-fragment-range-check');
    await runtime.query(`UPDATE contextflow."Project" SET "topic" = 'updated synthetic project', "revision" = "revision" + 1 WHERE "id" = '00000000-0000-4000-8000-000000000003'`);
    await runtime.query(`UPDATE contextflow."Asset" SET "state" = 'AVAILABLE' WHERE "id" = '00000000-0000-4000-8000-000000000004'`);
    await runtime.query(`UPDATE contextflow."ProjectMember" SET "leftAt" = CURRENT_TIMESTAMP WHERE "projectId" = '00000000-0000-4000-8000-000000000003'`);
    await runtime.query('ROLLBACK');

    stage = 'runtime-private-metadata';
    let metadataReadDenied = false;
    try {
      await runtime.query(`SELECT * FROM contextflow."_prisma_migrations" LIMIT 0`);
    } catch (error) {
      metadataReadDenied = error?.code === '42501';
    }
    if (!metadataReadDenied) throw new Error('metadata-read');

    let metadataWriteDenied = false;
    try {
      await runtime.query(`UPDATE contextflow."_prisma_migrations" SET finished_at = finished_at WHERE false`);
    } catch (error) {
      metadataWriteDenied = error?.code === '42501';
    }
    if (!metadataWriteDenied) throw new Error('metadata-write');

    stage = 'runtime-schema-create';
    let createDenied = false;
    try { await runtime.query('CREATE SCHEMA verifier_must_not_create'); }
    catch (error) { createDenied = error?.code === '42501'; }
    if (!createDenied) throw new Error('schema-create');
  } finally {
    await runtime.query('ROLLBACK').catch(() => {});
    await runtime.end().catch(() => {});
  }
}

async function checkMigrationSourceGuards(migrationUrl) {
  const migration = new Client({ connectionString: migrationUrl, ssl: false, application_name: 'contextflow-migration-verifier-source-guards', connectionTimeoutMillis: 5000 });
  try {
    await migration.connect();
    await migration.query('BEGIN');
    const userId = '00000000-0000-4000-8000-000000000031';
    const workspaceId = '00000000-0000-4000-8000-000000000032';
    const projectId = '00000000-0000-4000-8000-000000000033';
    const assetId = '00000000-0000-4000-8000-000000000034';
    const materialId = '00000000-0000-4000-8000-000000000035';
    const snapshotId = '00000000-0000-4000-8000-000000000036';
    await migration.query(`INSERT INTO contextflow."UserProfile" ("id", "displayName") VALUES ($1, 'source guard verifier')`, [userId]);
    await migration.query(`INSERT INTO contextflow."Workspace" ("id", "name", "ownerId") VALUES ($1, 'source guard verifier', $2)`, [workspaceId, userId]);
    await migration.query(`INSERT INTO contextflow."WorkspaceMember" ("workspaceId", "userId") VALUES ($1, $2)`, [workspaceId, userId]);
    await migration.query(`INSERT INTO contextflow."WorkspaceStyleRevision" ("workspaceId", "revision", "createdBy") VALUES ($1, 1, $2)`, [workspaceId, userId]);
    await migration.query(`INSERT INTO contextflow."Project" ("id", "workspaceId", "topic", "formats", "createdBy") VALUES ($1, $2, 'source guard verifier', ARRAY['ARTICLE']::contextflow."ProjectFormat"[], $3)`, [projectId, workspaceId, userId]);
    await migration.query(`INSERT INTO contextflow."Asset" ("id", "projectId", "bucket", "objectKey", "mediaType", "bytes", "sha256", "purpose", "createdBy") VALUES ($1, $2, 'private-assets', $2::uuid::text || '/source.txt', 'text/plain', 3, encode(sha256(convert_to('abc', 'UTF8')), 'hex'), 'ORIGINAL', $3)`, [assetId, projectId, userId]);
    await migration.query(`INSERT INTO contextflow."Material" ("id", "projectId", "kind", "purpose", "label", "createdBy") VALUES ($1, $2, 'FILE', 'FACTUAL_SOURCE', 'Guard source', $3)`, [materialId, projectId, userId]);
    await migration.query(`INSERT INTO contextflow."SourceSnapshot" ("id", "projectId", "materialId", "sequence", "normalizedText", "sha256", "bytes", "origin", "originalAssetId", "originalFilename", "createdBy") VALUES ($1, $2, $3, 1, 'abc', encode(sha256(convert_to('abc', 'UTF8')), 'hex'), 3, 'LOCAL_FILE', $4, 'source.txt', $5)`, [snapshotId, projectId, materialId, assetId, userId]);
    await migration.query(`INSERT INTO contextflow."SourceFragment" ("id", "projectId", "snapshotId", "ordinal", "startOffset", "endOffset", "sha256") VALUES ('00000000-0000-4000-8000-000000000037', $1, $2, 1, 0, 3, encode(sha256(convert_to('abc', 'UTF8')), 'hex'))`, [projectId, snapshotId]);

    const assertGuarded = async (savepoint, action, failure) => {
      await migration.query(`SAVEPOINT ${savepoint}`);
      let rejected = false;
      try { await action(); } catch (error) { rejected = error?.code === '23514'; }
      await migration.query(`ROLLBACK TO SAVEPOINT ${savepoint}`);
      await migration.query(`RELEASE SAVEPOINT ${savepoint}`);
      if (!rejected) throw new Error(failure);
    };
    await assertGuarded('snapshot_immutability_guard', () => migration.query(`UPDATE contextflow."SourceSnapshot" SET "normalizedText" = 'edited' WHERE "id" = $1`, [snapshotId]), 'source-snapshot-update-trigger');
    await assertGuarded('fragment_immutability_guard', () => migration.query(`UPDATE contextflow."SourceFragment" SET "endOffset" = 2 WHERE "snapshotId" = $1`, [snapshotId]), 'source-fragment-update-trigger');
    await assertGuarded('asset_metadata_guard', () => migration.query(`UPDATE contextflow."Asset" SET "objectKey" = $1 WHERE "id" = $2`, [projectId + '/changed.txt', assetId]), 'referenced-asset-metadata-trigger');
    await migration.query('ROLLBACK');
  } finally {
    await migration.query('ROLLBACK').catch(() => {});
    await migration.end().catch(() => {});
  }
}

try {
  stage = 'environment';
  const migrationEntries = await readdir(new URL('prisma/migrations/', root), { withFileTypes: true });
  const expectedMigrations = migrationEntries.filter(entry => entry.isDirectory()).map(entry => entry.name).sort();
  if (expectedMigrations.length === 0 || expectedMigrations.some(name => !/^\d{14}_[a-z0-9_]+$/.test(name))) throw new Error('invalid-migration-directories');
  const contents = await readFile(new URL('.env', root), 'utf8');
  const adminPassword = envValue(contents, 'TEST_POSTGRES_ADMIN_PASSWORD');
  const migrationPassword = envValue(contents, 'TEST_POSTGRES_MIGRATION_PASSWORD');
  const runtimePassword = envValue(contents, 'TEST_POSTGRES_RUNTIME_PASSWORD');
  if (!adminPassword || !migrationPassword || !runtimePassword) throw new Error('missing-credentials');
  const migrationBase = validateTestUrl(envValue(contents, 'TEST_DIRECT_DATABASE_URL'), 'cf_migrate');
  const runtimeBase = validateTestUrl(envValue(contents, 'TEST_DATABASE_URL'), 'cf_runtime');
  if (decodeURIComponent(migrationBase.password) !== migrationPassword || decodeURIComponent(runtimeBase.password) !== runtimePassword) {
    throw new Error('credential-mismatch');
  }

  stage = 'local-test-postgres';
  admin = new Client({ host: '127.0.0.1', port: 54330, database: 'postgres', user: 'postgres', password: adminPassword, ssl: false, application_name: 'contextflow-migration-verifier-admin', connectionTimeoutMillis: 5000 });
  await admin.connect();
  const serviceCheck = await admin.query(`
    SELECT current_user = 'postgres' AS expected_admin,
      (SELECT rolcanlogin AND NOT rolsuper AND NOT rolcreatedb AND NOT rolcreaterole AND NOT rolreplication AND NOT rolbypassrls FROM pg_roles WHERE rolname = 'cf_migrate') AS migration_role_is_limited,
      (SELECT rolcanlogin AND NOT rolsuper AND NOT rolcreatedb AND NOT rolcreaterole AND NOT rolreplication AND NOT rolbypassrls FROM pg_roles WHERE rolname = 'cf_runtime') AS runtime_role_is_limited
  `);
  if (!serviceCheck.rows[0]?.expected_admin || !serviceCheck.rows[0]?.migration_role_is_limited || !serviceCheck.rows[0]?.runtime_role_is_limited) {
    throw new Error('unexpected-local-service');
  }

  databaseName = `cf_m12_migration_${randomBytes(16).toString('hex')}`;
  if (!/^cf_m12_migration_[a-f0-9]{32}$/.test(databaseName)) throw new Error('unsafe-database-name');
  stage = 'create-disposable-database';
  await admin.query(`CREATE DATABASE "${databaseName}"`);
  databaseCreated = true;
  await admin.query(`GRANT CONNECT, CREATE ON DATABASE "${databaseName}" TO cf_migrate`);
  await admin.query(`GRANT CONNECT ON DATABASE "${databaseName}" TO cf_runtime`);

  stage = 'prisma-migrate-deploy';
  const prismaPackage = require.resolve('prisma/package.json');
  const prismaCli = join(dirname(prismaPackage), 'build', 'index.js');
  const migrationUrl = disposableUrl(migrationBase.toString(), databaseName);
  const runtimeUrl = disposableUrl(runtimeBase.toString(), databaseName);
  const prisma = spawnSync(process.execPath, [prismaCli, 'migrate', 'deploy', '--config', 'prisma7.config.ts'], {
    cwd: new URL('.', root),
    env: { ...process.env, NODE_ENV: 'test', TEST_DATABASE_URL: runtimeUrl, TEST_DIRECT_DATABASE_URL: migrationUrl },
    encoding: 'utf8', timeout: 120_000, maxBuffer: 4 * 1024 * 1024, windowsHide: true
  });
  if (prisma.error || prisma.status !== 0) throw new Error('migration-command');

  stage = 'migration-results';
  const migrated = new Client({ connectionString: migrationUrl, ssl: false, application_name: 'contextflow-migration-verifier-check', connectionTimeoutMillis: 5000 });
  await migrated.connect();
  try {
    const results = await migrated.query(`
      SELECT migration_name, finished_at, rolled_back_at
      FROM contextflow."_prisma_migrations"
      ORDER BY migration_name
    `);
    const actualMigrations = results.rows;
    const migrationsOk = actualMigrations.length === expectedMigrations.length
      && actualMigrations.every((row, index) => row.migration_name === expectedMigrations[index] && row.finished_at !== null && row.rolled_back_at === null);
    const checks = await migrated.query(`
      SELECT
        (SELECT count(*) = 12 FROM information_schema.tables
          WHERE table_schema = 'contextflow' AND table_name IN ('UserProfile', 'AppSession', 'Workspace', 'WorkspaceMember', 'WorkspaceInvite', 'WorkspaceStyleRevision', 'Project', 'ProjectMember', 'Asset', 'Material', 'SourceSnapshot', 'SourceFragment')) AS app_tables_ok,
        (SELECT count(*) = 7 FROM pg_constraint c
          JOIN pg_class t ON t.oid = c.conrelid
          JOIN pg_namespace n ON n.oid = t.relnamespace
          WHERE n.nspname = 'contextflow' AND t.relname = 'AppSession') AS session_constraints_ok,
        (SELECT count(*) = 1 FROM pg_constraint c
          JOIN pg_class t ON t.oid = c.conrelid
          JOIN pg_namespace n ON n.oid = t.relnamespace
          WHERE n.nspname = 'contextflow' AND t.relname = 'UserProfile' AND c.contype = 'p') AS profile_primary_key_ok,
        to_regnamespace('auth') IS NULL AS no_provider_auth_schema
    `);
    const result = checks.rows[0];
    if (!migrationsOk || !result.app_tables_ok || !result.session_constraints_ok || !result.profile_primary_key_ok || !result.no_provider_auth_schema) {
      throw new Error('migration-state');
    }
  } finally { await migrated.end().catch(() => {}); }

  stage = 'runtime-privileges';
  await checkRuntime(runtimeUrl);
  stage = 'migration-source-immutability';
  await checkMigrationSourceGuards(migrationUrl);
  stage = 'complete';
} catch (error) {
  safeFailure(error);
} finally {
  if (admin && databaseCreated && /^cf_m12_migration_[a-f0-9]{32}$/.test(databaseName ?? '')) {
    stage = 'drop-disposable-database';
    try {
      await admin.query(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()`, [databaseName]);
      await admin.query(`DROP DATABASE "${databaseName}"`);
      databaseCreated = false;
    } catch {
      process.stderr.write('Could not remove the generated disposable migration database.\n');
      process.exitCode = 1;
    }
  }
  await admin?.end().catch(() => {});
}

if (process.exitCode !== 1) {
  process.stdout.write('Verified all Prisma migrations, source integrity and isolation constraints, immutable source write permissions, runtime table permissions, private migration metadata, and no auth schema; disposable database removed.\n');
}
