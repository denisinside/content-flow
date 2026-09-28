import { Module } from '@nestjs/common';
import { FoundationModule } from '@contextflow/backend';
import { AuthModule } from '../auth/auth.module.js';
import { StorageModule } from '../storage/storage.module.js';
import { SourceService } from './source.service.js';
import { SourcesController } from './sources.controller.js';

@Module({ imports: [FoundationModule, AuthModule, StorageModule], controllers: [SourcesController], providers: [SourceService], exports: [SourceService] })
export class SourcesModule {}
