import { z } from 'zod';
import { embeddingRequestSchema, validateEmbeddingOutput, type EmbeddingOutput, type EmbeddingRequest } from './contracts.js';

const RELEASE = {
  releaseId: 'source-embedding-2026-10-20.1',
  configDigest: 'd6b74609adb0e83fdb04110ee14976eadec2c033964289b9190822fe5763973c',
  workflowIdEnv: 'DIFY_SOURCE_EMBEDDING_PUBLISHED_WORKFLOW_ID',
  configDigestEnv: 'DIFY_SOURCE_EMBEDDING_CONFIG_SHA256',
  apiKeyEnv: 'DIFY_SOURCE_EMBEDDING_API_KEY',
  apiBaseEnv: 'DIFY_API_BASE_URL',
  inputVariable: 'embedding_request_json',
  outputVariable: 'embedding_json',
  responseMode: 'streaming',
} as const;

const MAX_GET_BYTES = 2 * 1024 * 1024;
const MAX_SSE_EVENT_BYTES = 1024 * 1024;
const MAX_SSE_BYTES = 4 * 1024 * 1024;
const MAX_OUTPUT_CHARACTERS = 400_000;

export type EmbeddingWorkflowSettings = Readonly<{
  endpoint: string;
  workflowId: string;
  releaseId: typeof RELEASE.releaseId;
  configDigest: string;
  apiKey: string;
}>;

export class EmbeddingProviderError extends Error {
  constructor(readonly code: 'CONFIG' | 'AUTH' | 'INVALID_INPUT' | 'INCOMPATIBLE_CONTRACT' | 'QUOTA' | 'RATE_LIMIT'
    | 'TRANSIENT_TRANSPORT' | 'TIMEOUT' | 'UNKNOWN_OUTCOME' | 'PROVIDER_FAILED',
  message: string, readonly outcome: 'NOT_SUBMITTED' | 'KNOWN_FAILED' | 'UNKNOWN' = 'KNOWN_FAILED') {
    super(message);
    this.name = 'EmbeddingProviderError';
  }
}

function uuid(value: string | undefined): value is string {
  return !!value && z.uuid().safeParse(value).success;
}

function safeEndpoint(value: string | undefined, allowLocal: boolean): string | undefined {
  try {
    const url = new URL(value ?? '');
    if (url.protocol !== 'https:' && !(allowLocal && url.protocol === 'http:'
      && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) return;
    if (url.username || url.password || url.pathname.replace(/\/+$/u, '') !== '/v1' || url.search || url.hash) return;
    return `${url.origin}/v1`;
  } catch { return; }
}

function configuredRelease(env: Record<string, string | undefined>): Omit<EmbeddingWorkflowSettings, 'apiKey'> {
  const endpoint = safeEndpoint(env[RELEASE.apiBaseEnv], env['NODE_ENV'] !== 'production');
  const workflowId = env[RELEASE.workflowIdEnv];
  const digest = env[RELEASE.configDigestEnv];
  if (!endpoint || !uuid(workflowId) || digest !== RELEASE.configDigest) {
    throw new EmbeddingProviderError('CONFIG', 'The published source-embedding workflow release is not configured', 'NOT_SUBMITTED');
  }
  return { endpoint, workflowId, releaseId: RELEASE.releaseId, configDigest: RELEASE.configDigest };
}

export function embeddingWorkflowRelease(env: Record<string, string | undefined> = process.env): Omit<EmbeddingWorkflowSettings, 'apiKey'> {
  return configuredRelease(env);
}

export function embeddingWorkflowSettings(env: Record<string, string | undefined> = process.env): EmbeddingWorkflowSettings {
  const apiKey = env[RELEASE.apiKeyEnv];
  if (!apiKey || apiKey.length > 500) throw new EmbeddingProviderError('CONFIG', 'The source-embedding workflow API key is missing', 'NOT_SUBMITTED');
  return { ...configuredRelease(env), apiKey };
}

function failResponse(status: number): EmbeddingProviderError {
  if (status === 401 || status === 403) return new EmbeddingProviderError('AUTH', 'Source-embedding workflow authentication failed', 'KNOWN_FAILED');
  if (status === 402) return new EmbeddingProviderError('QUOTA', 'Source-embedding workflow quota is exhausted', 'KNOWN_FAILED');
  if (status === 429) return new EmbeddingProviderError('RATE_LIMIT', 'Source-embedding workflow is rate limited', 'KNOWN_FAILED');
  if (status >= 500) return new EmbeddingProviderError('TRANSIENT_TRANSPORT', 'Source-embedding workflow service is temporarily unavailable', 'UNKNOWN');
  return new EmbeddingProviderError('PROVIDER_FAILED', 'Source-embedding workflow could not complete the request', 'KNOWN_FAILED');
}

function safeJson(text: string): unknown {
  try { return JSON.parse(text); } catch {
    throw new EmbeddingProviderError('INCOMPATIBLE_CONTRACT', 'Source-embedding workflow returned invalid JSON');
  }
}

async function boundedJson(response: Response): Promise<unknown> {
  const reader = response.body?.getReader();
  if (!reader) throw new EmbeddingProviderError('INCOMPATIBLE_CONTRACT', 'Source-embedding workflow returned an empty response');
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > MAX_GET_BYTES) {
        await reader.cancel();
        throw new EmbeddingProviderError('INCOMPATIBLE_CONTRACT', 'Source-embedding workflow response exceeded its size limit');
      }
      chunks.push(next.value);
    }
    return safeJson(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
  } catch (error) {
    if (error instanceof EmbeddingProviderError) throw error;
    throw new EmbeddingProviderError('INCOMPATIBLE_CONTRACT', 'Source-embedding workflow returned an invalid response');
  } finally { reader.releaseLock(); }
}

