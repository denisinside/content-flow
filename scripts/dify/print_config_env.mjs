import { readFile } from 'node:fs/promises';

const root = new URL('../../', import.meta.url);
for (const path of ['packages/backend/src/claims/workflows/claim-extraction/release.json',
  'packages/backend/src/editorial/workflows/outline-generation/release.json',
  'packages/backend/src/editorial/workflows/article-generation/release.json']) {
  const release = JSON.parse(await readFile(new URL(path, root), 'utf8'));
  if (!/^DIFY_[A-Z_]+_CONFIG_SHA256$/u.test(release.configDigestEnv) || !/^[a-f0-9]{64}$/u.test(release.configDigest))
    throw new Error('Invalid workflow configuration digest descriptor');
  console.log(`${release.configDigestEnv}=${release.configDigest}`);
}
