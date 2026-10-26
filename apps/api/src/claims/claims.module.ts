import { Module } from '@nestjs/common';
import { DependencyHealthService, DurableJobService, FactualBasisService, FoundationModule, SourceEvidenceService, SourcePreparationService } from '@contextflow/backend';
import { AuthModule } from '../auth/auth.module.js';
import { JobsModule } from '../jobs/jobs.module.js';
import { EvidenceController } from './evidence.controller.js';

@Module({ imports: [FoundationModule, AuthModule, JobsModule], controllers: [EvidenceController],
  providers: [{ provide: FactualBasisService, inject: [DependencyHealthService, DurableJobService],
    useFactory: (health: DependencyHealthService, jobs: DurableJobService) => new FactualBasisService(health.prisma, jobs) },
  { provide: SourceEvidenceService, inject: [DependencyHealthService, DurableJobService],
    useFactory: (health: DependencyHealthService, jobs: DurableJobService) => new SourceEvidenceService(health.prisma, jobs) },
  { provide: SourcePreparationService, inject: [DependencyHealthService, DurableJobService, SourceEvidenceService, FactualBasisService],
    useFactory: (health: DependencyHealthService, jobs: DurableJobService, evidence: SourceEvidenceService, facts: FactualBasisService) =>
      new SourcePreparationService(health.prisma, jobs, evidence, facts) }],
  exports: [FactualBasisService, SourceEvidenceService, SourcePreparationService] })
export class ClaimsModule {}
