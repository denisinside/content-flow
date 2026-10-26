import { BadRequestException, Body, Controller, Get, Inject, Param, Post, Req, ServiceUnavailableException, UseGuards } from '@nestjs/common';
import { ApiCookieAuth, ApiTags } from '@nestjs/swagger';
import { BriefProposalService, SourceWritingProviderError, briefProposalCommandSchema, jobView } from '@contextflow/backend';
import { z } from 'zod';
import { SessionGuard, type AuthenticatedRequest } from '../auth/session.guard.js';

function id(value: string) { if (!z.uuid().safeParse(value).success) throw new BadRequestException('Invalid resource identifier'); return value; }

@ApiTags('editorial brief proposal')
@ApiCookieAuth('__Host-contextflow')
@UseGuards(SessionGuard)
@Controller('api/v1/projects/:projectId/brief/proposals')
export class BriefProposalController {
  constructor(@Inject(BriefProposalService) private readonly proposals: BriefProposalService) {}

  @Get('config')
  config(@Req() request: AuthenticatedRequest, @Param('projectId') project: string) {
    return this.proposals.configured(request.sessionUser.id, id(project)).then(configured => ({ configured }));
  }

  @Post()
  async prepare(@Req() request: AuthenticatedRequest, @Param('projectId') project: string, @Body() body: unknown) {
    let input;
    try { input = briefProposalCommandSchema.parse(body); }
    catch { throw new BadRequestException('Invalid brief proposal input'); }
    try { return { job: jobView(await this.proposals.prepare(request.sessionUser.id, id(project), input)) }; }
    catch (error) {
      if (error instanceof SourceWritingProviderError && error.code === 'CONFIG') throw new ServiceUnavailableException('The published brief-proposal workflow is not configured');
      throw error;
    }
  }

  @Get(':jobId')
  get(@Req() request: AuthenticatedRequest, @Param('projectId') project: string, @Param('jobId') jobId: string) {
    return this.proposals.get(request.sessionUser.id, id(project), id(jobId));
  }
}
