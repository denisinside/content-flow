import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
const directory = new URL('../../packages/backend/src/evidence/workflows/source-writing/',import.meta.url);
const release = JSON.parse(readFileSync(new URL('release.json',directory),'utf8'));
const digest = value => createHash('sha256').update(value).digest('hex');
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}
for (const [path,expected] of [[new URL(release.workflowDslFile,directory),release.workflowDslSha256],
  [new URL(release.promptTemplateFile,directory),release.promptSha256],
  [new URL('../../'+release.runtimeFile,import.meta.url),release.runtimeSha256]]) {
  if (digest(readFileSync(path)) !== expected) throw new Error('Source-writing controlled artifact hash mismatch');
}
const { configDigest,...configuration } = release;
if (digest(canonical(configuration)) !== configDigest) throw new Error('Source-writing release configuration digest mismatch');
const provider = readFileSync(new URL('../../packages/backend/src/evidence/writing-provider.ts',import.meta.url),'utf8');
if (!provider.includes(`configDigest: '${configDigest}'`) || !provider.includes(`releaseId: '${release.releaseId}'`)) throw new Error('Source-writing provider pin differs from controlled release');
process.stdout.write(`Source-writing release verified: ${release.releaseId}\n`);
