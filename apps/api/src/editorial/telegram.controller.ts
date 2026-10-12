import { BadRequestException, Body, Controller, Get, Inject, Param, Post, Query, Req, ServiceUnavailableException, UseGuards } from '@nestjs/common';
import { ApiCookieAuth, ApiTags } from '@nestjs/swagger';
import { TelegramService, adaptationFormatSchema, saveTelegramDraftInput, checkpointTelegramInput, reviewTelegramInput, rereviewTelegramInput, generateTelegramInput, telegramWorkflowRelease, jobView } from '@contextflow/backend';
import { z } from 'zod';
import { SessionGuard, type AuthenticatedRequest } from '../auth/session.guard.js';
function id(value: string) { if (!z.uuid().safeParse(value).success) throw new BadRequestException('Invalid resource identifier'); return value; }
function parse<T>(schema: z.ZodType<T>, body: unknown): T { const value = schema.safeParse(body); if (!value.success) throw new BadRequestException('Invalid adaptation input'); return value.data; }
type TelegramState = Awaited<ReturnType<TelegramService['get']>>;
@ApiTags('Telegram editor and review')
@ApiCookieAuth('__Host-contextflow')
@UseGuards(SessionGuard)
@Controller('api/v1/projects/:projectId/telegram')
export class TelegramController {
  constructor(@Inject(TelegramService) private readonly telegram: TelegramService) {}
  @Get()
  state(@Req() request: AuthenticatedRequest, @Param('projectId') project: string, @Query('format') rawFormat?: string): Promise<TelegramState> {
    const format = rawFormat === undefined ? 'TELEGRAM_POST' : parse(adaptationFormatSchema, rawFormat);
    return this.telegram.get(request.sessionUser.id, id(project), format);
  }
  @Post('draft')
  draft(@Req() request: AuthenticatedRequest, @Param('projectId') project: string, @Body() body: unknown): Promise<TelegramState> { return this.telegram.saveDraft(request.sessionUser.id, id(project), parse(saveTelegramDraftInput, body)); }
  @Post('checkpoint')
  checkpoint(@Req() request: AuthenticatedRequest, @Param('projectId') project: string, @Body() body: unknown): Promise<TelegramState> { return this.telegram.checkpoint(request.sessionUser.id, id(project), parse(checkpointTelegramInput, body)); }
  @Post('generate')
  async generate(@Req() request: AuthenticatedRequest, @Param('projectId') project: string, @Body() body: unknown): Promise<{ job: ReturnType<typeof jobView> }> {
    const input = parse(generateTelegramInput, body); let release;
    try { release = telegramWorkflowRelease(); } catch { throw new ServiceUnavailableException('The published channel workflow is not configured; manual editing remains available'); }
    const job = await this.telegram.freezeTelegram(request.sessionUser.id, id(project), input, release);
    return { job: { ...jobView(job), format: input.format } };
  }
  @Post(':revisionId/apply')
  apply(@Req() request: AuthenticatedRequest, @Param('projectId') project: string, @Param('revisionId') revision: string, @Body() body: unknown): Promise<TelegramState> { return this.telegram.review(request.sessionUser.id, id(project), id(revision), 'apply', parse(reviewTelegramInput, body)); }
  @Post(':revisionId/approve')
  approve(@Req() request: AuthenticatedRequest, @Param('projectId') project: string, @Param('revisionId') revision: string, @Body() body: unknown): Promise<TelegramState> { return this.telegram.review(request.sessionUser.id, id(project), id(revision), 'approve', parse(reviewTelegramInput, body)); }
  @Post(':revisionId/withdraw')
  withdraw(@Req() request: AuthenticatedRequest, @Param('projectId') project: string, @Param('revisionId') revision: string, @Body() body: unknown): Promise<TelegramState> { return this.telegram.review(request.sessionUser.id, id(project), id(revision), 'withdraw', parse(reviewTelegramInput, body)); }
  @Post(':revisionId/rereview')
  rereview(@Req() request: AuthenticatedRequest, @Param('projectId') project: string, @Param('revisionId') revision: string, @Body() body: unknown): Promise<TelegramState> { return this.telegram.rereview(request.sessionUser.id, id(project), id(revision), parse(rereviewTelegramInput, body)); }
}
