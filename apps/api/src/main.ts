import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { createRequire } from 'node:module';
import { loadRuntimeConfig } from '@contextflow/backend';
import { AppModule } from './app.module.js';

const platformRequire = createRequire(createRequire(import.meta.url).resolve('@nestjs/platform-express'));
const expressJson = platformRequire('express').json as (options: { limit: string }) => Parameters<NestExpressApplication['use']>[0];

async function bootstrap(): Promise<void> {
  const config = loadRuntimeConfig();
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { logger: false, bodyParser: false });
  app.getHttpAdapter().getInstance().use('/api/v1/projects/:projectId/visuals/assets', expressJson({ limit: '7mb' }));
  app.useBodyParser('json', { limit: '1mb' });

  app.getHttpAdapter().getInstance().disable('x-powered-by');
  app.enableShutdownHooks();

  const openApiConfig = new DocumentBuilder()
    .setTitle('ContextFlow API')
    .setVersion('1.0.0')
    .addCookieAuth('__Host-contextflow', { type: 'apiKey', in: 'cookie' }, '__Host-contextflow')
    .build();
  const openApiDocument = SwaggerModule.createDocument(app, openApiConfig);
  SwaggerModule.setup('api/docs', app, openApiDocument, {
    jsonDocumentUrl: 'api/openapi.json',
  });

  await app.listen(config.apiPort, config.apiHost);
  console.info('api started');
}

void bootstrap().catch(() => {
  console.error('API startup failed. Check local configuration and try again.');
  process.exitCode = 1;
});
