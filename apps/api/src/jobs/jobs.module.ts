import { Module } from '@nestjs/common';
import { DependencyHealthService, DurableJobService, FoundationModule } from '@contextflow/backend';
import { AuthModule } from '../auth/auth.module.js';
import { EXTERNAL_PROCESSING_NOTICE } from '../auth/external-processing.js';
import { JobsController } from './jobs.controller.js';

@Module({ imports: [FoundationModule, AuthModule], controllers: [JobsController], providers: [{ provide: DurableJobService,
  inject: [DependencyHealthService], useFactory: (health: DependencyHealthService) => new DurableJobService(health.prisma,
    { noticeVersion: EXTERNAL_PROCESSING_NOTICE.version }) }], exports: [DurableJobService] })
export class JobsModule {}
