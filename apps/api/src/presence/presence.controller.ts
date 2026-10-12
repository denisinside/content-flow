import { BadRequestException, Body, Controller, Get, Inject, Param, Post, Query, Req, Delete, UseGuards } from '@nestjs/common';
import { ApiCookieAuth, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { presenceHeartbeatSchema, presencePageSchema } from './presence.contracts.js';
import { PresenceService } from './presence.service.js';
import { PresenceSessionGuard, type PresenceRequest } from './presence.guard.js';

@ApiTags('Project presence')
@ApiCookieAuth('__Host-contextflow')
@UseGuards(PresenceSessionGuard)
@Controller('api/v1/projects/:projectId/presence')
export class PresenceController {
  constructor(@Inject(PresenceService) private readonly presence: PresenceService) {}

  private uuid(value: unknown, label: string): string {
    const parsed = z.uuid().safeParse(value);
    if (!parsed.success) throw new BadRequestException(`Invalid ${label}`);
    return parsed.data;
  }

  @Get()
  list(@Req() request: PresenceRequest, @Param('projectId') projectId: string, @Query('page') rawPage: unknown) {
    const page = presencePageSchema.safeParse(rawPage);
    if (!page.success) throw new BadRequestException('Invalid presence page');
    return this.presence.list(this.uuid(projectId, 'project identifier'), page.data,
      { userId: request.sessionUser.id, sessionId: request.presenceSessionId });
  }

  @Post()
  heartbeat(@Req() request: PresenceRequest, @Param('projectId') projectId: string, @Body() rawBody: unknown) {
    const input = presenceHeartbeatSchema.safeParse(rawBody);
    if (!input.success) throw new BadRequestException('Invalid presence heartbeat');
    return this.presence.heartbeat(this.uuid(projectId, 'project identifier'), input.data.page, input.data.clientId,
      { userId: request.sessionUser.id, sessionId: request.presenceSessionId });
  }

  @Delete()
  leave(@Req() request: PresenceRequest, @Param('projectId') projectId: string, @Body() rawBody: unknown) {
    const input = presenceHeartbeatSchema.safeParse(rawBody);
    if (!input.success) throw new BadRequestException('Invalid presence request');
    return this.presence.leave(this.uuid(projectId, 'project identifier'), input.data.page, input.data.clientId,
      { userId: request.sessionUser.id, sessionId: request.presenceSessionId });
  }
}
