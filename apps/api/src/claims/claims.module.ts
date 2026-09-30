import { Module } from '@nestjs/common';
import { DependencyHealthService, DurableJobService, FactualBasisService, FoundationModule } from '@contextflow/backend';
import { AuthModule } from '../auth/auth.module.js';
import { JobsModule } from '../jobs/jobs.module.js';
import { ClaimsController } from './claims.controller.js';

@Module({ imports: [FoundationModule, AuthModule, JobsModule], controllers: [ClaimsController],
  providers: [{ provide: FactualBasisService, inject: [DependencyHealthService, DurableJobService],
    useFactory: (health: DependencyHealthService, jobs: DurableJobService) => new FactualBasisService(health.prisma, jobs) }], exports: [FactualBasisService] })
export class ClaimsModule {}
