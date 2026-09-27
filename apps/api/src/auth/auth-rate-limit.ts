import { HttpException, ServiceUnavailableException, type OnModuleDestroy } from '@nestjs/common';
import { createHmac } from 'node:crypto';
import { Redis } from 'ioredis';
import type { AuthConfig } from './auth-config.js';

const increment = `local count = redis.call('INCR', KEYS[1]); if count == 1 then redis.call('PEXPIRE', KEYS[1], ARGV[1]); end; return count;`;
export class AuthRateLimit implements OnModuleDestroy {
  private readonly redis: Redis;
  constructor(redisUrl: string, private readonly config: AuthConfig) {
    this.redis = new Redis(redisUrl, { lazyConnect: true, enableOfflineQueue: false, connectTimeout: 3000,
      commandTimeout: 3000, maxRetriesPerRequest: 1, retryStrategy: () => null });
    this.redis.on('error', () => {});
  }
  private connecting: Promise<void> | undefined;
  async require(ip: string, email: string): Promise<void> {
    try {
      if (!this.connecting && ['wait', 'end'].includes(this.redis.status)) this.connecting = this.redis.connect().finally(() => { this.connecting = undefined; });
      if (this.connecting) await this.connecting;
      const hash = (value: string) => createHmac('sha256', this.config.csrfKey).update(value).digest('hex');
      const counts = await Promise.all([this.redis.eval(increment, 1, 'cf:auth:ip:' + hash(ip), 600_000),
        this.redis.eval(increment, 1, 'cf:auth:email:' + hash(email.toLowerCase()), 600_000)]);
      if (Number(counts[0]) > 30 || Number(counts[1]) > 10) throw new HttpException('Too many attempts; try later', 429);
    } catch (error) {
      if (error instanceof HttpException) throw error;
      throw new ServiceUnavailableException('Authentication temporarily unavailable');
    }
  }
  onModuleDestroy(): void { this.redis.disconnect(); }
}
