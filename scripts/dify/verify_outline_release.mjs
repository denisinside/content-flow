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
if (release.schemaVersion !== 'contextflow-dify-release-v1'
  || release.operation !== 'OUTLINE_GENERATION' || release.contractVersion !== 'outline-v1'
  || release.promptTemplateFile !== 'prompt.md' || release.workflowDslFile !== 'outline-generation-v1.yml'
  || release.promptTemplateVersion !== 'outline-generation-reviewed-prompt-v2'
  || release.runtimeFile !== 'scripts/dify/outline_generation_runtime.py'
  || release.reportVariable !== 'outline_report' || release.reportSchemaVersion !== 'outline-review-report-v1'
  || release.target?.difyVersion !== '1.17.1' || release.target?.graphonVersion !== '0.7.0'
  || release.target?.dslVersion !== '0.7.0' || release.responseMode !== 'streaming'
  || release.inputVariable !== 'editorial_json' || release.outputVariable !== 'outline_json'
  || sha(await readFile(new URL('prompt.md', directory))) !== release.promptSha256
  || sha(await readFile(new URL(release.workflowDslFile, directory))) !== release.workflowDslSha256
  || sha(await readFile(new URL(release.runtimeFile, root))) !== release.runtimeSha256
  || sha(canonical(unsigned)) !== configDigest) throw new Error('Outline release integrity check failed');
const provider = await readFile(new URL('packages/backend/src/editorial/provider.ts', root), 'utf8');
for (const [key, value] of Object.entries({ releaseId: release.releaseId, configDigest, promptTemplateVersion: release.promptTemplateVersion,
  workflowDslSha256: release.workflowDslSha256 })) {
  const values = [...provider.matchAll(new RegExp(`${key}:\\s*['"]([^'"]+)['"]`, 'g'))].map(match => match[1]);
  if (values.length !== 1 || values[0] !== value) throw new Error(`Outline provider pin mismatch: ${key}`);
}
for (const path of ['packages/backend/src/editorial/provider.spec.ts', 'tests/integration/outline-generation.test.ts']) {
  const source = await readFile(new URL(path, root), 'utf8');
  if (!source.includes('release.json') || !source.includes("'configDigest'") && !source.includes('descriptor.configDigest'))
    throw new Error(`Outline test release descriptor mapping missing: ${path}`);
}
console.log('Outline prompt, DSL, embedded runtime, report contract, release digest and provider/test pins verified.');
console.log('Read-only verification only; published Dify configuration and live model behavior are unverified.');
