import { readFileSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { DifyArticleProvider, ArticleProviderError, articleWorkflowRelease, articleWorkflowSettings, type ArticleProviderInput } from './article-provider.js';
import { canonicalManifestHash } from '../jobs/job-service.js';

const directory = new URL('./workflows/article-generation/', import.meta.url);
const release = JSON.parse(readFileSync(new URL('release.json', directory), 'utf8')) as Record<string, string>;
const env = { NODE_ENV: 'test', DIFY_API_BASE_URL: 'https://dify.example.test/v1',
  DIFY_ARTICLE_GENERATION_PUBLISHED_WORKFLOW_ID: randomUUID(), DIFY_ARTICLE_GENERATION_API_KEY: 'synthetic-article-key',
  DIFY_ARTICLE_GENERATION_CONFIG_SHA256: release['configDigest'] };
const input: ArticleProviderInput = { schemaVersion: 'article-context-v1', contentMode: 'CREATIVE',
  brief: { topic: 'Тема' }, style: { brandbook: '', tone: '', settings: {} }, claims: [], context: [],
  outline: { title: 'Тема', sections: [{ title: 'Вступ', purpose: 'Пояснити тему', claimRevisionIds: [] }] } };
const output = { schemaVersion: 'article-v1', content: { title: 'Тема', document: { type: 'doc',
  content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Синтетична стаття.' }] }] } } };
const readyReport = JSON.stringify({ schemaVersion: 'article-editorial-report-v1', status: 'ready' });
const signal = () => new AbortController().signal;
const sse = (...events: unknown[]) => new Response(events.map(value => `data: ${JSON.stringify(value)}\n\n`).join(''),
  { headers: { 'Content-Type': 'text/event-stream' } });
describe('controlled article workflow boundary', () => {
  it('accepts a ready reviewed short-after-edit candidate with an explicit length warning', async () => {
    const runId = randomUUID(), settings = articleWorkflowSettings(env);
    const report = JSON.stringify({ schemaVersion: 'article-editorial-report-v1', status: 'ready',
      humanApprovalRequired: true, lengthPolicy: 'shorter_after_edit', warnings: ['ARTICLE_SHORTER_AFTER_EDIT'],
      restoredEarlierVersion: false, metrics: { targetWords: 100, minWords: 80, maxWords: 120, wordCount: 79 } });
    const provider = new DifyArticleProvider(async () => sse({ event: 'workflow_finished', workflow_run_id: runId,
      data: { workflow_id: settings.workflowId, status: 'succeeded', outputs: { article_json: output, editorial_report: report } } }));
    expect((await provider.execute(settings, randomUUID(), input, signal(), async () => {}, async () => {})).output).toEqual(output);
  });
  it('uses one DIFY mapping in development, test and production', () => {
    for (const NODE_ENV of ['development', 'test', 'production']) {
      expect(articleWorkflowSettings({ ...env, NODE_ENV })).toMatchObject({
        apiKey: env.DIFY_ARTICLE_GENERATION_API_KEY, workflowId: env.DIFY_ARTICLE_GENERATION_PUBLISHED_WORKFLOW_ID,
        configDigest: env.DIFY_ARTICLE_GENERATION_CONFIG_SHA256,
      });
    }
  });
  it('pins prompt, native graph, complete configuration and separate credential scope', () => {
    const hash = (name: string) => createHash('sha256').update(readFileSync(new URL(name, directory))).digest('hex');
    expect(hash('prompt.md')).toBe(release['promptSha256']);
    expect(hash('article-generation-v1.yml')).toBe(release['workflowDslSha256']);
    const { configDigest, ...unsigned } = release;
    expect(canonicalManifestHash(unsigned)).toBe(configDigest);
    expect(articleWorkflowRelease(env)).toMatchObject({ configDigest, contractVersion: 'article-v1', releaseId: release['releaseId'] });
    expect(articleWorkflowRelease(env)).not.toHaveProperty('apiKey');
  });
  it('fails closed for wrong attestation, malformed endpoint and missing credentials', () => {
    expect(() => articleWorkflowSettings({ ...env, DIFY_ARTICLE_GENERATION_CONFIG_SHA256: '0'.repeat(64) })).toThrow(ArticleProviderError);
    expect(() => articleWorkflowRelease({ ...env, DIFY_API_BASE_URL: 'https://user:secret@dify.example.test/v1' })).toThrow(ArticleProviderError);
    expect(() => articleWorkflowSettings({ ...env, DIFY_ARTICLE_GENERATION_API_KEY: '' })).toThrow(ArticleProviderError);
  });
  it('does not submit when the transactional submission guard fails', async () => {
    let calls = 0;
    const provider = new DifyArticleProvider(async () => { calls++; throw new Error('Unexpected transport'); });
    await expect(provider.execute(articleWorkflowSettings(env), randomUUID(), input, signal(),
      async () => { throw new Error('Evidence withdrawn'); }, async () => {})).rejects.toThrow('Evidence withdrawn');
    expect(calls).toBe(0);
  });
  it('rejects missing factual context and oversized frozen input before transport', async () => {
    let calls = 0;
    const provider = new DifyArticleProvider(async () => { calls++; throw new Error('Unexpected transport'); });
    for (const value of [{ ...input, contentMode: 'FACTUAL' as const }, { ...input, brief: { notes: 'x'.repeat(350000) } }]) {
      await expect(provider.execute(articleWorkflowSettings(env), randomUUID(), value, signal(), async () => {}, async () => {}))
        .rejects.toMatchObject({ code: 'INVALID_INPUT', outcome: 'NOT_SUBMITTED' });
    }
    expect(calls).toBe(0);
  });
  it('captures the run before accepting structured article completion', async () => {
    const runId = randomUUID(), captured: string[] = [];
    const settings = articleWorkflowSettings(env);
    const provider = new DifyArticleProvider(async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as { inputs: Record<string, string>; response_mode: string };
      expect(JSON.parse(body.inputs['editorial_json'] ?? '')).toEqual(input);
      expect(body.response_mode).toBe('streaming');
      return sse({ event: 'workflow_started', workflow_run_id: runId },
        { event: 'workflow_finished', workflow_run_id: runId, data: { workflow_id: settings.workflowId, status: 'succeeded', outputs: { article_json: output, editorial_report: readyReport }, model: 'gemini-3.8-flash' } });
    });
    expect(await provider.execute(settings, randomUUID(), input, signal(), async () => {}, async id => { captured.push(id); }))
      .toEqual({ output, workflowRunId: runId, model: 'gemini-3.8-flash' });
    expect(captured).toEqual([runId]);
  });
  it('reports an unknown submission outcome and never blindly retries POST', async () => {
    let calls = 0;
    const provider = new DifyArticleProvider(async () => { calls++; throw new TypeError('Synthetic connection reset'); });
    await expect(provider.execute(articleWorkflowSettings(env), randomUUID(), input, signal(), async () => {}, async () => {}))
      .rejects.toMatchObject({ code: 'UNKNOWN_OUTCOME', outcome: 'UNKNOWN' });
    expect(calls).toBe(1);
  });
  it('keeps a captured interrupted stream recoverable without a new submission', async () => {
    const runId = randomUUID(), captured: string[] = [];
    const provider = new DifyArticleProvider(async () => sse({ event: 'workflow_started', workflow_run_id: runId }));
    await expect(provider.execute(articleWorkflowSettings(env), randomUUID(), input, signal(), async () => {},
      async id => { captured.push(id); })).rejects.toMatchObject({ code: 'UNKNOWN_OUTCOME', outcome: 'UNKNOWN' });
    expect(captured).toEqual([runId]);
  });
  it('accepts normal loop state metadata exceeding the previous event and total limits', async () => {
    const settings = articleWorkflowSettings(env), runId = randomUUID();
    const provider = new DifyArticleProvider(async () => sse({ event: 'workflow_started', workflow_run_id: runId },
      { event: 'node_finished', workflow_run_id: runId, data: { editorial_state: 'x'.repeat(3 * 1024 * 1024) } },
      { event: 'workflow_finished', workflow_run_id: runId, data: { workflow_id: settings.workflowId, status: 'succeeded',
        outputs: { article_json: JSON.stringify(output), editorial_report: readyReport } } }));
    expect(await provider.execute(settings, randomUUID(), input, signal(), async () => {}, async () => {}))
      .toEqual({ output, workflowRunId: runId, model: null });
  });
  it('rejects an oversized stream event before parsing provider JSON without allocating 64 MiB', async () => {
    const oversizedEvent = 'data: {"event":"node_finished","data":{"state":"synthetic"}}';
    const byteLength = Buffer.byteLength.bind(Buffer);
    const size = vi.spyOn(Buffer, 'byteLength').mockImplementation((value, encoding) =>
      value === oversizedEvent ? 64 * 1024 * 1024 + 1 : byteLength(value, encoding));
    try {
      const provider = new DifyArticleProvider(async () => new Response(oversizedEvent + '\n\n', { headers: { 'Content-Type': 'text/event-stream' } }));
      await expect(provider.execute(articleWorkflowSettings(env), randomUUID(), input, signal(), async () => {}, async () => {}))
        .rejects.toMatchObject({ code: 'INCOMPATIBLE_CONTRACT', message: 'Article workflow stream event exceeded its limit' });
    } finally { size.mockRestore(); }
  });
  it('cancels an oversized stream before decoding without allocating 128 MiB', async () => {
    let cancelled = false;
    const chunk = new TextEncoder().encode('data: {}\n\n');
    Object.defineProperty(chunk, 'byteLength', { value: 128 * 1024 * 1024 + 1 });
    const provider = new DifyArticleProvider(async () => new Response(new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(chunk); }, cancel() { cancelled = true; },
    }), { headers: { 'Content-Type': 'text/event-stream' } }));
    await expect(provider.execute(articleWorkflowSettings(env), randomUUID(), input, signal(), async () => {}, async () => {}))
      .rejects.toMatchObject({ code: 'INCOMPATIBLE_CONTRACT', message: 'Article workflow stream exceeded its size limit' });
    expect(cancelled).toBe(true);
  });
  it.each([undefined, '{}', '{malformed', JSON.stringify({ schemaVersion: 'article-editorial-report-v1', status: 'unknown' }),
    { schemaVersion: 'article-editorial-report-v1', status: 'ready' }, 'x'.repeat(256 * 1024 + 1)])
  ('rejects a missing, malformed, object or oversized editorial report (%#)', async report => {
    const settings = articleWorkflowSettings(env), runId = randomUUID();
    const provider = new DifyArticleProvider(async () => sse({ event: 'workflow_finished', workflow_run_id: runId,
      data: { workflow_id: settings.workflowId, status: 'succeeded', outputs: { article_json: output, editorial_report: report } } }));
    await expect(provider.execute(settings, randomUUID(), input, signal(), async () => {}, async () => {}))
      .rejects.toMatchObject({ code: 'INCOMPATIBLE_CONTRACT', outcome: 'KNOWN_FAILED' });
  });
  it.each(['needs_human', 'insufficient_evidence'])('blocks an article with nonready editorial status %s on execution and reconciliation', async status => {
    const settings = articleWorkflowSettings(env), runId = randomUUID();
    const outputs = { article_json: output, editorial_report: JSON.stringify({ schemaVersion: 'article-editorial-report-v1', status, reason: 'private-source-content' }) };
    const execution = new DifyArticleProvider(async () => sse({ event: 'workflow_finished', workflow_run_id: runId,
      data: { workflow_id: settings.workflowId, status: 'succeeded', outputs } }));
    const reconciliation = new DifyArticleProvider(async () => Response.json({ id: runId, workflow_id: settings.workflowId, status: 'succeeded', outputs }));
    for (const request of [() => execution.execute(settings, randomUUID(), input, signal(), async () => {}, async () => {}),
      () => reconciliation.resume(settings, runId, signal())]) {
      await expect(request()).rejects.toMatchObject({ code: 'PROVIDER_FAILED', outcome: 'KNOWN_FAILED',
        message: 'Article workflow requires editorial intervention before a candidate can be accepted' });
    }
  });
  it('does not accept recovered article output without the editorial report', async () => {
    const settings = articleWorkflowSettings(env), runId = randomUUID();
    const provider = new DifyArticleProvider(async () => Response.json({ id: runId, workflow_id: settings.workflowId, status: 'succeeded', outputs: { article_json: output } }));
    await expect(provider.resume(settings, runId, signal())).rejects.toMatchObject({ code: 'INCOMPATIBLE_CONTRACT', outcome: 'KNOWN_FAILED' });
  });
  it('rejects an empty article despite a ready editorial report', async () => {
    const settings = articleWorkflowSettings(env), runId = randomUUID();
    const provider = new DifyArticleProvider(async () => sse({ event: 'workflow_finished', workflow_run_id: runId,
      data: { workflow_id: settings.workflowId, status: 'succeeded', outputs: { article_json: '', editorial_report: readyReport } } }));
    await expect(provider.execute(settings, randomUUID(), input, signal(), async () => {}, async () => {}))
      .rejects.toMatchObject({ code: 'INCOMPATIBLE_CONTRACT', outcome: 'KNOWN_FAILED' });
  });
  it('keeps run-detail responses bounded independently of larger SSE metadata limits', async () => {
    const settings = articleWorkflowSettings(env), runId = randomUUID();
    const provider = new DifyArticleProvider(async () => Response.json({ id: runId, workflow_id: settings.workflowId, status: 'succeeded',
      outputs: { article_json: output, editorial_report: readyReport }, metadata: 'x'.repeat(2 * 1024 * 1024) }));
    await expect(provider.resume(settings, runId, signal())).rejects.toMatchObject({ code: 'INCOMPATIBLE_CONTRACT', message: 'Article workflow response exceeded its size limit' });
  });
  it('rejects non-streaming results with an unknown submission outcome', async () => {
    const provider = new DifyArticleProvider(async () => Response.json({ data: output }));
    await expect(provider.execute(articleWorkflowSettings(env), randomUUID(), input, signal(), async () => {}, async () => {}))
      .rejects.toMatchObject({ code: 'INCOMPATIBLE_CONTRACT', outcome: 'UNKNOWN' });
  });
  it('propagates run persistence failure without converting it into a transport retry', async () => {
    const provider = new DifyArticleProvider(async () => sse({ event: 'workflow_started', workflow_run_id: randomUUID() }));
    await expect(provider.execute(articleWorkflowSettings(env), randomUUID(), input, signal(), async () => {},
      async () => { throw new Error('Lease lost'); })).rejects.toThrow('Lease lost');
  });
  it('reconciles only the captured run, using GET and frozen workflow identity', async () => {
    const settings = articleWorkflowSettings(env), runId = randomUUID();
    const provider = new DifyArticleProvider(async (url, init) => {
      expect(url).toBe(`${settings.endpoint}/workflows/run/${runId}`);
      expect(init?.method).toBeUndefined();
      expect(init?.body).toBeUndefined();
      return Response.json({ id: runId, workflow_id: settings.workflowId, status: 'succeeded', outputs: { article_json: JSON.stringify(output), editorial_report: readyReport } });
    });
    expect(await provider.resume(settings, runId, signal())).toEqual({ output, workflowRunId: runId, model: null });
  });
  it('rejects a different captured run or frozen workflow release during recovery', async () => {
    const settings = articleWorkflowSettings(env), runId = randomUUID();
    for (const detail of [{ id: randomUUID(), workflow_id: settings.workflowId }, { id: runId, workflow_id: randomUUID() }]) {
      const provider = new DifyArticleProvider(async () => Response.json({ ...detail, status: 'succeeded', outputs: { article_json: output } }));
      await expect(provider.resume(settings, runId, signal())).rejects.toMatchObject({ code: 'INCOMPATIBLE_CONTRACT' });
    }
  });
  it('rejects unsupported document nodes atomically at the provider boundary', async () => {
    const settings = articleWorkflowSettings(env), runId = randomUUID();
    const provider = new DifyArticleProvider(async () => Response.json({ id: runId, workflow_id: settings.workflowId, status: 'succeeded',
      outputs: { editorial_report: readyReport, article_json: { ...output, content: { title: 'Тема', document: { type: 'doc', content: [{ type: 'image', attrs: { src: 'https://example.test/private' } }] } } } } }));
    await expect(provider.resume(settings, runId, signal())).rejects.toMatchObject({ code: 'INCOMPATIBLE_CONTRACT' });
  });
});
