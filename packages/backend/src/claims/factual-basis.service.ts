import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import type { Prisma, PrismaClient, Job } from '../generated/prisma/client.js';
import { DurableJobService, canonicalManifestHash } from '../jobs/job-service.js';
import { JobFailure } from '../jobs/contracts.js';
import { EXTERNAL_PROCESSING_NOTICE } from '../external-processing-notice.js';
import { claimInputManifestSchema, claimsOutputSchema, claimWorkflowReleaseSchema, type CreateClaimInput,
  type EditClaimInput, type EvidenceInput, type ClaimWorkflowRelease } from './contracts.js';

const evidenceInclude = { snapshot: { select: { materialId: true, sequence: true, material: { select: { label: true } } } } } as const;
const actorSelect = { displayName: true } satisfies Prisma.UserProfileSelect;
const revisionInclude = { evidence: { include: evidenceInclude, orderBy: { id: 'asc' as const } },
  approver: { select: actorSelect }, rejector: { select: actorSelect }, withdrawer: { select: actorSelect } } as const;
const claimInclude = { currentRevision: { include: revisionInclude } } as const;
type ClaimRecord = Prisma.ClaimGetPayload<{ include: typeof claimInclude }>;
type RevisionRecord = Prisma.ClaimRevisionGetPayload<{ include: typeof revisionInclude }>;
const conflictInclude = { participants: { include: { revision: { select: { wording: true } } } }, selectedEvidence: true,
  supersededBy: { select: { id: true } } } as const;
type ConflictRecord = Prisma.ClaimConflictGetPayload<{ include: typeof conflictInclude }>;
function sha256(value: string): string { return createHash('sha256').update(value, 'utf8').digest('hex'); }
function revisionView(revision: RevisionRecord) {
  return { id: revision.id, number: revision.number, wording: revision.wording, sha256: revision.sha256, status: revision.status,
    createdBy: revision.createdBy, createdAt: revision.createdAt.toISOString(), approvedBy: revision.approvedBy, approvedAt: revision.approvedAt?.toISOString() ?? null,
    approvedByName: revision.approver?.displayName || null,
    rejectedByName: revision.rejector?.displayName || null,
    withdrawnByName: revision.withdrawer?.displayName || null,
    rejectedBy: revision.rejectedBy, rejectedAt: revision.rejectedAt?.toISOString() ?? null,
    withdrawnBy: revision.withdrawnBy, withdrawnAt: revision.withdrawnAt?.toISOString() ?? null, withdrawalReason: revision.withdrawalReason,
    evidence: revision.evidence.map(evidence => ({ id: evidence.id, snapshotId: evidence.snapshotId, fragmentId: evidence.fragmentId,
      materialId: evidence.snapshot.materialId, materialLabel: evidence.snapshot.material.label, snapshotSequence: evidence.snapshot.sequence,
      startOffset: evidence.startOffset, endOffset: evidence.endOffset, quote: evidence.quote, sha256: evidence.sha256,
      relation: evidence.relation, capturedPurpose: evidence.capturedPurpose, invalidatedBy: evidence.invalidatedBy,
      invalidatedAt: evidence.invalidatedAt?.toISOString() ?? null, invalidationReason: evidence.invalidationReason })) };
}
function claimView(claim: ClaimRecord) { return { id: claim.id, projectId: claim.projectId, revision: claim.revision,
  currentRevisionId: claim.currentRevisionId, currentRevision: claim.currentRevision ? revisionView(claim.currentRevision) : null }; }
function conflictView(conflict: ConflictRecord) {
  return { id: conflict.id, revision: conflict.revision, origin: conflict.origin, rationale: conflict.rationale,
    supersedesId: conflict.supersedesId, supersededById: conflict.supersededBy?.id ?? null,
    createdBy: conflict.createdBy, createdAt: conflict.createdAt.toISOString(), resolvedBy: conflict.resolvedBy,
    resolvedAt: conflict.resolvedAt?.toISOString() ?? null, selectedRevisionId: conflict.selectedRevisionId, formulation: conflict.formulation,
    resolutionRationale: conflict.resolutionRationale, selectedEvidenceIds: conflict.selectedEvidence.map(row => row.evidenceId),
    participants: conflict.participants.map(row => ({ claimId: row.claimId, revisionId: row.revisionId, wording: row.revision.wording })) };
}

