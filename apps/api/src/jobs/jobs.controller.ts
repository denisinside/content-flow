import { BadRequestException, Controller, Get, Inject, Param, Post, Req, UseGuards } from '@nestjs/common';
import { ApiCookieAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { DurableJobService, jobView } from '@contextflow/backend';
import { z } from 'zod';
import { SessionGuard, type AuthenticatedRequest } from '../auth/session.guard.js';

function id(value: string): string {
  if (!z.uuid().safeParse(value).success) throw new BadRequestException('Invalid resource identifier');
  return value;
}
@ApiTags('jobs')
@ApiCookieAuth('__Host-contextflow')
@UseGuards(SessionGuard)
@Controller('api/v1/projects/:projectId/jobs')
export class JobsController {
  constructor(@Inject(DurableJobService) private readonly jobs: DurableJobService) {}
  @Get()
  @ApiOperation({ summary: 'List authorized DB-backed execution state' })
  async list(@Req() request: AuthenticatedRequest, @Param('projectId') projectId: string) {
    return { jobs: (await this.jobs.list(request.sessionUser.id, id(projectId))).map(jobView) };
  }
  @Get(':jobId')
  @ApiOperation({ summary: 'Poll execution without extending user activity' })
  async get(@Req() request: AuthenticatedRequest, @Param('projectId') projectId: string, @Param('jobId') jobId: string) {
    return { job: jobView(await this.jobs.get(request.sessionUser.id, id(projectId), id(jobId))) };
  }
  @Post(':jobId/cancel')
  @ApiOperation({ summary: 'Persist cancellation and fence late output' })
  async cancel(@Req() request: AuthenticatedRequest, @Param('projectId') projectId: string, @Param('jobId') jobId: string) {
    return { job: jobView(await this.jobs.cancel(request.sessionUser.id, id(projectId), id(jobId))) };
  }
  @Post(':jobId/retry')
  @ApiOperation({ summary: 'Retry frozen inputs only when the previous failure is known safe' })
  async retry(@Req() request: AuthenticatedRequest, @Param('projectId') projectId: string, @Param('jobId') jobId: string) {
    return { job: jobView(await this.jobs.retry(request.sessionUser.id, id(projectId), id(jobId))) };
  }
}
