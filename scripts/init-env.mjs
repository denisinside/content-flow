import { randomBytes, createHmac } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = new URL('../', import.meta.url);
const target = new URL('.env', root);
const existed = existsSync(target);
let content = readFileSync(existed ? target : new URL('.env.example', root), 'utf8');
const values = new Map(content.split(/\r?\n/).flatMap(line => {
  const match = /^([A-Z_]+)=(.*)$/.exec(line);
  return match ? [[match[1], match[2].replace(/^(['"])(.*)\1$/, '$2')]] : [];
}));
function ensure(name, generated) {
  const existing = values.get(name);
  if (existing && !existing.startsWith('GENERATE_')) return existing;
  const value = generated();
  if (values.has(name)) content = content.replace(new RegExp('^' + name + '=.*$', 'm'), name + '=' + value);
  else content += '\n' + name + '=' + value;
  values.set(name, value);
  return value;
}
for (const name of ['TEST_POSTGRES_ADMIN_PASSWORD', 'TEST_POSTGRES_MIGRATION_PASSWORD', 'TEST_POSTGRES_RUNTIME_PASSWORD']) {
  const old = values.get(name);
  const generated = ensure(name, () => randomBytes(24).toString('hex'));
  if (old?.startsWith('GENERATE_')) content = content.replaceAll(old, generated);
}
ensure('SESSION_ENCRYPTION_KEY', () => randomBytes(32).toString('base64'));
ensure('SESSION_CSRF_KEY', () => randomBytes(32).toString('base64'));
ensure('TEST_SESSION_ENCRYPTION_KEY', () => randomBytes(32).toString('base64'));
ensure('TEST_SESSION_CSRF_KEY', () => randomBytes(32).toString('base64'));
ensure('TEST_SESSION_ENCRYPTION_KEY_VERSION', () => '1');
ensure('TEST_AUTH_POSTGRES_PASSWORD', () => randomBytes(24).toString('hex'));
const jwtSecret = ensure('TEST_AUTH_JWT_SECRET', () => randomBytes(32).toString('hex'));
ensure('TEST_SUPABASE_URL', () => 'http://127.0.0.1:54331');
function jwt(role) {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({ role, iss: 'supabase', iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 315_360_000 })).toString('base64url');
  return header + '.' + payload + '.' + createHmac('sha256', jwtSecret).update(header + '.' + payload).digest('base64url');
}
ensure('TEST_SUPABASE_PUBLISHABLE_KEY', () => jwt('anon'));
ensure('TEST_SUPABASE_SECRET_KEY', () => jwt('service_role'));
writeFileSync(target, content.endsWith('\n') ? content : content + '\n', { ...(existed ? {} : { flag: 'wx' }), mode: 0o600 });
console.log(`${existed ? 'Updated missing generated fields in' : 'Created'} ${fileURLToPath(target)}. Existing configured values preserved; no credentials printed.`);
