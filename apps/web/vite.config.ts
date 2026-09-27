import { defineConfig, loadEnv } from 'vite';
import vue from '@vitejs/plugin-vue';
import { fileURLToPath } from 'node:url';

const workspaceRoot = fileURLToPath(new URL('../..', import.meta.url));

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, workspaceRoot, 'API_');
  const apiPort = Number(env['API_PORT'] ?? '3000');
  if (!Number.isInteger(apiPort) || apiPort < 1 || apiPort > 65535) throw new Error('Invalid API_PORT');
  return {
    plugins: [vue()],
    envDir: workspaceRoot,
    server: {
      proxy: { '/api': { target: `http://127.0.0.1:${apiPort}`, changeOrigin: false } }
    }
  };
});
