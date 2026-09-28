import { ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { DependencyHealthService, type Prisma } from '@contextflow/backend';
import type { CreateProjectInput, UpdateProjectInput } from './project-input.js';

const projectSelect = { id: true, workspaceId: true, topic: true, formats: true, revision: true, createdAt: true, updatedAt: true, archivedAt: true } as const;
type ProjectRecord = Prisma.ProjectGetPayload<{ select: typeof projectSelect }>;
function view(project: ProjectRecord) {
  return { ...project, createdAt: project.createdAt.toISOString(), updatedAt: project.updatedAt.toISOString(), archivedAt: project.archivedAt?.toISOString() ?? null };
}

@Injectable()
export class ProjectService {
  constructor(@Inject(DependencyHealthService) private readonly health: DependencyHealthService) {}

  async list(userId: string, cursor?: string, workspaceId?: string) {
    const where = { ...(workspaceId ? { workspaceId } : {}), workspace: { members: { some: { userId, leftAt: null } } } };
    const anchor = cursor ? await this.health.prisma.project.findFirst({ where: { id: cursor, ...where }, select: { id: true, createdAt: true } }) : null;
    if (cursor && !anchor) throw new NotFoundException('Project not found');
    const rows = await this.health.prisma.project.findMany({ where: { ...where, ...(anchor ? { OR: [
      { createdAt: { lt: anchor.createdAt } }, { createdAt: anchor.createdAt, id: { lt: anchor.id } }
    ] } : {}) }, select: projectSelect, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: 51 });
    const projects = rows.slice(0, 50);
    return { projects: projects.map(view), nextCursor: rows.length > 50 ? projects.at(-1)?.id ?? null : null };
  }

  async create(userId: string, input: CreateProjectInput) {
    return this.health.prisma.$transaction(async tx => {
      // A shared Workspace row prevents concurrent archive while the Project is created.
      const workspaces = await tx.$queryRaw<Array<{ id: string }>>`SELECT "id" FROM contextflow."Workspace" WHERE "id" = ${input.workspaceId}::uuid AND "archivedAt" IS NULL FOR SHARE`;
      if (!workspaces.length) throw new NotFoundException('Workspace not found');
      const membership = await tx.$queryRaw<Array<{ userId: string }>>`SELECT "userId" FROM contextflow."WorkspaceMember" WHERE "workspaceId" = ${input.workspaceId}::uuid AND "userId" = ${userId}::uuid AND "leftAt" IS NULL FOR SHARE`;
      if (!membership.length) throw new NotFoundException('Workspace not found');
      const project = await tx.project.create({ data: { id: randomUUID(), workspaceId: input.workspaceId, createdBy: userId,
        topic: input.topic, formats: input.formats }, select: projectSelect });
      return { project: view(project) };
    });
  }

  async get(userId: string, id: string) {
    const project = await this.health.prisma.project.findFirst({ where: { id, workspace: { members: { some: { userId, leftAt: null } } } }, select: projectSelect });
    if (!project) throw new NotFoundException('Project not found');
    return { project: view(project) };
  }

  async update(userId: string, id: string, input: UpdateProjectInput) {
    return this.health.prisma.$transaction(async tx => {
      // Resolve the actual ancestry and hold Workspace/membership until commit.
      const membership = await tx.$queryRaw<Array<{ workspaceId: string }>>`SELECT p."workspaceId" FROM contextflow."Project" p JOIN contextflow."Workspace" w ON w."id" = p."workspaceId" JOIN contextflow."WorkspaceMember" m ON m."workspaceId" = w."id" WHERE p."id" = ${id}::uuid AND m."userId" = ${userId}::uuid AND m."leftAt" IS NULL AND w."archivedAt" IS NULL FOR SHARE OF w, m`;
      if (!membership.length) throw new NotFoundException('Project not found');
      const result = await tx.project.updateMany({ where: { id, revision: input.expectedRevision, archivedAt: null }, data: {
        ...(input.topic !== undefined ? { topic: input.topic } : {}), ...(input.formats !== undefined ? { formats: input.formats } : {}),
        revision: { increment: 1 }, updatedAt: new Date()
      } });
      if (result.count !== 1) throw new ConflictException('Project changed or is archived; reload before saving');
      const project = await tx.project.findUniqueOrThrow({ where: { id }, select: projectSelect });
      return { project: view(project) };
    });
  }

  async asset(userId: string, projectId: string, id: string) {
    const asset = await this.health.prisma.asset.findFirst({ where: { id, projectId, state: 'AVAILABLE',
      project: { workspace: { members: { some: { userId, leftAt: null } } } } },
      select: { id: true, projectId: true, mediaType: true, bytes: true, sha256: true, state: true, purpose: true, createdAt: true } });
    if (!asset) throw new NotFoundException('Asset not found');
    return { asset: { ...asset, bytes: Number(asset.bytes), createdAt: asset.createdAt.toISOString() } };
  }
}