export class FactualBasisService {
  constructor(readonly prisma: PrismaClient, private readonly jobs: DurableJobService) {}
  private async lockProject(tx: Prisma.TransactionClient, userId: string, projectId: string, write = true): Promise<void> {
    const rows = write ? await tx.$queryRaw<Array<{ id: string }>>`SELECT p."id" FROM contextflow."Project" p
      JOIN contextflow."Workspace" w ON w."id" = p."workspaceId" JOIN contextflow."WorkspaceMember" m ON m."workspaceId" = w."id"
      WHERE p."id" = ${projectId}::uuid AND p."archivedAt" IS NULL AND w."archivedAt" IS NULL AND m."userId" = ${userId}::uuid AND m."leftAt" IS NULL
      FOR UPDATE OF p FOR SHARE OF w, m`
      : await tx.$queryRaw<Array<{ id: string }>>`SELECT p."id" FROM contextflow."Project" p
      JOIN contextflow."Workspace" w ON w."id" = p."workspaceId" JOIN contextflow."WorkspaceMember" m ON m."workspaceId" = w."id"
      WHERE p."id" = ${projectId}::uuid AND m."userId" = ${userId}::uuid AND m."leftAt" IS NULL FOR SHARE OF p, w, m`;
    if (!rows.length) throw new NotFoundException('Project not found');
  }
  private command<T>(userId: string, projectId: string, callback: (tx: Prisma.TransactionClient) => Promise<T>, write = true): Promise<T> {
    return this.prisma.$transaction(async tx => { await this.lockProject(tx, userId, projectId, write); return callback(tx); });
  }
  private async getClaim(tx: Prisma.TransactionClient, projectId: string, id: string): Promise<ClaimRecord> {
    const claim = await tx.claim.findFirst({ where: { id, projectId }, include: claimInclude });
    if (!claim) throw new NotFoundException('Claim not found');
    return claim;
  }
  private async checkEvidence(tx: Prisma.TransactionClient, projectId: string, inputs: readonly EvidenceInput[], frozenIds?: Set<string>): Promise<void> {
    if (!inputs.some(row => row.relation === 'SUPPORTS')) throw new BadRequestException('A claim needs supporting factual evidence');
    const seen = new Set<string>();
    for (const input of inputs) {
      const key = [input.fragmentId, input.startOffset, input.endOffset, input.relation].join('-');
      if (seen.has(key)) throw new BadRequestException('Duplicate evidence');
      seen.add(key);
      if (frozenIds && !frozenIds.has(input.snapshotId)) throw new JobFailure('INVALID_CONTRACT', 'KNOWN_SUCCEEDED');
      const fragment = await tx.sourceFragment.findFirst({ where: { id: input.fragmentId, snapshotId: input.snapshotId, projectId },
        include: { snapshot: { include: { material: { select: { purpose: true } } } } } });
      if (!fragment || (!frozenIds && fragment.snapshot.material.purpose !== 'FACTUAL_SOURCE')
        || input.startOffset < fragment.startOffset || input.endOffset > fragment.endOffset || input.startOffset >= input.endOffset
        || Buffer.from(input.quote, 'utf8').toString('utf8') !== input.quote
        || fragment.snapshot.normalizedText.slice(input.startOffset, input.endOffset) !== input.quote || sha256(input.quote) !== input.sha256
        || sha256(fragment.snapshot.normalizedText.slice(fragment.startOffset, fragment.endOffset)) !== fragment.sha256) {
        throw new BadRequestException('Evidence must match an exact factual source excerpt, range and hash');
      }
    }
  }
  private async append(tx: Prisma.TransactionClient, userId: string, projectId: string, claimId: string, number: number,
    input: CreateClaimInput, job?: { id: string; key: string }): Promise<string> {
    const id = randomUUID();
    await tx.claimRevision.create({ data: { id, projectId, claimId, number, wording: input.wording, sha256: sha256(input.wording),
      createdBy: userId, ...(job ? { jobId: job.id, providerClaimKey: job.key } : {}) } });
    await tx.claimEvidence.createMany({ data: input.evidence.map(evidence => ({ ...evidence, id: randomUUID(), projectId, claimRevisionId: id,
      capturedPurpose: 'FACTUAL_SOURCE' as const, createdBy: userId })) });
    return id;
  }
  async list(userId: string, projectId: string, cursor?: string) {
    return this.command(userId, projectId, async tx => {
      const anchor = cursor ? await tx.claim.findFirst({ where: { id: cursor, projectId }, select: { id: true, createdAt: true } }) : null;
      if (cursor && !anchor) throw new NotFoundException('Claim cursor not found');
      const rows = await tx.claim.findMany({ where: { projectId, ...(anchor ? { OR: [
        { createdAt: { lt: anchor.createdAt } }, { createdAt: anchor.createdAt, id: { lt: anchor.id } } ] } : {}) }, include: claimInclude,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: 51 });
      const claims = rows.slice(0, 50);
      return { claims: claims.map(claimView), nextCursor: rows.length > 50 ? claims.at(-1)!.id : null };
    }, false);
  }
  async detail(userId: string, projectId: string, id: string) {
    return this.command(userId, projectId, async tx => ({ claim: claimView(await this.getClaim(tx, projectId, id)),
      revisions: (await tx.claimRevision.findMany({ where: { projectId, claimId: id }, include: revisionInclude, orderBy: { number: 'desc' } })).map(revisionView) }), false);
  }
  async create(userId: string, projectId: string, input: CreateClaimInput) {
    return this.command(userId, projectId, async tx => {
      await this.checkEvidence(tx, projectId, input.evidence);
      const id = randomUUID();
      await tx.claim.create({ data: { id, projectId, createdBy: userId } });
      const revisionId = await this.append(tx, userId, projectId, id, 1, input);
      await tx.claim.update({ where: { id }, data: { currentRevisionId: revisionId } });
      return { claim: claimView(await this.getClaim(tx, projectId, id)) };
    });
  }
  async edit(userId: string, projectId: string, id: string, input: EditClaimInput) {
    return this.command(userId, projectId, async tx => {
      const claim = await this.getClaim(tx, projectId, id);
      if (claim.revision !== input.expectedRevision) throw new ConflictException('Claim changed; reload before saving');
      await this.checkEvidence(tx, projectId, input.evidence);
      const revisionId = await this.append(tx, userId, projectId, id, (claim.currentRevision?.number ?? 0) + 1, input);
      await tx.claim.update({ where: { id }, data: { currentRevisionId: revisionId, revision: { increment: 1 }, updatedAt: new Date() } });
      return { claim: claimView(await this.getClaim(tx, projectId, id)) };
    });
  }
  private async conflictBlocks(tx: Prisma.TransactionClient, projectId: string, claimId: string, revisionId: string, unresolvedOnly = false): Promise<boolean> {
    const conflicts = await tx.claimConflict.findMany({ where: { projectId, participants: { some: { claimId } }, supersededBy: { is: null } }, select: { resolvedAt: true, selectedRevisionId: true } });
    return conflicts.some(row => !row.resolvedAt || (!unresolvedOnly && row.selectedRevisionId !== revisionId));
  }
  private async eligible(tx: Prisma.TransactionClient, revision: RevisionRecord, currentId: string | null): Promise<string[]> {
    const reasons: string[] = [];
    if (revision.id !== currentId) reasons.push('CLAIM_CHANGED');
    if (revision.status !== 'APPROVED') reasons.push('NOT_APPROVED');
    if (revision.withdrawnAt) reasons.push('WITHDRAWN');
    if (!revision.evidence.some(row => row.relation === 'SUPPORTS' && !row.invalidatedAt)) reasons.push('MISSING_SUPPORT');
    if (revision.evidence.some(row => row.invalidatedAt)) reasons.push('INVALID_EVIDENCE');
    if (await this.conflictBlocks(tx, revision.projectId, revision.claimId, revision.id)) reasons.push('CONFLICT');
    return reasons;
  }
  async review(userId: string, projectId: string, id: string, revisionId: string, action: 'approve' | 'reject' | 'withdraw', input: { expectedRevision: number; reason?: string | undefined }) {
    return this.command(userId, projectId, async tx => {
      const claim = await this.getClaim(tx, projectId, id);
      if (claim.revision !== input.expectedRevision) throw new ConflictException('Claim changed; reload before review');
      const revision = await tx.claimRevision.findFirst({ where: { id: revisionId, claimId: id, projectId }, include: revisionInclude });
      if (!revision) throw new NotFoundException('Claim revision not found');
      const now = new Date();
      if (action === 'withdraw') {
        if (revision.status !== 'APPROVED' || revision.withdrawnAt) throw new ConflictException('Only an active approved revision may be withdrawn');
        await tx.claimRevision.update({ where: { id: revisionId }, data: { withdrawnBy: userId, withdrawnAt: now, withdrawalReason: input.reason ?? null } });
      } else {
        if (revision.status !== 'PROPOSED' || claim.currentRevisionId !== revisionId) throw new ConflictException('Review requires the current proposed revision');
        if (action === 'approve') {
          if (!revision.evidence.some(row => row.relation === 'SUPPORTS' && !row.invalidatedAt) || revision.evidence.some(row => row.invalidatedAt)
            || await this.conflictBlocks(tx, projectId, id, revisionId, true)) throw new ConflictException('Resolve conflicts and invalid evidence before approval');
          await tx.claimRevision.update({ where: { id: revisionId }, data: { status: 'APPROVED', approvedBy: userId, approvedAt: now } });
        } else await tx.claimRevision.update({ where: { id: revisionId }, data: { status: 'REJECTED', rejectedBy: userId, rejectedAt: now } });
      }
      await tx.claim.update({ where: { id }, data: { revision: { increment: 1 }, updatedAt: now } });
      return { claim: claimView(await this.getClaim(tx, projectId, id)) };
    });
  }
  async invalidate(userId: string, projectId: string, id: string, evidenceId: string, input: { expectedRevision: number; reason: string }) {
    return this.command(userId, projectId, async tx => {
      const claim = await this.getClaim(tx, projectId, id);
      if (claim.revision !== input.expectedRevision) throw new ConflictException('Claim changed; reload before invalidation');
      const evidence = await tx.claimEvidence.findFirst({ where: { id: evidenceId, projectId, claimRevision: { claimId: id } } });
      if (!evidence) throw new NotFoundException('Evidence not found');
      if (evidence.invalidatedAt) throw new ConflictException('Evidence invalidation is terminal');
      await tx.claimEvidence.update({ where: { id: evidenceId }, data: { invalidatedBy: userId, invalidatedAt: new Date(), invalidationReason: input.reason } });
      await tx.claim.update({ where: { id }, data: { revision: { increment: 1 }, updatedAt: new Date() } });
      return { claim: claimView(await this.getClaim(tx, projectId, id)) };
    });
  }
  private async addConflict(tx: Prisma.TransactionClient, userId: string, projectId: string, revisions: readonly { id: string; claimId: string }[], rationale: string, origin: 'MANUAL' | 'DETECTED', supersedesId?: string) {
    if (new Set(revisions.map(row => row.claimId)).size !== revisions.length) throw new BadRequestException('A conflict requires different claims');
    const id = randomUUID();
    await tx.claimConflict.create({ data: { id, projectId, createdBy: userId, rationale, origin, ...(supersedesId ? { supersedesId } : {}) } });
    await tx.claimConflictParticipant.createMany({ data: revisions.map(row => ({ projectId, conflictId: id, claimId: row.claimId, revisionId: row.id })) });
    return id;
  }
  async conflicts(userId: string, projectId: string, cursor?: string) {
    return this.command(userId, projectId, async tx => {
      const anchor = cursor ? await tx.claimConflict.findFirst({ where: { id: cursor, projectId }, select: { id: true, createdAt: true } }) : null;
      if (cursor && !anchor) throw new NotFoundException('Conflict cursor not found');
      const rows = await tx.claimConflict.findMany({ where: { projectId, ...(anchor ? { OR: [
        { createdAt: { lt: anchor.createdAt } }, { createdAt: anchor.createdAt, id: { lt: anchor.id } } ] } : {}) }, include: conflictInclude,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: 51 });
      const conflicts = rows.slice(0, 50);
      return { conflicts: conflicts.map(conflictView), nextCursor: rows.length > 50 ? conflicts.at(-1)!.id : null };
    }, false);
  }
  async flagConflict(userId: string, projectId: string, input: { revisionIds: string[]; rationale: string }) {
    return this.command(userId, projectId, async tx => {
      const revisions = await tx.claimRevision.findMany({ where: { projectId, id: { in: input.revisionIds } }, select: { id: true, claimId: true } });
      if (revisions.length !== input.revisionIds.length) throw new BadRequestException('Conflict participants must belong to this Project');
      const id = await this.addConflict(tx, userId, projectId, revisions, input.rationale, 'MANUAL');
      return { conflict: conflictView(await tx.claimConflict.findUniqueOrThrow({ where: { id }, include: conflictInclude })) };
    });
  }
  async resolveConflict(userId: string, projectId: string, id: string, input: { selectedRevisionId: string; selectedEvidenceIds: string[]; formulation: string; rationale: string }) {
    return this.command(userId, projectId, async tx => {
      const conflict = await tx.claimConflict.findFirst({ where: { id, projectId }, include: conflictInclude });
      if (!conflict) throw new NotFoundException('Conflict not found');
      if (conflict.resolvedAt) throw new ConflictException('Conflict resolution is terminal');
      const selected = await tx.claimRevision.findFirst({ where: { projectId, id: input.selectedRevisionId }, include: { ...revisionInclude, claim: { select: { currentRevisionId: true } } } });
      if (!selected || !conflict.participants.some(row => row.claimId === selected.claimId) || selected.id !== selected.claim.currentRevisionId
        || selected.wording !== input.formulation || selected.status === 'REJECTED' || selected.withdrawnAt) throw new BadRequestException('Select the current formulation of a participant claim');
      const evidence = selected.evidence.filter(row => input.selectedEvidenceIds.includes(row.id));
      if (evidence.length !== input.selectedEvidenceIds.length || evidence.some(row => row.relation !== 'SUPPORTS' || row.invalidatedAt)) {
        throw new BadRequestException('Resolution needs valid supporting evidence of the chosen revision');
      }
      await tx.claimConflict.update({ where: { id }, data: { resolvedBy: userId, resolvedAt: new Date(), selectedRevisionId: selected.id,
        formulation: selected.wording, resolutionRationale: input.rationale, revision: { increment: 1 } } });
      await tx.conflictResolutionEvidence.createMany({ data: evidence.map(row => ({ projectId, conflictId: id, claimRevisionId: selected.id, evidenceId: row.id })) });
      return { conflict: conflictView(await tx.claimConflict.findUniqueOrThrow({ where: { id }, include: conflictInclude })) };
    });
  }
  async reopenConflict(userId: string, projectId: string, id: string, input: { rationale: string }) {
    return this.command(userId, projectId, async tx => {
      const previous = await tx.claimConflict.findFirst({ where: { id, projectId }, include: { ...conflictInclude,
        participants: { include: { claim: { select: { currentRevisionId: true } } } } } });
      if (!previous) throw new NotFoundException('Conflict not found');
      if (!previous.resolvedAt || previous.supersededBy) throw new ConflictException('Only a resolved current conflict may be reopened');
      const revisions = previous.participants.map(row => ({ claimId: row.claimId, id: row.claim.currentRevisionId }));
      if (revisions.length < 2 || revisions.some(row => !row.id)) throw new ConflictException('Conflict participants require current revisions');
      const next = await this.addConflict(tx, userId, projectId, revisions.map(row => ({ claimId: row.claimId, id: row.id! })), input.rationale, 'MANUAL', previous.id);
      return { conflict: conflictView(await tx.claimConflict.findUniqueOrThrow({ where: { id: next }, include: conflictInclude })) };
    });
  }
  private async basisView(tx: Prisma.TransactionClient, basisId: string) {
    const basis = await tx.factualBasisRevision.findUniqueOrThrow({ where: { id: basisId }, include: {
      claims: { include: { claim: { select: { currentRevisionId: true } }, claimRevision: { include: revisionInclude }, evidence: true } } } });
    const reasons = new Set<string>();
    const relationalManifest = { schemaVersion: 'basis-v1', claims: [...basis.claims].sort((a, b) => a.claimRevisionId.localeCompare(b.claimRevisionId))
      .map(row => ({ claimId: row.claimId, claimRevisionId: row.claimRevisionId, evidenceIds: row.evidence.map(edge => edge.evidenceId).sort() })) };
    if (canonicalManifestHash(basis.manifest) !== basis.sha256 || canonicalManifestHash(relationalManifest) !== basis.sha256) reasons.add('BASIS_INTEGRITY');
    for (const row of basis.claims) {
      for (const reason of await this.eligible(tx, row.claimRevision, row.claim.currentRevisionId)) reasons.add(reason);
      if (!row.evidence.length || row.evidence.some(edge => !row.claimRevision.evidence.some(evidence => evidence.id === edge.evidenceId && evidence.relation === 'SUPPORTS' && !evidence.invalidatedAt))) reasons.add('INVALID_EVIDENCE');
    }
    return { id: basis.id, sequence: basis.sequence, manifest: basis.manifest, sha256: basis.sha256, createdBy: basis.createdBy,
      createdAt: basis.createdAt.toISOString(), valid: reasons.size === 0 && basis.claims.length > 0, blockingReasons: [...reasons] };
  }
  async basis(userId: string, projectId: string, mode: 'FACTUAL' | 'CREATIVE') {
    return this.command(userId, projectId, tx => this.inspectBasis(tx, projectId, mode), false);
  }
  // Callers must hold the Project lock and authorize its actual Workspace ancestry.
  // Reuse eligibility in the caller's transaction so a concurrent withdrawal cannot
  // pass a generation/approval check on a different database snapshot.
  async inspectBasis(tx: Prisma.TransactionClient, projectId: string, mode: 'FACTUAL' | 'CREATIVE') {
      const claims = await tx.claim.findMany({ where: { projectId, currentRevision: { status: 'APPROVED', withdrawnAt: null } }, include: claimInclude });
      const eligibleClaims: ReturnType<typeof claimView>[] = [];
      for (const claim of claims) if (claim.currentRevision && !(await this.eligible(tx, claim.currentRevision, claim.currentRevisionId)).length) eligibleClaims.push(claimView(claim));
      const latest = await tx.factualBasisRevision.findFirst({ where: { projectId }, orderBy: { sequence: 'desc' }, select: { id: true } });
      const basis = latest ? await this.basisView(tx, latest.id) : null;
      return { mode, basis, eligibleClaims, missingBasis: mode === 'FACTUAL' && (!basis || !basis.valid), unverified: mode === 'CREATIVE',
        blockingReasons: mode === 'FACTUAL' ? basis?.blockingReasons.length ? basis.blockingReasons : !basis ? ['MISSING_BASIS'] : [] : [] };
  }
  async inspectBasisRevision(tx: Prisma.TransactionClient, projectId: string, basisId: string) {
    const row = await tx.factualBasisRevision.findFirst({ where: { id: basisId, projectId }, select: { id: true } });
    if (!row) throw new NotFoundException('Factual basis not found');
    return this.basisView(tx, row.id);
  }
  async freezeBasis(userId: string, projectId: string, input: { claimRevisionIds: string[] }) {
    return this.command(userId, projectId, async tx => {
      const selected = await tx.claimRevision.findMany({ where: { projectId, id: { in: input.claimRevisionIds } }, include: { ...revisionInclude, claim: { select: { currentRevisionId: true } } } });
      if (selected.length !== input.claimRevisionIds.length || new Set(selected.map(row => row.claimId)).size !== selected.length) throw new BadRequestException('Basis references must be exact revisions in this Project');
      for (const revision of selected) if ((await this.eligible(tx, revision, revision.claim.currentRevisionId)).length) throw new ConflictException('Basis accepts only eligible approved current claims');
      const entries = selected.sort((a, b) => a.id.localeCompare(b.id)).map(row => ({ claimId: row.claimId, claimRevisionId: row.id,
        evidenceIds: row.evidence.filter(evidence => evidence.relation === 'SUPPORTS' && !evidence.invalidatedAt).map(evidence => evidence.id).sort() }));
      const manifest = { schemaVersion: 'basis-v1', claims: entries };
      const previous = await tx.factualBasisRevision.findFirst({ where: { projectId }, orderBy: { sequence: 'desc' }, select: { sequence: true } });
      const id = randomUUID();
      await tx.factualBasisRevision.create({ data: { id, projectId, sequence: (previous?.sequence ?? 0) + 1, manifest, sha256: canonicalManifestHash(manifest), createdBy: userId } });
      for (const entry of entries) {
        await tx.basisClaim.create({ data: { projectId, basisId: id, claimId: entry.claimId, claimRevisionId: entry.claimRevisionId } });
        await tx.basisClaimEvidence.createMany({ data: entry.evidenceIds.map(evidenceId => ({ projectId, basisId: id, claimRevisionId: entry.claimRevisionId, evidenceId })) });
      }
      return { basis: await this.basisView(tx, id) };
    });
  }
  async extract(userId: string, projectId: string, commandKey: string, releaseInput: ClaimWorkflowRelease) {
    const release = claimWorkflowReleaseSchema.parse(releaseInput);
    return this.command(userId, projectId, async tx => {
      await this.jobs.assertEffects(tx, projectId, userId);
      const snapshots = await tx.sourceSnapshot.findMany({ where: { projectId, currentForMaterials: { some: { included: true, purpose: 'FACTUAL_SOURCE' } } },
        select: { id: true, materialId: true, sha256: true, fragments: { select: { id: true, startOffset: true, endOffset: true, sha256: true }, orderBy: { ordinal: 'asc' } } }, orderBy: { id: 'asc' }, take: 101 });
      if (!snapshots.length || snapshots.length > 100) throw new BadRequestException('Extraction requires 1 to 100 included factual snapshots');
      const profile = await tx.userProfile.findUniqueOrThrow({ where: { id: userId }, select: { externalProcessingAcceptedAt: true } });
      const manifest = claimInputManifestSchema.parse({ schemaVersion: 'claim-input-v1', release,
        snapshots: snapshots.map(row => ({ snapshotId: row.id, materialId: row.materialId, sha256: row.sha256, fragments: row.fragments })),
        noticeVersion: EXTERNAL_PROCESSING_NOTICE.version, acceptedAt: profile.externalProcessingAcceptedAt?.toISOString() });
      return this.jobs.create(tx, { projectId, userId, operation: 'CLAIM_EXTRACTION', contractVersion: 'claims-v1', commandKey, inputManifest: manifest, deadlineMs: 600_000 });
    });
  }
  async commitExtracted(tx: Prisma.TransactionClient, job: Job, raw: unknown): Promise<{ claimIds: string[]; conflictIds: string[] }> {
    await this.lockProject(tx, job.requestedBy, job.projectId);
    const parsed = claimsOutputSchema.safeParse(raw), manifest = claimInputManifestSchema.safeParse(job.inputManifest);
    if (!parsed.success || !manifest.success || job.operation !== 'CLAIM_EXTRACTION' || job.contractVersion !== 'claims-v1') throw new JobFailure('INVALID_CONTRACT', 'KNOWN_SUCCEEDED');
    const output = parsed.data, frozen = manifest.data;
    const keys = new Set(output.claims.map(row => row.key));
    if (keys.size !== output.claims.length || output.conflicts.some(row => new Set(row.claimKeys).size !== row.claimKeys.length || row.claimKeys.some(key => !keys.has(key)))) throw new JobFailure('INVALID_CONTRACT', 'KNOWN_SUCCEEDED');
    const snapshotIds = new Set(frozen.snapshots.map(row => row.snapshotId));
    for (const snapshot of frozen.snapshots) {
      const actual = await tx.sourceSnapshot.findFirst({ where: { projectId: job.projectId, id: snapshot.snapshotId, materialId: snapshot.materialId }, select: { sha256: true } });
      if (!actual || actual.sha256 !== snapshot.sha256) throw new JobFailure('INVALID_CONTRACT', 'KNOWN_SUCCEEDED');
    }
    for (const claim of output.claims) {
      for (const evidence of claim.evidence) {
        const snapshot = frozen.snapshots.find(row => row.snapshotId === evidence.snapshotId);
        if (!snapshot?.fragments.some(row => row.id === evidence.fragmentId && evidence.startOffset >= row.startOffset && evidence.endOffset <= row.endOffset)) throw new JobFailure('INVALID_CONTRACT', 'KNOWN_SUCCEEDED');
      }
      try { await this.checkEvidence(tx, job.projectId, claim.evidence, snapshotIds); }
      catch { throw new JobFailure('INVALID_CONTRACT', 'KNOWN_SUCCEEDED'); }
    }
    const ids = new Map<string, { id: string; claimId: string }>();
    for (const input of output.claims) {
      const claimId = randomUUID();
      await tx.claim.create({ data: { id: claimId, projectId: job.projectId, createdBy: job.requestedBy } });
      const id = await this.append(tx, job.requestedBy, job.projectId, claimId, 1, input, { id: job.id, key: input.key });
      await tx.claim.update({ where: { id: claimId }, data: { currentRevisionId: id } });
      ids.set(input.key, { id, claimId });
    }
    const conflictIds: string[] = [];
    for (const conflict of output.conflicts) conflictIds.push(await this.addConflict(tx, job.requestedBy, job.projectId,
      conflict.claimKeys.map(key => ids.get(key)!), conflict.rationale, 'DETECTED'));
    return { claimIds: [...ids.values()].map(row => row.claimId), conflictIds };
  }
}
