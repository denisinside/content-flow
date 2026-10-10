import { createHash } from 'node:crypto';
import { z } from 'zod';
import { ImportValidationError, type DigitalDocument } from './document-validation.js';
import { publicAddress, validatePublicUrl, type ResolveAddresses, resolveAddresses } from './url-validation.js';

export const IMPORT_CONTRACT = 'source-import-v1';
export const DOCLING_VERSION = '1.21.0';
export const FIRECRAWL_OPTIONS = Object.freeze({ formats: ['markdown'], onlyMainContent: true, maxAge: 0, storeInCache: false,
  timeout: 60000, skipTlsVerification: false, parsers: [], actions: [], headers: {}, removeBase64Images: true });
export const DOCLING_OPTIONS = Object.freeze({ to_formats: 'md', do_ocr: 'false', force_ocr: 'false', image_export_mode: 'placeholder', table_mode: 'accurate' });
export type ImportProviderSettings = { firecrawlEndpoint: string; firecrawlVersion: string; remotePolicyDigest: string; doclingEndpoint: string; doclingVersion: string };
function providerEnvironment(env: Record<string, string | undefined>): Record<string, string | undefined> {
  if (env['NODE_ENV'] !== 'test') return env;
  return Object.fromEntries(Object.entries(env).filter(([name]) => name.startsWith('TEST_')).map(([name, value]) => [name.slice(5), value]));
}
export function importProviderSettings(env: Record<string, string | undefined>): ImportProviderSettings {
  env = providerEnvironment(env);
  return { firecrawlEndpoint: env['FIRECRAWL_ENDPOINT'] ?? '', firecrawlVersion: env['FIRECRAWL_VERSION'] ?? 'v2',
    remotePolicyDigest: env['FIRECRAWL_EGRESS_POLICY_SHA256'] ?? '', doclingEndpoint: env['DOCLING_ENDPOINT'] ?? '',
    doclingVersion: env['DOCLING_VERSION'] ?? DOCLING_VERSION };
}
export type ImportedSource = { text: string; metadata: Record<string, unknown> };
export class ImportProviderError extends Error {
  constructor(readonly code: 'CONFIG' | 'CONTRACT' | 'NO_TEXT' | 'INVALID_URL' | 'QUOTA' | 'AUTH' | 'TRANSIENT' | 'UNKNOWN_OUTCOME', message: string) { super(message); }
}
const policySchema = z.object({ schemaVersion: z.literal('contextflow-egress-v1'), policyDigest: z.string().regex(/^[a-f0-9]{64}$/),
  publicOnly: z.literal(true), pinDns: z.literal(true), validateEveryRedirect: z.literal(true), validateSubresources: z.literal(true),
  networkIsolation: z.literal(true), maxRedirects: z.number().int().min(0).max(5), maxRequests: z.number().int().positive().max(100),
  maxResponseBytes: z.number().int().positive().max(10 * 1024 * 1024) }).strict();
const traceSchema = z.object({ policyDigest: z.string(), requests: z.array(z.object({ url: z.string().max(2048),
  addresses: z.array(z.string()).min(1).max(32), connectedAddress: z.string(), responseBytes: z.number().int().nonnegative(),
  redirect: z.boolean() }).strict()).min(1).max(100) }).strict();
const webSchema = z.object({ success: z.literal(true), data: z.object({ markdown: z.string().max(200_000),
  metadata: z.object({ statusCode: z.number().int().min(200).max(299), sourceURL: z.string().max(2048).optional(),
    url: z.string().max(2048).optional(), title: z.string().max(1000).optional(), language: z.string().max(100).optional(),
    contentType: z.string().max(200).optional() }).passthrough(), remoteFetch: traceSchema.optional() }).passthrough() }).passthrough();
const doclingSchema = z.object({ status: z.literal('success'), document: z.object({ md_content: z.string().max(200_000) }).passthrough(),
  processing_time: z.number().nonnegative().optional() }).passthrough();

