import { z } from 'zod';
import { relevanceInputSchema, validateRelevanceOutput, type RelevanceInput } from './relevance-contracts.js';

const RELEASES = [
  { releaseId: 'source-relevance-2026-10-22.1',
    configDigest: '239be78994f5b3d2b1e5cfdf119a4b91d6de943d12aebe0c52594fcc55457c9b' },
  { releaseId: 'source-relevance-2026-10-24.1',
    configDigest: '40153b6847d3f6a6da168afd7b5ec930492c35458582a8aec32aba3e431582c0' },
] as const;
type SourceRelevanceRelease = typeof RELEASES[number];
const RELEASE = {
  workflowIdEnv: 'DIFY_SOURCE_RELEVANCE_PUBLISHED_WORKFLOW_ID',
  configDigestEnv: 'DIFY_SOURCE_RELEVANCE_CONFIG_SHA256',
  apiKeyEnv: 'DIFY_SOURCE_RELEVANCE_API_KEY',
  apiBaseEnv: 'DIFY_API_BASE_URL',
  inputVariable: 'source_relevance_request_json',
  outputVariable: 'source_relevance_json',
} as const;

const MAX_GET_BYTES = 2 * 1024 * 1024;
const MAX_SSE_EVENT_BYTES = 1024 * 1024;
const MAX_SSE_BYTES = 4 * 1024 * 1024;
const MAX_OUTPUT_BYTES = 40_000;

export type SourceRelevanceWorkflowSettings = Readonly<{
  endpoint: string;
  workflowId: string;
  releaseId: SourceRelevanceRelease['releaseId'];
  configDigest: string;
  apiKey: string;
}>;

export class SourceRelevanceProviderError extends Error {
  constructor(readonly code: 'CONFIG' | 'AUTH' | 'INVALID_INPUT' | 'INCOMPATIBLE_CONTRACT' | 'QUOTA' | 'RATE_LIMIT'
    | 'TRANSIENT_TRANSPORT' | 'TIMEOUT' | 'UNKNOWN_OUTCOME' | 'PROVIDER_FAILED',
  message: string, readonly outcome: 'NOT_SUBMITTED' | 'KNOWN_FAILED' | 'UNKNOWN' = 'KNOWN_FAILED') {
    super(message);
    this.name = 'SourceRelevanceProviderError';
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

function configuredRelease(env: Record<string, string | undefined>): Omit<SourceRelevanceWorkflowSettings, 'apiKey'> {
  const endpoint = safeEndpoint(env[RELEASE.apiBaseEnv], env['NODE_ENV'] !== 'production');
  const workflowId = env[RELEASE.workflowIdEnv];
  const digest = env[RELEASE.configDigestEnv];
  const release = RELEASES.find(candidate => candidate.configDigest === digest);
  if (!endpoint || !uuid(workflowId) || !release) {
    throw new SourceRelevanceProviderError('CONFIG', 'The published source-relevance workflow release is not configured', 'NOT_SUBMITTED');
  }
  return { endpoint, workflowId, ...release };
}

export function sourceRelevanceWorkflowRelease(env: Record<string, string | undefined> = process.env): Omit<SourceRelevanceWorkflowSettings, 'apiKey'> {
  return configuredRelease(env);
}

export function sourceRelevanceWorkflowSettings(env: Record<string, string | undefined> = process.env): SourceRelevanceWorkflowSettings {
  const apiKey = env[RELEASE.apiKeyEnv];
  if (!apiKey || apiKey.length > 500) throw new SourceRelevanceProviderError('CONFIG', 'The source-relevance workflow API key is missing', 'NOT_SUBMITTED');
  return { ...configuredRelease(env), apiKey };
}

function failResponse(status: number): SourceRelevanceProviderError {
  if (status === 401 || status === 403) return new SourceRelevanceProviderError('AUTH', 'Source-relevance workflow authentication failed');
  if (status === 402) return new SourceRelevanceProviderError('QUOTA', 'Source-relevance workflow quota is exhausted');
  if (status === 429) return new SourceRelevanceProviderError('RATE_LIMIT', 'Source-relevance workflow is rate limited');
  if (status >= 500) return new SourceRelevanceProviderError('TRANSIENT_TRANSPORT', 'Source-relevance workflow service is temporarily unavailable', 'UNKNOWN');
  return new SourceRelevanceProviderError('PROVIDER_FAILED', 'Source-relevance workflow could not complete the request');
}

function safeJson(text: string): unknown {
  try { return JSON.parse(text); } catch {
    throw new SourceRelevanceProviderError('INCOMPATIBLE_CONTRACT', 'Source-relevance workflow returned invalid JSON');
  }
}

async function boundedJson(response: Response): Promise<unknown> {
  const reader = response.body?.getReader();
  if (!reader) throw new SourceRelevanceProviderError('INCOMPATIBLE_CONTRACT', 'Source-relevance workflow returned an empty response');
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > MAX_GET_BYTES) {
        await reader.cancel();
        throw new SourceRelevanceProviderError('INCOMPATIBLE_CONTRACT', 'Source-relevance workflow response exceeded its size limit');
      }
      chunks.push(next.value);
    }
    return safeJson(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
  } catch (error) {
    if (error instanceof SourceRelevanceProviderError) throw error;
    throw new SourceRelevanceProviderError('INCOMPATIBLE_CONTRACT', 'Source-relevance workflow returned an invalid response');
  } finally { reader.releaseLock(); }
}

