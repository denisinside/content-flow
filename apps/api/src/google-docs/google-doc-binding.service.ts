import { createHash, randomUUID } from 'node:crypto';
import { BadRequestException, ConflictException, ForbiddenException, Inject, Injectable, NotFoundException, UnauthorizedException } from '@nestjs/common';
import { DependencyHealthService, GOOGLE_DOCS_FILE_SCOPE, type GoogleDocsDocument, type GoogleDocsClient, type Prisma } from '@contextflow/backend';
import { z } from 'zod';
import { cookieValue, SESSION_COOKIE } from '../auth/csrf.js';
import type { AuthenticatedRequest } from '../auth/session.guard.js';
import { EXTERNAL_PROCESSING_NOTICE } from '../auth/external-processing.js';
import { tokenDigest, validOpaqueToken } from '../auth/session-crypto.js';
import { GoogleOAuthService } from './google-oauth.service.js';
import { googleTabToArticleContent as convertGoogleTab } from '@contextflow/backend';

const documentIdInput = z.string().trim().min(1).max(1024).refine(value => Buffer.byteLength(value, 'utf8') <= 1024);
const bindInput = z.object({
  connectionId: z.uuid(), documentId: documentIdInput, tabId: z.string().trim().min(1).max(128),
  commandKey: z.uuid(), expectedArticleRevision: z.number().int().min(0).max(2_147_483_646), acknowledgeWorkspaceSharing: z.literal(true),
}).strict();
const inspectInput = z.object({ connectionId: z.uuid(), documentId: documentIdInput }).strict();
const unbindInput = z.object({ expectedBindingId: z.uuid() }).strict();
type ProjectAccess = { articleRevision: number };
type ConnectionGeneration = { generation: number };
type RequestContext = { sessionId: string; userId: string; acceptedAt: Date };
type SafeSnapshot = {
  id: string; remoteRevision: string; contentHash: string; capturedAt: string;
  converted: { content: unknown; suggestions: unknown; unsupported: unknown; plainText: string; inlineCoordinatesValid: boolean };
};

