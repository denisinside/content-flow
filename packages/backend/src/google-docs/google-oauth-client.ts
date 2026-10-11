import { createHash } from 'node:crypto';
import { z } from 'zod';

const AUTHORIZATION_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
const REVOCATION_ENDPOINT = 'https://oauth2.googleapis.com/revoke';
export const GOOGLE_DOCS_FILE_SCOPE = 'https://www.googleapis.com/auth/drive.file';
const MAX_RESPONSE_BYTES = 16 * 1024;
const DEFAULT_TIMEOUT_MS = 10_000;
const bearer = z.literal('Bearer');
const tokenResponseSchema = z.object({
  access_token: z.string().min(1).max(8192), token_type: bearer, expires_in: z.number().int().min(1).max(86_400),
  refresh_token: z.string().min(1).max(8192).optional(), scope: z.string().max(4096).optional(),
  refresh_token_expires_in: z.number().int().min(1).max(315_360_000).optional(),
}).strict();

export type GoogleOAuthTokens = z.infer<typeof tokenResponseSchema>;
export type GoogleOAuthErrorKind = 'CONFIG' | 'TIMEOUT' | 'TRANSPORT' | 'HTTP' | 'INVALID_RESPONSE';

/** Safe categorical failure: provider messages and credentials are never retained. */
export class GoogleOAuthError extends Error {
  constructor(readonly kind: GoogleOAuthErrorKind, readonly status?: number) {
    super(`Google OAuth request failed (${kind}${status ? `, HTTP ${status}` : ''})`);
    this.name = 'GoogleOAuthError';
  }
}

export interface GoogleOAuthClientOptions {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  maxResponseBytes?: number;
}

function validVerifier(value: string) { return /^[A-Za-z0-9._~-]{43,128}$/u.test(value); }
function validState(value: string) { return /^[A-Za-z0-9._~-]{32,256}$/u.test(value); }
function validRedirectUri(raw: string) {
  try {
    const url = new URL(raw);
    if (url.username || url.password || url.search || url.hash || url.pathname !== '/api/v1/google-docs/oauth/callback') return false;
    if (url.protocol === 'https:') return true;
    return url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname);
  }
  catch { return false; }
}

async function readBounded(response: Response, limit: number, allowEmpty = false): Promise<unknown> {
  const reader = response.body?.getReader();
  if (!reader) {
    if (allowEmpty) return undefined;
    throw new GoogleOAuthError('INVALID_RESPONSE', response.status);
  }
  const chunks: Uint8Array[] = []; let bytes = 0;
  try {
    while (true) {
      const item = await reader.read();
      if (item.done) break;
      bytes += item.value.byteLength;
      if (bytes > limit) { await reader.cancel(); throw new GoogleOAuthError('INVALID_RESPONSE', response.status); }
      chunks.push(item.value);
    }
    if (bytes === 0 && allowEmpty) return undefined;
    try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks.map(chunk => Buffer.from(chunk))))); }
    catch { throw new GoogleOAuthError('INVALID_RESPONSE', response.status); }
  } finally { reader.releaseLock(); }
}

export class GoogleOAuthClient {
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly maxResponseBytes: number;

  constructor(private readonly options: GoogleOAuthClientOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxResponseBytes = options.maxResponseBytes ?? MAX_RESPONSE_BYTES;
    if (!options.clientId.trim() || options.clientId.length > 512 || !options.clientSecret || options.clientSecret.length > 8192
      || !validRedirectUri(options.redirectUri) || !Number.isSafeInteger(this.timeoutMs) || this.timeoutMs < 100 || this.timeoutMs > 60_000
      || !Number.isSafeInteger(this.maxResponseBytes) || this.maxResponseBytes < 1024 || this.maxResponseBytes > 1024 * 1024) {
      throw new GoogleOAuthError('CONFIG');
    }
  }

  authorizationUrl(state: string, codeVerifier: string): string {
    if (!validState(state) || !validVerifier(codeVerifier)) throw new GoogleOAuthError('CONFIG');
    const challenge = createHash('sha256').update(codeVerifier, 'ascii').digest('base64url');
    const url = new URL(AUTHORIZATION_ENDPOINT);
    url.searchParams.set('client_id', this.options.clientId);
    url.searchParams.set('redirect_uri', this.options.redirectUri);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('scope', GOOGLE_DOCS_FILE_SCOPE);
    url.searchParams.set('access_type', 'offline');
    url.searchParams.set('prompt', 'consent');
    url.searchParams.set('include_granted_scopes', 'false');
    url.searchParams.set('state', state);
    url.searchParams.set('code_challenge', challenge);
    url.searchParams.set('code_challenge_method', 'S256');
    return url.toString();
  }

  exchangeAuthorizationCode(code: string, codeVerifier: string): Promise<GoogleOAuthTokens> {
    if (!code.trim() || code.length > 8192 || !validVerifier(codeVerifier)) throw new GoogleOAuthError('CONFIG');
    return this.tokenRequest({ grant_type: 'authorization_code', code, code_verifier: codeVerifier, redirect_uri: this.options.redirectUri });
  }

  refreshAccessToken(refreshToken: string): Promise<GoogleOAuthTokens> {
    if (!refreshToken.trim() || refreshToken.length > 8192) throw new GoogleOAuthError('CONFIG');
    return this.tokenRequest({ grant_type: 'refresh_token', refresh_token: refreshToken });
  }

  async revokeToken(token: string): Promise<void> {
    if (!token.trim() || token.length > 8192) throw new GoogleOAuthError('CONFIG');
    await this.request(REVOCATION_ENDPOINT, new URLSearchParams({ token }).toString(), async response => {
      if (!response.ok) { await response.body?.cancel(); throw new GoogleOAuthError('HTTP', response.status); }
      // Revocation normally returns an empty body. Bound any content Google sends.
      await readBounded(response, this.maxResponseBytes, true);
    });
  }

  private async tokenRequest(fields: Record<string, string>): Promise<GoogleOAuthTokens> {
    return this.request(TOKEN_ENDPOINT, new URLSearchParams({ ...fields, client_id: this.options.clientId, client_secret: this.options.clientSecret }).toString(), async response => {
      if (!response.ok) { await response.body?.cancel(); throw new GoogleOAuthError('HTTP', response.status); }
      const parsed = tokenResponseSchema.safeParse(await readBounded(response, this.maxResponseBytes));
      if (!parsed.success || parsed.data.scope !== undefined && parsed.data.scope.split(/\s+/u).filter(Boolean).some(scope => scope !== GOOGLE_DOCS_FILE_SCOPE)
        || parsed.data.scope !== undefined && !parsed.data.scope.split(/\s+/u).filter(Boolean).includes(GOOGLE_DOCS_FILE_SCOPE)) {
        throw new GoogleOAuthError('INVALID_RESPONSE', response.status);
      }
      return parsed.data;
    });
  }

  private async request<T>(url: string, body: string, consume: (response: Response) => Promise<T>): Promise<T> {
    const controller = new AbortController();
    let timedOut = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => { timedOut = true; controller.abort(); reject(new GoogleOAuthError('TIMEOUT')); }, this.timeoutMs);
    });
    try {
      const work = (async () => {
        const response = await this.fetchImpl(url, { method: 'POST', redirect: 'error', signal: controller.signal,
          headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' }, body });
        return consume(response);
      })();
      return await Promise.race([work, timeout]);
    } catch (error) {
      if (error instanceof GoogleOAuthError && !timedOut) throw error;
      throw new GoogleOAuthError(timedOut ? 'TIMEOUT' : 'TRANSPORT');
    } finally { clearTimeout(timer); }
  }
}
