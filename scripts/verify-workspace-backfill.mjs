import { randomBytes } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import pg from 'pg';

const { Client } = pg;
const root = new URL('../', import.meta.url);
const migrations = new URL('prisma/migrations/', root);
let admin;
let databaseName;
let created = false;
let stage = 'configuration';

function envValue(contents, name) {
  const line = contents.split(/\r?\n/).find(value => value.startsWith(`${name}=`));
  if (!line) return undefined;
  const raw = line.slice(name.length + 1).trim();
  return raw.startsWith('"') && raw.endsWith('"') ? raw.slice(1, -1) : raw;
}
function testUrl(raw, role, password) {
  const url = new URL(raw);
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || url.hostname !== '127.0.0.1'
    || url.port !== '54330' || url.pathname !== '/contextflow_test' || decodeURIComponent(url.username) !== role
    || decodeURIComponent(url.password) !== password || url.searchParams.get('schema') !== 'contextflow'
    || [...url.searchParams.keys()].some(key => !['schema', 'connect_timeout', 'pool_timeout', 'connection_limit'].includes(key))) {
    throw new Error('Unexpected TEST database target');
  }
  return url;
}
function check(condition, label) { if (!condition) throw new Error(label); }

try {
  const env = await readFile(new URL('.env', root), 'utf8');
  const adminPassword = envValue(env, 'TEST_POSTGRES_ADMIN_PASSWORD');
  const migrationPassword = envValue(env, 'TEST_POSTGRES_MIGRATION_PASSWORD');
  const url = testUrl(envValue(env, 'TEST_DIRECT_DATABASE_URL'), 'cf_migrate', migrationPassword);
  check(adminPassword && migrationPassword, 'Missing TEST credentials');
  stage = 'local-test-postgres';
  admin = new Client({ host: '127.0.0.1', port: 54330, database: 'postgres', user: 'postgres', password: adminPassword, ssl: false, connectionTimeoutMillis: 5000 });
  await admin.connect();
  const role = await admin.query(`SELECT current_user = 'postgres' AS ok, (SELECT NOT rolsuper AND NOT rolcreatedb FROM pg_roles WHERE rolname='cf_migrate') AS limited`);
  check(role.rows[0]?.ok && role.rows[0]?.limited, 'Unexpected local database roles');
  databaseName = `cf_m14_backfill_${randomBytes(16).toString('hex')}`;
  check(/^cf_m14_backfill_[a-f0-9]{32}$/.test(databaseName), 'Unsafe generated database name');
  stage = 'create-disposable-database';
  await admin.query(`CREATE DATABASE "${databaseName}"`);
  created = true;
  await admin.query(`GRANT CONNECT, CREATE ON DATABASE "${databaseName}" TO cf_migrate`);
  url.pathname = `/${databaseName}`;
  const db = new Client({ connectionString: url.toString(), ssl: false, connectionTimeoutMillis: 5000 });
  try {
    await db.connect();
    stage = 'old-migrations';
    const names = (await readdir(migrations, { withFileTypes: true })).filter(entry => entry.isDirectory()).map(entry => entry.name).sort();
    check(names.at(-1) === '20260928000100_workspace_foundation' && names.length === 8, 'Unexpected migration list');
    for (const name of names.slice(0, -1)) {
      stage = `old-migrations:${name}`;
      // Prisma creates its own metadata table before executing migrations.
      // This direct-SQL fixture has no migration ledger to restrict.
      if (name === '20260927000100_restrict_migration_metadata') continue;
      await db.query(await readFile(new URL(`${name}/migration.sql`, migrations), 'utf8'));
    }
    stage = 'populated-fixture';
    const ids = {
      a: '00000000-0000-4000-8000-000000000101', b: '00000000-0000-4000-8000-000000000102',
      c: '00000000-0000-4000-8000-000000000103', d: '00000000-0000-4000-8000-000000000104',
      p1: '00000000-0000-4000-8000-000000000201', p2: '00000000-0000-4000-8000-000000000202',
      p3: '00000000-0000-4000-8000-000000000203', p4: '00000000-0000-4000-8000-000000000204',
      asset: '00000000-0000-4000-8000-000000000301'
    };
    for (const id of [ids.a, ids.b, ids.c, ids.d]) await db.query('INSERT INTO contextflow."UserProfile" ("id") VALUES ($1)', [id]);
    for (const [id, owner] of [[ids.p1, ids.a], [ids.p2, ids.b], [ids.p3, ids.a], [ids.p4, ids.d]]) {
      await db.query(`INSERT INTO contextflow."Project" ("id","topic","formats","createdBy") VALUES ($1,'Legacy project',ARRAY['LINKEDIN_TEXT']::contextflow."ProjectFormat"[],$2)`, [id, owner]);
    }
    for (const [projectId, userId, left] of [[ids.p1, ids.a, false], [ids.p1, ids.b, false],
      [ids.p2, ids.b, false], [ids.p2, ids.c, false], [ids.p3, ids.a, false], [ids.p4, ids.d, true]]) {
      await db.query(`INSERT INTO contextflow."ProjectMember" ("projectId","userId","leftAt") VALUES ($1,$2,$3)`, [projectId, userId, left ? new Date(Date.now() + 1000) : null]);
    }
    await db.query(`INSERT INTO contextflow."Asset" ("id","projectId","bucket","objectKey","mediaType","bytes","sha256","purpose","createdBy") VALUES ($1,$2,'private-assets',$3,'text/plain',1,repeat('a',64),'ORIGINAL',$4)`, [ids.asset, ids.p1, `${ids.p1}/fixture.txt`, ids.b]);
    stage = 'workspace-migration';
    await db.query(await readFile(new URL('20260928000100_workspace_foundation/migration.sql', migrations), 'utf8'));
    stage = 'access-set-assertions';
    const rows = await db.query(`SELECT p."id" AS project_id, p."workspaceId" AS workspace_id, w."ownerId" AS owner_id, w."archivedAt" AS archived_at,
      ARRAY(SELECT m."userId"::text FROM contextflow."WorkspaceMember" m WHERE m."workspaceId"=p."workspaceId" AND m."leftAt" IS NULL ORDER BY m."userId") AS current_users,
      ARRAY(SELECT m."userId"::text FROM contextflow."ProjectMember" m WHERE m."projectId"=p."id" AND m."leftAt" IS NULL ORDER BY m."userId") AS former_users
      FROM contextflow."Project" p JOIN contextflow."Workspace" w ON w."id"=p."workspaceId" ORDER BY p."id"`);
    check(rows.rows.length === 4, 'Legacy project count changed');
    check(new Set(rows.rows.map(row => row.workspace_id)).size === 4, 'Legacy projects merged into a shared Workspace');
    for (const row of rows.rows) check(JSON.stringify(row.current_users) === JSON.stringify(row.former_users), 'Legacy access set widened or narrowed');
    const byProject = new Map(rows.rows.map(row => [row.project_id, row]));
    check(byProject.get(ids.p1)?.owner_id === ids.a && byProject.get(ids.p2)?.owner_id === ids.b, 'Wrong active owner backfill');
    check(byProject.get(ids.p4)?.archived_at !== null && byProject.get(ids.p4)?.current_users.length === 0, 'Memberless legacy project was exposed');
    const asset = await db.query(`SELECT a."createdBy", p."workspaceId" FROM contextflow."Asset" a JOIN contextflow."Project" p ON p."id"=a."projectId" WHERE a."id"=$1`, [ids.asset]);
    check(asset.rows[0]?.createdBy === ids.b && asset.rows[0]?.workspaceId === byProject.get(ids.p1)?.workspace_id, 'Asset attribution or ancestry changed');
  } finally { await db.end().catch(() => {}); }
  stage = 'complete';
} catch (error) {
  process.stderr.write(`Workspace populated migration verification failed at ${stage}${error?.code ? ` (${error.code})` : ''}.\n`);
  process.exitCode = 1;
} finally {
  if (admin && created && /^cf_m14_backfill_[a-f0-9]{32}$/.test(databaseName ?? '')) {
    try {
      await admin.query('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1 AND pid<>pg_backend_pid()', [databaseName]);
      await admin.query(`DROP DATABASE "${databaseName}"`);
    } catch { process.stderr.write('Could not remove disposable backfill database.\n'); process.exitCode = 1; }
  }
  await admin?.end().catch(() => {});
}
if (process.exitCode !== 1) process.stdout.write('Verified populated Workspace backfill: exact old access sets, isolated projects, owner/archive mapping and asset attribution. Disposable database removed.\n');
