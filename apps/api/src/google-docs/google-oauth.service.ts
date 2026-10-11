import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { BadRequestException, ForbiddenException, HttpException, Inject, Injectable, ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';
import type { DependencyHealthService, GoogleDocsClient, Prisma, StoredGoogleOAuthTokens } from '@contextflow/backend';
import { GOOGLE_DOCS_FILE_SCOPE, GoogleOAuthError, GoogleDocsApiError, GoogleDocsClient as GoogleDocsApiClient } from '@contextflow/backend';
import { z } from 'zod';
import { setTimeout as delay } from 'node:timers/promises';
import { tokenDigest, validOpaqueToken } from '../auth/session-crypto.js';
import { SESSION_COOKIE, cookieValue } from '../auth/csrf.js';
import { SessionService } from '../auth/session-service.js';
import { EXTERNAL_PROCESSING_NOTICE, ExternalProcessingService } from '../auth/external-processing.js';
import type { AuthenticatedRequest } from '../auth/session.guard.js';
import type { GoogleOAuthRuntime } from './google-oauth.config.js';

const GOOGLE_ABOUT = 'https://www.googleapis.com/drive/v3/about?fields=user(permissionId,displayName)';
const attemptLifetimeMs = 10 * 60_000;
const opaqueState = z.string().regex(/^[A-Za-z0-9_-]{43}$/u);
const callbackQuery = z.object({
  state: z.string().min(32).max(256), code: z.string().min(1).max(8192).optional(),
  error: z.string().max(128).optional(), scope: z.string().max(4096).optional(),
  authuser: z.string().max(32).optional(), prompt: z.string().max(64).optional(), iss: z.literal('https://accounts.google.com').optional(),
}).strict().refine(value => Boolean(value.code) !== Boolean(value.error), 'Invalid Google OAuth callback');
const aboutSchema = z.object({ user: z.object({ permissionId: z.string().min(1).max(128), displayName: z.string().max(200).optional() }).strict() }).strict();
type Binding = { cookie: string; sessionId: string; userId: string };
type LockAttempt = { kind: 'locked' } | { kind: 'busy' };
type ConnectionView = { id: string; googlePermissionId: string; displayName: string | null; grantedScope: string; accessExpiresAt: string; refreshExpiresAt: string | null; generation: number; connectedAt: string; updatedAt: string; revokedAt: string | null; status: 'connected' | 'disconnected' | 'needs_connection'; providerAccess: 'authorized' | 'verify_in_google_account' | 'reauthorize' };

function digestState(state: string): string { return createHash('sha256').update(state, 'ascii').digest('hex'); }
function safeConnection(row: { id: string; googlePermissionId: string; displayName: string | null; grantedScope: string; accessExpiresAt: Date; refreshExpiresAt: Date | null; generation: number; connectedAt: Date; updatedAt: Date; revokedAt: Date | null }): ConnectionView {
  const expiredGrant = row.refreshExpiresAt !== null && row.refreshExpiresAt.getTime() <= Date.now();
  return { id: row.id, googlePermissionId: row.googlePermissionId, displayName: row.displayName, grantedScope: row.grantedScope,
    accessExpiresAt: row.accessExpiresAt.toISOString(), refreshExpiresAt: row.refreshExpiresAt?.toISOString() ?? null,
    generation: row.generation, connectedAt: row.connectedAt.toISOString(), updatedAt: row.updatedAt.toISOString(),
    revokedAt: row.revokedAt?.toISOString() ?? null, status: row.revokedAt ? 'disconnected' : expiredGrant ? 'needs_connection' : 'connected',
    providerAccess: row.revokedAt ? 'verify_in_google_account' : expiredGrant ? 'reauthorize' : 'authorized' };
}

@Injectable()
export class GoogleOAuthService {
  constructor(private readonly health: DependencyHealthService, private readonly sessions: SessionService,
    private readonly processing: ExternalProcessingService, @Inject('GOOGLE_OAUTH_RUNTIME') private readonly runtime: GoogleOAuthRuntime) {}

  private available(): Extract<GoogleOAuthRuntime, { kind: 'configured' }> {
    if (this.runtime.kind !== 'configured') throw new ServiceUnavailableException('Google Docs connection is not configured');
    return this.runtime;
  }

  private async binding(request: AuthenticatedRequest): Promise<Binding> {
    const cookie = cookieValue(request, SESSION_COOKIE);
    if (!validOpaqueToken(cookie)) throw new UnauthorizedException('Session expired');
    const verified = await this.sessions.check(cookie);
    if (verified.kind === 'unavailable') throw new ServiceUnavailableException('Authentication temporarily unavailable');
    if (verified.kind !== 'active' || verified.user.id !== request.sessionUser.id) throw new UnauthorizedException('Session expired');
    const row = await this.health.prisma.appSession.findUnique({ where: { cookieDigest: tokenDigest(cookie) }, select: { id: true, userId: true, revokedAt: true, expiresAt: true } });
    if (!row || row.revokedAt || row.userId !== verified.user.id || row.userId !== request.sessionUser.id || Date.now() >= row.expiresAt.getTime()) {
      throw new UnauthorizedException('Session expired');
    }
    return { cookie, sessionId: row.id, userId: row.userId };
  }

  private async assertBinding(binding: Binding): Promise<void> {
    const verified = await this.sessions.check(binding.cookie);
    if (verified.kind === 'unavailable') throw new ServiceUnavailableException('Authentication temporarily unavailable');
    if (verified.kind !== 'active' || verified.user.id !== binding.userId) throw new UnauthorizedException('Session expired');
    const row = await this.health.prisma.appSession.findUnique({ where: { cookieDigest: tokenDigest(binding.cookie) }, select: { id: true, userId: true, revokedAt: true, expiresAt: true } });
    if (!row || row.id !== binding.sessionId || row.userId !== binding.userId || row.revokedAt || Date.now() >= row.expiresAt.getTime()) {
      throw new UnauthorizedException('Session expired');
    }
  }

  private async lockBinding(tx: Prisma.TransactionClient, binding: Binding, acceptedAt?: Date, lockProfile = false, requireNotice = true): Promise<Date | null> {
    const sessions = await tx.$queryRaw<Array<{ id: string; expiresAt: Date; lastUserActivityAt: Date }>>`
      SELECT "id", "expiresAt", "lastUserActivityAt" FROM contextflow."AppSession"
      WHERE "id" = ${binding.sessionId}::uuid AND "userId" = ${binding.userId}::uuid AND "revokedAt" IS NULL FOR UPDATE`;
    const profiles = lockProfile
      ? await tx.$queryRaw<Array<{ idleTimeoutMinutes: number; externalProcessingNoticeVersion: string | null; externalProcessingAcceptedAt: Date | null }>>`
        SELECT "idleTimeoutMinutes", "externalProcessingNoticeVersion", "externalProcessingAcceptedAt" FROM contextflow."UserProfile" WHERE "id" = ${binding.userId}::uuid FOR UPDATE`
      : await tx.$queryRaw<Array<{ idleTimeoutMinutes: number; externalProcessingNoticeVersion: string | null; externalProcessingAcceptedAt: Date | null }>>`
        SELECT "idleTimeoutMinutes", "externalProcessingNoticeVersion", "externalProcessingAcceptedAt" FROM contextflow."UserProfile" WHERE "id" = ${binding.userId}::uuid FOR SHARE`;
    const now = new Date();
    if (!sessions[0] || now >= sessions[0].expiresAt || now.getTime() - sessions[0].lastUserActivityAt.getTime() >= (profiles[0]?.idleTimeoutMinutes ?? 0) * 60_000) {
      throw new UnauthorizedException('Session expired');
    }
    const profile = profiles[0];
    if (!profile) throw new UnauthorizedException('Session expired');
    if (requireNotice && (profile.externalProcessingNoticeVersion !== EXTERNAL_PROCESSING_NOTICE.version || !profile.externalProcessingAcceptedAt)) {
      throw new ForbiddenException('Accept the external-processing notice before connecting Google Docs');
    }
    if (acceptedAt && profile.externalProcessingAcceptedAt?.getTime() !== acceptedAt.getTime()) {
      throw new ForbiddenException('External-processing acceptance changed during Google authorization');
    }
    return profile.externalProcessingAcceptedAt;
  }

  /** Refresh waiters never block on session/profile row locks past the DB's short statement timeout. */
  private async tryLockBinding(tx: Prisma.TransactionClient, binding: Binding, acceptedAt?: Date,
    requireNotice = true, lockProfile = false): Promise<LockAttempt> {
    const sessions = await tx.$queryRaw<Array<{ id: string; expiresAt: Date; lastUserActivityAt: Date }>>`
      SELECT "id", "expiresAt", "lastUserActivityAt" FROM contextflow."AppSession"
      WHERE "id" = ${binding.sessionId}::uuid AND "userId" = ${binding.userId}::uuid AND "revokedAt" IS NULL
      FOR UPDATE SKIP LOCKED`;
    if (!sessions.length) {
      const exists = await tx.appSession.findFirst({ where: { id: binding.sessionId, userId: binding.userId },
        select: { id: true, revokedAt: true, expiresAt: true } });
      if (!exists || exists.revokedAt || Date.now() >= exists.expiresAt.getTime()) throw new UnauthorizedException('Session expired');
      return { kind: 'busy' };
    }
    const profiles = lockProfile
      ? await tx.$queryRaw<Array<{ idleTimeoutMinutes: number; externalProcessingNoticeVersion: string | null; externalProcessingAcceptedAt: Date | null }>>`
        SELECT "idleTimeoutMinutes", "externalProcessingNoticeVersion", "externalProcessingAcceptedAt"
        FROM contextflow."UserProfile" WHERE "id" = ${binding.userId}::uuid FOR UPDATE SKIP LOCKED`
      : await tx.$queryRaw<Array<{ idleTimeoutMinutes: number; externalProcessingNoticeVersion: string | null; externalProcessingAcceptedAt: Date | null }>>`
        SELECT "idleTimeoutMinutes", "externalProcessingNoticeVersion", "externalProcessingAcceptedAt"
        FROM contextflow."UserProfile" WHERE "id" = ${binding.userId}::uuid FOR SHARE SKIP LOCKED`;
    if (!profiles.length) {
      if (!await tx.userProfile.findUnique({ where: { id: binding.userId }, select: { id: true } })) throw new UnauthorizedException('Session expired');
      return { kind: 'busy' };
    }
    const now = Date.now(), session = sessions[0]!, profile = profiles[0]!;
    if (now >= session.expiresAt.getTime() || now - session.lastUserActivityAt.getTime() >= profile.idleTimeoutMinutes * 60_000) {
      throw new UnauthorizedException('Session expired');
    }
    if (requireNotice && (profile.externalProcessingNoticeVersion !== EXTERNAL_PROCESSING_NOTICE.version || !profile.externalProcessingAcceptedAt)) {
      throw new ForbiddenException('Accept the external-processing notice before using Google Docs');
    }
    if (acceptedAt && profile.externalProcessingAcceptedAt?.getTime() !== acceptedAt.getTime()) {
      throw new ForbiddenException('External-processing acceptance changed during Google Docs authorization');
    }
    return { kind: 'locked' };
  }

  private async bindingExpired(tx: Prisma.TransactionClient, binding: Binding): Promise<boolean> {
    const rows = await tx.$queryRaw<Array<{ expiresAt: Date; lastUserActivityAt: Date; idleTimeoutMinutes: number }>>`
      SELECT s."expiresAt", s."lastUserActivityAt", u."idleTimeoutMinutes"
      FROM contextflow."AppSession" s JOIN contextflow."UserProfile" u ON u."id" = s."userId"
      WHERE s."id" = ${binding.sessionId}::uuid AND s."userId" = ${binding.userId}::uuid AND s."revokedAt" IS NULL`;
    const row = rows[0];
    return !row || Date.now() >= row.expiresAt.getTime() || Date.now() - row.lastUserActivityAt.getTime() >= row.idleTimeoutMinutes * 60_000;
  }

  async start(request: AuthenticatedRequest): Promise<{ authorizationUrl: string; expiresAt: string }> {
    const { client, crypto } = this.available();
    await this.processing.requireAccepted(request.sessionUser.id);
    const binding = await this.binding(request);
    const id = randomUUID();
    const state = randomBytes(32).toString('base64url');
    const verifier = randomBytes(32).toString('base64url');
    const encrypted = crypto.encryptVerifier(verifier, binding.userId, id);
    const expiresAt = await this.health.prisma.$transaction(async tx => {
      await this.lockBinding(tx, binding);
      const now = new Date();
      const expiresAt = new Date(now.getTime() + attemptLifetimeMs);
      await tx.googleOAuthAttempt.create({ data: { id, userId: binding.userId, appSessionId: binding.sessionId,
        stateDigest: digestState(state), encryptedVerifier: encrypted.ciphertext, tokenKeyVersion: encrypted.keyVersion, createdAt: now, expiresAt } });
      return expiresAt;
    });
    return { authorizationUrl: client.authorizationUrl(state, verifier), expiresAt: expiresAt.toISOString() };
  }

  private async consumeAttempt(state: string, binding: Binding, crypto: Extract<GoogleOAuthRuntime, { kind: 'configured' }>['crypto']): Promise<string> {
    const stateHash = digestState(state);
    return this.health.prisma.$transaction(async tx => {
      await this.lockBinding(tx, binding);
      const rows = await tx.$queryRaw<Array<{ id: string; userId: string; appSessionId: string; encryptedVerifier: string | null; tokenKeyVersion: number; expiresAt: Date; consumedAt: Date | null }>>`
        SELECT "id", "userId", "appSessionId", "encryptedVerifier", "tokenKeyVersion", "expiresAt", "consumedAt"
        FROM contextflow."GoogleOAuthAttempt" WHERE "stateDigest" = ${stateHash} FOR UPDATE`;
      const attempt = rows[0];
      if (!attempt || attempt.userId !== binding.userId || attempt.appSessionId !== binding.sessionId || attempt.consumedAt
        || !attempt.encryptedVerifier || Date.now() >= attempt.expiresAt.getTime()) throw new BadRequestException('Google OAuth attempt is invalid or expired');
      const verifier = crypto.decryptVerifier({ ciphertext: attempt.encryptedVerifier, keyVersion: attempt.tokenKeyVersion }, binding.userId, attempt.id);
      await tx.googleOAuthAttempt.update({ where: { id: attempt.id }, data: { consumedAt: new Date(), encryptedVerifier: null } });
      return verifier;
    }, { timeout: 10_000, maxWait: 5_000 });
  }

  private async googleAbout(accessToken: string): Promise<{ permissionId: string; displayName: string | null }> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10_000);
    try {
      const response = await fetch(GOOGLE_ABOUT, { method: 'GET', redirect: 'error', signal: controller.signal,
        headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' } });
      if (!response.ok) { await response.body?.cancel(); throw new ServiceUnavailableException('Google account verification failed'); }
      const reader = response.body?.getReader();
      if (!reader) throw new ServiceUnavailableException('Google account verification failed');
      const chunks: Uint8Array[] = []; let bytes = 0;
      try {
        while (true) {
          const result = await reader.read(); if (result.done) break;
          bytes += result.value.byteLength;
          if (bytes > 16_384) { await reader.cancel(); throw new ServiceUnavailableException('Google account verification failed'); }
          chunks.push(result.value);
        }
      } finally { reader.releaseLock(); }
      let payload: unknown;
      try { payload = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks.map(chunk => Buffer.from(chunk))))) as unknown; }
      catch { throw new ServiceUnavailableException('Google account verification failed'); }
      const parsed = aboutSchema.safeParse(payload);
      if (!parsed.success) throw new ServiceUnavailableException('Google account verification failed');
      return { permissionId: parsed.data.user.permissionId, displayName: parsed.data.user.displayName ?? null };
    } catch (error) {
      if (error instanceof ServiceUnavailableException) throw error;
      throw new ServiceUnavailableException('Google account verification failed');
    } finally { clearTimeout(timer); }
  }

  async callback(request: AuthenticatedRequest, rawQuery: unknown): Promise<{ connected: true; connection: ConnectionView }> {
    const parsed = callbackQuery.safeParse(rawQuery);
    if (!parsed.success || !opaqueState.safeParse(parsed.data?.state).success) throw new BadRequestException('Invalid Google OAuth callback');
    const config = this.available();
    const notice = await this.processing.status(request.sessionUser.id);
    if (!notice.accepted || !notice.acceptedAt) throw new ForbiddenException('Accept the external-processing notice before connecting Google Docs');
    const acceptedAt = new Date(notice.acceptedAt);
    const binding = await this.binding(request);
    const verifier = await this.consumeAttempt(parsed.data.state, binding, config.crypto);
    if (parsed.data.error || !parsed.data.code) throw new BadRequestException('Google authorization was not completed');
    if (parsed.data.scope) {
      const granted = parsed.data.scope.split(/\s+/u).filter(Boolean);
      if (granted.length !== 1 || granted[0] !== GOOGLE_DOCS_FILE_SCOPE) throw new ForbiddenException('Google granted an unexpected permission');
    }
    let tokens;
    try { tokens = await config.client.exchangeAuthorizationCode(parsed.data.code, verifier); }
    catch (error) {
      if (error instanceof GoogleOAuthError) throw new BadRequestException('Google authorization could not be completed');
      throw new ServiceUnavailableException('Google authorization is temporarily unavailable');
    }
    const account = await this.googleAbout(tokens.access_token);
    await this.assertBinding(binding);
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      const saved = await this.health.prisma.$transaction(async tx => {
        if ((await this.tryLockBinding(tx, binding, acceptedAt, true, true)).kind === 'busy') return { kind: 'busy' } as const;
        await this.lockBinding(tx, binding, acceptedAt, true);
        const rows = await tx.$queryRaw<Array<{ id: string }>>`
          SELECT "id" FROM contextflow."GoogleDriveConnection" WHERE "userId" = ${binding.userId}::uuid
          AND "googlePermissionId" = ${account.permissionId} FOR UPDATE SKIP LOCKED`;
        if (!rows.length && await tx.googleDriveConnection.findUnique({ where: { userId_googlePermissionId: { userId: binding.userId, googlePermissionId: account.permissionId } }, select: { id: true } })) {
          return { kind: 'busy' } as const;
        }
        await this.lockBinding(tx, binding, acceptedAt, true);
        const now = new Date();
        const existing = await tx.googleDriveConnection.findUnique({ where: { userId_googlePermissionId: { userId: binding.userId, googlePermissionId: account.permissionId } } });
        let refreshToken = tokens.refresh_token;
        let previousRefreshToken: string | undefined;
        if (!refreshToken && existing?.encryptedTokens && !existing.revokedAt
          && (!existing.refreshExpiresAt || existing.refreshExpiresAt > now)) {
          const old = config.crypto.decryptTokens({ ciphertext: existing.encryptedTokens, keyVersion: existing.tokenKeyVersion }, binding.userId, existing.id);
          previousRefreshToken = old.refreshToken;
          refreshToken = old.refreshToken;
        }
        if (!refreshToken) throw new BadRequestException('Google did not return an offline connection token; restart the connection');
        const id = existing?.id ?? randomUUID();
        const expiresAtMs = now.getTime() + tokens.expires_in * 1000;
        const stored: StoredGoogleOAuthTokens = { accessToken: tokens.access_token, refreshToken, expiresAtMs };
        const encrypted = config.crypto.encryptTokens(stored, binding.userId, id);
        const data = { displayName: account.displayName, encryptedTokens: encrypted.ciphertext, tokenKeyVersion: encrypted.keyVersion,
          accessExpiresAt: new Date(expiresAtMs), refreshExpiresAt: tokens.refresh_token_expires_in ? new Date(now.getTime() + tokens.refresh_token_expires_in * 1000)
            : refreshToken === previousRefreshToken ? existing?.refreshExpiresAt ?? null : null,
          updatedAt: now, revokedAt: null, generation: { increment: 1 } };
        const row = existing
          ? await tx.googleDriveConnection.update({ where: { id: existing.id }, data })
          : await tx.googleDriveConnection.create({ data: { id, userId: binding.userId, googlePermissionId: account.permissionId, grantedScope: GOOGLE_DOCS_FILE_SCOPE,
            connectedAt: now, ...data, generation: 1 } });
        return { kind: 'saved', value: { connected: true as const, connection: safeConnection(row) } } as const;
      }, { timeout: 15_000, maxWait: 3_000 });
      if (saved.kind === 'saved') return saved.value;
      await delay(25);
    }
    throw new ServiceUnavailableException('Google Docs connection is busy; retry shortly');
  }

  async list(request: AuthenticatedRequest): Promise<{ connections: ConnectionView[] }> {
    const binding = await this.binding(request);
    const rows = await this.health.prisma.googleDriveConnection.findMany({ where: { userId: binding.userId }, orderBy: { connectedAt: 'desc' },
      select: { id: true, googlePermissionId: true, displayName: true, grantedScope: true, accessExpiresAt: true, refreshExpiresAt: true,
        generation: true, connectedAt: true, updatedAt: true, revokedAt: true } });
    return { connections: rows.map(safeConnection) };
  }

  /** Server-only Google Docs facade. OAuth credentials stay inside the token supplier and never enter an API DTO. */
  async withOwnGoogleDocsClient<T>(request: AuthenticatedRequest, rawConnectionId: unknown,
    operation: (client: GoogleDocsClient) => Promise<T>): Promise<T> {
    const config = this.available();
    const parsed = z.uuid().safeParse(rawConnectionId);
    if (!parsed.success) throw new BadRequestException('Invalid Google connection');
    const binding = await this.binding(request);
    const notice = await this.processing.status(binding.userId);
    if (!notice.accepted || !notice.acceptedAt) throw new ForbiddenException('Accept the external-processing notice before using Google Docs');
    const acceptedAt = new Date(notice.acceptedAt);
    let usedGeneration: number | null = null;
    let tokenProviderFailure: HttpException | null = null;
    let closed = false;
    const getAccessToken = async (): Promise<string> => {
      if (closed) {
        tokenProviderFailure = new UnauthorizedException('Google Docs operation has ended');
        throw tokenProviderFailure;
      }
      let token: { accessToken: string; generation: number };
      try { token = await this.acquireOwnAccessToken(binding, parsed.data, acceptedAt, config.crypto, config.client); }
      catch (error) {
        const safeError = error instanceof HttpException ? error : new ServiceUnavailableException('Google Docs authorization is temporarily unavailable');
        tokenProviderFailure = safeError;
        throw safeError;
      }
      if (closed) {
        tokenProviderFailure ??= new UnauthorizedException('Google Docs operation has ended');
        throw tokenProviderFailure;
      }
      if (usedGeneration !== null && usedGeneration !== token.generation) {
        tokenProviderFailure ??= new UnauthorizedException('Google Docs connection changed during operation');
        throw tokenProviderFailure;
      }
      usedGeneration = token.generation;
      return token.accessToken;
    };
    const client = new GoogleDocsApiClient({ getAccessToken });
    let result: T;
    try { result = await operation(client); }
    catch (error) {
      if (tokenProviderFailure) throw tokenProviderFailure;
      if (usedGeneration !== null && error instanceof GoogleDocsApiError && error.kind === 'unauthenticated' && error.status === 401) {
        await this.markConnectionNeedsReauthorization(binding, parsed.data, acceptedAt, usedGeneration);
      }
      throw error;
    } finally { closed = true; }
    if (tokenProviderFailure) throw tokenProviderFailure;
    if (usedGeneration === null) throw new BadRequestException('Google Docs operation did not use the connected account');
    await this.assertOperationFence(binding, parsed.data, acceptedAt, usedGeneration);
    return result;
  }

  /** A provider 401 invalidates future use of this grant, but keeps ciphertext for explicit disconnect/revocation. */
  private async markConnectionNeedsReauthorization(binding: Binding, connectionId: string, acceptedAt: Date, generation: number): Promise<void> {
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      const result = await this.health.prisma.$transaction(async tx => {
        if ((await this.tryLockBinding(tx, binding, acceptedAt)).kind === 'busy') return 'busy' as const;
        await this.lockBinding(tx, binding, acceptedAt);
        const rows = await tx.$queryRaw<Array<{ generation: number; encryptedTokens: string | null; revokedAt: Date | null; grantedScope: string }>>`
          SELECT "generation", "encryptedTokens", "revokedAt", "grantedScope" FROM contextflow."GoogleDriveConnection"
          WHERE "id" = ${connectionId}::uuid AND "userId" = ${binding.userId}::uuid FOR UPDATE SKIP LOCKED`;
        if (!rows.length) {
          return await tx.googleDriveConnection.findFirst({ where: { id: connectionId, userId: binding.userId }, select: { id: true } })
            ? 'busy' as const : 'done' as const;
        }
        const row = rows[0]!;
        if (row.generation !== generation || row.revokedAt || !row.encryptedTokens || row.grantedScope !== GOOGLE_DOCS_FILE_SCOPE) return 'done' as const;
        const at = new Date();
        await tx.googleDriveConnection.update({ where: { id: connectionId }, data: {
          refreshExpiresAt: at, updatedAt: at, generation: { increment: 1 },
        } });
        return 'done' as const;
      }, { timeout: 15_000, maxWait: 3_000 });
      if (result === 'done') return;
      await delay(25);
    }
    throw new ServiceUnavailableException('Google Docs connection is busy; retry shortly');
  }

  private async acquireOwnAccessToken(binding: Binding, connectionId: string, acceptedAt: Date,
    crypto: Extract<GoogleOAuthRuntime, { kind: 'configured' }>['crypto'],
    client: Extract<GoogleOAuthRuntime, { kind: 'configured' }>['client']): Promise<{ accessToken: string; generation: number }> {
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      const result = await this.health.prisma.$transaction(async tx => {
        const bindingLock = await this.tryLockBinding(tx, binding, acceptedAt);
        if (bindingLock.kind === 'busy') return { kind: 'busy' } as const;
        await this.lockBinding(tx, binding, acceptedAt);
        const rows = await tx.$queryRaw<Array<{ id: string }>>`
          SELECT "id" FROM contextflow."GoogleDriveConnection"
          WHERE "id" = ${connectionId}::uuid AND "userId" = ${binding.userId}::uuid FOR UPDATE SKIP LOCKED`;
        if (!rows.length) {
          const exists = await tx.googleDriveConnection.findFirst({ where: { id: connectionId, userId: binding.userId }, select: { id: true } });
          return exists ? { kind: 'busy' } as const : { kind: 'missing' } as const;
        }
        // Re-read after the row lock. A reconnect or disconnect that won the lock first
        // must be visible before deciding whether this connection may provide a token.
        const row = await tx.googleDriveConnection.findFirst({ where: { id: connectionId, userId: binding.userId } });
        if (!row) return { kind: 'missing' } as const;
        if (row.revokedAt || !row.encryptedTokens || row.grantedScope !== GOOGLE_DOCS_FILE_SCOPE) return { kind: 'missing' } as const;
        const now = new Date();
        if (row.refreshExpiresAt && row.refreshExpiresAt.getTime() <= now.getTime()) return { kind: 'reauthorize' } as const;
        let stored: StoredGoogleOAuthTokens;
        try { stored = crypto.decryptTokens({ ciphertext: row.encryptedTokens, keyVersion: row.tokenKeyVersion }, binding.userId, row.id); }
        catch { return { kind: 'unavailable' } as const; }
        if (Math.abs(row.accessExpiresAt.getTime() - stored.expiresAtMs) > 1000) return { kind: 'unavailable' } as const;
        if (stored.expiresAtMs > now.getTime() + 60_000) {
          if (row.tokenKeyVersion === crypto.keyVersion) return { kind: 'ready', accessToken: stored.accessToken, generation: row.generation } as const;
          const encrypted = crypto.encryptTokens(stored, binding.userId, row.id);
          const updated = await tx.googleDriveConnection.update({ where: { id: row.id }, data: {
            encryptedTokens: encrypted.ciphertext, tokenKeyVersion: encrypted.keyVersion, updatedAt: new Date(), generation: { increment: 1 },
          } });
          await this.lockBinding(tx, binding, acceptedAt);
          return { kind: 'ready', accessToken: stored.accessToken, generation: updated.generation } as const;
        }
        let refreshed;
        try { refreshed = await client.refreshAccessToken(stored.refreshToken); }
        catch (error) {
          if (error instanceof GoogleOAuthError && (error.status === 400 || error.status === 401
            || ['TIMEOUT', 'TRANSPORT', 'INVALID_RESPONSE'].includes(error.kind))) {
            const at = new Date();
            await tx.googleDriveConnection.update({ where: { id: row.id }, data: { refreshExpiresAt: at, updatedAt: at, generation: { increment: 1 } } });
            return await this.bindingExpired(tx, binding) ? { kind: 'session-expired' } as const : { kind: 'reauthorize' } as const;
          }
          // Known temporary HTTP failures keep the last ciphertext/generation;
          // the caller may retry later without rotating the stored grant.
          throw new ServiceUnavailableException('Google Docs authorization is temporarily unavailable');
        }
        const refreshToken = refreshed.refresh_token ?? stored.refreshToken;
        const expiresAtMs = Date.now() + refreshed.expires_in * 1000;
        if (await this.bindingExpired(tx, binding)) {
          const at = new Date();
          await tx.googleDriveConnection.update({ where: { id: row.id }, data: { refreshExpiresAt: at, updatedAt: at, generation: { increment: 1 } } });
          return { kind: 'session-expired' } as const;
        }
        const next: StoredGoogleOAuthTokens = { accessToken: refreshed.access_token, refreshToken, expiresAtMs };
        const encrypted = crypto.encryptTokens(next, binding.userId, row.id);
        const refreshExpiresAt = refreshed.refresh_token_expires_in !== undefined
          ? new Date(Date.now() + refreshed.refresh_token_expires_in * 1000)
          : refreshed.refresh_token === undefined ? row.refreshExpiresAt : null;
        const updatedAt = new Date();
        const updated = await tx.googleDriveConnection.update({ where: { id: row.id }, data: {
          encryptedTokens: encrypted.ciphertext, tokenKeyVersion: encrypted.keyVersion, accessExpiresAt: new Date(expiresAtMs),
          refreshExpiresAt, updatedAt, generation: { increment: 1 },
        } });
        return { kind: 'ready', accessToken: next.accessToken, generation: updated.generation } as const;
      }, { timeout: 15_000, maxWait: 3_000 });
      if (result.kind === 'ready') return { accessToken: result.accessToken, generation: result.generation };
      if (result.kind === 'missing') throw new ForbiddenException('Google connection is unavailable; reconnect the account');
      if (result.kind === 'reauthorize') throw new ForbiddenException('Google authorization expired; reconnect the account');
      if (result.kind === 'unavailable') throw new ServiceUnavailableException('Google Docs authorization is unavailable');
      if (result.kind === 'session-expired') throw new UnauthorizedException('Session expired');
      await delay(25);
    }
    throw new ServiceUnavailableException('Google Docs connection is busy; retry shortly');
  }

  private async assertOperationFence(binding: Binding, connectionId: string, acceptedAt: Date, generation: number): Promise<void> {
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      const result = await this.health.prisma.$transaction(async tx => {
        const bindingLock = await this.tryLockBinding(tx, binding, acceptedAt);
        if (bindingLock.kind === 'busy') return 'busy' as const;
        const rows = await tx.$queryRaw<Array<{ generation: number; revokedAt: Date | null; encryptedTokens: string | null; grantedScope: string; refreshExpiresAt: Date | null }>>`
          SELECT "generation", "revokedAt", "encryptedTokens", "grantedScope", "refreshExpiresAt" FROM contextflow."GoogleDriveConnection"
          WHERE "id" = ${connectionId}::uuid AND "userId" = ${binding.userId}::uuid FOR SHARE SKIP LOCKED`;
        if (!rows.length) {
          const exists = await tx.googleDriveConnection.findFirst({ where: { id: connectionId, userId: binding.userId }, select: { id: true } });
          return exists ? 'busy' as const : 'invalid' as const;
        }
        const row = rows[0]!;
        return !row.revokedAt && row.encryptedTokens && row.grantedScope === GOOGLE_DOCS_FILE_SCOPE && row.generation === generation
          && (!row.refreshExpiresAt || row.refreshExpiresAt.getTime() > Date.now())
          ? 'valid' as const : 'invalid' as const;
      }, { timeout: 10_000, maxWait: 3_000 });
      if (result === 'valid') return;
      if (result === 'invalid') throw new GoogleDocsApiError('unauthenticated');
      await delay(25);
    }
    throw new ServiceUnavailableException('Google Docs connection is busy; retry shortly');
  }

  async disconnect(request: AuthenticatedRequest, rawId: unknown): Promise<{ connection: ConnectionView; providerRevocation: 'confirmed' | 'pending' }> {
    const runtime = this.runtime.kind === 'configured' ? this.runtime : null;
    const parsedId = z.uuid().safeParse(rawId);
    if (!parsedId.success) throw new BadRequestException('Invalid Google connection');
    const binding = await this.binding(request);
    let result: { view: ConnectionView; token: string | null; pending: boolean } | null = null;
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      const locked = await this.health.prisma.$transaction(async tx => {
        if ((await this.tryLockBinding(tx, binding, undefined, false)).kind === 'busy') return { kind: 'busy' } as const;
        await this.lockBinding(tx, binding, undefined, false, false);
        const rows = await tx.$queryRaw<Array<{ id: string }>>`
          SELECT "id" FROM contextflow."GoogleDriveConnection" WHERE "id" = ${parsedId.data}::uuid
          AND "userId" = ${binding.userId}::uuid FOR UPDATE SKIP LOCKED`;
        if (!rows.length) {
          return await tx.googleDriveConnection.findFirst({ where: { id: parsedId.data, userId: binding.userId }, select: { id: true } })
            ? { kind: 'busy' } as const : { kind: 'missing' } as const;
        }
        await this.lockBinding(tx, binding, undefined, false, false);
        const now = new Date();
        const row = await tx.googleDriveConnection.findFirst({ where: { id: parsedId.data, userId: binding.userId } });
        if (!row) return { kind: 'missing' } as const;
        if (row.revokedAt || !row.encryptedTokens) return { kind: 'saved', value: { view: safeConnection(row), token: null, pending: true } } as const;
        let token: string | null = null;
        let pending = !runtime;
        if (runtime) {
          try { token = runtime.crypto.decryptTokens({ ciphertext: row.encryptedTokens, keyVersion: row.tokenKeyVersion }, binding.userId, row.id).refreshToken; }
          catch { pending = true; }
        }
        const changed = await tx.googleDriveConnection.update({ where: { id: row.id }, data: { encryptedTokens: null, revokedAt: now, updatedAt: now, generation: { increment: 1 } } });
        return { kind: 'saved', value: { view: safeConnection(changed), token, pending } } as const;
      }, { timeout: 15_000, maxWait: 3_000 });
      if (locked.kind === 'saved') { result = locked.value; break; }
      if (locked.kind === 'missing') throw new BadRequestException('Google connection not found');
      await delay(25);
    }
    if (!result) throw new ServiceUnavailableException('Google Docs connection is busy; retry shortly');
    if (result.pending || !result.token || !runtime) return { connection: result.view, providerRevocation: result.pending ? 'pending' : 'confirmed' };
    try { await runtime.client.revokeToken(result.token); return { connection: result.view, providerRevocation: 'confirmed' }; }
    catch { return { connection: result.view, providerRevocation: 'pending' }; }
  }
}
