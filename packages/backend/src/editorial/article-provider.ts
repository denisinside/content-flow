import { createHash } from 'node:crypto';
import { z } from 'zod';
import { articleOutputSchema, type ArticleOutput, type ArticleWorkflowRelease } from './article-contracts.js';

export const ARTICLE_CONTRACT = 'article-v1';
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
// Loop events repeat bounded editorial state; 90 passes can include multiple
// <=350 KiB state snapshots. These limits do not enlarge canonical article output.
const MAX_SSE_RESPONSE_BYTES = 128 * 1024 * 1024;
const MAX_SSE_EVENT_BYTES = 64 * 1024 * 1024;
const MAX_EDITORIAL_REPORT_BYTES = 256 * 1024;
const MAX_INPUT_BYTES = 350000;

type ReleaseArtifact = {
  schemaVersion: 'contextflow-dify-release-v1';
  operation: 'ARTICLE_GENERATION';
  releaseId: string;
  configDigest: string;
  publishedWorkflowIdEnv: 'DIFY_ARTICLE_GENERATION_PUBLISHED_WORKFLOW_ID';
  configDigestEnv: 'DIFY_ARTICLE_GENERATION_CONFIG_SHA256';
  apiBaseEnv: 'DIFY_API_BASE_URL';
  apiKeyEnv: 'DIFY_ARTICLE_GENERATION_API_KEY';
  contractVersion: typeof ARTICLE_CONTRACT;
  promptTemplateVersion: string;
  promptTemplateFile: string;
  inputVariable: 'editorial_json';
  outputVariable: 'article_json';
  responseMode: 'streaming';
  provider: 'dify';
  model: { provider: string; name: string; mode: string; completionParams: Record<string, string | number | boolean> };
  workflowDslFile: string;
  workflowDslSha256: string;
};

// Deployment explicitly attests that this published UUID contains the pinned
// configuration digest; a workflow ID alone cannot prove release settings.
const release: ReleaseArtifact = {
  schemaVersion: 'contextflow-dify-release-v1', operation: 'ARTICLE_GENERATION', releaseId: 'article-generation-2026-10-10.1',
  configDigest: 'ffb4847aa44ed06600e209ce7cee171fafd965d062ebe3003ec4c74c7d2d36ab', publishedWorkflowIdEnv: 'DIFY_ARTICLE_GENERATION_PUBLISHED_WORKFLOW_ID',
  configDigestEnv: 'DIFY_ARTICLE_GENERATION_CONFIG_SHA256',
  apiBaseEnv: 'DIFY_API_BASE_URL', apiKeyEnv: 'DIFY_ARTICLE_GENERATION_API_KEY', contractVersion: ARTICLE_CONTRACT,
  promptTemplateVersion: 'article-generation-editorial-prompt-v3', promptTemplateFile: 'prompt.md', inputVariable: 'editorial_json',
  outputVariable: 'article_json', responseMode: 'streaming', provider: 'dify',
  model: { provider: 'langgenius/gemini/google', name: 'gemini-3.8-flash', mode: 'chat', completionParams: {
    max_output_tokens: 8192, thinking_level: 'Low', include_thoughts: false, media_resolution: 'Default',
    grounding: false, url_context: false, code_execution: false, service_tier: 'standard' } },
  workflowDslFile: 'article-generation-v1.yml',
  workflowDslSha256: '334350bc8cf36a9b56b2f641015bd2da35aa5bf94170e1d82a1672a23046b87a',
};

