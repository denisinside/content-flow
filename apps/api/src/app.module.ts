import { Module } from '@nestjs/common';
import { FoundationModule } from '@contextflow/backend';
import { HealthController } from './health/health.controller.js';
import { AuthModule } from './auth/auth.module.js';
import { ProjectsModule } from './projects/projects.module.js';
import { WorkspacesModule } from './workspaces/workspaces.module.js';

@Module({
  imports: [FoundationModule, AuthModule, WorkspacesModule, ProjectsModule],
  controllers: [HealthController],
})
export class AppModule {}
