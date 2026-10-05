import { Module } from '@nestjs/common';
import { createClaimJobHandler, createOutlineJobHandler, createImportJobHandlers, DependencyHealthService, DurableJobService, DurableJobWorker, EditorialService, EXTERNAL_PROCESSING_NOTICE, FactualBasisService, FoundationModule, loadRuntimeConfig, PrivateAssetStore } from '@contextflow/backend';
import { HealthController } from './health/health.controller.js';

@Module({
  imports: [FoundationModule],
  controllers: [HealthController],
  providers: [PrivateAssetStore, { provide: DurableJobWorker, inject: [DependencyHealthService, PrivateAssetStore],
    useFactory: (health: DependencyHealthService, assets: PrivateAssetStore) => {
      const jobs = new DurableJobService(health.prisma, { noticeVersion: EXTERNAL_PROCESSING_NOTICE.version });
      const facts = new FactualBasisService(health.prisma, jobs);
      const editorial = new EditorialService(health.prisma, jobs, facts);
      return new DurableJobWorker(health.prisma,
      loadRuntimeConfig().redisUrl, EXTERNAL_PROCESSING_NOTICE.version, [
        ...createImportJobHandlers({ prisma: health.prisma, assets }),
        createClaimJobHandler({ prisma: health.prisma, factualBasis: new FactualBasisService(health.prisma,
          new DurableJobService(health.prisma, { noticeVersion: EXTERNAL_PROCESSING_NOTICE.version })) }),
        createOutlineJobHandler({ prisma: health.prisma, editorial, factualBasis: facts }),
      ]);
    } }],
})
export class AppModule {}
