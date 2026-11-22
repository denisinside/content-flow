import { readFileSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { DifyOutlineProvider, OutlineProviderError, outlineWorkflowRelease, outlineWorkflowSettings, type OutlineProviderInput } from './provider.js';
import { canonicalManifestHash } from '../jobs/job-service.js';

const directory = new URL('./workflows/outline-generation/', import.meta.url);
const release = JSON.parse(readFileSync(new URL('release.json', directory), 'utf8')) as Record<string, string>;
const env = { NODE_ENV: 'test', DIFY_API_BASE_URL: 'https://dify.example.test/v1',
  DIFY_OUTLINE_GENERATION_PUBLISHED_WORKFLOW_ID: randomUUID(), DIFY_OUTLINE_GENERATION_API_KEY: 'synthetic-outline-key',
  DIFY_OUTLINE_GENERATION_CONFIG_SHA256: release['configDigest'] };
const input = (): OutlineProviderInput => ({ schemaVersion: 'outline-context-v1', contentMode: 'CREATIVE',
  brief: { topic: 'Тема' }, style: { brandbook: '', tone: '', settings: {} }, claims: [], context: [] });
const output = { schemaVersion: 'outline-v1', content: { title: 'Структура',
  sections: [{ title: 'Розділ', purpose: 'Пояснити тему', claimRevisionIds: [] }] } };
const readyReport = JSON.stringify({ schemaVersion: 'outline-review-report-v1', status: 'ready' });
const validOutputs = () => ({ outline_json: JSON.stringify(output), outline_report: readyReport });
function completion(outputs: Record<string, unknown>, runId: string, metadata = ''): Response {
  return new Response(`data: ${JSON.stringify({ event: 'node_finished', workflow_run_id: runId, data: { metadata } })}\n\n`
    + `data: ${JSON.stringify({ event: 'workflow_finished', workflow_run_id: runId, data: {
      workflow_id: env.DIFY_OUTLINE_GENERATION_PUBLISHED_WORKFLOW_ID, status: 'succeeded', outputs } })}\n\n`,
  { headers: { 'content-type': 'text/event-stream' } });
}
async function consume(outputs: Record<string, unknown>, route: 'stream' | 'detail', metadata = '') {
  const runId = randomUUID(), settings = outlineWorkflowSettings(env);
  const provider = new DifyOutlineProvider(async () => route === 'stream' ? completion(outputs, runId, metadata)
    : new Response(JSON.stringify({ id: runId, workflow_id: settings.workflowId, status: 'succeeded', outputs, metadata }),
      { headers: { 'content-type': 'application/json' } }));
  return route === 'stream'
    ? provider.execute(settings, randomUUID(), input(), new AbortController().signal, async () => {}, async () => {})
    : provider.resume(settings, runId, new AbortController().signal);
}
describe('controlled outline workflow boundary', () => {
  it('uses one DIFY mapping in development, test and production', () => {
    for (const NODE_ENV of ['development', 'test', 'production']) {
      expect(outlineWorkflowSettings({ ...env, NODE_ENV })).toMatchObject({
        apiKey: env.DIFY_OUTLINE_GENERATION_API_KEY, workflowId: env.DIFY_OUTLINE_GENERATION_PUBLISHED_WORKFLOW_ID,
        configDigest: env.DIFY_OUTLINE_GENERATION_CONFIG_SHA256,
      });
    }
  });
  it('pins the exact prompt, native graph and complete configuration without secrets', () => {
    const hash = (name: string) => createHash('sha256').update(readFileSync(new URL(name, directory))).digest('hex');
    expect(hash('prompt.md')).toBe(release['promptSha256']);
    expect(hash('outline-generation-v1.yml')).toBe(release['workflowDslSha256']);
    expect(createHash('sha256').update(readFileSync(new URL('../../../../scripts/dify/outline_generation_runtime.py', import.meta.url))).digest('hex')).toBe(release['runtimeSha256']);
    expect(release['reportVariable']).toBe('outline_report');
    expect(release['reportSchemaVersion']).toBe('outline-review-report-v1');
    const { configDigest, ...unsigned } = release;
    expect(canonicalManifestHash(unsigned)).toBe(configDigest);
    expect(outlineWorkflowRelease(env)).toMatchObject({ configDigest, contractVersion: 'outline-v1', releaseId: release['releaseId'] });
    expect(outlineWorkflowRelease(env)).not.toHaveProperty('apiKey');
  });
  it('requires outline credentials and a matching release attestation', () => {
    expect(() => outlineWorkflowSettings({ ...env, DIFY_OUTLINE_GENERATION_CONFIG_SHA256: '0'.repeat(64) })).toThrow(OutlineProviderError);
    expect(() => outlineWorkflowSettings({ ...env, DIFY_OUTLINE_GENERATION_API_KEY: '' })).toThrow(OutlineProviderError);
    expect(() => outlineWorkflowRelease({ ...env, DIFY_API_BASE_URL: 'https://user:secret@dify.example.test/v1' })).toThrow(OutlineProviderError);
  });
  it('does not issue a provider request when the transactional submission guard fails', async () => {
    let calls = 0;
    const provider = new DifyOutlineProvider(async () => { calls++; throw new Error('Transport must not be called'); });
    await expect(provider.execute(outlineWorkflowSettings(env), randomUUID(), { schemaVersion: 'outline-context-v1',
      contentMode: 'CREATIVE', brief: { topic: 'Тема' }, style: { brandbook: '', tone: '', settings: {} }, claims: [], context: [] },
      new AbortController().signal, async () => { throw new Error('Evidence withdrawn'); }, async () => {})).rejects.toThrow('Evidence withdrawn');
    expect(calls).toBe(0);
  });
  it('accepts a ready reviewed outline on streaming completion and captured-run reconciliation', async () => {
    for (const route of ['stream', 'detail'] as const) expect((await consume(validOutputs(), route)).output).toEqual(output);
  });
  it('requires a bounded JSON-string report with the exact review contract on both paths', async () => {
    for (const route of ['stream', 'detail'] as const) {
      for (const report of [undefined, '', '{', {}, JSON.stringify({ status: 'ready' }),
        JSON.stringify({ schemaVersion: 'outline-review-report-v1', status: 'approved' }),
        JSON.stringify({ schemaVersion: 'outline-review-report-v1', status: 'ready', notes: 'x'.repeat(256000) })]) {
        await expect(consume({ outline_json: JSON.stringify(output), outline_report: report }, route))
          .rejects.toMatchObject({ code: 'INCOMPATIBLE_CONTRACT', outcome: 'KNOWN_FAILED' });
      }
    }
  });
  it('rejects unresolved review before reading the candidate without leaking private findings', async () => {
    for (const route of ['stream', 'detail'] as const) {
      const report = JSON.stringify({ schemaVersion: 'outline-review-report-v1', status: 'needs_human', findings: ['private fixture finding'] });
      let failure: unknown;
      try { await consume({ outline_json: 'deliberately invalid candidate', outline_report: report }, route); } catch (error) { failure = error; }
      expect(failure).toMatchObject({ code: 'PROVIDER_FAILED', outcome: 'KNOWN_FAILED' });
      expect(String(failure)).not.toContain('private fixture finding');
    }
  });
  it('counts UTF-8 input bytes and rejects over capacity before submission intent', async () => {
    let submissions = 0, calls = 0;
    const provider = new DifyOutlineProvider(async () => { calls++; return completion(validOutputs(), randomUUID()); });
    const exact = input(), remaining = 350000 - Buffer.byteLength(JSON.stringify(exact));
    exact.style.tone = 'ї'.repeat(Math.floor(remaining / 2)) + (remaining % 2 ? 'x' : '');
    expect(Buffer.byteLength(JSON.stringify(exact))).toBe(350000);
    await provider.execute(outlineWorkflowSettings(env), randomUUID(), exact, new AbortController().signal,
      async () => { submissions++; }, async () => {});
    const tooLarge = { ...exact, style: { ...exact.style, tone: exact.style.tone + 'x' } };
    await expect(provider.execute(outlineWorkflowSettings(env), randomUUID(), tooLarge, new AbortController().signal,
      async () => { submissions++; }, async () => {})).rejects.toMatchObject({ code: 'INVALID_INPUT', outcome: 'NOT_SUBMITTED' });
    expect(submissions).toBe(1); expect(calls).toBe(1);
  });
  it('allows repeated native Loop metadata without relaxing final candidate bounds', async () => {
    expect((await consume(validOutputs(), 'stream', 'x'.repeat(3 * 1024 * 1024))).output).toEqual(output);
    expect((await consume(validOutputs(), 'detail', 'x'.repeat(1024 * 1024))).output).toEqual(output);
    for (const route of ['stream', 'detail'] as const) {
      const serialized = JSON.stringify(output), exact = serialized + ' '.repeat(350000 - Buffer.byteLength(serialized));
      expect((await consume({ outline_json: exact, outline_report: readyReport }, route)).output).toEqual(output);
      await expect(consume({ outline_json: exact + ' ', outline_report: readyReport }, route))
        .rejects.toMatchObject({ code: 'INCOMPATIBLE_CONTRACT' });
    }
  });
  it('preserves outline-v1 validation after a ready report and bounds captured-run detail separately', async () => {
    for (const route of ['stream', 'detail'] as const) {
      await expect(consume({ outline_json: JSON.stringify({ schemaVersion: 'outline-v1', content: { title: 'Broken', sections: [] } }),
        outline_report: readyReport }, route)).rejects.toMatchObject({ code: 'INVALID_DRAFT', outcome: 'KNOWN_SUCCEEDED' });
    }
    await expect(consume(validOutputs(), 'detail', 'x'.repeat(2 * 1024 * 1024)))
      .rejects.toMatchObject({ code: 'INCOMPATIBLE_CONTRACT' });
  });
  it('rejects excessive native metadata by independent SSE event and total limits', async () => {
    const event = (length: number) => new TextEncoder().encode(`data: ${JSON.stringify({ event: 'node_finished', data: { metadata: 'x'.repeat(length) } })}\n\n`);
    for (const [chunk, repetitions, message] of [
      [event(64 * 1024 * 1024), 1, 'Outline workflow stream event exceeded its limit'],
      [event(16 * 1024 * 1024), 9, 'Outline workflow stream exceeded its size limit'],
    ] as const) {
      const provider = new DifyOutlineProvider(async () => new Response(new ReadableStream<Uint8Array>({
        start(controller) { for (let index = 0; index < repetitions; index++) controller.enqueue(chunk); controller.close(); },
      }), { headers: { 'content-type': 'text/event-stream' } }));
      await expect(provider.execute(outlineWorkflowSettings(env), randomUUID(), input(), new AbortController().signal, async () => {}, async () => {}))
        .rejects.toMatchObject({ code: 'INCOMPATIBLE_CONTRACT', message });
    }
  });
});