function endpoint(value: string, allowLocal = false): string {
  try {
    const url = new URL(value);
    if ((url.protocol !== 'https:' && !(allowLocal && url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))
      || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error();
    return url.origin;
  } catch { throw new ImportProviderError('CONFIG', 'The import provider endpoint is not configured safely'); }
}
export function isOfficialFirecrawlCloud(value: string): boolean {
  try { const url = new URL(value); return url.protocol === 'https:' && url.hostname === 'api.firecrawl.dev'; }
  catch { return false; }
}
function normalizedText(value: string): string {
  const text = value.replace(/^\uFEFF/u, '').replace(/\r\n?/gu, '\n');
  if (!text.trim()) throw new ImportProviderError('NO_TEXT', 'No digital text was found. OCR is disabled; enter a manual transcript for this original.');
  if (text.length > 200_000 || Buffer.from(text).toString('utf8') !== text || /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/u.test(text)) {
    throw new ImportProviderError('CONTRACT', 'The provider returned unsupported source text');
  }
  return text;
}
async function boundedJson(response: Response, limit: number): Promise<unknown> {
  if (!response.ok) {
    await response.body?.cancel();
    const code = response.status === 401 || response.status === 403 ? 'AUTH' : response.status === 402 ? 'QUOTA'
      : response.status === 429 || response.status === 503 ? 'TRANSIENT' : 'CONTRACT';
    throw new ImportProviderError(code, 'The import provider could not complete the request');
  }
  const reader = response.body?.getReader();
  if (!reader) throw new ImportProviderError('CONTRACT', 'The provider response is empty');
  const chunks: Buffer[] = []; let size = 0;
  try {
    while (true) {
      const item = await reader.read(); if (item.done) break;
      size += item.value.length;
      if (size > limit) { await reader.cancel(); throw new ImportProviderError('CONTRACT', 'The provider response exceeds its limit'); }
      chunks.push(Buffer.from(item.value));
    }
    try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))); }
    catch { throw new ImportProviderError('CONTRACT', 'The provider returned an incompatible response'); }
  } finally { reader.releaseLock(); }
}
export class ImportProviders {
  private readonly env: Record<string, string | undefined>;
  private readonly allowLocal: boolean;
  constructor(env: Record<string, string | undefined> = process.env,
    private readonly transport: typeof fetch = fetch, private readonly resolver: ResolveAddresses = resolveAddresses) {
    this.env = providerEnvironment(env); this.allowLocal = env['NODE_ENV'] !== 'production';
  }

