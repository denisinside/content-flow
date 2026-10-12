import { Module } from '@nestjs/common';
import { DependencyHealthService, FoundationModule } from '@contextflow/backend';
import { AuthModule } from '../auth/auth.module.js';
import { PresenceController } from './presence.controller.js';
import { PresenceSessionGuard } from './presence.guard.js';
import { PresenceService } from './presence.service.js';

@Module({ imports: [FoundationModule, AuthModule], controllers: [PresenceController], providers: [PresenceSessionGuard,
  { provide: PresenceService, inject: [DependencyHealthService], useFactory: (health: DependencyHealthService) => new PresenceService(health) }] })
export class PresenceModule {}
