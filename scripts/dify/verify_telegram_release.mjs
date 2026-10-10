import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
const root = new URL('../../', import.meta.url);
const directory = new URL('packages/backend/src/editorial/workflows/telegram-generation/', root);
const sha = value => createHash('sha256').update(value).digest('hex');
function canonical(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
}
const release = JSON.parse(await readFile(new URL('release.json', directory), 'utf8'));
const { configDigest, ...unsigned } = release;
if (release.operation !== 'TELEGRAM_GENERATION' || release.contractVersion !== 'telegram-v1'
  || release.promptTemplateFile !== 'prompt.md' || release.workflowDslFile !== 'telegram-generation-v1.yml'
  || release.inputVariable !== 'editorial_json' || release.outputVariable !== 'telegram_json'
  || sha(await readFile(new URL('prompt.md', directory))) !== release.promptSha256
  || sha(await readFile(new URL(release.workflowDslFile, directory))) !== release.workflowDslSha256
  || release.runtimeFile !== 'scripts/dify/telegram_generation_runtime.py'
  || sha(await readFile(new URL(release.runtimeFile, root))) !== release.runtimeSha256
  || release.reportSchemaVersion !== 'telegram-editorial-report-v1' || release.reportVariable !== 'telegram_report'
  || release.telegramLimits.deadlineMs !== 600000 || release.telegramLimits.maxModelCalls !== 4
  || sha(canonical(unsigned)) !== configDigest) throw new Error('Telegram release integrity check failed');
const provider = await readFile(new URL('packages/backend/src/editorial/telegram-provider.ts', root), 'utf8');
for (const [key, value] of Object.entries({ releaseId: release.releaseId, configDigest, promptTemplateVersion: release.promptTemplateVersion,
  workflowDslSha256: release.workflowDslSha256 })) {
  if (!provider.includes(`${key}: '${value}'`)) throw new Error(`Telegram provider pin mismatch: ${key}`);
}
console.log('Telegram prompt, runtime, DSL, report contract, release digest and provider pins verified.');
