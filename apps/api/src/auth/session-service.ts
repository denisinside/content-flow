import { randomUUID } from 'node:crypto';
import type { DependencyHealthService, Prisma } from '@contextflow/backend';
import { setTimeout as delay } from 'node:timers/promises';
import type { AuthConfig } from './auth-config.js';
import { AuthProvider, ProviderFailure, type ProviderSession } from './auth-provider.js';
import { SessionCrypto, opaqueToken, tokenDigest, validOpaqueToken, type ProviderTokens } from './session-crypto.js';

export const DEFAULT_IDLE_TIMEOUT_MINUTES = 24 * 60;
export const MAX_IDLE_TIMEOUT_MINUTES = 7 * 24 * 60;
export const IDLE_TIMEOUT_MS = DEFAULT_IDLE_TIMEOUT_MINUTES * 60 * 1000;
export interface SessionUser { id: string; email: string; displayName: string | null }
export type SessionCheck = { kind: 'active'; user: SessionUser } | { kind: 'expired' } | { kind: 'unavailable' };

export class SessionService {
  private readonly crypto: SessionCrypto;
  constructor(private readonly prisma: DependencyHealthService['prisma'], private readonly provider: AuthProvider, private readonly config: AuthConfig) {
    this.crypto = new SessionCrypto(config);
  }

