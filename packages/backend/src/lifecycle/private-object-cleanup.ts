import type { PrismaClient } from '../generated/prisma/client.js';
import type { PrivateAssetStore } from '../storage/private-asset-store.js';

/** Retries only objects durably detached by an authorized whole-project purge. */
export class PrivateObjectCleanup {
  constructor(private readonly prisma: PrismaClient, private readonly assets: Pick<PrivateAssetStore, 'remove'>) {}

  async processOne(): Promise<boolean> {
    return this.prisma.$transaction(async tx => {
      const rows = await tx.$queryRaw<Array<{ id: string; bucket: string; objectKey: string; attempts: number }>>`
        SELECT "id", "bucket", "objectKey", "attempts" FROM contextflow."PrivateObjectDeletion"
        WHERE "state"='PENDING' AND "retryAfter"<=CURRENT_TIMESTAMP
        ORDER BY "createdAt","id" LIMIT 1 FOR UPDATE SKIP LOCKED`;
      const row = rows[0];
      if (!row) return false;
      const referenced = await tx.asset.findUnique({ where: { bucket_objectKey: { bucket: row.bucket, objectKey: row.objectKey } }, select: { id: true } });
      const attempts = row.attempts + 1;
      if (referenced) {
        await tx.privateObjectDeletion.update({ where: { id: row.id }, data: { attempts, errorCategory: 'REFERENCE_CONFLICT', retryAfter: new Date(Date.now() + 86_400_000) } });
        return true;
      }
      try { await this.assets.remove(row.bucket, row.objectKey); }
      catch {
        await tx.privateObjectDeletion.update({ where: { id: row.id }, data: { attempts, errorCategory: 'STORAGE_UNAVAILABLE',
          retryAfter: new Date(Date.now() + Math.min(86_400_000, 30_000 * 2 ** Math.min(attempts - 1, 12))) } });
        return true;
      }
      await tx.privateObjectDeletion.update({ where: { id: row.id }, data: { state: 'DELETED', attempts, deletedAt: new Date(), errorCategory: null } });
      return true;
    }, { timeout: 30_000, maxWait: 5000 });
  }
}

export class PrivateObjectCleanupPoller {
  private timer: ReturnType<typeof setInterval> | undefined;
  private pending: Promise<void> | undefined;
  constructor(private readonly cleanup: PrivateObjectCleanup) {}
  onModuleInit(): void {
    const tick = () => {
      if (this.pending) return;
      this.pending = this.run().finally(() => { this.pending = undefined; });
    };
    this.timer = setInterval(tick, 30_000);
    this.timer.unref();
    tick();
  }
  private async run(): Promise<void> {
    try { for (let count = 0; count < 4 && await this.cleanup.processOne(); count++) { /* bounded batch */ } }
    catch { console.warn(JSON.stringify({ event: 'PRIVATE_OBJECT_CLEANUP_FAILED', category: 'DATABASE_UNAVAILABLE' })); }
  }
  async onModuleDestroy(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    await this.pending;
  }
}
