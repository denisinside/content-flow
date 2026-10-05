import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
const root = new URL('../../', import.meta.url);
const directory = new URL('packages/backend/src/editorial/workflows/outline-generation/', root);
const sha = value => createHash('sha256').update(value).digest('hex');
function canonical(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
}
const release = JSON.parse(await readFile(new URL('release.json', directory), 'utf8'));
const { configDigest, ...unsigned } = release;
if (release.operation !== 'OUTLINE_GENERATION' || release.contractVersion !== 'outline-v1'
  || release.promptTemplateFile !== 'prompt.md' || release.workflowDslFile !== 'outline-generation-v1.yml'
  || release.inputVariable !== 'editorial_json' || release.outputVariable !== 'outline_json'
  || sha(await readFile(new URL('prompt.md', directory))) !== release.promptSha256
  || sha(await readFile(new URL(release.workflowDslFile, directory))) !== release.workflowDslSha256
  || sha(canonical(unsigned)) !== configDigest) throw new Error('Outline release integrity check failed');
const provider = await readFile(new URL('packages/backend/src/editorial/provider.ts', root), 'utf8');
for (const [key, value] of Object.entries({ releaseId: release.releaseId, configDigest,
  workflowDslSha256: release.workflowDslSha256 })) {
  if (!provider.includes(`${key}: '${value}'`)) throw new Error(`Outline provider pin mismatch: ${key}`);
}
console.log('Outline prompt, DSL, release digest and runtime pins verified.');
