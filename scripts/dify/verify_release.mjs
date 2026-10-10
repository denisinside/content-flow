#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const releasePath = resolve(repoRoot, 'packages/backend/src/claims/workflows/claim-extraction/release.json');

function canonical(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) {
    process.stdout.write('Usage: node scripts/dify/verify_release.mjs\n');
    return 0;
  }
  if (args.length > 0) {
    process.stderr.write('ERROR: this checker verifies the canonical ContentFlow claim-extraction release and its runtime/test pins; it takes no path arguments.\n');
    return 2;
  }

  let release;
  try {
    release = JSON.parse(await readFile(releasePath, 'utf8'));
  } catch (error) {
    process.stderr.write(`ERROR: cannot read valid JSON from ${releasePath}: ${error.message}\n`);
    return 1;
  }
  if (!release || typeof release !== 'object' || Array.isArray(release)
      || release.schemaVersion !== 'contextflow-dify-release-v1') {
    process.stderr.write('ERROR: input is not a ContentFlow Dify API release descriptor.\n');
    return 1;
  }
  if (release.promptTemplateFile !== 'prompt.md') {
    process.stderr.write('ERROR: this verifier expects promptTemplateFile to be exactly "prompt.md".\n');
    return 1;
  }
  if (release.promptTemplateVersion !== 'claims-extraction-review-prompt-v2'
      || release.runtimeFile !== 'scripts/dify/claim_extraction_runtime.py'
      || typeof release.runtimeSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(release.runtimeSha256)
      || release.operation !== 'CLAIM_EXTRACTION' || release.contractVersion !== 'claims-v1'
      || release.inputVariable !== 'sources_json' || release.outputVariable !== 'claims_json'
      || release.target?.difyVersion !== '1.17.1' || release.target?.graphonVersion !== '0.7.0'
      || release.reportVariable !== 'extraction_report' || release.reportSchemaVersion !== 'claims-extraction-report-v1') {
    process.stderr.write('ERROR: release.json has an incompatible prompt/runtime/report contract.\n');
    return 1;
  }
  if (typeof release.promptSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(release.promptSha256)) {
    process.stderr.write('ERROR: release.json has no valid lowercase SHA-256 promptSha256.\n');
    return 1;
  }
  if (typeof release.configDigest !== 'string' || !/^[a-f0-9]{64}$/.test(release.configDigest)) {
    process.stderr.write('ERROR: release.json has no valid lowercase SHA-256 configDigest.\n');
    return 1;
  }
  if (release.workflowDslFile !== 'claim-extraction-v1.yml'
      || typeof release.workflowDslSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(release.workflowDslSha256)) {
    process.stderr.write('ERROR: release.json has no recognized workflowDslFile and valid lowercase SHA-256 workflowDslSha256.\n');
    return 1;
  }
  if (typeof release.releaseId !== 'string' || !release.releaseId) {
    process.stderr.write('ERROR: release.json has no releaseId.\n');
    return 1;
  }

  const promptPath = resolve(dirname(releasePath), 'prompt.md');
  let promptBytes;
  try {
    promptBytes = await readFile(promptPath);
  } catch (error) {
    process.stderr.write(`ERROR: cannot read ${promptPath}: ${error.message}\n`);
    return 1;
  }
  const actualPrompt = sha256(promptBytes);
  const workflowDslPath = resolve(dirname(releasePath), release.workflowDslFile);
  let workflowDslBytes;
  try {
    workflowDslBytes = await readFile(workflowDslPath);
  } catch (error) {
    process.stderr.write(`ERROR: cannot read ${workflowDslPath}: ${error.message}\n`);
    return 1;
  }
  const actualWorkflowDsl = sha256(workflowDslBytes);
  const actualRuntime = sha256(await readFile(resolve(repoRoot, release.runtimeFile)));
  const { configDigest, ...unsigned } = release;
  const actualConfig = sha256(Buffer.from(canonical(unsigned), 'utf8'));
  const failures = [];
  if (actualPrompt !== release.promptSha256) {
    failures.push(`promptSha256 mismatch (declared ${release.promptSha256}, actual ${actualPrompt})`);
  }
  if (actualWorkflowDsl !== release.workflowDslSha256) {
    failures.push(`workflowDslSha256 mismatch (declared ${release.workflowDslSha256}, actual ${actualWorkflowDsl})`);
  }
  if (actualRuntime !== release.runtimeSha256) {
    failures.push(`runtimeSha256 mismatch (declared ${release.runtimeSha256}, actual ${actualRuntime})`);
  }
  if (actualConfig !== configDigest) {
    failures.push(`configDigest mismatch (declared ${configDigest}, actual ${actualConfig})`);
  }

  const pins = [
    {
      label: 'provider.ts promptTemplateVersion',
      path: 'packages/backend/src/claims/provider.ts',
      pattern: /promptTemplateVersion:\s*['"]([^'"]+)['"]/g,
      expected: release.promptTemplateVersion,
    },
    {
      label: 'provider.ts releaseId',
      path: 'packages/backend/src/claims/provider.ts',
      pattern: /releaseId:\s*['"]([^'"]+)['"]/g,
      expected: release.releaseId,
    },
    {
      label: 'provider.ts configDigest',
      path: 'packages/backend/src/claims/provider.ts',
      pattern: /configDigest:\s*['"]([a-f0-9]{64})['"]/g,
      expected: configDigest,
    },
    {
      label: 'provider.ts workflowDslSha256',
      path: 'packages/backend/src/claims/provider.ts',
      pattern: /workflowDslSha256:\s*['"]([a-f0-9]{64})['"]/g,
      expected: release.workflowDslSha256,
    },
    {
      label: 'provider.spec.ts test config digest',
      path: 'packages/backend/src/claims/provider.spec.ts',
      pattern: /DIFY_CLAIM_EXTRACTION_CONFIG_SHA256:\s*['"]([a-f0-9]{64})['"]/g,
      expected: configDigest,
    },
    {
      label: 'claim-extraction integration test config digest',
      path: 'tests/integration/claim-extraction.test.ts',
      pattern: /const configDigest\s*=\s*['"]([a-f0-9]{64})['"]/g,
      expected: configDigest,
    },
    {
      label: 'claim-extraction integration test releaseId',
      path: 'tests/integration/claim-extraction.test.ts',
      pattern: /releaseId:\s*['"]([^'"]+)['"]/g,
      expected: release.releaseId,
    },
  ];
  for (const pin of pins) {
    let source;
    try {
      source = await readFile(resolve(repoRoot, pin.path), 'utf8');
    } catch (error) {
      failures.push(`cannot read ${pin.path}: ${error.message}`);
      continue;
    }
    const values = [...source.matchAll(pin.pattern)].map((match) => match[1]);
    if (values.length !== 1 || values[0] !== pin.expected) {
      failures.push(`${pin.label} must have exactly one value equal to ${pin.expected}; found ${values.length ? values.join(', ') : 'none'}`);
    }
  }

  if (failures.length) {
    for (const failure of failures) process.stderr.write(`ERROR: ${failure}\n`);
    return 1;
  }

  process.stdout.write(`PASS: ${releasePath}\n`);
  process.stdout.write(`  promptSha256 ${actualPrompt}\n`);
  process.stdout.write(`  workflowDslSha256 ${actualWorkflowDsl}\n`);
  process.stdout.write(`  runtimeSha256 ${actualRuntime}\n`);
  process.stdout.write(`  configDigest ${actualConfig}\n`);
  process.stdout.write('  runtime release and test pins match\n');
  process.stdout.write('Read-only verification only; this does not verify a published or live Dify workflow.\n');
  return 0;
}

main().then((code) => { process.exitCode = code; }).catch((error) => {
  process.stderr.write(`ERROR: ${error.message}\n`);
  process.exitCode = 1;
});
