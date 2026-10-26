import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

const base = new URL('../../packages/backend/src/evidence/workflows/source-embedding/', import.meta.url);
const release = JSON.parse(readFileSync(new URL('release.json', base), 'utf8'));
const { configDigest, workflowDslSha256, ...configuration } = release;
function canonical(value) {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value !== null && typeof value === 'object') return '{' + Object.keys(value).sort()
    .map(key => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}';
  return JSON.stringify(value);
}
const sha256 = value => createHash('sha256').update(value).digest('hex');
const dsl = readFileSync(new URL('source-embedding-v1.yml', base));
if (sha256(dsl) !== workflowDslSha256 || sha256(canonical(configuration)) !== configDigest) {
  throw new Error('Source embedding release artifact hashes do not match');
}
const provider = readFileSync(new URL('../../packages/backend/src/evidence/embedding-provider.ts', import.meta.url), 'utf8');
const contracts = readFileSync(new URL('../../packages/backend/src/evidence/contracts.ts', import.meta.url), 'utf8');
if (!provider.includes(`configDigest: '${configDigest}'`) || !provider.includes(`releaseId: '${release.releaseId}'`)
  || release.provider.model !== 'gemini-embedding-001' || release.provider.dimensions !== 768
  || !contracts.includes("EMBEDDING_MODEL = 'gemini-embedding-001'") || !contracts.includes('EMBEDDING_DIMENSIONS = 768')
  || release.provider.autoTruncate !== false || release.contract.maxTexts !== 16 || release.contract.maxTextUtf8Bytes !== 1536
  || release.target.graphonVersion !== '0.7.0' || release.target.difyVersion !== '1.17.1') {
  throw new Error('Source embedding release and backend contract pins do not match');
}
console.log(JSON.stringify({ releaseId: release.releaseId, configDigest, workflowDslSha256,
  verification: 'local artifact and backend pins only; no remote publication attestation' }));