  private async locked<T>(digest: string, work: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      const result = await this.prisma.$transaction(async tx => {
        const rows = await tx.$queryRaw<Array<{ id: string }>>`SELECT "id" FROM contextflow."AppSession" WHERE "cookieDigest" = ${digest} FOR UPDATE SKIP LOCKED`;
        if (!rows.length && await tx.appSession.findUnique({ where: { cookieDigest: digest }, select: { id: true } })) return { busy: true } as const;
        return { busy: false, value: await work(tx) } as const;
      }, { timeout: 20_000, maxWait: 5000 });
      if (!result.busy) return result.value;
      // Do not block a SQL statement beyond the driver's three-second deadline.
      // Retry outside the transaction, releasing the connection for the lock holder.
      await delay(25);
    }
    throw new ProviderFailure(true);
  }

  async create(session: ProviderSession, displayName: string | undefined, previousCookie?: string): Promise<{ cookie: string; user: SessionUser }> {
    const cookie = opaqueToken();
    const id = randomUUID();
    const now = new Date();
    const encrypted = this.crypto.encrypt(session.tokens, id, session.identity.id);
    const profile = await this.prisma.$transaction(async tx => {
      if (validOpaqueToken(previousCookie)) {
        await tx.appSession.updateMany({ where: { cookieDigest: tokenDigest(previousCookie), revokedAt: null }, data: { revokedAt: now, encryptedProviderTokens: null } });
      }
      const user = await tx.userProfile.upsert({ where: { id: session.identity.id }, update: {}, create: { id: session.identity.id, displayName: displayName ?? session.identity.displayName } });
      await tx.appSession.create({ data: { id, cookieDigest: tokenDigest(cookie), userId: user.id,
        encryptedProviderTokens: encrypted.ciphertext, tokenKeyVersion: encrypted.version,
        providerSessionId: session.identity.sessionId, providerTokenExpiresAt: session.identity.expiresAt,
        createdAt: now, lastUserActivityAt: now, expiresAt: new Date(now.getTime() + this.config.absoluteTtlMs) } });
      return user;
    });
    return { cookie, user: { id: profile.id, email: session.identity.email, displayName: profile.displayName } };
  }

  async check(cookie: string | undefined, activity = false): Promise<SessionCheck> {
    if (!validOpaqueToken(cookie)) return { kind: 'expired' };
    const digest = tokenDigest(cookie);
    // A PostgreSQL row lock spans verification/refresh and commit. It coordinates
    // all API processes; a rotating refresh token never races another refresh/logout.
    return this.locked(digest, async tx => {
      const row = await tx.appSession.findUnique({ where: { cookieDigest: digest }, include: { user: true } });
      if (!row || row.revokedAt) return { kind: 'expired' } as const;
      const revoke = async (): Promise<SessionCheck> => {
        await tx.appSession.update({ where: { id: row.id }, data: { revokedAt: new Date(), encryptedProviderTokens: null } });
        return { kind: 'expired' };
      };
      // Hold the personal setting while verifying the session. Concurrent edits
      // apply on the next check and cannot turn an already-expired check active.
      const preferences = await tx.$queryRaw<Array<{ idleTimeoutMinutes: number }>>`SELECT "idleTimeoutMinutes" FROM contextflow."UserProfile" WHERE "id" = ${row.userId}::uuid FOR SHARE`;
      if (!preferences[0]) return revoke();
      const idleTimeoutMs = preferences[0].idleTimeoutMinutes * 60_000;
      if (Date.now() >= row.expiresAt.getTime() || Date.now() - row.lastUserActivityAt.getTime() >= idleTimeoutMs) return revoke();
      let tokens: ProviderTokens;
      try { tokens = this.crypto.decrypt(row.encryptedProviderTokens ?? '', row.tokenKeyVersion, row.id, row.userId); }
      catch { return revoke(); }
      try {
        const refreshed = row.providerTokenExpiresAt.getTime() <= Date.now() + 60_000 ? await this.provider.refresh(tokens) : null;
        const identity = refreshed?.identity ?? await this.provider.verify(tokens);
        if (identity.id !== row.userId || identity.sessionId !== row.providerSessionId) return revoke();
        // Verification/refresh may take time; neither may revive an expired session.
        if (Date.now() >= row.expiresAt.getTime() || Date.now() - row.lastUserActivityAt.getTime() >= idleTimeoutMs) return revoke();
        if (refreshed || row.tokenKeyVersion !== this.config.currentKeyVersion) {
          const encrypted = this.crypto.encrypt(refreshed?.tokens ?? tokens, row.id, row.userId);
          await tx.appSession.update({ where: { id: row.id }, data: { encryptedProviderTokens: encrypted.ciphertext,
            tokenKeyVersion: encrypted.version, providerTokenExpiresAt: identity.expiresAt } });
        }
        if (activity && Date.now() - row.lastUserActivityAt.getTime() >= 30_000) {
          await tx.appSession.update({ where: { id: row.id }, data: { lastUserActivityAt: new Date() } });
        }
        return { kind: 'active', user: { id: row.userId, email: identity.email, displayName: row.user.displayName } } as const;
      } catch (error) {
        if (error instanceof ProviderFailure) return error.unavailable ? { kind: 'unavailable' } as const : revoke();
        throw error;
      }
    });
  }

  async preferences(userId: string): Promise<{ preferences: { idleTimeoutMinutes: number } }> {
    const profile = await this.prisma.userProfile.findUniqueOrThrow({ where: { id: userId }, select: { idleTimeoutMinutes: true } });
    return { preferences: { idleTimeoutMinutes: profile.idleTimeoutMinutes } };
  }

  async updatePreferences(userId: string, idleTimeoutMinutes: number): Promise<{ preferences: { idleTimeoutMinutes: number } }> {
    const profile = await this.prisma.userProfile.update({ where: { id: userId }, data: { idleTimeoutMinutes }, select: { idleTimeoutMinutes: true } });
    return { preferences: { idleTimeoutMinutes: profile.idleTimeoutMinutes } };
  }

  async logout(cookie: string | undefined): Promise<void> {
    if (!validOpaqueToken(cookie)) return;
    const digest = tokenDigest(cookie);
    const tokens = await this.locked(digest, async tx => {
      const row = await tx.appSession.findUnique({ where: { cookieDigest: digest } });
      if (!row || row.revokedAt) return null;
      let stored: ProviderTokens | null = null;
      try { stored = this.crypto.decrypt(row.encryptedProviderTokens ?? '', row.tokenKeyVersion, row.id, row.userId); } catch { /* Still revoke unreadable local credentials. */ }
      await tx.appSession.update({ where: { id: row.id }, data: { revokedAt: new Date(), encryptedProviderTokens: null } });
      return stored;
    });
    // Local revocation is committed first and cannot be undone by provider downtime.
    if (tokens) await this.provider.logout(tokens).catch(() => {});
  }
}
