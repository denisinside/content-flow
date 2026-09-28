import { defineConfig } from '@playwright/test';

const apiPort = Number(process.env['E2E_API_PORT'] ?? '3000');
const workerPort = Number(process.env['E2E_WORKER_PORT'] ?? '3001');
const webPort = Number(process.env['E2E_WEB_PORT'] ?? '4173');
for (const value of [apiPort, workerPort, webPort]) {
  if (!Number.isInteger(value) || value < 1 || value > 65535) throw new Error('Invalid E2E port');
}
const webOrigin = `http://localhost:${webPort}`;

export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: 'list',
  use: { baseURL: webOrigin, headless: true, trace: 'retain-on-failure' },
  projects: [{ name: 'chromium', use: { browserName: 'chromium', ...(process.env['CI'] ? {} : { channel: 'chrome' }) } }],
  webServer: [
    { command: 'pnpm --filter @contextflow/api start', url: `http://127.0.0.1:${apiPort}/api/health/live`, reuseExistingServer: false, env: { NODE_ENV: 'test', API_PORT: String(apiPort), WEB_ORIGIN: webOrigin } },
    { command: 'pnpm --filter @contextflow/worker start', url: `http://127.0.0.1:${workerPort}/health/live`, reuseExistingServer: false, env: { NODE_ENV: 'test', WORKER_HEALTH_PORT: String(workerPort) } },
    { command: `pnpm --filter @contextflow/web exec vite preview --host 127.0.0.1 --port ${webPort} --strictPort`, url: `http://127.0.0.1:${webPort}`, reuseExistingServer: false, env: { API_PORT: String(apiPort) } }
  ]
});
