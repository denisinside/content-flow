import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { DifyJsonWorkflowProvider } from './writing-provider.js';

const workflowId = randomUUID(), runId = randomUUID();
const settings = { endpoint: 'https://dify.example.test/v1', workflowId, apiKey: 'synthetic-key' };
const event = (data: unknown) => `data: ${JSON.stringify(data)}\n\n`;
function stream(id = workflowId) {
  return new Response(event({ event: 'workflow_started', workflow_run_id: runId, data: { workflow_id: id } })
    + event({ event: 'workflow_finished', workflow_run_id: runId, data: { workflow_id: id, status: 'succeeded',
      outputs: { brief_proposal_json: JSON.stringify({ candidate: 'synthetic' }) } } }), { headers: { 'content-type': 'text/event-stream' } });
}
describe('shared captured-run JSON workflow transport', () => {
  it('uses the configured variables and captures a run before returning its untrusted candidate', async () => {
    const transport = vi.fn<typeof fetch>().mockResolvedValue(stream()), intent = vi.fn(), captured = vi.fn();
    const result = await new DifyJsonWorkflowProvider('brief_request_json', 'brief_proposal_json', transport)
      .execute(settings, randomUUID(), { topic: 'Synthetic topic' }, new AbortController().signal, intent, captured);
    expect(intent).toHaveBeenCalledOnce(); expect(captured).toHaveBeenCalledExactlyOnceWith(runId);
    expect(result).toMatchObject({ output: { candidate: 'synthetic' }, workflowRunId: runId });
    expect(JSON.parse(transport.mock.calls[0]![1]!.body as string)).toMatchObject({
      inputs: { brief_request_json: JSON.stringify({ topic: 'Synthetic topic' }) }, response_mode: 'streaming' });
  });
  it('rejects another workflow and does not silently submit again after an uncertain POST', async () => {
    await expect(new DifyJsonWorkflowProvider('request', 'brief_proposal_json', vi.fn().mockResolvedValue(stream(randomUUID())))
      .execute(settings, randomUUID(), {}, new AbortController().signal, async () => {}, async () => {}))
      .rejects.toMatchObject({ code: 'INCOMPATIBLE_CONTRACT' });
    const transport = vi.fn<typeof fetch>().mockRejectedValue(new Error('synthetic transport failure'));
    await expect(new DifyJsonWorkflowProvider('request', 'output', transport)
      .execute(settings, randomUUID(), {}, new AbortController().signal, async () => {}, async () => {}))
      .rejects.toMatchObject({ code: 'UNKNOWN_OUTCOME', outcome: 'UNKNOWN' });
    expect(transport).toHaveBeenCalledOnce();
  });
  it('reconciles by GET only and rejects a different captured identity', async () => {
    const transport = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ id: runId, workflow_id: workflowId,
      status: 'succeeded', outputs: { result: '{"ok":true}' } })));
    expect((await new DifyJsonWorkflowProvider('input', 'result', transport)
      .resume(settings, runId, {}, new AbortController().signal)).output).toEqual({ ok: true });
    expect(transport.mock.calls[0]![0]).toBe(`${settings.endpoint}/workflows/run/${runId}`);
    expect(transport.mock.calls[0]![1]).not.toHaveProperty('body');
    const wrong = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ id: randomUUID(), workflow_id: workflowId, status: 'succeeded' })));
    await expect(new DifyJsonWorkflowProvider('input', 'result', wrong)
      .resume(settings, runId, {}, new AbortController().signal)).rejects.toMatchObject({ code: 'INCOMPATIBLE_CONTRACT' });
  });
});
