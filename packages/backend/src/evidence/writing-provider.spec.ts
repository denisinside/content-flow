import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { canonicalManifestHash } from '../jobs/job-service.js';
import { DifySourceWritingProvider, SourceWritingProviderError, sourceWritingWorkflowRelease, sourceWritingWorkflowSettings } from './writing-provider.js';
import { sourceWritingInputSchema, type SourceWritingInput } from './writing-contracts.js';

const workflowId = '8d52e8a7-f629-49c9-8c29-54b81c6d9e51';
const runId = 'f8f453dc-5ff8-44d5-a5c5-6cd1af37092b';
const configDigest = '627ff3011fa324418e2d420290eb1e42ebb03f1a511b7822e376e3f13c024b75';
const sectionId = '088f5f7c-8eb7-46bc-b95e-af5677ed6dbb';
const env = { NODE_ENV: 'test', DIFY_API_BASE_URL: 'http://127.0.0.1:8080/v1',
  DIFY_SOURCE_WRITING_PUBLISHED_WORKFLOW_ID: workflowId, DIFY_SOURCE_WRITING_API_KEY: 'synthetic-test-key',
  DIFY_SOURCE_WRITING_CONFIG_SHA256: configDigest };
const passageId = randomUUID();

function request(): SourceWritingInput {
  const value = { schemaVersion: 'source-writing-input-v1' as const, requestId: randomUUID(), task: 'OUTLINE' as const,
    brief: { topic: 'Synthetic topic', audience: '', centralMessage: '', category: '', tone: '', targetLength: 50, cta: '', exclusions: [], notes: '' },
    style: { brandbook: '', tone: '', settings: {} }, context: [],
    passages: [{ id: passageId, packetId: randomUUID(), snapshotId: randomUUID(), quote: 'A synthetic source passage.' }], requiredClaims: [] };
  const parsed = sourceWritingInputSchema.safeParse(value);
  if (!parsed.success) throw new Error(JSON.stringify(parsed.error.issues));
  return parsed.data;
}

function output(input: SourceWritingInput) {
  return { schemaVersion: 'source-writing-v1', requestId: input.requestId, inputHash: canonicalManifestHash(input),
    task: input.task, status: 'ready', content: { title: 'Synthetic outline', sections: [{ id: sectionId,
      title: 'Synthetic section', purpose: 'Explain the source.', targetWords: 50, passageIds: [passageId], requiredClaimRevisionIds: [] }] },
    review: { status: 'ready', issues: [], reasons: ['Synthetic fixture passed the review checks.'], modelCalls: 2 } };
}

const event = (value: unknown) => `data: ${JSON.stringify(value)}\r\n\r\n`;
function stream(runWorkflowId: string, value: unknown, runIdentifier = runId) {
  return new Response(event({ event: 'workflow_started', workflow_run_id: runIdentifier, data: { workflow_id: runWorkflowId } })
    + event({ event: 'workflow_finished', workflow_run_id: runIdentifier, data: { workflow_id: runWorkflowId, status: 'succeeded',
      outputs: { source_writing_json: JSON.stringify(value) } } }), { headers: { 'content-type': 'text/event-stream' } });
}
function detail(runWorkflowId: string, value: unknown, runIdentifier = runId) {
  return new Response(JSON.stringify({ id: runIdentifier, workflow_id: runWorkflowId, status: 'succeeded',
    outputs: { source_writing_json: JSON.stringify(value) } }), { headers: { 'content-type': 'application/json' } });
}

