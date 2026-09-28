import { randomUUID } from 'node:crypto';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { createServer, type ViteDevServer } from 'vite';

it('denies private originals through Vite filesystem URLs while serving ordinary workspace files', async () => {
  const webRoot = fileURLToPath(new URL('./', import.meta.url));
  const root = resolve(webRoot, '../..');
  const fixtureId = randomUUID();
  const directories = [resolve(root, '.private-assets', fixtureId), resolve(root, '.private-assets-test', fixtureId), resolve(root, 'coverage/vite-security', fixtureId)];
  let server: ViteDevServer | undefined;
  try {
    for (const directory of directories) {
      await mkdir(directory, { recursive: true });
      await writeFile(resolve(directory, 'fixture.txt'), 'synthetic-private-original', { flag: 'wx' });
    }
    server = await createServer({ root: webRoot, configFile: resolve(webRoot, 'vite.config.ts'), mode: 'test', logLevel: 'silent', server: { host: '127.0.0.1', port: 0 } });
    await server.listen();
    const address = server.httpServer?.address();
    if (!address || typeof address === 'string') throw new Error('TEST Vite did not bind a loopback port');
    const origin = `http://127.0.0.1:${address.port}`;
    for (const directory of directories) {
      const path = resolve(directory, 'fixture.txt').replaceAll('\\', '/');
      const response = await fetch(`${origin}/@fs/${path}`);
      if (directory === directories[2]) {
        expect(response.status).toBe(200);
        expect(await response.text()).toBe('synthetic-private-original');
      } else {
        expect(response.status).toBe(403);
        expect(await response.text()).not.toContain('synthetic-private-original');
      }
    }
  } finally {
    await server?.close();
    for (const directory of directories) {
      const suffix = relative(root, directory);
      if (suffix.startsWith('..') || !suffix.endsWith(fixtureId)) throw new Error('Invalid TEST cleanup path');
      await rm(directory, { recursive: true, force: true });
    }
  }
}, 15000);
