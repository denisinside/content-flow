import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { CLAIMS_CONTRACT, ClaimProviderError, DifyClaimProvider, claimWorkflowRelease, claimWorkflowSettings } from './provider.js';

const workflowId = 'b21081a2-114a-4ce9-91d8-21241a03b70c';
const runId = 'f8f453dc-5ff8-44d5-a5c5-6cd1af37092b';
const run = { workflow_run_id: runId, data: { workflow_id: workflowId, status: 'succeeded', outputs: {
  claims_json: { schemaVersion: CLAIMS_CONTRACT, claims: [], conflicts: [] },
} } };
const env = { NODE_ENV: 'test', TEST_DIFY_API_BASE_URL: 'http://127.0.0.1:8080/v1', TEST_DIFY_CLAIM_EXTRACTION_PUBLISHED_WORKFLOW_ID: workflowId,
  TEST_DIFY_CLAIM_EXTRACTION_CONFIG_SHA256: '9c8619e05041a0de3c3eb4fb925b96c68bb7b0166d6be1dfc7f259e750f9af3c',
  TEST_DIFY_CLAIM_EXTRACTION_API_KEY: 'synthetic-test-key' };
const source = [{ snapshotId: 'a11081a2-114a-4ce9-91d8-21241a03b70c', materialId: 'c21081a2-114a-4ce9-91d8-21241a03b70c',
  sha256: 'a'.repeat(64), fragments: [{ id: 'd21081a2-114a-4ce9-91d8-21241a03b70c', startOffset: 0, endOffset: 6, sha256: 'b'.repeat(64), text: 'Kyiv is a city' }] }];
function response(body: string | Uint8Array, contentType = 'text/event-stream'): Response { return new Response(body, { status: 200, headers: { 'content-type': contentType } }); }
function stream(chunks: Uint8Array[]): Response {
  let index = 0;
  return new Response(new ReadableStream<Uint8Array>({ pull(controller) { if (index < chunks.length) controller.enqueue(chunks[index++]); else controller.close(); } }),
    { status: 200, headers: { 'content-type': 'text/event-stream' } });
}
const event = (value: unknown) => new TextEncoder().encode(`data: ${JSON.stringify(value)}\r\n\r\n`);