describe('Dify source-writing workflow boundary', () => {
  it('pins the release config and keeps the API key out of the release mapping', () => {
    expect(sourceWritingWorkflowRelease(env)).toMatchObject({ releaseId: 'source-writing-2026-10-20.1', configDigest, workflowId });
    expect(sourceWritingWorkflowRelease(env)).not.toHaveProperty('apiKey');
    expect(sourceWritingWorkflowSettings(env).apiKey).toBe('synthetic-test-key');
    expect(() => sourceWritingWorkflowSettings({ ...env, DIFY_SOURCE_WRITING_CONFIG_SHA256: '0'.repeat(64) }))
      .toThrow(SourceWritingProviderError);
    expect(() => sourceWritingWorkflowSettings({ ...env, DIFY_SOURCE_WRITING_API_KEY: '' })).toThrow(SourceWritingProviderError);
    expect(() => sourceWritingWorkflowSettings({ ...env, DIFY_API_BASE_URL: 'https://user:secret@dify.example/v1' }))
      .toThrow(SourceWritingProviderError);
  });

  it('accepts the generated indexed-section release only when its digest is pinned', () => {
    const release = JSON.parse(readFileSync(new URL('./workflows/source-writing/release.json', import.meta.url), 'utf8')) as {
      configDigest: string; releaseId: string;
    };
    expect(release.releaseId).toBe('source-writing-2026-11-22.1');
    expect(sourceWritingWorkflowRelease({ ...env, DIFY_SOURCE_WRITING_CONFIG_SHA256: release.configDigest }))
      .toMatchObject({ releaseId: release.releaseId, configDigest: release.configDigest, workflowId });
  });

  it('records intent before POST, captures only the matching run, and validates the frozen output', async () => {
    const input = request(), order: string[] = [];
    const transport = vi.fn().mockResolvedValue(stream(workflowId, output(input)));
    const result = await new DifySourceWritingProvider(transport).execute(sourceWritingWorkflowSettings(env), randomUUID(), input,
      new AbortController().signal, async () => { order.push('intent'); }, async id => { order.push(`run:${id}`); });
    expect(result).toMatchObject({ workflowRunId: runId, output: output(input), model: null });
    expect(order).toEqual(['intent', `run:${runId}`]);
    const [url, init] = transport.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${sourceWritingWorkflowSettings(env).endpoint}/workflows/run`);
    expect(init.redirect).toBe('error');
    expect(JSON.parse(String(init.body))).toMatchObject({ response_mode: 'streaming', user: expect.stringMatching(/^job-/u) });
    expect(JSON.parse(JSON.parse(String(init.body)).inputs.source_writing_request_json)).toEqual(input);
  });

  it('resumes only the recorded run and binds output to the exact frozen request hash', async () => {
    const input = request(), settings = sourceWritingWorkflowSettings(env);
    const result = await new DifySourceWritingProvider(vi.fn().mockResolvedValue(detail(workflowId, output(input))))
      .resume(settings, runId, input, new AbortController().signal);
    expect(result.output.inputHash).toBe(canonicalManifestHash(input));
    const changed = { ...input, brief: { ...input.brief, topic: 'Different frozen topic' } };
    await expect(new DifySourceWritingProvider(vi.fn().mockResolvedValue(detail(workflowId, output(input))))
      .resume(settings, runId, changed, new AbortController().signal)).rejects.toMatchObject({ code: 'INCOMPATIBLE_CONTRACT' });
    await expect(new DifySourceWritingProvider(vi.fn().mockResolvedValue(detail(workflowId, output(input), randomUUID())))
      .resume(settings, runId, input, new AbortController().signal)).rejects.toMatchObject({ code: 'INCOMPATIBLE_CONTRACT' });
  });

  it('rejects a different workflow release and a run identity switch, cancelling the stream', async () => {
    await expect(new DifySourceWritingProvider(vi.fn().mockResolvedValue(stream(randomUUID(), output(request()))))
      .execute(sourceWritingWorkflowSettings(env), randomUUID(), request(), new AbortController().signal, vi.fn(), vi.fn()))
      .rejects.toMatchObject({ code: 'INCOMPATIBLE_CONTRACT' });
    let cancelled = 0;
    const foreignId = randomUUID();
    const body = new ReadableStream<Uint8Array>({ start(controller) {
      controller.enqueue(new TextEncoder().encode(event({ event: 'workflow_started', workflow_run_id: runId, data: { workflow_id: workflowId } })));
      controller.enqueue(new TextEncoder().encode(event({ event: 'node_finished', workflow_run_id: foreignId, data: {} })));
    }, cancel() { cancelled++; } });
    await expect(new DifySourceWritingProvider(vi.fn().mockResolvedValue(new Response(body, { headers: { 'content-type': 'text/event-stream' } })))
      .execute(sourceWritingWorkflowSettings(env), randomUUID(), request(), new AbortController().signal, vi.fn(), vi.fn()))
      .rejects.toMatchObject({ code: 'INCOMPATIBLE_CONTRACT' });
    expect(cancelled).toBe(1);
  });

  it('never resubmits after an unknown POST outcome and rejects malformed input before intent', async () => {
    const transport = vi.fn().mockRejectedValue(new TypeError('synthetic network interruption'));
    const beforeSubmit = vi.fn();
    const provider = new DifySourceWritingProvider(transport);
    await expect(provider.execute(sourceWritingWorkflowSettings(env), randomUUID(), request(), new AbortController().signal, beforeSubmit, vi.fn()))
      .rejects.toMatchObject({ code: 'UNKNOWN_OUTCOME', outcome: 'UNKNOWN' });
    expect(transport).toHaveBeenCalledOnce();
    const invalid = { ...request(), extra: 'not allowed' } as SourceWritingInput;
    await expect(provider.execute(sourceWritingWorkflowSettings(env), randomUUID(), invalid, new AbortController().signal, beforeSubmit, vi.fn()))
      .rejects.toMatchObject({ code: 'INVALID_INPUT', outcome: 'NOT_SUBMITTED' });
    expect(beforeSubmit).toHaveBeenCalledOnce();
    expect(transport).toHaveBeenCalledOnce();
  });

  it('enforces bounded responses and maps provider authentication errors without reading bodies', async () => {
    const input = request(), settings = sourceWritingWorkflowSettings(env);
    await expect(new DifySourceWritingProvider(vi.fn().mockResolvedValue(stream(workflowId,
      { ...output(input), padding: 'x'.repeat(500_001) }))).execute(settings, randomUUID(), input,
        new AbortController().signal, vi.fn(), vi.fn())).rejects.toMatchObject({ code: 'INCOMPATIBLE_CONTRACT' });
    await expect(new DifySourceWritingProvider(vi.fn().mockResolvedValue(new Response('synthetic', { status: 401 })))
      .execute(settings, randomUUID(), input, new AbortController().signal, vi.fn(), vi.fn()))
      .rejects.toMatchObject({ code: 'AUTH', outcome: 'KNOWN_FAILED' });
  });
});
