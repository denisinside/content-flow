import { createClient, type Session, type User } from '@supabase/supabase-js';
import type { AuthConfig } from './auth-config.js';
import type { ProviderTokens } from './session-crypto.js';

export class ProviderFailure extends Error {
  constructor(readonly unavailable: boolean) { super('Authentication provider request failed'); }
}
export interface VerifiedIdentity { id: string; email: string; displayName: string | null; sessionId: string | null; expiresAt: Date }
export interface ProviderSession { tokens: ProviderTokens; identity: VerifiedIdentity }

export class AuthProvider {
  constructor(private readonly config: AuthConfig) {}

  private client() {
    const signal = AbortSignal.timeout(this.config.providerTimeoutMs);
    return createClient(this.config.providerUrl, this.config.publishableKey, {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false, flowType: 'pkce' },
      global: { fetch: async (url, init) => {
        try { return await fetch(url, { ...init, signal }); }
        catch { throw new Error('Authentication provider unavailable'); }
      } }
    });
  }

  private async bounded<T>(work: (client: ReturnType<AuthProvider['client']>) => Promise<T>): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([work(this.client()), new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new ProviderFailure(true)), this.config.providerTimeoutMs + 50);
      })]);
    } finally { if (timer) clearTimeout(timer); }
  }

  private fail(error: { status?: number | undefined; name?: string | undefined } | null): never {
    throw new ProviderFailure(!error || !error.status || error.status >= 500 || error.status === 429);
  }

  private identity(accessToken: string, user: User): VerifiedIdentity {
    // getUser has already authenticated this JWT with the provider. These checks
    // constrain the verified identity to our issuer/audience; decoding alone is never trusted.
    try {
      const claims: unknown = JSON.parse(Buffer.from(accessToken.split('.')[1] ?? '', 'base64url').toString('utf8'));
      if (!claims || typeof claims !== 'object' || !('sub' in claims) || !('iss' in claims) || !('aud' in claims) || !('exp' in claims)) throw new Error();
      if (claims.sub !== user.id || claims.iss !== this.config.providerUrl + '/auth/v1'
        || !(claims.aud === 'authenticated' || (Array.isArray(claims.aud) && claims.aud.includes('authenticated')))
        || typeof claims.exp !== 'number' || claims.exp * 1000 <= Date.now() || !user.email) throw new Error();
      const sessionId = 'session_id' in claims && typeof claims.session_id === 'string' && /^[0-9a-f-]{36}$/i.test(claims.session_id) ? claims.session_id : null;
      const rawName: unknown = user.user_metadata['display_name'];
      const displayName = typeof rawName === 'string' && rawName.trim().length <= 80 ? rawName.trim() || null : null;
      return { id: user.id, email: user.email, displayName, sessionId, expiresAt: new Date(claims.exp * 1000) };
    } catch { throw new ProviderFailure(false); }
  }

  async verify(tokens: ProviderTokens): Promise<VerifiedIdentity> {
    try {
      return await this.bounded(async client => {
        const { data, error } = await client.auth.getUser(tokens.accessToken);
        if (error || !data.user) this.fail(error);
        return this.identity(tokens.accessToken, data.user);
      });
    } catch (error) { if (error instanceof ProviderFailure) throw error; throw new ProviderFailure(true); }
  }

  private async verifiedSession(session: Session, client: ReturnType<AuthProvider['client']>): Promise<ProviderSession> {
    const tokens = { accessToken: session.access_token, refreshToken: session.refresh_token };
    const { data, error } = await client.auth.getUser(tokens.accessToken);
    if (error || !data.user) this.fail(error);
    return { tokens, identity: this.identity(tokens.accessToken, data.user) };
  }

  async login(email: string, password: string): Promise<ProviderSession> {
    try {
      return await this.bounded(async client => {
        const { data, error } = await client.auth.signInWithPassword({ email, password });
        if (error || !data.session) this.fail(error);
        return this.verifiedSession(data.session, client);
      });
    } catch (error) { if (error instanceof ProviderFailure) throw error; throw new ProviderFailure(true); }
  }

  async register(email: string, password: string, displayName?: string): Promise<ProviderSession | null> {
    try {
      return await this.bounded(async client => {
      const { data, error } = await client.auth.signUp({ email, password, options: {
        emailRedirectTo: this.config.webOrigin, data: { display_name: displayName ?? null }
      } });
      if (error) {
        if (error.code === 'user_already_exists' || error.code === 'email_exists') return null;
        if (error.status === 401 || error.status === 403 || error.code === 'signup_disabled'
          || error.code === 'captcha_failed') throw new ProviderFailure(true);
        this.fail(error);
      }
      return data.session ? await this.verifiedSession(data.session, client) : null;
      });
    } catch (error) { if (error instanceof ProviderFailure) throw error; throw new ProviderFailure(true); }
  }

  async refresh(tokens: ProviderTokens): Promise<ProviderSession> {
    try {
      return await this.bounded(async client => {
        const { data, error } = await client.auth.refreshSession({ refresh_token: tokens.refreshToken });
        if (error || !data.session) this.fail(error);
        return this.verifiedSession(data.session, client);
      });
    } catch (error) { if (error instanceof ProviderFailure) throw error; throw new ProviderFailure(true); }
  }

  async logout(tokens: ProviderTokens): Promise<void> {
    // Explicit bearer JWT and local scope; no shared mutable SDK session.
    await this.bounded(async client => {
      const { error } = await client.auth.admin.signOut(tokens.accessToken, 'local');
      if (error) this.fail(error);
    });
  }
}
