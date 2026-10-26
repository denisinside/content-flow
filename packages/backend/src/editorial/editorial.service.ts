import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Prisma, PrismaClient, Job } from '../generated/prisma/client.js';
import { FactualBasisService } from '../claims/factual-basis.service.js';
import { SourceGroundingService, type GroundingSet } from '../evidence/source-grounding.service.js';
import { DurableJobService, canonicalManifestHash } from '../jobs/job-service.js';
import { JobFailure } from '../jobs/contracts.js';
import { EXTERNAL_PROCESSING_NOTICE } from '../external-processing-notice.js';
import { outlineContentSchema, outlineInputManifestSchema, outlineWorkflowReleaseSchema,
  sourceOutlineOutputSchema, type SaveBriefInput, type ManualOutlineInput, type OutlineContent, type OutlineWorkflowRelease } from './contracts.js';

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
const sourceWritingManifestSchema = z.object({ schemaVersion: z.literal('source-writing-job-v1'), requestId: z.uuid(),
  task: z.literal('OUTLINE'), briefRevisionId: z.uuid(), briefHash: z.string().regex(/^[a-f0-9]{64}$/u), workspaceId: z.uuid(),
  workspaceStyleRevision: z.number().int().positive(), expectedRevision: z.number().int().nonnegative(), sourceEvidenceSetId: z.uuid(),
  setHash: z.string().regex(/^[a-f0-9]{64}$/u), request: z.unknown(), release: z.object({ endpoint: z.url(), workflowId: z.uuid(),
    releaseId: z.string().min(1), configDigest: z.string().regex(/^[a-f0-9]{64}$/u) }).passthrough(),
  noticeVersion: z.string().min(1), acceptedAt: z.iso.datetime() }).passthrough();

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
      sourceEvidenceRequired: brief?.currentRevision?.contentMode === 'FACTUAL' };
  }
  get(userId: string, projectId: string) { return this.command(userId, projectId, tx => this.state(tx, projectId), false); }
  async saveBrief(userId: string, projectId: string, input: SaveBriefInput) {
    return this.command(userId, projectId, async tx => {
      const previous = await tx.brief.findUnique({ where: { projectId } });
      if ((previous?.revision ?? 0) !== input.expectedRevision) throw new ConflictException('Brief changed; retain your text and reload before saving');
      const project = await tx.project.findUniqueOrThrow({ where: { id: projectId }, include: { workspace: true } });
      const style = await tx.workspaceStyleRevision.findUniqueOrThrow({ where: { workspaceId_revision: { workspaceId: project.workspaceId, revision: project.workspace.styleRevision } } });
      if (input.requiredClaimRevisionIds.length) throw new BadRequestException('REQUIRED_CLAIMS_RETIRED');
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
    if (brief.currentRevision.requiredClaims.length) throw new ConflictException('REQUIRED_CLAIMS_RETIRED');
    if (requireBasis && brief.currentRevision.contentMode === 'FACTUAL') {
      throw new ConflictException('Factual outlines must be prepared from source evidence');
    }
    const prerequisites = brief.currentRevision.contentMode === 'CREATIVE'
      ? await this.facts.inspectBasis(tx, projectId, 'CREATIVE')
      : { mode: 'FACTUAL' as const, basis: null, eligibleClaims: [], missingBasis: false, unverified: false, blockingReasons: [] };
    return { brief: brief.currentRevision, prerequisites };
  }
  private checkCitations(content: OutlineContent, mode: 'FACTUAL' | 'CREATIVE', basis: { manifest: unknown } | null,
    source?: { passageIds: ReadonlySet<string>; claimRevisionIds: ReadonlySet<string> }) {
    const claims = source?.claimRevisionIds ?? new Set((basis?.manifest as { claims?: { claimRevisionId: string }[] } | undefined)?.claims?.map(row => row.claimRevisionId));
    for (const section of content.sections) {
      if (section.claimRevisionIds.some(id => mode === 'CREATIVE' || !claims.has(id))) throw new BadRequestException('Outline citations must belong to its captured factual inputs');
      if ((section.sourcePassageIds ?? []).some(id => !source?.passageIds.has(id))) throw new BadRequestException('Outline source passages must belong to its frozen evidence set');
    }
    if (!source && content.sections.some(section => (section.sourcePassageIds?.length ?? 0) > 0)) {
      throw new BadRequestException('Source passage citations require a frozen source evidence set');
    }
  }
  private async appendOutline(tx: Prisma.TransactionClient, userId: string, projectId: string, briefRevisionId: string, basisRevisionId: string | null,
    mode: 'FACTUAL' | 'CREATIVE', content: OutlineContent, origin: 'MANUAL' | 'AI', jobId?: string, aiExecutionId?: string,
    sourceEvidenceSetId?: string) {
    const outline = await tx.outline.findUnique({ where: { projectId } }) ?? await tx.outline.create({ data: { id: randomUUID(), projectId } });
    const last = await tx.outlineRevision.findFirst({ where: { outlineId: outline.id }, orderBy: { number: 'desc' } });
    const revision = await tx.outlineRevision.create({ data: { id: randomUUID(), projectId, outlineId: outline.id, number: (last?.number ?? 0) + 1,
      briefRevisionId, basisRevisionId, contentMode: mode, content, origin, sha256: canonicalManifestHash(content), createdBy: userId,
      ...(sourceEvidenceSetId ? { sourceEvidenceSetId, sourceEvidenceSealed: false } : {}),
      ...(jobId ? { jobId } : {}), ...(aiExecutionId ? { aiExecutionId } : {}) } });
    return { outline, revision };
  }
  private async saveSourceCitations(tx: Prisma.TransactionClient, projectId: string, revisionId: string, sourceEvidenceSetId: string,
    content: OutlineContent, grounding: GroundingSet) {
    const byId = new Map<string, GroundingSet['passages'][number]>();
    for (const passage of grounding.passages) if (!byId.has(passage.id)) byId.set(passage.id, passage);
    const rows = content.sections.flatMap((section, sectionIndex) => (section.sourcePassageIds ?? []).map((spanId, citationIndex) => {
      const passage = byId.get(spanId);
      if (!passage) throw new ConflictException('Outline cites a passage outside its frozen evidence set');
      return { projectId, revisionId, sourceEvidenceSetId, packetId: passage.packetId, spanId, sectionIndex,
        locator: `sections/${sectionIndex}/evidence/${citationIndex}`, text: section.purpose, quote: passage.quote };
    }));
    if (!rows.length) throw new ConflictException('A source-grounded outline must cite at least one source passage');
    await tx.outlineRevisionSourceCitation.createMany({ data: rows });
    await tx.outlineRevision.update({ where: { id: revisionId }, data: { sourceEvidenceSealed: true } });
  }
  private async verifySourceCitations(tx: Prisma.TransactionClient, projectId: string, revisionId: string, sourceEvidenceSetId: string,
    content: OutlineContent, grounding: GroundingSet) {
    const byId = new Map<string, GroundingSet['passages'][number]>();
    for (const passage of grounding.passages) if (!byId.has(passage.id)) byId.set(passage.id, passage);
    const expected = content.sections.flatMap((section, sectionIndex) => (section.sourcePassageIds ?? []).map(spanId => {
      const passage = byId.get(spanId);
      if (!passage) throw new ConflictException('Outline cites a passage outside its frozen evidence set');
      return { sourceEvidenceSetId, packetId: passage.packetId, spanId, sectionIndex, text: section.purpose, quote: passage.quote };
    }));
    const revision = await tx.outlineRevision.findFirst({ where: { id: revisionId, projectId }, select: { sourceEvidenceSetId: true, sourceEvidenceSealed: true } });
    if (!revision?.sourceEvidenceSealed || revision.sourceEvidenceSetId !== sourceEvidenceSetId || !expected.length) throw new ConflictException('Source citations are not sealed');
    const actual = await tx.outlineRevisionSourceCitation.findMany({ where: { projectId, revisionId },
      select: { sourceEvidenceSetId: true, packetId: true, spanId: true, sectionIndex: true, text: true, quote: true } });
    if (canonicalManifestHash(actual.map(row => ({ ...row })).sort((a, b) => `${a.sectionIndex}:${a.packetId}:${a.spanId}`.localeCompare(`${b.sectionIndex}:${b.packetId}:${b.spanId}`)))
      !== canonicalManifestHash(expected.sort((a, b) => `${a.sectionIndex}:${a.packetId}:${a.spanId}`.localeCompare(`${b.sectionIndex}:${b.packetId}:${b.spanId}`)))) {
      throw new ConflictException('Source citation mappings do not match the sealed outline content');
    }
  }
  manualOutline(userId: string, projectId: string, input: ManualOutlineInput) {
    return this.command(userId, projectId, async tx => {
      const existing = await tx.outline.findUnique({ where: { projectId } });
      if ((existing?.revision ?? 0) !== input.expectedRevision) throw new ConflictException('Outline changed; retain your text and reload');
      const { brief, prerequisites } = await this.currentInputs(tx, projectId, input.briefRevisionId, false);
      const currentRevision = existing?.currentRevisionId ? await tx.outlineRevision.findFirst({ where: { id: existing.currentRevisionId, projectId }, select: { sourceEvidenceSetId: true } }) : null;
      const sourceEvidenceSetId = input.sourceEvidenceSetId === null ? null : input.sourceEvidenceSetId ?? currentRevision?.sourceEvidenceSetId ?? undefined;
      if (brief.contentMode === 'FACTUAL' && !sourceEvidenceSetId) throw new ConflictException('Factual outlines must cite selected source passages');
      let grounding: GroundingSet | undefined;
      let sourcePassages: ReadonlySet<string> | undefined;
      if (sourceEvidenceSetId) {
        grounding = await new SourceGroundingService().inspectSet(tx, projectId, sourceEvidenceSetId, brief.id, true);
        sourcePassages = new Set(grounding.passages.map(row => row.id));
        if (input.content.sections.some(section => section.claimRevisionIds.length)) throw new BadRequestException('REQUIRED_CLAIMS_RETIRED');
      }
      this.checkCitations(input.content, brief.contentMode, sourceEvidenceSetId ? null : prerequisites.basis,
        sourceEvidenceSetId ? { passageIds: sourcePassages!, claimRevisionIds: new Set() } : undefined);
      const { outline, revision } = await this.appendOutline(tx, userId, projectId, brief.id,
        sourceEvidenceSetId ? null : brief.contentMode === 'FACTUAL' ? prerequisites.basis?.id ?? null : null,
        brief.contentMode, input.content, 'MANUAL', undefined, undefined, sourceEvidenceSetId ?? undefined);
      if (sourceEvidenceSetId && grounding) await this.saveSourceCitations(tx, projectId, revision.id, sourceEvidenceSetId, input.content, grounding);
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
        const sourceSetId = revision.sourceEvidenceSetId;
        const { brief, prerequisites } = await this.currentInputs(tx, projectId, revision.briefRevisionId, !sourceSetId);
        const content = outlineContentSchema.parse(revision.content);
        let grounding: GroundingSet | undefined;
        if (sourceSetId) {
          if (revision.contentMode !== 'FACTUAL' || revision.basisRevisionId !== null || !revision.sourceEvidenceSealed) throw new ConflictException('Source-grounded outline lineage is invalid');
          grounding = await new SourceGroundingService().inspectSet(tx, projectId, sourceSetId, brief.id, true);
          this.checkCitations(content, brief.contentMode, null, { passageIds: new Set(grounding.passages.map(row => row.id)),
            claimRevisionIds: new Set() });
          if (content.sections.some(section => section.claimRevisionIds.length)) throw new ConflictException('REQUIRED_CLAIMS_RETIRED');
          await this.verifySourceCitations(tx, projectId, revisionId, sourceSetId, content, grounding);
        } else {
          if (revision.sourceEvidenceSealed) throw new ConflictException('Legacy outline cannot seal source citations');
          if (revision.contentMode === 'FACTUAL' && revision.basisRevisionId !== prerequisites.basis?.id) throw new ConflictException('Outline factual basis changed; create a new revision');
          this.checkCitations(content, brief.contentMode, prerequisites.basis);
          if (brief.contentMode === 'FACTUAL') throw new ConflictException('Factual outlines must be prepared from source evidence');
        }
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
      const { brief } = await this.currentInputs(tx, projectId, current.currentRevisionId, true);
      if (brief.contentMode === 'FACTUAL') throw new ConflictException('Factual outlines must be prepared from source evidence');
      const profile = await tx.userProfile.findUniqueOrThrow({ where: { id: userId } });
      const manifest = outlineInputManifestSchema.parse({ schemaVersion: 'outline-input-v1', briefRevisionId: brief.id, briefHash: brief.sha256,
        workspaceId: brief.workspaceId, workspaceStyleRevision: brief.workspaceStyleRevision, contentMode: brief.contentMode,
        basisRevisionId: null,
        basisHash: null,
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
      if (frozen.contentMode === 'FACTUAL' || brief.requiredClaims.length || cited.size) throw new Error('Factual outlines must be prepared from source evidence');
    } catch { throw new JobFailure('INVALID_CONTRACT', 'KNOWN_SUCCEEDED'); }
    const existing = await tx.outline.findUnique({ where: { projectId: job.projectId } });
    const { outline, revision } = await this.appendOutline(tx, job.requestedBy, job.projectId, brief.id, frozen.basisRevisionId, frozen.contentMode, content.data, 'AI', job.id, executionId);
    if (existing) await tx.outline.update({ where: { id: outline.id }, data: { revision: { increment: 1 } } });
    return { outlineRevisionId: revision.id };
  }
  async commitSourceGenerated(tx: Prisma.TransactionClient, job: Job, raw: unknown, executionId: string, sourceEvidenceSetId: string) {
    await this.lock(tx, job.requestedBy, job.projectId);
    const output = sourceOutlineOutputSchema.safeParse(raw);
    const manifest = sourceWritingManifestSchema.safeParse(job.inputManifest);
    if (!output.success || !manifest.success || job.operation !== 'SOURCE_WRITING' || job.contractVersion !== 'source-writing-v1'
      || canonicalManifestHash({ contractVersion: job.contractVersion, inputManifest: job.inputManifest }) !== job.inputHash) {
      throw new JobFailure('INVALID_CONTRACT', 'KNOWN_SUCCEEDED');
    }
    const frozen = manifest.data;
    if (frozen.sourceEvidenceSetId !== sourceEvidenceSetId) throw new JobFailure('INVALID_CONTRACT', 'KNOWN_SUCCEEDED');
    const execution = await tx.aIExecution.findFirst({ where: { id: executionId, projectId: job.projectId, jobId: job.id } });
    if (!execution || execution.inputHash !== job.inputHash
      || canonicalManifestHash(execution.inputManifest) !== canonicalManifestHash(job.inputManifest)) {
      throw new JobFailure('INVALID_CONTRACT', 'KNOWN_SUCCEEDED');
    }
    const { brief } = await this.currentInputs(tx, job.projectId, frozen.briefRevisionId, false);
    if (brief.contentMode !== 'FACTUAL' || brief.sha256 !== frozen.briefHash || brief.workspaceId !== frozen.workspaceId
      || brief.workspaceStyleRevision !== frozen.workspaceStyleRevision) throw new JobFailure('INVALID_CONTRACT', 'KNOWN_SUCCEEDED');
    const grounding = await new SourceGroundingService().inspectSet(tx, job.projectId, sourceEvidenceSetId, brief.id, true);
    if (grounding.sha256 !== frozen.setHash) throw new JobFailure('INVALID_CONTRACT', 'KNOWN_SUCCEEDED');
    const allowedPassages = new Set(grounding.passages.map(row => row.id));
    const citedPassages = new Set(output.data.sections.flatMap(section => section.passageIds));
    if (!citedPassages.size || [...citedPassages].some(id => !allowedPassages.has(id))
      || output.data.sections.some(section => section.requiredClaimRevisionIds.length)) {
      throw new JobFailure('INVALID_CONTRACT', 'KNOWN_SUCCEEDED');
    }
    const existing = await tx.outline.findUnique({ where: { projectId: job.projectId } });
    if ((existing?.revision ?? 0) !== frozen.expectedRevision) throw new JobFailure('STALE_INPUT', 'KNOWN_SUCCEEDED');
    const content = outlineContentSchema.parse({ title: output.data.title, sections: output.data.sections.map(section => ({
      id: section.id, title: section.title, purpose: section.purpose, targetWords: section.targetWords,
      claimRevisionIds: section.requiredClaimRevisionIds, sourcePassageIds: section.passageIds })) });
    const { outline, revision } = await this.appendOutline(tx, job.requestedBy, job.projectId, brief.id, null, 'FACTUAL', content, 'AI', job.id,
      executionId, sourceEvidenceSetId);
    await this.saveSourceCitations(tx, job.projectId, revision.id, sourceEvidenceSetId, content, grounding);
    if (existing) await tx.outline.update({ where: { id: outline.id }, data: { revision: { increment: 1 } } });
    return { outlineRevisionId: revision.id, sourceEvidenceSetId };
  }
}