type Run = { workflowRunId: string; workflowId: string; status: string; outputs?: Record<string, unknown>; model: string | null };

function runStarted(value: unknown, settings: EmbeddingWorkflowSettings, expectedRunId?: string): Run {
  const parsed = z.object({ workflow_run_id: z.uuid(), event: z.string().optional(), data: z.object({
    workflow_id: z.uuid(), status: z.string(), outputs: z.record(z.string(), z.unknown()).optional(),
    model: z.string().nullable().optional(),
  }).passthrough() }).passthrough().safeParse(value);
  if (!parsed.success || parsed.data.data.workflow_id !== settings.workflowId
    || (expectedRunId && parsed.data.workflow_run_id !== expectedRunId)) {
    throw new EmbeddingProviderError('INCOMPATIBLE_CONTRACT', 'Source-embedding workflow run identity did not match the frozen release');
  }
  return { workflowRunId: parsed.data.workflow_run_id, workflowId: parsed.data.data.workflow_id,
    status: parsed.data.data.status, ...(parsed.data.data.outputs !== undefined ? { outputs: parsed.data.data.outputs } : {}),
    model: parsed.data.data.model ?? null };
}

function runDetail(value: unknown, settings: EmbeddingWorkflowSettings, expectedRunId: string): Run {
  const parsed = z.object({ id: z.uuid(), workflow_id: z.uuid(), status: z.string(),
    outputs: z.record(z.string(), z.unknown()).optional(), model: z.string().nullable().optional() }).passthrough().safeParse(value);
  if (!parsed.success || parsed.data.workflow_id !== settings.workflowId || parsed.data.id !== expectedRunId) {
    throw new EmbeddingProviderError('INCOMPATIBLE_CONTRACT', 'Source-embedding workflow returned a different run identity');
  }
  return { workflowRunId: parsed.data.id, workflowId: parsed.data.workflow_id, status: parsed.data.status,
    ...(parsed.data.outputs !== undefined ? { outputs: parsed.data.outputs } : {}), model: parsed.data.model ?? null };
}

class CallbackError extends Error { constructor(readonly original: unknown) { super('Provider callback failed'); } }

