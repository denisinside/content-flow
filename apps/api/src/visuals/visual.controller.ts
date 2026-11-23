import { BadRequestException, Body, Controller, Get, Inject, Param, Post, Query, Req, Res, ServiceUnavailableException, StreamableFile, UnauthorizedException, UseGuards } from '@nestjs/common';
import { ApiCookieAuth, ApiTags } from '@nestjs/swagger';
import type { ServerResponse } from 'node:http';
import { VisualService, VisualBackgroundService, backgroundGenerateSchema, backgroundApplySchema } from '@contextflow/backend';
import { z } from 'zod';
import { SessionGuard, type AuthenticatedRequest } from '../auth/session.guard.js';
import { SessionService } from '../auth/session-service.js';
import { cookieValue, SESSION_COOKIE, setCookie } from '../auth/csrf.js';

type VisualState = Awaited<ReturnType<VisualService['get']>>;
const idSchema = z.uuid();
const initializeSchema = z.object({ parentRevisionId: z.uuid() }).strict();
const draftSchema = z.object({ expectedRevision: z.number().int().nonnegative(), expectedDraftCounter: z.number().int().nonnegative(),
  workspaceStyleRevision: z.number().int().positive().optional(), composition: z.unknown() }).strict();
const checkpointSchema = z.object({ expectedRevision: z.number().int().nonnegative(), expectedDraftCounter: z.number().int().nonnegative() }).strict();
const reviewSchema = z.object({ expectedRevision: z.number().int().nonnegative(), expectedReviewCounter: z.number().int().nonnegative(), acknowledgeUnmapped: z.boolean().optional() }).strict();
const previewSchema = z.object({ frameId: z.uuid() }).strict();
const assetSchema = z.object({ filename: z.string().min(1).max(255), mediaType: z.enum(['image/png', 'image/jpeg']), base64: z.string().max(7_000_000) }).strict();
function id(value: string) { const parsed = idSchema.safeParse(value); if (!parsed.success) throw new BadRequestException('Invalid resource identifier'); return parsed.data; }
function parse<T>(schema: z.ZodType<T>, body: unknown): T { const result = schema.safeParse(body); if (!result.success) throw new BadRequestException('Invalid visual input'); return result.data; }

