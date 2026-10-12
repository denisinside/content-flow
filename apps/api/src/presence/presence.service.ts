import { Inject, Injectable, NotFoundException, UnauthorizedException } from '@nestjs/common';
import { DependencyHealthService, type Prisma } from '@contextflow/backend';
import { PRESENCE_HEARTBEAT_SECONDS, PRESENCE_POLL_SECONDS, PRESENCE_TTL_SECONDS, type PresencePage, type ProjectPresence } from './presence.contracts.js';

const TTL_MS = PRESENCE_TTL_SECONDS * 1000;
type PresenceActor = { userId: string; sessionId: string };
type Access = { idleTimeoutMinutes: number; lastUserActivityAt: Date; expiresAt: Date };

@Injectable()
export class PresenceService {
  constructor(@Inject(DependencyHealthService) private readonly health: DependencyHealthService) {}

  private async activeAccess(tx: Prisma.TransactionClient, projectId: string, actor: PresenceActor): Promise<Access> {
    // Keep lifecycle and membership changes ordered Workspace → Project → Member → Session.
    const workspaces = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT "id" FROM contextflow."Workspace"
      WHERE "id" = (SELECT "workspaceId" FROM contextflow."Project" WHERE "id" = ${projectId}::uuid)
        AND "archivedAt" IS NULL AND "trashedAt" IS NULL FOR SHARE`;
    if (!workspaces[0]) throw new NotFoundException('Project not found');
    const projects = await tx.$queryRaw<Array<{ workspaceId: string }>>`
      SELECT "workspaceId" FROM contextflow."Project"
      WHERE "id" = ${projectId}::uuid AND "workspaceId" = ${workspaces[0].id}::uuid
        AND "archivedAt" IS NULL AND "trashedAt" IS NULL
      FOR SHARE`;
    if (!projects[0]) throw new NotFoundException('Project not found');
    const members = await tx.$queryRaw<Array<{ userId: string }>>`
      SELECT "userId" FROM contextflow."WorkspaceMember"
      WHERE "workspaceId" = ${workspaces[0].id}::uuid AND "userId" = ${actor.userId}::uuid AND "leftAt" IS NULL FOR SHARE`;
    if (!members[0]) throw new NotFoundException('Project not found');
    const sessions = await tx.$queryRaw<Array<{ expiresAt: Date; lastUserActivityAt: Date; idleTimeoutMinutes: number }>>`
      SELECT s."expiresAt", s."lastUserActivityAt", u."idleTimeoutMinutes"
      FROM contextflow."AppSession" s JOIN contextflow."UserProfile" u ON u."id" = s."userId"
      WHERE s."id" = ${actor.sessionId}::uuid AND s."userId" = ${actor.userId}::uuid
        AND s."revokedAt" IS NULL AND s."expiresAt" > CURRENT_TIMESTAMP
      FOR SHARE OF s, u`;
    const session = sessions[0];
    if (!session || Date.now() - session.lastUserActivityAt.getTime() >= session.idleTimeoutMinutes * 60_000) {
      throw new UnauthorizedException('Session expired');
    }
    return session;
  }

  private async prune(tx: Prisma.TransactionClient, projectId: string): Promise<void> {
    await tx.$executeRaw`DELETE FROM contextflow."EditorPresence"
      WHERE "projectId" = ${projectId}::uuid AND "expiresAt" <= CURRENT_TIMESTAMP`;
  }

  async list(projectId: string, page: PresencePage, actor: PresenceActor): Promise<ProjectPresence> {
    return this.health.prisma.$transaction(async tx => {
      await this.activeAccess(tx, projectId, actor);
      await this.prune(tx, projectId);
      const people = await tx.$queryRaw<Array<{ userId: string; displayName: string | null }>>`
        SELECT DISTINCT ON (s."userId") s."userId", u."displayName"
        FROM contextflow."EditorPresence" ep
        JOIN contextflow."Project" p ON p."id" = ep."projectId" AND p."archivedAt" IS NULL AND p."trashedAt" IS NULL
        JOIN contextflow."Workspace" w ON w."id" = p."workspaceId" AND w."archivedAt" IS NULL AND w."trashedAt" IS NULL
        JOIN contextflow."WorkspaceMember" m ON m."workspaceId" = w."id" AND m."userId" = ep."userId" AND m."leftAt" IS NULL
        JOIN contextflow."AppSession" s ON s."id" = ep."sessionId" AND s."userId" = ep."userId"
          AND s."revokedAt" IS NULL AND s."expiresAt" > CURRENT_TIMESTAMP
        JOIN contextflow."UserProfile" u ON u."id" = s."userId"
        WHERE ep."projectId" = ${projectId}::uuid AND ep."page" = ${page}
          AND ep."expiresAt" > CURRENT_TIMESTAMP AND s."lastUserActivityAt" > CURRENT_TIMESTAMP - (u."idleTimeoutMinutes" * INTERVAL '1 minute')
          AND s."userId" <> ${actor.userId}::uuid
        ORDER BY s."userId", ep."updatedAt" DESC
        LIMIT 500`;
      return { page, ttlSeconds: PRESENCE_TTL_SECONDS, heartbeatSeconds: PRESENCE_HEARTBEAT_SECONDS, pollSeconds: PRESENCE_POLL_SECONDS,
        people: people.map(person => ({ userId: person.userId, displayName: person.displayName?.trim() || 'Учасник' })) };
    }, { timeout: 10_000, maxWait: 3_000 });
  }

  async heartbeat(projectId: string, page: PresencePage, clientId: string, actor: PresenceActor): Promise<{ ok: true; page: PresencePage; ttlSeconds: number }> {
    return this.health.prisma.$transaction(async tx => {
      await this.activeAccess(tx, projectId, actor);
      await this.prune(tx, projectId);
      await tx.$executeRaw`INSERT INTO contextflow."EditorPresence" ("projectId", "sessionId", "userId", "page", "clientId", "expiresAt", "updatedAt")
        VALUES (${projectId}::uuid, ${actor.sessionId}::uuid, ${actor.userId}::uuid, ${page}, ${clientId}::uuid,
          CURRENT_TIMESTAMP + (${TTL_MS} * INTERVAL '1 millisecond'), CURRENT_TIMESTAMP)
        ON CONFLICT ("projectId", "sessionId", "page", "clientId") DO UPDATE SET
          "userId" = EXCLUDED."userId", "expiresAt" = EXCLUDED."expiresAt", "updatedAt" = EXCLUDED."updatedAt"`;
      return { ok: true as const, page, ttlSeconds: PRESENCE_TTL_SECONDS };
    }, { timeout: 10_000, maxWait: 3_000 });
  }

  async leave(projectId: string, page: PresencePage, clientId: string, actor: PresenceActor): Promise<{ ok: true }> {
    return this.health.prisma.$transaction(async tx => {
      await this.activeAccess(tx, projectId, actor);
      await this.prune(tx, projectId);
      await tx.$executeRaw`DELETE FROM contextflow."EditorPresence"
        WHERE "projectId" = ${projectId}::uuid AND "sessionId" = ${actor.sessionId}::uuid
          AND "userId" = ${actor.userId}::uuid AND "page" = ${page} AND "clientId" = ${clientId}::uuid`;
      return { ok: true as const };
    }, { timeout: 10_000, maxWait: 3_000 });
  }
}
