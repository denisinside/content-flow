import { Module } from '@nestjs/common';
import { FoundationModule } from '@contextflow/backend';
import { HealthController } from './health/health.controller.js';
import { AuthModule } from './auth/auth.module.js';

@Module({
  imports: [FoundationModule, AuthModule],
  controllers: [HealthController],
})
export class AppModule {}