type Run = { workflowRunId: string; workflowId: string; status: string; outputs?: Record<string, unknown>; model: string | null };

function runStarted(value: unknown, settings: SourceRelevanceWorkflowSettings): Run {
  const parsed = z.object({ workflow_run_id: z.uuid(), data: z.object({
    workflow_id: z.uuid(), status: z.string(), outputs: z.record(z.string(), z.unknown()).optional(), model: z.string().nullable().optional(),
  }).passthrough() }).passthrough().safeParse(value);
  if (!parsed.success || parsed.data.data.workflow_id !== settings.workflowId) {
    throw new SourceRelevanceProviderError('INCOMPATIBLE_CONTRACT', 'Source-relevance workflow run identity did not match the frozen release');
  }
  return { workflowRunId: parsed.data.workflow_run_id, workflowId: parsed.data.data.workflow_id,
    status: parsed.data.data.status, ...(parsed.data.data.outputs !== undefined ? { outputs: parsed.data.data.outputs } : {}),
    model: parsed.data.data.model ?? null };
}

function runDetail(value: unknown, settings: SourceRelevanceWorkflowSettings, expectedRunId: string): Run {
  const parsed = z.object({ id: z.uuid(), workflow_id: z.uuid(), status: z.string(),
    outputs: z.record(z.string(), z.unknown()).optional(), model: z.string().nullable().optional() }).passthrough().safeParse(value);
  if (!parsed.success || parsed.data.workflow_id !== settings.workflowId || parsed.data.id !== expectedRunId) {
    throw new SourceRelevanceProviderError('INCOMPATIBLE_CONTRACT', 'Source-relevance workflow returned a different run identity');
  }
  return { workflowRunId: parsed.data.id, workflowId: parsed.data.workflow_id, status: parsed.data.status,
    ...(parsed.data.outputs !== undefined ? { outputs: parsed.data.outputs } : {}), model: parsed.data.model ?? null };
}

class CallbackError extends Error { constructor(readonly original: unknown) { super('Provider callback failed'); } }

