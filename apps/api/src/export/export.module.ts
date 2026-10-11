import { Module } from '@nestjs/common';
import { ArticleService, DependencyHealthService, DurableJobService, ExportService, PrivateAssetStore, TelegramService, FoundationModule } from '@contextflow/backend';
import { AuthModule } from '../auth/auth.module.js';
import { JobsModule } from '../jobs/jobs.module.js';
import { EditorialModule } from '../editorial/editorial.module.js';
import { StorageModule } from '../storage/storage.module.js';
import { ExportController } from './export.controller.js';

@Module({ imports: [FoundationModule, AuthModule, JobsModule, EditorialModule, StorageModule], controllers: [ExportController], providers: [
  { provide: ExportService, inject: [DependencyHealthService, DurableJobService, ArticleService, TelegramService, PrivateAssetStore],
    useFactory: (health: DependencyHealthService, jobs: DurableJobService, articles: ArticleService, telegram: TelegramService, assets: PrivateAssetStore) =>
      new ExportService(health.prisma, jobs, articles, telegram, assets) },
], exports: [ExportService] })
export class ExportModule {}
