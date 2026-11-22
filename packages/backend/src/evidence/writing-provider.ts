import { z } from 'zod';
import { sourceWritingInputSchema, validateSourceWritingOutput, type SourceWritingInput } from './writing-contracts.js';

export const sourceWritingReleaseId = z.enum(['source-writing-2026-10-20.1', 'source-writing-2026-11-07.1', 'source-writing-2026-11-08.1', 'source-writing-2026-11-22.1']);
type SourceWritingReleaseId = z.infer<typeof sourceWritingReleaseId>;
const RELEASE_DIGESTS: Record<SourceWritingReleaseId, string> = {
  'source-writing-2026-10-20.1': '627ff3011fa324418e2d420290eb1e42ebb03f1a511b7822e376e3f13c024b75',
  'source-writing-2026-11-07.1': '2f81d936d16c47aeb2eacc071a72c211dd83af0352d349d70ee3bf81d04f2fa2',
  'source-writing-2026-11-08.1': 'e61f1cfc3b69f40ee8500c3fb3e34986b661d9f01228c084dcec4aa66e22e1c4',
  'source-writing-2026-11-22.1': 'b86d6c9334b9bef8e1450ee7715641320d3dd62e49f426bced0dec25f33bb624',
};
const RELEASE = {
  workflowIdEnv: 'DIFY_SOURCE_WRITING_PUBLISHED_WORKFLOW_ID',
  configDigestEnv: 'DIFY_SOURCE_WRITING_CONFIG_SHA256',
  apiKeyEnv: 'DIFY_SOURCE_WRITING_API_KEY',
  apiBaseEnv: 'DIFY_API_BASE_URL',
  inputVariable: 'source_writing_request_json',
  outputVariable: 'source_writing_json',
} as const;

const MAX_GET_BYTES = 2 * 1024 * 1024;
const MAX_SSE_EVENT_BYTES = 1024 * 1024;
const MAX_SSE_BYTES = 4 * 1024 * 1024;
const MAX_OUTPUT_CHARACTERS = 500_000;
const MAX_OUTPUT_BYTES = 500_000;

export type SourceWritingWorkflowSettings = Readonly<{
  endpoint: string;
  workflowId: string;
  releaseId: SourceWritingReleaseId;
  configDigest: string;
  apiKey: string;
}>;

export class SourceWritingProviderError extends Error {
  constructor(readonly code: 'CONFIG' | 'AUTH' | 'INVALID_INPUT' | 'INCOMPATIBLE_CONTRACT' | 'QUOTA' | 'RATE_LIMIT'
    | 'TRANSIENT_TRANSPORT' | 'TIMEOUT' | 'UNKNOWN_OUTCOME' | 'PROVIDER_FAILED',
  message: string, readonly outcome: 'NOT_SUBMITTED' | 'KNOWN_FAILED' | 'UNKNOWN' = 'KNOWN_FAILED') {
    super(message);
    this.name = 'SourceWritingProviderError';
  }
}

function uuid(value: string | undefined): value is string { return !!value && z.uuid().safeParse(value).success; }

