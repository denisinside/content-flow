import {
  Controller,
  Get,
  Inject,
  ServiceUnavailableException,
} from '@nestjs/common';
import { DependencyHealthService, DurableJobWorker } from '@contextflow/backend';

class WorkerLivenessResponse {
  status!: 'ok';
  service!: 'worker';
}

class WorkerReadinessResponse {
  status!: 'ready' | 'not_ready';
  checks!: {
    database: 'up' | 'down';
    redis: 'up' | 'down';
    dispatcher: 'up' | 'down';
  };
}

@Controller('health')
export class HealthController {
  constructor(
    @Inject(DependencyHealthService)
    private readonly dependencyHealth: DependencyHealthService,
    @Inject(DurableJobWorker) private readonly jobs: DurableJobWorker,
  ) {}

  @Get('live')
  live(): WorkerLivenessResponse {
    return { status: 'ok', service: 'worker' };
  }

  @Get('ready')
  async ready(): Promise<WorkerReadinessResponse> {
    const dependencies = await this.dependencyHealth.check();
    const dispatcher = this.jobs.lastReconcileAt !== null && this.jobs.lastDispatchError === null ? 'up' : 'down';
    const readiness: WorkerReadinessResponse = { status: dependencies.status === 'ready' && dispatcher === 'up' ? 'ready' : 'not_ready',
      checks: { ...dependencies.checks, dispatcher } };
    if (readiness.status === 'not_ready') {
      throw new ServiceUnavailableException(readiness);
    }
    return readiness;
  }
}
