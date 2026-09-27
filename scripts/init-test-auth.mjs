import { readFile } from 'node:fs/promises';
import pg from 'pg';

const envText = await readFile(new URL('../.env', import.meta.url), 'utf8').catch(() => {
  throw new Error('Missing root .env; run pnpm env:init first.');
});

function envValue(name) {
  for (const line of envText.split(/\r?\n/)) {
    const match = line.match(/^\s*([^#=\s]+)\s*=\s*(.*)\s*$/);
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

const adminPassword = envValue('TEST_POSTGRES_ADMIN_PASSWORD');
const authPassword = envValue('TEST_AUTH_POSTGRES_PASSWORD');
if (!adminPassword || !authPassword) {
  throw new Error('Missing TEST_POSTGRES_ADMIN_PASSWORD or TEST_AUTH_POSTGRES_PASSWORD in root .env.');
}
if (!/^[A-Za-z0-9_-]{32,}$/.test(authPassword)) {
  throw new Error('TEST_AUTH_POSTGRES_PASSWORD must be at least 32 URL-safe characters for the GoTrue database URL.');
}

const client = new pg.Client({
  host: '127.0.0.1',
  port: 54330,
  database: 'contextflow_test',
  user: 'postgres',
  password: adminPassword,
  ssl: false,
  application_name: 'contextflow-test-auth-bootstrap',
  connectionTimeoutMillis: 5000,
});

try {
  await client.connect();
  await client.query('BEGIN');

  const existingRole = await client.query("SELECT 1 FROM pg_roles WHERE rolname = 'supabase_auth_admin'");
  if (existingRole.rowCount === 0) {
    await client.query('CREATE ROLE supabase_auth_admin LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS');
  } else {
    const role = await client.query(`
      SELECT r.rolcanlogin, r.rolsuper, r.rolcreatedb, r.rolcreaterole, r.rolreplication, r.rolbypassrls, r.rolinherit,
        EXISTS (
          SELECT 1 FROM pg_auth_members m
          WHERE m.roleid = r.oid OR m.member = r.oid
        ) AS has_memberships
      FROM pg_roles r WHERE r.rolname = 'supabase_auth_admin'
    `);
    const [existing] = role.rows;
    if (!existing.rolcanlogin || existing.rolsuper || existing.rolcreatedb || existing.rolcreaterole || existing.rolreplication || existing.rolbypassrls || existing.rolinherit || existing.has_memberships) {
      throw new Error('Existing TEST Auth database role has unexpected privileges.');
    }
  }

  // PostgreSQL cannot bind parameters in ALTER ROLE, so format only this local password literal server-side.
  const alterRole = await client.query("SELECT format('ALTER ROLE supabase_auth_admin WITH LOGIN PASSWORD %L', $1::text) AS sql", [authPassword]);
  await client.query(alterRole.rows[0].sql);
  await client.query('GRANT CONNECT ON DATABASE contextflow_test TO supabase_auth_admin');

  const authSchema = await client.query("SELECT pg_get_userbyid(nspowner) AS owner FROM pg_namespace WHERE nspname = 'auth'");
  if (authSchema.rowCount === 0) {
    await client.query('CREATE SCHEMA auth AUTHORIZATION supabase_auth_admin');
  } else if (authSchema.rows[0].owner !== 'supabase_auth_admin') {
    throw new Error('Existing TEST auth schema has an unexpected owner.');
  }

  await client.query('ALTER ROLE supabase_auth_admin IN DATABASE contextflow_test SET search_path = auth');

  await client.query('COMMIT');
  process.stdout.write('TEST Auth database role and schema are ready.\n');
} catch {
  await client.query('ROLLBACK').catch(() => {});
  process.stderr.write('TEST Auth bootstrap failed; inspect the local TEST PostgreSQL service and configuration.\n');
  process.exitCode = 1;
} finally {
  await client.end().catch(() => {});
}
