import { ConflictException, ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { DependencyHealthService, type Prisma } from '@contextflow/backend';
import { opaqueToken, tokenDigest } from '../auth/session-crypto.js';
import type { SessionUser } from '../auth/session-service.js';
import type { UpdateStyleInput } from './workspace-input.js';

const workspaceSelect = { id: true, name: true, ownerId: true, styleRevision: true, lifecycleRevision: true, createdAt: true, updatedAt: true, archivedAt: true, trashedAt: true, purgeAfter: true } as const;
const detailSelect = { ...workspaceSelect, members: { where: { leftAt: null }, select: { userId: true, joinedAt: true, user: { select: { displayName: true } } }, orderBy: { joinedAt: 'asc' } } } as const;
type WorkspaceRecord = Prisma.WorkspaceGetPayload<{ select: typeof workspaceSelect }>;
type WorkspaceDetail = Prisma.WorkspaceGetPayload<{ select: typeof detailSelect }>;
type WorkspaceTx = Prisma.TransactionClient;

function mapPurgeDatabaseError(error: unknown): never {
  const value = error as { code?: unknown; meta?: { code?: unknown; driverAdapterError?: { code?: unknown; cause?: { code?: unknown } } } } | null;
  const sqlState = typeof value?.meta?.code === 'string' ? value.meta.code
    : typeof value?.meta?.driverAdapterError?.code === 'string' ? value.meta.driverAdapterError.code
      : typeof value?.meta?.driverAdapterError?.cause?.code === 'string' ? value.meta.driverAdapterError.cause.code : null;
  if (['P2010', 'P2039'].includes(String(value?.code)) && sqlState) {
    if (sqlState === '42501') throw new ForbiddenException('Only the active sole Workspace owner may permanently delete this Workspace');
    if (sqlState === 'P0002') throw new NotFoundException('Workspace not found');
    if (['55000', '40001', '40P01'].includes(sqlState)) throw new ConflictException('Workspace cannot be permanently deleted yet; reload and retry after resolving the lifecycle conflict');
  }
  throw error;
}

function view(workspace: WorkspaceRecord | WorkspaceDetail) {
  return { id: workspace.id, name: workspace.name, ownerId: workspace.ownerId, styleRevision: workspace.styleRevision, lifecycleRevision: workspace.lifecycleRevision,
    createdAt: workspace.createdAt.toISOString(), updatedAt: workspace.updatedAt.toISOString(), archivedAt: workspace.archivedAt?.toISOString() ?? null,
    trashedAt: workspace.trashedAt?.toISOString() ?? null, purgeAfter: workspace.purgeAfter?.toISOString() ?? null,
    ...('members' in workspace ? { members: workspace.members.map(member => ({ userId: member.userId,
      displayName: member.user.displayName, joinedAt: member.joinedAt.toISOString() })) } : {}) };
}

function styleView(style: { revision: number; brandbook: string; tone: string; settings: Prisma.JsonValue; createdBy: string; createdAt: Date }) {
  return { revision: style.revision, brandbook: style.brandbook, tone: style.tone, settings: style.settings,
    createdBy: style.createdBy, createdAt: style.createdAt.toISOString() };
}

@Injectable()
export class WorkspaceService {
  constructor(@Inject(DependencyHealthService) private readonly health: DependencyHealthService) {}

  private async locked(tx: WorkspaceTx, workspaceId: string) {
    const rows = await tx.$queryRaw<Array<{ id: string }>>`SELECT "id" FROM contextflow."Workspace" WHERE "id" = ${workspaceId}::uuid FOR UPDATE`;
    if (!rows.length) throw new NotFoundException('Workspace not found');
    return tx.workspace.findUniqueOrThrow({ where: { id: workspaceId }, select: workspaceSelect });
  }

  private async activeMember(tx: WorkspaceTx, workspaceId: string, userId: string) {
    const member = await tx.workspaceMember.findUnique({ where: { workspaceId_userId: { workspaceId, userId } }, select: { leftAt: true } });
    if (!member || member.leftAt) throw new NotFoundException('Workspace not found');
  }

  private async detail(tx: WorkspaceTx, workspaceId: string) {
    const workspace = await tx.workspace.findUniqueOrThrow({ where: { id: workspaceId }, select: detailSelect });
    return { workspace: view(workspace) };
  }

  async list(userId: string, cursor?: string) {
    const where = { members: { some: { userId, leftAt: null } } };
    const anchor = cursor ? await this.health.prisma.workspace.findFirst({ where: { id: cursor, ...where }, select: { id: true, createdAt: true } }) : null;
    if (cursor && !anchor) throw new NotFoundException('Workspace not found');
    const rows = await this.health.prisma.workspace.findMany({ where: { ...where, ...(anchor ? { OR: [
      { createdAt: { lt: anchor.createdAt } }, { createdAt: anchor.createdAt, id: { lt: anchor.id } }
    ] } : {}) }, select: workspaceSelect, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: 51 });
    const workspaces = rows.slice(0, 50);
    return { workspaces: workspaces.map(view), nextCursor: rows.length > 50 ? workspaces.at(-1)?.id ?? null : null };
  }

  async create(userId: string, name: string) {
    return this.health.prisma.$transaction(async tx => {
      const workspaceId = randomUUID();
      await tx.workspace.create({ data: { id: workspaceId, name, ownerId: userId,
        members: { create: { userId } }, styles: { create: { revision: 1, createdBy: userId, brandbook: '', tone: '', settings: {} } } } });
      return this.detail(tx, workspaceId);
    });
  }

  async get(userId: string, workspaceId: string) {
    const workspace = await this.health.prisma.workspace.findFirst({ where: { id: workspaceId, members: { some: { userId, leftAt: null } } }, select: detailSelect });
    if (!workspace) throw new NotFoundException('Workspace not found');
    return { workspace: view(workspace) };
  }

  async invite(user: SessionUser, workspaceId: string, email: string) {
    return this.health.prisma.$transaction(async tx => {
      const workspace = await this.locked(tx, workspaceId);
      await this.activeMember(tx, workspaceId, user.id);
      if (workspace.ownerId !== user.id) throw new ForbiddenException('Only the Workspace owner can invite members');
      if (workspace.archivedAt || workspace.trashedAt) throw new ConflictException('Workspace is archived or trashed');
      if (email === user.email.trim().toLowerCase()) throw new ConflictException('Already a Workspace member');
      const token = opaqueToken();
      const invite = await tx.workspaceInvite.create({ data: { id: randomUUID(), workspaceId, email,
        tokenDigest: tokenDigest(token), invitedBy: user.id, expiresAt: new Date(Date.now() + 48 * 60 * 60 * 1000) },
        select: { id: true, email: true, expiresAt: true } });
      return { invite: { ...invite, expiresAt: invite.expiresAt.toISOString(), token } };
    });
  }

  async accept(user: SessionUser, token: string) {
    const digest = tokenDigest(token);
    const candidate = await this.health.prisma.workspaceInvite.findUnique({ where: { tokenDigest: digest }, select: { workspaceId: true } });
    if (!candidate) throw new NotFoundException('Invitation not found');
    return this.health.prisma.$transaction(async tx => {
      const workspace = await this.locked(tx, candidate.workspaceId);
      if (workspace.archivedAt || workspace.trashedAt) throw new ConflictException('Workspace is archived or trashed');
      const invite = await tx.workspaceInvite.findUnique({ where: { tokenDigest: digest }, select: { id: true, email: true, acceptedAt: true, expiresAt: true } });
      if (!invite || invite.acceptedAt || invite.expiresAt.getTime() <= Date.now()) throw new NotFoundException('Invitation not found');
      if (invite.email !== user.email.trim().toLowerCase()) throw new ForbiddenException('Invitation is for another account');
      const member = await tx.workspaceMember.findUnique({ where: { workspaceId_userId: { workspaceId: candidate.workspaceId, userId: user.id } }, select: { leftAt: true } });
      if (member && !member.leftAt) throw new ConflictException('Already a Workspace member');
      const acceptedAt = new Date();
      const used = await tx.workspaceInvite.updateMany({ where: { id: invite.id, acceptedAt: null, expiresAt: { gt: acceptedAt } }, data: { acceptedAt, acceptedBy: user.id } });
      if (used.count !== 1) throw new NotFoundException('Invitation not found');
      await tx.workspaceMember.upsert({ where: { workspaceId_userId: { workspaceId: candidate.workspaceId, userId: user.id } },
        create: { workspaceId: candidate.workspaceId, userId: user.id, joinedAt: acceptedAt }, update: { joinedAt: acceptedAt, leftAt: null } });
      await tx.workspace.update({ where: { id: candidate.workspaceId }, data: { lifecycleRevision: { increment: 1 }, updatedAt: acceptedAt } });
      return this.detail(tx, candidate.workspaceId);
    });
  }

  async leave(userId: string, workspaceId: string) {
    const current = await this.health.prisma.workspace.findFirst({ where: { id: workspaceId, members: { some: { userId, leftAt: null } } }, select: { ownerId: true, lifecycleRevision: true } });
    if (!current) throw new NotFoundException('Workspace not found');
    if (current.ownerId === userId) {
      const count = await this.health.prisma.workspaceMember.count({ where: { workspaceId, leftAt: null } });
      if (count > 1) throw new ConflictException('Transfer ownership before leaving');
      await this.lifecycle(userId, workspaceId, 'archive', current.lifecycleRevision);
      return;
    }
    await this.health.prisma.$transaction(async tx => {
      const workspace = await this.locked(tx, workspaceId);
      await this.activeMember(tx, workspaceId, userId);
      if (workspace.ownerId === userId) throw new ConflictException('Ownership changed; reload before leaving');
      await tx.workspaceMember.update({ where: { workspaceId_userId: { workspaceId, userId } }, data: { leftAt: new Date() } });
      await tx.workspace.update({ where: { id: workspaceId }, data: { lifecycleRevision: { increment: 1 }, updatedAt: new Date() } });
    });
  }

  async transfer(userId: string, workspaceId: string, targetId: string) {
    return this.health.prisma.$transaction(async tx => {
      const workspace = await this.locked(tx, workspaceId);
      await this.activeMember(tx, workspaceId, userId);
      if (workspace.ownerId !== userId) throw new ForbiddenException('Only the Workspace owner can transfer ownership');
      if (workspace.archivedAt || workspace.trashedAt) throw new ConflictException('Workspace is archived or trashed');
      if (targetId === userId) throw new ConflictException('Choose another active member');
      const target = await tx.workspaceMember.findUnique({ where: { workspaceId_userId: { workspaceId, userId: targetId } }, select: { leftAt: true } });
      if (!target || target.leftAt) throw new ConflictException('Choose another active member');
      await tx.workspace.update({ where: { id: workspaceId }, data: { ownerId: targetId, lifecycleRevision: { increment: 1 }, updatedAt: new Date() } });
      return this.detail(tx, workspaceId);
    });
  }

  async lifecycle(userId: string, workspaceId: string, action: 'archive' | 'trash' | 'restore', expectedRevision: number) {
    return this.health.prisma.$transaction(async tx => {
      const allowed = await tx.$queryRaw<Array<{ id: string }>>`SELECT "id" FROM contextflow."Workspace" WHERE "id"=${workspaceId}::uuid AND "ownerId"=${userId}::uuid AND EXISTS (SELECT 1 FROM contextflow."WorkspaceMember" WHERE "workspaceId"=${workspaceId}::uuid AND "userId"=${userId}::uuid AND "leftAt" IS NULL)`;
      if (!allowed.length) throw new NotFoundException('Workspace not found');
      const lockJobs = async () => tx.$queryRaw<Array<{ id: string }>>`SELECT j."id" FROM contextflow."Job" j JOIN contextflow."Project" p ON p."id"=j."projectId" WHERE p."workspaceId"=${workspaceId}::uuid AND j."status" IN ('QUEUED','RETRY_WAIT','RUNNING') ORDER BY j."id" FOR UPDATE OF j`;
      const prelockedJobs = await lockJobs();
      const workspace = await this.locked(tx, workspaceId);
      await this.activeMember(tx, workspaceId, userId);
      if (workspace.ownerId !== userId) throw new ForbiddenException('Only the Workspace owner can archive it');
      if (workspace.lifecycleRevision !== expectedRevision) throw new ConflictException('Workspace changed; reload before changing lifecycle');
      const count = await tx.workspaceMember.count({ where: { workspaceId, leftAt: null } });
      if (count !== 1) throw new ConflictException('Only a sole owner can archive the Workspace');
      const pendingAfterWorkspaceLock = await tx.$queryRaw<Array<{ id: string }>>`SELECT j."id" FROM contextflow."Job" j JOIN contextflow."Project" p ON p."id"=j."projectId" WHERE p."workspaceId"=${workspaceId}::uuid AND j."status" IN ('QUEUED','RETRY_WAIT','RUNNING') ORDER BY j."id"`;
      const prelockedIds = new Set(prelockedJobs.map(job => job.id));
      if (pendingAfterWorkspaceLock.some(job => !prelockedIds.has(job.id))) throw new ConflictException('New work started; retry the lifecycle change');
      const jobsLocked = prelockedJobs;
      const now = new Date();
      const data = action === 'archive'
        ? (!workspace.archivedAt && !workspace.trashedAt ? { archivedAt: now } : null)
        : action === 'trash'
          ? (!workspace.trashedAt ? { trashedAt: now, purgeAfter: new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000) } : null)
          : (workspace.trashedAt ? { trashedAt: null, purgeAfter: null } : workspace.archivedAt ? { archivedAt: null } : null);
      if (!data) throw new ConflictException('Workspace lifecycle state changed; reload before continuing');
      await tx.workspace.update({ where: { id: workspaceId }, data: { ...data, lifecycleRevision: { increment: 1 }, updatedAt: now } });
      if (action !== 'restore') await this.cancelPendingJobs(tx, workspaceId, now, jobsLocked.map(job => job.id));
      return this.detail(tx, workspaceId);
    });
  }

  async purge(userId: string, workspaceId: string, expectedRevision: number) {
    const access = await this.health.prisma.workspace.findFirst({ where: { id: workspaceId, members: { some: { userId, leftAt: null } } },
      select: { ownerId: true, members: { where: { leftAt: null }, select: { userId: true } } } });
    if (!access) throw new NotFoundException('Workspace not found');
    if (access.ownerId !== userId || access.members.length !== 1) throw new ForbiddenException('Only the active sole Workspace owner may permanently delete this Workspace');
    try { return await this.health.prisma.$transaction(async tx => {
      const rows = await tx.$queryRaw<Array<{ result: { workspaceId: string; deletedProjects: number; cleanupPending: number } }>>`SELECT contextflow.purge_workspace_graph(${workspaceId}::uuid,${userId}::uuid,${expectedRevision}) AS result`;
      const result = rows[0]?.result;
      if (!result) throw new ConflictException('Workspace purge did not complete');
      return { purge: result, cleanupPending: result.cleanupPending > 0 };
    }); } catch (error) { mapPurgeDatabaseError(error); }
  }

  private async cancelPendingJobs(tx: WorkspaceTx, workspaceId: string, now: Date, ids: string[]) {
    const jobs = await tx.job.findMany({ where: { id: { in: ids }, project: { workspaceId }, status: { in: ['QUEUED', 'RETRY_WAIT', 'RUNNING'] } }, select: { id: true, status: true, providerOutcome: true } });
    for (const job of jobs) {
      const unknown = ['MAY_STILL_RUN', 'UNKNOWN'].includes(job.providerOutcome);
      const activeAttempts = await tx.jobAttempt.findMany({ where: { jobId: job.id, finishedAt: null }, select: { id: true, providerOutcome: true } });
      for (const attempt of activeAttempts) {
        const executionStatus = attempt.providerOutcome === 'KNOWN_SUCCEEDED' ? 'SUCCEEDED' : ['MAY_STILL_RUN', 'UNKNOWN'].includes(attempt.providerOutcome) ? 'OUTCOME_UNKNOWN' : 'FAILED';
        await tx.aIExecution.updateMany({ where: { attemptId: attempt.id, status: 'RUNNING' }, data: {
          status: executionStatus, finishedAt: now, ...(executionStatus === 'SUCCEEDED' ? {} : { errorCategory: 'WORKSPACE_LIFECYCLE_CANCELLED' })
        } });
      }
      await tx.jobAttempt.updateMany({ where: { jobId: job.id, finishedAt: null }, data: { finishedAt: now, errorCategory: 'WORKSPACE_LIFECYCLE_CANCELLED' } });
      await tx.job.updateMany({ where: { id: job.id, status: { in: ['QUEUED', 'RETRY_WAIT', 'RUNNING'] } }, data: {
        status: unknown ? 'OUTCOME_UNKNOWN' : 'CANCELLED', cancelRequestedAt: now, fencingToken: { increment: 1 },
        progressStage: unknown ? 'OUTCOME_UNKNOWN' : 'CANCELLED', errorCategory: 'WORKSPACE_LIFECYCLE_CANCELLED',
        ...(!unknown && (job.status === 'QUEUED' || job.status === 'RETRY_WAIT') ? { providerOutcome: 'NOT_SUBMITTED' as const } : {}),
        ...(unknown ? { errorCategory: 'WORKSPACE_LIFECYCLE_CANCELLED' } : {}), updatedAt: now
      } });
    }
  }

  async style(userId: string, workspaceId: string) {
    return this.health.prisma.$transaction(async tx => {
      const workspace = await this.locked(tx, workspaceId);
      await this.activeMember(tx, workspaceId, userId);
      if (workspace.trashedAt) throw new NotFoundException('Workspace not found');
      const style = await tx.workspaceStyleRevision.findUniqueOrThrow({ where: { workspaceId_revision: { workspaceId, revision: workspace.styleRevision } } });
      return { style: styleView(style) };
    });
  }

  async updateStyle(userId: string, workspaceId: string, input: UpdateStyleInput) {
    return this.health.prisma.$transaction(async tx => {
      const workspace = await this.locked(tx, workspaceId);
      await this.activeMember(tx, workspaceId, userId);
      if (workspace.archivedAt || workspace.trashedAt) throw new ConflictException('Workspace is archived or trashed');
      if (workspace.styleRevision !== input.expectedRevision) throw new ConflictException('Workspace style changed; reload before saving');
      const previous = await tx.workspaceStyleRevision.findUniqueOrThrow({ where: { workspaceId_revision: { workspaceId, revision: workspace.styleRevision } } });
      const revision = workspace.styleRevision + 1;
      const style = await tx.workspaceStyleRevision.create({ data: { workspaceId, revision, createdBy: userId,
        brandbook: input.brandbook ?? previous.brandbook, tone: input.tone ?? previous.tone,
        settings: input.settings ?? JSON.parse(JSON.stringify(previous.settings)) as Prisma.InputJsonValue } });
      await tx.workspace.update({ where: { id: workspaceId }, data: { styleRevision: revision, updatedAt: new Date() } });
      return { style: styleView(style) };
    });
  }
}
