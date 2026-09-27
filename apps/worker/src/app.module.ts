import { Module } from '@nestjs/common';
import { FoundationModule } from '@contextflow/backend';
import { HealthController } from './health/health.controller.js';

@Module({
  imports: [FoundationModule],
  controllers: [HealthController],
})
export class AppModule {}
