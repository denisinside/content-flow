import { createHash } from 'node:crypto';
import { z } from 'zod';
import { telegramOutputSchema, type TelegramOutput, type TelegramWorkflowRelease } from './telegram-contracts.js';

export const TELEGRAM_CONTRACT = 'telegram-v1';
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
// Loop events repeat bounded editorial state. These limits do not enlarge the
// canonical Telegram output accepted below.
const MAX_SSE_RESPONSE_BYTES = 128 * 1024 * 1024;
const MAX_SSE_EVENT_BYTES = 64 * 1024 * 1024;
const MAX_EDITORIAL_REPORT_BYTES = 256 * 1024;
const MAX_INPUT_BYTES = 350000;

type ReleaseArtifact = {
  schemaVersion: 'contextflow-dify-release-v1';
  operation: 'TELEGRAM_GENERATION';
  releaseId: string;
  configDigest: string;
  publishedWorkflowIdEnv: 'DIFY_TELEGRAM_WORKFLOW_ID';
  configDigestEnv: 'DIFY_TELEGRAM_CONFIG_SHA256';
  apiBaseEnv: 'DIFY_API_BASE_URL';
  apiKeyEnv: 'DIFY_TELEGRAM_API_KEY';
  contractVersion: typeof TELEGRAM_CONTRACT;
  promptTemplateVersion: string;
  promptTemplateFile: string;
  inputVariable: 'editorial_json';
  outputVariable: 'telegram_json';
  responseMode: 'streaming';
  provider: 'dify';
  model: { provider: string; name: string; mode: string; completionParams: Record<string, string | number | boolean> };
  workflowDslFile: string;
  workflowDslSha256: string;
};

// Deployment explicitly attests that this published UUID contains the pinned
// configuration digest; a workflow ID alone cannot prove release settings.
const release: ReleaseArtifact = {
  schemaVersion: 'contextflow-dify-release-v1', operation: 'TELEGRAM_GENERATION', releaseId: 'telegram-generation-2026-10-10.1',
  configDigest: '2f6029054537b1039aa047a3f635b0b635f68869c5ea5ba7f14a1c50560aa846', publishedWorkflowIdEnv: 'DIFY_TELEGRAM_WORKFLOW_ID',
  configDigestEnv: 'DIFY_TELEGRAM_CONFIG_SHA256',
  apiBaseEnv: 'DIFY_API_BASE_URL', apiKeyEnv: 'DIFY_TELEGRAM_API_KEY', contractVersion: TELEGRAM_CONTRACT,
  promptTemplateVersion: 'telegram-generation-v1', promptTemplateFile: 'prompt.md', inputVariable: 'editorial_json',
  outputVariable: 'telegram_json', responseMode: 'streaming', provider: 'dify',
  model: { provider: 'langgenius/gemini/google', name: 'gemini-3.8-flash', mode: 'chat', completionParams: {
    max_output_tokens: 8192, thinking_level: 'Low', include_thoughts: false, media_resolution: 'Default',
    grounding: false, url_context: false, code_execution: false, service_tier: 'standard' } },
  workflowDslFile: 'telegram-generation-v1.yml',
  workflowDslSha256: '688fa420088740cc5dbc65a90f37ddb150bab817d65ab213ef4be236d1b97f79',
};

export type TelegramWorkflowSettings = TelegramWorkflowRelease & { apiKey: string };
export class TelegramProviderError extends Error {
  constructor(readonly code: 'CONFIG' | 'AUTH' | 'INVALID_INPUT' | 'INCOMPATIBLE_CONTRACT' | 'QUOTA' | 'RATE_LIMIT' | 'TRANSIENT_TRANSPORT'
    | 'TIMEOUT' | 'UNKNOWN_OUTCOME' | 'PROVIDER_FAILED', message: string, readonly outcome: 'NOT_SUBMITTED' | 'KNOWN_FAILED' | 'UNKNOWN' = 'KNOWN_FAILED') {
    super(message); this.name = 'TelegramProviderError';
  }
}

