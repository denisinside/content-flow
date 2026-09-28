import { ConflictException, ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { DependencyHealthService, type Prisma } from '@contextflow/backend';
import { opaqueToken, tokenDigest } from '../auth/session-crypto.js';
import type { SessionUser } from '../auth/session-service.js';
import type { UpdateStyleInput } from './workspace-input.js';

const workspaceSelect = { id: true, name: true, ownerId: true, styleRevision: true, createdAt: true, updatedAt: true, archivedAt: true } as const;
const detailSelect = { ...workspaceSelect, members: { where: { leftAt: null }, select: { userId: true, joinedAt: true, user: { select: { displayName: true } } }, orderBy: { joinedAt: 'asc' } } } as const;
type WorkspaceRecord = Prisma.WorkspaceGetPayload<{ select: typeof workspaceSelect }>;
type WorkspaceDetail = Prisma.WorkspaceGetPayload<{ select: typeof detailSelect }>;
type WorkspaceTx = Prisma.TransactionClient;

function view(workspace: WorkspaceRecord | WorkspaceDetail) {
  return { id: workspace.id, name: workspace.name, ownerId: workspace.ownerId, styleRevision: workspace.styleRevision,
    createdAt: workspace.createdAt.toISOString(), updatedAt: workspace.updatedAt.toISOString(), archivedAt: workspace.archivedAt?.toISOString() ?? null,
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
      if (workspace.archivedAt) throw new ConflictException('Workspace is archived');
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
      if (workspace.archivedAt) throw new ConflictException('Workspace is archived');
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
      return this.detail(tx, candidate.workspaceId);
    });
  }

  async leave(userId: string, workspaceId: string) {
    await this.health.prisma.$transaction(async tx => {
      const workspace = await this.locked(tx, workspaceId);
      await this.activeMember(tx, workspaceId, userId);
      if (workspace.ownerId === userId) {
        const count = await tx.workspaceMember.count({ where: { workspaceId, leftAt: null } });
        if (count > 1) throw new ConflictException('Transfer ownership before leaving');
        if (workspace.archivedAt) throw new ConflictException('Workspace is already archived');
        await tx.workspace.update({ where: { id: workspaceId }, data: { archivedAt: new Date(), updatedAt: new Date() } });
        return;
      }
      await tx.workspaceMember.update({ where: { workspaceId_userId: { workspaceId, userId } }, data: { leftAt: new Date() } });
      await tx.workspace.update({ where: { id: workspaceId }, data: { updatedAt: new Date() } });
    });
  }

  async transfer(userId: string, workspaceId: string, targetId: string) {
    return this.health.prisma.$transaction(async tx => {
      const workspace = await this.locked(tx, workspaceId);
      await this.activeMember(tx, workspaceId, userId);
      if (workspace.ownerId !== userId) throw new ForbiddenException('Only the Workspace owner can transfer ownership');
      if (workspace.archivedAt) throw new ConflictException('Workspace is archived');
      if (targetId === userId) throw new ConflictException('Choose another active member');
      const target = await tx.workspaceMember.findUnique({ where: { workspaceId_userId: { workspaceId, userId: targetId } }, select: { leftAt: true } });
      if (!target || target.leftAt) throw new ConflictException('Choose another active member');
      await tx.workspace.update({ where: { id: workspaceId }, data: { ownerId: targetId, updatedAt: new Date() } });
      return this.detail(tx, workspaceId);
    });
  }

  async archive(userId: string, workspaceId: string) {
    return this.health.prisma.$transaction(async tx => {
      const workspace = await this.locked(tx, workspaceId);
      await this.activeMember(tx, workspaceId, userId);
      if (workspace.ownerId !== userId) throw new ForbiddenException('Only the Workspace owner can archive it');
      if (workspace.archivedAt) throw new ConflictException('Workspace is already archived');
      const count = await tx.workspaceMember.count({ where: { workspaceId, leftAt: null } });
      if (count !== 1) throw new ConflictException('Only a sole owner can archive the Workspace');
      await tx.workspace.update({ where: { id: workspaceId }, data: { archivedAt: new Date(), updatedAt: new Date() } });
      return this.detail(tx, workspaceId);
    });
  }

  async restore(userId: string, workspaceId: string) {
    return this.health.prisma.$transaction(async tx => {
      const workspace = await this.locked(tx, workspaceId);
      await this.activeMember(tx, workspaceId, userId);
      if (workspace.ownerId !== userId) throw new ForbiddenException('Only the Workspace owner can restore it');
      if (!workspace.archivedAt) throw new ConflictException('Workspace is already active');
      await tx.workspace.update({ where: { id: workspaceId }, data: { archivedAt: null, updatedAt: new Date() } });
      return this.detail(tx, workspaceId);
    });
  }

  async style(userId: string, workspaceId: string) {
    return this.health.prisma.$transaction(async tx => {
      const workspace = await this.locked(tx, workspaceId);
      await this.activeMember(tx, workspaceId, userId);
      const style = await tx.workspaceStyleRevision.findUniqueOrThrow({ where: { workspaceId_revision: { workspaceId, revision: workspace.styleRevision } } });
      return { style: styleView(style) };
    });
  }

  async updateStyle(userId: string, workspaceId: string, input: UpdateStyleInput) {
    return this.health.prisma.$transaction(async tx => {
      const workspace = await this.locked(tx, workspaceId);
      await this.activeMember(tx, workspaceId, userId);
      if (workspace.archivedAt) throw new ConflictException('Workspace is archived');
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
