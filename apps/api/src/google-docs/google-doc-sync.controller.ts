import { BadRequestException, Body, Controller, ForbiddenException, Get, Inject, Param, Post, Query, Req, UnauthorizedException, UseGuards } from '@nestjs/common';
import { ApiCookieAuth, ApiTags } from '@nestjs/swagger';
import { DependencyHealthService, EXTERNAL_PROCESSING_NOTICE, GoogleDocSyncService, googleSyncBackgroundInputSchema, googleSyncConfirmInputSchema, googleSyncPreviewInputSchema, googleSyncPullInputSchema, googleSyncReconcileInputSchema, type GoogleSyncActor } from '@contextflow/backend';
import { z } from 'zod';
import { SessionGuard, type AuthenticatedRequest } from '../auth/session.guard.js';
import { cookieValue, SESSION_COOKIE } from '../auth/csrf.js';
import { tokenDigest, validOpaqueToken } from '../auth/session-crypto.js';

@ApiTags('Google Docs synchronization')
@ApiCookieAuth('__Host-contextflow')
@UseGuards(SessionGuard)
@Controller('api/v1/projects/:projectId/google-docs/sync')
export class GoogleDocSyncController {
  constructor(@Inject(DependencyHealthService) private readonly health: DependencyHealthService,
    @Inject(GoogleDocSyncService) private readonly sync: GoogleDocSyncService) {}

  private parse<T>(schema: z.ZodType<T>, input: unknown): T {
    const result = schema.safeParse(input);
    if (!result.success) throw new BadRequestException('Invalid Google Docs synchronization request');
    return result.data;
  }

  private async actor(request: AuthenticatedRequest): Promise<GoogleSyncActor> {
    const cookie = cookieValue(request, SESSION_COOKIE);
    if (!validOpaqueToken(cookie)) throw new UnauthorizedException('Session expired');
    const [session, profile] = await Promise.all([
      this.health.prisma.appSession.findUnique({ where: { cookieDigest: tokenDigest(cookie) } }),
      this.health.prisma.userProfile.findUnique({ where: { id: request.sessionUser.id } }),
    ]);
    const now = Date.now();
    if (!session || !profile || session.userId !== request.sessionUser.id || session.revokedAt
      || session.expiresAt.getTime() <= now || now - session.lastUserActivityAt.getTime() >= profile.idleTimeoutMinutes * 60_000) {
      throw new UnauthorizedException('Session expired');
    }
    if (profile.externalProcessingNoticeVersion !== EXTERNAL_PROCESSING_NOTICE.version || !profile.externalProcessingAcceptedAt) {
      throw new ForbiddenException('Accept the external-processing notice before using Google Docs');
    }
    return { userId: session.userId, sessionId: session.id, noticeAcceptedAt: profile.externalProcessingAcceptedAt };
  }

  @Get()
  async status(@Req() request: AuthenticatedRequest, @Param('projectId') projectId: string, @Query('targetVersionId') versionId?: string): Promise<Awaited<ReturnType<GoogleDocSyncService['status']>>> {
    return this.sync.status(await this.actor(request), this.parse(z.uuid(), projectId), versionId === undefined ? undefined : this.parse(z.uuid(), versionId));
  }

  @Post('preview')
  async preview(@Req() request: AuthenticatedRequest, @Param('projectId') projectId: string, @Body() body: unknown): Promise<Awaited<ReturnType<GoogleDocSyncService['preview']>>> {
    return this.sync.preview(await this.actor(request), this.parse(z.uuid(), projectId), this.parse(googleSyncPreviewInputSchema, body));
  }

  @Post('confirm')
  async confirm(@Req() request: AuthenticatedRequest, @Param('projectId') projectId: string, @Body() body: unknown): Promise<Awaited<ReturnType<GoogleDocSyncService['confirm']>>> {
    return this.sync.confirm(await this.actor(request), this.parse(z.uuid(), projectId), this.parse(googleSyncConfirmInputSchema, body));
  }

  @Post('pull')
  async pull(@Req() request: AuthenticatedRequest, @Param('projectId') projectId: string, @Body() body: unknown): Promise<Awaited<ReturnType<GoogleDocSyncService['pull']>>> {
    return this.sync.pull(await this.actor(request), this.parse(z.uuid(), projectId), this.parse(googleSyncPullInputSchema, body));
  }

  @Post('operations/:operationId/reconcile')
  async reconcile(@Req() request: AuthenticatedRequest, @Param('projectId') projectId: string, @Param('operationId') operationId: string, @Body() body: unknown): Promise<Awaited<ReturnType<GoogleDocSyncService['reconcile']>>> {
    const input = this.parse(googleSyncReconcileInputSchema.omit({ operationId: true }), body);
    return this.sync.reconcile(await this.actor(request), this.parse(z.uuid(), projectId), { ...input, operationId: this.parse(z.uuid(), operationId) });
  }

  @Post('background')
  async background(@Req() request: AuthenticatedRequest, @Param('projectId') projectId: string, @Body() body: unknown): Promise<Awaited<ReturnType<GoogleDocSyncService['background']>>> {
    return this.sync.background(await this.actor(request), this.parse(z.uuid(), projectId), this.parse(googleSyncBackgroundInputSchema, body));
  }
}
