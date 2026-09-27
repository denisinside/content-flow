import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: [
      { test: { name: 'unit', include: ['packages/backend/src/**/*.spec.ts', 'apps/**/*.spec.ts'], environment: 'node' } },
      { test: { name: 'integration', include: ['tests/integration/**/*.test.ts'], environment: 'node', env: { NODE_ENV: 'test' }, testTimeout: 15000, hookTimeout: 15000 } }
    ]
  }
});
