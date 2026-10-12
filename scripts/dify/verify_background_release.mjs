import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
const base = new URL('../../packages/backend/src/visuals/workflows/background-generation/',import.meta.url);
const release = JSON.parse(await readFile(new URL('release.json',base),'utf8'));
const hash = value => createHash('sha256').update(value).digest('hex');
function canonical(value) {if(Array.isArray(value))return '['+value.map(canonical).join(',')+']';if(value&&typeof value==='object')return '{'+Object.keys(value).sort().map(key=>JSON.stringify(key)+':'+canonical(value[key])).join(',')+'}';return JSON.stringify(value);}
for(const [file,digest] of [[new URL(release.promptTemplateFile,base),release.promptSha256],[new URL(release.workflowDslFile,base),release.workflowDslSha256],[new URL('../../'+release.runtimeFile,import.meta.url),release.runtimeSha256]])if(hash(await readFile(file))!==digest)throw Error('Background release artifact hash mismatch');
const {configDigest,...input}=release;if(hash(canonical(input))!==configDigest)throw Error('Background configuration digest mismatch');
console.log('Background prompt/runtime/DSL/config hashes verified:',configDigest);
