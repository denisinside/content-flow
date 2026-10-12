import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { Prisma, PrismaClient, Job } from '../generated/prisma/client.js';
import { FactualBasisService } from '../claims/factual-basis.service.js';
import { DurableJobService, canonicalManifestHash } from '../jobs/job-service.js';
import { JobFailure } from '../jobs/contracts.js';
import { EXTERNAL_PROCESSING_NOTICE } from '../external-processing-notice.js';
import { outlineContentSchema, outlineInputManifestSchema, outlineWorkflowReleaseSchema,
  type SaveBriefInput, type ManualOutlineInput, type OutlineContent, type OutlineWorkflowRelease } from './contracts.js';

const briefInclude = { requiredClaims: true, contextSnapshots: true, style: true } as const;
function json<T>(value: T): T { return JSON.parse(JSON.stringify(value)) as T; }
type BriefHashInput = { contentMode: string; topic: string; audience: string; centralMessage: string; category: string;
  tone: string; targetLength: number; cta: string; exclusions: unknown; notes: string; workspaceId: string;
  workspaceStyleRevision: number; style: unknown; requiredClaims: readonly { claimRevisionId: string }[];
  contextSnapshots: readonly { snapshotId: string; capturedPurpose: string }[] };
export function canonicalBriefHash(brief: BriefHashInput): string {
  return canonicalManifestHash({ contentMode: brief.contentMode, topic: brief.topic, audience: brief.audience,
    centralMessage: brief.centralMessage, category: brief.category, tone: brief.tone, targetLength: brief.targetLength,
    cta: brief.cta, exclusions: brief.exclusions, notes: brief.notes, workspaceId: brief.workspaceId,
    workspaceStyleRevision: brief.workspaceStyleRevision, style: json(brief.style),
    requiredClaimRevisionIds: brief.requiredClaims.map(row => row.claimRevisionId).sort(),
    contextSnapshots: [...brief.contextSnapshots].map(row => ({ snapshotId: row.snapshotId, capturedPurpose: row.capturedPurpose }))
      .sort((a, b) => a.snapshotId.localeCompare(b.snapshotId)) });
}
function revisionView<T extends { approvedAt: Date | null; withdrawnAt: Date | null }>(value: T) {
  return { ...json(value), status: value.withdrawnAt ? 'WITHDRAWN' : value.approvedAt ? 'APPROVED' : 'PROPOSED' };
}

