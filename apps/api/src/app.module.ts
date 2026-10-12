import { Module } from '@nestjs/common';
import { FoundationModule } from '@contextflow/backend';
import { HealthController } from './health/health.controller.js';
import { AuthModule } from './auth/auth.module.js';
import { ProjectsModule } from './projects/projects.module.js';
import { WorkspacesModule } from './workspaces/workspaces.module.js';
import { SourcesModule } from './sources/sources.module.js';
import { JobsModule } from './jobs/jobs.module.js';
import { ClaimsModule } from './claims/claims.module.js';
import { EditorialModule } from './editorial/editorial.module.js';
import { ExportModule } from './export/export.module.js';
import { GoogleOAuthModule } from './google-docs/google-oauth.module.js';
import { PresenceModule } from './presence/presence.module.js';

@Module({
  imports: [FoundationModule, AuthModule, WorkspacesModule, ProjectsModule, SourcesModule, JobsModule, ClaimsModule, EditorialModule, ExportModule, GoogleOAuthModule, PresenceModule],
  controllers: [HealthController],
})
export class AppModule {}
