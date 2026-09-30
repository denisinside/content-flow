import { BadRequestException, Body, Controller, Get, Inject, Param, Patch, Post, Query, Req, ServiceUnavailableException, UseGuards } from '@nestjs/common';
import { ApiCookieAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { FactualBasisService, claimWorkflowRelease, jobView, createClaimInput, editClaimInput, reviewClaimInput,
  invalidateEvidenceInput, createConflictInput, resolveConflictInput, reopenConflictInput, freezeBasisInput, extractClaimsInput } from '@contextflow/backend';
import { z } from 'zod';
import { SessionGuard, type AuthenticatedRequest } from '../auth/session.guard.js';

function id(value: string): string {
  if (!z.uuid().safeParse(value).success) throw new BadRequestException('Invalid resource identifier');
  return value;
}
function parse<T>(schema: z.ZodType<T>, body: unknown): T {
  const value = schema.safeParse(body);
  if (!value.success) throw new BadRequestException('Invalid factual review input');
  return value.data;
}
@ApiTags('claims and factual basis')
@ApiCookieAuth('__Host-contextflow')
@UseGuards(SessionGuard)
@Controller('api/v1/projects/:projectId')
export class ClaimsController {
  constructor(@Inject(FactualBasisService) private readonly facts: FactualBasisService) {}
  @Get('claims')
  @ApiOperation({ summary: 'Inspect current claims and exact evidence' })
  list(@Req() request: AuthenticatedRequest, @Param('projectId') projectId: string, @Query('cursor') cursor?: string) {
    return this.facts.list(request.sessionUser.id, id(projectId), cursor ? id(cursor) : undefined);
  }
  @Get('claims/:claimId')
  detail(@Req() request: AuthenticatedRequest, @Param('projectId') projectId: string, @Param('claimId') claimId: string) {
    return this.facts.detail(request.sessionUser.id, id(projectId), id(claimId));
  }
  @Post('claims/extract')
  @ApiOperation({ summary: 'Freeze included factual source versions for an external candidate extraction' })
  async extract(@Req() request: AuthenticatedRequest, @Param('projectId') projectId: string, @Body() body: unknown) {
    const input = parse(extractClaimsInput, body);
    let release;
    try { release = claimWorkflowRelease(); }
    catch { throw new ServiceUnavailableException('The published claim workflow is not configured; manual evidence review remains available'); }
    return { job: jobView(await this.facts.extract(request.sessionUser.id, id(projectId), input.commandKey, release)) };
  }
  @Post('claims')
  create(@Req() request: AuthenticatedRequest, @Param('projectId') projectId: string, @Body() body: unknown) {
    return this.facts.create(request.sessionUser.id, id(projectId), parse(createClaimInput, body));
  }
  @Patch('claims/:claimId')
  @ApiOperation({ summary: 'Append an unapproved revision, preserving earlier wording and approval' })
  edit(@Req() request: AuthenticatedRequest, @Param('projectId') projectId: string, @Param('claimId') claimId: string, @Body() body: unknown) {
    return this.facts.edit(request.sessionUser.id, id(projectId), id(claimId), parse(editClaimInput, body));
  }
  @Post('claims/:claimId/revisions/:revisionId/approve')
  approve(@Req() request: AuthenticatedRequest, @Param('projectId') projectId: string, @Param('claimId') claimId: string, @Param('revisionId') revisionId: string, @Body() body: unknown) {
    return this.facts.review(request.sessionUser.id, id(projectId), id(claimId), id(revisionId), 'approve', parse(reviewClaimInput, body));
  }
  @Post('claims/:claimId/revisions/:revisionId/reject')
  reject(@Req() request: AuthenticatedRequest, @Param('projectId') projectId: string, @Param('claimId') claimId: string, @Param('revisionId') revisionId: string, @Body() body: unknown) {
    return this.facts.review(request.sessionUser.id, id(projectId), id(claimId), id(revisionId), 'reject', parse(reviewClaimInput, body));
  }
  @Post('claims/:claimId/revisions/:revisionId/withdraw')
  withdraw(@Req() request: AuthenticatedRequest, @Param('projectId') projectId: string, @Param('claimId') claimId: string, @Param('revisionId') revisionId: string, @Body() body: unknown) {
    return this.facts.review(request.sessionUser.id, id(projectId), id(claimId), id(revisionId), 'withdraw', parse(reviewClaimInput, body));
  }
  @Post('claims/:claimId/evidence/:evidenceId/invalidate')
  invalidate(@Req() request: AuthenticatedRequest, @Param('projectId') projectId: string, @Param('claimId') claimId: string, @Param('evidenceId') evidenceId: string, @Body() body: unknown) {
    return this.facts.invalidate(request.sessionUser.id, id(projectId), id(claimId), id(evidenceId), parse(invalidateEvidenceInput, body));
  }
  @Get('conflicts')
  conflicts(@Req() request: AuthenticatedRequest, @Param('projectId') projectId: string, @Query('cursor') cursor?: string) {
    return this.facts.conflicts(request.sessionUser.id, id(projectId), cursor ? id(cursor) : undefined);
  }
  @Post('conflicts')
  flag(@Req() request: AuthenticatedRequest, @Param('projectId') projectId: string, @Body() body: unknown) {
    return this.facts.flagConflict(request.sessionUser.id, id(projectId), parse(createConflictInput, body));
  }
  @Post('conflicts/:conflictId/resolve')
  resolve(@Req() request: AuthenticatedRequest, @Param('projectId') projectId: string, @Param('conflictId') conflictId: string, @Body() body: unknown) {
    return this.facts.resolveConflict(request.sessionUser.id, id(projectId), id(conflictId), parse(resolveConflictInput, body));
  }
  @Get('basis')
  @ApiOperation({ summary: 'Read explicit factual prerequisites or an unverified creative mode' })
  basis(@Req() request: AuthenticatedRequest, @Param('projectId') projectId: string, @Query('mode') mode?: string) {
    const value = parse(z.enum(['FACTUAL', 'CREATIVE']), mode ?? 'FACTUAL');
    return this.facts.basis(request.sessionUser.id, id(projectId), value);
  }
  @Post('conflicts/:conflictId/reopen')
  @ApiOperation({ summary: 'Create a new unresolved conflict for the same stable claims while retaining the earlier decision' })
  reopen(@Req() request: AuthenticatedRequest, @Param('projectId') projectId: string, @Param('conflictId') conflictId: string, @Body() body: unknown) {
    return this.facts.reopenConflict(request.sessionUser.id, id(projectId), id(conflictId), parse(reopenConflictInput, body));
  }
  @Post('basis')
  freeze(@Req() request: AuthenticatedRequest, @Param('projectId') projectId: string, @Body() body: unknown) {
    return this.facts.freezeBasis(request.sessionUser.id, id(projectId), parse(freezeBasisInput, body));
  }
}
