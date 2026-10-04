import { createHash } from 'node:crypto';
import { z } from 'zod';
import { claimsOutputSchema, type ClaimsOutput, type ClaimWorkflowRelease } from './contracts.js';

export const CLAIMS_CONTRACT = 'claims-v1';
const MAX_RESPONSE_BYTES = 512 * 1024;
const MAX_SSE_EVENT_BYTES = 128 * 1024;
const MAX_INPUT_BYTES = 1024 * 1024;

type ReleaseArtifact = {
  schemaVersion: 'contextflow-dify-release-v1';
  operation: 'CLAIM_EXTRACTION';
  releaseId: string;
  configDigest: string;
  publishedWorkflowIdEnv: 'DIFY_CLAIM_EXTRACTION_PUBLISHED_WORKFLOW_ID';
  configDigestEnv: 'DIFY_CLAIM_EXTRACTION_CONFIG_SHA256';
  apiBaseEnv: 'DIFY_API_BASE_URL';
  apiKeyEnv: 'DIFY_CLAIM_EXTRACTION_API_KEY';
  contractVersion: typeof CLAIMS_CONTRACT;
  promptTemplateVersion: string;
  promptTemplateFile: string;
  inputVariable: 'sources_json';
  outputVariable: 'claims_json';
  responseMode: 'streaming';
  provider: 'dify';
  model: { provider: string; name: string; mode: string; completionParams: Record<string, string | number | boolean> };
  workflowDslFile: string;
  workflowDslSha256: string;
};

// Deployment explicitly attests that this published UUID contains the pinned
// configuration digest; a workflow ID alone cannot prove release settings.
const release: ReleaseArtifact = {
  schemaVersion: 'contextflow-dify-release-v1', operation: 'CLAIM_EXTRACTION', releaseId: 'claim-extraction-2026-09-30.1',
  configDigest: '9c8619e05041a0de3c3eb4fb925b96c68bb7b0166d6be1dfc7f259e750f9af3c', publishedWorkflowIdEnv: 'DIFY_CLAIM_EXTRACTION_PUBLISHED_WORKFLOW_ID',
  configDigestEnv: 'DIFY_CLAIM_EXTRACTION_CONFIG_SHA256',
  apiBaseEnv: 'DIFY_API_BASE_URL', apiKeyEnv: 'DIFY_CLAIM_EXTRACTION_API_KEY', contractVersion: CLAIMS_CONTRACT,
  promptTemplateVersion: 'claims-extraction-prompt-v1', promptTemplateFile: 'prompt.md', inputVariable: 'sources_json',
  outputVariable: 'claims_json', responseMode: 'streaming', provider: 'dify',
  model: { provider: 'openai', name: 'gpt-4.1-mini', mode: 'chat', completionParams: { temperature: 0, max_tokens: 8192 } },
  workflowDslFile: 'claim-extraction-v1.yml',
  workflowDslSha256: 'fd2cb307a0fdbba610365378316687b66777c2506f57a86c3ec1dacc17bb853d',
};

