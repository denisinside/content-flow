import { createHash, randomUUID } from 'node:crypto';
import { BadRequestException, ConflictException, ForbiddenException, Inject, Injectable, NotFoundException, ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';
import { DependencyHealthService, GOOGLE_DOCS_FILE_SCOPE, GoogleDocsApiError, type Prisma } from '@contextflow/backend';
import { z } from 'zod';
import { cookieValue, SESSION_COOKIE } from '../auth/csrf.js';
import type { AuthenticatedRequest } from '../auth/session.guard.js';
import { EXTERNAL_PROCESSING_NOTICE } from '../auth/external-processing.js';
import { tokenDigest, validOpaqueToken } from '../auth/session-crypto.js';
import { GoogleOAuthService } from './google-oauth.service.js';

const createInput = z.object({
  connectionId: z.uuid(), commandKey: z.uuid(), title: z.string().trim().min(1).max(200),
  expectedArticleRevision: z.number().int().min(0).max(2_147_483_646),
}).strict();
const reconcileInput = z.object({ connectionId: z.uuid() }).strict();
type RequestContext = { sessionId: string; userId: string; acceptedAt: Date };
type CommandRow = { id: string; projectId: string; userId: string; connectionId: string; commandKey: string; payloadHash: string;
  title: string; state: 'SUBMITTED' | 'UNKNOWN' | 'CREATED' | 'FAILED'; documentId: string | null; createdAt: Date; updatedAt: Date };

function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object).sort().map(key => `${JSON.stringify(key)}:${canonical(object[key])}`).join(',')}}`;
}
function hash(value: unknown): string { return createHash('sha256').update(canonical(value), 'utf8').digest('hex'); }
function projectUuid(value: unknown): string {
  const parsed = z.uuid().safeParse(value);
  if (!parsed.success) throw new BadRequestException('Invalid project identifier');
  return parsed.data;
}
function view(row: CommandRow, replayed = false, recoverableByOwnConnection = false, createdBy?: { userId: string; displayName: string | null }) {
  return { id: row.id, projectId: row.projectId, connectionId: row.connectionId, commandKey: row.commandKey, title: row.title, state: row.state,
    documentId: row.documentId, createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString(), replayed,
    recoverableByOwnConnection, ...(createdBy ? { createdBy } : {}) };
}
function providerFailure(error: unknown): never {
  if (!(error instanceof GoogleDocsApiError)) throw error;
  if (error.status === 401 || error.status === 403 || error.kind === 'unauthenticated' || error.kind === 'forbidden') {
    throw new ForbiddenException('Google Docs access is unavailable; reconnect the account or review its access');
  }
  if (error.kind === 'conflict') throw new ConflictException('Google Docs rejected the create request; review the command before retrying');
  throw new ServiceUnavailableException(error.mayHaveCommitted
    ? 'Google Docs create outcome is unknown; reconcile this command before taking another action'
    : 'Google Docs is temporarily unavailable; the create command was not accepted');
}

@Injectable()
export class GoogleDocCreateService {
  constructor(@Inject(DependencyHealthService) private readonly health: DependencyHealthService,
    @Inject(GoogleOAuthService) private readonly oauth: GoogleOAuthService) {}

  private async context(request: AuthenticatedRequest, requireNotice = true): Promise<RequestContext> {
    const cookie = cookieValue(request, SESSION_COOKIE);
    if (!validOpaqueToken(cookie)) throw new UnauthorizedException('Session expired');
    const [session, profile] = await Promise.all([
      this.health.prisma.appSession.findUnique({ where: { cookieDigest: tokenDigest(cookie) },
        select: { id: true, userId: true, revokedAt: true, expiresAt: true, lastUserActivityAt: true } }),
      this.health.prisma.userProfile.findUnique({ where: { id: request.sessionUser.id },
        select: { idleTimeoutMinutes: true, externalProcessingNoticeVersion: true, externalProcessingAcceptedAt: true } }),
    ]);
    const now = Date.now();
    if (!session || session.revokedAt || session.userId !== request.sessionUser.id || now >= session.expiresAt.getTime()
      || !profile || now - session.lastUserActivityAt.getTime() >= profile.idleTimeoutMinutes * 60_000) throw new UnauthorizedException('Session expired');
    if (requireNotice && (profile.externalProcessingNoticeVersion !== EXTERNAL_PROCESSING_NOTICE.version || !profile.externalProcessingAcceptedAt)) {
      throw new ForbiddenException('Accept the external-processing notice before using Google Docs');
    }
    return { sessionId: session.id, userId: session.userId, acceptedAt: profile.externalProcessingAcceptedAt ?? new Date(0) };
  }

  private async lockContext(tx: Prisma.TransactionClient, context: RequestContext, requireNotice = true): Promise<void> {
    const sessions = await tx.$queryRaw<Array<{ expiresAt: Date; lastUserActivityAt: Date }>>`
      SELECT "expiresAt", "lastUserActivityAt" FROM contextflow."AppSession"
      WHERE "id" = ${context.sessionId}::uuid AND "userId" = ${context.userId}::uuid AND "revokedAt" IS NULL FOR UPDATE`;
    const profiles = await tx.$queryRaw<Array<{ idleTimeoutMinutes: number; externalProcessingNoticeVersion: string | null; externalProcessingAcceptedAt: Date | null }>>`
      SELECT "idleTimeoutMinutes", "externalProcessingNoticeVersion", "externalProcessingAcceptedAt"
      FROM contextflow."UserProfile" WHERE "id" = ${context.userId}::uuid FOR SHARE`;
    const session = sessions[0], profile = profiles[0], now = Date.now();
    if (!session || !profile || now >= session.expiresAt.getTime() || now - session.lastUserActivityAt.getTime() >= profile.idleTimeoutMinutes * 60_000) {
      throw new UnauthorizedException('Session expired');
    }
    if (requireNotice && (profile.externalProcessingNoticeVersion !== EXTERNAL_PROCESSING_NOTICE.version
      || profile.externalProcessingAcceptedAt?.getTime() !== context.acceptedAt.getTime())) {
      throw new ForbiddenException('External-processing acceptance changed during Google Docs operation');
    }
  }

  private async project(tx: Prisma.TransactionClient, userId: string, projectId: string,
    expectedRevision?: number, requireArticle = true): Promise<number> {
    const rows = await tx.$queryRaw<Array<{ revision: number | null; formats: string[] }>>`
      SELECT a."revision", p."formats" FROM contextflow."Project" p
      JOIN contextflow."Workspace" w ON w."id" = p."workspaceId"
      JOIN contextflow."WorkspaceMember" m ON m."workspaceId" = w."id"
      LEFT JOIN contextflow."Article" a ON a."projectId" = p."id"
      WHERE p."id" = ${projectId}::uuid AND p."archivedAt" IS NULL AND w."archivedAt" IS NULL
        AND m."userId" = ${userId}::uuid AND m."leftAt" IS NULL
      FOR SHARE OF p, w, m`;
    const row = rows[0];
    if (!row) throw new NotFoundException('Project not found');
    if (requireArticle && !row.formats.includes('ARTICLE')) throw new ConflictException('Select Article before creating a Google Doc');
    const revision = row.revision ?? 0;
    if (expectedRevision !== undefined && revision !== expectedRevision) throw new ConflictException('Article changed; reload before creating a Google Doc');
    return revision;
  }

  private async connection(tx: Prisma.TransactionClient, userId: string, connectionId: string): Promise<void> {
    const rows = await tx.$queryRaw<Array<{ refreshExpiresAt: Date | null }>>`
      SELECT "refreshExpiresAt" FROM contextflow."GoogleDriveConnection"
      WHERE "id" = ${connectionId}::uuid AND "userId" = ${userId}::uuid AND "revokedAt" IS NULL
        AND "encryptedTokens" IS NOT NULL AND "grantedScope" = ${GOOGLE_DOCS_FILE_SCOPE} FOR SHARE`;
    if (!rows[0]) throw new NotFoundException('Google connection not found');
    if (rows[0].refreshExpiresAt && rows[0].refreshExpiresAt.getTime() <= Date.now()) throw new ForbiddenException('Google authorization expired; reconnect the account');
  }

  private async lockCommand(tx: Prisma.TransactionClient, commandId: string): Promise<CommandRow> {
    const rows = await tx.$queryRaw<CommandRow[]>`SELECT * FROM contextflow."GoogleDocCreateCommand" WHERE "id" = ${commandId}::uuid FOR UPDATE`;
    if (!rows[0]) throw new NotFoundException('Google Doc create command not found');
    return rows[0];
  }

  private async transition(commandId: string, allowed: Array<'SUBMITTED' | 'UNKNOWN'>, state: 'UNKNOWN' | 'CREATED' | 'FAILED', documentId: string | null): Promise<CommandRow> {
    return this.health.prisma.$transaction(async tx => {
      const row = await this.lockCommand(tx, commandId);
      if (row.state === 'CREATED' || row.state === 'FAILED') return row;
      if (!allowed.includes(row.state)) return row;
      const updatedAt = new Date(Math.max(Date.now(), row.updatedAt.getTime() + 1));
      return tx.googleDocCreateCommand.update({ where: { id: commandId }, data: { state, documentId, updatedAt } });
    }, { timeout: 10_000, maxWait: 3_000 });
  }

  private async safeGet(request: AuthenticatedRequest, context: RequestContext, projectId: string, commandId: string): Promise<CommandRow> {
    return this.health.prisma.$transaction(async tx => {
      await this.lockContext(tx, context, false);
      await this.project(tx, context.userId, projectId, undefined, false);
      const row = await tx.googleDocCreateCommand.findFirst({ where: { id: commandId, projectId, userId: context.userId } });
      if (!row) throw new NotFoundException('Google Doc create command not found');
      return row;
    }, { timeout: 10_000, maxWait: 3_000 });
  }

  private async authorizeProject(request: AuthenticatedRequest, context: RequestContext, projectId: string): Promise<void> {
    await this.health.prisma.$transaction(async tx => {
      await this.lockContext(tx, context, false);
      await this.project(tx, request.sessionUser.id, projectId, undefined, false);
    }, { timeout: 10_000, maxWait: 3_000 });
  }

  async list(request: AuthenticatedRequest, rawProjectId: unknown) {
    const projectId = projectUuid(rawProjectId), context = await this.context(request, false);
    const rows = await this.health.prisma.$transaction(async tx => {
      await this.lockContext(tx, context, false);
      await this.project(tx, context.userId, projectId, undefined, false);
      return tx.googleDocCreateCommand.findMany({
        where: { projectId, OR: [{ userId: context.userId }, { state: { in: ['SUBMITTED', 'UNKNOWN'] } }] },
        include: { user: { select: { displayName: true } } },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: 40,
      });
    }, { timeout: 10_000, maxWait: 3_000 });
    return { commands: rows.map(row => view(row, false, row.state === 'SUBMITTED' || row.state === 'UNKNOWN',
      { userId: row.userId, displayName: row.user.displayName })) };
  }

  async create(request: AuthenticatedRequest, rawProjectId: unknown, rawBody: unknown) {
    const projectId = projectUuid(rawProjectId), parsed = createInput.safeParse(rawBody);
    if (!parsed.success) throw new BadRequestException('Invalid Google Doc create command');
    const input = parsed.data, context = await this.context(request, false), payloadHash = hash(input);
    // Membership is required before command-key lookup. An exact replay remains readable
    // after notice withdrawal or Article edits, but cannot escape the current session fence.
    await this.authorizeProject(request, context, projectId);
    const prior = await this.health.prisma.googleDocCreateCommand.findUnique({ where: {
      projectId_userId_commandKey: { projectId, userId: context.userId, commandKey: input.commandKey },
    } });
    if (prior) {
      if (prior.payloadHash !== payloadHash) throw new ConflictException('Google Doc command key was already used with different input');
      const current = await this.safeGet(request, context, projectId, prior.id);
      return { command: view(current, true) };
    }

    await this.context(request, true);
    const commandId = randomUUID();
    let command: CommandRow;
    try {
      command = await this.health.prisma.$transaction(async tx => {
        await this.lockContext(tx, context, true);
        await this.project(tx, context.userId, projectId, input.expectedArticleRevision, true);
        await this.connection(tx, context.userId, input.connectionId);
        const active = await tx.googleDocBinding.findFirst({ where: { projectId, endedAt: null }, select: { id: true } });
        if (active) throw new ConflictException('End the active Google Doc binding before creating another document');
        return tx.googleDocCreateCommand.create({ data: { id: commandId, projectId, userId: context.userId, connectionId: input.connectionId,
          commandKey: input.commandKey, payloadHash, title: input.title, state: 'SUBMITTED' } });
      }, { timeout: 10_000, maxWait: 3_000 });
    } catch (error) {
      if ((error as { code?: string })?.code === 'P2002') {
        const raced = await this.health.prisma.googleDocCreateCommand.findUnique({ where: {
          projectId_userId_commandKey: { projectId, userId: context.userId, commandKey: input.commandKey },
        } });
        if (raced) {
          if (raced.payloadHash !== payloadHash) throw new ConflictException('Google Doc command key was already used with different input');
          const current = await this.safeGet(request, context, projectId, raced.id);
          return { command: view(current, true) };
        }
        throw new ConflictException('A Google Doc create operation is already unresolved for this Project');
      }
      throw error;
    }

    let postAttempted = false;
    try {
      const created = await this.oauth.withOwnGoogleDocsClient(request, input.connectionId, async client => {
        // Recheck the mutable editorial and access boundary inside the OAuth closure,
        // immediately before the one provider POST. The OAuth facade independently
        // fences the acting session, notice and personal connection generation.
        await this.health.prisma.$transaction(async tx => {
          await this.lockContext(tx, context, true);
          await this.project(tx, context.userId, projectId, input.expectedArticleRevision, true);
          await this.connection(tx, context.userId, input.connectionId);
          const active = await tx.googleDocBinding.findFirst({ where: { projectId, endedAt: null }, select: { id: true } });
          if (active) throw new ConflictException('End the active Google Doc binding before creating another document');
          const saved = await this.lockCommand(tx, commandId);
          if (saved.state !== 'SUBMITTED') throw new ConflictException('Google Doc create command is no longer ready to submit');
        }, { timeout: 10_000, maxWait: 3_000 });
        const result = await client.createBlankDocument(commandId, input.title, () => { postAttempted = true; });
        // Persist the known remote effect before OAuth's post-operation fence can fail.
        command = await this.transition(commandId, ['SUBMITTED', 'UNKNOWN'], 'CREATED', result.documentId);
        return result;
      });
      command = await this.safeGet(request, context, projectId, commandId);
      return { command: view(command), document: { documentId: created.documentId, title: created.title } };
    } catch (error) {
      const knownNoEffect = error instanceof GoogleDocsApiError && !error.mayHaveCommitted;
      const next = !postAttempted || knownNoEffect ? 'FAILED' : 'UNKNOWN';
      command = await this.transition(commandId, ['SUBMITTED'], next, null);
      // This may be a logout that happened after Google accepted the POST. Preserve the
      // journal above, then keep the response fenced by the session/membership check.
      await this.safeGet(request, context, projectId, commandId);
      providerFailure(error);
    }
  }

  async reconcile(request: AuthenticatedRequest, rawProjectId: unknown, rawCommandId: unknown, rawBody: unknown) {
    const projectId = projectUuid(rawProjectId), commandId = typeof rawCommandId === 'string' ? z.uuid().safeParse(rawCommandId) : { success: false as const };
    if (!commandId.success) throw new BadRequestException('Invalid Google Doc command identifier');
    const input = reconcileInput.safeParse(rawBody);
    if (!input.success) throw new BadRequestException('Invalid Google Doc reconciliation request');
    const context = await this.context(request, false);
    await this.authorizeProject(request, context, projectId);
    let row = await this.health.prisma.$transaction(async tx => {
      await this.lockContext(tx, context, false);
      await this.project(tx, context.userId, projectId, undefined, false);
      const found = await tx.googleDocCreateCommand.findFirst({ where: { id: commandId.data, projectId,
        OR: [{ userId: context.userId }, { state: { in: ['SUBMITTED', 'UNKNOWN'] } }] } });
      if (!found) throw new NotFoundException('Google Doc create command not found');
      return found;
    }, { timeout: 10_000, maxWait: 3_000 });
    if (row.state === 'CREATED' || row.state === 'FAILED') return { command: view(row, true), matches: row.state === 'CREATED' ? 1 : 0 };
    await this.context(request, true);
    // Recovery is performed only with the current member's own OAuth connection.
    // The original creator's connection is never borrowed, even while it still exists.
    let matches: Array<{ documentId: string; title: string }> = [];
    try {
      matches = await this.oauth.withOwnGoogleDocsClient(request, input.data.connectionId, async client => {
        const found = await client.findCreatedDocuments(row.id);
        if (found.length === 1) await this.transition(row.id, ['SUBMITTED', 'UNKNOWN'], 'CREATED', found[0]!.documentId);
        return found;
      });
    } catch (error) {
      // Finder failures do not change an unresolved outcome or authorize another POST.
      await this.authorizeProject(request, context, projectId);
      providerFailure(error);
    }
    if (matches.length === 1) row = await this.transition(row.id, ['SUBMITTED', 'UNKNOWN'], 'CREATED', matches[0]!.documentId);
    else if (row.state === 'SUBMITTED') row = await this.transition(row.id, ['SUBMITTED'], 'UNKNOWN', null);
    else row = await this.transition(row.id, ['UNKNOWN'], 'UNKNOWN', null);
    row = await this.health.prisma.$transaction(async tx => {
      await this.lockContext(tx, context, false);
      await this.project(tx, context.userId, projectId, undefined, false);
      const current = await tx.googleDocCreateCommand.findFirst({ where: { id: row.id, projectId } });
      if (!current) throw new NotFoundException('Google Doc create command not found');
      return current;
    }, { timeout: 10_000, maxWait: 3_000 });
    return { command: view(row, false, row.state === 'SUBMITTED' || row.state === 'UNKNOWN'), matches: matches.length, conflict: matches.length > 1 };
  }
}
