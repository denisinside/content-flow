/** Opt-in direct Gemini probes. Reads only the explicitly supplied key variable. */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

const args = process.argv.slice(2);
const option = name => args.includes(name) ? args[args.indexOf(name) + 1] : undefined;
if (!args.includes('--live') || !option('--env-file')) throw new Error('Requires --live and --env-file');
const source = await readFile(option('--env-file'), 'utf8');
const assignment = source.match(/^\s*(?:export\s+)?GEMINI_API_KEY\s*=\s*(.*)$/mu)?.[1]?.trim();
if (!assignment) throw new Error('GEMINI_API_KEY is missing');
const key = /^(["']).*\1$/u.test(assignment) ? assignment.slice(1, -1) : assignment.replace(/\s+#.*$/u, '').trim();
if (!key || /[\r\n]/u.test(key)) throw new Error('GEMINI_API_KEY is empty or invalid');
const sanitize = value => String(value).replaceAll(key, '[redacted]').slice(0, 3000);
const destination = option('--output-dir') ? pathToFileURL(resolve(option('--output-dir')) + sep)
  : new URL('../../docs/live-dify-2026-10-09/', import.meta.url);
const schemas = JSON.parse(await readFile(option('--schema-file') ?? new URL('gemini-schemas.json', destination), 'utf8'));
await mkdir(destination, { recursive: true });
const model = 'gemini-3.8-flash';
const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${model}`;
const results = [];
const loosen = (value, fields = ['minLength', 'maxLength', 'minItems', 'maxItems']) => Array.isArray(value) ? value.map(child => loosen(child, fields)) : value && typeof value === 'object'
  ? Object.fromEntries(Object.entries(value).filter(([key]) => !fields.includes(key)).map(([key, child]) => [key, loosen(child, fields)])) : value;

async function request(id, schema, streaming = false, metadata = false) {
  const startedAt = new Date().toISOString();
  const generationConfig = { maxOutputTokens: 8192, thinkingConfig: { thinkingLevel: 'LOW', includeThoughts: false } };
  if (schema) Object.assign(generationConfig, { responseMimeType: 'application/json', responseJsonSchema: schema });
  const body = { contents: [{ role: 'user', parts: [{ text: schema
    ? 'Return the smallest valid JSON matching the schema. Use empty arrays where allowed. For mandatory text use test. For hashes use 64 lowercase a characters. No explanation.'
    : 'Reply with exactly GEMINI_KEY_OK.' }] }], generationConfig };
  const receipt = { id, model, startedAt, transport: metadata ? 'GET model' : streaming ? 'streamGenerateContent' : 'generateContent',
    schemaSha256: schema ? createHash('sha256').update(JSON.stringify(schema)).digest('hex') : null };
  try {
    const response = await fetch(metadata ? endpoint : `${endpoint}:${streaming ? 'streamGenerateContent?alt=sse' : 'generateContent'}`, {
      method: metadata ? 'GET' : 'POST', redirect: 'error', signal: AbortSignal.timeout(180000),
      headers: { 'x-goog-api-key': key, 'Content-Type': 'application/json' }, ...(metadata ? {} : { body: JSON.stringify(body) }),
    });
    receipt.httpStatus = response.status;
    const raw = await response.text();
    if (!response.ok) {
      const value = JSON.parse(raw); receipt.error = { code: value.error?.code, status: value.error?.status, message: sanitize(value.error?.message ?? raw) };
    } else if (metadata) {
      const value = JSON.parse(raw); receipt.returnedModel = value.name; receipt.supportedGenerationMethods = value.supportedGenerationMethods;
    } else {
      const chunks = streaming ? raw.split(/\r?\n\r?\n/u).map(event => event.split(/\r?\n/u).filter(line => line.startsWith('data:')).map(line => line.slice(5).trim()).join('\n')).filter(Boolean).map(text => JSON.parse(text)) : [JSON.parse(raw)];
      const error = chunks.find(chunk => chunk.error)?.error;
      if (error) receipt.error = { code: error.code, status: error.status, message: sanitize(error.message) };
      receipt.text = sanitize(chunks.flatMap(chunk => chunk.candidates?.[0]?.content?.parts ?? []).filter(part => !part.thought).map(part => part.text ?? '').join(''));
      receipt.finishReason = chunks.map(chunk => chunk.candidates?.[0]?.finishReason).filter(Boolean).at(-1) ?? null;
      receipt.usage = chunks.map(chunk => chunk.usageMetadata).filter(Boolean).at(-1) ?? null;
      receipt.returnedModelVersion = chunks.map(chunk => chunk.modelVersion).filter(Boolean).at(-1) ?? null;
      if (schema && receipt.text) { try { receipt.parsedOutput = JSON.parse(receipt.text); } catch { receipt.invalidJson = true; } }
    }
    receipt.verdict = response.ok && !receipt.error && (metadata || receipt.finishReason === 'STOP' && receipt.text && !receipt.invalidJson) ? 'pass' : 'fail';
  } catch (error) { receipt.verdict = 'inconclusive'; receipt.error = { message: sanitize(error.message) }; }
  receipt.finishedAt = new Date().toISOString();
  results.push(receipt);
  await writeFile(new URL(`gemini-${id}.json`, destination), JSON.stringify(receipt, null, 2) + '\n');
  console.log(JSON.stringify({ id, verdict: receipt.verdict, httpStatus: receipt.httpStatus, error: receipt.error, text: receipt.text, usage: receipt.usage }));
  return receipt;
}

if (args.includes('--isolate-max-items')) {
  for (const [id, schema] of Object.entries(schemas).filter(([id]) => id !== 'outline-strategist')) {
    await request(id + '-without-max-items', loosen(schema, ['maxItems']), true);
  }
} else if (args.includes('--isolate-bounds')) {
  for (const [id, schema] of Object.entries(schemas).filter(([id]) => id !== 'outline-strategist')) {
    await request(id + '-without-string-bounds', loosen(schema, ['minLength', 'maxLength']), true);
    await request(id + '-without-array-bounds', loosen(schema, ['minItems', 'maxItems']), true);
  }
} else {
  const info = await request('model-access', null, false, true);
  if (info.verdict !== 'pass') { process.exitCode = 1; }
  else {
    const plain = await request('plain', null);
    if (plain.verdict !== 'pass') process.exitCode = 1;
    else {
      for (const [id, schema] of Object.entries(schemas)) {
        const exact = await request(id + '-exact', schema, true);
        if (exact.httpStatus === 400) await request(id + '-without-bounds', loosen(schema), true);
      }
    }
  }
}
const summaryName = args.includes('--isolate-max-items') ? 'gemini-summary-max-items.json' : args.includes('--isolate-bounds') ? 'gemini-summary-bounds.json' : 'gemini-summary.json';
await writeFile(new URL(summaryName, destination), JSON.stringify({ model, startedAt: results[0].startedAt,
  requests: results.length, pass: results.filter(r => r.verdict === 'pass').length, fail: results.filter(r => r.verdict === 'fail').length,
  inconclusive: results.filter(r => r.verdict === 'inconclusive').length, results }, null, 2) + '\n');
