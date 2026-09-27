import { randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = new URL('../', import.meta.url);
const target = new URL('.env', root);
if (existsSync(target)) {
  console.log('.env already exists; preserved without reading or printing its values.');
} else {
  let content = readFileSync(new URL('.env.example', root), 'utf8');
  for (const token of [
    'GENERATE_LOCAL_ADMIN_PASSWORD', 'GENERATE_LOCAL_MIGRATION_PASSWORD', 'GENERATE_LOCAL_RUNTIME_PASSWORD',
    'GENERATE_TEST_ADMIN_PASSWORD', 'GENERATE_TEST_MIGRATION_PASSWORD', 'GENERATE_TEST_RUNTIME_PASSWORD'
  ]) content = content.replaceAll(token, randomBytes(24).toString('hex'));
  content = content.replaceAll('GENERATE_SESSION_ENCRYPTION_KEY', randomBytes(32).toString('base64'));
  writeFileSync(target, content, { flag: 'wx', mode: 0o600 });
  console.log(`Created ${fileURLToPath(target)} with local development/test values. No credentials printed.`);
}
