import { spawnSync } from 'node:child_process';
const compose = ['compose', '--env-file', '.env', '-f', 'infra/compose.dev.yml', '--profile', 'test'];
function run(command, args) {
  const result = spawnSync(command, args, { stdio: 'inherit', shell: false });
  if (result.error || result.status !== 0) process.exit(result.status || 1);
}
run('docker', [...compose, 'up', '-d', '--wait', 'postgres-test', 'redis-test']);
run(process.execPath, ['scripts/init-test-auth.mjs']);
run('docker', [...compose, 'up', '-d', '--wait', 'auth-test', 'auth-gateway-test']);
