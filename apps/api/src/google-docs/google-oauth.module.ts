import { Module } from '@nestjs/common';
import { ArticleService, DependencyHealthService, DurableJobService, FoundationModule, GoogleDocSyncService, GoogleSyncCredentials } from '@contextflow/backend';
import { AuthModule } from '../auth/auth.module.js';
import { ExternalProcessingService } from '../auth/external-processing.js';
import { SessionService } from '../auth/session-service.js';
import { GoogleOAuthController } from './google-oauth.controller.js';
import { loadGoogleOAuthRuntime } from './google-oauth.config.js';
import { GoogleOAuthService } from './google-oauth.service.js';
import { GoogleDocBindingController } from './google-doc-binding.controller.js';
import { GoogleDocBindingService } from './google-doc-binding.service.js';
import { GoogleDocCreateController } from './google-doc-create.controller.js';
import { GoogleDocCreateService } from './google-doc-create.service.js';
import { GoogleDocSyncController } from './google-doc-sync.controller.js';
import { JobsModule } from '../jobs/jobs.module.js';
import { EditorialModule } from '../editorial/editorial.module.js';

@Module({
  imports: [FoundationModule, AuthModule, JobsModule, EditorialModule],
  controllers: [GoogleOAuthController, GoogleDocBindingController, GoogleDocCreateController, GoogleDocSyncController],
  providers: [
    { provide: 'GOOGLE_OAUTH_RUNTIME', useFactory: loadGoogleOAuthRuntime },
    { provide: GoogleSyncCredentials, inject: [DependencyHealthService, 'GOOGLE_OAUTH_RUNTIME'],
      useFactory: (health: DependencyHealthService, runtime: ReturnType<typeof loadGoogleOAuthRuntime>) => new GoogleSyncCredentials(health.prisma, runtime) },
    { provide: GoogleDocSyncService, inject: [DependencyHealthService, DurableJobService, ArticleService, GoogleSyncCredentials],
      useFactory: (health: DependencyHealthService, jobs: DurableJobService, articles: ArticleService, credentials: GoogleSyncCredentials) => new GoogleDocSyncService(health.prisma, jobs, articles, credentials) },
    { provide: GoogleOAuthService, inject: [DependencyHealthService, SessionService, ExternalProcessingService, 'GOOGLE_OAUTH_RUNTIME'],
      useFactory: (health: DependencyHealthService, sessions: SessionService, processing: ExternalProcessingService,
        runtime: ReturnType<typeof loadGoogleOAuthRuntime>) => new GoogleOAuthService(health, sessions, processing, runtime) },
    { provide: GoogleDocBindingService, inject: [DependencyHealthService, GoogleOAuthService],
      useFactory: (health: DependencyHealthService, oauth: GoogleOAuthService) => new GoogleDocBindingService(health, oauth) },
    { provide: GoogleDocCreateService, inject: [DependencyHealthService, GoogleOAuthService],
      useFactory: (health: DependencyHealthService, oauth: GoogleOAuthService) => new GoogleDocCreateService(health, oauth) },
  ],
  exports: [GoogleOAuthService],
})
export class GoogleOAuthModule {}