function safeEndpoint(value: string | undefined, allowLocal: boolean): string | undefined {
  try {
    const url = new URL(value ?? '');
    if (url.protocol !== 'https:' && !(allowLocal && url.protocol === 'http:'
      && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) return;
    if (url.username || url.password || url.pathname.replace(/\/+$/u, '') !== '/v1' || url.search || url.hash) return;
    return `${url.origin}/v1`;
  } catch { return; }
}

function configuredRelease(env: Record<string, string | undefined>): Omit<SourceWritingWorkflowSettings, 'apiKey'> {
  const endpoint = safeEndpoint(env[RELEASE.apiBaseEnv], env['NODE_ENV'] !== 'production');
  const workflowId = env[RELEASE.workflowIdEnv];
  const digest = env[RELEASE.configDigestEnv];
  const releaseId = digest && sourceWritingReleaseId.options.find(id => RELEASE_DIGESTS[id] === digest);
  if (!endpoint || !uuid(workflowId) || !digest || !releaseId) {
    throw new SourceWritingProviderError('CONFIG', 'The published source-writing workflow release is not configured', 'NOT_SUBMITTED');
  }
  return { endpoint, workflowId, releaseId, configDigest: digest };
}

export function sourceWritingWorkflowRelease(env: Record<string, string | undefined> = process.env): Omit<SourceWritingWorkflowSettings, 'apiKey'> {
  return configuredRelease(env);
}

export function sourceWritingWorkflowSettings(env: Record<string, string | undefined> = process.env): SourceWritingWorkflowSettings {
  const apiKey = env[RELEASE.apiKeyEnv];
  if (!apiKey || apiKey.length > 500) throw new SourceWritingProviderError('CONFIG', 'The source-writing workflow API key is missing', 'NOT_SUBMITTED');
  return { ...configuredRelease(env), apiKey };
}

function failResponse(status: number): SourceWritingProviderError {
  if (status === 401 || status === 403) return new SourceWritingProviderError('AUTH', 'Source-writing workflow authentication failed', 'KNOWN_FAILED');
  if (status === 402) return new SourceWritingProviderError('QUOTA', 'Source-writing workflow quota is exhausted', 'KNOWN_FAILED');
  if (status === 429) return new SourceWritingProviderError('RATE_LIMIT', 'Source-writing workflow is rate limited', 'KNOWN_FAILED');
  if (status >= 500) return new SourceWritingProviderError('TRANSIENT_TRANSPORT', 'Source-writing workflow service is temporarily unavailable', 'UNKNOWN');
  return new SourceWritingProviderError('PROVIDER_FAILED', 'Source-writing workflow could not complete the request', 'KNOWN_FAILED');
}

function safeJson(text: string): unknown {
  try { return JSON.parse(text); } catch {
    throw new SourceWritingProviderError('INCOMPATIBLE_CONTRACT', 'Source-writing workflow returned invalid JSON');
  }
}

async function boundedJson(response: Response): Promise<unknown> {
  const reader = response.body?.getReader();
  if (!reader) throw new SourceWritingProviderError('INCOMPATIBLE_CONTRACT', 'Source-writing workflow returned an empty response');
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > MAX_GET_BYTES) {
        await reader.cancel();
        throw new SourceWritingProviderError('INCOMPATIBLE_CONTRACT', 'Source-writing workflow response exceeded its size limit');
      }
      chunks.push(next.value);
    }
    return safeJson(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
  } catch (error) {
    if (error instanceof SourceWritingProviderError) throw error;
    throw new SourceWritingProviderError('INCOMPATIBLE_CONTRACT', 'Source-writing workflow returned an invalid response');
  } finally { reader.releaseLock(); }
}

type Run = { workflowRunId: string; workflowId: string; status: string; outputs?: Record<string, unknown>; model: string | null };
type WorkflowConnection = Readonly<{ endpoint: string; workflowId: string; apiKey: string }>;

function runStarted(value: unknown, settings: WorkflowConnection, expectedRunId?: string): Run {
  const parsed = z.object({ workflow_run_id: z.uuid(), event: z.string().optional(), data: z.object({
    workflow_id: z.uuid(), status: z.string(), outputs: z.record(z.string(), z.unknown()).optional(),
    model: z.string().nullable().optional(),
  }).passthrough() }).passthrough().safeParse(value);
  if (!parsed.success || parsed.data.data.workflow_id !== settings.workflowId
    || (expectedRunId && parsed.data.workflow_run_id !== expectedRunId)) {
    throw new SourceWritingProviderError('INCOMPATIBLE_CONTRACT', 'Source-writing workflow run identity did not match the frozen release');
  }
  return { workflowRunId: parsed.data.workflow_run_id, workflowId: parsed.data.data.workflow_id,
    status: parsed.data.data.status, ...(parsed.data.data.outputs !== undefined ? { outputs: parsed.data.data.outputs } : {}),
    model: parsed.data.data.model ?? null };
}

function runDetail(value: unknown, settings: WorkflowConnection, expectedRunId: string): Run {
  const parsed = z.object({ id: z.uuid(), workflow_id: z.uuid(), status: z.string(),
    outputs: z.record(z.string(), z.unknown()).optional(), model: z.string().nullable().optional() }).passthrough().safeParse(value);
  if (!parsed.success || parsed.data.workflow_id !== settings.workflowId || parsed.data.id !== expectedRunId) {
    throw new SourceWritingProviderError('INCOMPATIBLE_CONTRACT', 'Source-writing workflow returned a different run identity');
  }
  return { workflowRunId: parsed.data.id, workflowId: parsed.data.workflow_id, status: parsed.data.status,
    ...(parsed.data.outputs !== undefined ? { outputs: parsed.data.outputs } : {}), model: parsed.data.model ?? null };
}

