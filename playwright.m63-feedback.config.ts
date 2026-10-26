import { defineConfig } from '@playwright/test';

const port = Number(process.env['M63_FEEDBACK_WEB_PORT'] ?? '4184');
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid M6.3 feedback preview port');
const origin = `http://127.0.0.1:${port}`;
const engine = process.env['M63_FEEDBACK_ENGINE'] ?? (process.env['CI'] ? 'chromium' : 'chrome');
if (!['chromium', 'chrome', 'msedge', 'firefox', 'webkit'].includes(engine)) {
  throw new Error('M63_FEEDBACK_ENGINE must be chromium, chrome, msedge, firefox, or webkit');
}

export default defineConfig({
  testDir: './tests/e2e',
  testMatch: 'facts-ui-feedback.spec.ts',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: 'list',
  outputDir: '.local-checks/m63-feedback/playwright-results',
  use: {
    baseURL: origin,
    headless: true,
    trace: 'retain-on-failure',
    browserName: engine === 'firefox' ? 'firefox' : engine === 'webkit' ? 'webkit' : 'chromium',
    ...(engine === 'chrome' || engine === 'msedge' ? { channel: engine } : {}),
  },
  webServer: [{
    command: `"${process.execPath}" node_modules/vite/bin/vite.js preview --host 127.0.0.1 --port ${port} --strictPort`,
    cwd: 'apps/web',
    url: origin,
    reuseExistingServer: false,
    env: { API_PORT: '1' },
  }],
});
