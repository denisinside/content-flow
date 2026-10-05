import { Module } from '@nestjs/common';
import { DependencyHealthService, DurableJobService, EditorialService, FactualBasisService, FoundationModule } from '@contextflow/backend';
import { AuthModule } from '../auth/auth.module.js';
import { JobsModule } from '../jobs/jobs.module.js';
import { ClaimsModule } from '../claims/claims.module.js';
import { EditorialController } from './editorial.controller.js';

@Module({ imports: [FoundationModule, AuthModule, JobsModule, ClaimsModule], controllers: [EditorialController],
  providers: [{ provide: EditorialService, inject: [DependencyHealthService, DurableJobService, FactualBasisService],
    useFactory: (health: DependencyHealthService, jobs: DurableJobService, facts: FactualBasisService) => new EditorialService(health.prisma, jobs, facts) }], exports: [EditorialService] })
export class EditorialModule {}
