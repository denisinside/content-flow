import type { OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import type { GoogleDocSyncService } from './google-doc-sync.service.js';

export class GoogleDocSyncPoller implements OnModuleInit, OnModuleDestroy {
  private timer: ReturnType<typeof setInterval> | undefined;
  private running = false;
  lastErrorAt: Date | null = null;
  constructor(private readonly sync: GoogleDocSyncService) {}
  onModuleInit(): void {
    this.timer = setInterval(() => { void this.tick(); }, 60_000);
    this.timer.unref();
  }
  onModuleDestroy(): void { if (this.timer) clearInterval(this.timer); }
  async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try { await this.sync.queueDuePulls(); this.lastErrorAt = null; }
    catch { this.lastErrorAt = new Date(); }
    finally { this.running = false; }
  }
}
