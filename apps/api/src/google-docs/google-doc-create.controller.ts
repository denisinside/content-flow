import { Body, Controller, Get, Inject, Param, Post, Req, UseGuards } from '@nestjs/common';
import { ApiBody, ApiCookieAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { SessionGuard, type AuthenticatedRequest } from '../auth/session.guard.js';
import { GoogleDocCreateService } from './google-doc-create.service.js';

@ApiTags('Google Docs create')
@ApiCookieAuth('__Host-contextflow')
@UseGuards(SessionGuard)
@Controller('api/v1/projects/:projectId/google-docs')
export class GoogleDocCreateController {
  constructor(@Inject(GoogleDocCreateService) private readonly creates: GoogleDocCreateService) {}

  @Get('create-commands')
  @ApiOperation({ summary: 'List this member’s recent Google Doc create commands for the Project' })
  list(@Req() request: AuthenticatedRequest, @Param('projectId') projectId: string): Promise<Awaited<ReturnType<GoogleDocCreateService['list']>>> {
    return this.creates.list(request, projectId);
  }

  @Post('create')
  @ApiOperation({ summary: 'Create one blank Google Doc with a durable outcome journal' })
  @ApiBody({ schema: { type: 'object', additionalProperties: false,
    required: ['connectionId', 'commandKey', 'title', 'expectedArticleRevision'], properties: {
      connectionId: { type: 'string', format: 'uuid' }, commandKey: { type: 'string', format: 'uuid' },
      title: { type: 'string', minLength: 1, maxLength: 200 }, expectedArticleRevision: { type: 'integer', minimum: 0 },
    } } })
  create(@Req() request: AuthenticatedRequest, @Param('projectId') projectId: string, @Body() body: unknown): Promise<Awaited<ReturnType<GoogleDocCreateService['create']>>> {
    return this.creates.create(request, projectId, body);
  }

  @Post('create-commands/:commandId/reconcile')
  @ApiOperation({ summary: 'Search Google Drive for the exact create marker and record its outcome without creating another document' })
  @ApiBody({ schema: { type: 'object', additionalProperties: false, required: ['connectionId'], properties: {
    connectionId: { type: 'string', format: 'uuid' },
  } } })
  reconcile(@Req() request: AuthenticatedRequest, @Param('projectId') projectId: string, @Param('commandId') commandId: string,
    @Body() body: unknown): Promise<Awaited<ReturnType<GoogleDocCreateService['reconcile']>>> {
    return this.creates.reconcile(request, projectId, commandId, body);
  }
}