export class EditorialService {
  constructor(readonly prisma: PrismaClient, private readonly jobs: DurableJobService, private readonly facts: FactualBasisService) {}
  private async lock(tx: Prisma.TransactionClient, userId: string, projectId: string, write = true) {
    const rows = write ? await tx.$queryRaw<Array<{ id: string }>>`SELECT p."id" FROM contextflow."Project" p
      JOIN contextflow."Workspace" w ON w."id"=p."workspaceId" JOIN contextflow."WorkspaceMember" m ON m."workspaceId"=w."id"
      WHERE p."id"=${projectId}::uuid AND p."archivedAt" IS NULL AND p."trashedAt" IS NULL AND w."archivedAt" IS NULL AND w."trashedAt" IS NULL AND m."userId"=${userId}::uuid AND m."leftAt" IS NULL
      FOR UPDATE OF p FOR SHARE OF w,m`
      : await tx.$queryRaw<Array<{ id: string }>>`SELECT p."id" FROM contextflow."Project" p
      JOIN contextflow."Workspace" w ON w."id"=p."workspaceId" JOIN contextflow."WorkspaceMember" m ON m."workspaceId"=w."id"
      WHERE p."id"=${projectId}::uuid AND p."trashedAt" IS NULL AND w."trashedAt" IS NULL AND m."userId"=${userId}::uuid AND m."leftAt" IS NULL FOR SHARE OF p,w,m`;
    if (!rows.length) throw new NotFoundException('Project not found');
  }
  private command<T>(user: string, project: string, callback: (tx: Prisma.TransactionClient) => Promise<T>, write = true) {
    return this.prisma.$transaction(async tx => { await this.lock(tx, user, project, write); return callback(tx); });
  }
  private async state(tx: Prisma.TransactionClient, projectId: string) {
    const project = await tx.project.findUniqueOrThrow({ where: { id: projectId }, include: { workspace: true } });
    const style = await tx.workspaceStyleRevision.findUniqueOrThrow({ where: { workspaceId_revision: {
      workspaceId: project.workspaceId, revision: project.workspace.styleRevision } } });
    const brief = await tx.brief.findUnique({ where: { projectId }, include: { currentRevision: { include: briefInclude },
      revisions: { include: briefInclude, orderBy: { number: 'desc' } } } });
    const outline = await tx.outline.findUnique({ where: { projectId }, include: { currentRevision: true, revisions: { orderBy: { number: 'desc' } } } });
    return { brief: brief ? { id: brief.id, revision: brief.revision, currentRevision: json(brief.currentRevision), history: json(brief.revisions) } : null,
      outline: outline ? { id: outline.id, revision: outline.revision, currentApprovedRevisionId: outline.currentApprovedRevisionId,
        currentRevision: outline.currentRevision ? revisionView(outline.currentRevision) : null, revisions: outline.revisions.map(revisionView) } : null,
      style: json(style), articleSelected: project.formats.includes('ARTICLE'),
      prerequisites: await this.facts.inspectBasis(tx, projectId, brief?.currentRevision?.contentMode ?? 'FACTUAL') };
  }
  get(userId: string, projectId: string) { return this.command(userId, projectId, tx => this.state(tx, projectId), false); }
  async saveBrief(userId: string, projectId: string, input: SaveBriefInput) {
    return this.command(userId, projectId, async tx => {
      const previous = await tx.brief.findUnique({ where: { projectId } });
      if ((previous?.revision ?? 0) !== input.expectedRevision) throw new ConflictException('Brief changed; retain your text and reload before saving');
      const project = await tx.project.findUniqueOrThrow({ where: { id: projectId }, include: { workspace: true } });
      const style = await tx.workspaceStyleRevision.findUniqueOrThrow({ where: { workspaceId_revision: { workspaceId: project.workspaceId, revision: project.workspace.styleRevision } } });
      const prerequisites = await this.facts.inspectBasis(tx, projectId, input.contentMode);
      if (input.contentMode === 'CREATIVE' && input.requiredClaimRevisionIds.length) throw new BadRequestException('Creative briefs cannot cite factual claims');
      const eligible = new Set(prerequisites.eligibleClaims.map(claim => claim.currentRevisionId));
      if (input.requiredClaimRevisionIds.some(id => !eligible.has(id))) throw new BadRequestException('Required facts must be approved eligible current claims of this project');
      const contexts = await tx.material.findMany({ where: { projectId, included: true, purpose: { in: ['NOTES', 'BRANDBOOK', 'STYLE_SAMPLE'] }, currentSnapshotId: { not: null } }, orderBy: { id: 'asc' }, take: 101 });
      if (contexts.length > 100) throw new BadRequestException('Brief accepts at most 100 context snapshots');
      const brief = previous ?? await tx.brief.create({ data: { id: randomUUID(), projectId } });
      const latest = await tx.briefRevision.findFirst({ where: { briefId: brief.id }, orderBy: { number: 'desc' } });
      const { expectedRevision: _expected, requiredClaimRevisionIds: requiredInput, ...fields } = input;
      void _expected;
      const requiredClaimRevisionIds = [...requiredInput].sort();
      const content = { ...fields, tone: input.tone?.trim() ? input.tone : style.tone };
      const capturedStyle = { workspaceId: project.workspaceId, workspaceStyleRevision: style.revision, style };
      const contextSnapshots = contexts.map(row => ({ snapshotId: row.currentSnapshotId!, capturedPurpose: row.purpose })).sort((a, b) => a.snapshotId.localeCompare(b.snapshotId));
      const id = randomUUID();
      await tx.briefRevision.create({ data: { ...content, id, projectId, briefId: brief.id, number: (latest?.number ?? 0) + 1,
        workspaceId: project.workspaceId, workspaceStyleRevision: style.revision, createdBy: userId,
        sha256: canonicalBriefHash({ ...content, ...capturedStyle, requiredClaims: requiredClaimRevisionIds.map(claimRevisionId => ({ claimRevisionId })), contextSnapshots }) } });
      if (requiredClaimRevisionIds.length) await tx.briefRequiredClaim.createMany({ data: requiredClaimRevisionIds.map(claimRevisionId => ({ projectId, briefRevisionId: id, claimRevisionId })) });
      if (contexts.length) await tx.briefContextSnapshot.createMany({ data: contextSnapshots.map(row => ({ projectId, briefRevisionId: id, ...row })) });
      await tx.brief.update({ where: { id: brief.id }, data: { currentRevisionId: id, ...(previous ? { revision: { increment: 1 } } : {}) } });
      return this.state(tx, projectId);
    });
  }
  private async currentInputs(tx: Prisma.TransactionClient, projectId: string, briefRevisionId: string, requireBasis: boolean) {
    const project = await tx.project.findUniqueOrThrow({ where: { id: projectId }, include: { workspace: true } });
    if (!project.formats.includes('ARTICLE')) throw new ConflictException('Select Article before working on an outline');
    const brief = await tx.brief.findUnique({ where: { projectId }, include: { currentRevision: { include: briefInclude } } });
    if (!brief?.currentRevision || brief.currentRevision.id !== briefRevisionId) throw new ConflictException('Outline requires the latest brief revision');
    if (canonicalBriefHash(brief.currentRevision) !== brief.currentRevision.sha256) throw new ConflictException('Brief input integrity check failed');
    if (brief.currentRevision.workspaceStyleRevision !== project.workspace.styleRevision) throw new ConflictException('Workspace style changed; save a new brief revision');
    const prerequisites = await this.facts.inspectBasis(tx, projectId, brief.currentRevision.contentMode);
    if (requireBasis && prerequisites.missingBasis) throw new ConflictException('Outline requires a valid current factual basis');
    if (requireBasis && brief.currentRevision.contentMode === 'FACTUAL') {
      const manifest = prerequisites.basis?.manifest as { claims?: { claimRevisionId: string }[] } | undefined;
      const captured = new Set(manifest?.claims?.map(row => row.claimRevisionId));
      if (brief.currentRevision.requiredClaims.some(row => !captured.has(row.claimRevisionId))) throw new ConflictException('Required facts are absent from the current factual basis');
    }
    return { brief: brief.currentRevision, prerequisites };
  }
  private checkCitations(content: OutlineContent, mode: 'FACTUAL' | 'CREATIVE', basis: { manifest: unknown } | null) {
    const claims = new Set((basis?.manifest as { claims?: { claimRevisionId: string }[] } | undefined)?.claims?.map(row => row.claimRevisionId));
    for (const section of content.sections) if (section.claimRevisionIds.some(id => mode === 'CREATIVE' || !claims.has(id))) throw new BadRequestException('Outline citations must belong to its captured factual basis');
  }
  private async appendOutline(tx: Prisma.TransactionClient, userId: string, projectId: string, briefRevisionId: string, basisRevisionId: string | null,
    mode: 'FACTUAL' | 'CREATIVE', content: OutlineContent, origin: 'MANUAL' | 'AI', jobId?: string, aiExecutionId?: string) {
    const outline = await tx.outline.findUnique({ where: { projectId } }) ?? await tx.outline.create({ data: { id: randomUUID(), projectId } });
    const last = await tx.outlineRevision.findFirst({ where: { outlineId: outline.id }, orderBy: { number: 'desc' } });
    const revision = await tx.outlineRevision.create({ data: { id: randomUUID(), projectId, outlineId: outline.id, number: (last?.number ?? 0) + 1,
      briefRevisionId, basisRevisionId, contentMode: mode, content, origin, sha256: canonicalManifestHash(content), createdBy: userId,
      ...(jobId ? { jobId } : {}), ...(aiExecutionId ? { aiExecutionId } : {}) } });
    return { outline, revision };
  }
  manualOutline(userId: string, projectId: string, input: ManualOutlineInput) {
    return this.command(userId, projectId, async tx => {
      const existing = await tx.outline.findUnique({ where: { projectId } });
      if ((existing?.revision ?? 0) !== input.expectedRevision) throw new ConflictException('Outline changed; retain your text and reload');
      const { brief, prerequisites } = await this.currentInputs(tx, projectId, input.briefRevisionId, false);
      this.checkCitations(input.content, brief.contentMode, prerequisites.basis);
      const { outline, revision } = await this.appendOutline(tx, userId, projectId, brief.id, brief.contentMode === 'FACTUAL' ? prerequisites.basis?.id ?? null : null, brief.contentMode, input.content, 'MANUAL');
      await tx.outline.update({ where: { id: outline.id }, data: { currentRevisionId: revision.id, ...(existing ? { revision: { increment: 1 } } : {}) } });
      return this.state(tx, projectId);
    });
  }
  reviewOutline(userId: string, projectId: string, revisionId: string, action: 'apply' | 'approve' | 'withdraw', input: { expectedRevision: number; reason?: string | undefined }) {
    return this.command(userId, projectId, async tx => {
      const outline = await tx.outline.findUnique({ where: { projectId } });
      if (!outline) throw new NotFoundException('Outline not found');
      if (outline.revision !== input.expectedRevision) throw new ConflictException('Outline changed; reload before review');
      const revision = await tx.outlineRevision.findFirst({ where: { id: revisionId, outlineId: outline.id, projectId } });
      if (!revision) throw new NotFoundException('Outline revision not found');
      if (revision.withdrawnAt) throw new ConflictException('Outline withdrawal is terminal');
      if (action === 'withdraw') {
        if (!revision.approvedAt) throw new ConflictException('Only an approved outline can be withdrawn');
        await tx.outlineRevision.update({ where: { id: revisionId }, data: { withdrawnAt: new Date(), withdrawnBy: userId, withdrawalReason: input.reason ?? null } });
        await tx.outline.update({ where: { id: outline.id }, data: { revision: { increment: 1 }, ...(outline.currentApprovedRevisionId === revisionId ? { currentApprovedRevisionId: null } : {}) } });
      } else {
        if (canonicalManifestHash(revision.content) !== revision.sha256) throw new ConflictException('Outline content integrity check failed');
        const { brief, prerequisites } = await this.currentInputs(tx, projectId, revision.briefRevisionId, true);
        if (revision.contentMode === 'FACTUAL' && revision.basisRevisionId !== prerequisites.basis?.id) throw new ConflictException('Outline factual basis changed; create a new revision');
        this.checkCitations(outlineContentSchema.parse(revision.content), brief.contentMode, prerequisites.basis);
        const cited = new Set(outlineContentSchema.parse(revision.content).sections.flatMap(section => section.claimRevisionIds));
        if (brief.requiredClaims.some(row => !cited.has(row.claimRevisionId))) throw new ConflictException('Outline omits required facts');
        if (action === 'approve') {
          if (outline.currentRevisionId !== revisionId || revision.approvedAt) throw new ConflictException('Approve only the current unapproved outline');
          await tx.outlineRevision.update({ where: { id: revisionId }, data: { approvedAt: new Date(), approvedBy: userId } });
        }
        await tx.outline.update({ where: { id: outline.id }, data: { revision: { increment: 1 },
          ...(action === 'apply' ? { currentRevisionId: revisionId } : { currentApprovedRevisionId: revisionId }) } });
      }
      return this.state(tx, projectId);
    });
  }
  freezeOutline(userId: string, projectId: string, commandKey: string, releaseInput: OutlineWorkflowRelease) {
    const release = outlineWorkflowReleaseSchema.parse(releaseInput);
    return this.command(userId, projectId, async tx => {
      await this.jobs.assertEffects(tx, projectId, userId);
      const current = await tx.brief.findUnique({ where: { projectId } });
      if (!current?.currentRevisionId) throw new ConflictException('Save a brief before generating an outline');
      const { brief, prerequisites } = await this.currentInputs(tx, projectId, current.currentRevisionId, true);
      const profile = await tx.userProfile.findUniqueOrThrow({ where: { id: userId } });
      const manifest = outlineInputManifestSchema.parse({ schemaVersion: 'outline-input-v1', briefRevisionId: brief.id, briefHash: brief.sha256,
        workspaceId: brief.workspaceId, workspaceStyleRevision: brief.workspaceStyleRevision, contentMode: brief.contentMode,
        basisRevisionId: brief.contentMode === 'FACTUAL' ? prerequisites.basis?.id ?? null : null,
        basisHash: brief.contentMode === 'FACTUAL' ? prerequisites.basis?.sha256 ?? null : null,
        contextSnapshotIds: brief.contextSnapshots.map(row => row.snapshotId).sort(), release,
        noticeVersion: EXTERNAL_PROCESSING_NOTICE.version, acceptedAt: profile.externalProcessingAcceptedAt?.toISOString() });
      return this.jobs.create(tx, { projectId, userId, operation: 'OUTLINE_GENERATION', contractVersion: 'outline-v1', commandKey, inputManifest: manifest, deadlineMs: 600_000 });
    });
  }
  async commitGenerated(tx: Prisma.TransactionClient, job: Job, raw: unknown, executionId: string) {
    await this.lock(tx, job.requestedBy, job.projectId);
    const content = outlineContentSchema.safeParse(raw), manifest = outlineInputManifestSchema.safeParse(job.inputManifest);
    if (!content.success || !manifest.success || job.operation !== 'OUTLINE_GENERATION' || job.contractVersion !== 'outline-v1') throw new JobFailure('INVALID_CONTRACT', 'KNOWN_SUCCEEDED');
    const frozen = manifest.data;
    const brief = await tx.briefRevision.findFirst({ where: { id: frozen.briefRevisionId, projectId: job.projectId }, include: briefInclude });
    const execution = await tx.aIExecution.findFirst({ where: { id: executionId, projectId: job.projectId, jobId: job.id } });
    const basis = frozen.basisRevisionId ? await tx.factualBasisRevision.findFirst({ where: { id: frozen.basisRevisionId, projectId: job.projectId } }) : null;
    if (!brief || !execution || canonicalBriefHash(brief) !== brief.sha256 || brief.sha256 !== frozen.briefHash || brief.workspaceId !== frozen.workspaceId
      || brief.workspaceStyleRevision !== frozen.workspaceStyleRevision || brief.contentMode !== frozen.contentMode
      || canonicalManifestHash(brief.contextSnapshots.map(row => row.snapshotId).sort()) !== canonicalManifestHash([...frozen.contextSnapshotIds].sort())
      || (frozen.contentMode === 'FACTUAL' && (!basis || basis.sha256 !== frozen.basisHash || canonicalManifestHash(basis.manifest) !== basis.sha256))) throw new JobFailure('INVALID_CONTRACT', 'KNOWN_SUCCEEDED');
    try {
      this.checkCitations(content.data, frozen.contentMode, basis);
      const cited = new Set(content.data.sections.flatMap(section => section.claimRevisionIds));
      if (brief.requiredClaims.some(row => !cited.has(row.claimRevisionId))) throw new Error('Required facts omitted');
    } catch { throw new JobFailure('INVALID_CONTRACT', 'KNOWN_SUCCEEDED'); }
    const existing = await tx.outline.findUnique({ where: { projectId: job.projectId } });
    const { outline, revision } = await this.appendOutline(tx, job.requestedBy, job.projectId, brief.id, frozen.basisRevisionId, frozen.contentMode, content.data, 'AI', job.id, executionId);
    if (existing) await tx.outline.update({ where: { id: outline.id }, data: { revision: { increment: 1 } } });
    return { outlineRevisionId: revision.id };
  }
}