function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object).sort().map(key => `${JSON.stringify(key)}:${canonical(object[key])}`).join(',')}}`;
}
function digest(value: unknown): string { return createHash('sha256').update(canonical(value), 'utf8').digest('hex'); }
function uuid(value: unknown, label: string): string {
  const parsed = z.uuid().safeParse(value);
  if (!parsed.success) throw new BadRequestException(`Invalid ${label}`);
  return parsed.data;
}
function flattenTabs(tabs: GoogleDocsDocument['tabs']): Array<{ tabId: string; title: string | null }> {
  return tabs.flatMap(tab => [
    { tabId: tab.tabProperties.tabId, title: tab.tabProperties.title ?? null },
    ...flattenTabs(tab.childTabs ?? []),
  ]);
}
function safeSnapshot(snapshot: { id: string; remoteRevision: string; contentHash: string; capturedAt: Date; converted: Prisma.JsonValue }): SafeSnapshot {
  const converted = snapshot.converted as unknown as SafeSnapshot['converted'];
  return { id: snapshot.id, remoteRevision: snapshot.remoteRevision, contentHash: snapshot.contentHash, capturedAt: snapshot.capturedAt.toISOString(),
    converted: { content: converted.content, suggestions: converted.suggestions, unsupported: converted.unsupported,
      plainText: converted.plainText, inlineCoordinatesValid: converted.inlineCoordinatesValid } };
}

@Injectable()
export class GoogleDocBindingService {
  constructor(@Inject(DependencyHealthService) private readonly health: DependencyHealthService,
    @Inject(GoogleOAuthService) private readonly oauth: GoogleOAuthService) {}

  private async lockProject(tx: Prisma.TransactionClient, userId: string, projectId: string, write: boolean, requireArticle: boolean,
    expectedArticleRevision?: number): Promise<ProjectAccess> {
    const rows = write
      ? await tx.$queryRaw<Array<{ revision: number | null; formats: string[] }>>`
        SELECT a."revision", p."formats" FROM contextflow."Project" p
        JOIN contextflow."Workspace" w ON w."id" = p."workspaceId"
        JOIN contextflow."WorkspaceMember" m ON m."workspaceId" = w."id"
        LEFT JOIN contextflow."Article" a ON a."projectId" = p."id"
        WHERE p."id" = ${projectId}::uuid AND p."archivedAt" IS NULL AND p."trashedAt" IS NULL AND w."archivedAt" IS NULL AND w."trashedAt" IS NULL
          AND m."userId" = ${userId}::uuid AND m."leftAt" IS NULL
        FOR UPDATE OF p FOR SHARE OF w, m`
      : await tx.$queryRaw<Array<{ revision: number | null; formats: string[] }>>`
        SELECT a."revision", p."formats" FROM contextflow."Project" p
        JOIN contextflow."Workspace" w ON w."id" = p."workspaceId"
        JOIN contextflow."WorkspaceMember" m ON m."workspaceId" = w."id"
        LEFT JOIN contextflow."Article" a ON a."projectId" = p."id"
        WHERE p."id" = ${projectId}::uuid AND p."archivedAt" IS NULL AND p."trashedAt" IS NULL AND w."archivedAt" IS NULL AND w."trashedAt" IS NULL
          AND m."userId" = ${userId}::uuid AND m."leftAt" IS NULL
        FOR SHARE OF p, w, m`;
    const row = rows[0];
    if (!row) throw new NotFoundException('Project not found');
    if (requireArticle && !row.formats.includes('ARTICLE')) throw new ConflictException('Select Article before binding a Google Doc');
    const articleRevision = row.revision ?? 0;
    if (expectedArticleRevision !== undefined && articleRevision !== expectedArticleRevision) {
      throw new ConflictException('Article changed; reload before binding a Google Doc');
    }
    return { articleRevision };
  }

  private async activeConnection(tx: Prisma.TransactionClient, userId: string, connectionId: string): Promise<ConnectionGeneration> {
    const rows = await tx.$queryRaw<Array<{ generation: number; refreshExpiresAt: Date | null }>>`
      SELECT "generation", "refreshExpiresAt" FROM contextflow."GoogleDriveConnection"
      WHERE "id" = ${connectionId}::uuid AND "userId" = ${userId}::uuid AND "revokedAt" IS NULL
        AND "encryptedTokens" IS NOT NULL AND "grantedScope" = ${GOOGLE_DOCS_FILE_SCOPE} FOR SHARE`;
    if (!rows[0]) throw new NotFoundException('Google connection not found');
    if (rows[0].refreshExpiresAt && rows[0].refreshExpiresAt.getTime() <= Date.now()) {
      throw new ForbiddenException('Google authorization expired; reconnect the account');
    }
    return rows[0];
  }

  private async requestContext(request: AuthenticatedRequest, requireNotice = true): Promise<RequestContext> {
    const cookie = cookieValue(request, SESSION_COOKIE);
    if (!validOpaqueToken(cookie)) throw new UnauthorizedException('Session expired');
    const cookieDigest = tokenDigest(cookie);
    const [session, profile] = await Promise.all([
      this.health.prisma.appSession.findUnique({ where: { cookieDigest }, select: { id: true, userId: true, revokedAt: true, expiresAt: true, lastUserActivityAt: true } }),
      this.health.prisma.userProfile.findUnique({ where: { id: request.sessionUser.id }, select: { idleTimeoutMinutes: true, externalProcessingNoticeVersion: true, externalProcessingAcceptedAt: true } }),
    ]);
    const now = Date.now();
    if (!session || session.revokedAt || session.userId !== request.sessionUser.id || now >= session.expiresAt.getTime()
      || !profile || now - session.lastUserActivityAt.getTime() >= profile.idleTimeoutMinutes * 60_000) throw new UnauthorizedException('Session expired');
    if (requireNotice && (profile.externalProcessingNoticeVersion !== EXTERNAL_PROCESSING_NOTICE.version || !profile.externalProcessingAcceptedAt)) {
      throw new ForbiddenException('Accept the external-processing notice before using Google Docs');
    }
    return { sessionId: session.id, userId: session.userId, acceptedAt: profile.externalProcessingAcceptedAt ?? new Date(0) };
  }

  private async lockRequestContext(tx: Prisma.TransactionClient, context: RequestContext, requireNotice = true): Promise<void> {
    const sessions = await tx.$queryRaw<Array<{ expiresAt: Date; lastUserActivityAt: Date }>>`
      SELECT "expiresAt", "lastUserActivityAt" FROM contextflow."AppSession"
      WHERE "id" = ${context.sessionId}::uuid AND "userId" = ${context.userId}::uuid AND "revokedAt" IS NULL FOR UPDATE`;
    const profiles = await tx.$queryRaw<Array<{ idleTimeoutMinutes: number; externalProcessingNoticeVersion: string | null; externalProcessingAcceptedAt: Date | null }>>`
      SELECT "idleTimeoutMinutes", "externalProcessingNoticeVersion", "externalProcessingAcceptedAt"
      FROM contextflow."UserProfile" WHERE "id" = ${context.userId}::uuid FOR SHARE`;
    const now = Date.now(), session = sessions[0], profile = profiles[0];
    if (!session || !profile || now >= session.expiresAt.getTime()
      || now - session.lastUserActivityAt.getTime() >= profile.idleTimeoutMinutes * 60_000) throw new UnauthorizedException('Session expired');
    if (requireNotice && (profile.externalProcessingNoticeVersion !== EXTERNAL_PROCESSING_NOTICE.version
      || profile.externalProcessingAcceptedAt?.getTime() !== context.acceptedAt.getTime())) {
      throw new ForbiddenException('External-processing acceptance changed during Google Docs operation');
    }
  }

  private async projectAccess(userId: string, projectId: string, requireArticle: boolean, expectedArticleRevision?: number): Promise<ProjectAccess> {
    return this.health.prisma.$transaction(tx => this.lockProject(tx, userId, projectId, false, requireArticle, expectedArticleRevision),
      { timeout: 10_000, maxWait: 3_000 });
  }

  private async generation(userId: string, connectionId: string): Promise<ConnectionGeneration> {
    return this.health.prisma.$transaction(tx => this.activeConnection(tx, userId, connectionId), { timeout: 10_000, maxWait: 3_000 });
  }

  async inspect(request: AuthenticatedRequest, rawProjectId: unknown, rawBody: unknown) {
    const projectId = uuid(rawProjectId, 'project identifier');
    const input = inspectInput.safeParse(rawBody);
    if (!input.success) throw new BadRequestException('Invalid Google Doc selection');
    const context = await this.requestContext(request);
    await this.projectAccess(request.sessionUser.id, projectId, true);
    await this.generation(request.sessionUser.id, input.data.connectionId);
    let observedGeneration: number | undefined;
    const document = await this.oauth.withOwnGoogleDocsClient(request, input.data.connectionId,
      async (client: GoogleDocsClient) => {
        const result = await client.getDocument(input.data.documentId);
        observedGeneration = (await this.generation(request.sessionUser.id, input.data.connectionId)).generation;
        return result;
      });
    await this.health.prisma.$transaction(async tx => {
      await this.lockRequestContext(tx, context);
      await this.lockProject(tx, request.sessionUser.id, projectId, false, true);
      const current = await this.activeConnection(tx, request.sessionUser.id, input.data.connectionId);
      if (current.generation !== observedGeneration) throw new ConflictException('Google connection changed; inspect the document again');
      await this.lockRequestContext(tx, context);
    }, { timeout: 10_000, maxWait: 3_000 });
    return { document: { documentId: document.documentId, title: document.title ?? null, revisionId: document.revisionId, tabs: flattenTabs(document.tabs) } };
  }

  private async bindingResult(tx: Prisma.TransactionClient, projectId: string, bindingId: string) {
    const binding = await tx.googleDocBinding.findFirst({ where: { id: bindingId, projectId }, select: {
      id: true, projectId: true, connectionId: true, documentId: true, tabId: true, createdBy: true, createdAt: true, endedAt: true,
      snapshots: { orderBy: [{ capturedAt: 'desc' }, { id: 'desc' }], take: 1, select: {
        id: true, remoteRevision: true, contentHash: true, capturedAt: true, converted: true,
      } },
    } });
    if (!binding) throw new NotFoundException('Google Doc binding not found');
    const { snapshots, ...safe } = binding;
    return { ...safe, createdAt: safe.createdAt.toISOString(), endedAt: safe.endedAt?.toISOString() ?? null,
      snapshot: snapshots[0] ? safeSnapshot(snapshots[0]) : null };
  }

  async get(request: AuthenticatedRequest, rawProjectId: unknown) {
    const projectId = uuid(rawProjectId, 'project identifier');
    return this.health.prisma.$transaction(async tx => {
      await this.lockProject(tx, request.sessionUser.id, projectId, false, false);
      const binding = await tx.googleDocBinding.findFirst({ where: { projectId, endedAt: null }, select: { id: true } });
      return { binding: binding ? await this.bindingResult(tx, projectId, binding.id) : null };
    }, { timeout: 10_000, maxWait: 3_000 });
  }

  async bind(request: AuthenticatedRequest, rawProjectId: unknown, rawBody: unknown) {
    const projectId = uuid(rawProjectId, 'project identifier');
    const parsed = bindInput.safeParse(rawBody);
    if (!parsed.success) throw new BadRequestException('Invalid Google Doc binding');
    const input = parsed.data;
    const payloadHash = digest(input);
    // A stored command receipt is local history and stays readable after the
    // notice has been withdrawn. New remote work still requires current consent.
    const context = await this.requestContext(request, false);
    await this.projectAccess(request.sessionUser.id, projectId, false);
    const prior = await this.health.prisma.googleDocBindCommand.findUnique({
      where: { projectId_createdBy_commandKey: { projectId, createdBy: request.sessionUser.id, commandKey: input.commandKey } }, select: { payloadHash: true, bindingId: true },
    });
    if (prior) {
      if (prior.payloadHash !== payloadHash) throw new ConflictException('Google Doc command key was already used with different input');
      return this.health.prisma.$transaction(async tx => {
        await this.lockRequestContext(tx, context, false);
        await this.lockProject(tx, request.sessionUser.id, projectId, false, false);
        return { binding: await this.bindingResult(tx, projectId, prior.bindingId), replayed: true };
      }, { timeout: 10_000, maxWait: 3_000 });
    }
    await this.projectAccess(request.sessionUser.id, projectId, true, input.expectedArticleRevision);
    await this.generation(request.sessionUser.id, input.connectionId);
    let observedGeneration: number | undefined;
    const document = await this.oauth.withOwnGoogleDocsClient(request, input.connectionId, async client => {
      const fetched = await client.getDocument(input.documentId);
      observedGeneration = (await this.generation(request.sessionUser.id, input.connectionId)).generation;
      return fetched;
    });
    let converted;
    try { converted = convertGoogleTab(document, input.tabId); }
    catch { throw new BadRequestException('Selected Google Docs tab is unavailable'); }
    const snapshotPayload = JSON.parse(JSON.stringify(document)) as Prisma.InputJsonValue;
    const convertedPayload = JSON.parse(JSON.stringify({
      tabId: converted.tabId, content: converted.content, suggestions: converted.suggestions, unsupported: converted.unsupported,
      plainText: converted.plainText, inlineText: converted.inlineText, inlineTextStartIndex: converted.inlineTextStartIndex,
      inlineCoordinatesValid: converted.inlineCoordinatesValid, rangeMap: converted.rangeMap,
    })) as Prisma.InputJsonValue;
    const contentHash = digest(snapshotPayload);
    try {
      return await this.health.prisma.$transaction(async tx => {
        await this.lockRequestContext(tx, context);
        await this.lockProject(tx, request.sessionUser.id, projectId, true, false);
        const existingCommand = await tx.googleDocBindCommand.findUnique({
          where: { projectId_createdBy_commandKey: { projectId, createdBy: request.sessionUser.id, commandKey: input.commandKey } },
        });
        if (existingCommand) {
          if (existingCommand.payloadHash !== payloadHash) throw new ConflictException('Google Doc command key was already used with different input');
          return { binding: await this.bindingResult(tx, projectId, existingCommand.bindingId), replayed: true };
        }
        const connection = await this.activeConnection(tx, request.sessionUser.id, input.connectionId);
        if (connection.generation !== observedGeneration) throw new ConflictException('Google connection changed; bind the document again');
        await this.lockRequestContext(tx, context);
        await this.lockProject(tx, request.sessionUser.id, projectId, true, true, input.expectedArticleRevision);
        const bindingId = randomUUID(), now = new Date();
        await tx.googleDocBinding.create({ data: { id: bindingId, projectId, connectionId: input.connectionId,
          connectionUserId: request.sessionUser.id, documentId: input.documentId, tabId: input.tabId, createdBy: request.sessionUser.id, createdAt: now } });
        await tx.googleDocSnapshot.create({ data: { id: randomUUID(), projectId, bindingId, remoteRevision: document.revisionId,
          payload: snapshotPayload, converted: convertedPayload, contentHash, capturedBy: request.sessionUser.id, capturedAt: now } });
        await tx.googleDocBindCommand.create({ data: { projectId, createdBy: request.sessionUser.id, commandKey: input.commandKey, payloadHash, bindingId, createdAt: now } });
        return { binding: await this.bindingResult(tx, projectId, bindingId), replayed: false };
      }, { timeout: 15_000, maxWait: 5_000 });
    } catch (error) {
      if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'P2002') {
        throw new ConflictException('A Google Doc tab is already bound to an active project');
      }
      throw error;
    }
  }

  async unbind(request: AuthenticatedRequest, rawProjectId: unknown, rawBody: unknown) {
    const projectId = uuid(rawProjectId, 'project identifier');
    const parsed = unbindInput.safeParse(rawBody);
    if (!parsed.success) throw new BadRequestException('Invalid Google Doc binding');
    const context = await this.requestContext(request, false);
    return this.health.prisma.$transaction(async tx => {
      await this.lockRequestContext(tx, context, false);
      await this.lockProject(tx, request.sessionUser.id, projectId, true, false);
      await this.lockRequestContext(tx, context, false);
      const active = await tx.googleDocBinding.findFirst({ where: { id: parsed.data.expectedBindingId, projectId, endedAt: null }, select: { createdAt: true } });
      if (!active) throw new ConflictException('Google Doc binding changed; reload before unbinding');
      const endedAt = new Date(Math.max(Date.now(), active.createdAt.getTime() + 1));
      await tx.googleDocBinding.update({ where: { id: parsed.data.expectedBindingId }, data: { endedAt } });
      return { binding: await this.bindingResult(tx, projectId, parsed.data.expectedBindingId) };
    }, { timeout: 10_000, maxWait: 3_000 });
  }
}

export { bindInput as googleDocBindInput, inspectInput as googleDocInspectInput, unbindInput as googleDocUnbindInput };
