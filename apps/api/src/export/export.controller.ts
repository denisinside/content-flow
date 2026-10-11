import { BadRequestException, Body, Controller, Get, Inject, Param, Post, Req, Res, ServiceUnavailableException, UnauthorizedException, UseGuards } from '@nestjs/common';
import { ApiCookieAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { ServerResponse } from 'node:http';
import { ExportService, createExportInput } from '@contextflow/backend';
import { z } from 'zod';
import { SessionGuard, type AuthenticatedRequest } from '../auth/session.guard.js';
import { SessionService } from '../auth/session-service.js';
import { cookieValue, SESSION_COOKIE, setCookie } from '../auth/csrf.js';

function id(value: string): string {
  const parsed = z.uuid().safeParse(value);
  if (!parsed.success) throw new BadRequestException('Invalid resource identifier');
  return parsed.data;
}
function attachmentHeader(filename: string): string {
  const clean = filename.replace(/[\u0000-\u001F\u007F]/gu, '').replace(/[\\/]/gu, '_').slice(0, 200) || 'export.txt';
  const fallback = clean.normalize('NFKD').replace(/[^\x20-\x7e]/gu, '_').replace(/["\\;]/gu, '_');
  const encoded = encodeURIComponent(clean).replace(/[!'()*]/gu, character => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}

@ApiTags('reviewed exports')
@ApiCookieAuth('__Host-contextflow')
@UseGuards(SessionGuard)
@Controller('api/v1/projects/:projectId/exports')
export class ExportController {
  constructor(@Inject(ExportService) private readonly exports: ExportService, @Inject(SessionService) private readonly sessions: SessionService) {}

  @Get()
  @ApiOperation({ summary: 'Show selected output readiness and export history' })
  list(@Req() request: AuthenticatedRequest, @Param('projectId') projectId: string): Promise<Awaited<ReturnType<ExportService['readiness']>>> {
    return this.exports.readiness(request.sessionUser.id, id(projectId));
  }

  @Post()
  @ApiOperation({ summary: 'Freeze selected currently approved revisions into an immutable export job' })
  async create(@Req() request: AuthenticatedRequest, @Param('projectId') projectId: string, @Body() body: unknown) {
    const parsed = createExportInput.safeParse(body);
    if (!parsed.success) throw new BadRequestException('Invalid export selection');
    return this.exports.freeze(request.sessionUser.id, id(projectId), parsed.data);
  }

  @Get(':exportId/download')
  @ApiOperation({ summary: 'Download a current private export after rechecking session, membership, and selected dependencies' })
  async download(@Req() request: AuthenticatedRequest, @Param('projectId') projectId: string, @Param('exportId') exportId: string, @Res() response: ServerResponse) {
    const project = id(projectId), artifact = id(exportId);
    const file = await this.exports.download(request.sessionUser.id, project, artifact);
    const session = await this.sessions.check(cookieValue(request, SESSION_COOKIE), false);
    if (session.kind === 'unavailable') throw new ServiceUnavailableException('Authentication temporarily unavailable');
    if (session.kind !== 'active' || session.user.id !== request.sessionUser.id) {
      setCookie(response, SESSION_COOKIE, '', 0);
      throw new UnauthorizedException('Session expired');
    }
    await this.exports.assertDownloadReadable(request.sessionUser.id, project, artifact);
    response.statusCode = 200;
    response.setHeader('Content-Type', file.contentType);
    response.setHeader('Content-Length', file.bytes.byteLength);
    response.setHeader('Content-Disposition', attachmentHeader(file.filename));
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.end(file.bytes);
  }
}
