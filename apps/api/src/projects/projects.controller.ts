import { BadRequestException, Body, Controller, Get, Inject, Param, Patch, Post, Query, Req, UseGuards } from '@nestjs/common';
import { ApiBody, ApiCookieAuth, ApiOperation, ApiQuery, ApiResponse, ApiTags } from '@nestjs/swagger';
import { ProjectFormat } from '@contextflow/backend';
import { SessionGuard, type AuthenticatedRequest } from '../auth/session.guard.js';
import { ProjectService } from './project.service.js';
import { ProjectResultDto, ProjectsPageDto, AssetMetadataResultDto } from './project.dto.js';
import { createProjectInput, listProjectsInput, projectIdInput, updateProjectInput } from './project-input.js';

const formatsSchema = { type: 'array' as const, minItems: 1, maxItems: Object.keys(ProjectFormat).length, uniqueItems: true, items: { type: 'string' as const, enum: Object.values(ProjectFormat) } };
function id(value: string): string {
  const parsed = projectIdInput.safeParse(value);
  if (!parsed.success) throw new BadRequestException('Invalid resource identifier');
  return parsed.data;
}

@ApiTags('projects')
@ApiCookieAuth('__Host-contextflow')
@ApiResponse({ status: 401, description: 'Session expired' })
@ApiResponse({ status: 404, description: 'Resource not found or not accessible' })
@UseGuards(SessionGuard)
@Controller('api/v1/projects')
export class ProjectsController {
  constructor(@Inject(ProjectService) private readonly projects: ProjectService) {}

  @Get()
  @ApiQuery({ name: 'cursor', required: false, type: String, format: 'uuid' })
  @ApiQuery({ name: 'workspaceId', required: false, type: String, format: 'uuid' })
  @ApiResponse({ status: 200, type: ProjectsPageDto })
  @ApiOperation({ summary: 'List projects in Workspaces with current active membership' })
  async list(@Req() request: AuthenticatedRequest, @Query() query: unknown) {
    const parsed = listProjectsInput.safeParse(query);
    if (!parsed.success) throw new BadRequestException('Invalid project query');
    return this.projects.list(request.sessionUser.id, parsed.data.cursor, parsed.data.workspaceId);
  }

  @Post()
  @ApiResponse({ status: 201, type: ProjectResultDto })
  @ApiOperation({ summary: 'Create a project in an active Workspace' })
  @ApiBody({ schema: { type: 'object', required: ['workspaceId', 'topic', 'formats'], additionalProperties: false, properties: { workspaceId: { type: 'string', format: 'uuid' }, topic: { type: 'string', minLength: 1, maxLength: 500 }, formats: formatsSchema } } })
  async create(@Req() request: AuthenticatedRequest, @Body() body: unknown) {
    const parsed = createProjectInput.safeParse(body);
    if (!parsed.success) throw new BadRequestException('Invalid project input');
    return this.projects.create(request.sessionUser.id, parsed.data);
  }

  @Get(':projectId')
  @ApiResponse({ status: 200, type: ProjectResultDto })
  @ApiOperation({ summary: 'Open an accessible project' })
  get(@Req() request: AuthenticatedRequest, @Param('projectId') projectId: string) {
    return this.projects.get(request.sessionUser.id, id(projectId));
  }

  @Patch(':projectId')
  @ApiResponse({ status: 200, type: ProjectResultDto })
  @ApiOperation({ summary: 'Update topic/formats only at the expected revision' })
  @ApiResponse({ status: 409, description: 'Concurrent edit or archived project' })
  @ApiBody({ schema: { type: 'object', required: ['expectedRevision'], additionalProperties: false, properties: {
    expectedRevision: { type: 'integer', minimum: 1 }, topic: { type: 'string', minLength: 1, maxLength: 500 }, formats: formatsSchema
  } } })
  async update(@Req() request: AuthenticatedRequest, @Param('projectId') projectId: string, @Body() body: unknown) {
    const parsed = updateProjectInput.safeParse(body);
    if (!parsed.success) throw new BadRequestException('Invalid project input');
    return this.projects.update(request.sessionUser.id, id(projectId), parsed.data);
  }

  @Get(':projectId/assets/:assetId')
  @ApiResponse({ status: 200, type: AssetMetadataResultDto })
  @ApiOperation({ summary: 'Read available private asset metadata after project ancestry authorization' })
  asset(@Req() request: AuthenticatedRequest, @Param('projectId') projectId: string, @Param('assetId') assetId: string) {
    return this.projects.asset(request.sessionUser.id, id(projectId), id(assetId));
  }
}