class CallbackError extends Error { constructor(readonly original: unknown) { super('Provider callback failed'); } }

async function streamRun(response: Response, settings: WorkflowConnection, signal: AbortSignal,
  recordRun: (id: string) => Promise<void>): Promise<Run> {
  if (!response.body) throw new SourceWritingProviderError('INCOMPATIBLE_CONTRACT', 'Source-writing workflow returned an empty stream');
  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let buffer = '', totalBytes = 0, capturedId: string | undefined, finalRun: Run | undefined;

  const processEvent = async (eventText: string) => {
    if (!eventText.trim()) return;
    if (Buffer.byteLength(eventText, 'utf8') > MAX_SSE_EVENT_BYTES) throw new SourceWritingProviderError('INCOMPATIBLE_CONTRACT', 'Source-writing stream event exceeded its size limit');
    const data = eventText.split(/\r?\n/u).filter(line => line.startsWith('data:'))
      .map(line => line.slice(5).trimStart()).join('\n');
    if (!data || data === '[DONE]') return;
    const payload = safeJson(data);
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return;
    const row = payload as Record<string, unknown>;
    const runId = row['workflow_run_id'];
    if (row['event'] === 'workflow_started') {
      const startedRunId = typeof runId === 'string' && uuid(runId) ? runId : undefined;
      const startedData = row['data'];
      const workflowId = startedData && typeof startedData === 'object' && !Array.isArray(startedData)
        ? (startedData as Record<string, unknown>)['workflow_id'] : undefined;
      if (!startedRunId || workflowId !== settings.workflowId) {
        throw new SourceWritingProviderError('INCOMPATIBLE_CONTRACT', 'Source-writing workflow release identity did not match');
      }
      if (capturedId && capturedId !== startedRunId) throw new SourceWritingProviderError('INCOMPATIBLE_CONTRACT', 'Source-writing workflow changed its run identity');
      if (!capturedId) {
        capturedId = startedRunId;
        try { await recordRun(startedRunId); } catch (error) { throw new CallbackError(error); }
      }
      return;
    }
    if (typeof runId === 'string' && uuid(runId) && capturedId && capturedId !== runId) {
      throw new SourceWritingProviderError('INCOMPATIBLE_CONTRACT', 'Source-writing workflow changed its run identity');
    }
    if (row['event'] === 'workflow_finished') {
      const dataRow = row['data'];
      if (!dataRow || typeof dataRow !== 'object' || Array.isArray(dataRow) || !capturedId) throw new SourceWritingProviderError('INCOMPATIBLE_CONTRACT', 'Source-writing completion event was invalid');
      const details = dataRow as Record<string, unknown>;
      finalRun = runStarted({ workflow_run_id: capturedId, data: { workflow_id: details['workflow_id'], status: details['status'],
        outputs: details['outputs'], model: details['model'] } }, settings);
    }
    if (row['event'] === 'error') throw new SourceWritingProviderError('PROVIDER_FAILED', 'Source-writing workflow reported a failure', 'KNOWN_FAILED');
  };

  try {
    while (true) {
      if (signal.aborted) throw new SourceWritingProviderError('TIMEOUT', 'Source-writing workflow exceeded its execution deadline', 'UNKNOWN');
      const next = await reader.read();
      if (next.done) break;
      totalBytes += next.value.byteLength;
      if (totalBytes > MAX_SSE_BYTES) {
        await reader.cancel();
        throw new SourceWritingProviderError('INCOMPATIBLE_CONTRACT', 'Source-writing workflow stream exceeded its size limit');
      }
      buffer += decoder.decode(next.value, { stream: true });
      let boundary: RegExpExecArray | null;
      while ((boundary = /\r?\n\r?\n/u.exec(buffer)) !== null) {
        const event = buffer.slice(0, boundary.index);
        buffer = buffer.slice(boundary.index + boundary[0].length);
        await processEvent(event);
      }
      if (Buffer.byteLength(buffer, 'utf8') > MAX_SSE_EVENT_BYTES) throw new SourceWritingProviderError('INCOMPATIBLE_CONTRACT', 'Source-writing stream event exceeded its size limit');
    }
    buffer += decoder.decode();
    if (buffer.trim()) await processEvent(buffer);
  } catch (error) {
    try { await reader.cancel(); } catch { /* response may already be closed */ }
    if (error instanceof CallbackError) throw error.original;
    if (error instanceof SourceWritingProviderError) throw error;
    if (signal.aborted || error instanceof TypeError) throw new SourceWritingProviderError('UNKNOWN_OUTCOME', 'Source-writing workflow outcome is unknown; the captured run must be reconciled', 'UNKNOWN');
    throw new SourceWritingProviderError('INCOMPATIBLE_CONTRACT', 'Source-writing workflow returned an invalid stream');
  } finally { reader.releaseLock(); }
  if (!finalRun) throw new SourceWritingProviderError('UNKNOWN_OUTCOME', 'Source-writing workflow ended before completion; reconcile its captured run', 'UNKNOWN');
  return finalRun;
}

