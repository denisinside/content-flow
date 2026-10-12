import { Module } from '@nestjs/common';
import { ExportService, createExportJobHandler, ArticleService, ScriptService, TelegramService, createTelegramJobHandler, createArticleJobHandler, createClaimJobHandler, createOutlineJobHandler, createImportJobHandlers, DependencyHealthService, DurableJobService, DurableJobWorker, EditorialService, EXTERNAL_PROCESSING_NOTICE, FactualBasisService, FoundationModule, loadRuntimeConfig, PrivateAssetStore } from '@contextflow/backend';
import { HealthController } from './health/health.controller.js';
import { GoogleDocSyncService, GoogleDocSyncPoller, GoogleSyncCredentials, loadGoogleOAuthRuntime, createGoogleDocSyncHandler } from '@contextflow/backend';
import { PrivateObjectCleanup, PrivateObjectCleanupPoller } from '@contextflow/backend';
import { VisualService, VisualRenderer, VisualBackgroundService, createBackgroundJobHandler } from '@contextflow/backend';

@Module({
  imports: [FoundationModule],
  controllers: [HealthController],
  providers: [PrivateAssetStore, {provide: VisualRenderer,useFactory:()=>new VisualRenderer()},
    { provide: PrivateObjectCleanupPoller, inject: [DependencyHealthService, PrivateAssetStore], useFactory: (health: DependencyHealthService, assets: PrivateAssetStore) =>
      new PrivateObjectCleanupPoller(new PrivateObjectCleanup(health.prisma, assets)) },
    { provide: GoogleDocSyncService, inject: [DependencyHealthService], useFactory: (health: DependencyHealthService) => {
      const jobs = new DurableJobService(health.prisma, { noticeVersion: EXTERNAL_PROCESSING_NOTICE.version });
      const facts = new FactualBasisService(health.prisma, jobs);
      return new GoogleDocSyncService(health.prisma, jobs, new ArticleService(health.prisma, jobs, facts), new GoogleSyncCredentials(health.prisma, loadGoogleOAuthRuntime()));
    } },
    { provide: GoogleDocSyncPoller, inject: [GoogleDocSyncService], useFactory: (sync: GoogleDocSyncService) => new GoogleDocSyncPoller(sync) },
    { provide: DurableJobWorker, inject: [DependencyHealthService, PrivateAssetStore, GoogleDocSyncService, VisualRenderer],
    useFactory: (health: DependencyHealthService, assets: PrivateAssetStore, sync: GoogleDocSyncService, renderer: VisualRenderer) => {
      const jobs = new DurableJobService(health.prisma, { noticeVersion: EXTERNAL_PROCESSING_NOTICE.version });
      const facts = new FactualBasisService(health.prisma, jobs);
      const editorial = new EditorialService(health.prisma, jobs, facts);
      const article = new ArticleService(health.prisma, jobs, facts);
      const telegram = new TelegramService(health.prisma, jobs, facts, article);
      const scripts = new ScriptService(health.prisma, telegram);
      const visuals = new VisualService(health.prisma,telegram,scripts,renderer,assets);
      const backgrounds = new VisualBackgroundService(health.prisma,visuals,jobs);
      return new DurableJobWorker(health.prisma,
      loadRuntimeConfig().redisUrl, EXTERNAL_PROCESSING_NOTICE.version, [
        ...createImportJobHandlers({ prisma: health.prisma, assets }),
        createClaimJobHandler({ prisma: health.prisma, factualBasis: new FactualBasisService(health.prisma,
          new DurableJobService(health.prisma, { noticeVersion: EXTERNAL_PROCESSING_NOTICE.version })) }),
        createOutlineJobHandler({ prisma: health.prisma, editorial, factualBasis: facts }),
        createArticleJobHandler({ prisma: health.prisma, editorial: article, factualBasis: facts }),
        createTelegramJobHandler({ prisma: health.prisma, telegram, scripts, articles: article, factualBasis: facts }),
        createExportJobHandler(new ExportService(health.prisma, jobs, article, telegram, assets, visuals)),
        createBackgroundJobHandler({prisma:health.prisma,backgrounds,renderer,assets}),
        createGoogleDocSyncHandler({ prisma: health.prisma, articles: article, sync, credentials: new GoogleSyncCredentials(health.prisma, loadGoogleOAuthRuntime()) }),
      ]);
    } }],
})
export class AppModule {}
