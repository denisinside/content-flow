import { BadRequestException, Body, Controller, Get, HttpCode, Inject, Param, Patch, Post, Query, Req, UseGuards } from '@nestjs/common';
import { ApiBody, ApiCookieAuth, ApiOperation, ApiQuery, ApiResponse, ApiTags } from '@nestjs/swagger';
import { SessionGuard, type AuthenticatedRequest } from '../auth/session.guard.js';
import { WorkspaceInviteResultDto, WorkspaceResultDto, WorkspaceStyleResultDto, WorkspacesPageDto } from './workspace.dto.js';
import { acceptInviteInput, createWorkspaceInput, inviteInput, listWorkspacesInput, transferInput, updateStyleInput, workspaceIdInput } from './workspace-input.js';
import { WorkspaceService } from './workspace.service.js';

function id(value: string) {
  const parsed = workspaceIdInput.safeParse(value);
  if (!parsed.success) throw new BadRequestException('Invalid resource identifier');
  return parsed.data;
}

@ApiTags('workspaces')
@ApiCookieAuth('__Host-contextflow')
@ApiResponse({ status: 401, description: 'Session expired' })
@ApiResponse({ status: 404, description: 'Resource not found or not accessible' })
@UseGuards(SessionGuard)
@Controller('api/v1/workspaces')
export class WorkspacesController {
  constructor(@Inject(WorkspaceService) private readonly workspaces: WorkspaceService) {}

  @Get()
  @ApiOperation({ summary: 'List Workspaces with current active membership' })
  @ApiQuery({ name: 'cursor', required: false, type: String, format: 'uuid' })
  @ApiResponse({ status: 200, type: WorkspacesPageDto })
  list(@Req() request: AuthenticatedRequest, @Query() query: unknown) {
    const parsed = listWorkspacesInput.safeParse(query);
    if (!parsed.success) throw new BadRequestException('Invalid Workspace query');
    return this.workspaces.list(request.sessionUser.id, parsed.data.cursor);
  }

  @Post()
  @ApiOperation({ summary: 'Create a named Workspace with its owner membership and first style revision' })
  @ApiBody({ schema: { type: 'object', required: ['name'], additionalProperties: false, properties: { name: { type: 'string', minLength: 1, maxLength: 120 } } } })
  @ApiResponse({ status: 201, type: WorkspaceResultDto })
  create(@Req() request: AuthenticatedRequest, @Body() body: unknown) {
    const parsed = createWorkspaceInput.safeParse(body);
    if (!parsed.success) throw new BadRequestException('Invalid Workspace input');
    return this.workspaces.create(request.sessionUser.id, parsed.data.name);
  }

  @Get(':workspaceId')
  @ApiOperation({ summary: 'Open an accessible Workspace and its active members' })
  @ApiResponse({ status: 200, type: WorkspaceResultDto })
  get(@Req() request: AuthenticatedRequest, @Param('workspaceId') workspaceId: string) {
    return this.workspaces.get(request.sessionUser.id, id(workspaceId));
  }

  @Post(':workspaceId/invites')
  @ApiOperation({ summary: 'Owner creates a targeted 48-hour invitation; token is returned once for manual delivery' })
  @ApiBody({ schema: { type: 'object', required: ['email'], additionalProperties: false, properties: { email: { type: 'string', format: 'email', maxLength: 254 } } } })
  @ApiResponse({ status: 201, type: WorkspaceInviteResultDto })
  invite(@Req() request: AuthenticatedRequest, @Param('workspaceId') workspaceId: string, @Body() body: unknown) {
    const parsed = inviteInput.safeParse(body);
    if (!parsed.success) throw new BadRequestException('Invalid invitation input');
    return this.workspaces.invite(request.sessionUser, id(workspaceId), parsed.data.email);
  }

  @Post(':workspaceId/leave')
  @HttpCode(204)
  @ApiOperation({ summary: 'Member leaves; sole-owner departure archives while retaining recovery custody' })
  @ApiResponse({ status: 204, description: 'Left or archived' })
  leave(@Req() request: AuthenticatedRequest, @Param('workspaceId') workspaceId: string) {
    return this.workspaces.leave(request.sessionUser.id, id(workspaceId));
  }

