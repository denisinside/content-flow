import { BadRequestException, Body, Controller, Get, Inject, Param, Post, Req, UseGuards } from '@nestjs/common';
import { ApiCookieAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { SourceEvidenceService, indexSourceEvidenceInput, searchSourceEvidenceInput } from '@contextflow/backend';
import { z } from 'zod';
import { SessionGuard, type AuthenticatedRequest } from '../auth/session.guard.js';

function id(value: string): string {
  if (!z.uuid().safeParse(value).success) throw new BadRequestException('Invalid resource identifier');
  return value;
}
function input<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new BadRequestException('Invalid source evidence request');
  return parsed.data;
}

@ApiTags('source evidence')
@ApiCookieAuth('__Host-contextflow')
@UseGuards(SessionGuard)
@Controller('api/v1/projects/:projectId/evidence')
export class EvidenceController {
  constructor(@Inject(SourceEvidenceService) private readonly evidence: SourceEvidenceService) {}

  @Get()
  @ApiOperation({ summary: 'Inspect selected factual sources and semantic index readiness' })
  list(@Req() request: AuthenticatedRequest, @Param('projectId') projectId: string) {
    return this.evidence.list(request.sessionUser.id, id(projectId));
  }

  @Post('index')
  @ApiOperation({ summary: 'Prepare durable embedding batches for selected current factual sources' })
  index(@Req() request: AuthenticatedRequest, @Param('projectId') projectId: string, @Body() body: unknown) {
    return this.evidence.index(request.sessionUser.id, id(projectId), input(indexSourceEvidenceInput, body));
  }

  @Post('search')
  @ApiOperation({ summary: 'Freeze a question and selected source indexes for hybrid evidence search' })
  search(@Req() request: AuthenticatedRequest, @Param('projectId') projectId: string, @Body() body: unknown) {
    return this.evidence.search(request.sessionUser.id, id(projectId), input(searchSourceEvidenceInput, body));
  }

  @Get('search/:jobId')
  @ApiOperation({ summary: 'Read a durable search result and exact captured source passages' })
  result(@Req() request: AuthenticatedRequest, @Param('projectId') projectId: string, @Param('jobId') jobId: string) {
    return this.evidence.result(request.sessionUser.id, id(projectId), id(jobId));
  }
}