function uuid(value: string | undefined): value is string { return !!value && z.uuid().safeParse(value).success; }
function safeEndpoint(value: string | undefined, allowLocal: boolean): string | undefined {
  try {
    const url = new URL(value ?? '');
    if (url.protocol !== 'https:' && !(allowLocal && url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) return;
    if (url.username || url.password || url.pathname.replace(/\/+$/u, '') !== '/v1' || url.search || url.hash) return;
    return `${url.origin}/v1`;
  } catch { return; }
}
function configuredRelease(env: Record<string, string | undefined>): TelegramWorkflowRelease {
  const effective = env;
  const endpoint = safeEndpoint(effective[release.apiBaseEnv], effective['NODE_ENV'] !== 'production');
  const workflowId = effective[release.publishedWorkflowIdEnv];
  if (!endpoint || !uuid(workflowId) || effective[release.configDigestEnv] !== release.configDigest) {
    throw new TelegramProviderError('CONFIG', 'The published Telegram-generation workflow release is not configured', 'NOT_SUBMITTED');
  }
  return { endpoint, workflowId, releaseId: release.releaseId, configDigest: release.configDigest,
    contractVersion: release.contractVersion, promptTemplateVersion: release.promptTemplateVersion };
}
export function telegramWorkflowRelease(env: Record<string, string | undefined> = process.env): TelegramWorkflowRelease {
  const config = configuredRelease(env);
  return { endpoint: config.endpoint, workflowId: config.workflowId, releaseId: config.releaseId,
    configDigest: config.configDigest, contractVersion: config.contractVersion, promptTemplateVersion: config.promptTemplateVersion };
}
export function telegramWorkflowSettings(env: Record<string, string | undefined> = process.env): TelegramWorkflowSettings {
  const apiKey = env[release.apiKeyEnv];
  if (!apiKey || apiKey.length > 500) throw new TelegramProviderError('CONFIG', 'The Telegram workflow API key is missing', 'NOT_SUBMITTED');
  return { ...configuredRelease(env), apiKey };
}

function safeJson(text: string): unknown {
  try { return JSON.parse(text); } catch { throw new TelegramProviderError('INCOMPATIBLE_CONTRACT', 'The Telegram workflow returned an invalid contract'); }
}
function responseError(status: number, unknownAfterSubmit = true): TelegramProviderError {
  const outcome = unknownAfterSubmit ? 'UNKNOWN' : 'KNOWN_FAILED';
  if (status === 401 || status === 403) return new TelegramProviderError('AUTH', 'Telegram workflow authentication failed', 'KNOWN_FAILED');
  if (status === 402) return new TelegramProviderError('QUOTA', 'Telegram workflow quota is exhausted', 'KNOWN_FAILED');
  if (status === 429) return new TelegramProviderError('RATE_LIMIT', 'Telegram workflow is rate limited', 'KNOWN_FAILED');
  if (status >= 500) return new TelegramProviderError('TRANSIENT_TRANSPORT', 'Telegram workflow service is temporarily unavailable', outcome);
  return new TelegramProviderError('PROVIDER_FAILED', 'Telegram workflow could not complete the request', 'KNOWN_FAILED');
}
async function boundedJson(response: Response): Promise<unknown> {
  const reader = response.body?.getReader();
  if (!reader) throw new TelegramProviderError('INCOMPATIBLE_CONTRACT', 'Telegram workflow returned an empty response');
  const chunks: Uint8Array[] = []; let size = 0;
  try {
    while (true) {
      const next = await reader.read(); if (next.done) break;
      size += next.value.byteLength;
      if (size > MAX_RESPONSE_BYTES) { await reader.cancel(); throw new TelegramProviderError('INCOMPATIBLE_CONTRACT', 'Telegram workflow response exceeded its size limit'); }
      chunks.push(next.value);
    }
    return safeJson(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
  } catch (error) {
    if (error instanceof TelegramProviderError) throw error;
    throw new TelegramProviderError('INCOMPATIBLE_CONTRACT', 'Telegram workflow returned an invalid response');
  } finally { reader.releaseLock(); }
}
class CallbackError extends Error { constructor(readonly originalError: unknown) { super('Provider callback failed'); } }

type DifyRun = { workflow_run_id: string; data: { workflow_id: string; status: string; outputs?: Record<string, unknown>; error?: string | null; model?: string | null } };
function completedRun(value: unknown, settings: TelegramWorkflowSettings): DifyRun {
  const parsed = z.object({ workflow_run_id: z.uuid(), data: z.object({ workflow_id: z.uuid(), status: z.string(),
    outputs: z.record(z.string(), z.unknown()).optional(), error: z.string().nullable().optional(), model: z.string().nullable().optional() }).passthrough() }).passthrough().safeParse(value);
  if (!parsed.success || parsed.data.data.workflow_id !== settings.workflowId) throw new TelegramProviderError('INCOMPATIBLE_CONTRACT', 'Telegram workflow release identity did not match the frozen release');
  return { workflow_run_id: parsed.data.workflow_run_id, data: { workflow_id: parsed.data.data.workflow_id,
    status: parsed.data.data.status, ...(parsed.data.data.outputs !== undefined ? { outputs: parsed.data.data.outputs } : {}),
    ...(parsed.data.data.error !== undefined ? { error: parsed.data.data.error } : {}),
    ...(parsed.data.data.model !== undefined ? { model: parsed.data.data.model } : {}) } };
}
function completedRunDetail(value: unknown, settings: TelegramWorkflowSettings): DifyRun {
  const parsed = z.object({ id: z.uuid(), workflow_id: z.uuid(), status: z.string(), outputs: z.record(z.string(), z.unknown()).optional(),
    error: z.string().nullable().optional(), model: z.string().nullable().optional() }).passthrough().safeParse(value);
  if (!parsed.success || parsed.data.workflow_id !== settings.workflowId) throw new TelegramProviderError('INCOMPATIBLE_CONTRACT', 'Telegram workflow release identity did not match the frozen release');
  return { workflow_run_id: parsed.data.id, data: { workflow_id: parsed.data.workflow_id, status: parsed.data.status,
    ...(parsed.data.outputs !== undefined ? { outputs: parsed.data.outputs } : {}), ...(parsed.data.error !== undefined ? { error: parsed.data.error } : {}),
    ...(parsed.data.model !== undefined ? { model: parsed.data.model } : {}) } };
}

async function streamRun(response: Response, settings: TelegramWorkflowSettings, signal: AbortSignal, recordRun: (id: string) => Promise<void>): Promise<DifyRun> {
  if (!response.body) throw new TelegramProviderError('INCOMPATIBLE_CONTRACT', 'Telegram workflow returned an empty stream');
  const reader = response.body.getReader(), decoder = new TextDecoder('utf-8', { fatal: true });
  let buffer = '', bytes = 0, run: DifyRun | undefined, capturedRunId: string | undefined;
  const processEvent = async (event: string) => {
    if (!event.trim()) return;
    if (Buffer.byteLength(event) > MAX_SSE_EVENT_BYTES) throw new TelegramProviderError('INCOMPATIBLE_CONTRACT', 'Telegram workflow stream event exceeded its limit');
    const data = event.split(/\r?\n/u).filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
    if (!data || data === '[DONE]') return;
    const value = safeJson(data);
    if (!value || typeof value !== 'object' || Array.isArray(value)) return;
    const payload = value as Record<string, unknown>;
    const runId = typeof payload['workflow_run_id'] === 'string' ? payload['workflow_run_id'] : capturedRunId;
    if (typeof runId === 'string' && uuid(runId)) {
      if (capturedRunId && capturedRunId !== runId) throw new TelegramProviderError('INCOMPATIBLE_CONTRACT', 'Telegram workflow changed its run identity');
      if (!capturedRunId) {
        capturedRunId = runId;
        try { await recordRun(runId); } catch (error) { throw new CallbackError(error); }
      }
    }
    if (payload['event'] === 'workflow_started' && typeof runId === 'string') return;
    if (payload['event'] === 'workflow_finished') {
      const workflow = payload['data'];
      if (!workflow || typeof workflow !== 'object' || Array.isArray(workflow)) throw new TelegramProviderError('INCOMPATIBLE_CONTRACT', 'Telegram workflow completion event was invalid');
      const detail = workflow as Record<string, unknown>;
      run = completedRun({ workflow_run_id: runId, data: { workflow_id: detail['workflow_id'], status: detail['status'], outputs: detail['outputs'], error: detail['error'], model: detail['model'] } }, settings);
    }
    if (payload['event'] === 'error') throw new TelegramProviderError('PROVIDER_FAILED', 'Telegram workflow reported a failure', 'KNOWN_FAILED');
  };
  try {
    while (true) {
      if (signal.aborted) throw new TelegramProviderError('TIMEOUT', 'Telegram workflow exceeded its execution deadline', 'UNKNOWN');
      const next = await reader.read(); if (next.done) break;
      bytes += next.value.byteLength;
      if (bytes > MAX_SSE_RESPONSE_BYTES) { await reader.cancel(); throw new TelegramProviderError('INCOMPATIBLE_CONTRACT', 'Telegram workflow stream exceeded its size limit'); }
      buffer += decoder.decode(next.value, { stream: true });
      let boundary: RegExpExecArray | null;
      while ((boundary = /\r?\n\r?\n/u.exec(buffer)) !== null) {
        const event = buffer.slice(0, boundary.index); buffer = buffer.slice(boundary.index + boundary[0].length); await processEvent(event);
      }
      if (Buffer.byteLength(buffer) > MAX_SSE_EVENT_BYTES) throw new TelegramProviderError('INCOMPATIBLE_CONTRACT', 'Telegram workflow stream event exceeded its limit');
    }
    buffer += decoder.decode();
    if (buffer.trim()) await processEvent(buffer);
  } catch (error) {
    if (error instanceof CallbackError) throw error.originalError;
    if (error instanceof TelegramProviderError) throw error;
    if (signal.aborted || error instanceof TypeError) throw new TelegramProviderError('UNKNOWN_OUTCOME', 'Telegram workflow outcome is unknown; the captured run will be reconciled', 'UNKNOWN');
    throw new TelegramProviderError('INCOMPATIBLE_CONTRACT', 'Telegram workflow returned an invalid stream');
  } finally { reader.releaseLock(); }
  if (!run) throw new TelegramProviderError('UNKNOWN_OUTCOME', 'Telegram workflow ended before a completion result was captured', 'UNKNOWN');
  return run;
}

const editorialReportSchema = z.object({
  schemaVersion: z.literal('telegram-editorial-report-v1'),
  status: z.enum(['ready', 'needs_human', 'insufficient_evidence']),
  contentHash: z.string().regex(/^[a-f0-9]{64}$/u).nullable(),
}).passthrough();
function extractionFromRun(run: DifyRun): TelegramOutput {
  if (run.data.status !== 'succeeded') throw new TelegramProviderError('PROVIDER_FAILED', 'Telegram workflow did not succeed', 'KNOWN_FAILED');
  const report = run.data.outputs?.['telegram_report'];
  if (typeof report !== 'string' || Buffer.byteLength(report) > MAX_EDITORIAL_REPORT_BYTES) {
    throw new TelegramProviderError('INCOMPATIBLE_CONTRACT', 'Telegram workflow editorial report did not match its contract');
  }
  const parsedReport = editorialReportSchema.safeParse(safeJson(report));
  if (!parsedReport.success) throw new TelegramProviderError('INCOMPATIBLE_CONTRACT', 'Telegram workflow editorial report did not match its contract');
  if (parsedReport.data.status !== 'ready') {
    throw new TelegramProviderError('PROVIDER_FAILED', 'Telegram workflow requires editorial intervention before a candidate can be accepted', 'KNOWN_FAILED');
  }
  if (!parsedReport.data.contentHash) throw new TelegramProviderError('INCOMPATIBLE_CONTRACT', 'Telegram workflow review hash did not match its output');
  const raw = run.data.outputs?.[release.outputVariable];
  const output = typeof raw === 'string' ? safeJson(raw) : raw;
  const parsed = telegramOutputSchema.safeParse(output);
  if (!parsed.success) throw new TelegramProviderError('INCOMPATIBLE_CONTRACT', 'Telegram workflow output did not match telegram-v1');
  if (parsedReport.data.contentHash !== sha256(JSON.stringify(parsed.data))) {
    throw new TelegramProviderError('INCOMPATIBLE_CONTRACT', 'Telegram workflow review hash did not match its output');
  }
  return parsed.data;
}

export type TelegramProviderInput = { schemaVersion: 'telegram-context-v1'; inputMode: 'DIRECT' | 'ARTICLE_DERIVED';
  contentMode: 'FACTUAL' | 'CREATIVE'; includeLink: boolean;
  brief: Record<string, unknown>; style: { brandbook: string; tone: string; settings: unknown };
  claims: Array<{ claimRevisionId: string; wording: string; evidence: Array<{ evidenceId: string; quote: string; snapshotId: string }> }>;
  context: Array<{ snapshotId: string; purpose: string; sha256: string; text: string }>;
  article: null | { versionId: string; sha256: string; text: string } };
export class DifyTelegramProvider {
  constructor(private readonly transport: typeof fetch = fetch) {}
  private headers(settings: TelegramWorkflowSettings) { return { Authorization: `Bearer ${settings.apiKey}`, 'Content-Type': 'application/json', Accept: 'text/event-stream' }; }
  async execute(settings: TelegramWorkflowSettings, jobId: string, input: TelegramProviderInput, signal: AbortSignal,
    beforeSubmit: () => Promise<void>, recordRun: (id: string) => Promise<void>): Promise<{ output: TelegramOutput; workflowRunId: string; model: string | null }> {
    const inputBytes = Buffer.byteLength(JSON.stringify(input));
    if (inputBytes > MAX_INPUT_BYTES || !input.brief || input.schemaVersion !== 'telegram-context-v1'
      || input.inputMode === 'DIRECT' && input.article !== null || input.inputMode === 'ARTICLE_DERIVED' && !input.article
      || input.contentMode === 'FACTUAL' && input.claims.length === 0)
      throw new TelegramProviderError('INVALID_INPUT', 'Frozen Telegram context is empty, inconsistent or exceeds its limit', 'NOT_SUBMITTED');
    const origin = settings.endpoint;
    // Dify Cloud's version-specific execution route is plan-gated. Run the
    // currently published app, then accept output only if its returned version
    // matches the workflow ID frozen into this job's release manifest.
    const url = `${origin}/workflows/run`;
    await beforeSubmit();
    let response: Response;
    try {
      response = await this.transport(url, { method: 'POST', headers: this.headers(settings), redirect: 'error', signal,
        body: JSON.stringify({ inputs: { [release.inputVariable]: JSON.stringify(input) }, response_mode: release.responseMode, user: `job-${jobId}` }) });
    } catch { throw new TelegramProviderError('UNKNOWN_OUTCOME', 'Telegram workflow submission outcome is unknown', 'UNKNOWN'); }
    if (!response.ok) { await response.body?.cancel(); throw responseError(response.status); }
    const contentType = response.headers.get('content-type') ?? '';
    if (!contentType.toLowerCase().includes('text/event-stream')) {
      await response.body?.cancel();
      throw new TelegramProviderError('INCOMPATIBLE_CONTRACT', 'Telegram workflow did not honor the pinned streaming response mode', 'UNKNOWN');
    }
    const run = await streamRun(response, settings, signal, recordRun);
    return { output: extractionFromRun(run), workflowRunId: run.workflow_run_id, model: run.data.model ?? null };
  }
  async resume(settings: TelegramWorkflowSettings, runId: string, signal: AbortSignal): Promise<{ output: TelegramOutput; workflowRunId: string; model: string | null }> {
    if (!uuid(runId)) throw new TelegramProviderError('CONFIG', 'Captured Telegram workflow run ID is invalid');
    while (!signal.aborted) {
      let response: Response;
      try { response = await this.transport(`${settings.endpoint}/workflows/run/${encodeURIComponent(runId)}`, {
        headers: { Authorization: `Bearer ${settings.apiKey}`, Accept: 'application/json' }, redirect: 'error', signal }); }
      catch {
        if (signal.aborted) break;
        await pollDelay(signal);
        continue;
      }
      if (!response.ok) { await response.body?.cancel(); throw responseError(response.status); }
      const run = completedRunDetail(await boundedJson(response), settings);
      if (run.workflow_run_id !== runId) throw new TelegramProviderError('INCOMPATIBLE_CONTRACT', 'Telegram workflow returned a different run identity');
      if (['running', 'paused'].includes(run.data.status)) { await pollDelay(signal); continue; }
      return { output: extractionFromRun(run), workflowRunId: run.workflow_run_id, model: run.data.model ?? null };
    }
    throw new TelegramProviderError('TIMEOUT', 'Telegram workflow did not finish before the execution deadline', 'UNKNOWN');
  }
}

function pollDelay(signal: AbortSignal): Promise<void> {
  return new Promise(resolve => {
    const timer = setTimeout(done, 1500);
    function done() { clearTimeout(timer); signal.removeEventListener('abort', done); resolve(); }
    signal.addEventListener('abort', done, { once: true });
  });
}

export function sha256(value: string): string { return createHash('sha256').update(value, 'utf8').digest('hex'); }
