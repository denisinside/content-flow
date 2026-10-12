import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
const root = new URL('../../', import.meta.url);
const directory = new URL('packages/backend/src/editorial/workflows/telegram-generation/', root);
const sha = value => createHash('sha256').update(value).digest('hex');
function canonical(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}';
}
const release = JSON.parse(await readFile(new URL('release.json', directory), 'utf8'));
const { configDigest, ...unsigned } = release;
if (release.operation !== 'TELEGRAM_GENERATION' || release.contractVersion !== 'telegram-v1'
  || release.promptTemplateFile !== 'prompt.md' || release.workflowDslFile !== 'telegram-generation-v1.yml'
  || sha(await readFile(new URL('prompt.md', directory))) !== release.promptSha256
  || sha(await readFile(new URL(release.workflowDslFile, directory))) !== release.workflowDslSha256
  || release.runtimeFile !== 'scripts/dify/telegram_generation_runtime.py'
  || sha(await readFile(new URL(release.runtimeFile, root))) !== release.runtimeSha256
  || release.target?.difyVersion !== '1.17.1' || release.target?.graphonVersion !== '0.7.0'
  || release.telegramLimits?.maxModelCalls !== 4 || sha(canonical(unsigned)) !== configDigest) {
  throw new Error('Legacy Telegram release files do not match their preserved descriptor');
}
console.log('Legacy Telegram prompt/runtime/DSL hashes and API release descriptor remain intact; this release is retired from the current provider.');
