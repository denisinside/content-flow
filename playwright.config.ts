import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: 'list',
  use: { baseURL: 'http://localhost:4173', headless: true, trace: 'retain-on-failure' },
  projects: [{ name: 'chromium', use: { browserName: 'chromium', ...(process.env['CI'] ? {} : { channel: 'chrome' }) } }],
  webServer: [
    { command: 'pnpm --filter @contextflow/api start', url: 'http://127.0.0.1:3000/api/health/live', reuseExistingServer: false, env: { NODE_ENV: 'test', WEB_ORIGIN: 'http://localhost:4173' } },
    { command: 'pnpm --filter @contextflow/worker start', url: 'http://127.0.0.1:3001/health/live', reuseExistingServer: false, env: { NODE_ENV: 'test' } },
    { command: 'pnpm --filter @contextflow/web preview', url: 'http://127.0.0.1:4173', reuseExistingServer: false }
  ]
});