async function streamRun(response: Response, settings: EmbeddingWorkflowSettings, signal: AbortSignal,
  recordRun: (id: string) => Promise<void>): Promise<Run> {
  if (!response.body) throw new EmbeddingProviderError('INCOMPATIBLE_CONTRACT', 'Source-embedding workflow returned an empty stream');
  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let buffer = '', totalBytes = 0, capturedId: string | undefined, finalRun: Run | undefined;

  const processEvent = async (eventText: string) => {
    if (!eventText.trim()) return;
    if (Buffer.byteLength(eventText, 'utf8') > MAX_SSE_EVENT_BYTES) throw new EmbeddingProviderError('INCOMPATIBLE_CONTRACT', 'Source-embedding stream event exceeded its size limit');
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
        throw new EmbeddingProviderError('INCOMPATIBLE_CONTRACT', 'Source-embedding workflow release identity did not match');
      }
      if (capturedId && capturedId !== startedRunId) throw new EmbeddingProviderError('INCOMPATIBLE_CONTRACT', 'Source-embedding workflow changed its run identity');
      if (!capturedId) {
        capturedId = startedRunId;
        try { await recordRun(startedRunId); } catch (error) { throw new CallbackError(error); }
      }
      return;
    }
    if (typeof runId === 'string' && uuid(runId) && capturedId && capturedId !== runId) {
      throw new EmbeddingProviderError('INCOMPATIBLE_CONTRACT', 'Source-embedding workflow changed its run identity');
    }
    if (row['event'] === 'workflow_finished') {
      const dataRow = row['data'];
      if (!dataRow || typeof dataRow !== 'object' || Array.isArray(dataRow) || !capturedId) throw new EmbeddingProviderError('INCOMPATIBLE_CONTRACT', 'Source-embedding completion event was invalid');
      const details = dataRow as Record<string, unknown>;
      finalRun = runStarted({ workflow_run_id: capturedId, data: { workflow_id: details['workflow_id'], status: details['status'],
        outputs: details['outputs'], model: details['model'] } }, settings);
    }
    if (row['event'] === 'error') throw new EmbeddingProviderError('PROVIDER_FAILED', 'Source-embedding workflow reported a failure', 'KNOWN_FAILED');
  };

  try {
    while (true) {
      if (signal.aborted) throw new EmbeddingProviderError('TIMEOUT', 'Source-embedding workflow exceeded its execution deadline', 'UNKNOWN');
      const next = await reader.read();
      if (next.done) break;
      totalBytes += next.value.byteLength;
      if (totalBytes > MAX_SSE_BYTES) {
        await reader.cancel();
        throw new EmbeddingProviderError('INCOMPATIBLE_CONTRACT', 'Source-embedding workflow stream exceeded its size limit');
      }
      buffer += decoder.decode(next.value, { stream: true });
      let boundary: RegExpExecArray | null;
      while ((boundary = /\r?\n\r?\n/u.exec(buffer)) !== null) {
        const event = buffer.slice(0, boundary.index);
        buffer = buffer.slice(boundary.index + boundary[0].length);
        await processEvent(event);
      }
      if (Buffer.byteLength(buffer, 'utf8') > MAX_SSE_EVENT_BYTES) throw new EmbeddingProviderError('INCOMPATIBLE_CONTRACT', 'Source-embedding stream event exceeded its size limit');
    }
    buffer += decoder.decode();
    if (buffer.trim()) await processEvent(buffer);
  } catch (error) {
    // Stop consuming provider output once the run is rejected. In particular,
    // do not leave a live response body behind after a contract failure.
    try { await reader.cancel(); } catch { /* the stream may already be closed */ }
    if (error instanceof CallbackError) throw error.original;
    if (error instanceof EmbeddingProviderError) throw error;
    if (signal.aborted || error instanceof TypeError) throw new EmbeddingProviderError('UNKNOWN_OUTCOME', 'Source-embedding workflow outcome is unknown; the captured run must be reconciled', 'UNKNOWN');
    throw new EmbeddingProviderError('INCOMPATIBLE_CONTRACT', 'Source-embedding workflow returned an invalid stream');
  } finally { reader.releaseLock(); }
  if (!finalRun) throw new EmbeddingProviderError('UNKNOWN_OUTCOME', 'Source-embedding workflow ended before completion; reconcile its captured run', 'UNKNOWN');
  return finalRun;
}

