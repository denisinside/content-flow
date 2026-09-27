import { DependencyHealthService, loadRuntimeConfig } from '@contextflow/backend';

let service: DependencyHealthService | undefined;
try {
  service = new DependencyHealthService(loadRuntimeConfig());
  const health = await service.check();
  console.log(JSON.stringify(health));
  if (health.status !== 'ready') process.exitCode = 1;
} catch {
  console.error('Connection verification failed. Check .env configuration; no credentials are printed.');
  process.exitCode = 1;
} finally {
  await service?.onModuleDestroy();
}
