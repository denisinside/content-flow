import { randomBytes } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';

// Initialize only missing local Google key material. Existing keys are never rotated here.
const path = '.env';
let contents = await readFile(path, 'utf8');
for (const prefix of ['', 'TEST_']) {
  const keyName = `${prefix}GOOGLE_DOCS_TOKEN_ENCRYPTION_KEY`;
  const keyVersionName = `${prefix}GOOGLE_DOCS_TOKEN_ENCRYPTION_KEY_VERSION`;
  for (const [name, create] of [[keyName, () => randomBytes(32).toString('base64')], [keyVersionName, () => '1']]) {
    const pattern = new RegExp(`^${name}=(.*)$`, 'm');
    const match = contents.match(pattern);
    if (match?.[1]?.trim()) continue;
    const entry = `${name}=${create()}`;
    contents = match ? contents.replace(pattern, entry) : `${contents.trimEnd()}\n${entry}\n`;
  }
}
await writeFile(path, contents);
console.log('Local Google encryption keys initialized; existing values preserved.');
