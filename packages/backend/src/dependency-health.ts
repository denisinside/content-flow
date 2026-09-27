import type { OnModuleDestroy } from '@nestjs/common';
import { PrismaPg } from '@prisma/adapter-pg';
import { Redis } from 'ioredis';
import { PrismaClient } from './generated/prisma/client.js';
import { databasePoolOptions } from './database-connection.js';
import type { BackendConfig } from './config.js';

export interface DependencyHealth {
  status: 'ready' | 'not_ready';
  checks: { database: 'up' | 'down'; redis: 'up' | 'down' };
}

export class DependencyHealthService implements OnModuleDestroy {
  readonly prisma: PrismaClient;
  private readonly redis: Redis;
  private redisConnection: Promise<void> | undefined;

  constructor(config: BackendConfig) {
    const adapter = new PrismaPg(databasePoolOptions(config), { schema: 'contextflow' });
    this.prisma = new PrismaClient({ adapter, log: [] });
    this.redis = new Redis(config.redisUrl, {
      lazyConnect: true, enableOfflineQueue: false,
      connectTimeout: config.dependencyTimeoutMs, commandTimeout: config.dependencyTimeoutMs,
      maxRetriesPerRequest: 1, retryStrategy: () => null
    });
    // Drivers may include credentials in errors; expose only sanitized health state.
    this.redis.on('error', () => {});
  }

  async check(): Promise<DependencyHealth> {
    const results = await Promise.allSettled([
      this.prisma.$queryRawUnsafe<Array<{ ok: number }>>('SELECT 1 AS ok'),
      this.pingRedis()
    ]);
    const database = results[0]?.status === 'fulfilled' ? 'up' : 'down';
    const redis = results[1]?.status === 'fulfilled' ? 'up' : 'down';
    return { status: database === 'up' && redis === 'up' ? 'ready' : 'not_ready', checks: { database, redis } };
  }

  private async pingRedis(): Promise<void> {
    if (!this.redisConnection && (this.redis.status === 'wait' || this.redis.status === 'end')) {
      this.redisConnection = this.redis.connect().then(() => {}).finally(() => { this.redisConnection = undefined; });
    }
    if (this.redisConnection) await this.redisConnection;
    const reply = await this.redis.ping();
    if (reply !== 'PONG') throw new Error('Unexpected Redis health response');
  }

  async onModuleDestroy(): Promise<void> {
    this.redis.disconnect();
    await this.prisma.$disconnect();
  }
}
