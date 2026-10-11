import { BadRequestException, Body, Controller, Get, Inject, Param, Post, Query, Req, UseGuards } from '@nestjs/common';
import { ApiCookieAuth, ApiTags } from '@nestjs/swagger';
import { ArticleAnnotationService, actArticleAnnotationInput, createArticleAnnotationInput, listArticleAnnotationsInput, replyArticleAnnotationInput } from '@contextflow/backend';
import { z } from 'zod';
import { SessionGuard, type AuthenticatedRequest } from '../auth/session.guard.js';

function id(value: string) { if (!z.uuid().safeParse(value).success) throw new BadRequestException('Invalid resource identifier'); return value; }
function parse<T>(schema: z.ZodType<T>, body: unknown): T { const value = schema.safeParse(body); if (!value.success) throw new BadRequestException('Invalid article annotation input'); return value.data; }

@ApiTags('article annotations')
@ApiCookieAuth('__Host-contextflow')
@UseGuards(SessionGuard)
@Controller('api/v1/projects/:projectId/article/annotations')
export class ArticleAnnotationController {
  constructor(@Inject(ArticleAnnotationService) private readonly annotations: ArticleAnnotationService) {}
  @Get()
  list(@Req() request: AuthenticatedRequest, @Param('projectId') project: string, @Query() queryInput: unknown): ReturnType<ArticleAnnotationService['list']> {
    const query = parse(listArticleAnnotationsInput, queryInput);
    return this.annotations.list(request.sessionUser.id, id(project), query.targetVersionId);
  }
  @Post()
  create(@Req() request: AuthenticatedRequest, @Param('projectId') project: string, @Body() body: unknown): ReturnType<ArticleAnnotationService['create']> {
    return this.annotations.create(request.sessionUser.id, id(project), parse(createArticleAnnotationInput, body));
  }
  @Post(':annotationId/reply')
  reply(@Req() request: AuthenticatedRequest, @Param('projectId') project: string, @Param('annotationId') annotationId: string, @Body() body: unknown): ReturnType<ArticleAnnotationService['reply']> {
    const input = parse(replyArticleAnnotationInput, body);
    return this.annotations.reply(request.sessionUser.id, id(project), id(annotationId), input.expectedRevision, input.body);
  }
  @Post(':annotationId/action')
  action(@Req() request: AuthenticatedRequest, @Param('projectId') project: string, @Param('annotationId') annotationId: string, @Body() body: unknown): ReturnType<ArticleAnnotationService['act']> {
    return this.annotations.act(request.sessionUser.id, id(project), id(annotationId), parse(actArticleAnnotationInput, body));
  }
}
