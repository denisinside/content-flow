import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { canonicalManifestHash } from '../jobs/job-service.js';
import { relevanceInputHash, type RelevanceInput } from './relevance-contracts.js';
import { sha256Text } from './contracts.js';
import { evidenceRelevanceManifestSchema, evidenceSearchV2ManifestSchema } from './relevance-job-contracts.js';
import { DifySourceRelevanceProvider, SourceRelevanceProviderError, sourceRelevanceWorkflowRelease,
  sourceRelevanceWorkflowSettings } from './relevance-provider.js';

const release = JSON.parse(readFileSync(new URL('./workflows/source-relevance/release.json', import.meta.url), 'utf8')) as Record<string, unknown>;
const workflowId = 'b21081a2-114a-4ce9-91d8-21241a03b70c';
const runId = 'f8f453dc-5ff8-44d5-a5c5-6cd1af37092b';
const env = { NODE_ENV: 'test', DIFY_API_BASE_URL: 'http://127.0.0.1:8080/v1',
  DIFY_SOURCE_RELEVANCE_PUBLISHED_WORKFLOW_ID: workflowId, DIFY_SOURCE_RELEVANCE_API_KEY: 'synthetic-test-key',
  DIFY_SOURCE_RELEVANCE_CONFIG_SHA256: String(release['configDigest']) };

function request(): RelevanceInput {
  const quote = 'Synthetic source evidence supports the exact query.';
  return { schemaVersion: 'source-relevance-request-v1', requestId: randomUUID(), query: 'What does the source support?',
    candidates: [{ id: 'c'.repeat(64), snapshotId: randomUUID(), fragmentId: randomUUID(), startOffset: 0,
      endOffset: quote.length, quote, sha256: sha256Text(quote), snapshotSha256: 'a'.repeat(64), label: 'Background' }] };
}
function output(input: RelevanceInput, ranked = true) {
  return { schemaVersion: 'source-relevance-v1', requestId: input.requestId, requestHash: relevanceInputHash(input),
    decisions: input.candidates.map(row => ({ id: row.id, sha256: row.sha256,
      relevance: ranked ? 'DIRECT' : 'IRRELEVANT', reason: ranked ? 'ANSWERS' : 'NO_QUERY_SUPPORT' })),
    rankedIds: ranked ? input.candidates.map(row => row.id) : [] };
}
const event = (value: unknown) => `data: ${JSON.stringify(value)}\r\n\r\n`;
function stream(wfId: string, value: unknown, id = runId) {
  const outputs = { source_relevance_json: JSON.stringify(value) };
  return new Response(event({ event: 'workflow_started', workflow_run_id: id, data: { workflow_id: wfId } })
    + event({ event: 'workflow_finished', workflow_run_id: id, data: { workflow_id: wfId, status: 'succeeded', outputs } }),
  { headers: { 'content-type': 'text/event-stream' } });
}
function detail(wfId: string, value: unknown, id = runId) {
  return new Response(JSON.stringify({ id, workflow_id: wfId, status: 'succeeded',
    outputs: { source_relevance_json: JSON.stringify(value) } }), { headers: { 'content-type': 'application/json' } });
}

