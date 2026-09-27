import { createServer, createConnection } from 'node:net';
import type { Socket } from 'node:net';
import { once } from 'node:events';
import { describe, expect, it } from 'vitest';
import { DependencyHealthService, loadRuntimeConfig } from '@contextflow/backend';

const config = loadRuntimeConfig();
const databaseUrl = new URL(config.databaseUrl);

describe('database readiness deadline and recovery', () => {
  it.skipIf(!['127.0.0.1', 'localhost'].includes(databaseUrl.hostname))('discards a connected client with dropped responses and reconnects', async () => {
    let dropResponses = false;
    const sockets = new Set<Socket>();
    const proxy = createServer(client => {
      const upstream = createConnection({ host: databaseUrl.hostname, port: Number(databaseUrl.port || '5432') });
      sockets.add(client);
      sockets.add(upstream);
      client.on('data', data => upstream.write(data));
      upstream.on('data', data => { if (!dropResponses) client.write(data); });
      client.on('error', () => upstream.destroy());
      upstream.on('error', () => client.destroy());
      client.on('close', () => { sockets.delete(client); upstream.destroy(); });
      upstream.on('close', () => { sockets.delete(upstream); client.destroy(); });
    });
    proxy.listen(0, '127.0.0.1');
    await once(proxy, 'listening');
    const address = proxy.address();
    if (!address || typeof address === 'string') throw new Error('Expected a TCP fixture port');
    const proxiedUrl = new URL(config.databaseUrl);
    proxiedUrl.hostname = '127.0.0.1';
    proxiedUrl.port = String(address.port);
    const health = new DependencyHealthService({ ...config, databaseUrl: proxiedUrl.toString(), dependencyTimeoutMs: 500 });
    try {
      expect((await health.check()).status).toBe('ready');
      dropResponses = true;
      const startedAt = Date.now();
      expect(await health.check()).toEqual({ status: 'not_ready', checks: { database: 'down', redis: 'up' } });
      expect(Date.now() - startedAt).toBeLessThan(2000);
      dropResponses = false;
      expect((await health.check()).status).toBe('ready');
    } finally {
      dropResponses = false;
      await health.onModuleDestroy();
      for (const socket of sockets) socket.destroy();
      await new Promise<void>(resolve => proxy.close(() => resolve()));
    }
  });
});
