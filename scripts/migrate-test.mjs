import { spawn } from 'node:child_process';

const pnpmCli = process.env.npm_execpath;
if (!pnpmCli) throw new Error('Run this command through pnpm db:migrate:test.');
const child = spawn(process.execPath, [pnpmCli, 'exec', 'prisma', 'migrate', 'deploy', '--config', 'prisma7.config.ts'], {
  env: { ...process.env, NODE_ENV: 'test' }, stdio: ['ignore', 'pipe', 'pipe']
});
let output = '';
child.stdout.on('data', chunk => { output += chunk.toString(); });
child.stderr.on('data', chunk => { output += chunk.toString(); });
child.on('error', () => { console.error('Test migration could not start.'); process.exitCode = 1; });
child.on('close', code => {
  const sanitized = output.replace(/postgres(?:ql)?:\/\/[^\s"'<>]+/gi, '[database URL redacted]');
  console.log(sanitized);
  process.exitCode = code ?? 1;
});
