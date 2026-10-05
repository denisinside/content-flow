import { BadRequestException, Body, Controller, Get, Inject, Param, Post, Req, ServiceUnavailableException, UseGuards } from '@nestjs/common';
import { ApiCookieAuth, ApiTags } from '@nestjs/swagger';
import { EditorialService, saveBriefInput, manualOutlineInput, reviewOutlineInput, generateOutlineInput, outlineWorkflowRelease, jobView } from '@contextflow/backend';
import { z } from 'zod';
import { SessionGuard, type AuthenticatedRequest } from '../auth/session.guard.js';

function id(value: string) { if (!z.uuid().safeParse(value).success) throw new BadRequestException('Invalid resource identifier'); return value; }
function parse<T>(schema: z.ZodType<T>, body: unknown): T { const result = schema.safeParse(body); if (!result.success) throw new BadRequestException('Invalid editorial input'); return result.data; }
@ApiTags('editorial brief and outline')
@ApiCookieAuth('__Host-contextflow')
@UseGuards(SessionGuard)
@Controller('api/v1/projects/:projectId')
export class EditorialController {
  constructor(@Inject(EditorialService) private readonly editorial: EditorialService) {}
  @Get(['editorial', 'brief'])
  state(@Req() request: AuthenticatedRequest, @Param('projectId') project: string) { return this.editorial.get(request.sessionUser.id, id(project)); }
  @Get('outline')
  outline(@Req() request: AuthenticatedRequest, @Param('projectId') project: string) { return this.editorial.get(request.sessionUser.id, id(project)); }
  @Post('brief')
  brief(@Req() request: AuthenticatedRequest, @Param('projectId') project: string, @Body() body: unknown) { return this.editorial.saveBrief(request.sessionUser.id, id(project), parse(saveBriefInput, body)); }
  @Post('outline/manual')
  manual(@Req() request: AuthenticatedRequest, @Param('projectId') project: string, @Body() body: unknown) { return this.editorial.manualOutline(request.sessionUser.id, id(project), parse(manualOutlineInput, body)); }
  @Post('outline/generate')
  async generate(@Req() request: AuthenticatedRequest, @Param('projectId') project: string, @Body() body: unknown) {
    const input = parse(generateOutlineInput, body);
    let release;
    try { release = outlineWorkflowRelease(); } catch { throw new ServiceUnavailableException('The published outline workflow is not configured; manual outlines remain available'); }
    return { job: jobView(await this.editorial.freezeOutline(request.sessionUser.id, id(project), input.commandKey, release)) };
  }
  @Post('outline/:revisionId/apply')
  apply(@Req() request: AuthenticatedRequest, @Param('projectId') project: string, @Param('revisionId') revision: string, @Body() body: unknown) { return this.editorial.reviewOutline(request.sessionUser.id, id(project), id(revision), 'apply', parse(reviewOutlineInput, body)); }
  @Post('outline/:revisionId/approve')
  approve(@Req() request: AuthenticatedRequest, @Param('projectId') project: string, @Param('revisionId') revision: string, @Body() body: unknown) { return this.editorial.reviewOutline(request.sessionUser.id, id(project), id(revision), 'approve', parse(reviewOutlineInput, body)); }
  @Post('outline/:revisionId/withdraw')
  withdraw(@Req() request: AuthenticatedRequest, @Param('projectId') project: string, @Param('revisionId') revision: string, @Body() body: unknown) { return this.editorial.reviewOutline(request.sessionUser.id, id(project), id(revision), 'withdraw', parse(reviewOutlineInput, body)); }
}
