import { BadRequestException, Body, Controller, Inject, Param, Post, Req, UseGuards } from '@nestjs/common';
import { ApiCookieAuth, ApiTags } from '@nestjs/swagger';
import { ScriptLanguageService, scriptLanguageAcceptInput, scriptLanguageReviewInput } from '@contextflow/backend';
import { z } from 'zod';
import { SessionGuard, type AuthenticatedRequest } from '../auth/session.guard.js';

function id(value: string) { if (!z.uuid().safeParse(value).success) throw new BadRequestException('Invalid resource identifier'); return value; }
function parse<T>(schema: z.ZodType<T>, body: unknown): T {
  const result = schema.safeParse(body); if (!result.success) throw new BadRequestException('Invalid script language input'); return result.data;
}

@ApiTags('script language suggestions')
@ApiCookieAuth('__Host-contextflow')
@UseGuards(SessionGuard)
@Controller('api/v1/projects/:projectId/scripts/language-suggestions')
export class ScriptLanguageController {
  constructor(@Inject(ScriptLanguageService) private readonly language: ScriptLanguageService) {}

  @Post('review')
  review(@Req() request: AuthenticatedRequest, @Param('projectId') project: string, @Body() body: unknown): Promise<Awaited<ReturnType<ScriptLanguageService['review']>>> {
    return this.language.review(request.sessionUser.id, id(project), parse(scriptLanguageReviewInput, body));
  }

  @Post('accept')
  accept(@Req() request: AuthenticatedRequest, @Param('projectId') project: string, @Body() body: unknown) {
    return this.language.accept(request.sessionUser.id, id(project), parse(scriptLanguageAcceptInput, body));
  }

  @Post(':suggestionId/reject')
  reject(@Req() request: AuthenticatedRequest, @Param('projectId') project: string, @Param('suggestionId') suggestion: string, @Body() body: unknown) {
    const input = parse(z.object({ expectedRevision: z.number().int().nonnegative() }).strict(), body);
    return this.language.reject(request.sessionUser.id, id(project), id(suggestion), input.expectedRevision);
  }
}
