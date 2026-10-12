import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
const root = new URL('../../', import.meta.url);
const directory = new URL('packages/backend/src/editorial/workflows/adaptation-generation/', root);
const sha = value => createHash('sha256').update(value).digest('hex');
function canonical(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}';
}
const release = JSON.parse(await readFile(new URL('release.json', directory), 'utf8'));
const { configDigest, ...unsigned } = release;
if (release.operation !== 'ADAPTATION_GENERATION' || release.contractVersion !== 'adaptation-v1'
  || release.releaseId !== 'adaptation-generation-2026-10-12.1'
  || release.promptTemplateVersion !== 'adaptation-generation-v2'
  || release.promptTemplateFile !== 'prompt.md' || release.workflowDslFile !== 'adaptation-generation-v1.yml'
  || release.inputVariable !== 'editorial_json' || release.outputVariable !== 'adaptation_json'
  || sha(await readFile(new URL('prompt.md', directory))) !== release.promptSha256
  || sha(await readFile(new URL(release.workflowDslFile, directory))) !== release.workflowDslSha256
  || release.runtimeFile !== 'scripts/dify/adaptation_generation_runtime.py'
  || sha(await readFile(new URL(release.runtimeFile, root))) !== release.runtimeSha256
  || release.reportSchemaVersion !== 'adaptation-editorial-report-v1' || release.reportVariable !== 'adaptation_report'
  || release.adaptationLimits.deadlineMs !== 600000 || release.adaptationLimits.maxModelCalls !== 4
  || release.adaptationLimits.maxScriptFrames !== 30 || release.adaptationLimits.maxScriptFrameTextUtf16 !== 3000
  || release.adaptationLimits.maxScriptTextUtf16 !== 30000 || release.adaptationLimits.maxScriptMappings !== 100
  || release.adaptationLimits.maxScriptBytes !== 200000 || release.adaptationLimits.maxScriptPurposeChars !== 200
  || release.adaptationLimits.maxScriptVisualHintChars !== 1000 || release.adaptationLimits.maxScriptTransitionChars !== 300
  || release.adaptationLimits.maxOutputBytes !== 360000 || release.adaptationLimits.maxStateBytes !== 750000
  || sha(canonical(unsigned)) !== configDigest) throw new Error('Shared adaptation release integrity check failed');
const provider = await readFile(new URL('packages/backend/src/editorial/telegram-provider.ts', root), 'utf8');
for (const [key, value] of Object.entries({ releaseId: release.releaseId, configDigest, promptTemplateVersion: release.promptTemplateVersion,
  workflowDslSha256: release.workflowDslSha256 })) {
  if (!provider.includes(key + ": '" + value + "'")) throw new Error('Adaptation provider pin mismatch: ' + key);
}
console.log('Shared adaptation prompt, runtime, DSL, report contract, release digest and provider pins verified.');
