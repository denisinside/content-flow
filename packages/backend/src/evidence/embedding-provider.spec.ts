import { randomUUID, createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { canonicalManifestHash } from '../jobs/job-service.js';
import { embeddingRequestHash, sha256Text, type EmbeddingRequest } from './contracts.js';
import { DifyEmbeddingProvider, EmbeddingProviderError, embeddingWorkflowRelease, embeddingWorkflowSettings } from './embedding-provider.js';

const directory = new URL('./workflows/source-embedding/', import.meta.url);
const release = JSON.parse(readFileSync(new URL('release.json', directory), 'utf8')) as Record<string, unknown>;
const workflowId = 'b21081a2-114a-4ce9-91d8-21241a03b70c';
const runId = 'f8f453dc-5ff8-44d5-a5c5-6cd1af37092b';
const env = { NODE_ENV: 'test', DIFY_API_BASE_URL: 'http://127.0.0.1:8080/v1',
  DIFY_SOURCE_EMBEDDING_PUBLISHED_WORKFLOW_ID: workflowId, DIFY_SOURCE_EMBEDDING_API_KEY: 'synthetic-test-key',
  DIFY_SOURCE_EMBEDDING_CONFIG_SHA256: String(release['configDigest']) };

function request(task: 'DOCUMENT' | 'QUERY' = 'DOCUMENT'): EmbeddingRequest {
  const texts = [{ id: randomUUID(), text: 'Synthetic requirements and source evidence.', sha256: sha256Text('Synthetic requirements and source evidence.') }];
  return { schemaVersion: 'source-embedding-request-v1', requestId: randomUUID(), task, texts };
}
function output(input: EmbeddingRequest) {
  const values = Array.from({ length: 768 }, (_, index) => index === 0 ? 1 : 0);
  return { schemaVersion: 'source-embedding-v1', requestId: input.requestId, requestHash: embeddingRequestHash(input),
    model: 'gemini-embedding-001', dimensions: 768, task: input.task,
    embeddings: input.texts.map(row => ({ id: row.id, sha256: row.sha256, values })) };
}
const event = (value: unknown) => `data: ${JSON.stringify(value)}\r\n\r\n`;
function stream(runWorkflowId: string, value: unknown, runIdentifier = runId) {
  const outputs = { embedding_json: JSON.stringify(value) };
  return new Response(event({ event: 'workflow_started', workflow_run_id: runIdentifier, data: { workflow_id: runWorkflowId } })
    + event({ event: 'workflow_finished', workflow_run_id: runIdentifier, data: { workflow_id: runWorkflowId, status: 'succeeded', outputs } }),
  { headers: { 'content-type': 'text/event-stream' } });
}
function detail(runWorkflowId: string, value: unknown, runIdentifier = runId) {
  return new Response(JSON.stringify({ id: runIdentifier, workflow_id: runWorkflowId, status: 'succeeded',
    outputs: { embedding_json: JSON.stringify(value) } }), { headers: { 'content-type': 'application/json' } });
}

describe('Dify source-embedding workflow boundary', () => {
  it('pins the local release descriptor and keeps the API key out of its public mapping', () => {
    const configDigest = release['configDigest'];
    const unsigned = Object.fromEntries(Object.entries(release).filter(([key]) => key !== 'configDigest' && key !== 'workflowDslSha256'));
    expect(canonicalManifestHash(unsigned)).toBe(configDigest);
    expect(embeddingWorkflowRelease(env)).toMatchObject({ releaseId: release['releaseId'], configDigest, workflowId });
    expect(embeddingWorkflowRelease(env)).not.toHaveProperty('apiKey');
    expect(embeddingWorkflowSettings(env).apiKey).toBe('synthetic-test-key');
    expect(() => embeddingWorkflowSettings({ ...env, DIFY_SOURCE_EMBEDDING_CONFIG_SHA256: '0'.repeat(64) })).toThrow(EmbeddingProviderError);
    expect(() => embeddingWorkflowSettings({ ...env, DIFY_SOURCE_EMBEDDING_API_KEY: '' })).toThrow(EmbeddingProviderError);
    expect(() => embeddingWorkflowSettings({ ...env, DIFY_API_BASE_URL: 'https://user:secret@dify.example/v1' })).toThrow(EmbeddingProviderError);
  });

  it('records durable intent before submit, captures the run, and validates vectors for the exact request', async () => {
    const input = request();
    const order: string[] = [];
    const transport = vi.fn().mockResolvedValue(stream(workflowId, output(input)));
    const provider = new DifyEmbeddingProvider(transport);
    const result = await provider.execute(embeddingWorkflowSettings(env), randomUUID(), input, new AbortController().signal,
      async () => { order.push('intent'); }, async id => { order.push(`run:${id}`); });
    expect(result).toMatchObject({ workflowRunId: runId, output: output(input), model: null });
    expect(order).toEqual(['intent', `run:${runId}`]);
    const [url, init] = transport.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${embeddingWorkflowSettings(env).endpoint}/workflows/run`);
    expect(init.redirect).toBe('error');
    expect(JSON.parse(String(init.body))).toMatchObject({ response_mode: 'streaming', user: expect.stringMatching(/^job-/u) });
    expect(JSON.parse(JSON.parse(String(init.body)).inputs.embedding_request_json)).toEqual(input);
  });

  it('reconciles only the recorded flat run and validates the same frozen request', async () => {
    const input = request('QUERY'), settings = embeddingWorkflowSettings(env);
    const transport = vi.fn().mockResolvedValue(detail(workflowId, output(input)));
    const result = await new DifyEmbeddingProvider(transport).resume(settings, runId, input, new AbortController().signal);
    expect(result.output).toEqual(output(input));
    expect(transport).toHaveBeenCalledWith(`${settings.endpoint}/workflows/run/${runId}`, expect.objectContaining({ redirect: 'error' }));
    await expect(new DifyEmbeddingProvider(vi.fn().mockResolvedValue(detail(workflowId, output(input), randomUUID())))
      .resume(settings, runId, input, new AbortController().signal)).rejects.toMatchObject({ code: 'INCOMPATIBLE_CONTRACT' });
  });

  it('rejects release mismatches and output for another request on both paths', async () => {
    const input = request(), settings = embeddingWorkflowSettings(env);
    await expect(new DifyEmbeddingProvider(vi.fn().mockResolvedValue(stream(randomUUID(), output(input))))
      .execute(settings, randomUUID(), input, new AbortController().signal, vi.fn(), vi.fn()))
      .rejects.toMatchObject({ code: 'INCOMPATIBLE_CONTRACT' });
    const otherRequest = request();
    for (const reply of [stream(workflowId, output(otherRequest)), detail(workflowId, output(otherRequest))]) {
      const provider = new DifyEmbeddingProvider(vi.fn().mockResolvedValue(reply));
      const result = reply.headers.get('content-type')?.includes('event-stream')
        ? provider.execute(settings, randomUUID(), input, new AbortController().signal, vi.fn(), vi.fn())
        : provider.resume(settings, runId, input, new AbortController().signal);
      await expect(result).rejects.toMatchObject({ code: 'INCOMPATIBLE_CONTRACT' });
    }
  });

  it('cancels a rejected streaming response and does not persist a run from the wrong release', async () => {
    let cancelled = 0;
    const body = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new TextEncoder().encode(event({ event: 'workflow_started', workflow_run_id: runId, data: { workflow_id: randomUUID() } }))); },
      cancel() { cancelled++; },
    });
    const recordRun = vi.fn();
    const provider = new DifyEmbeddingProvider(vi.fn().mockResolvedValue(new Response(body, { headers: { 'content-type': 'text/event-stream' } })));
    await expect(provider.execute(embeddingWorkflowSettings(env), randomUUID(), request(), new AbortController().signal, vi.fn(), recordRun))
      .rejects.toMatchObject({ code: 'INCOMPATIBLE_CONTRACT' });
    expect(cancelled).toBe(1);
    expect(recordRun).not.toHaveBeenCalled();
  });

  it('captures run identity only at a matching workflow_started event and rejects later identity changes', async () => {
    let cancelled = 0;
    const foreignRunId = randomUUID();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(event({ event: 'node_started', workflow_run_id: foreignRunId, data: {} })));
        controller.enqueue(new TextEncoder().encode(event({ event: 'workflow_started', workflow_run_id: runId, data: { workflow_id: workflowId } })));
        controller.enqueue(new TextEncoder().encode(event({ event: 'node_finished', workflow_run_id: foreignRunId, data: {} })));
      },
      cancel() { cancelled++; },
    });
    const recordRun = vi.fn();
    const provider = new DifyEmbeddingProvider(vi.fn().mockResolvedValue(new Response(body, { headers: { 'content-type': 'text/event-stream' } })));
    await expect(provider.execute(embeddingWorkflowSettings(env), randomUUID(), request(), new AbortController().signal, vi.fn(), recordRun))
      .rejects.toMatchObject({ code: 'INCOMPATIBLE_CONTRACT' });
    expect(recordRun).toHaveBeenCalledExactlyOnceWith(runId);
    expect(cancelled).toBe(1);
  });

  it('does not resubmit when the POST outcome is unknown and sanitizes transport errors', async () => {
    const beforeSubmit = vi.fn(), transport = vi.fn().mockRejectedValue(new TypeError('secret-key and source text'));
    const provider = new DifyEmbeddingProvider(transport);
    await expect(provider.execute(embeddingWorkflowSettings(env), randomUUID(), request(), new AbortController().signal, beforeSubmit, vi.fn()))
      .rejects.toMatchObject({ code: 'UNKNOWN_OUTCOME', outcome: 'UNKNOWN' });
    expect(beforeSubmit).toHaveBeenCalledOnce(); expect(transport).toHaveBeenCalledOnce();
    await expect(provider.execute(embeddingWorkflowSettings(env), randomUUID(), request(), new AbortController().signal, vi.fn(), vi.fn()))
      .rejects.not.toThrow('secret-key');
  });

  it('classifies rate limit and authentication responses without reading provider bodies', async () => {
    for (const [status, code] of [[429, 'RATE_LIMIT'], [401, 'AUTH']] as const) {
      const provider = new DifyEmbeddingProvider(vi.fn().mockResolvedValue(new Response('private-token', { status })));
      await expect(provider.execute(embeddingWorkflowSettings(env), randomUUID(), request(), new AbortController().signal, vi.fn(), vi.fn()))
        .rejects.toMatchObject({ code, outcome: 'KNOWN_FAILED' });
    }
  });

  it('enforces per-event, total SSE, GET byte, and output character bounds', async () => {
    const settings = embeddingWorkflowSettings(env), input = request();
    const oversizedEvent = `data: ${JSON.stringify({ event: 'node_finished', data: { content: 'x'.repeat(1024 * 1024) } })}\n\n`;
    const eventProvider = new DifyEmbeddingProvider(vi.fn().mockResolvedValue(new Response(oversizedEvent, { headers: { 'content-type': 'text/event-stream' } })));
    await expect(eventProvider.execute(settings, randomUUID(), input, new AbortController().signal, vi.fn(), vi.fn()))
      .rejects.toMatchObject({ code: 'INCOMPATIBLE_CONTRACT' });

    const totalChunk = `data: ${JSON.stringify({ event: 'node_finished', data: { content: 'x'.repeat(600 * 1024) } })}\n\n`;
    const totalProvider = new DifyEmbeddingProvider(vi.fn().mockResolvedValue(new Response(totalChunk.repeat(8), { headers: { 'content-type': 'text/event-stream' } })));
    await expect(totalProvider.execute(settings, randomUUID(), input, new AbortController().signal, vi.fn(), vi.fn()))
      .rejects.toMatchObject({ code: 'INCOMPATIBLE_CONTRACT' });

    const getProvider = new DifyEmbeddingProvider(vi.fn().mockResolvedValue(new Response(new Uint8Array(2 * 1024 * 1024 + 1))));
    await expect(getProvider.resume(settings, runId, input, new AbortController().signal)).rejects.toMatchObject({ code: 'INCOMPATIBLE_CONTRACT' });

    const hugeOutput = new DifyEmbeddingProvider(vi.fn().mockResolvedValue(stream(workflowId,
      { ...output(input), padding: 'x'.repeat(400_001) })));
    await expect(hugeOutput.execute(settings, randomUUID(), input, new AbortController().signal, vi.fn(), vi.fn()))
      .rejects.toMatchObject({ code: 'INCOMPATIBLE_CONTRACT' });
  });

  it('does not submit malformed source requests', async () => {
    const input = request(); input.texts[0]!.sha256 = createHash('sha256').update('different').digest('hex');
    const beforeSubmit = vi.fn(), transport = vi.fn();
    await expect(new DifyEmbeddingProvider(transport).execute(embeddingWorkflowSettings(env), randomUUID(), input,
      new AbortController().signal, beforeSubmit, vi.fn())).rejects.toMatchObject({ code: 'INVALID_INPUT', outcome: 'NOT_SUBMITTED' });
    expect(beforeSubmit).not.toHaveBeenCalled(); expect(transport).not.toHaveBeenCalled();
  });
});
