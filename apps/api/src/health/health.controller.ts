import {
  Controller,
  Get,
  Inject,
  ServiceUnavailableException,
} from '@nestjs/common';
import {
  ApiOkResponse,
  ApiServiceUnavailableResponse,
  ApiTags,
} from '@nestjs/swagger';
import type { SchemaObject } from '@nestjs/swagger';
import { DependencyHealthService } from '@contextflow/backend';

class LivenessResponse {
  status!: 'ok';
  service!: 'api';
}

class ReadinessChecks {
  database!: 'up' | 'down';
  redis!: 'up' | 'down';
}

class ReadinessResponse {
  status!: 'ready' | 'not_ready';
  checks!: ReadinessChecks;
}

const livenessSchema: SchemaObject = {
  type: 'object',
  required: ['status', 'service'],
  properties: {
    status: { type: 'string', enum: ['ok'] },
    service: { type: 'string', enum: ['api'] },
  },
};

const readinessSchema: SchemaObject = {
  type: 'object',
  required: ['status', 'checks'],
  properties: {
    status: { type: 'string', enum: ['ready', 'not_ready'] },
    checks: {
      type: 'object',
      required: ['database', 'redis'],
      properties: {
        database: { type: 'string', enum: ['up', 'down'] },
        redis: { type: 'string', enum: ['up', 'down'] },
      },
    },
  },
};

@ApiTags('health')
@Controller('api/health')
export class HealthController {
  constructor(
    @Inject(DependencyHealthService)
    private readonly dependencyHealth: Pick<DependencyHealthService, 'check'>,
  ) {}

  @Get('live')
  @ApiOkResponse({ schema: livenessSchema })
  live(): LivenessResponse {
    return { status: 'ok', service: 'api' };
  }

  @Get('ready')
  @ApiOkResponse({ schema: readinessSchema })
  @ApiServiceUnavailableResponse({
    description: 'One or more required dependencies are unavailable.',
    schema: readinessSchema,
  })
  async ready(): Promise<ReadinessResponse> {
    const readiness = await this.dependencyHealth.check();
    if (readiness.status === 'not_ready') {
      throw new ServiceUnavailableException(readiness);
    }
    return readiness;
  }
}