describe('Dify source-relevance workflow boundary', () => {
  it('pins the release descriptor and keeps the API key out of the public release settings', () => {
    const configDigest = release['configDigest'];
    const unsigned = Object.fromEntries(Object.entries(release).filter(([key]) => key !== 'configDigest' && key !== 'workflowDslSha256'));
    expect(canonicalManifestHash(unsigned)).toBe(configDigest);
    expect(sourceRelevanceWorkflowRelease(env)).toMatchObject({ releaseId: release['releaseId'], configDigest, workflowId });
    expect(sourceRelevanceWorkflowRelease(env)).not.toHaveProperty('apiKey');
    expect(sourceRelevanceWorkflowSettings(env).apiKey).toBe('synthetic-test-key');
    const oldEnv = { ...env, DIFY_SOURCE_RELEVANCE_CONFIG_SHA256: '239be78994f5b3d2b1e5cfdf119a4b91d6de943d12aebe0c52594fcc55457c9b' };
    expect(sourceRelevanceWorkflowRelease(oldEnv)).toMatchObject({ releaseId: 'source-relevance-2026-10-22.1',
      configDigest: oldEnv.DIFY_SOURCE_RELEVANCE_CONFIG_SHA256, workflowId });
    const compactEnv = { ...env, DIFY_SOURCE_RELEVANCE_CONFIG_SHA256: '40153b6847d3f6a6da168afd7b5ec930492c35458582a8aec32aba3e431582c0' };
    expect(sourceRelevanceWorkflowRelease(compactEnv)).toMatchObject({ releaseId: 'source-relevance-2026-10-24.1',
      configDigest: compactEnv.DIFY_SOURCE_RELEVANCE_CONFIG_SHA256 });
    expect(() => sourceRelevanceWorkflowRelease({ ...env, DIFY_SOURCE_RELEVANCE_CONFIG_SHA256: 'f'.repeat(64) }))
      .toThrow(SourceRelevanceProviderError);
    expect(() => sourceRelevanceWorkflowSettings({ ...env, DIFY_SOURCE_RELEVANCE_CONFIG_SHA256: '0'.repeat(64) })).toThrow(SourceRelevanceProviderError);
    expect(() => sourceRelevanceWorkflowSettings({ ...env, DIFY_SOURCE_RELEVANCE_API_KEY: '' })).toThrow(SourceRelevanceProviderError);
    expect(() => sourceRelevanceWorkflowSettings({ ...env, DIFY_API_BASE_URL: 'https://user:secret@dify.example/v1' })).toThrow(SourceRelevanceProviderError);
  });

  it('parses both frozen release pairs and rejects crossed or unknown historical pins', () => {
    const rootId = randomUUID(), snapshotId = randomUUID(), materialId = randomUUID(), indexId = randomUUID();
    const query = 'What does the source support?';
    const embeddingRelease = { endpoint: 'https://dify.example/v1', workflowId, releaseId: 'source-embedding-2026-10-20.1',
      configDigest: 'a'.repeat(64) };
    const candidateQuote = 'Synthetic source evidence supports the exact query.';
    const requestValue: RelevanceInput = { schemaVersion: 'source-relevance-request-v1', requestId: randomUUID(), query,
      candidates: [{ id: 'c'.repeat(64), snapshotId, fragmentId: randomUUID(), startOffset: 0, endOffset: candidateQuote.length,
        quote: candidateQuote, sha256: sha256Text(candidateQuote), snapshotSha256: 'b'.repeat(64), label: 'Background' }] };
    const snapshot = { snapshotId, materialId, snapshotSha256: 'b'.repeat(64), sequence: 1, label: 'Background' };
    const index = { indexId, snapshotId, snapshotSha256: 'b'.repeat(64), configDigest: 'a'.repeat(64) };
    const pins = [
      { releaseId: 'source-relevance-2026-10-22.1', configDigest: '239be78994f5b3d2b1e5cfdf119a4b91d6de943d12aebe0c52594fcc55457c9b' },
      { releaseId: 'source-relevance-2026-10-24.1', configDigest: '40153b6847d3f6a6da168afd7b5ec930492c35458582a8aec32aba3e431582c0' },
    ] as const;
    for (const pin of pins) {
      const parent = { schemaVersion: 'evidence-search-job-v2', commandKey: 'synthetic-command', query,
        snapshots: [snapshot], indexes: [index], retrievalPolicy: { version: 'hybrid-source-v4', rankConstant: 60,
          byteBudget: 30_000, maxPassages: 20, adjacentContextChunks: 1 },
        request: { schemaVersion: 'source-embedding-request-v1', requestId: randomUUID(), task: 'QUERY',
          texts: [{ id: randomUUID(), text: query, sha256: sha256Text(query) }] }, release: embeddingRelease,
        relevanceRelease: { endpoint: 'https://dify.example/v1', workflowId, ...pin }, noticeVersion: 'notice-v1',
        acceptedAt: '2026-10-22T00:00:00.000Z' };
      expect(evidenceSearchV2ManifestSchema.safeParse(parent).success).toBe(true);
      const child = { schemaVersion: 'evidence-relevance-job-v1', commandKey: `relevance-${rootId}`, parentJobId: rootId,
        parentInputHash: 'd'.repeat(64), query, snapshots: [snapshot], indexes: [index], retrievalPolicy: parent.retrievalPolicy,
        embeddingRelease, release: parent.relevanceRelease, request: requestValue, candidateCount: 1, hasMore: false,
        noticeVersion: 'notice-v1', acceptedAt: parent.acceptedAt };
      expect(evidenceRelevanceManifestSchema.safeParse(child).success).toBe(true);
      const crossedChild = { ...child, release: { ...child.release, releaseId: pins[1].releaseId,
        configDigest: pins[0].configDigest } };
      expect(evidenceRelevanceManifestSchema.safeParse(crossedChild).success).toBe(false);
      const crossed = { ...parent, relevanceRelease: { ...parent.relevanceRelease,
        releaseId: pins[1].releaseId, configDigest: pins[0].configDigest } };
      expect(evidenceSearchV2ManifestSchema.safeParse(crossed).success).toBe(false);
      const unknown = { ...child, release: { ...child.release, configDigest: 'e'.repeat(64) } };
      expect(evidenceRelevanceManifestSchema.safeParse(unknown).success).toBe(false);
    }
  });

  it('persists intent and run identity before validating a successful streaming result', async () => {
    const input = request(), order: string[] = [], transport = vi.fn().mockResolvedValue(stream(workflowId, output(input)));
    const result = await new DifySourceRelevanceProvider(transport).execute(sourceRelevanceWorkflowSettings(env), randomUUID(), input,
      new AbortController().signal, async () => { order.push('intent'); }, async id => { order.push(`run:${id}`); });
    expect(result).toMatchObject({ workflowRunId: runId, output: output(input), model: null });
    expect(order).toEqual(['intent', `run:${runId}`]);
    const [url, init] = transport.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${sourceRelevanceWorkflowSettings(env).endpoint}/workflows/run`);
    expect(init.redirect).toBe('error');
    expect(JSON.parse(String(init.body))).toMatchObject({ response_mode: 'streaming', user: expect.stringMatching(/^job-/u) });
    expect(JSON.parse(JSON.parse(String(init.body)).inputs.source_relevance_request_json)).toEqual(input);
  });

  it('accepts an empty useful ranking and resumes a captured run using GET only', async () => {
    const input = request(), settings = sourceRelevanceWorkflowSettings(env);
    const empty = await new DifySourceRelevanceProvider(vi.fn().mockResolvedValue(stream(workflowId, output(input, false))))
      .execute(settings, randomUUID(), input, new AbortController().signal, vi.fn(), vi.fn());
    expect(empty.output.rankedIds).toEqual([]);

    const calls: Array<[string, RequestInit | undefined]> = [];
    const transport = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      calls.push([String(url), init]);
      if (init?.method === 'POST') return new Response(event({ event: 'workflow_started', workflow_run_id: runId, data: { workflow_id: workflowId } }),
        { headers: { 'content-type': 'text/event-stream' } });
      return detail(workflowId, output(input));
    });
    const provider = new DifySourceRelevanceProvider(transport), settings1 = settings;
    await expect(provider.execute(settings1, randomUUID(), input, new AbortController().signal, vi.fn(), vi.fn()))
      .rejects.toMatchObject({ code: 'UNKNOWN_OUTCOME', outcome: 'UNKNOWN' });
    const resumed = await provider.resume(settings1, runId, input, new AbortController().signal);
    expect(resumed.output).toEqual(output(input));
    expect(calls.map(([, init]) => init?.method ?? 'GET')).toEqual(['POST', 'GET']);
    expect(calls[1][0]).toBe(`${settings.endpoint}/workflows/run/${runId}`);
  });

  it('rejects wrong workflow/run identities, malformed and oversized GET results, and tampered request decisions', async () => {
    const input = request(), settings = sourceRelevanceWorkflowSettings(env);
    await expect(new DifySourceRelevanceProvider(vi.fn().mockResolvedValue(stream(randomUUID(), output(input))))
      .execute(settings, randomUUID(), input, new AbortController().signal, vi.fn(), vi.fn())).rejects.toMatchObject({ code: 'INCOMPATIBLE_CONTRACT' });
    await expect(new DifySourceRelevanceProvider(vi.fn().mockResolvedValue(detail(randomUUID(), output(input))))
      .resume(settings, runId, input, new AbortController().signal)).rejects.toMatchObject({ code: 'INCOMPATIBLE_CONTRACT' });
    await expect(new DifySourceRelevanceProvider(vi.fn().mockResolvedValue(detail(workflowId, output(input), randomUUID())))
      .resume(settings, runId, input, new AbortController().signal)).rejects.toMatchObject({ code: 'INCOMPATIBLE_CONTRACT' });
    await expect(new DifySourceRelevanceProvider(vi.fn().mockResolvedValue(new Response('{bad json')))
      .resume(settings, runId, input, new AbortController().signal)).rejects.toMatchObject({ code: 'INCOMPATIBLE_CONTRACT' });
    const large = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new Uint8Array(2 * 1024 * 1024 + 1)); } });
    await expect(new DifySourceRelevanceProvider(vi.fn().mockResolvedValue(new Response(large)))
      .resume(settings, runId, input, new AbortController().signal)).rejects.toMatchObject({ code: 'INCOMPATIBLE_CONTRACT' });
    await expect(new DifySourceRelevanceProvider(vi.fn().mockResolvedValue(detail(workflowId, { ...output(input), requestHash: 'f'.repeat(64) })))
      .resume(settings, runId, input, new AbortController().signal)).rejects.toMatchObject({ code: 'INCOMPATIBLE_CONTRACT' });
    const oversizedOutput = new Response(JSON.stringify({ id: runId, workflow_id: workflowId, status: 'succeeded',
      outputs: { source_relevance_json: JSON.stringify({ ...output(input), padding: 'x'.repeat(40_000) }) } }),
    { headers: { 'content-type': 'application/json' } });
    await expect(new DifySourceRelevanceProvider(vi.fn().mockResolvedValue(oversizedOutput))
      .resume(settings, runId, input, new AbortController().signal)).rejects.toMatchObject({ code: 'INCOMPATIBLE_CONTRACT' });
  });

  it('preserves HTTP failure classes, rejects redirects, and reports unknown submission outcomes without retrying POST', async () => {
    const input = request(), settings = sourceRelevanceWorkflowSettings(env), jobId = randomUUID();
    for (const [status, code] of [[401, 'AUTH'], [402, 'QUOTA'], [429, 'RATE_LIMIT'], [503, 'TRANSIENT_TRANSPORT']] as const) {
      await expect(new DifySourceRelevanceProvider(vi.fn().mockResolvedValue(new Response('', { status })))
        .execute(settings, jobId, input, new AbortController().signal, vi.fn(), vi.fn())).rejects.toMatchObject({ code });
    }
    const redirect = vi.fn().mockResolvedValue(new Response('', { status: 302, headers: { location: 'https://elsewhere.invalid' } }));
    await expect(new DifySourceRelevanceProvider(redirect).execute(settings, jobId, input, new AbortController().signal, vi.fn(), vi.fn()))
      .rejects.toMatchObject({ code: 'PROVIDER_FAILED' });
    expect((redirect.mock.calls[0]?.[1] as RequestInit).redirect).toBe('error');
    const rejected = vi.fn().mockRejectedValue(new TypeError('synthetic redirect/transport failure'));
    await expect(new DifySourceRelevanceProvider(rejected).execute(settings, jobId, input, new AbortController().signal, vi.fn(), vi.fn()))
      .rejects.toMatchObject({ code: 'UNKNOWN_OUTCOME', outcome: 'UNKNOWN' });
    expect(rejected).toHaveBeenCalledTimes(1);
  });
});
