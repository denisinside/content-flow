import { ForbiddenException, ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';
import { setTimeout as delay } from 'node:timers/promises';
import { Prisma, type PrismaClient } from '../generated/prisma/client.js';
import { EXTERNAL_PROCESSING_NOTICE } from '../external-processing-notice.js';
import { GoogleOAuthError, GOOGLE_DOCS_FILE_SCOPE } from './google-oauth-client.js';
import type { StoredGoogleOAuthTokens } from './google-oauth-crypto.js';
import { GoogleDocsApiError, GoogleDocsClient } from './google-docs-client.js';
import type { GoogleOAuthRuntime } from './google-oauth-runtime.js';

export interface GoogleSyncCredentialsContext {
  projectId: string;
  bindingId: string;
  userId: string;
  connectionId: string;
  sessionId: string | null;
  noticeAcceptedAt: Date;
  backgroundGeneration: number | null;
  signal?: AbortSignal;
}

type Runtime = Extract<GoogleOAuthRuntime, { kind: 'configured' }>;
type AuthRows = {
  generation: number; encryptedTokens: string | null; tokenKeyVersion: number; accessExpiresAt: Date;
  refreshExpiresAt: Date | null; revokedAt: Date | null; grantedScope: string;
};
type AccessToken = { accessToken: string; connectionGeneration: number };
const BUSY_TIMEOUT_MS = 30_000;
const REFRESH_SAFETY_WINDOW_MS = 60_000;

/** Server-only credential closure. Neither token nor connection ciphertext leaves this class. */
export class GoogleSyncCredentials {
  constructor(private readonly prisma: PrismaClient, private readonly runtime: GoogleOAuthRuntime = { kind: 'disabled' }) {}

  async withClient<T>(context: GoogleSyncCredentialsContext, operation: (client: GoogleDocsClient) => Promise<T>): Promise<T> {
    const runtime = this.configured();
    this.validateContext(context);
    const pinned = await this.acquireAccessToken(context, runtime);
    let operationError: unknown;
    let operationFailed = false;
    let reauthorizationMarked = false;
    let value: T | undefined;
    try {
      const baseFetch = runtime.docsFetchImpl ?? fetch;
      const client = new GoogleDocsClient({
        getAccessToken: async () => {
          this.assertNotAborted(context);
          await this.assertCurrent(context, pinned.connectionGeneration);
          return pinned.accessToken;
        },
        fetchImpl: (input, init) => {
          this.assertNotAborted(context);
          return baseFetch(input, init);
        },
      });
      value = await operation(client);
    } catch (error) {
      operationError = error;
      operationFailed = true;
      if (error instanceof GoogleDocsApiError && error.status === 401) {
        reauthorizationMarked = await this.expireGrant(context, pinned.connectionGeneration);
      }
    }

    // Always fence the outcome, including provider failures. A result observed after
    // consent, membership, binding, session, or credential generation changed is unusable.
    if (reauthorizationMarked) await this.assertReauthorizationFence(context, pinned.connectionGeneration);
    else await this.assertCurrent(context, pinned.connectionGeneration);
    if (operationFailed) throw operationError;
    return value as T;
  }

  private configured(): Runtime {
    if (this.runtime.kind !== 'configured') throw new ServiceUnavailableException('Google Docs connection is not configured');
    return this.runtime;
  }

  private validateContext(context: GoogleSyncCredentialsContext): void {
    if (!context || !context.projectId || !context.bindingId || !context.userId || !context.connectionId
      || !(context.noticeAcceptedAt instanceof Date) || !Number.isFinite(context.noticeAcceptedAt.getTime())
      || (context.sessionId === null) !== (context.backgroundGeneration !== null)
      || (context.backgroundGeneration !== null && (!Number.isSafeInteger(context.backgroundGeneration) || context.backgroundGeneration < 1))) {
      throw new ForbiddenException('Google Docs authorization context is invalid');
    }
    this.assertNotAborted(context);
  }

  private assertNotAborted(context: GoogleSyncCredentialsContext): void {
    if (context.signal?.aborted) throw new UnauthorizedException('Google Docs operation was cancelled');
  }

  private async acquireAccessToken(context: GoogleSyncCredentialsContext, runtime: Runtime): Promise<AccessToken> {
    const deadline = Date.now() + BUSY_TIMEOUT_MS;
    while (Date.now() < deadline) {
      this.assertNotAborted(context);
      const result = await this.prisma.$transaction(async tx => {
        const validation = await this.lockAndValidateContext(tx, context, true);
        if (validation === 'busy') return { kind: 'busy' } as const;
        if (validation !== 'valid') return { kind: validation } as const;

        const locked = await tx.$queryRaw<Array<{ id: string }>>`
          SELECT "id" FROM contextflow."GoogleDriveConnection"
          WHERE "id" = ${context.connectionId}::uuid AND "userId" = ${context.userId}::uuid
          FOR UPDATE SKIP LOCKED`;
        if (!locked.length) {
          const exists = await tx.googleDriveConnection.findFirst({ where: { id: context.connectionId, userId: context.userId }, select: { id: true } });
          return exists ? { kind: 'busy' } as const : { kind: 'missing' } as const;
        }
        const rows = await tx.$queryRaw<AuthRows[]>`
          SELECT "generation", "encryptedTokens", "tokenKeyVersion", "accessExpiresAt", "refreshExpiresAt", "revokedAt", "grantedScope"
          FROM contextflow."GoogleDriveConnection"
          WHERE "id" = ${context.connectionId}::uuid AND "userId" = ${context.userId}::uuid`;
        const row = rows[0];
        if (!row || row.revokedAt || !row.encryptedTokens || row.grantedScope !== GOOGLE_DOCS_FILE_SCOPE) return { kind: 'missing' } as const;
        const now = new Date();
        if (row.refreshExpiresAt && row.refreshExpiresAt.getTime() <= now.getTime()) return { kind: 'reauthorize' } as const;
        let stored: StoredGoogleOAuthTokens;
        try { stored = runtime.crypto.decryptTokens({ ciphertext: row.encryptedTokens, keyVersion: row.tokenKeyVersion }, context.userId, context.connectionId); }
        catch { return { kind: 'unavailable' } as const; }
        if (Math.abs(row.accessExpiresAt.getTime() - stored.expiresAtMs) > 1000) return { kind: 'unavailable' } as const;

        if (stored.expiresAtMs > now.getTime() + REFRESH_SAFETY_WINDOW_MS) {
          if (row.tokenKeyVersion === runtime.crypto.keyVersion) return { kind: 'ready', token: { accessToken: stored.accessToken, connectionGeneration: row.generation } } as const;
          const encrypted = runtime.crypto.encryptTokens(stored, context.userId, context.connectionId);
          const updated = await tx.googleDriveConnection.update({ where: { id: context.connectionId }, data: {
            encryptedTokens: encrypted.ciphertext, tokenKeyVersion: encrypted.keyVersion, updatedAt: now, generation: { increment: 1 },
          }, select: { generation: true } });
          return { kind: 'ready', token: { accessToken: stored.accessToken, connectionGeneration: updated.generation } } as const;
        }

        let refreshed;
        try { refreshed = await runtime.client.refreshAccessToken(stored.refreshToken); }
        catch (error) {
          if (error instanceof GoogleOAuthError && (error.status === 400 || error.status === 401
            || ['TIMEOUT', 'TRANSPORT', 'INVALID_RESPONSE'].includes(error.kind))) {
            // Google may have rotated the grant before the response was lost. Keep the
            // ciphertext encrypted for explicit disconnect, but never reuse the grant.
            await tx.googleDriveConnection.update({ where: { id: context.connectionId }, data: {
              refreshExpiresAt: new Date(), updatedAt: new Date(), generation: { increment: 1 },
            } });
            return (await this.isSessionExpired(tx, context)) ? { kind: 'session-expired' } as const : { kind: 'reauthorize' } as const;
          }
          throw new ServiceUnavailableException('Google Docs authorization is temporarily unavailable');
        }

        if (await this.isSessionExpired(tx, context)) {
          await tx.googleDriveConnection.update({ where: { id: context.connectionId }, data: {
            refreshExpiresAt: new Date(), updatedAt: new Date(), generation: { increment: 1 },
          } });
          return { kind: 'session-expired' } as const;
        }
        const expiresAtMs = Date.now() + refreshed.expires_in * 1000;
        const next: StoredGoogleOAuthTokens = { accessToken: refreshed.access_token,
          refreshToken: refreshed.refresh_token ?? stored.refreshToken, expiresAtMs };
        const encrypted = runtime.crypto.encryptTokens(next, context.userId, context.connectionId);
        const refreshExpiresAt = refreshed.refresh_token_expires_in !== undefined
          ? new Date(Date.now() + refreshed.refresh_token_expires_in * 1000)
          : refreshed.refresh_token === undefined ? row.refreshExpiresAt : null;
        const updated = await tx.googleDriveConnection.update({ where: { id: context.connectionId }, data: {
          encryptedTokens: encrypted.ciphertext, tokenKeyVersion: encrypted.keyVersion, accessExpiresAt: new Date(expiresAtMs),
          refreshExpiresAt, updatedAt: new Date(), generation: { increment: 1 },
        }, select: { generation: true } });
        return { kind: 'ready', token: { accessToken: next.accessToken, connectionGeneration: updated.generation } } as const;
      }, { timeout: 15_000, maxWait: 3_000 });

      if (result.kind === 'ready') return result.token;
      if (result.kind === 'missing') throw new ForbiddenException('Google connection is unavailable; reconnect the account');
      if (result.kind === 'reauthorize') throw new ForbiddenException('Google authorization expired; reconnect the account');
      if (result.kind === 'unavailable') throw new ServiceUnavailableException('Google Docs authorization is unavailable');
      if (result.kind === 'session-expired') throw new UnauthorizedException('Google Docs session expired');
      if (result.kind === 'notice-changed') throw new ForbiddenException('Google Docs consent or background grant changed');
      await delay(25);
    }
    throw new ServiceUnavailableException('Google Docs connection is busy; retry shortly');
  }

  /** Lock Project ancestry before session/notice and personal connection, matching sync command and job commit order. */
  private async lockAndValidateContext(tx: Prisma.TransactionClient, context: GoogleSyncCredentialsContext, skipLocked: boolean): Promise<'valid' | 'busy' | 'missing' | 'session-expired' | 'notice-changed'> {
    const projects = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT p."id" FROM contextflow."Project" p
      JOIN contextflow."Workspace" w ON w."id" = p."workspaceId"
      JOIN contextflow."WorkspaceMember" m ON m."workspaceId" = w."id"
      WHERE p."id" = ${context.projectId}::uuid AND p."archivedAt" IS NULL AND w."archivedAt" IS NULL
        AND 'ARTICLE' = ANY(p."formats") AND m."userId" = ${context.userId}::uuid AND m."leftAt" IS NULL
      FOR SHARE OF p, w, m`;
    if (!projects.length) return 'missing';
    if (context.sessionId !== null) {
      const sessions = skipLocked
        ? await tx.$queryRaw<Array<{ expiresAt: Date; lastUserActivityAt: Date }>>`
          SELECT "expiresAt", "lastUserActivityAt" FROM contextflow."AppSession"
          WHERE "id" = ${context.sessionId}::uuid AND "userId" = ${context.userId}::uuid AND "revokedAt" IS NULL
          FOR UPDATE SKIP LOCKED`
        : await tx.$queryRaw<Array<{ expiresAt: Date; lastUserActivityAt: Date }>>`
          SELECT "expiresAt", "lastUserActivityAt" FROM contextflow."AppSession"
          WHERE "id" = ${context.sessionId}::uuid AND "userId" = ${context.userId}::uuid AND "revokedAt" IS NULL
          FOR UPDATE`;
      if (!sessions.length) {
        const existing = await tx.$queryRaw<Array<{ revokedAt: Date | null; expiresAt: Date }>>`
          SELECT "revokedAt", "expiresAt" FROM contextflow."AppSession"
          WHERE "id" = ${context.sessionId}::uuid AND "userId" = ${context.userId}::uuid`;
        return existing[0] && !existing[0].revokedAt && existing[0].expiresAt.getTime() > Date.now() ? 'busy' : 'session-expired';
      }
      const profiles = await tx.$queryRaw<Array<{ idleTimeoutMinutes: number; externalProcessingNoticeVersion: string | null; externalProcessingAcceptedAt: Date | null }>>`
        SELECT "idleTimeoutMinutes", "externalProcessingNoticeVersion", "externalProcessingAcceptedAt"
        FROM contextflow."UserProfile" WHERE "id" = ${context.userId}::uuid FOR SHARE SKIP LOCKED`;
      if (!profiles.length) return 'busy';
      if (this.sessionExpired(sessions[0]!, profiles[0]!)) return 'session-expired';
      if (!this.noticeMatches(profiles[0]!, context.noticeAcceptedAt)) return 'notice-changed';
    } else {
      const profiles = await tx.$queryRaw<Array<{ externalProcessingNoticeVersion: string | null; externalProcessingAcceptedAt: Date | null }>>`
        SELECT "externalProcessingNoticeVersion", "externalProcessingAcceptedAt" FROM contextflow."UserProfile"
        WHERE "id" = ${context.userId}::uuid FOR SHARE SKIP LOCKED`;
      if (!profiles.length) {
        const exists = await tx.$queryRaw<Array<{ id: string }>>`SELECT "id" FROM contextflow."UserProfile" WHERE "id" = ${context.userId}::uuid`;
        return exists.length ? 'busy' : 'missing';
      }
      if (!this.noticeMatches(profiles[0]!, context.noticeAcceptedAt)) return 'notice-changed';
    }

    const bindings = await tx.$queryRaw<Array<{ connectionId: string; connectionUserId: string }>>`
      SELECT "connectionId", "connectionUserId" FROM contextflow."GoogleDocBinding"
      WHERE "id" = ${context.bindingId}::uuid AND "projectId" = ${context.projectId}::uuid AND "endedAt" IS NULL FOR SHARE`;
    if (!bindings.length) return 'missing';

    const states = await tx.$queryRaw<Array<{ backgroundConnectionId: string | null; backgroundUserId: string | null;
      backgroundNoticeAcceptedAt: Date | null; backgroundGeneration: number; backgroundGrantedAt: Date | null }>>`
      SELECT "backgroundConnectionId", "backgroundUserId", "backgroundNoticeAcceptedAt", "backgroundGeneration", "backgroundGrantedAt"
      FROM contextflow."GoogleDocSyncState" WHERE "bindingId" = ${context.bindingId}::uuid AND "projectId" = ${context.projectId}::uuid
      ${skipLocked ? Prisma.sql`FOR SHARE SKIP LOCKED` : Prisma.sql`FOR SHARE`}`;
    if (context.sessionId === null) {
      const state = states[0];
      if (!state && skipLocked) {
        const exists = await tx.$queryRaw<Array<{ bindingId: string }>>`
          SELECT "bindingId" FROM contextflow."GoogleDocSyncState" WHERE "bindingId" = ${context.bindingId}::uuid AND "projectId" = ${context.projectId}::uuid`;
        if (exists.length) return 'busy';
      }
      if (!state || !state.backgroundGrantedAt || state.backgroundConnectionId !== context.connectionId
        || state.backgroundUserId !== context.userId || state.backgroundGeneration !== context.backgroundGeneration
        || state.backgroundNoticeAcceptedAt?.getTime() !== context.noticeAcceptedAt.getTime()) return 'notice-changed';
    }

    return 'valid';
  }

  private async assertCurrent(context: GoogleSyncCredentialsContext, connectionGeneration: number): Promise<void> {
    this.assertNotAborted(context);
    const result = await this.prisma.$transaction(async tx => {
      const checked = await this.lockAndValidateContext(tx, context, false);
      if (checked !== 'valid') return checked;
      const connections = await tx.$queryRaw<Array<AuthRows>>`
        SELECT "generation", "encryptedTokens", "tokenKeyVersion", "accessExpiresAt", "refreshExpiresAt", "revokedAt", "grantedScope"
        FROM contextflow."GoogleDriveConnection" WHERE "id" = ${context.connectionId}::uuid
          AND "userId" = ${context.userId}::uuid FOR SHARE`;
      const connection = connections[0];
      return connection && connection.generation === connectionGeneration && !connection.revokedAt
        && connection.encryptedTokens && connection.grantedScope === GOOGLE_DOCS_FILE_SCOPE
        && (!connection.refreshExpiresAt || connection.refreshExpiresAt.getTime() > Date.now()) ? 'valid' : 'missing';
    }, { timeout: 10_000, maxWait: 3_000 });
    this.throwFenceResult(result);
  }

  private async assertReauthorizationFence(context: GoogleSyncCredentialsContext, previousGeneration: number): Promise<void> {
    this.assertNotAborted(context);
    const result = await this.prisma.$transaction(async tx => {
      const checked = await this.lockAndValidateContext(tx, context, false);
      if (checked !== 'valid') return checked;
      const connections = await tx.$queryRaw<Array<AuthRows>>`
        SELECT "generation", "encryptedTokens", "tokenKeyVersion", "accessExpiresAt", "refreshExpiresAt", "revokedAt", "grantedScope"
        FROM contextflow."GoogleDriveConnection" WHERE "id" = ${context.connectionId}::uuid
          AND "userId" = ${context.userId}::uuid FOR SHARE`;
      const connection = connections[0];
      return connection && connection.generation === previousGeneration + 1 && !connection.revokedAt
        && connection.encryptedTokens && connection.grantedScope === GOOGLE_DOCS_FILE_SCOPE
        && connection.refreshExpiresAt && connection.refreshExpiresAt.getTime() <= Date.now() ? 'valid' : 'missing';
    }, { timeout: 10_000, maxWait: 3_000 });
    this.throwFenceResult(result);
  }

  private async expireGrant(context: GoogleSyncCredentialsContext, expectedGeneration: number): Promise<boolean> {
    const now = new Date();
    return this.prisma.$transaction(async tx => {
      const checked = await this.lockAndValidateContext(tx, context, false);
      if (checked !== 'valid') return false;
      const result = await tx.googleDriveConnection.updateMany({ where: { id: context.connectionId, userId: context.userId,
        generation: expectedGeneration, revokedAt: null }, data: { refreshExpiresAt: now, updatedAt: now, generation: { increment: 1 } } });
      return result.count === 1;
    }, { timeout: 10_000, maxWait: 3_000 });
  }

  private async isSessionExpired(tx: Prisma.TransactionClient, context: GoogleSyncCredentialsContext): Promise<boolean> {
    if (context.sessionId === null) return false;
    const rows = await tx.$queryRaw<Array<{ expiresAt: Date; lastUserActivityAt: Date; idleTimeoutMinutes: number }>>`
      SELECT s."expiresAt", s."lastUserActivityAt", u."idleTimeoutMinutes"
      FROM contextflow."AppSession" s JOIN contextflow."UserProfile" u ON u."id" = s."userId"
      WHERE s."id" = ${context.sessionId}::uuid AND s."userId" = ${context.userId}::uuid AND s."revokedAt" IS NULL`;
    return !rows[0] || this.sessionExpired(rows[0], rows[0]);
  }

  private sessionExpired(session: { expiresAt: Date; lastUserActivityAt: Date }, profile: { idleTimeoutMinutes: number }): boolean {
    const now = Date.now();
    return now >= session.expiresAt.getTime() || now - session.lastUserActivityAt.getTime() >= profile.idleTimeoutMinutes * 60_000;
  }

  private noticeMatches(profile: { externalProcessingNoticeVersion: string | null; externalProcessingAcceptedAt: Date | null }, acceptedAt: Date): boolean {
    return profile.externalProcessingNoticeVersion === EXTERNAL_PROCESSING_NOTICE.version
      && profile.externalProcessingAcceptedAt?.getTime() === acceptedAt.getTime();
  }

  private throwFenceResult(result: 'valid' | 'busy' | 'missing' | 'session-expired' | 'notice-changed'): void {
    if (result === 'valid') return;
    if (result === 'session-expired') throw new UnauthorizedException('Google Docs session expired');
    if (result === 'notice-changed') throw new ForbiddenException('Google Docs consent changed');
    if (result === 'busy') throw new ServiceUnavailableException('Google Docs authorization is busy; retry shortly');
    throw new ForbiddenException('Google Docs access is no longer available');
  }
}
