import { Module } from '@nestjs/common';
import { ArticleService, DependencyHealthService, DurableJobService, ExportService, PrivateAssetStore, TelegramService, FoundationModule, VisualService } from '@contextflow/backend';
import { AuthModule } from '../auth/auth.module.js';
import { JobsModule } from '../jobs/jobs.module.js';
import { EditorialModule } from '../editorial/editorial.module.js';
import { StorageModule } from '../storage/storage.module.js';
import { ExportController } from './export.controller.js';
import { VisualModule } from '../visuals/visual.module.js';

@Module({ imports: [FoundationModule, AuthModule, JobsModule, EditorialModule, StorageModule, VisualModule], controllers: [ExportController], providers: [
  { provide: ExportService, inject: [DependencyHealthService, DurableJobService, ArticleService, TelegramService, PrivateAssetStore, VisualService],
    useFactory: (health: DependencyHealthService, jobs: DurableJobService, articles: ArticleService, telegram: TelegramService, assets: PrivateAssetStore, visuals: VisualService) =>
      new ExportService(health.prisma, jobs, articles, telegram, assets, visuals) },
], exports: [ExportService] })
export class ExportModule {}
