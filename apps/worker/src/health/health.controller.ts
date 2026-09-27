import {
  Controller,
  Get,
  Inject,
  ServiceUnavailableException,
} from '@nestjs/common';
import { DependencyHealthService } from '@contextflow/backend';

class WorkerLivenessResponse {
  status!: 'ok';
  service!: 'worker';
}

class WorkerReadinessResponse {
  status!: 'ready' | 'not_ready';
  checks!: {
    database: 'up' | 'down';
    redis: 'up' | 'down';
  };
}

@Controller('health')
export class HealthController {
  constructor(
    @Inject(DependencyHealthService)
    private readonly dependencyHealth: DependencyHealthService,
  ) {}

  @Get('live')
  live(): WorkerLivenessResponse {
    return { status: 'ok', service: 'worker' };
  }

  @Get('ready')
  async ready(): Promise<WorkerReadinessResponse> {
    const readiness = await this.dependencyHealth.check();
    if (readiness.status === 'not_ready') {
      throw new ServiceUnavailableException(readiness);
    }
    return readiness;
  }
}