function outputFromRun(run: Run, request: SourceWritingInput) {
  if (run.status !== 'succeeded') throw new SourceWritingProviderError('PROVIDER_FAILED', 'Source-writing workflow did not succeed', 'KNOWN_FAILED');
  const raw = run.outputs?.[RELEASE.outputVariable];
  if (typeof raw !== 'string' || [...raw].length > MAX_OUTPUT_CHARACTERS || Buffer.byteLength(raw, 'utf8') > MAX_OUTPUT_BYTES) {
    throw new SourceWritingProviderError('INCOMPATIBLE_CONTRACT', 'Source-writing output is missing or exceeds its size limit');
  }
  try { return validateSourceWritingOutput(safeJson(raw), request); }
  catch { throw new SourceWritingProviderError('INCOMPATIBLE_CONTRACT', 'Source-writing output did not match the frozen request or evidence'); }
}

function pollDelay(signal: AbortSignal): Promise<void> {
  return new Promise(resolve => {
    const timer = setTimeout(done, 1500);
    function done() { clearTimeout(timer); signal.removeEventListener('abort', done); resolve(); }
    signal.addEventListener('abort', done, { once: true });
  });
}

export class DifySourceWritingProvider {
  constructor(private readonly transport: typeof fetch = fetch) {}

  private headers(settings: SourceWritingWorkflowSettings) {
    return { Authorization: `Bearer ${settings.apiKey}`, 'Content-Type': 'application/json', Accept: 'text/event-stream' };
  }

  async execute(settings: SourceWritingWorkflowSettings, jobId: string, input: SourceWritingInput, signal: AbortSignal,
    beforeSubmit: () => Promise<void>, recordRun: (id: string) => Promise<void>) {
    let request: SourceWritingInput;
    try { request = sourceWritingInputSchema.parse(input); }
    catch { throw new SourceWritingProviderError('INVALID_INPUT', 'Frozen source-writing request is invalid', 'NOT_SUBMITTED'); }
    if (!uuid(jobId)) throw new SourceWritingProviderError('INVALID_INPUT', 'Source-writing job identity is invalid', 'NOT_SUBMITTED');
    await beforeSubmit();
    let response: Response;
    try {
      response = await this.transport(`${settings.endpoint}/workflows/run`, { method: 'POST', headers: this.headers(settings),
        redirect: 'error', signal, body: JSON.stringify({ inputs: { [RELEASE.inputVariable]: JSON.stringify(request) },
          response_mode: 'streaming', user: `job-${jobId}` }) });
    } catch { throw new SourceWritingProviderError('UNKNOWN_OUTCOME', 'Source-writing submission outcome is unknown', 'UNKNOWN'); }
    if (!response.ok) { await response.body?.cancel(); throw failResponse(response.status); }
    if (!(response.headers.get('content-type') ?? '').toLowerCase().includes('text/event-stream')) {
      await response.body?.cancel();
      throw new SourceWritingProviderError('INCOMPATIBLE_CONTRACT', 'Source-writing workflow did not honor its streaming response mode', 'UNKNOWN');
    }
    const run = await streamRun(response, settings, signal, recordRun);
    return { output: outputFromRun(run, request), workflowRunId: run.workflowRunId, model: run.model };
  }

