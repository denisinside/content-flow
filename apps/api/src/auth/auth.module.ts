import { Module } from '@nestjs/common';
import { DependencyHealthService, FoundationModule, loadRuntimeConfig } from '@contextflow/backend';
import { loadAuthConfig, type AuthConfig } from './auth-config.js';
import { AuthController } from './auth.controller.js';
import { AuthProvider } from './auth-provider.js';
import { AuthRateLimit } from './auth-rate-limit.js';
import { CsrfProtection } from './csrf.js';
import { SessionService } from './session-service.js';
import { SessionGuard } from './session.guard.js';
import { ExternalProcessingController, ExternalProcessingService } from './external-processing.js';

@Module({
  imports: [FoundationModule], controllers: [AuthController, ExternalProcessingController],
  providers: [
    SessionGuard,
    ExternalProcessingService,
    { provide: 'AUTH_CONFIG', useFactory: loadAuthConfig },
    { provide: AuthProvider, inject: ['AUTH_CONFIG'], useFactory: (config: AuthConfig) => new AuthProvider(config) },
    { provide: CsrfProtection, inject: ['AUTH_CONFIG'], useFactory: (config: AuthConfig) => new CsrfProtection(config) },
    { provide: AuthRateLimit, inject: ['AUTH_CONFIG'], useFactory: (config: AuthConfig) => new AuthRateLimit(loadRuntimeConfig().redisUrl, config) },
    { provide: SessionService, inject: [DependencyHealthService, AuthProvider, 'AUTH_CONFIG'],
      useFactory: (health: DependencyHealthService, provider: AuthProvider, config: AuthConfig) => new SessionService(health.prisma, provider, config) }
  ], exports: [SessionService, AuthProvider, SessionGuard, CsrfProtection, ExternalProcessingService]
})
export class AuthModule {}
