import { BadRequestException, Body, Controller, Get, Inject, Param, Post, Query, Req, UseGuards } from '@nestjs/common';
import { ApiCookieAuth, ApiTags } from '@nestjs/swagger';
import { ScriptService, scriptSaveDraftInput, scriptCheckpointInput, scriptReviewInput } from '@contextflow/backend';
import { z } from 'zod';
import { SessionGuard, type AuthenticatedRequest } from '../auth/session.guard.js';
type ScriptState = Awaited<ReturnType<ScriptService['get']>>;

function id(value: string) { if (!z.uuid().safeParse(value).success) throw new BadRequestException('Invalid resource identifier'); return value; }
function parse<T>(schema: z.ZodType<T>, body: unknown): T { const parsed = schema.safeParse(body); if (!parsed.success) throw new BadRequestException('Invalid script input'); return parsed.data; }

@ApiTags('Designer scripts')
@ApiCookieAuth('__Host-contextflow')
@UseGuards(SessionGuard)
@Controller('api/v1/projects/:projectId/scripts')
export class ScriptController {
  constructor(@Inject(ScriptService) private readonly scripts: ScriptService) {}
  @Get()
  state(@Req() request: AuthenticatedRequest, @Param('projectId') project: string, @Query('format') format: string): Promise<ScriptState> {
    return this.scripts.get(request.sessionUser.id, id(project), format);
  }
  @Post('draft')
  draft(@Req() request: AuthenticatedRequest, @Param('projectId') project: string, @Query('format') format: string, @Body() body: unknown): Promise<ScriptState> {
    return this.scripts.saveDraft(request.sessionUser.id, id(project), format, parse(scriptSaveDraftInput, body));
  }
  @Post('checkpoint')
  checkpoint(@Req() request: AuthenticatedRequest, @Param('projectId') project: string, @Query('format') format: string, @Body() body: unknown): Promise<ScriptState> {
    return this.scripts.checkpoint(request.sessionUser.id, id(project), format, parse(scriptCheckpointInput, body));
  }
  @Post('revisions/:revisionId/apply')
  apply(@Req() request: AuthenticatedRequest, @Param('projectId') project: string, @Param('revisionId') revision: string, @Query('format') format: string, @Body() body: unknown): Promise<ScriptState> {
    return this.scripts.review(request.sessionUser.id, id(project), format, id(revision), 'apply', parse(scriptReviewInput, body));
  }
  @Post('revisions/:revisionId/approve')
  approve(@Req() request: AuthenticatedRequest, @Param('projectId') project: string, @Param('revisionId') revision: string, @Query('format') format: string, @Body() body: unknown): Promise<ScriptState> {
    return this.scripts.review(request.sessionUser.id, id(project), format, id(revision), 'approve', parse(scriptReviewInput, body));
  }
  @Post('revisions/:revisionId/withdraw')
  withdraw(@Req() request: AuthenticatedRequest, @Param('projectId') project: string, @Param('revisionId') revision: string, @Query('format') format: string, @Body() body: unknown): Promise<ScriptState> {
    return this.scripts.review(request.sessionUser.id, id(project), format, id(revision), 'withdraw', parse(scriptReviewInput, body));
  }
}
