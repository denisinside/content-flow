import { Body, Controller, Get, Inject, Param, Post, Req, UseGuards } from '@nestjs/common';
import { ApiBody, ApiCookieAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { SessionGuard, type AuthenticatedRequest } from '../auth/session.guard.js';
import { GoogleDocBindingService } from './google-doc-binding.service.js';

@ApiTags('Google Docs binding')
@ApiCookieAuth('__Host-contextflow')
@UseGuards(SessionGuard)
@Controller('api/v1/projects/:projectId/google-docs')
export class GoogleDocBindingController {
  constructor(@Inject(GoogleDocBindingService) private readonly bindings: GoogleDocBindingService) {}

  @Get('binding')
  @ApiOperation({ summary: 'Read the active project Google Doc binding and its latest immutable snapshot' })
  get(@Req() request: AuthenticatedRequest, @Param('projectId') projectId: string): Promise<Awaited<ReturnType<GoogleDocBindingService['get']>>> {
    return this.bindings.get(request, projectId);
  }

  @Post('inspect')
  @ApiOperation({ summary: 'Inspect a selected Google Doc and list its available tabs without importing content' })
  @ApiBody({ schema: { type: 'object', additionalProperties: false, required: ['connectionId', 'documentId'], properties: {
    connectionId: { type: 'string', format: 'uuid' }, documentId: { type: 'string', minLength: 1, maxLength: 1024 },
  } } })
  inspect(@Req() request: AuthenticatedRequest, @Param('projectId') projectId: string, @Body() body: unknown): Promise<Awaited<ReturnType<GoogleDocBindingService['inspect']>>> {
    return this.bindings.inspect(request, projectId, body);
  }

  @Post('bind')
  @ApiOperation({ summary: 'Bind one explicitly selected Google Docs tab to an Article project and capture an immutable snapshot' })
  @ApiBody({ schema: { type: 'object', additionalProperties: false, required: ['connectionId', 'documentId', 'tabId', 'commandKey', 'expectedArticleRevision', 'acknowledgeWorkspaceSharing'], properties: {
    connectionId: { type: 'string', format: 'uuid' }, documentId: { type: 'string', minLength: 1, maxLength: 1024 }, tabId: { type: 'string', minLength: 1, maxLength: 128 },
    commandKey: { type: 'string', format: 'uuid' }, expectedArticleRevision: { type: 'integer', minimum: 0 }, acknowledgeWorkspaceSharing: { type: 'boolean', enum: [true] },
  } } })
  bind(@Req() request: AuthenticatedRequest, @Param('projectId') projectId: string, @Body() body: unknown): Promise<Awaited<ReturnType<GoogleDocBindingService['bind']>>> {
    return this.bindings.bind(request, projectId, body);
  }

  @Post('unbind')
  @ApiOperation({ summary: 'End the active Google Docs binding while preserving its immutable history' })
  @ApiBody({ schema: { type: 'object', additionalProperties: false, required: ['expectedBindingId'], properties: {
    expectedBindingId: { type: 'string', format: 'uuid' },
  } } })
  unbind(@Req() request: AuthenticatedRequest, @Param('projectId') projectId: string, @Body() body: unknown): Promise<Awaited<ReturnType<GoogleDocBindingService['unbind']>>> {
    return this.bindings.unbind(request, projectId, body);
  }
}
