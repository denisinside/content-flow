import { BadRequestException, Body, Controller, ForbiddenException, Get, Inject, Injectable, Post, Req, UseGuards } from '@nestjs/common';
import { ApiBody, ApiCookieAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { DependencyHealthService } from '@contextflow/backend';
import { z } from 'zod';
import { SessionGuard, type AuthenticatedRequest } from './session.guard.js';

export const EXTERNAL_PROCESSING_NOTICE = Object.freeze({
  version: '2026-09-28-v1',
  text: 'Вибрані вами матеріали можуть передаватися зовнішнім сервісам для імпорту, перетворення документів і роботи ШІ. Передаються лише матеріали, потрібні для обраної дії. Перевіряйте отримані результати перед використанням.',
});
const acceptanceInput = z.object({ noticeVersion: z.literal(EXTERNAL_PROCESSING_NOTICE.version) }).strict();

@Injectable()
export class ExternalProcessingService {
  constructor(@Inject(DependencyHealthService) private readonly health: DependencyHealthService) {}

  async status(userId: string) {
    const profile = await this.health.prisma.userProfile.findUniqueOrThrow({ where: { id: userId },
      select: { externalProcessingNoticeVersion: true, externalProcessingAcceptedAt: true } });
    const accepted = profile.externalProcessingNoticeVersion === EXTERNAL_PROCESSING_NOTICE.version && profile.externalProcessingAcceptedAt !== null;
    return { notice: EXTERNAL_PROCESSING_NOTICE, accepted, acceptedAt: accepted ? profile.externalProcessingAcceptedAt!.toISOString() : null };
  }

  async accept(userId: string) {
    // Replay of the current notice keeps its first accepted timestamp, including concurrent requests.
    await this.health.prisma.userProfile.updateMany({ where: { id: userId, OR: [
      { externalProcessingNoticeVersion: null }, { externalProcessingNoticeVersion: { not: EXTERNAL_PROCESSING_NOTICE.version } },
    ] }, data: { externalProcessingNoticeVersion: EXTERNAL_PROCESSING_NOTICE.version, externalProcessingAcceptedAt: new Date() } });
    return this.status(userId);
  }

  async requireAccepted(userId: string): Promise<void> {
    if (!(await this.status(userId)).accepted) throw new ForbiddenException('Accept the external-processing notice before using external services');
  }
}

@ApiTags('identity')
@ApiCookieAuth('__Host-contextflow')
@ApiResponse({ status: 401, description: 'Session expired' })
@UseGuards(SessionGuard)
@Controller('api/auth/external-processing')
export class ExternalProcessingController {
  constructor(@Inject(ExternalProcessingService) private readonly processing: ExternalProcessingService) {}

  @Get()
  @ApiOperation({ summary: 'Read the current external-processing notice and personal acceptance' })
  status(@Req() request: AuthenticatedRequest) { return this.processing.status(request.sessionUser.id); }

  @Post()
  @ApiOperation({ summary: 'Explicitly accept the current notice; retain first acceptance time' })
  @ApiBody({ schema: { type: 'object', required: ['noticeVersion'], additionalProperties: false,
    properties: { noticeVersion: { type: 'string', enum: [EXTERNAL_PROCESSING_NOTICE.version] } } } })
  accept(@Req() request: AuthenticatedRequest, @Body() body: unknown) {
    if (!acceptanceInput.safeParse(body).success) throw new BadRequestException('Accept the current notice version explicitly');
    return this.processing.accept(request.sessionUser.id);
  }
}