export type ArticleWorkflowSettings = ArticleWorkflowRelease & { apiKey: string };
export class ArticleProviderError extends Error {
  constructor(readonly code: 'CONFIG' | 'AUTH' | 'INVALID_INPUT' | 'INCOMPATIBLE_CONTRACT' | 'QUOTA' | 'RATE_LIMIT' | 'TRANSIENT_TRANSPORT'
    | 'TIMEOUT' | 'UNKNOWN_OUTCOME' | 'PROVIDER_FAILED', message: string, readonly outcome: 'NOT_SUBMITTED' | 'KNOWN_FAILED' | 'UNKNOWN' = 'KNOWN_FAILED') {
    super(message); this.name = 'ArticleProviderError';
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
function configuredRelease(env: Record<string, string | undefined>): ArticleWorkflowRelease {
  const effective = env;
  const endpoint = safeEndpoint(effective[release.apiBaseEnv], effective['NODE_ENV'] !== 'production');
  const workflowId = effective[release.publishedWorkflowIdEnv];
  if (!endpoint || !uuid(workflowId) || effective[release.configDigestEnv] !== release.configDigest) {
    throw new ArticleProviderError('CONFIG', 'The published article-generation workflow release is not configured', 'NOT_SUBMITTED');
  }
  return { endpoint, workflowId, releaseId: release.releaseId, configDigest: release.configDigest,
    contractVersion: release.contractVersion, promptTemplateVersion: release.promptTemplateVersion };
}
export function articleWorkflowRelease(env: Record<string, string | undefined> = process.env): ArticleWorkflowRelease {
  const config = configuredRelease(env);
  return { endpoint: config.endpoint, workflowId: config.workflowId, releaseId: config.releaseId,
    configDigest: config.configDigest, contractVersion: config.contractVersion, promptTemplateVersion: config.promptTemplateVersion };
}
export function articleWorkflowSettings(env: Record<string, string | undefined> = process.env): ArticleWorkflowSettings {
  const apiKey = env[release.apiKeyEnv];
  if (!apiKey || apiKey.length > 500) throw new ArticleProviderError('CONFIG', 'The article workflow API key is missing', 'NOT_SUBMITTED');
  return { ...configuredRelease(env), apiKey };
}

function safeJson(text: string): unknown {
  try { return JSON.parse(text); } catch { throw new ArticleProviderError('INCOMPATIBLE_CONTRACT', 'The article workflow returned an invalid contract'); }
}
function responseError(status: number, unknownAfterSubmit = true): ArticleProviderError {
  const outcome = unknownAfterSubmit ? 'UNKNOWN' : 'KNOWN_FAILED';
  if (status === 401 || status === 403) return new ArticleProviderError('AUTH', 'Article workflow authentication failed', 'KNOWN_FAILED');
  if (status === 402) return new ArticleProviderError('QUOTA', 'Article workflow quota is exhausted', 'KNOWN_FAILED');
  if (status === 429) return new ArticleProviderError('RATE_LIMIT', 'Article workflow is rate limited', 'KNOWN_FAILED');
  if (status >= 500) return new ArticleProviderError('TRANSIENT_TRANSPORT', 'Article workflow service is temporarily unavailable', outcome);
  return new ArticleProviderError('PROVIDER_FAILED', 'Article workflow could not complete the request', 'KNOWN_FAILED');
}
async function boundedJson(response: Response): Promise<unknown> {
  const reader = response.body?.getReader();
  if (!reader) throw new ArticleProviderError('INCOMPATIBLE_CONTRACT', 'Article workflow returned an empty response');
  const chunks: Uint8Array[] = []; let size = 0;
  try {
    while (true) {
      const next = await reader.read(); if (next.done) break;
      size += next.value.byteLength;
      if (size > MAX_RESPONSE_BYTES) { await reader.cancel(); throw new ArticleProviderError('INCOMPATIBLE_CONTRACT', 'Article workflow response exceeded its size limit'); }
      chunks.push(next.value);
    }
    return safeJson(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
  } catch (error) {
    if (error instanceof ArticleProviderError) throw error;
    throw new ArticleProviderError('INCOMPATIBLE_CONTRACT', 'Article workflow returned an invalid response');
  } finally { reader.releaseLock(); }
}
class CallbackError extends Error { constructor(readonly originalError: unknown) { super('Provider callback failed'); } }

type DifyRun = { workflow_run_id: string; data: { workflow_id: string; status: string; outputs?: Record<string, unknown>; error?: string | null; model?: string | null } };
function completedRun(value: unknown, settings: ArticleWorkflowSettings): DifyRun {
  const parsed = z.object({ workflow_run_id: z.uuid(), data: z.object({ workflow_id: z.uuid(), status: z.string(),
    outputs: z.record(z.string(), z.unknown()).optional(), error: z.string().nullable().optional(), model: z.string().nullable().optional() }).passthrough() }).passthrough().safeParse(value);
  if (!parsed.success || parsed.data.data.workflow_id !== settings.workflowId) throw new ArticleProviderError('INCOMPATIBLE_CONTRACT', 'Article workflow release identity did not match the frozen release');
  return { workflow_run_id: parsed.data.workflow_run_id, data: { workflow_id: parsed.data.data.workflow_id,
    status: parsed.data.data.status, ...(parsed.data.data.outputs !== undefined ? { outputs: parsed.data.data.outputs } : {}),
    ...(parsed.data.data.error !== undefined ? { error: parsed.data.data.error } : {}),
    ...(parsed.data.data.model !== undefined ? { model: parsed.data.data.model } : {}) } };
}
function completedRunDetail(value: unknown, settings: ArticleWorkflowSettings): DifyRun {
  const parsed = z.object({ id: z.uuid(), workflow_id: z.uuid(), status: z.string(), outputs: z.record(z.string(), z.unknown()).optional(),
    error: z.string().nullable().optional(), model: z.string().nullable().optional() }).passthrough().safeParse(value);
  if (!parsed.success || parsed.data.workflow_id !== settings.workflowId) throw new ArticleProviderError('INCOMPATIBLE_CONTRACT', 'Article workflow release identity did not match the frozen release');
  return { workflow_run_id: parsed.data.id, data: { workflow_id: parsed.data.workflow_id, status: parsed.data.status,
    ...(parsed.data.outputs !== undefined ? { outputs: parsed.data.outputs } : {}), ...(parsed.data.error !== undefined ? { error: parsed.data.error } : {}),
    ...(parsed.data.model !== undefined ? { model: parsed.data.model } : {}) } };
}

async function streamRun(response: Response, settings: ArticleWorkflowSettings, signal: AbortSignal, recordRun: (id: string) => Promise<void>): Promise<DifyRun> {
  if (!response.body) throw new ArticleProviderError('INCOMPATIBLE_CONTRACT', 'Article workflow returned an empty stream');
  const reader = response.body.getReader(), decoder = new TextDecoder('utf-8', { fatal: true });
  let buffer = '', bytes = 0, run: DifyRun | undefined, capturedRunId: string | undefined;
  const processEvent = async (event: string) => {
    if (!event.trim()) return;
    if (Buffer.byteLength(event) > MAX_SSE_EVENT_BYTES) throw new ArticleProviderError('INCOMPATIBLE_CONTRACT', 'Article workflow stream event exceeded its limit');
    const data = event.split(/\r?\n/u).filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
    if (!data || data === '[DONE]') return;
    const value = safeJson(data);
    if (!value || typeof value !== 'object' || Array.isArray(value)) return;
    const payload = value as Record<string, unknown>;
    const runId = typeof payload['workflow_run_id'] === 'string' ? payload['workflow_run_id'] : capturedRunId;
    if (typeof runId === 'string' && uuid(runId)) {
      if (capturedRunId && capturedRunId !== runId) throw new ArticleProviderError('INCOMPATIBLE_CONTRACT', 'Article workflow changed its run identity');
      if (!capturedRunId) {
        capturedRunId = runId;
        try { await recordRun(runId); } catch (error) { throw new CallbackError(error); }
      }
    }
    if (payload['event'] === 'workflow_started' && typeof runId === 'string') return;
    if (payload['event'] === 'workflow_finished') {
      const workflow = payload['data'];
      if (!workflow || typeof workflow !== 'object' || Array.isArray(workflow)) throw new ArticleProviderError('INCOMPATIBLE_CONTRACT', 'Article workflow completion event was invalid');
      const detail = workflow as Record<string, unknown>;
      run = completedRun({ workflow_run_id: runId, data: { workflow_id: detail['workflow_id'], status: detail['status'], outputs: detail['outputs'], error: detail['error'], model: detail['model'] } }, settings);
    }
    if (payload['event'] === 'error') throw new ArticleProviderError('PROVIDER_FAILED', 'Article workflow reported a failure', 'KNOWN_FAILED');
  };
  try {
    while (true) {
      if (signal.aborted) throw new ArticleProviderError('TIMEOUT', 'Article workflow exceeded its execution deadline', 'UNKNOWN');
      const next = await reader.read(); if (next.done) break;
      bytes += next.value.byteLength;
      if (bytes > MAX_SSE_RESPONSE_BYTES) { await reader.cancel(); throw new ArticleProviderError('INCOMPATIBLE_CONTRACT', 'Article workflow stream exceeded its size limit'); }
      buffer += decoder.decode(next.value, { stream: true });
      let boundary: RegExpExecArray | null;
      while ((boundary = /\r?\n\r?\n/u.exec(buffer)) !== null) {
        const event = buffer.slice(0, boundary.index); buffer = buffer.slice(boundary.index + boundary[0].length); await processEvent(event);
      }
      if (Buffer.byteLength(buffer) > MAX_SSE_EVENT_BYTES) throw new ArticleProviderError('INCOMPATIBLE_CONTRACT', 'Article workflow stream event exceeded its limit');
    }
    buffer += decoder.decode();
    if (buffer.trim()) await processEvent(buffer);
  } catch (error) {
    if (error instanceof CallbackError) throw error.originalError;
    if (error instanceof ArticleProviderError) throw error;
    if (signal.aborted || error instanceof TypeError) throw new ArticleProviderError('UNKNOWN_OUTCOME', 'Article workflow outcome is unknown; the captured run will be reconciled', 'UNKNOWN');
    throw new ArticleProviderError('INCOMPATIBLE_CONTRACT', 'Article workflow returned an invalid stream');
  } finally { reader.releaseLock(); }
  if (!run) throw new ArticleProviderError('UNKNOWN_OUTCOME', 'Article workflow ended before a completion result was captured', 'UNKNOWN');
  return run;
}

const editorialReportSchema = z.object({
  schemaVersion: z.literal('article-editorial-report-v1'),
  status: z.enum(['ready', 'needs_human', 'insufficient_evidence']),
}).passthrough();
function extractionFromRun(run: DifyRun): ArticleOutput {
  if (run.data.status !== 'succeeded') throw new ArticleProviderError('PROVIDER_FAILED', 'Article workflow did not succeed', 'KNOWN_FAILED');
  const report = run.data.outputs?.['editorial_report'];
  if (typeof report !== 'string' || Buffer.byteLength(report) > MAX_EDITORIAL_REPORT_BYTES) {
    throw new ArticleProviderError('INCOMPATIBLE_CONTRACT', 'Article workflow editorial report did not match its contract');
  }
  const parsedReport = editorialReportSchema.safeParse(safeJson(report));
  if (!parsedReport.success) throw new ArticleProviderError('INCOMPATIBLE_CONTRACT', 'Article workflow editorial report did not match its contract');
  if (parsedReport.data.status !== 'ready') {
    throw new ArticleProviderError('PROVIDER_FAILED', 'Article workflow requires editorial intervention before a candidate can be accepted', 'KNOWN_FAILED');
  }
  const raw = run.data.outputs?.[release.outputVariable];
  const output = typeof raw === 'string' ? safeJson(raw) : raw;
  const parsed = articleOutputSchema.safeParse(output);
  if (!parsed.success) throw new ArticleProviderError('INCOMPATIBLE_CONTRACT', 'Article workflow output did not match article-v1');
  return parsed.data;
}

export type ArticleProviderInput = { schemaVersion: 'article-context-v1'; contentMode: 'FACTUAL' | 'CREATIVE';
  brief: Record<string, unknown>; style: { brandbook: string; tone: string; settings: unknown };
  claims: Array<{ claimRevisionId: string; wording: string; evidence: Array<{ evidenceId: string; quote: string; snapshotId: string }> }>;
  context: Array<{ snapshotId: string; purpose: string; sha256: string; text: string }>;
  outline: { title: string; sections: Array<{ title: string; purpose: string; claimRevisionIds: string[] }> } };
export class DifyArticleProvider {
  constructor(private readonly transport: typeof fetch = fetch) {}
  private headers(settings: ArticleWorkflowSettings) { return { Authorization: `Bearer ${settings.apiKey}`, 'Content-Type': 'application/json', Accept: 'text/event-stream' }; }
  async execute(settings: ArticleWorkflowSettings, jobId: string, input: ArticleProviderInput, signal: AbortSignal,
    beforeSubmit: () => Promise<void>, recordRun: (id: string) => Promise<void>): Promise<{ output: ArticleOutput; workflowRunId: string; model: string | null }> {
    const inputBytes = Buffer.byteLength(JSON.stringify(input));
    if (inputBytes > MAX_INPUT_BYTES || !input.brief || !input.outline || (input.contentMode === 'FACTUAL' && input.claims.length === 0))
      throw new ArticleProviderError('INVALID_INPUT', 'Frozen article context is empty or exceeds its limit', 'NOT_SUBMITTED');
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
    } catch { throw new ArticleProviderError('UNKNOWN_OUTCOME', 'Article workflow submission outcome is unknown', 'UNKNOWN'); }
    if (!response.ok) { await response.body?.cancel(); throw responseError(response.status); }
    const contentType = response.headers.get('content-type') ?? '';
    if (!contentType.toLowerCase().includes('text/event-stream')) {
      await response.body?.cancel();
      throw new ArticleProviderError('INCOMPATIBLE_CONTRACT', 'Article workflow did not honor the pinned streaming response mode', 'UNKNOWN');
    }
    const run = await streamRun(response, settings, signal, recordRun);
    return { output: extractionFromRun(run), workflowRunId: run.workflow_run_id, model: run.data.model ?? null };
  }
  async resume(settings: ArticleWorkflowSettings, runId: string, signal: AbortSignal): Promise<{ output: ArticleOutput; workflowRunId: string; model: string | null }> {
    if (!uuid(runId)) throw new ArticleProviderError('CONFIG', 'Captured article workflow run ID is invalid');
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
      if (run.workflow_run_id !== runId) throw new ArticleProviderError('INCOMPATIBLE_CONTRACT', 'Article workflow returned a different run identity');
      if (['running', 'paused'].includes(run.data.status)) { await pollDelay(signal); continue; }
      return { output: extractionFromRun(run), workflowRunId: run.workflow_run_id, model: run.data.model ?? null };
    }
    throw new ArticleProviderError('TIMEOUT', 'Article workflow did not finish before the execution deadline', 'UNKNOWN');
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