function testEnvironment(env: Record<string, string | undefined>): Record<string, string | undefined> {
  if (env['NODE_ENV'] !== 'test') return env;
  return Object.fromEntries(Object.entries(env).filter(([name]) => name.startsWith('TEST_')).map(([name, value]) => [name.slice(5), value]));
}
export type ClaimWorkflowSettings = ClaimWorkflowRelease & { apiKey: string };
export class ClaimProviderError extends Error {
  constructor(readonly code: 'CONFIG' | 'AUTH' | 'INVALID_INPUT' | 'INCOMPATIBLE_CONTRACT' | 'QUOTA' | 'RATE_LIMIT' | 'TRANSIENT_TRANSPORT'
    | 'TIMEOUT' | 'UNKNOWN_OUTCOME' | 'PROVIDER_FAILED', message: string, readonly outcome: 'NOT_SUBMITTED' | 'KNOWN_FAILED' | 'UNKNOWN' = 'KNOWN_FAILED') {
    super(message); this.name = 'ClaimProviderError';
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
function configuredRelease(env: Record<string, string | undefined>): ClaimWorkflowRelease {
  const effective = testEnvironment(env);
  const endpoint = safeEndpoint(effective[release.apiBaseEnv], effective['NODE_ENV'] !== 'production');
  const workflowId = effective[release.publishedWorkflowIdEnv];
  if (!endpoint || !uuid(workflowId) || effective[release.configDigestEnv] !== release.configDigest) {
    throw new ClaimProviderError('CONFIG', 'The published claim-extraction workflow release is not configured', 'NOT_SUBMITTED');
  }
  return { endpoint, workflowId, releaseId: release.releaseId, configDigest: release.configDigest,
    contractVersion: release.contractVersion, promptTemplateVersion: release.promptTemplateVersion };
}
export function claimWorkflowRelease(env: Record<string, string | undefined> = process.env): ClaimWorkflowRelease {
  const config = configuredRelease(env);
  return { endpoint: config.endpoint, workflowId: config.workflowId, releaseId: config.releaseId,
    configDigest: config.configDigest, contractVersion: config.contractVersion, promptTemplateVersion: config.promptTemplateVersion };
}
export function claimWorkflowSettings(env: Record<string, string | undefined> = process.env): ClaimWorkflowSettings {
  const apiKey = testEnvironment(env)[release.apiKeyEnv];
  if (!apiKey || apiKey.length > 500) throw new ClaimProviderError('CONFIG', 'The claim workflow API key is missing', 'NOT_SUBMITTED');
  return { ...configuredRelease(env), apiKey };
}

function safeJson(text: string): unknown {
  try { return JSON.parse(text); } catch { throw new ClaimProviderError('INCOMPATIBLE_CONTRACT', 'The claim workflow returned an invalid contract'); }
}
function responseError(status: number, unknownAfterSubmit = true): ClaimProviderError {
  const outcome = unknownAfterSubmit ? 'UNKNOWN' : 'KNOWN_FAILED';
  if (status === 401 || status === 403) return new ClaimProviderError('AUTH', 'Claim workflow authentication failed', 'KNOWN_FAILED');
  if (status === 402) return new ClaimProviderError('QUOTA', 'Claim workflow quota is exhausted', 'KNOWN_FAILED');
  if (status === 429) return new ClaimProviderError('RATE_LIMIT', 'Claim workflow is rate limited', 'KNOWN_FAILED');
  if (status >= 500) return new ClaimProviderError('TRANSIENT_TRANSPORT', 'Claim workflow service is temporarily unavailable', outcome);
  return new ClaimProviderError('PROVIDER_FAILED', 'Claim workflow could not complete the request', 'KNOWN_FAILED');
}
async function boundedJson(response: Response): Promise<unknown> {
  const reader = response.body?.getReader();
  if (!reader) throw new ClaimProviderError('INCOMPATIBLE_CONTRACT', 'Claim workflow returned an empty response');
  const chunks: Uint8Array[] = []; let size = 0;
  try {
    while (true) {
      const next = await reader.read(); if (next.done) break;
      size += next.value.byteLength;
      if (size > MAX_RESPONSE_BYTES) { await reader.cancel(); throw new ClaimProviderError('INCOMPATIBLE_CONTRACT', 'Claim workflow response exceeded its size limit'); }
      chunks.push(next.value);
    }
    return safeJson(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
  } catch (error) {
    if (error instanceof ClaimProviderError) throw error;
    throw new ClaimProviderError('INCOMPATIBLE_CONTRACT', 'Claim workflow returned an invalid response');
  } finally { reader.releaseLock(); }
}
class CallbackError extends Error { constructor(readonly originalError: unknown) { super('Provider callback failed'); } }

type DifyRun = { workflow_run_id: string; data: { workflow_id: string; status: string; outputs?: Record<string, unknown>; error?: string | null; model?: string | null } };
function completedRun(value: unknown, settings: ClaimWorkflowSettings): DifyRun {
  const parsed = z.object({ workflow_run_id: z.uuid(), data: z.object({ workflow_id: z.uuid(), status: z.string(),
    outputs: z.record(z.string(), z.unknown()).optional(), error: z.string().nullable().optional(), model: z.string().nullable().optional() }).passthrough() }).passthrough().safeParse(value);
  if (!parsed.success || parsed.data.data.workflow_id !== settings.workflowId) throw new ClaimProviderError('INCOMPATIBLE_CONTRACT', 'Claim workflow release identity did not match the frozen release');
  return { workflow_run_id: parsed.data.workflow_run_id, data: { workflow_id: parsed.data.data.workflow_id,
    status: parsed.data.data.status, ...(parsed.data.data.outputs !== undefined ? { outputs: parsed.data.data.outputs } : {}),
    ...(parsed.data.data.error !== undefined ? { error: parsed.data.data.error } : {}),
    ...(parsed.data.data.model !== undefined ? { model: parsed.data.data.model } : {}) } };
}
function completedRunDetail(value: unknown, settings: ClaimWorkflowSettings): DifyRun {
  const parsed = z.object({ id: z.uuid(), workflow_id: z.uuid(), status: z.string(), outputs: z.record(z.string(), z.unknown()).optional(),
    error: z.string().nullable().optional(), model: z.string().nullable().optional() }).passthrough().safeParse(value);
  if (!parsed.success || parsed.data.workflow_id !== settings.workflowId) throw new ClaimProviderError('INCOMPATIBLE_CONTRACT', 'Claim workflow release identity did not match the frozen release');
  return { workflow_run_id: parsed.data.id, data: { workflow_id: parsed.data.workflow_id, status: parsed.data.status,
    ...(parsed.data.outputs !== undefined ? { outputs: parsed.data.outputs } : {}), ...(parsed.data.error !== undefined ? { error: parsed.data.error } : {}),
    ...(parsed.data.model !== undefined ? { model: parsed.data.model } : {}) } };
}

async function streamRun(response: Response, settings: ClaimWorkflowSettings, signal: AbortSignal, recordRun: (id: string) => Promise<void>): Promise<DifyRun> {
  if (!response.body) throw new ClaimProviderError('INCOMPATIBLE_CONTRACT', 'Claim workflow returned an empty stream');
  const reader = response.body.getReader(), decoder = new TextDecoder('utf-8', { fatal: true });
  let buffer = '', bytes = 0, run: DifyRun | undefined, capturedRunId: string | undefined;
  const processEvent = async (event: string) => {
    if (!event.trim()) return;
    if (Buffer.byteLength(event) > MAX_SSE_EVENT_BYTES) throw new ClaimProviderError('INCOMPATIBLE_CONTRACT', 'Claim workflow stream event exceeded its limit');
    const data = event.split(/\r?\n/u).filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
    if (!data || data === '[DONE]') return;
    const value = safeJson(data);
    if (!value || typeof value !== 'object' || Array.isArray(value)) return;
    const payload = value as Record<string, unknown>;
    const runId = typeof payload['workflow_run_id'] === 'string' ? payload['workflow_run_id'] : capturedRunId;
    if (typeof runId === 'string' && uuid(runId)) {
      if (capturedRunId && capturedRunId !== runId) throw new ClaimProviderError('INCOMPATIBLE_CONTRACT', 'Claim workflow changed its run identity');
      if (!capturedRunId) {
        capturedRunId = runId;
        try { await recordRun(runId); } catch (error) { throw new CallbackError(error); }
      }
    }
    if (payload['event'] === 'workflow_started' && typeof runId === 'string') return;
    if (payload['event'] === 'workflow_finished') {
      const workflow = payload['data'];
      if (!workflow || typeof workflow !== 'object' || Array.isArray(workflow)) throw new ClaimProviderError('INCOMPATIBLE_CONTRACT', 'Claim workflow completion event was invalid');
      const detail = workflow as Record<string, unknown>;
      run = completedRun({ workflow_run_id: runId, data: { workflow_id: detail['workflow_id'], status: detail['status'], outputs: detail['outputs'], error: detail['error'], model: detail['model'] } }, settings);
    }
    if (payload['event'] === 'error') throw new ClaimProviderError('PROVIDER_FAILED', 'Claim workflow reported a failure', 'KNOWN_FAILED');
  };
  try {
    while (true) {
      if (signal.aborted) throw new ClaimProviderError('TIMEOUT', 'Claim workflow exceeded its execution deadline', 'UNKNOWN');
      const next = await reader.read(); if (next.done) break;
      bytes += next.value.byteLength;
      if (bytes > MAX_RESPONSE_BYTES) { await reader.cancel(); throw new ClaimProviderError('INCOMPATIBLE_CONTRACT', 'Claim workflow stream exceeded its size limit'); }
      buffer += decoder.decode(next.value, { stream: true });
      let boundary: RegExpExecArray | null;
      while ((boundary = /\r?\n\r?\n/u.exec(buffer)) !== null) {
        const event = buffer.slice(0, boundary.index); buffer = buffer.slice(boundary.index + boundary[0].length); await processEvent(event);
      }
      if (Buffer.byteLength(buffer) > MAX_SSE_EVENT_BYTES) throw new ClaimProviderError('INCOMPATIBLE_CONTRACT', 'Claim workflow stream event exceeded its limit');
    }
    buffer += decoder.decode();
    if (buffer.trim()) await processEvent(buffer);
  } catch (error) {
    if (error instanceof CallbackError) throw error.originalError;
    if (error instanceof ClaimProviderError) throw error;
    if (signal.aborted || error instanceof TypeError) throw new ClaimProviderError('UNKNOWN_OUTCOME', 'Claim workflow outcome is unknown; the captured run will be reconciled', 'UNKNOWN');
    throw new ClaimProviderError('INCOMPATIBLE_CONTRACT', 'Claim workflow returned an invalid stream');
  } finally { reader.releaseLock(); }
  if (!run) throw new ClaimProviderError('UNKNOWN_OUTCOME', 'Claim workflow ended before a completion result was captured', 'UNKNOWN');
  return run;
}

function extractionFromRun(run: DifyRun): ClaimsOutput {
  if (run.data.status !== 'succeeded') throw new ClaimProviderError('PROVIDER_FAILED', 'Claim workflow did not succeed', 'KNOWN_FAILED');
  const raw = run.data.outputs?.[release.outputVariable];
  const output = typeof raw === 'string' ? safeJson(raw) : raw;
  const parsed = claimsOutputSchema.safeParse(output);
  if (!parsed.success) throw new ClaimProviderError('INCOMPATIBLE_CONTRACT', 'Claim workflow output did not match claims-v1');
  return parsed.data;
}

export type ClaimSourceInput = { snapshotId: string; materialId: string; sha256: string; fragments: Array<{ id: string; startOffset: number; endOffset: number; sha256: string; text: string }> };
export class DifyClaimProvider {
  constructor(private readonly transport: typeof fetch = fetch) {}
  private headers(settings: ClaimWorkflowSettings) { return { Authorization: `Bearer ${settings.apiKey}`, 'Content-Type': 'application/json', Accept: 'text/event-stream' }; }
  async execute(settings: ClaimWorkflowSettings, jobId: string, sources: ClaimSourceInput[], signal: AbortSignal,
    beforeSubmit: () => Promise<void>, recordRun: (id: string) => Promise<void>): Promise<{ output: ClaimsOutput; workflowRunId: string; model: string | null }> {
    const inputBytes = Buffer.byteLength(JSON.stringify(sources));
    if (inputBytes > MAX_INPUT_BYTES || sources.length === 0 || sources.some(source => source.fragments.length === 0))
      throw new ClaimProviderError('INVALID_INPUT', 'Frozen factual-source input is empty or exceeds its limit', 'NOT_SUBMITTED');
    const origin = settings.endpoint;
    // Dify Cloud's version-specific execution route is plan-gated. Run the
    // currently published app, then accept output only if its returned version
    // matches the workflow ID frozen into this job's release manifest.
    const url = `${origin}/workflows/run`;
    await beforeSubmit();
    let response: Response;
    try {
      response = await this.transport(url, { method: 'POST', headers: this.headers(settings), redirect: 'error', signal,
        body: JSON.stringify({ inputs: { [release.inputVariable]: JSON.stringify(sources) }, response_mode: release.responseMode, user: `job-${jobId}` }) });
    } catch { throw new ClaimProviderError('UNKNOWN_OUTCOME', 'Claim workflow submission outcome is unknown', 'UNKNOWN'); }
    if (!response.ok) { await response.body?.cancel(); throw responseError(response.status); }
    const contentType = response.headers.get('content-type') ?? '';
    if (!contentType.toLowerCase().includes('text/event-stream')) {
      await response.body?.cancel();
      throw new ClaimProviderError('INCOMPATIBLE_CONTRACT', 'Claim workflow did not honor the pinned streaming response mode', 'UNKNOWN');
    }
    const run = await streamRun(response, settings, signal, recordRun);
    return { output: extractionFromRun(run), workflowRunId: run.workflow_run_id, model: run.data.model ?? null };
  }
  async resume(settings: ClaimWorkflowSettings, runId: string, signal: AbortSignal): Promise<{ output: ClaimsOutput; workflowRunId: string; model: string | null }> {
    if (!uuid(runId)) throw new ClaimProviderError('CONFIG', 'Captured claim workflow run ID is invalid');
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
      if (run.workflow_run_id !== runId) throw new ClaimProviderError('INCOMPATIBLE_CONTRACT', 'Claim workflow returned a different run identity');
      if (['running', 'paused'].includes(run.data.status)) { await pollDelay(signal); continue; }
      return { output: extractionFromRun(run), workflowRunId: run.workflow_run_id, model: run.data.model ?? null };
    }
    throw new ClaimProviderError('TIMEOUT', 'Claim workflow did not finish before the execution deadline', 'UNKNOWN');
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
