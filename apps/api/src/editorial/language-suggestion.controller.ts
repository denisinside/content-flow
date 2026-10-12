import { BadRequestException, Body, Controller, Get, Inject, Param, Post, Query, Req, UseGuards } from '@nestjs/common';
import { ApiCookieAuth, ApiTags } from '@nestjs/swagger';
import { LanguageSuggestionService, acceptLanguageSuggestionsInput, listLanguageSuggestionsInput,
  rejectLanguageSuggestionInput, reviewLanguageSuggestionsInput } from '@contextflow/backend';
import { z } from 'zod';
import { SessionGuard, type AuthenticatedRequest } from '../auth/session.guard.js';

function id(value: string) { if (!z.uuid().safeParse(value).success) throw new BadRequestException('Invalid resource identifier'); return value; }
function parse<T>(schema: z.ZodType<T>, body: unknown): T { const value = schema.safeParse(body); if (!value.success) throw new BadRequestException('Invalid language suggestion input'); return value.data; }

@ApiTags('language suggestions')
@ApiCookieAuth('__Host-contextflow')
@UseGuards(SessionGuard)
@Controller('api/v1/projects/:projectId/language-suggestions')
export class LanguageSuggestionController {
  constructor(@Inject(LanguageSuggestionService) private readonly language: LanguageSuggestionService) {}

  @Get()
  list(@Req() request: AuthenticatedRequest, @Param('projectId') project: string, @Query() query: unknown) {
    const input = parse(listLanguageSuggestionsInput, query);
    return this.language.list(request.sessionUser.id, id(project), input.targetType, input.sourceRevisionId);
  }

  @Post('review')
  review(@Req() request: AuthenticatedRequest, @Param('projectId') project: string, @Body() body: unknown) {
    return this.language.review(request.sessionUser.id, id(project), parse(reviewLanguageSuggestionsInput, body));
  }

  @Post('accept')
  accept(@Req() request: AuthenticatedRequest, @Param('projectId') project: string, @Body() body: unknown) {
    return this.language.accept(request.sessionUser.id, id(project), parse(acceptLanguageSuggestionsInput, body));
  }

  @Post(':suggestionId/reject')
  reject(@Req() request: AuthenticatedRequest, @Param('projectId') project: string, @Param('suggestionId') suggestion: string, @Body() body: unknown) {
    const input = parse(rejectLanguageSuggestionInput, body);
    return this.language.reject(request.sessionUser.id, id(project), id(suggestion), input.expectedRevision);
  }
}