  async resume(settings: SourceWritingWorkflowSettings, runId: string, input: SourceWritingInput, signal: AbortSignal) {
    if (!uuid(runId)) throw new SourceWritingProviderError('CONFIG', 'Captured source-writing run ID is invalid');
    let request: SourceWritingInput;
    try { request = sourceWritingInputSchema.parse(input); }
    catch { throw new SourceWritingProviderError('INVALID_INPUT', 'Frozen source-writing request is invalid'); }
    while (!signal.aborted) {
      let response: Response;
      try {
        response = await this.transport(`${settings.endpoint}/workflows/run/${encodeURIComponent(runId)}`, {
          headers: { Authorization: `Bearer ${settings.apiKey}`, Accept: 'application/json' }, redirect: 'error', signal });
      } catch {
        if (signal.aborted) break;
        await pollDelay(signal);
        continue;
      }
      if (!response.ok) { await response.body?.cancel(); throw failResponse(response.status); }
      const run = runDetail(await boundedJson(response), settings, runId);
      if (['running', 'paused'].includes(run.status)) { await pollDelay(signal); continue; }
      return { output: outputFromRun(run, request), workflowRunId: run.workflowRunId, model: run.model };
    }
    throw new SourceWritingProviderError('TIMEOUT', 'Source-writing workflow did not finish before the execution deadline', 'UNKNOWN');
  }
}

/** Shared bounded Workflow API transport. Domain adapters validate both ends. */
export class DifyJsonWorkflowProvider {
  constructor(private readonly inputVariable: string, private readonly outputVariable: string,
    private readonly transport: typeof fetch = fetch) {}

  private result(run: Run) {
    if (run.status !== 'succeeded') throw new SourceWritingProviderError('PROVIDER_FAILED', 'Workflow did not succeed');
    const raw = run.outputs?.[this.outputVariable];
    if (typeof raw !== 'string' || Buffer.byteLength(raw, 'utf8') > MAX_OUTPUT_BYTES) {
      throw new SourceWritingProviderError('INCOMPATIBLE_CONTRACT', 'Workflow output is missing or exceeds its limit');
    }
    return { output: safeJson(raw), workflowRunId: run.workflowRunId, model: run.model };
  }

  async execute(settings: WorkflowConnection, jobId: string, input: unknown, signal: AbortSignal,
    beforeSubmit: () => Promise<void>, recordRun: (id: string) => Promise<void>) {
    if (!uuid(jobId) || Buffer.byteLength(JSON.stringify(input), 'utf8') > 150_000) {
      throw new SourceWritingProviderError('INVALID_INPUT', 'Workflow request exceeds its bound', 'NOT_SUBMITTED');
    }
    await beforeSubmit();
    let response: Response;
    try {
      response = await this.transport(`${settings.endpoint}/workflows/run`, { method: 'POST', redirect: 'error', signal,
        headers: { Authorization: `Bearer ${settings.apiKey}`, 'Content-Type': 'application/json', Accept: 'text/event-stream' },
        body: JSON.stringify({ inputs: { [this.inputVariable]: JSON.stringify(input) }, response_mode: 'streaming', user: `job-${jobId}` }) });
    } catch { throw new SourceWritingProviderError('UNKNOWN_OUTCOME', 'Workflow submission outcome is unknown', 'UNKNOWN'); }
    if (!response.ok) { await response.body?.cancel(); throw failResponse(response.status); }
    if (!(response.headers.get('content-type') ?? '').toLowerCase().includes('text/event-stream')) {
      await response.body?.cancel();
      throw new SourceWritingProviderError('INCOMPATIBLE_CONTRACT', 'Workflow did not return its captured-run stream', 'UNKNOWN');
    }
    return this.result(await streamRun(response, settings, signal, recordRun));
  }

  async resume(settings: WorkflowConnection, runId: string, _input: unknown, signal: AbortSignal) {
    if (!uuid(runId)) throw new SourceWritingProviderError('CONFIG', 'Captured workflow run is invalid');
    while (!signal.aborted) {
      let response: Response;
      try {
        response = await this.transport(`${settings.endpoint}/workflows/run/${encodeURIComponent(runId)}`, {
          headers: { Authorization: `Bearer ${settings.apiKey}`, Accept: 'application/json' }, redirect: 'error', signal });
      } catch { if (signal.aborted) break; await pollDelay(signal); continue; }
      if (!response.ok) { await response.body?.cancel(); throw failResponse(response.status); }
      const run = runDetail(await boundedJson(response), settings, runId);
      if (['running', 'paused'].includes(run.status)) { await pollDelay(signal); continue; }
      return this.result(run);
    }
    throw new SourceWritingProviderError('TIMEOUT', 'Workflow did not finish before its deadline', 'UNKNOWN');
  }
}