async function streamRun(response: Response, settings: SourceRelevanceWorkflowSettings, signal: AbortSignal,
  recordRun: (id: string) => Promise<void>): Promise<Run> {
  if (!response.body) throw new SourceRelevanceProviderError('INCOMPATIBLE_CONTRACT', 'Source-relevance workflow returned an empty stream');
  const reader = response.body.getReader(), decoder = new TextDecoder('utf-8', { fatal: true });
  let buffer = '', totalBytes = 0, capturedId: string | undefined, finalRun: Run | undefined;
  const processEvent = async (eventText: string) => {
    if (!eventText.trim()) return;
    if (Buffer.byteLength(eventText, 'utf8') > MAX_SSE_EVENT_BYTES) throw new SourceRelevanceProviderError('INCOMPATIBLE_CONTRACT', 'Source-relevance stream event exceeded its size limit');
    const data = eventText.split(/\r?\n/u).filter(line => line.startsWith('data:'))
      .map(line => line.slice(5).trimStart()).join('\n');
    if (!data || data === '[DONE]') return;
    const payload = safeJson(data);
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return;
    const row = payload as Record<string, unknown>, runId = row['workflow_run_id'];
    if (row['event'] === 'workflow_started') {
      const startedId = typeof runId === 'string' && uuid(runId) ? runId : undefined, rawData = row['data'];
      const workflowId = rawData && typeof rawData === 'object' && !Array.isArray(rawData)
        ? (rawData as Record<string, unknown>)['workflow_id'] : undefined;
      if (!startedId || workflowId !== settings.workflowId || (capturedId && capturedId !== startedId)) {
        throw new SourceRelevanceProviderError('INCOMPATIBLE_CONTRACT', 'Source-relevance workflow release identity did not match');
      }
      if (!capturedId) { capturedId = startedId; try { await recordRun(startedId); } catch (error) { throw new CallbackError(error); } }
      return;
    }
    if (typeof runId === 'string' && uuid(runId) && capturedId && capturedId !== runId) {
      throw new SourceRelevanceProviderError('INCOMPATIBLE_CONTRACT', 'Source-relevance workflow changed its run identity');
    }
    if (row['event'] === 'workflow_finished') {
      const rawData = row['data'];
      if (!rawData || typeof rawData !== 'object' || Array.isArray(rawData) || !capturedId) throw new SourceRelevanceProviderError('INCOMPATIBLE_CONTRACT', 'Source-relevance completion event was invalid');
      const details = rawData as Record<string, unknown>;
      finalRun = runStarted({ workflow_run_id: capturedId, data: { workflow_id: details['workflow_id'], status: details['status'],
        outputs: details['outputs'], model: details['model'] } }, settings);
    }
    if (row['event'] === 'error') throw new SourceRelevanceProviderError('PROVIDER_FAILED', 'Source-relevance workflow reported a failure');
  };
  try {
    while (true) {
      if (signal.aborted) throw new SourceRelevanceProviderError('TIMEOUT', 'Source-relevance workflow exceeded its execution deadline', 'UNKNOWN');
      const next = await reader.read(); if (next.done) break;
      totalBytes += next.value.byteLength;
      if (totalBytes > MAX_SSE_BYTES) { await reader.cancel(); throw new SourceRelevanceProviderError('INCOMPATIBLE_CONTRACT', 'Source-relevance workflow stream exceeded its size limit'); }
      buffer += decoder.decode(next.value, { stream: true });
      let boundary: RegExpExecArray | null;
      while ((boundary = /\r?\n\r?\n/u.exec(buffer)) !== null) {
        const eventText = buffer.slice(0, boundary.index); buffer = buffer.slice(boundary.index + boundary[0].length); await processEvent(eventText);
      }
      if (Buffer.byteLength(buffer, 'utf8') > MAX_SSE_EVENT_BYTES) throw new SourceRelevanceProviderError('INCOMPATIBLE_CONTRACT', 'Source-relevance stream event exceeded its size limit');
    }
    buffer += decoder.decode(); if (buffer.trim()) await processEvent(buffer);
  } catch (error) {
    try { await reader.cancel(); } catch { /* response may already be closed */ }
    if (error instanceof CallbackError) throw error.original;
    if (error instanceof SourceRelevanceProviderError) throw error;
    if (signal.aborted || error instanceof TypeError) throw new SourceRelevanceProviderError('UNKNOWN_OUTCOME', 'Source-relevance workflow outcome is unknown; the captured run must be reconciled', 'UNKNOWN');
    throw new SourceRelevanceProviderError('INCOMPATIBLE_CONTRACT', 'Source-relevance workflow returned an invalid stream');
  } finally { reader.releaseLock(); }
  if (!finalRun) throw new SourceRelevanceProviderError('UNKNOWN_OUTCOME', 'Source-relevance workflow ended before completion; reconcile its captured run', 'UNKNOWN');
  return finalRun;
}