describe('Dify claim workflow boundary', () => {
  it('requires an explicit published workflow mapping and matching release digest, without exposing keys in the frozen release', () => {
    expect(() => claimWorkflowRelease({ NODE_ENV: 'test', TEST_DIFY_API_BASE_URL: 'http://127.0.0.1' })).toThrow(ClaimProviderError);
    expect(() => claimWorkflowRelease({ ...env, TEST_DIFY_CLAIM_EXTRACTION_CONFIG_SHA256: '0'.repeat(64) })).toThrow(ClaimProviderError);
    const release = claimWorkflowRelease(env);
    expect(release).not.toHaveProperty('apiKey');
    expect(claimWorkflowSettings(env).apiKey).toBe('synthetic-test-key');
  });

  it('keeps the checked-in prompt and release digest reproducible', () => {
    const root = new URL('./workflows/claim-extraction/', import.meta.url);
    const artifact = JSON.parse(readFileSync(new URL('release.json', root), 'utf8')) as Record<string, unknown>;
    const promptHash = createHash('sha256').update(readFileSync(new URL('prompt.md', root))).digest('hex');
    expect(artifact['promptSha256']).toBe(promptHash);
    const workflowDslHash = createHash('sha256').update(readFileSync(new URL(String(artifact['workflowDslFile']), root))).digest('hex');
    expect(artifact['workflowDslSha256']).toBe(workflowDslHash);
    const { configDigest, ...unsigned } = artifact;
    const canonical = (value: unknown): string => value === null || typeof value !== 'object' ? JSON.stringify(value) ?? 'null'
      : Array.isArray(value) ? `[${value.map(canonical).join(',')}]`
        : `{${Object.keys(value as Record<string, unknown>).sort().map(key => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(',')}}`;
    expect(configDigest).toBe(createHash('sha256').update(canonical(unsigned)).digest('hex'));
    expect(configDigest).toBe(claimWorkflowRelease(env).configDigest);
  });

  it('captures workflow_run_id from a split UTF-8 SSE stream and validates exact published workflow identity', async () => {
    const payload = { ...run, data: { ...run.data, outputs: { claims_json: JSON.stringify({ schemaVersion: CLAIMS_CONTRACT, claims: [], conflicts: [] }) } } };
    const encoded = event({ event: 'workflow_finished', workflow_run_id: runId, data: payload.data });
    // Split in the middle of a multibyte character to exercise streaming TextDecoder state.
    const start = event({ event: 'workflow_started', workflow_run_id: runId });
    const utf8 = new TextEncoder().encode('data: {"note":"Київ"}\r\n\r\n');
    const cityIndex = utf8.findIndex(byte => byte >= 0xd0);
    const chunks = [start, utf8.slice(0, cityIndex + 1), utf8.slice(cityIndex + 1), encoded];
    const transport = vi.fn().mockResolvedValue(stream(chunks));
    const provider = new DifyClaimProvider(transport);
    const recorded: string[] = [];
    const result = await provider.execute(claimWorkflowSettings(env), runId, source, new AbortController().signal, vi.fn(), async id => { recorded.push(id); });
    expect(recorded).toEqual([runId]);
    expect(result.output).toEqual({ schemaVersion: CLAIMS_CONTRACT, claims: [], conflicts: [] });
    expect(transport).toHaveBeenCalledWith(`http://127.0.0.1:8080/v1/workflows/${workflowId}/run`, expect.objectContaining({ method: 'POST' }));
    expect(result.model).toBeNull();
  });

  it('resumes the exact captured run using Dify’s flat run-detail response and polls until terminal', async () => {
    const detail = { id: runId, workflow_id: workflowId, status: 'succeeded', outputs: run.data.outputs, error: null };
    const transport = vi.fn().mockResolvedValueOnce(response(JSON.stringify({ ...detail, status: 'running', outputs: {} }), 'application/json'))
      .mockResolvedValueOnce(response(JSON.stringify(detail), 'application/json'));
    const provider = new DifyClaimProvider(transport);
    expect((await provider.resume(claimWorkflowSettings(env), runId, new AbortController().signal)).workflowRunId).toBe(runId);
    expect(transport).toHaveBeenCalledTimes(2);
    expect(transport).toHaveBeenCalledWith(`http://127.0.0.1:8080/v1/workflows/run/${runId}`, expect.objectContaining({
      headers: { Authorization: 'Bearer synthetic-test-key', Accept: 'application/json' }, redirect: 'error' }));
  });

  it('rejects a resumed run with a different ID or published workflow version', async () => {
    const wrong = { id: 'e21081a2-114a-4ce9-91d8-21241a03b70c', workflow_id: 'c31081a2-114a-4ce9-91d8-21241a03b70c', status: 'succeeded', outputs: run.data.outputs };
    const mismatch = new DifyClaimProvider(vi.fn().mockResolvedValue(response(JSON.stringify(wrong), 'application/json')));
    await expect(mismatch.resume(claimWorkflowSettings(env), runId, new AbortController().signal)).rejects.toMatchObject({ code: 'INCOMPATIBLE_CONTRACT' });
  });

  it('records submission intent before POST and classifies a lost response as unknown without resubmitting', async () => {
    const order: string[] = [];
    const provider = new DifyClaimProvider(vi.fn().mockImplementation(async () => { order.push('post'); throw new TypeError('network'); }));
    await expect(provider.execute(claimWorkflowSettings(env), runId, source, new AbortController().signal,
      async () => { order.push('intent'); }, vi.fn())).rejects.toMatchObject({ code: 'UNKNOWN_OUTCOME', outcome: 'UNKNOWN' });
    expect(order).toEqual(['intent', 'post']);
  });

  it('rejects malformed/oversized output and a wrong returned workflow ID', async () => {
    const malformed = { ...run, data: { ...run.data, outputs: { claims_json: { schemaVersion: CLAIMS_CONTRACT, claims: [{ key: 'x', surprise: true }], conflicts: [] } } } };
    const provider = new DifyClaimProvider(vi.fn().mockResolvedValue(stream([event({ event: 'workflow_started', workflow_run_id: runId }),
      event({ event: 'workflow_finished', workflow_run_id: runId, data: malformed.data })])));
    await expect(provider.execute(claimWorkflowSettings(env), runId, source, new AbortController().signal, vi.fn(), vi.fn()))
      .rejects.toMatchObject({ code: 'INCOMPATIBLE_CONTRACT' });
    const oversized = new DifyClaimProvider(vi.fn().mockResolvedValue(response(new Uint8Array(512 * 1024 + 1), 'application/json')));
    await expect(oversized.resume(claimWorkflowSettings(env), runId, new AbortController().signal)).rejects.toThrow();
  });
});
