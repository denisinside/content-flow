import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { loadRuntimeConfig } from '@contextflow/backend';
import { AppModule } from './app.module.js';

async function bootstrap(): Promise<void> {
  const config = loadRuntimeConfig();
  const app = await NestFactory.create(AppModule, { logger: false });

  app.getHttpAdapter().getInstance().disable('x-powered-by');
  app.enableShutdownHooks();
  await app.listen(config.workerHealthPort, config.workerHealthHost);
  console.info('worker started');
}

void bootstrap().catch(() => {
  console.error('Worker startup failed. Check local configuration and try again.');
  process.exitCode = 1;
});