  @Post(':workspaceId/transfer')
  @ApiOperation({ summary: 'Owner atomically transfers ownership to an active member' })
  @ApiBody({ schema: { type: 'object', required: ['userId'], additionalProperties: false, properties: { userId: { type: 'string', format: 'uuid' } } } })
  @ApiResponse({ status: 201, type: WorkspaceResultDto })
  transfer(@Req() request: AuthenticatedRequest, @Param('workspaceId') workspaceId: string, @Body() body: unknown) {
    const parsed = transferInput.safeParse(body);
    if (!parsed.success) throw new BadRequestException('Invalid transfer input');
    return this.workspaces.transfer(request.sessionUser.id, id(workspaceId), parsed.data.userId);
  }

  @Post(':workspaceId/archive')
  @ApiOperation({ summary: 'Sole owner archives a Workspace without deleting history' })
  @ApiResponse({ status: 201, type: WorkspaceResultDto })
  archive(@Req() request: AuthenticatedRequest, @Param('workspaceId') workspaceId: string) {
    return this.workspaces.archive(request.sessionUser.id, id(workspaceId));
  }

  @Post(':workspaceId/restore')
  @ApiOperation({ summary: 'Owner restores an archived Workspace' })
  @ApiResponse({ status: 201, type: WorkspaceResultDto })
  restore(@Req() request: AuthenticatedRequest, @Param('workspaceId') workspaceId: string) {
    return this.workspaces.restore(request.sessionUser.id, id(workspaceId));
  }

  @Get(':workspaceId/style')
  @ApiOperation({ summary: 'Read the current immutable Workspace style revision' })
  @ApiResponse({ status: 200, type: WorkspaceStyleResultDto })
  style(@Req() request: AuthenticatedRequest, @Param('workspaceId') workspaceId: string) {
    return this.workspaces.style(request.sessionUser.id, id(workspaceId));
  }

  @Patch(':workspaceId/style')
  @ApiOperation({ summary: 'Create a new Workspace style revision using optimistic concurrency' })
  @ApiBody({ schema: { type: 'object', required: ['expectedRevision'], additionalProperties: false, properties: {
    expectedRevision: { type: 'integer', minimum: 1 }, brandbook: { type: 'string', maxLength: 50000 },
    tone: { type: 'string', maxLength: 10000 }, settings: { type: 'object', additionalProperties: { oneOf: [{ type: 'string' }, { type: 'number' }, { type: 'boolean' }] } }
  } } })
  @ApiResponse({ status: 200, type: WorkspaceStyleResultDto })
  @ApiResponse({ status: 409, description: 'Concurrent edit or archived Workspace' })
  updateStyle(@Req() request: AuthenticatedRequest, @Param('workspaceId') workspaceId: string, @Body() body: unknown) {
    const parsed = updateStyleInput.safeParse(body);
    if (!parsed.success) throw new BadRequestException('Invalid Workspace style input');
    return this.workspaces.updateStyle(request.sessionUser.id, id(workspaceId), parsed.data);
  }
}

@ApiTags('workspace-invites')
@ApiCookieAuth('__Host-contextflow')
@ApiResponse({ status: 401, description: 'Session expired' })
@UseGuards(SessionGuard)
@Controller('api/v1/workspace-invites')
export class WorkspaceInvitesController {
  constructor(@Inject(WorkspaceService) private readonly workspaces: WorkspaceService) {}

  @Post('accept')
  @ApiOperation({ summary: 'Accept a targeted invitation with the matching signed-in account' })
  @ApiBody({ schema: { type: 'object', required: ['token'], additionalProperties: false, properties: { token: { type: 'string', minLength: 43, maxLength: 43 } } } })
  @ApiResponse({ status: 201, type: WorkspaceResultDto })
  accept(@Req() request: AuthenticatedRequest, @Body() body: unknown) {
    const parsed = acceptInviteInput.safeParse(body);
    if (!parsed.success) throw new BadRequestException('Invalid invitation input');
    return this.workspaces.accept(request.sessionUser, parsed.data.token);
  }
}
