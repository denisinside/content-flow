import {
  BadRequestException, Body, Controller, Get, Inject, Param, Patch, Post, Query, Req, Res, UnauthorizedException, ServiceUnavailableException, UploadedFile, UseGuards, UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiBody, ApiConsumes, ApiCookieAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import type { ServerResponse } from 'node:http';
import { SourceEvidenceService } from '@contextflow/backend';
import { SessionGuard, type AuthenticatedRequest } from '../auth/session.guard.js';
import { SessionService } from '../auth/session-service.js';
import { cookieValue, SESSION_COOKIE, setCookie } from '../auth/csrf.js';
import { STORAGE_MAX_BYTES } from '../storage/private-asset-store.js';
import { SourceService } from './source.service.js';
import { CreateSourceResultDto, MaterialDetailDto, MaterialResultDto, SnapshotResultDto, SourcesPageDto } from './sources.dto.js';
import { appendSnapshotInput, createTextSourceInput, resourceIdInput, updateMaterialInput, uploadSourceInput, importUrlInput, importDocumentInput, reimportSourceInput } from './source-input.js';

type UploadedFile = { originalname: string; mimetype: string; buffer: Buffer; size: number };
function id(value: string): string {
  const parsed = resourceIdInput.safeParse(value);
  if (!parsed.success) throw new BadRequestException('Invalid resource identifier');
  return parsed.data;
}
function attachmentHeader(filename: string): string {
  const clean = filename.replace(/[\u0000-\u001F\u007F]/gu, '').replace(/[\\/]/gu, '_').slice(0, 255) || 'source.txt';
  const fallback = clean.normalize('NFKD').replace(/[^\x20-\x7e]/gu, '_').replace(/["\\;]/gu, '_');
  const encoded = encodeURIComponent(clean).replace(/[!'()*]/gu, character => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}

@ApiTags('sources')
@ApiCookieAuth('__Host-contextflow')
@ApiResponse({ status: 401, description: 'Session expired' })
@ApiResponse({ status: 404, description: 'Resource not found or not accessible' })
@UseGuards(SessionGuard)
@Controller('api/v1')
export class SourcesController {
  constructor(@Inject(SourceService) private readonly sources: SourceService, @Inject(SessionService) private readonly sessions: SessionService,
    @Inject(SourceEvidenceService) private readonly evidence: SourceEvidenceService) {}

  private indexSnapshot(user: string, project: string, material: { currentSnapshotId: string | null; purpose: string; included: boolean }) {
    if (process.env['NODE_ENV'] === 'test') return; // TEST can use the shared live provider keys.
    if (material.currentSnapshotId && material.included && material.purpose === 'FACTUAL_SOURCE') {
      void this.evidence.indexNewSnapshot(user, project, material.currentSnapshotId);
    }
  }

  @Get('projects/:projectId/materials')
  @ApiResponse({ status: 200, type: SourcesPageDto })
  @ApiOperation({ summary: 'List every source material in an accessible Project' })
  list(@Req() request: AuthenticatedRequest, @Param('projectId') projectId: string) {
    return this.sources.list(request.sessionUser.id, id(projectId));
  }

  @Post('projects/:projectId/materials')
  @ApiBody({ schema: { type: 'object', required: ['purpose', 'text'], additionalProperties: false,
    properties: { label: { type: 'string', maxLength: 200, description: 'Optional. Defaults to the first 80 characters of the text.' }, purpose: { type: 'string', enum: ['FACTUAL_SOURCE', 'NOTES', 'BRANDBOOK', 'STYLE_SAMPLE', 'SUPPLIED_ARTICLE'] }, text: { type: 'string', minLength: 1, maxLength: 200000 } } } })
  @ApiResponse({ status: 201, type: CreateSourceResultDto })
  @ApiOperation({ summary: 'Create a manual text source and its immutable first snapshot' })
  async createText(@Req() request: AuthenticatedRequest, @Param('projectId') projectId: string, @Body() body: unknown) {
    const parsed = createTextSourceInput.safeParse(body);
    if (!parsed.success) throw new BadRequestException('Invalid source input');
    const result = await this.sources.createText(request.sessionUser.id, id(projectId), parsed.data);
    this.indexSnapshot(request.sessionUser.id, projectId, result.material);
    return result;
  }

  @Post('projects/:projectId/materials/upload')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: STORAGE_MAX_BYTES, files: 1, fields: 2 } }))
  @ApiConsumes('multipart/form-data')
  @ApiBody({ schema: { type: 'object', required: ['file', 'purpose'], properties: {
    file: { type: 'string', format: 'binary' }, label: { type: 'string', maxLength: 200, description: 'Optional. Defaults to the uploaded filename.' }, purpose: { type: 'string', enum: ['FACTUAL_SOURCE', 'NOTES', 'BRANDBOOK', 'STYLE_SAMPLE', 'SUPPLIED_ARTICLE'] },
  } } })
  @ApiResponse({ status: 201, type: CreateSourceResultDto })
  @ApiOperation({ summary: 'Upload validated UTF-8 TXT or Markdown as a private original and immutable snapshot' })
  async upload(@Req() request: AuthenticatedRequest, @Param('projectId') projectId: string, @Body() body: unknown,
    @UploadedFile() file?: UploadedFile) {
    const parsed = uploadSourceInput.safeParse(body);
    if (!parsed.success || !file) throw new BadRequestException('Upload requires a file and purpose');
    const cookie = cookieValue(request, SESSION_COOKIE);
    if (!cookie) throw new UnauthorizedException('Session expired');
    const result = await this.sources.upload(request.sessionUser.id, id(projectId), cookie, parsed.data, file);
    this.indexSnapshot(request.sessionUser.id, projectId, result.material);
    return result;
  }

  @Post('projects/:projectId/materials/url')
  @ApiBody({ schema: { type: 'object', required: ['purpose', 'url', 'commandKey'], additionalProperties: false,
    properties: { label: { type: 'string', maxLength: 200, description: 'Optional. Defaults to the normalized URL.' }, purpose: { type: 'string', enum: ['FACTUAL_SOURCE', 'NOTES', 'BRANDBOOK', 'STYLE_SAMPLE', 'SUPPLIED_ARTICLE'] }, url: { type: 'string', minLength: 1, maxLength: 2048 }, commandKey: { type: 'string', format: 'uuid' } } } })
  @ApiOperation({ summary: 'Create a URL source and durable single-page import using an explicit command key' })
  async importUrl(@Req() request: AuthenticatedRequest, @Param('projectId') projectId: string, @Body() body: unknown) {
    const parsed = importUrlInput.safeParse(body);
    if (!parsed.success) throw new BadRequestException('URL import requires a purpose, URL, and command key');
    return this.sources.importUrl(request.sessionUser.id, id(projectId), parsed.data);
  }

  @Post('projects/:projectId/materials/document')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: STORAGE_MAX_BYTES, files: 1, fields: 3 } }))
  @ApiConsumes('multipart/form-data')
  @ApiBody({ schema: { type: 'object', required: ['file', 'purpose', 'commandKey'], properties: {
    file: { type: 'string', format: 'binary' }, label: { type: 'string', maxLength: 200, description: 'Optional. Defaults to the uploaded filename.' },
    purpose: { type: 'string', enum: ['FACTUAL_SOURCE', 'NOTES', 'BRANDBOOK', 'STYLE_SAMPLE', 'SUPPLIED_ARTICLE'] }, commandKey: { type: 'string', format: 'uuid' },
  } } })
  @ApiOperation({ summary: 'Retain validated private PDF/DOCX bytes and submit a durable digital-text import with OCR disabled' })
  async importDocument(@Req() request: AuthenticatedRequest, @Param('projectId') projectId: string, @Body() body: unknown, @UploadedFile() file?: UploadedFile) {
    const parsed = importDocumentInput.safeParse(body);
    if (!parsed.success || !file) throw new BadRequestException('Document import requires a file, purpose, and command key');
    const cookie = cookieValue(request, SESSION_COOKIE);
    if (!cookie) throw new UnauthorizedException('Session expired');
    return this.sources.importDocument(request.sessionUser.id, id(projectId), cookie, parsed.data, file);
  }

  @Post('projects/:projectId/materials/:materialId/reimport')
  @ApiOperation({ summary: 'Explicitly import the frozen original again, preserving all earlier snapshots' })
  async reimport(@Req() request: AuthenticatedRequest, @Param('projectId') projectId: string, @Param('materialId') materialId: string, @Body() body: unknown) {
    const parsed = reimportSourceInput.safeParse(body);
    if (!parsed.success) throw new BadRequestException('Reimport requires the current revision and a new command key');
    return this.sources.reimport(request.sessionUser.id, id(projectId), id(materialId), parsed.data);
  }

  @Get('projects/:projectId/materials/:materialId/compare')
  @ApiOperation({ summary: 'Compare exact saved source versions and their provenance' })
  compare(@Req() request: AuthenticatedRequest, @Param('projectId') projectId: string, @Param('materialId') materialId: string,
    @Query('left') left: string, @Query('right') right: string) {
    return this.sources.compare(request.sessionUser.id, id(projectId), id(materialId), id(left), id(right));
  }

  @Patch('projects/:projectId/materials/:materialId')
  @ApiBody({ schema: { type: 'object', required: ['expectedRevision'], additionalProperties: false, properties: {
    expectedRevision: { type: 'integer', minimum: 1 }, label: { type: 'string', minLength: 1, maxLength: 200 },
    purpose: { type: 'string', enum: ['FACTUAL_SOURCE', 'NOTES', 'BRANDBOOK', 'STYLE_SAMPLE', 'SUPPLIED_ARTICLE'] }, included: { type: 'boolean' },
  } } })
  @ApiResponse({ status: 200, type: MaterialResultDto })
  @ApiResponse({ status: 409, description: 'Source revision conflict' })
  @ApiOperation({ summary: 'Update source label, purpose, or future inclusion at the expected revision' })
  async update(@Req() request: AuthenticatedRequest, @Param('projectId') projectId: string, @Param('materialId') materialId: string, @Body() body: unknown) {
    const parsed = updateMaterialInput.safeParse(body);
    if (!parsed.success) throw new BadRequestException('Invalid source update');
    const result = await this.sources.update(request.sessionUser.id, id(projectId), id(materialId), parsed.data);
    if (parsed.data.included === true || parsed.data.purpose === 'FACTUAL_SOURCE') this.indexSnapshot(request.sessionUser.id, projectId, result.material);
    return result;
  }

  @Post('projects/:projectId/materials/:materialId/snapshots')
  @ApiBody({ schema: { type: 'object', required: ['expectedRevision', 'text'], additionalProperties: false, properties: {
    expectedRevision: { type: 'integer', minimum: 1 }, text: { type: 'string', minLength: 1, maxLength: 200000 },
  } } })
  @ApiResponse({ status: 201, type: CreateSourceResultDto })
  @ApiResponse({ status: 409, description: 'Source revision conflict' })
  @ApiOperation({ summary: 'Append a manual immutable text snapshot' })
  async appendSnapshot(@Req() request: AuthenticatedRequest, @Param('projectId') projectId: string, @Param('materialId') materialId: string, @Body() body: unknown) {
    const parsed = appendSnapshotInput.safeParse(body);
    if (!parsed.success) throw new BadRequestException('Invalid source snapshot');
    const result = await this.sources.appendText(request.sessionUser.id, id(projectId), id(materialId), parsed.data);
    this.indexSnapshot(request.sessionUser.id, projectId, result.material);
    return result;
  }

  @Get('projects/:projectId/materials/:materialId')
  @ApiResponse({ status: 200, type: MaterialDetailDto })
  @ApiOperation({ summary: 'Read a source and its immutable snapshot summaries' })
  detail(@Req() request: AuthenticatedRequest, @Param('projectId') projectId: string, @Param('materialId') materialId: string) {
    return this.sources.detail(request.sessionUser.id, id(projectId), id(materialId));
  }

  @Get('projects/:projectId/materials/:materialId/snapshots/:snapshotId')
  @ApiResponse({ status: 200, type: SnapshotResultDto })
  @ApiOperation({ summary: 'Read exact saved source text and UTF-16 fragment locators' })
  snapshot(@Req() request: AuthenticatedRequest, @Param('projectId') projectId: string, @Param('materialId') materialId: string, @Param('snapshotId') snapshotId: string) {
    return this.sources.snapshot(request.sessionUser.id, id(projectId), id(materialId), id(snapshotId));
  }

  @Get('projects/:projectId/assets/:assetId/download')
  @ApiResponse({ status: 200, description: 'Authorized private source original as an attachment' })
  @ApiOperation({ summary: 'Download a source original through current session and Workspace membership checks' })
  async download(@Req() request: AuthenticatedRequest, @Param('projectId') projectId: string, @Param('assetId') assetId: string, @Res() response: ServerResponse) {
    const file = await this.sources.download(request.sessionUser.id, id(projectId), id(assetId));
    const session = await this.sessions.check(cookieValue(request, SESSION_COOKIE), false);
    if (session.kind === 'unavailable') throw new ServiceUnavailableException('Authentication temporarily unavailable');
    if (session.kind !== 'active' || session.user.id !== request.sessionUser.id) {
      setCookie(response, SESSION_COOKIE, '', 0);
      throw new UnauthorizedException('Session expired');
    }
    await this.sources.assertAssetReadable(request.sessionUser.id, id(projectId), file.assetId);
    response.statusCode = 200;
    response.setHeader('Content-Type', file.mediaType);
    response.setHeader('Content-Length', file.bytes.byteLength);
    response.setHeader('Content-Disposition', attachmentHeader(file.filename));
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.end(file.bytes);
  }
}
