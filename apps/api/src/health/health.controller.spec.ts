import { ServiceUnavailableException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import type { DependencyHealthService } from '@contextflow/backend';
import { HealthController } from './health.controller.js';

describe('HealthController', () => {
  it('uses a sanitized 503 response when a dependency is unavailable', async () => {
    const check = vi.fn<DependencyHealthService['check']>().mockResolvedValue({
      status: 'not_ready',
      checks: { database: 'down', redis: 'up' },
    });
    const controller = new HealthController({ check });

    try {
      await controller.ready();
      throw new Error('Expected readiness to fail');
    } catch (error) {
      expect(error).toBeInstanceOf(ServiceUnavailableException);
      const exception = error as ServiceUnavailableException;
      expect(exception.getStatus()).toBe(503);
      expect(exception.getResponse()).toEqual({
        status: 'not_ready',
        checks: { database: 'down', redis: 'up' },
      });
    }
  });
});