@ApiTags('Visual compositions')
@ApiCookieAuth('__Host-contextflow')
@UseGuards(SessionGuard)
@Controller('api/v1/projects/:projectId/visuals')
export class VisualController {
  constructor(@Inject(VisualService) private readonly visuals: VisualService, @Inject(VisualBackgroundService) private readonly backgrounds: VisualBackgroundService,
    @Inject(SessionService) private readonly sessions: SessionService) {}
  @Get('backgrounds')
  backgroundsState(@Req() request: AuthenticatedRequest, @Param('projectId') project: string, @Query('format') format: string): ReturnType<VisualBackgroundService['list']> {
    return this.backgrounds.list(request.sessionUser.id,id(project),format);
  }
  @Post('backgrounds/generate')
  generateBackground(@Req() request: AuthenticatedRequest, @Param('projectId') project: string, @Query('format') format: string, @Body() body: unknown): ReturnType<VisualBackgroundService['generate']> {
    return this.backgrounds.generate(request.sessionUser.id,id(project),format,parse(backgroundGenerateSchema,body));
  }
  @Post('backgrounds/candidates/:candidateId/apply')
  applyBackground(@Req() request: AuthenticatedRequest, @Param('projectId') project: string, @Param('candidateId') candidate: string, @Query('format') format: string, @Body() body: unknown): ReturnType<VisualBackgroundService['apply']> {
    return this.backgrounds.apply(request.sessionUser.id,id(project),format,id(candidate),parse(backgroundApplySchema,body));
  }
  @Get()
  state(@Req() request: AuthenticatedRequest, @Param('projectId') project: string, @Query('format') format: string): Promise<VisualState> {
    return this.visuals.get(request.sessionUser.id, id(project), format);
  }
  @Post('initialize')
  initialize(@Req() request: AuthenticatedRequest, @Param('projectId') project: string, @Query('format') format: string, @Body() body: unknown): Promise<VisualState> {
    return this.visuals.initialize(request.sessionUser.id, id(project), format, parse(initializeSchema, body));
  }
  @Post('draft')
  draft(@Req() request: AuthenticatedRequest, @Param('projectId') project: string, @Query('format') format: string, @Body() body: unknown): Promise<VisualState> {
    const parsed = parse(draftSchema, body);
    return this.visuals.saveDraft(request.sessionUser.id, id(project), format, { expectedRevision: parsed.expectedRevision,
      expectedDraftCounter: parsed.expectedDraftCounter, composition: parsed.composition,
      ...(parsed.workspaceStyleRevision === undefined ? {} : { workspaceStyleRevision: parsed.workspaceStyleRevision }) });
  }
  @Post('checkpoint')
  checkpoint(@Req() request: AuthenticatedRequest, @Param('projectId') project: string, @Query('format') format: string, @Body() body: unknown): Promise<VisualState> {
    return this.visuals.checkpoint(request.sessionUser.id, id(project), format, parse(checkpointSchema, body));
  }
  @Post('parent/refresh')
  refreshParent(@Req() request: AuthenticatedRequest, @Param('projectId') project: string, @Query('format') format: string, @Body() body: unknown): Promise<VisualState> {
    const input = parse(z.object({ expectedRevision: z.number().int().nonnegative() }).strict(), body);
    return this.visuals.refreshParent(request.sessionUser.id, id(project), format, input);
  }
  @Post('revisions/:revisionId/approve')
  approve(@Req() request: AuthenticatedRequest, @Param('projectId') project: string, @Param('revisionId') revision: string,
    @Query('format') format: string, @Body() body: unknown): Promise<VisualState> {
    return this.visuals.review(request.sessionUser.id, id(project), format, id(revision), 'approve', parse(reviewSchema, body));
  }
  @Post('revisions/:revisionId/withdraw')
  withdraw(@Req() request: AuthenticatedRequest, @Param('projectId') project: string, @Param('revisionId') revision: string,
    @Query('format') format: string, @Body() body: unknown): Promise<VisualState> {
    return this.visuals.review(request.sessionUser.id, id(project), format, id(revision), 'withdraw', parse(reviewSchema, body));
  }
  @Post('assets')
  uploadAsset(@Req() request: AuthenticatedRequest, @Param('projectId') project: string, @Query('scope') scope: string, @Body() body: unknown) {
    return this.visuals.createAsset(request.sessionUser.id, id(project), scope, parse(assetSchema, body));
  }
  @Get('assets/:assetId')
  async readAsset(@Req() request: AuthenticatedRequest, @Param('projectId') project: string, @Param('assetId') assetId: string,
    @Query('scope') scope: string, @Res({ passthrough: true }) response: ServerResponse): Promise<StreamableFile> {
    const result = await this.visuals.readAsset(request.sessionUser.id, id(project), scope, id(assetId));
    await this.assertCurrentSession(request, response);
    await this.visuals.assertAssetReadable(request.sessionUser.id, id(project), scope, id(assetId), result.sha256, result.mediaType);
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    return new StreamableFile(result.bytes, { type: result.mediaType, disposition: 'inline', length: result.bytes.length });
  }
  @Post('revisions/:revisionId/preview')
  preview(@Req() request: AuthenticatedRequest, @Param('projectId') project: string, @Param('revisionId') revision: string,
    @Query('format') format: string, @Body() body: unknown): Promise<{ assetId: string; frameId: string; sha256: string; rendererVersion: string; fontHashes: unknown; overflow: unknown }> {
    return this.visuals.preview(request.sessionUser.id, id(project), format, id(revision), parse(previewSchema, body).frameId);
  }
  @Get('preview/:assetId')
  async readPreview(@Req() request: AuthenticatedRequest, @Param('projectId') project: string, @Param('assetId') assetId: string,
    @Res({ passthrough: true }) response: ServerResponse): Promise<StreamableFile> {
    const result = await this.visuals.readPreviewWithMetadata(request.sessionUser.id, id(project), id(assetId));
    await this.assertCurrentSession(request, response);
    await this.visuals.assertPreviewReadable(request.sessionUser.id, id(project), id(assetId), result.sha256);
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    return new StreamableFile(result.bytes, { type: 'image/png', disposition: 'inline', length: result.bytes.length });
  }

  private async assertCurrentSession(request: AuthenticatedRequest, response: ServerResponse): Promise<void> {
    const session = await this.sessions.check(cookieValue(request, SESSION_COOKIE), false);
    if (session.kind === 'unavailable') throw new ServiceUnavailableException('Authentication temporarily unavailable');
    if (session.kind !== 'active' || session.user.id !== request.sessionUser.id) {
      setCookie(response, SESSION_COOKIE, '', 0);
      throw new UnauthorizedException('Session expired');
    }
  }
}
