#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const releasePath = resolve(root, 'packages/backend/src/evidence/workflows/source-relevance/release.json');

function canonical(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function fail(message) {
  process.stderr.write(`ERROR: ${message}\n`);
  return 1;
}

async function main() {
  if (process.argv.length !== 2) return fail('This verifier takes no arguments.');
  let release;
  try {
    release = JSON.parse(await readFile(releasePath, 'utf8'));
  } catch (error) {
    return fail(`Cannot read release.json: ${error.message}`);
  }
  if (!release || typeof release !== 'object' || Array.isArray(release)
      || release.schemaVersion !== 'contextflow-dify-release-v1'
      || release.operation !== 'SOURCE_RELEVANCE'
      || release.releaseId !== 'source-relevance-2026-10-24.1'
      || release.contractVersion !== 'source-relevance-v1'
      || release.modelProtocolVersion !== 'source-relevance-compact-model-v1'
      || release.promptTemplateVersion !== 'source-relevance-prompt-v2'
      || release.promptTemplateFile !== 'prompt.md'
      || release.workflowDslFile !== 'source-relevance-v1.yml'
      || release.runtimeFile !== 'scripts/dify/source_relevance_runtime.py'
      || release.inputVariable !== 'source_relevance_request_json'
      || release.outputVariable !== 'source_relevance_json'
      || release.apiKeyEnv !== 'DIFY_SOURCE_RELEVANCE_API_KEY'
      || release.publishedWorkflowIdEnv !== 'DIFY_SOURCE_RELEVANCE_PUBLISHED_WORKFLOW_ID'
      || release.configDigestEnv !== 'DIFY_SOURCE_RELEVANCE_CONFIG_SHA256'
      || release.target?.difyVersion !== '1.17.1'
      || release.target?.graphonVersion !== '0.7.0'
      || release.target?.dslVersion !== '0.7.0'
      || release.model?.provider !== 'langgenius/gemini/google'
      || release.model?.name !== 'gemini-3.8-flash'
      || release.model?.mode !== 'chat'
      || release.model?.completionParams?.max_output_tokens !== 4096
      || release.relevanceLimits?.maxCandidates !== 60
      || release.relevanceLimits?.candidateBytes !== 60000
      || release.relevanceLimits?.inputBytes !== 100000
      || release.relevanceLimits?.maxPassages !== 20
      || release.relevanceLimits?.outputBytes !== 40000) {
    return fail('release.json does not match the fixed source-relevance release contract.');
  }

  const entries = [
    ['promptSha256', resolve(dirname(releasePath), release.promptTemplateFile)],
    ['workflowDslSha256', resolve(dirname(releasePath), release.workflowDslFile)],
    ['runtimeSha256', resolve(root, release.runtimeFile)],
  ];
  const failures = [];
  for (const [field, path] of entries) {
    if (typeof release[field] !== 'string' || !/^[a-f0-9]{64}$/u.test(release[field])) {
      failures.push(`${field} is not a lowercase SHA-256 digest`);
      continue;
    }
    try {
      const actual = sha256(await readFile(path));
      if (actual !== release[field]) failures.push(`${field} mismatch (declared ${release[field]}, actual ${actual})`);
    } catch (error) {
      failures.push(`cannot read ${path}: ${error.message}`);
    }
  }
  if (typeof release.configDigest !== 'string' || !/^[a-f0-9]{64}$/u.test(release.configDigest)) {
    failures.push('configDigest is not a lowercase SHA-256 digest');
  } else {
    const { configDigest, workflowDslSha256, ...manifest } = release;
    const actual = sha256(Buffer.from(canonical(manifest), 'utf8'));
    if (actual !== configDigest) failures.push(`configDigest mismatch (declared ${configDigest}, actual ${actual})`);
  }
  if (failures.length) return fail(failures.join('\nERROR: '));

  process.stdout.write(`PASS: ${releasePath}\n`);
  process.stdout.write(`  target Dify ${release.target.difyVersion} / Graphon ${release.target.graphonVersion} / DSL ${release.target.dslVersion}\n`);
  process.stdout.write(`  release ${release.releaseId}\n`);
  process.stdout.write(`  model protocol ${release.modelProtocolVersion}\n`);
  process.stdout.write(`  promptSha256 ${release.promptSha256}\n`);
  process.stdout.write(`  workflowDslSha256 ${release.workflowDslSha256}\n`);
  process.stdout.write(`  runtimeSha256 ${release.runtimeSha256}\n`);
  process.stdout.write(`  configDigest ${release.configDigest}\n`);
  process.stdout.write('Offline metadata and hash verification only; no published workflow or live provider was checked.\n');
  return 0;
}

main().then((code) => { process.exitCode = code; }).catch((error) => {
  process.stderr.write(`ERROR: ${error.message}\n`);
  process.exitCode = 1;
});
