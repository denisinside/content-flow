import { Module } from '@nestjs/common';
import { createClaimJobHandler, createImportJobHandlers, DependencyHealthService, DurableJobService, DurableJobWorker, EXTERNAL_PROCESSING_NOTICE, FactualBasisService, FoundationModule, loadRuntimeConfig, PrivateAssetStore } from '@contextflow/backend';
import { HealthController } from './health/health.controller.js';

@Module({
  imports: [FoundationModule],
  controllers: [HealthController],
  providers: [PrivateAssetStore, { provide: DurableJobWorker, inject: [DependencyHealthService, PrivateAssetStore],
    useFactory: (health: DependencyHealthService, assets: PrivateAssetStore) => new DurableJobWorker(health.prisma,
      loadRuntimeConfig().redisUrl, EXTERNAL_PROCESSING_NOTICE.version, [
        ...createImportJobHandlers({ prisma: health.prisma, assets }),
        createClaimJobHandler({ prisma: health.prisma, factualBasis: new FactualBasisService(health.prisma,
          new DurableJobService(health.prisma, { noticeVersion: EXTERNAL_PROCESSING_NOTICE.version })) }),
      ]) }],
})
export class AppModule {}
