import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { Prisma, PrismaClient, ScriptRevision as ScriptRevisionRow, Job } from '../generated/prisma/client.js';
import { canonicalManifestHash } from '../jobs/job-service.js';
import type { TelegramService } from './telegram.service.js';
import { scriptContentSchema, type ScriptContent, type ScriptReviewInput } from './script-contracts.js';
import type { AdaptationFormat } from './telegram-contracts.js';

const SCRIPT_FORMATS = ['LINKEDIN_CAROUSEL', 'INSTAGRAM_CAROUSEL', 'INSTAGRAM_STORIES'] as const;
type ScriptFormat = typeof SCRIPT_FORMATS[number];
const json = (v: unknown): Prisma.InputJsonValue => JSON.parse(JSON.stringify(v)) as Prisma.InputJsonValue;
const isScriptFormat = (v: string): v is ScriptFormat => (SCRIPT_FORMATS as readonly string[]).includes(v);

/** Independently versioned, sealed designer scripts whose parent is an exact approved channel revision. */
export class ScriptService {
  constructor(readonly prisma: PrismaClient, private readonly channels: TelegramService) {}

  private async lock(tx: Prisma.TransactionClient, user: string, project: string, write = true) {
    const rows = write
      ? await tx.$queryRaw<{ id: string }[]>`SELECT p."id" FROM contextflow."Project" p JOIN contextflow."Workspace" w ON w."id"=p."workspaceId" JOIN contextflow."WorkspaceMember" m ON m."workspaceId"=w."id" WHERE p."id"=${project}::uuid AND p."archivedAt" IS NULL AND p."trashedAt" IS NULL AND w."archivedAt" IS NULL AND w."trashedAt" IS NULL AND m."userId"=${user}::uuid AND m."leftAt" IS NULL FOR UPDATE OF p FOR SHARE OF w,m`
      : await tx.$queryRaw<{ id: string }[]>`SELECT p."id" FROM contextflow."Project" p JOIN contextflow."Workspace" w ON w."id"=p."workspaceId" JOIN contextflow."WorkspaceMember" m ON m."workspaceId"=w."id" WHERE p."id"=${project}::uuid AND p."archivedAt" IS NULL AND p."trashedAt" IS NULL AND w."archivedAt" IS NULL AND w."trashedAt" IS NULL AND m."userId"=${user}::uuid AND m."leftAt" IS NULL FOR SHARE OF p,w,m`;
    if (!rows.length) throw new NotFoundException('Project not found');
  }
  private command<T>(user: string, project: string, action: (tx: Prisma.TransactionClient) => Promise<T>, write = true) {
    return this.prisma.$transaction(async tx => { await this.lock(tx, user, project, write); return action(tx); });
  }
  private format(raw: string): ScriptFormat {
    if (!isScriptFormat(raw)) throw new BadRequestException('Scripts are available only for carousel and stories formats');
    return raw;
  }
  private async parent(tx: Prisma.TransactionClient, project: string, format: ScriptFormat, revisionId: string) {
    const selection = await tx.project.findUniqueOrThrow({ where: { id: project }, select: { formats: true } });
    if (!selection.formats.includes(format)) throw new ConflictException('Select this format before editing or approving its script');
    const adaptation = await tx.adaptation.findUnique({ where: { projectId_format: { projectId: project, format } } });
    const revision = adaptation ? await tx.adaptationRevision.findFirst({ where: { projectId: project, adaptationId: adaptation.id, id: revisionId } }) : null;
    if (!adaptation || !revision || adaptation.currentApprovedRevisionId !== revision.id || !revision.approvedAt || revision.withdrawnAt) {
      throw new ConflictException('Choose the current approved caption revision for this script');
    }
    const inspection = await this.channels.inspectRevision(tx, project, revision);
    if (!inspection.eligible) throw new ConflictException('The caption revision needs review before a script can use it');
    return { adaptation, revision, inspection };
  }
  async commitGenerated(tx: Prisma.TransactionClient, job: Job, captionRevisionId: string, raw: unknown, executionId: string) {
    const format = this.format(String((await tx.adaptationRevision.findFirstOrThrow({ where: { id: captionRevisionId }, include: { adaptation: true } })).adaptation.format));
    const parent = await tx.adaptationRevision.findFirst({ where: { id: captionRevisionId, projectId: job.projectId, jobId: job.id }, include: { adaptation: true } });
    const content = scriptContentSchema.safeParse(raw);
    if (!parent || !content.success || parent.adaptation.format !== format || !parent.claimsSealed) throw new ConflictException('Generated script candidate does not match the accepted caption candidate');
    const contentCheck = await this.validateContent(tx, job.projectId, format, parent, content.data);
    this.assertContent(contentCheck);
    const script = await tx.script.findUnique({ where: { projectId_format: { projectId: job.projectId, format } } })
      ?? await tx.script.create({ data: { projectId: job.projectId, format } });
    const latest = await tx.scriptRevision.findFirst({ where: { scriptId: script.id }, orderBy: { number: 'desc' } });
    const revision = await tx.scriptRevision.create({ data: { id: randomUUID(), projectId: job.projectId, scriptId: script.id, number: (latest?.number ?? 0) + 1,
      parentAdaptationRevisionId: parent.id, parentAdaptationRevisionHash: parent.sha256, parentAdaptationReviewCounter: parent.reviewCounter,
      content: json(content.data), sha256: canonicalManifestHash(content.data),
      createdBy: job.requestedBy, origin: 'AI', jobId: job.id, aiExecutionId: executionId } });
    const edges = content.data.frames.flatMap(frame => frame.mappings.map((mapping, mappingIndex) => ({ projectId: job.projectId, revisionId: revision.id, frameId: frame.id, mappingIndex,
      locator: `${frame.id}:${mapping.startOffset}:${mapping.endOffset}`, startOffset: mapping.startOffset, endOffset: mapping.endOffset, claimRevisionId: mapping.claimRevisionId, evidenceId: mapping.evidenceId,
      quote: mapping.quote, linkedText: frame.text.slice(mapping.startOffset, mapping.endOffset) })));
    if (edges.length) await tx.scriptRevisionClaim.createMany({ data: edges });
    await this.persistEvidenceLineage(tx, job.projectId, revision.id, parent.sourceEvidenceSetId, content.data);
    await tx.script.update({ where: { id: script.id }, data: { revision: { increment: 1 } } });
    return { scriptRevisionId: revision.id };
  }
  private async validateContent(tx: Prisma.TransactionClient, project: string, format: ScriptFormat,
    parent: { id: string; contentMode: string; basisRevisionId: string | null; sourceArticleVersionId: string | null;
      briefRevisionId: string; sourceEvidenceSetId: string | null; reviewCounter: number; reviewedBasisRevisionId: string | null;
      reviewedSourceArticleVersionId: string | null }, content: ScriptContent) {
    const allowed = new Set<string>();
    if (parent.contentMode === 'FACTUAL' && parent.basisRevisionId) {
      const basisEdges = await tx.basisClaimEvidence.findMany({ where: { projectId: project, basisId: parent.basisRevisionId } });
      for (const edge of basisEdges) allowed.add(`${edge.claimRevisionId}:${edge.evidenceId}`);
    }
    if (parent.sourceArticleVersionId) {
      const sourceEdges = await tx.articleVersionClaim.findMany({ where: { projectId: project, articleVersionId: parent.sourceArticleVersionId } });
      const source = new Set(sourceEdges.map(edge => `${edge.claimRevisionId}:${edge.evidenceId}`));
      for (const key of [...allowed]) if (!source.has(key)) allowed.delete(key);
    }
    if (parent.reviewCounter > 0) {
      const reviewedEdges = parent.reviewedBasisRevisionId
        ? await tx.basisClaimEvidence.findMany({ where: { projectId: project, basisId: parent.reviewedBasisRevisionId } }) : [];
      const reviewedBasis = new Set(reviewedEdges.map(edge => `${edge.claimRevisionId}:${edge.evidenceId}`));
      for (const key of [...allowed]) if (!reviewedBasis.has(key)) allowed.delete(key);
      if (parent.reviewedSourceArticleVersionId) {
        const rows = await tx.articleVersionClaim.findMany({ where: { projectId: project, articleVersionId: parent.reviewedSourceArticleVersionId } });
        const reviewedArticle = new Set(rows.map(edge => `${edge.claimRevisionId}:${edge.evidenceId}`));
        for (const key of [...allowed]) if (!reviewedArticle.has(key)) allowed.delete(key);
      }
    }
    let grounding: Awaited<ReturnType<TelegramService['inspectSourceSet']>> | null = null;
    const issues: string[] = [];
    if (parent.sourceEvidenceSetId) {
      if (parent.contentMode !== 'FACTUAL' || parent.basisRevisionId !== null || !parent.briefRevisionId) issues.push('SOURCE_EVIDENCE_PARENT_INVALID');
      else {
        try { grounding = await this.channels.inspectSourceSet(tx, project, parent.sourceEvidenceSetId, parent.briefRevisionId, true); }
        catch { issues.push('SOURCE_EVIDENCE_SET_INVALID'); }
      }
    }
    if (grounding) {
      for (const claim of grounding.requiredClaims) for (const evidence of claim.evidence) allowed.add(`${claim.claimRevisionId}:${evidence.evidenceId}`);
      for (const articleId of [parent.sourceArticleVersionId,parent.reviewCounter > 0 ? parent.reviewedSourceArticleVersionId : null].filter((id): id is string => !!id)) {
        const rows = await tx.articleVersionClaim.findMany({ where: { projectId: project,articleVersionId: articleId } });
        const articleEvidence = new Set(rows.map(row => `${row.claimRevisionId}:${row.evidenceId}`));
        for (const key of allowed) if (!articleEvidence.has(key)) allowed.delete(key);
      }
    }
    let hasUnmapped = false;
    for (const frame of content.frames) {
      if (!frame.text.trim()) issues.push('EMPTY_FRAME');
      if (format === 'INSTAGRAM_STORIES' && !frame.transition.trim()) issues.push('STORY_TRANSITION_REQUIRED');
      const ranges = [
        ...frame.mappings.map(map => ({ ...map, kind: 'claim' as const })),
        ...(frame.sourceMappings ?? []).map(map => ({ ...map, kind: 'source' as const })),
      ].sort((a, b) => a.startOffset - b.startOffset || a.endOffset - b.endOffset);
      let cursor = 0;
      for (const map of ranges) {
        if (frame.text.slice(cursor, map.startOffset).trim()) hasUnmapped = true;
        cursor = map.endOffset;
        const linkedText = frame.text.slice(map.startOffset, map.endOffset);
        if (!linkedText.trim()) issues.push('EMPTY_EVIDENCE_RANGE');
        if (map.kind === 'source') {
          const passage = grounding?.passages.find(item => item.id === map.passageId && item.packetId === map.packetId);
          if (!parent.sourceEvidenceSetId || parent.contentMode !== 'FACTUAL' || !passage || !passage.quote.includes(map.quote)) issues.push('INVALID_SOURCE_EVIDENCE');
          continue;
        }
        if (linkedText !== map.quote) { issues.push('FRAME_LOCATOR_MISMATCH'); continue; }
        if (parent.contentMode !== 'FACTUAL' || !allowed.has(`${map.claimRevisionId}:${map.evidenceId}`)) { issues.push('EVIDENCE_OUTSIDE_PARENT'); continue; }
        const evidence = await tx.claimEvidence.findFirst({ where: { projectId: project, id: map.evidenceId, claimRevisionId: map.claimRevisionId }, include: { claimRevision: true } });
        if (!evidence || evidence.invalidatedAt || evidence.relation !== 'SUPPORTS' || evidence.claimRevision.status !== 'APPROVED'
          || !evidence.claimRevision.approvedAt || evidence.claimRevision.withdrawnAt || evidence.claimRevision.rejectedAt) issues.push('INVALID_EVIDENCE');
      }
      if (frame.text.slice(cursor).trim()) hasUnmapped = true;
    }
    if (parent.sourceEvidenceSetId && !content.frames.some(frame => frame.sourceMappings?.length)) issues.push('SOURCE_EVIDENCE_REQUIRED');
    if (!parent.sourceEvidenceSetId && content.frames.some(frame => frame.sourceMappings?.length)) issues.push('SOURCE_EVIDENCE_SET_REQUIRED');
    return { hasUnmapped, issues: [...new Set(issues)] };
  }
  private assertContent(details: { issues: string[] }) {
    if (details.issues.length) throw new ConflictException('Script frames or evidence need correction before saving or approval');
  }
  private sourceCitationRows(project: string, revisionId: string, sourceEvidenceSetId: string, content: ScriptContent) {
    return content.frames.flatMap(frame => (frame.sourceMappings ?? []).map(mapping => ({
      projectId: project, revisionId, sourceEvidenceSetId, packetId: mapping.packetId, spanId: mapping.passageId, frameId: frame.id,
      locator: `${frame.id}:${mapping.startOffset}:${mapping.endOffset}`, text: frame.text.slice(mapping.startOffset, mapping.endOffset), quote: mapping.quote,
    })));
  }
  private async sourceCitationIntegrity(tx: Prisma.TransactionClient, project: string, row: ScriptRevisionRow, content: ScriptContent, sourceEvidenceSetId: string | null) {
    const citations = await tx.scriptRevisionSourceCitation.findMany({ where: { projectId: project, revisionId: row.id },
      orderBy: [{ frameId: 'asc' }, { locator: 'asc' }] });
    if (!sourceEvidenceSetId) return !row.sourceEvidenceSealed && !citations.length && !content.frames.some(frame => frame.sourceMappings?.length);
    if (!row.sourceEvidenceSealed) return false;
    const expected = this.sourceCitationRows(project, row.id, sourceEvidenceSetId, content)
      .map(({ frameId, packetId, spanId, locator, text, quote }) => ({ frameId, packetId, spanId, locator, text, quote }))
      .sort((a,b) => `${a.frameId}:${a.locator}`.localeCompare(`${b.frameId}:${b.locator}`));
    const actual = citations.map(({ frameId, packetId, spanId, locator, text, quote }) => ({ frameId, packetId, spanId, locator, text, quote }))
      .sort((a,b) => `${a.frameId}:${a.locator}`.localeCompare(`${b.frameId}:${b.locator}`));
    return expected.length > 0 && citations.length === expected.length && citations.every(citation => citation.sourceEvidenceSetId === sourceEvidenceSetId)
      && canonicalManifestHash(actual) === canonicalManifestHash(expected);
  }
  private async persistEvidenceLineage(tx: Prisma.TransactionClient, project: string, revisionId: string, sourceEvidenceSetId: string | null, content: ScriptContent) {
    if (sourceEvidenceSetId) {
      const rows = this.sourceCitationRows(project, revisionId, sourceEvidenceSetId, content);
      if (!rows.length) throw new ConflictException('A source-grounded script needs at least one exact cited passage');
      await tx.scriptRevisionSourceCitation.createMany({ data: rows });
      await tx.scriptRevision.update({ where: { id: revisionId }, data: { claimsSealed: true, sourceEvidenceSealed: true } });
    } else {
      if (content.frames.some(frame => frame.sourceMappings?.length)) throw new ConflictException('Script source citations require the approved caption source set');
      await tx.scriptRevision.update({ where: { id: revisionId }, data: { claimsSealed: true } });
    }
  }
  private async inspectParent(tx: Prisma.TransactionClient, project: string, format: ScriptFormat, row: { parentAdaptationRevisionId: string; parentAdaptationRevisionHash: string; parentAdaptationReviewCounter: number }) {
    const adaptation = await tx.adaptation.findUnique({ where: { projectId_format: { projectId: project, format } } });
    const parent = adaptation ? await tx.adaptationRevision.findFirst({ where: { id: row.parentAdaptationRevisionId, projectId: project, adaptationId: adaptation.id } }) : null;
    const staleReasons: string[] = [];
    const blockingReasons: string[] = [];
    if (!parent || parent.sha256 !== row.parentAdaptationRevisionHash || canonicalManifestHash(parent.content) !== parent.sha256) blockingReasons.push('PARENT_INTEGRITY');
    if (!adaptation || adaptation.currentApprovedRevisionId !== row.parentAdaptationRevisionId) staleReasons.push('PARENT_CHANGED');
    if (parent) {
      if (parent.reviewCounter !== row.parentAdaptationReviewCounter) staleReasons.push('PARENT_REVIEW_CHANGED');
      const inspection = await this.channels.inspectRevision(tx, project, parent);
      staleReasons.push(...inspection.staleReasons);
      blockingReasons.push(...inspection.blockingReasons);
      if (!parent.approvedAt || parent.withdrawnAt) blockingReasons.push('PARENT_NOT_APPROVED');
    }
    return { parent, staleReasons: [...new Set(staleReasons)], blockingReasons: [...new Set(blockingReasons)] };
  }
  async inspectRevision(tx: Prisma.TransactionClient, project: string, row: ScriptRevisionRow) {
    const script = await tx.script.findUnique({ where: { id: row.scriptId } });
    if (!script) throw new ConflictException('Script aggregate is unavailable');
    const content = scriptContentSchema.safeParse(row.content);
    const parent = await this.inspectParent(tx, project, script.format as ScriptFormat, row);
    const details = content.success && parent.parent
      ? await this.validateContent(tx, project, script.format as ScriptFormat, parent.parent, content.data) : { hasUnmapped: false, issues: [] as string[] };
    const blockingReasons = [...parent.blockingReasons];
    if (!content.success || canonicalManifestHash(row.content) !== row.sha256) blockingReasons.push('CONTENT_INTEGRITY');
    blockingReasons.push(...details.issues);
    if (content.success && !await this.sourceCitationIntegrity(tx, project, row, content.data, parent.parent?.sourceEvidenceSetId ?? null)) blockingReasons.push('SOURCE_CITATION_INTEGRITY');
    if (!row.claimsSealed) blockingReasons.push('UNSEALED_EVIDENCE');
    if (row.withdrawnAt) blockingReasons.push('APPROVAL_WITHDRAWN');
    if (details.hasUnmapped && !row.acknowledgedUnmapped) blockingReasons.push('UNMAPPED_NOT_ACKNOWLEDGED');
    return { staleReasons: parent.staleReasons, blockingReasons: [...new Set(blockingReasons)], hasUnmapped: details.hasUnmapped,
      eligible: !!row.approvedAt && !row.withdrawnAt && !parent.staleReasons.length && !blockingReasons.length };
  }
  /** Read-only export boundary for source passages actually cited by this script. */
  async inspectSourceEvidence(tx: Prisma.TransactionClient, project: string, row: ScriptRevisionRow) {
    const script = await tx.script.findUnique({ where: { id: row.scriptId } });
    if (!script) throw new ConflictException('Script aggregate is unavailable');
    const content = scriptContentSchema.safeParse(row.content);
    if (!content.success || canonicalManifestHash(row.content) !== row.sha256) throw new ConflictException('Script content failed integrity checks');
    const parent = await this.inspectParent(tx, project, script.format as ScriptFormat, row);
    if (parent.blockingReasons.length || parent.staleReasons.length || !parent.parent) throw new ConflictException('Script parent is no longer eligible');
    const sourceEvidenceSetId = parent.parent.sourceEvidenceSetId;
    if (!sourceEvidenceSetId) {
      if (!await this.sourceCitationIntegrity(tx, project, row, content.data, null)) throw new ConflictException('Legacy script has unexpected source citations');
      return null;
    }
    const detail = await this.validateContent(tx, project, script.format as ScriptFormat, parent.parent, content.data);
    if (detail.issues.length || !row.sourceEvidenceSealed || !await this.sourceCitationIntegrity(tx, project, row, content.data, sourceEvidenceSetId)) {
      throw new ConflictException('Script source citations failed integrity checks');
    }
    const grounding = await this.channels.inspectSourceSet(tx, project, sourceEvidenceSetId, parent.parent.briefRevisionId, true);
    const citations = await tx.scriptRevisionSourceCitation.findMany({ where: { projectId: project, revisionId: row.id }, orderBy: [{ frameId: 'asc' }, { locator: 'asc' }] });
    return { sourceEvidenceSetId: grounding.id, sourceEvidenceSetHash: grounding.sha256, passages: citations.map(citation => {
      const passage = grounding.passages.find(item => item.id === citation.spanId && item.packetId === citation.packetId);
      if (!passage) throw new ConflictException('Script citation is outside its frozen source set');
      return { frameId: citation.frameId, passageId: citation.spanId, packetId: citation.packetId, snapshotId: passage.snapshotId,
        sourceQuote: passage.quote, scriptLocator: citation.locator, scriptText: citation.text, quote: citation.quote };
    }) };
  }
  private async state(tx: Prisma.TransactionClient, project: string, format: ScriptFormat) {
    const p = await tx.project.findUniqueOrThrow({ where: { id: project } });
    const adaptation = await tx.adaptation.findUnique({ where: { projectId_format: { projectId: project, format } }, include: { revisions: { orderBy: { number: 'desc' } } } });
    const script = await tx.script.findUnique({ where: { projectId_format: { projectId: project, format } } });
    const draft = script ? await tx.scriptDraft.findUnique({ where: { scriptId: script.id } }) : null;
    const revisions = script ? await tx.scriptRevision.findMany({ where: { projectId: project, scriptId: script.id }, orderBy: { number: 'desc' } }) : [];
    const currentParent = adaptation?.currentApprovedRevisionId ? adaptation.revisions.find(row => row.id === adaptation.currentApprovedRevisionId) : null;
    const parentInspection = currentParent ? await this.channels.inspectRevision(tx, project, currentParent) : null;
    const grounding = currentParent?.sourceEvidenceSetId
      ? await this.channels.inspectSourceSet(tx,project,currentParent.sourceEvidenceSetId,currentParent.briefRevisionId,false) : null;
    return { format, formatSelected: p.formats.includes(format as AdaptationFormat),
      adaptation: adaptation ? { id: adaptation.id, revision: adaptation.revision, currentApprovedRevisionId: adaptation.currentApprovedRevisionId, revisions: adaptation.revisions } : null,
      script: script ? { ...script, draft, revisions: await Promise.all(revisions.map(async row => ({ ...row, ...(await this.inspectRevision(tx, project, row)) }))) } : null,
      eligibleSourcePassages: grounding?.passages.map(row => ({ passageId: row.id,packetId: row.packetId,quote: row.quote,snapshotId: row.snapshotId })) ?? [],
      parent: currentParent ? { id: currentParent.id, sha256: currentParent.sha256, reviewCounter: currentParent.reviewCounter, ...(parentInspection ?? {}) } : null };
  }
  get(user: string, project: string, rawFormat: string) {
    const format = this.format(rawFormat);
    return this.command(user, project, tx => this.state(tx, project, format), false);
  }
  saveDraft(user: string, project: string, rawFormat: string, input: { expectedRevision: number; expectedDraftCounter: number; parentAdaptationRevisionId: string; content: unknown }) {
    const format = this.format(rawFormat);
    return this.command(user, project, async tx => {
      const p = await tx.project.findUniqueOrThrow({ where: { id: project } });
      if (!p.formats.includes(format as AdaptationFormat)) throw new ConflictException(`Select ${format} before editing its script`);
      const script = await tx.script.findUnique({ where: { projectId_format: { projectId: project, format } } });
      if ((script?.revision ?? 0) !== input.expectedRevision) throw new ConflictException('Script changed; reload before saving');
      const parent = await this.parent(tx, project, format, input.parentAdaptationRevisionId);
      const parsed = scriptContentSchema.safeParse(input.content);
      if (!parsed.success) throw new BadRequestException('Invalid script content');
      const details = await this.validateContent(tx, project, format, parent.revision, parsed.data);
      this.assertContent(details);
      const existing = script ? await tx.scriptDraft.findUnique({ where: { scriptId: script.id } }) : null;
      if ((existing?.counter ?? 0) !== input.expectedDraftCounter) throw new ConflictException('Script draft changed; reload before saving');
      const owner = script ?? await tx.script.create({ data: { projectId: project, format } });
      await tx.scriptDraft.upsert({ where: { scriptId: owner.id }, create: { projectId: project, scriptId: owner.id, counter: 1,
        parentAdaptationRevisionId: parent.revision.id, parentAdaptationRevisionHash: parent.revision.sha256, parentAdaptationReviewCounter: parent.revision.reviewCounter, baseRevisionId: null, content: json(parsed.data),
        sha256: canonicalManifestHash(parsed.data), updatedBy: user }, update: { counter: { increment: 1 }, parentAdaptationRevisionId: parent.revision.id,
        parentAdaptationRevisionHash: parent.revision.sha256, parentAdaptationReviewCounter: parent.revision.reviewCounter, baseRevisionId: null, content: json(parsed.data), sha256: canonicalManifestHash(parsed.data), updatedBy: user, updatedAt: new Date() } });
      await tx.script.update({ where: { id: owner.id }, data: { revision: { increment: 1 } } });
      void details;
      return this.state(tx, project, format);
    });
  }
  checkpoint(user: string, project: string, rawFormat: string, input: { expectedRevision: number; expectedDraftCounter: number }) {
    const format = this.format(rawFormat);
    return this.command(user, project, async tx => {
      const script = await tx.script.findUnique({ where: { projectId_format: { projectId: project, format } } });
      if (!script || script.revision !== input.expectedRevision) throw new ConflictException('Script changed; reload before checkpointing');
      const draft = await tx.scriptDraft.findUnique({ where: { scriptId: script.id } });
      if (!draft || draft.counter !== input.expectedDraftCounter) throw new ConflictException('Script draft changed; reload before checkpointing');
      const parent = await this.parent(tx, project, format, draft.parentAdaptationRevisionId);
      if (parent.revision.sha256 !== draft.parentAdaptationRevisionHash || parent.revision.reviewCounter !== draft.parentAdaptationReviewCounter || canonicalManifestHash(draft.content) !== draft.sha256) throw new ConflictException('Script draft integrity check failed');
      const content = scriptContentSchema.parse(draft.content);
      this.assertContent(await this.validateContent(tx, project, format, parent.revision, content));
      const latest = await tx.scriptRevision.findFirst({ where: { scriptId: script.id }, orderBy: { number: 'desc' } });
      const revision = await tx.scriptRevision.create({ data: { id: randomUUID(), projectId: project, scriptId: script.id, number: (latest?.number ?? 0) + 1,
        parentAdaptationRevisionId: parent.revision.id, parentAdaptationRevisionHash: parent.revision.sha256, parentAdaptationReviewCounter: parent.revision.reviewCounter,
        content: json(content), sha256: canonicalManifestHash(content), createdBy: user, origin: 'MANUAL' } });
      const edges = content.frames.flatMap(frame => frame.mappings.map((mapping, mappingIndex) => ({ projectId: project, revisionId: revision.id, frameId: frame.id, mappingIndex,
        locator: `${frame.id}:${mapping.startOffset}:${mapping.endOffset}`, startOffset: mapping.startOffset, endOffset: mapping.endOffset, claimRevisionId: mapping.claimRevisionId, evidenceId: mapping.evidenceId,
        quote: mapping.quote, linkedText: frame.text.slice(mapping.startOffset, mapping.endOffset) })));
      if (edges.length) await tx.scriptRevisionClaim.createMany({ data: edges });
      await this.persistEvidenceLineage(tx, project, revision.id, parent.revision.sourceEvidenceSetId, content);
      await tx.scriptDraft.update({ where: { scriptId: script.id }, data: { baseRevisionId: revision.id, counter: { increment: 1 } } });
      await tx.script.update({ where: { id: script.id }, data: { revision: { increment: 1 } } });
      return this.state(tx, project, format);
    });
  }
  review(user: string, project: string, rawFormat: string, revisionId: string, action: 'apply' | 'approve' | 'withdraw', input: ScriptReviewInput) {
    const format = this.format(rawFormat);
    return this.command(user, project, async tx => {
      const script = await tx.script.findUnique({ where: { projectId_format: { projectId: project, format } } });
      if (!script || script.revision !== input.expectedRevision) throw new ConflictException('Script changed; reload before reviewing');
      const row = await tx.scriptRevision.findFirst({ where: { id: revisionId, projectId: project, scriptId: script.id } });
      if (!row) throw new NotFoundException('Script revision not found');
      if (row.withdrawnAt || canonicalManifestHash(row.content) !== row.sha256) throw new ConflictException('Script revision is withdrawn or its content hash is invalid');
      const parentRow = action === 'withdraw' ? await tx.adaptationRevision.findFirst({ where: { id: row.parentAdaptationRevisionId, projectId: project } })
        : (await this.parent(tx, project, format, row.parentAdaptationRevisionId)).revision;
      if (!parentRow || parentRow.sha256 !== row.parentAdaptationRevisionHash || action !== 'withdraw' && parentRow.reviewCounter !== row.parentAdaptationReviewCounter) throw new ConflictException('Script parent revision or review receipt changed');
      const content = scriptContentSchema.parse(row.content);
      if (action !== 'withdraw' && !await this.sourceCitationIntegrity(tx, project, row, content, parentRow.sourceEvidenceSetId)) {
        throw new ConflictException('Script source citations are not sealed to its content');
      }
      if (action === 'withdraw') {
        if (!row.approvedAt) throw new ConflictException('Only an approved script can be withdrawn');
        await tx.scriptRevision.update({ where: { id: row.id }, data: { withdrawnBy: user, withdrawnAt: new Date(), withdrawalReason: input.reason ?? null } });
        await tx.script.update({ where: { id: script.id }, data: { revision: { increment: 1 }, ...(script.currentApprovedRevisionId === row.id ? { currentApprovedRevisionId: null } : {}) } });
      } else if (action === 'apply') {
        const current = await tx.scriptDraft.findUnique({ where: { scriptId: script.id } });
        if (current && (current.parentAdaptationRevisionId !== row.parentAdaptationRevisionId || current.parentAdaptationReviewCounter !== row.parentAdaptationReviewCounter)) throw new ConflictException('Script parent differs; preserve local work');
        const selected = input.frameIds ? new Set(input.frameIds) : null;
        if (selected && (selected.size !== input.frameIds!.length || [...selected].some(id => !content.frames.some(frame => frame.id === id)))) throw new BadRequestException('Selected frame IDs must be unique and belong to this revision');
        const currentContent = current ? scriptContentSchema.parse(current.content) : { frames: [] };
        const chosen = selected ? content.frames.filter(frame => selected.has(frame.id)) : content.frames;
        const chosenById = new Map(chosen.map(frame => [frame.id, frame]));
        const mergedFrames = selected ? currentContent.frames.map(frame => chosenById.get(frame.id) ?? frame) : [...chosen];
        const existingIds = new Set(currentContent.frames.map(frame => frame.id));
        if (selected) mergedFrames.push(...chosen.filter(frame => !existingIds.has(frame.id)));
        const merged = scriptContentSchema.parse({ frames: mergedFrames });
        this.assertContent(await this.validateContent(tx, project, format, parentRow, merged));
        const exactFullApply = !selected && canonicalManifestHash(merged) === row.sha256;
        await tx.scriptDraft.upsert({ where: { scriptId: script.id }, create: { projectId: project, scriptId: script.id, counter: 1,
          parentAdaptationRevisionId: row.parentAdaptationRevisionId, parentAdaptationRevisionHash: row.parentAdaptationRevisionHash, parentAdaptationReviewCounter: row.parentAdaptationReviewCounter, baseRevisionId: exactFullApply ? row.id : null,
          content: json(merged), sha256: canonicalManifestHash(merged), updatedBy: user },
          update: { counter: { increment: 1 }, parentAdaptationRevisionId: row.parentAdaptationRevisionId, parentAdaptationRevisionHash: row.parentAdaptationRevisionHash, parentAdaptationReviewCounter: row.parentAdaptationReviewCounter,
            baseRevisionId: exactFullApply ? row.id : null, content: json(merged), sha256: canonicalManifestHash(merged), updatedBy: user, updatedAt: new Date() } });
        await tx.script.update({ where: { id: script.id }, data: { revision: { increment: 1 } } });
      } else {
        const draft = await tx.scriptDraft.findUnique({ where: { scriptId: script.id } });
        if (!draft || draft.baseRevisionId !== row.id || draft.sha256 !== row.sha256 || draft.parentAdaptationRevisionId !== row.parentAdaptationRevisionId
          || draft.parentAdaptationReviewCounter !== row.parentAdaptationReviewCounter) throw new ConflictException('Approve only the exact saved script checkpoint');
        if (row.approvedAt || input.expectedReviewCounter !== row.reviewCounter) throw new ConflictException('Script review counter is missing or stale');
        const details = await this.validateContent(tx, project, format, parentRow, content);
        this.assertContent(details);
        if (details.hasUnmapped && !input.acknowledgeUnmapped) throw new ConflictException('Acknowledge unmapped frame text before approval');
        await tx.scriptRevision.update({ where: { id: row.id }, data: { approvedBy: user, approvedAt: new Date(), acknowledgedUnmapped: details.hasUnmapped && input.acknowledgeUnmapped === true } });
        await tx.script.update({ where: { id: script.id }, data: { currentApprovedRevisionId: row.id, revision: { increment: 1 } } });
      }
      return this.state(tx, project, format);
    });
  }
}
