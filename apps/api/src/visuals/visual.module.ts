import { Module } from '@nestjs/common';
import { DependencyHealthService, DurableJobService, EXTERNAL_PROCESSING_NOTICE, PrivateAssetStore, ScriptService, TelegramService, VisualRenderer, VisualService, VisualBackgroundService } from '@contextflow/backend';
import { FoundationModule } from '@contextflow/backend';
import { AuthModule } from '../auth/auth.module.js';
import { EditorialModule } from '../editorial/editorial.module.js';
import { StorageModule } from '../storage/storage.module.js';
import { VisualController } from './visual.controller.js';

@Module({ imports: [FoundationModule, AuthModule, EditorialModule, StorageModule], controllers: [VisualController], providers: [
  { provide: VisualRenderer, useFactory: () => new VisualRenderer() },
  { provide: VisualService, inject: [DependencyHealthService, TelegramService, ScriptService, VisualRenderer, PrivateAssetStore],
    useFactory: (health: DependencyHealthService, channels: TelegramService, scripts: ScriptService, renderer: VisualRenderer, storage: PrivateAssetStore) =>
      new VisualService(health.prisma, channels, scripts, renderer, storage) },
  { provide: VisualBackgroundService, inject: [DependencyHealthService, VisualService], useFactory: (health: DependencyHealthService, visuals: VisualService) =>
    new VisualBackgroundService(health.prisma, visuals, new DurableJobService(health.prisma, {noticeVersion: EXTERNAL_PROCESSING_NOTICE.version})) },
] , exports: [VisualService] })
export class VisualModule {}
