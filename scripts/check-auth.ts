import { randomUUID } from 'node:crypto';
import { DependencyHealthService, loadRuntimeConfig } from '@contextflow/backend';
import { loadAuthConfig } from '../apps/api/src/auth/auth-config.js';
import { AuthProvider, ProviderFailure } from '../apps/api/src/auth/auth-provider.js';
import { SessionCrypto, opaqueToken, tokenDigest } from '../apps/api/src/auth/session-crypto.js';

async function main(): Promise<void> {
  const runtime = loadRuntimeConfig();
  const auth = loadAuthConfig();
  const health = new DependencyHealthService(runtime);
  class RollbackFixture extends Error {}
  try {
    if ((await health.check()).status !== 'ready') throw new Error('Dependencies unavailable');
    const settings = await fetch(auth.providerUrl + '/auth/v1/settings', {
      headers: { apikey: auth.publishableKey }, signal: AbortSignal.timeout(5000)
    });
    if (!settings.ok) throw new Error('Auth settings unavailable');
    const configuration: unknown = await settings.json();
    if (!configuration || typeof configuration !== 'object' || !('external' in configuration)
      || !configuration.external || typeof configuration.external !== 'object' || !('email' in configuration.external)
      || configuration.external.email !== true) throw new Error('Email authentication unavailable');
    try {
      await new AuthProvider(auth).verify({ accessToken: 'synthetic-invalid-token', refreshToken: 'synthetic-invalid-token' });
      throw new Error('Invalid token was accepted');
    } catch (error) {
      if (!(error instanceof ProviderFailure) || error.unavailable) throw error;
    }
    const id = randomUUID(); const userId = randomUUID();
    const encrypted = new SessionCrypto(auth).encrypt({ accessToken: 'synthetic-access', refreshToken: 'synthetic-refresh' }, id, userId);
    const now = new Date();
    try {
      await health.prisma.$transaction(async tx => {
        await tx.userProfile.create({ data: { id: userId, displayName: 'Synthetic rollback fixture' } });
        await tx.appSession.create({ data: { id, cookieDigest: tokenDigest(opaqueToken()), userId,
          encryptedProviderTokens: encrypted.ciphertext, tokenKeyVersion: encrypted.version,
          providerTokenExpiresAt: new Date(now.getTime() + 3_600_000), createdAt: now, lastUserActivityAt: now,
          expiresAt: new Date(now.getTime() + auth.absoluteTtlMs) } });
        await tx.appSession.update({ where: { id }, data: { revokedAt: now, encryptedProviderTokens: null } });
        throw new RollbackFixture();
      });
    } catch (error) { if (!(error instanceof RollbackFixture)) throw error; }
    if (await health.prisma.userProfile.findUnique({ where: { id: userId } })) throw new Error('Fixture rollback failed');
    console.info('Auth provider email configuration, invalid-token rejection and application session DML verified. Synthetic DB fixture rolled back; no emails sent.');
  } finally { await health.onModuleDestroy(); }
}
void main().catch(() => { console.error('Auth verification failed. Check provider/database configuration; no private values logged.'); process.exitCode = 1; });