  async web(value: string, settings: ImportProviderSettings, signal: AbortSignal, beforeSubmit: () => Promise<void>): Promise<ImportedSource> {
    const origin = endpoint(settings.firecrawlEndpoint), key = this.env['FIRECRAWL_API_KEY'];
    const cloud = isOfficialFirecrawlCloud(origin);
    if (!key || settings.firecrawlVersion !== 'v2' || !cloud && !/^[a-f0-9]{64}$/u.test(settings.remotePolicyDigest))
      throw new ImportProviderError('CONFIG', 'Firecrawl Cloud requires its API key; custom Firecrawl endpoints require the protected gateway policy');
    const checked = await validatePublicUrl(value, this.resolver);
    const headers = { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' };
    if (cloud) {
      // The app rejects obvious private/reserved input URLs before submission.
      // Firecrawl Cloud performs the remote fetch, so its network controls are
      // provider-managed and cannot be represented as our own pinned egress trace.
      const again = await validatePublicUrl(checked.url, this.resolver);
      if (again.addresses.join(',') !== checked.addresses.join(',')) throw new ImportProviderError('INVALID_URL', 'The URL DNS answers changed before submission');
      await beforeSubmit();
      let raw: unknown;
      try { raw = await boundedJson(await this.transport(`${origin}/v2/scrape`, { method: 'POST', headers, redirect: 'error', signal,
        body: JSON.stringify({ url: checked.url, ...FIRECRAWL_OPTIONS }) }), 2 * 1024 * 1024); }
      catch (error) { if (error instanceof ImportProviderError) throw error; throw new ImportProviderError('UNKNOWN_OUTCOME', 'The provider outcome is unknown. Start an explicit new import.'); }
      const parsed = webSchema.safeParse(raw);
      if (!parsed.success) throw new ImportProviderError('CONTRACT', 'Firecrawl Cloud returned an incompatible scrape response');
      const { data } = parsed.data;
      const finalUrl = data.metadata.url ?? data.metadata.sourceURL ?? checked.url;
      const final = await validatePublicUrl(finalUrl, this.resolver);
      const text = normalizedText(data.markdown);
      return { text, metadata: { schemaVersion: IMPORT_CONTRACT, provider: 'firecrawl', version: settings.firecrawlVersion,
        requestedUrl: checked.url, finalUrl: final.url, retrievedAt: new Date().toISOString(), options: FIRECRAWL_OPTIONS,
        egressMode: 'firecrawl-cloud',
        ...(data.metadata.title ? { title: data.metadata.title } : {}), ...(data.metadata.language ? { language: data.metadata.language } : {}),
        ...(data.metadata.contentType ? { contentType: data.metadata.contentType } : {}), statusCode: data.metadata.statusCode } };
    }
    let policy: z.infer<typeof policySchema>;
    try {
      const response = await this.transport(`${origin}/contextflow/egress-policy`, { headers, redirect: 'error', signal });
      const parsed = policySchema.safeParse(await boundedJson(response, 16384));
      if (!parsed.success || parsed.data.policyDigest !== settings.remotePolicyDigest) throw new Error();
      policy = parsed.data;
    } catch { throw new ImportProviderError('CONFIG', 'The Firecrawl gateway does not prove the required pinned remote-fetch controls'); }
    // Gateway pins these target addresses and applies its advertised controls to
    // every redirect/subresource. Local validation alone cannot control vendor egress.
    const again = await validatePublicUrl(checked.url, this.resolver);
    if (again.addresses.join(',') !== checked.addresses.join(',')) throw new ImportProviderError('INVALID_URL', 'The URL DNS answers changed before submission');
    await beforeSubmit();
    let raw: unknown;
    try { raw = await boundedJson(await this.transport(`${origin}/v2/scrape`, { method: 'POST', headers: { ...headers,
      'X-Contextflow-Egress-Policy': policy.policyDigest }, redirect: 'error', signal,
      body: JSON.stringify({ url: checked.url, ...FIRECRAWL_OPTIONS, contextflowEgress: { policyDigest: policy.policyDigest, pinnedAddresses: checked.addresses } }) }), 2 * 1024 * 1024); }
    catch (error) { if (error instanceof ImportProviderError) throw error; throw new ImportProviderError('UNKNOWN_OUTCOME', 'The provider outcome is unknown. Start an explicit new import.'); }
    const parsed = webSchema.safeParse(raw);
    if (!parsed.success) throw new ImportProviderError('CONTRACT', 'The provider did not return the required source and remote-fetch evidence');
    const { data } = parsed.data, remoteFetch = data.remoteFetch;
    if (!remoteFetch || remoteFetch.policyDigest !== policy.policyDigest) throw new ImportProviderError('CONTRACT', 'The provider did not return the required source and remote-fetch evidence');
    const trace = remoteFetch.requests;
    if (trace.length > policy.maxRequests || trace.filter(request => request.redirect).length > policy.maxRedirects
      || trace.reduce((total, request) => total + request.responseBytes, 0) > policy.maxResponseBytes
      || trace.some(request => request.addresses.some(address => !publicAddress(address)) || !request.addresses.includes(request.connectedAddress))) {
      throw new ImportProviderError('CONTRACT', 'The remote-fetch evidence violates the pinned egress policy');
    }
    for (const request of trace) {
      const destination = await validatePublicUrl(request.url, this.resolver);
      if (destination.addresses.join(',') !== [...new Set(request.addresses)].sort().join(',')) throw new ImportProviderError('CONTRACT', 'Remote DNS evidence differs from the validated public destination');
    }
    if (trace[0]?.url !== checked.url || trace[0].addresses.join(',') !== checked.addresses.join(',')) throw new ImportProviderError('CONTRACT', 'Remote-fetch evidence does not begin with the pinned input');
    const finalUrl = data.metadata.url ?? data.metadata.sourceURL ?? checked.url;
    if (!trace.some(request => request.url === finalUrl)) throw new ImportProviderError('CONTRACT', 'The returned source URL is absent from remote-fetch evidence');
    const text = normalizedText(data.markdown);
    return { text, metadata: { schemaVersion: IMPORT_CONTRACT, provider: 'firecrawl', version: settings.firecrawlVersion,
      requestedUrl: checked.url, finalUrl, retrievedAt: new Date().toISOString(), options: FIRECRAWL_OPTIONS,
      policyDigest: policy.policyDigest, remoteFetch,
      ...(data.metadata.title ? { title: data.metadata.title } : {}), ...(data.metadata.language ? { language: data.metadata.language } : {}),
      statusCode: data.metadata.statusCode, contentType: data.metadata.contentType ?? null } };
  }

  async document(document: DigitalDocument, settings: ImportProviderSettings, signal: AbortSignal, beforeSubmit: () => Promise<void>): Promise<ImportedSource> {
    const origin = endpoint(settings.doclingEndpoint, this.allowLocal);
    if (settings.doclingVersion !== DOCLING_VERSION) throw new ImportProviderError('CONFIG', 'Docling Serve must use the pinned 1.21.0 upload contract');
    const form = new FormData();
    form.set('files', new File([new Uint8Array(document.bytes)], document.filename, { type: document.mediaType }));
    form.set('from_formats', document.format);
    for (const [name, value] of Object.entries(DOCLING_OPTIONS)) form.set(name, value);
    await beforeSubmit();
    let raw: unknown;
    try { raw = await boundedJson(await this.transport(`${origin}/v1/convert/file`, { method: 'POST', body: form, redirect: 'error', signal,
      ...(this.env['DOCLING_API_KEY'] ? { headers: { 'X-Api-Key': this.env['DOCLING_API_KEY'] } } : {}) }), 2 * 1024 * 1024); }
    catch (error) { if (error instanceof ImportProviderError) throw error; throw new ImportProviderError('UNKNOWN_OUTCOME', 'The converter outcome is unknown. Start an explicit new import.'); }
    const parsed = doclingSchema.safeParse(raw);
    if (!parsed.success) throw new ImportProviderError('CONTRACT', 'Docling returned an incomplete or incompatible conversion');
    const text = normalizedText(parsed.data.document.md_content);
    return { text, metadata: { schemaVersion: IMPORT_CONTRACT, provider: 'docling', version: settings.doclingVersion,
      retrievedAt: new Date().toISOString(), options: { from_formats: document.format, ...DOCLING_OPTIONS },
      originalSha256: createHash('sha256').update(document.bytes).digest('hex'),
      processingSeconds: parsed.data.processing_time ?? null, locatorType: 'normalized-text-offsets' } };
  }
}

export function safeImportError(error: unknown): { code: string; message: string } {
  if (error instanceof ImportProviderError || error instanceof ImportValidationError) return { code: error.code, message: error.message };
  return { code: 'CONTRACT', message: 'The imported source could not be validated' };
}
