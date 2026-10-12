import { ConflictException, ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { DependencyHealthService, type Prisma } from '@contextflow/backend';
import type { CreateProjectInput, UpdateProjectInput } from './project-input.js';

const projectSelect = { id: true, workspaceId: true, workspace: { select: { ownerId: true } }, topic: true, formats: true, revision: true, createdAt: true, updatedAt: true, archivedAt: true, trashedAt: true, purgeAfter: true } as const;
type ProjectRecord = Prisma.ProjectGetPayload<{ select: typeof projectSelect }>;
function mapPurgeDatabaseError(error: unknown): never {
  const value = error as { code?: unknown; meta?: { code?: unknown; driverAdapterError?: { code?: unknown; cause?: { code?: unknown } } } } | null;
  const sqlState = typeof value?.meta?.code === 'string' ? value.meta.code
    : typeof value?.meta?.driverAdapterError?.code === 'string' ? value.meta.driverAdapterError.code
      : typeof value?.meta?.driverAdapterError?.cause?.code === 'string' ? value.meta.driverAdapterError.cause.code : null;
  if (['P2010', 'P2039'].includes(String(value?.code)) && sqlState) {
    if (sqlState === '42501') throw new ForbiddenException('Only the active Workspace owner may permanently delete this Project');
    if (sqlState === 'P0002') throw new NotFoundException('Project not found');
    if (['55000', '40001', '40P01'].includes(sqlState)) throw new ConflictException('Project cannot be permanently deleted yet; reload and retry after resolving the lifecycle conflict');
  }
  throw error;
}
function view(project: ProjectRecord, userId: string) {
  const { workspace, ...values } = project;
  return { ...values, workspaceOwnerId: workspace.ownerId, canPurge: workspace.ownerId === userId, createdAt: project.createdAt.toISOString(), updatedAt: project.updatedAt.toISOString(), archivedAt: project.archivedAt?.toISOString() ?? null, trashedAt: project.trashedAt?.toISOString() ?? null, purgeAfter: project.purgeAfter?.toISOString() ?? null };
}

@Injectable()
export class ProjectService {
  constructor(@Inject(DependencyHealthService) private readonly health: DependencyHealthService) {}

  async list(userId: string, cursor?: string, workspaceId?: string, state?: 'ACTIVE' | 'ARCHIVED' | 'TRASHED') {
    const lifecycle = state === 'ACTIVE' ? { archivedAt: null, trashedAt: null } : state === 'ARCHIVED' ? { archivedAt: { not: null }, trashedAt: null } : state === 'TRASHED' ? { trashedAt: { not: null } } : {};
    const where = { ...(workspaceId ? { workspaceId } : {}), ...lifecycle, workspace: { members: { some: { userId, leftAt: null } } } };
    const anchor = cursor ? await this.health.prisma.project.findFirst({ where: { id: cursor, ...where }, select: { id: true, createdAt: true } }) : null;
    if (cursor && !anchor) throw new NotFoundException('Project not found');
    const rows = await this.health.prisma.project.findMany({ where: { ...where, ...(anchor ? { OR: [
      { createdAt: { lt: anchor.createdAt } }, { createdAt: anchor.createdAt, id: { lt: anchor.id } }
    ] } : {}) }, select: projectSelect, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: 51 });
    const projects = rows.slice(0, 50);
    return { projects: projects.map(project => view(project, userId)), nextCursor: rows.length > 50 ? projects.at(-1)?.id ?? null : null };
  }

  async create(userId: string, input: CreateProjectInput) {
    return this.health.prisma.$transaction(async tx => {
      // A shared Workspace row prevents concurrent archive while the Project is created.
      const workspaces = await tx.$queryRaw<Array<{ id: string }>>`SELECT "id" FROM contextflow."Workspace" WHERE "id" = ${input.workspaceId}::uuid AND "archivedAt" IS NULL AND "trashedAt" IS NULL FOR SHARE`;
      if (!workspaces.length) throw new NotFoundException('Workspace not found');
      const membership = await tx.$queryRaw<Array<{ userId: string }>>`SELECT "userId" FROM contextflow."WorkspaceMember" WHERE "workspaceId" = ${input.workspaceId}::uuid AND "userId" = ${userId}::uuid AND "leftAt" IS NULL FOR SHARE`;
      if (!membership.length) throw new NotFoundException('Workspace not found');
      const project = await tx.project.create({ data: { id: randomUUID(), workspaceId: input.workspaceId, createdBy: userId,
        topic: input.topic, formats: input.formats }, select: projectSelect });
      return { project: view(project, userId) };
    });
  }

  async get(userId: string, id: string) {
    const project = await this.health.prisma.project.findFirst({ where: { id, trashedAt: null, workspace: { trashedAt: null, members: { some: { userId, leftAt: null } } } }, select: projectSelect });
    if (!project) throw new NotFoundException('Project not found');
    return { project: view(project, userId) };
  }

  async update(userId: string, id: string, input: UpdateProjectInput) {
    return this.health.prisma.$transaction(async tx => {
      // Resolve the actual ancestry and hold Workspace/membership until commit.
      const membership = await tx.$queryRaw<Array<{ workspaceId: string }>>`SELECT p."workspaceId" FROM contextflow."Project" p JOIN contextflow."Workspace" w ON w."id" = p."workspaceId" JOIN contextflow."WorkspaceMember" m ON m."workspaceId" = w."id" WHERE p."id" = ${id}::uuid AND m."userId" = ${userId}::uuid AND m."leftAt" IS NULL AND w."archivedAt" IS NULL AND w."trashedAt" IS NULL FOR SHARE OF w, m`;
      if (!membership.length) throw new NotFoundException('Project not found');
      const result = await tx.project.updateMany({ where: { id, revision: input.expectedRevision, archivedAt: null, trashedAt: null }, data: {
        ...(input.topic !== undefined ? { topic: input.topic } : {}), ...(input.formats !== undefined ? { formats: input.formats } : {}),
        revision: { increment: 1 }, updatedAt: new Date()
      } });
      if (result.count !== 1) throw new ConflictException('Project changed or is archived; reload before saving');
      const project = await tx.project.findUniqueOrThrow({ where: { id }, select: projectSelect });
      return { project: view(project, userId) };
    });
  }

  async lifecycle(userId: string, id: string, action: 'archive' | 'trash' | 'restore', expectedRevision: number) {
    return this.health.prisma.$transaction(async tx => {
      const access = await tx.$queryRaw<Array<{ id: string }>>`SELECT p."id" FROM contextflow."Project" p JOIN contextflow."Workspace" w ON w."id"=p."workspaceId" JOIN contextflow."WorkspaceMember" m ON m."workspaceId"=w."id" WHERE p."id"=${id}::uuid AND m."userId"=${userId}::uuid AND m."leftAt" IS NULL AND w."archivedAt" IS NULL AND w."trashedAt" IS NULL`;
      if (!access.length) throw new NotFoundException('Project not found');
      const lockJobs = async () => tx.$queryRaw<Array<{ id: string }>>`SELECT "id" FROM contextflow."Job" WHERE "projectId"=${id}::uuid AND "status" IN ('QUEUED','RETRY_WAIT','RUNNING') ORDER BY "id" FOR UPDATE`;
      const prelockedJobs = await lockJobs();
      const projectLocks = await tx.$queryRaw<Array<{ id: string }>>`SELECT "id" FROM contextflow."Project" WHERE "id"=${id}::uuid FOR UPDATE`;
      if (!projectLocks.length) throw new NotFoundException('Project not found');
      const pendingAfterProjectLock = await tx.$queryRaw<Array<{ id: string }>>`SELECT "id" FROM contextflow."Job" WHERE "projectId"=${id}::uuid AND "status" IN ('QUEUED','RETRY_WAIT','RUNNING') ORDER BY "id"`;
      const prelockedIds = new Set(prelockedJobs.map(job => job.id));
      if (pendingAfterProjectLock.some(job => !prelockedIds.has(job.id))) throw new ConflictException('New work started; retry the lifecycle change');
      const jobsLocked = prelockedJobs;
      const membership = await tx.$queryRaw<Array<{ workspaceId: string }>>`SELECT p."workspaceId" FROM contextflow."Project" p JOIN contextflow."Workspace" w ON w."id"=p."workspaceId" JOIN contextflow."WorkspaceMember" m ON m."workspaceId"=w."id" WHERE p."id"=${id}::uuid AND m."userId"=${userId}::uuid AND m."leftAt" IS NULL AND w."archivedAt" IS NULL AND w."trashedAt" IS NULL FOR SHARE OF w, m`;
      if (!membership.length) throw new NotFoundException('Project not found');
      const current = await tx.project.findUnique({ where: { id }, select: { revision: true, archivedAt: true, trashedAt: true } });
      if (!current) throw new NotFoundException('Project not found');
      if (current.revision !== expectedRevision) throw new ConflictException('Project changed; reload before changing lifecycle');
      const now = new Date();
      const data = action === 'archive'
        ? (current.archivedAt || current.trashedAt ? null : { archivedAt: now, revision: { increment: 1 }, updatedAt: now })
        : action === 'trash'
          ? (current.trashedAt ? null : { trashedAt: now, purgeAfter: new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000), revision: { increment: 1 }, updatedAt: now })
          : (!current.trashedAt && !current.archivedAt ? null : current.trashedAt
            ? { trashedAt: null, purgeAfter: null, revision: { increment: 1 }, updatedAt: now }
            : { archivedAt: null, revision: { increment: 1 }, updatedAt: now });
      if (!data) throw new ConflictException('Project lifecycle state changed; reload before continuing');
      await tx.project.update({ where: { id }, data });
      const jobs = action === 'restore' ? [] : await tx.job.findMany({ where: { id: { in: jobsLocked.map(job => job.id) }, status: { in: ['QUEUED', 'RETRY_WAIT', 'RUNNING'] } }, select: { id: true, status: true, providerOutcome: true } });
      for (const job of jobs) {
        const unknown = ['MAY_STILL_RUN', 'UNKNOWN'].includes(job.providerOutcome);
        const activeAttempts = await tx.jobAttempt.findMany({ where: { jobId: job.id, finishedAt: null }, select: { id: true, providerOutcome: true } });
        for (const attempt of activeAttempts) {
          const executionStatus = attempt.providerOutcome === 'KNOWN_SUCCEEDED' ? 'SUCCEEDED' : ['MAY_STILL_RUN', 'UNKNOWN'].includes(attempt.providerOutcome) ? 'OUTCOME_UNKNOWN' : 'FAILED';
          await tx.aIExecution.updateMany({ where: { attemptId: attempt.id, status: 'RUNNING' }, data: {
            status: executionStatus, finishedAt: now, ...(executionStatus === 'SUCCEEDED' ? {} : { errorCategory: 'PROJECT_LIFECYCLE_CANCELLED' })
          } });
        }
        await tx.jobAttempt.updateMany({ where: { jobId: job.id, finishedAt: null }, data: { finishedAt: now, errorCategory: 'PROJECT_LIFECYCLE_CANCELLED' } });
        await tx.job.updateMany({ where: { id: job.id, status: { in: ['QUEUED', 'RETRY_WAIT', 'RUNNING'] } }, data: {
          status: unknown ? 'OUTCOME_UNKNOWN' : 'CANCELLED', progressStage: unknown ? 'OUTCOME_UNKNOWN' : 'CANCELLED',
          cancelRequestedAt: now, fencingToken: { increment: 1 }, errorCategory: 'PROJECT_LIFECYCLE_CANCELLED',
          ...(!unknown && (job.status === 'QUEUED' || job.status === 'RETRY_WAIT') ? { providerOutcome: 'NOT_SUBMITTED' as const } : {}), updatedAt: now
        } });
      }
      const project = await tx.project.findUniqueOrThrow({ where: { id }, select: projectSelect });
      return { project: view(project, userId), cancelledJobs: jobs.length };
    });
  }

  async purge(userId: string, id: string, expectedRevision: number) {
    const access = await this.health.prisma.project.findFirst({ where: { id, workspace: { members: { some: { userId, leftAt: null } } } }, select: { workspace: { select: { ownerId: true } } } });
    if (!access) throw new NotFoundException('Project not found');
    if (access.workspace.ownerId !== userId) throw new ForbiddenException('Only the active Workspace owner may permanently delete this Project');
    try { return await this.health.prisma.$transaction(async tx => {
      const rows = await tx.$queryRaw<Array<{ result: { projectId: string; deletedRows: number; cleanupPending: number } }>>`SELECT contextflow.purge_project_graph(${id}::uuid,${userId}::uuid,${expectedRevision}) AS result`;
      const result = rows[0]?.result;
      if (!result) throw new ConflictException('Project purge did not complete');
      return { purge: result, cleanupPending: result.cleanupPending > 0 };
    }); } catch (error) { mapPurgeDatabaseError(error); }
  }

  async asset(userId: string, projectId: string, id: string) {
    const asset = await this.health.prisma.asset.findFirst({ where: { id, projectId, state: 'AVAILABLE',
      project: { archivedAt: null, trashedAt: null, workspace: { archivedAt: null, trashedAt: null, members: { some: { userId, leftAt: null } } } } },
      select: { id: true, projectId: true, mediaType: true, bytes: true, sha256: true, state: true, purpose: true, createdAt: true } });
    if (!asset) throw new NotFoundException('Asset not found');
    return { asset: { ...asset, bytes: Number(asset.bytes), createdAt: asset.createdAt.toISOString() } };
  }
}
