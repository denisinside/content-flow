import { Module } from '@nestjs/common';
import { loadRuntimeConfig } from './config.js';
import { DependencyHealthService } from './dependency-health.js';

@Module({
  providers: [{ provide: DependencyHealthService, useFactory: () => new DependencyHealthService(loadRuntimeConfig()) }],
  exports: [DependencyHealthService]
})
export class FoundationModule {}

export { DependencyHealthService } from './dependency-health.js';
export type { DependencyHealth } from './dependency-health.js';
export { ConfigurationError, loadRuntimeConfig, parseRuntimeConfig } from './config.js';
export type { BackendConfig } from './config.js';
export { databasePoolOptions } from './database-connection.js';
export type { Prisma } from './generated/prisma/client.js';
export { ProjectFormat, AssetState, AssetPurpose, MaterialKind, MaterialPurpose, SourceOrigin } from './generated/prisma/enums.js';