function outputFromRun(run: Run, request: EmbeddingRequest): EmbeddingOutput {
  if (run.status !== 'succeeded') throw new EmbeddingProviderError('PROVIDER_FAILED', 'Source-embedding workflow did not succeed', 'KNOWN_FAILED');
  const raw = run.outputs?.[RELEASE.outputVariable];
  if (typeof raw !== 'string' || [...raw].length > MAX_OUTPUT_CHARACTERS || Buffer.byteLength(raw, 'utf8') > 1024 * 1024) {
    throw new EmbeddingProviderError('INCOMPATIBLE_CONTRACT', 'Source-embedding output is missing or exceeds its size limit');
  }
  try { return validateEmbeddingOutput(safeJson(raw), request); }
  catch (error) {
    if (error instanceof EmbeddingProviderError) throw error;
    throw new EmbeddingProviderError('INCOMPATIBLE_CONTRACT', 'Source-embedding output did not match the requested texts');
  }
}

function pollDelay(signal: AbortSignal): Promise<void> {
  return new Promise(resolve => {
    const timer = setTimeout(done, 1500);
    function done() { clearTimeout(timer); signal.removeEventListener('abort', done); resolve(); }
    signal.addEventListener('abort', done, { once: true });
  });
}

export class DifyEmbeddingProvider {
  constructor(private readonly transport: typeof fetch = fetch) {}

  private headers(settings: EmbeddingWorkflowSettings) {
    return { Authorization: `Bearer ${settings.apiKey}`, 'Content-Type': 'application/json', Accept: 'text/event-stream' };
  }

  async execute(settings: EmbeddingWorkflowSettings, jobId: string, input: EmbeddingRequest, signal: AbortSignal,
    beforeSubmit: () => Promise<void>, recordRun: (id: string) => Promise<void>): Promise<{ output: EmbeddingOutput; workflowRunId: string; model: string | null }> {
    let request: EmbeddingRequest;
    try { request = embeddingRequestSchema.parse(input); }
    catch { throw new EmbeddingProviderError('INVALID_INPUT', 'Frozen source-embedding request is invalid', 'NOT_SUBMITTED'); }
    if (!uuid(jobId)) throw new EmbeddingProviderError('INVALID_INPUT', 'Source-embedding job identity is invalid', 'NOT_SUBMITTED');
    await beforeSubmit();
    let response: Response;
    try {
      response = await this.transport(`${settings.endpoint}/workflows/run`, { method: 'POST', headers: this.headers(settings),
        redirect: 'error', signal, body: JSON.stringify({ inputs: { [RELEASE.inputVariable]: JSON.stringify(request) },
          response_mode: RELEASE.responseMode, user: `job-${jobId}` }) });
    } catch { throw new EmbeddingProviderError('UNKNOWN_OUTCOME', 'Source-embedding submission outcome is unknown', 'UNKNOWN'); }
    if (!response.ok) { await response.body?.cancel(); throw failResponse(response.status); }
    if (!(response.headers.get('content-type') ?? '').toLowerCase().includes('text/event-stream')) {
      await response.body?.cancel();
      throw new EmbeddingProviderError('INCOMPATIBLE_CONTRACT', 'Source-embedding workflow did not honor its streaming response mode', 'UNKNOWN');
    }
    const run = await streamRun(response, settings, signal, recordRun);
    return { output: outputFromRun(run, request), workflowRunId: run.workflowRunId, model: run.model };
  }

  async resume(settings: EmbeddingWorkflowSettings, runId: string, input: EmbeddingRequest, signal: AbortSignal): Promise<{ output: EmbeddingOutput; workflowRunId: string; model: string | null }> {
    if (!uuid(runId)) throw new EmbeddingProviderError('CONFIG', 'Captured source-embedding run ID is invalid');
    let request: EmbeddingRequest;
    try { request = embeddingRequestSchema.parse(input); }
    catch { throw new EmbeddingProviderError('INVALID_INPUT', 'Frozen source-embedding request is invalid'); }
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
    throw new EmbeddingProviderError('TIMEOUT', 'Source-embedding workflow did not finish before the execution deadline', 'UNKNOWN');
  }
}