function outputFromRun(run: Run, request: RelevanceInput) {
  if (run.status !== 'succeeded') throw new SourceRelevanceProviderError('PROVIDER_FAILED', 'Source-relevance workflow did not succeed');
  const raw = run.outputs?.[RELEASE.outputVariable];
  if (typeof raw !== 'string' || Buffer.byteLength(raw, 'utf8') > MAX_OUTPUT_BYTES) {
    throw new SourceRelevanceProviderError('INCOMPATIBLE_CONTRACT', 'Source-relevance output is missing or exceeds its size limit');
  }
  try { return validateRelevanceOutput(safeJson(raw), request); }
  catch { throw new SourceRelevanceProviderError('INCOMPATIBLE_CONTRACT', 'Source-relevance output did not match the frozen request or candidates'); }
}

function pollDelay(signal: AbortSignal): Promise<void> {
  return new Promise(resolve => { const timer = setTimeout(done, 1500);
    function done() { clearTimeout(timer); signal.removeEventListener('abort', done); resolve(); }
    signal.addEventListener('abort', done, { once: true }); });
}

export class DifySourceRelevanceProvider {
  constructor(private readonly transport: typeof fetch = fetch) {}
  private headers(settings: SourceRelevanceWorkflowSettings) {
    return { Authorization: `Bearer ${settings.apiKey}`, 'Content-Type': 'application/json', Accept: 'text/event-stream' };
  }

  async execute(settings: SourceRelevanceWorkflowSettings, jobId: string, input: RelevanceInput, signal: AbortSignal,
    beforeSubmit: () => Promise<void>, recordRun: (id: string) => Promise<void>) {
    let request: RelevanceInput;
    try { request = relevanceInputSchema.parse(input); }
    catch { throw new SourceRelevanceProviderError('INVALID_INPUT', 'Frozen source-relevance request is invalid', 'NOT_SUBMITTED'); }
    if (!uuid(jobId)) throw new SourceRelevanceProviderError('INVALID_INPUT', 'Source-relevance job identity is invalid', 'NOT_SUBMITTED');
    await beforeSubmit();
    let response: Response;
    try { response = await this.transport(`${settings.endpoint}/workflows/run`, { method: 'POST', headers: this.headers(settings),
      redirect: 'error', signal, body: JSON.stringify({ inputs: { [RELEASE.inputVariable]: JSON.stringify(request) }, response_mode: 'streaming', user: `job-${jobId}` }) }); }
    catch { throw new SourceRelevanceProviderError('UNKNOWN_OUTCOME', 'Source-relevance submission outcome is unknown', 'UNKNOWN'); }
    if (!response.ok) { await response.body?.cancel(); throw failResponse(response.status); }
    if (!(response.headers.get('content-type') ?? '').toLowerCase().includes('text/event-stream')) {
      await response.body?.cancel(); throw new SourceRelevanceProviderError('INCOMPATIBLE_CONTRACT', 'Source-relevance workflow did not honor its streaming response mode', 'UNKNOWN');
    }
    const run = await streamRun(response, settings, signal, recordRun);
    return { output: outputFromRun(run, request), workflowRunId: run.workflowRunId, model: run.model };
  }

  async resume(settings: SourceRelevanceWorkflowSettings, runId: string, input: RelevanceInput, signal: AbortSignal) {
    if (!uuid(runId)) throw new SourceRelevanceProviderError('CONFIG', 'Captured source-relevance run ID is invalid');
    let request: RelevanceInput;
    try { request = relevanceInputSchema.parse(input); }
    catch { throw new SourceRelevanceProviderError('INVALID_INPUT', 'Frozen source-relevance request is invalid'); }
    while (!signal.aborted) {
      let response: Response;
      try { response = await this.transport(`${settings.endpoint}/workflows/run/${encodeURIComponent(runId)}`, {
        headers: { Authorization: `Bearer ${settings.apiKey}`, Accept: 'application/json' }, redirect: 'error', signal }); }
      catch { if (signal.aborted) break; await pollDelay(signal); continue; }
      if (!response.ok) { await response.body?.cancel(); throw failResponse(response.status); }
      const run = runDetail(await boundedJson(response), settings, runId);
      if (['running', 'paused'].includes(run.status)) { await pollDelay(signal); continue; }
      return { output: outputFromRun(run, request), workflowRunId: run.workflowRunId, model: run.model };
    }
    throw new SourceRelevanceProviderError('TIMEOUT', 'Source-relevance workflow did not finish before the execution deadline', 'UNKNOWN');
  }
}
