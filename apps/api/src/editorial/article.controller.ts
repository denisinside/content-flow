import { BadRequestException, Body, Controller, Get, Inject, Param, Post, Req, ServiceUnavailableException, UseGuards } from '@nestjs/common';
import { ApiCookieAuth, ApiTags } from '@nestjs/swagger';
import { ArticleService, saveArticleDraftInput, importArticleInput, checkpointArticleInput, reviewArticleInput, generateArticleInput, articleWorkflowRelease, jobView } from '@contextflow/backend';
import { z } from 'zod';
import { SessionGuard, type AuthenticatedRequest } from '../auth/session.guard.js';
function id(value: string) { if (!z.uuid().safeParse(value).success) throw new BadRequestException('Invalid resource identifier'); return value; }
function parse<T>(schema: z.ZodType<T>, body: unknown): T { const value = schema.safeParse(body); if (!value.success) throw new BadRequestException('Invalid article input'); return value.data; }
type ArticleState = Awaited<ReturnType<ArticleService['get']>>;
@ApiTags('article editor and review')
@ApiCookieAuth('__Host-contextflow')
@UseGuards(SessionGuard)
@Controller('api/v1/projects/:projectId/article')
export class ArticleController {
  constructor(@Inject(ArticleService) private readonly articles: ArticleService) {}
  @Get()
  state(@Req() request: AuthenticatedRequest, @Param('projectId') project: string): Promise<ArticleState> { return this.articles.get(request.sessionUser.id, id(project)); }
  @Post('draft')
  draft(@Req() request: AuthenticatedRequest, @Param('projectId') project: string, @Body() body: unknown): Promise<ArticleState> { return this.articles.saveDraft(request.sessionUser.id, id(project), parse(saveArticleDraftInput, body)); }
  @Post('import')
  import(@Req() request: AuthenticatedRequest, @Param('projectId') project: string, @Body() body: unknown): Promise<ArticleState> { return this.articles.importArticle(request.sessionUser.id, id(project), parse(importArticleInput, body)); }
  @Post('checkpoint')
  checkpoint(@Req() request: AuthenticatedRequest, @Param('projectId') project: string, @Body() body: unknown): Promise<ArticleState> { return this.articles.checkpoint(request.sessionUser.id, id(project), parse(checkpointArticleInput, body)); }
  @Post('generate')
  async generate(@Req() request: AuthenticatedRequest, @Param('projectId') project: string, @Body() body: unknown) {
    const input = parse(generateArticleInput, body); let release;
    try { release = articleWorkflowRelease(); } catch { throw new ServiceUnavailableException('The published article workflow is not configured; manual editing remains available'); }
    return { job: jobView(await this.articles.freezeArticle(request.sessionUser.id, id(project), input.commandKey, input.expectedRevision, release)) };
  }
  @Post(':versionId/apply')
  apply(@Req() request: AuthenticatedRequest, @Param('projectId') project: string, @Param('versionId') version: string, @Body() body: unknown): Promise<ArticleState> { return this.articles.review(request.sessionUser.id, id(project), id(version), 'apply', parse(reviewArticleInput, body)); }
  @Post(':versionId/approve')
  approve(@Req() request: AuthenticatedRequest, @Param('projectId') project: string, @Param('versionId') version: string, @Body() body: unknown): Promise<ArticleState> { return this.articles.review(request.sessionUser.id, id(project), id(version), 'approve', parse(reviewArticleInput, body)); }
  @Post(':versionId/withdraw')
  withdraw(@Req() request: AuthenticatedRequest, @Param('projectId') project: string, @Param('versionId') version: string, @Body() body: unknown): Promise<ArticleState> { return this.articles.review(request.sessionUser.id, id(project), id(version), 'withdraw', parse(reviewArticleInput, body)); }
}

