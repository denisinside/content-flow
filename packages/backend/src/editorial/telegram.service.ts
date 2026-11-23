import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { Prisma, PrismaClient, Job, AdaptationDraft, AdaptationRevision } from '../generated/prisma/client.js';
import { FactualBasisService } from '../claims/factual-basis.service.js';
import { SourceGroundingService } from '../evidence/source-grounding.service.js';
import { DurableJobService, canonicalManifestHash } from '../jobs/job-service.js';
import { JobFailure } from '../jobs/contracts.js';
import { EXTERNAL_PROCESSING_NOTICE } from '../external-processing-notice.js';
import { canonicalBriefHash } from './editorial.service.js';
import { telegramContentSchema, telegramInputManifestSchema, telegramWorkflowReleaseSchema,
  validateFormatContent,
  type TelegramContent, type TelegramInputManifest, type TelegramWorkflowRelease, type SaveTelegramDraftInput,
  type ReviewTelegramInput, type GenerateTelegramInput, type AdaptationFormat } from './telegram-contracts.js';
import type { ArticleService } from './article.service.js';

function json<T>(value: T): T { return JSON.parse(JSON.stringify(value)) as T; }
const briefInclude = { requiredClaims: true, contextSnapshots: true, style: true } as const;
type Inputs = Pick<AdaptationDraft, 'inputMode' | 'contentMode' | 'briefRevisionId' | 'basisRevisionId' | 'sourceEvidenceSetId' | 'sourceArticleVersionId' | 'workspaceId' | 'workspaceStyleRevision' | 'includeLink'>;
export type SourceAdaptationInputs = Pick<Inputs, 'inputMode' | 'contentMode' | 'briefRevisionId' | 'basisRevisionId' | 'sourceEvidenceSetId' | 'sourceArticleVersionId' | 'workspaceId' | 'workspaceStyleRevision' | 'includeLink'>;
type MappingIssue = { locator: string; claimRevisionId?: string; evidenceId?: string; passageId?: string; reason: string };
export const TELEGRAM_GENERATION_DEADLINE_MS = 600_000;

/** Telegram is an immutable reviewed adaptation with its own approval pointer. */
export class TelegramService {
  private readonly grounding: SourceGroundingService;
  constructor(readonly prisma: PrismaClient, private readonly jobs: DurableJobService, private readonly facts: FactualBasisService,
    private readonly articles: ArticleService) { this.grounding = new SourceGroundingService(); }
  /** Internal evidence lookup for script/export boundaries. Caller holds the authorized Project transaction. */
  inspectSourceSet(tx: Prisma.TransactionClient, project: string, setId: string, briefRevisionId: string, requireCurrent = true) {
    return this.grounding.inspectSet(tx, project, setId, briefRevisionId, requireCurrent);
  }

  private async lock(tx: Prisma.TransactionClient, user: string, project: string, write = true) {
    const rows = write
      ? await tx.$queryRaw<{ id: string }[]>`SELECT p."id" FROM contextflow."Project" p JOIN contextflow."Workspace" w ON w."id"=p."workspaceId" JOIN contextflow."WorkspaceMember" m ON m."workspaceId"=w."id" WHERE p."id"=${project}::uuid AND p."archivedAt" IS NULL AND p."trashedAt" IS NULL AND w."archivedAt" IS NULL AND w."trashedAt" IS NULL AND m."userId"=${user}::uuid AND m."leftAt" IS NULL FOR UPDATE OF p FOR SHARE OF w,m`
      : await tx.$queryRaw<{ id: string }[]>`SELECT p."id" FROM contextflow."Project" p JOIN contextflow."Workspace" w ON w."id"=p."workspaceId" JOIN contextflow."WorkspaceMember" m ON m."workspaceId"=w."id" WHERE p."id"=${project}::uuid AND p."archivedAt" IS NULL AND p."trashedAt" IS NULL AND w."archivedAt" IS NULL AND w."trashedAt" IS NULL AND m."userId"=${user}::uuid AND m."leftAt" IS NULL FOR SHARE OF p,w,m`;
    if (!rows.length) throw new NotFoundException('Project not found');
  }
  private command<T>(user: string, project: string, action: (tx: Prisma.TransactionClient) => Promise<T>, write = true) {
    // Channel state validates revisions and their approved article within the project lock.
    return this.prisma.$transaction(async tx => { await this.lock(tx, user, project, write); return action(tx); },
      { maxWait: 5_000, timeout: 30_000 });
  }
  private async adaptation(tx: Prisma.TransactionClient, project: string, expected: number, format: AdaptationFormat = 'TELEGRAM_POST', create = true) {
    const p = await tx.project.findUniqueOrThrow({ where: { id: project } });
    if (!p.formats.includes(format)) throw new ConflictException(`Select ${format} before working on an adaptation`);
    const row = await tx.adaptation.findUnique({ where: { projectId_format: { projectId: project, format } }, include: { draft: true } });
    if ((row?.revision ?? 0) !== expected) throw new ConflictException('Adaptation changed; retain local text and reload before saving');
    if (!row && !create) throw new NotFoundException('Adaptation not found');
    return row ?? { ...await tx.adaptation.create({ data: { projectId: project, format } }), draft: null };
  }
  private async currentInputs(tx: Prisma.TransactionClient, project: string, inputMode: Inputs['inputMode'], contentMode: Inputs['contentMode'], includeLink: boolean): Promise<Inputs> {
    const p = await tx.project.findUniqueOrThrow({ where: { id: project }, include: { workspace: true } });
    const brief = await tx.brief.findUnique({ where: { projectId: project }, include: { currentRevision: true } });
    const b = brief?.currentRevision?.contentMode === contentMode ? brief.currentRevision : null;
    let sourceArticleVersionId: string | null = null;
    let sourceEvidenceSetId: string | null = null;
    if (inputMode === 'ARTICLE_DERIVED') {
      const article = await tx.article.findUnique({ where: { projectId: project } });
      sourceArticleVersionId = article?.currentApprovedVersionId ?? null;
      const source = sourceArticleVersionId ? await tx.articleVersion.findFirst({ where: { id: sourceArticleVersionId, projectId: project }, select: { sourceEvidenceSetId: true } }) : null;
      sourceEvidenceSetId = contentMode === 'FACTUAL' ? source?.sourceEvidenceSetId ?? null : null;
    } else if (contentMode === 'FACTUAL' && b) {
      const set = await tx.sourceEvidenceSet.findFirst({ where: { projectId: project,briefRevisionId: b.id,sealed: true },orderBy: { createdAt: 'desc' },select: { id: true } });
      sourceEvidenceSetId = set?.id ?? null;
    }
    return { inputMode, contentMode, briefRevisionId: b?.id ?? '', basisRevisionId: null, sourceEvidenceSetId,
      sourceArticleVersionId, workspaceId: p.workspaceId, workspaceStyleRevision: p.workspace.styleRevision, includeLink };
  }
  private async validateInputs(tx: Prisma.TransactionClient, project: string, inputs: Inputs, requireCurrentSource = true) {
    if (!inputs.briefRevisionId) throw new ConflictException('Save a Brief in the selected content mode first');
    const brief = await tx.briefRevision.findFirst({ where: { id: inputs.briefRevisionId, projectId: project }, include: briefInclude });
    if (!brief || brief.contentMode !== inputs.contentMode || canonicalBriefHash(brief) !== brief.sha256) throw new ConflictException('Telegram inputs need a valid saved Brief');
    const projectRow = await tx.project.findUniqueOrThrow({ where: { id: project }, include: { workspace: true } });
    if (inputs.workspaceId !== projectRow.workspaceId || brief.workspaceId !== projectRow.workspaceId) throw new ConflictException('Brief Workspace ancestry is invalid');
    await tx.workspaceStyleRevision.findUniqueOrThrow({ where: { workspaceId_revision: { workspaceId: inputs.workspaceId, revision: inputs.workspaceStyleRevision } } });
    if (inputs.contentMode === 'FACTUAL' && inputs.sourceEvidenceSetId) {
      if (inputs.basisRevisionId !== null) throw new ConflictException('Source-grounded Telegram cannot mix in a factual basis');
      await this.grounding.inspectSet(tx, project, inputs.sourceEvidenceSetId, brief.id, requireCurrentSource);
    } else if (inputs.contentMode === 'FACTUAL') {
      throw new ConflictException('Factual channel writing requires source evidence');
    } else if (inputs.basisRevisionId !== null || inputs.sourceEvidenceSetId !== null) throw new ConflictException('Creative Telegram inputs cannot include factual evidence');
    if (inputs.inputMode === 'DIRECT') {
      if (inputs.sourceArticleVersionId !== null) throw new ConflictException('Direct Telegram inputs cannot reference an article');
    } else {
      if (!inputs.sourceArticleVersionId) throw new ConflictException('Derived Telegram needs a current approved article');
      const article = await tx.article.findUnique({ where: { projectId: project } });
      const version = await tx.articleVersion.findFirst({ where: { id: inputs.sourceArticleVersionId, projectId: project }, include: { claims: true } });
      if (!article || !version || version.contentMode !== inputs.contentMode || !version.approvedAt || version.withdrawnAt
        || requireCurrentSource && article.currentApprovedVersionId !== version.id) throw new ConflictException('Derived Telegram source article is not current and approved');
      const inspection = await this.articles.inspectVersion(tx, project, version);
      if (!inspection.eligible) throw new ConflictException('Derived Telegram source article needs current factual review');
      if (inputs.sourceEvidenceSetId !== (inputs.contentMode === 'FACTUAL' ? version.sourceEvidenceSetId : null)) throw new ConflictException('Derived Telegram source evidence must match its approved Article version');
    }
    return brief;
  }
  private async validateSavedAncestry(tx: Prisma.TransactionClient, project: string, inputs: Inputs) {
    const brief = await tx.briefRevision.findFirst({ where: { id: inputs.briefRevisionId, projectId: project }, include: briefInclude });
    if (!brief || brief.contentMode !== inputs.contentMode || canonicalBriefHash(brief) !== brief.sha256) throw new ConflictException('Saved Telegram Brief ancestry is invalid');
    const projectRow = await tx.project.findUniqueOrThrow({ where: { id: project }, include: { workspace: true } });
    if (inputs.workspaceId !== projectRow.workspaceId || brief.workspaceId !== projectRow.workspaceId) throw new ConflictException('Saved Telegram Workspace ancestry is invalid');
    await tx.workspaceStyleRevision.findUniqueOrThrow({ where: { workspaceId_revision: { workspaceId: inputs.workspaceId, revision: inputs.workspaceStyleRevision } } });
    if (inputs.contentMode === 'FACTUAL' && inputs.basisRevisionId && !await tx.factualBasisRevision.findFirst({ where: { id: inputs.basisRevisionId, projectId: project }, select: { id: true } })) throw new ConflictException('Saved Telegram basis ancestry is invalid');
    if (inputs.sourceEvidenceSetId) {
      if (inputs.contentMode !== 'FACTUAL' || inputs.basisRevisionId !== null) throw new ConflictException('Saved source evidence ancestry is invalid');
      await this.grounding.inspectSet(tx, project, inputs.sourceEvidenceSetId, brief.id, false);
    }
    if (inputs.inputMode === 'DIRECT' && inputs.sourceArticleVersionId !== null) throw new ConflictException('Direct Telegram draft cannot reference an article');
    if (inputs.inputMode === 'ARTICLE_DERIVED' && inputs.sourceArticleVersionId) {
      const source = await tx.articleVersion.findFirst({ where: { id: inputs.sourceArticleVersionId, projectId: project }, select: { id: true, contentMode: true, sourceEvidenceSetId: true } });
      if (!source || source.contentMode !== inputs.contentMode || (inputs.contentMode === 'FACTUAL' ? source.sourceEvidenceSetId : null) !== inputs.sourceEvidenceSetId) throw new ConflictException('Saved Telegram article ancestry is invalid');
    }
  }
  private async evidenceDetail(tx: Prisma.TransactionClient, project: string, content: TelegramContent, inputs: Inputs, ancestryOnly = false) {
    const issues: MappingIssue[] = [];
    let hasUnmapped = false;
    const grounding = inputs.sourceEvidenceSetId
      ? await this.grounding.inspectSet(tx, project, inputs.sourceEvidenceSetId, inputs.briefRevisionId, false) : null;
    for (const field of ['text', 'cover'] as const) {
      const target = field === 'text' ? content.text : content.cover?.text;
      const sorted = [
        ...content.mappings.filter(mapping => (mapping.field ?? 'text') === field).map(mapping => ({ kind: 'claim' as const, value: mapping })),
        ...(content.sourceMappings ?? []).filter(mapping => (mapping.field ?? 'text') === field).map(mapping => ({ kind: 'source' as const, value: mapping })),
      ].sort((a, b) => a.value.startOffset - b.value.startOffset || a.value.endOffset - b.value.endOffset);
      let cursor = 0;
      for (const entry of sorted) {
        const mapping = entry.value, locator = `${field}:${mapping.startOffset}:${mapping.endOffset}`;
        if (target?.slice(cursor, mapping.startOffset).trim()) hasUnmapped = true;
        cursor = mapping.endOffset;
        if (entry.kind === 'source') {
          const sourceMap = mapping as NonNullable<TelegramContent['sourceMappings']>[number];
          const passage = grounding?.passages.find(item => item.id === sourceMap.passageId && item.packetId === sourceMap.packetId);
          if (inputs.contentMode !== 'FACTUAL' || !passage || !passage.quote.includes(sourceMap.quote) || !target?.slice(sourceMap.startOffset, sourceMap.endOffset).trim()) {
            issues.push({ locator, passageId: sourceMap.passageId, reason: inputs.contentMode !== 'FACTUAL' ? 'CREATIVE_SOURCE_MAPPING' : grounding ? 'INVALID_SOURCE_PASSAGE' : 'MISSING_SOURCE_EVIDENCE_SET' });
          }
          continue;
        }
        const claimMap = mapping as TelegramContent['mappings'][number];
        if (target?.slice(claimMap.startOffset, claimMap.endOffset) !== claimMap.quote) issues.push({ locator, claimRevisionId: claimMap.claimRevisionId, evidenceId: claimMap.evidenceId, reason: 'WORDING_CHANGED' });
        const evidence = await tx.claimEvidence.findFirst({ where: { id: claimMap.evidenceId, claimRevisionId: claimMap.claimRevisionId, projectId: project } });
        if (!evidence) throw new BadRequestException('Telegram evidence must belong to its exact claim and project');
        if (inputs.contentMode === 'CREATIVE') { issues.push({ locator, claimRevisionId: claimMap.claimRevisionId, evidenceId: claimMap.evidenceId, reason: 'CREATIVE_MAPPING' }); continue; }
        if (!ancestryOnly) {
          const required = grounding?.requiredClaims.find(item => item.claimRevisionId === claimMap.claimRevisionId);
          const requiredEvidence = required?.evidence.some(item => item.evidenceId === claimMap.evidenceId && item.quote === claimMap.quote) ?? false;
          const edge = !grounding && inputs.basisRevisionId ? await tx.basisClaimEvidence.findFirst({ where: { projectId: project, basisId: inputs.basisRevisionId, claimRevisionId: claimMap.claimRevisionId, evidenceId: claimMap.evidenceId } }) : null;
          if (!(grounding ? requiredEvidence : edge)) issues.push({ locator, claimRevisionId: claimMap.claimRevisionId, evidenceId: claimMap.evidenceId, reason: grounding ? 'OUTSIDE_REQUIRED_CLAIMS' : 'OUTSIDE_BASIS' });
          if (evidence.invalidatedAt || evidence.relation !== 'SUPPORTS') issues.push({ locator, claimRevisionId: claimMap.claimRevisionId, evidenceId: claimMap.evidenceId, reason: 'INVALID_EVIDENCE' });
        }
      }
      if (target?.slice(cursor).trim()) hasUnmapped = true;
    }
    return { issues, hasUnmapped };
  }
  private async stale(tx: Prisma.TransactionClient, project: string, row: Inputs & { reviewedBriefRevisionId?: string | null; reviewedBasisRevisionId?: string | null; reviewedSourceEvidenceSetId?: string | null; reviewedSourceArticleVersionId?: string | null; reviewedWorkspaceStyleRevision?: number | null }) {
    const current = await this.currentInputs(tx, project, row.inputMode, row.contentMode, row.includeLink), reasons: string[] = [];
    const capture = (briefRevisionId: string | null, basisRevisionId: string | null, sourceEvidenceSetId: string | null, sourceArticleVersionId: string | null, styleRevision: number | null) =>
      briefRevisionId === current.briefRevisionId && (row.contentMode !== 'FACTUAL' || !!row.sourceEvidenceSetId || basisRevisionId === current.basisRevisionId)
        && (row.inputMode !== 'ARTICLE_DERIVED' || sourceEvidenceSetId === current.sourceEvidenceSetId)
        && sourceArticleVersionId === current.sourceArticleVersionId && styleRevision === current.workspaceStyleRevision;
    const originalTupleCurrent = capture(row.briefRevisionId || null, row.basisRevisionId, row.sourceEvidenceSetId, row.sourceArticleVersionId, row.workspaceStyleRevision);
    const receiptTupleCurrent = capture(row.reviewedBriefRevisionId ?? null, row.reviewedBasisRevisionId ?? null, row.reviewedSourceEvidenceSetId ?? row.sourceEvidenceSetId, row.reviewedSourceArticleVersionId ?? null, row.reviewedWorkspaceStyleRevision ?? null);
    if (!originalTupleCurrent && !receiptTupleCurrent) {
      reasons.push('INPUTS_CHANGED');
      if (current.briefRevisionId !== (row.briefRevisionId || null)) reasons.push('BRIEF_CHANGED');
      if (current.workspaceStyleRevision !== row.workspaceStyleRevision) reasons.push('WORKSPACE_STYLE_CHANGED');
      if (row.contentMode === 'FACTUAL' && !row.sourceEvidenceSetId) reasons.push('SOURCE_EVIDENCE_REQUIRED');
      if (row.inputMode === 'ARTICLE_DERIVED' && current.sourceArticleVersionId !== row.sourceArticleVersionId) reasons.push('SOURCE_ARTICLE_CHANGED');
    }
    if (row.contentMode === 'FACTUAL' && row.sourceEvidenceSetId) {
      try { await this.grounding.inspectSet(tx, project, row.sourceEvidenceSetId, row.briefRevisionId, true); }
      catch { reasons.push('INVALID_ORIGINAL_SOURCE_EVIDENCE_SET'); }
    } else if (row.contentMode === 'FACTUAL') reasons.push('SOURCE_EVIDENCE_REQUIRED');
    if (row.inputMode === 'ARTICLE_DERIVED' && row.sourceArticleVersionId) {
      const source = await tx.articleVersion.findFirst({ where: { id: row.sourceArticleVersionId, projectId: project }, include: { claims: true } });
      if (!source || !source.approvedAt || source.withdrawnAt) reasons.push('INVALID_ORIGINAL_SOURCE_ARTICLE');
      else if ((await this.articles.inspectVersion(tx, project, source)).blockingReasons.length) reasons.push('INVALID_ORIGINAL_SOURCE_EVIDENCE');
    }
    const effectiveSourceId = receiptTupleCurrent ? row.reviewedSourceArticleVersionId ?? null : row.sourceArticleVersionId;
    if (row.inputMode === 'ARTICLE_DERIVED' && (originalTupleCurrent || receiptTupleCurrent) && effectiveSourceId === current.sourceArticleVersionId) {
      const currentSource = current.sourceArticleVersionId ? await tx.articleVersion.findFirst({ where: { id: current.sourceArticleVersionId, projectId: project }, include: { claims: true } }) : null;
      if (!currentSource || !currentSource.approvedAt || currentSource.withdrawnAt || !(await this.articles.inspectVersion(tx, project, currentSource)).eligible) reasons.push('SOURCE_ARTICLE_NEEDS_REVIEW');
    }
    return [...new Set(reasons)];
  }
  private async state(tx: Prisma.TransactionClient, project: string, format: AdaptationFormat = 'TELEGRAM_POST') {
    const p = await tx.project.findUniqueOrThrow({ where: { id: project }, include: { workspace: true } });
    const adaptation = await tx.adaptation.findUnique({
      where: { projectId_format: { projectId: project, format } },
      include: { draft: true, revisions: { orderBy: { number: 'desc' }, include: {
        claims: { include: { evidence: { include: { claimRevision: true, snapshot: { include: { material: true } } } } } },
      } } },
    });
    const brief = await tx.brief.findUnique({ where: { projectId: project }, include: { currentRevision: { include: briefInclude }, revisions: { include: briefInclude, orderBy: { number: 'desc' } } } });
    const style = await tx.workspaceStyleRevision.findUniqueOrThrow({ where: { workspaceId_revision: { workspaceId: p.workspaceId, revision: p.workspace.styleRevision } } });
    const article = await tx.article.findUnique({ where: { projectId: project } });
    const approvedArticle = article?.currentApprovedVersionId ? await tx.articleVersion.findFirst({ where: { id: article.currentApprovedVersionId, projectId: project }, include: { claims: true } }) : null;
    const contentMode = adaptation?.draft?.contentMode ?? brief?.currentRevision?.contentMode ?? 'CREATIVE';
    const prerequisites = { sourceEvidenceRequired: contentMode === 'FACTUAL' };
    const draft = adaptation?.draft ? validateFormatContent(format, telegramContentSchema.parse(adaptation.draft.content)) : null;
    const inputs = adaptation?.draft;
    const detail = draft && inputs ? await this.evidenceDetail(tx, project, draft, inputs) : { issues: [], hasUnmapped: false };
    const sourceGrounded = !!inputs?.sourceEvidenceSetId || !!approvedArticle?.sourceEvidenceSetId
      || !!adaptation?.revisions.some(row => row.sourceEvidenceSetId);
    const selectedSet = inputs?.sourceEvidenceSetId && inputs.briefRevisionId ? { id: inputs.sourceEvidenceSetId,briefRevisionId: inputs.briefRevisionId }
      : adaptation?.revisions.find(row => row.sourceEvidenceSetId) ? { id: adaptation.revisions.find(row => row.sourceEvidenceSetId)!.sourceEvidenceSetId!,briefRevisionId: adaptation.revisions.find(row => row.sourceEvidenceSetId)!.briefRevisionId }
      : !inputs && approvedArticle?.sourceEvidenceSetId && approvedArticle.briefRevisionId ? { id: approvedArticle.sourceEvidenceSetId,briefRevisionId: approvedArticle.briefRevisionId } : null;
    const grounding = selectedSet ? await this.grounding.inspectSet(tx,project,selectedSet.id,selectedSet.briefRevisionId,false) : null;
    const sourceSnapshots = grounding ? await tx.sourceSnapshot.findMany({
      where: { projectId: project, id: { in: grounding.snapshots.map(row => row.snapshotId) } },
      select: { id: true, materialId: true, material: { select: { label: true } } },
    }) : [];
    const eligibleSourcePassages = grounding?.passages.map(row => ({ passageId: row.id,packetId: row.packetId,snapshotId: row.snapshotId,
      quote: row.quote,startOffset: row.startOffset,endOffset: row.endOffset,materialId: sourceSnapshots.find(snapshot => snapshot.id === row.snapshotId)!.materialId,
      materialTitle: sourceSnapshots.find(snapshot => snapshot.id === row.snapshotId)!.material.label })) ?? [];
    const staleReasons = inputs ? await this.stale(tx, project, inputs) : [];
    const sourceArticleIssues = approvedArticle ? await this.articles.inspectVersion(tx, project, approvedArticle) : null;
    const revisions = await Promise.all((adaptation?.revisions ?? []).map(async row => {
      const inspection = await this.inspectRevision(tx, project, row), content = validateFormatContent(format, telegramContentSchema.parse(row.content));
      const mappingDetails = await Promise.all(content.mappings.map(async mapping => {
        const evidence = await tx.claimEvidence.findFirst({ where: { id: mapping.evidenceId, claimRevisionId: mapping.claimRevisionId, projectId: project },
          include: { claimRevision: true, snapshot: { include: { material: true } } } });
      const target = (mapping.field ?? 'text') === 'cover' ? content.cover?.text ?? '' : content.text;
      return { ...mapping, field: mapping.field ?? 'text', linkedText: target.slice(mapping.startOffset, mapping.endOffset),
          evidence: evidence ? { wording: evidence.claimRevision.wording, quote: evidence.quote, snapshotId: evidence.snapshotId,
            materialTitle: evidence.snapshot.material.label } : null };
      }));
      return { ...json(row), status: row.withdrawnAt ? 'WITHDRAWN' : row.approvedAt ? 'APPROVED' : 'PROPOSED', mappingDetails, ...inspection };
    }));
    return { adaptation: adaptation ? { id: adaptation.id, revision: adaptation.revision, draft: json(adaptation.draft), currentApprovedRevisionId: adaptation.currentApprovedRevisionId,
      revisions } : null,
      format, formatSelected: p.formats.includes(format), telegramSelected: p.formats.includes('TELEGRAM_POST'), brief: brief ? { id: brief.id, revision: brief.revision, currentRevision: json(brief.currentRevision), history: json(brief.revisions) } : null,
      style: json(style), prerequisites, approvedArticle: approvedArticle ? { ...json(approvedArticle), inspection: json(sourceArticleIssues) } : null,
      eligibleSourcePassages,
      staleReasons, mappingIssues: detail.issues, hasUnmapped: detail.hasUnmapped, blockingReasons: [...(!sourceGrounded && contentMode === 'FACTUAL' ? ['SOURCE_EVIDENCE_REQUIRED'] : []), ...(detail.issues.length ? ['INVALID_EVIDENCE_MAPPINGS'] : [])] };
  }
  get(user: string, project: string, format: AdaptationFormat = 'TELEGRAM_POST') { return this.command(user, project, tx => this.state(tx, project, format), false); }

  // The caller holds the authorized Project transaction/lock. Export and editor
  // share this inspection so delivery cannot use weaker freshness rules.
  async inspectRevision(tx: Prisma.TransactionClient, project: string, row: AdaptationRevision) {
    const parent = await tx.adaptation.findUnique({ where: { id: row.adaptationId }, select: { format: true } });
    if (!parent) throw new ConflictException('Adaptation format is unavailable');
    const format = parent.format as AdaptationFormat;
    const staleReasons = await this.stale(tx, project, row), content = validateFormatContent(format, telegramContentSchema.parse(row.content));
    const reviewedBasis = row.reviewedAt ? row.reviewedBasisRevisionId : row.basisRevisionId;
    const reviewedSourceSet = row.reviewedAt ? row.reviewedSourceEvidenceSetId ?? row.sourceEvidenceSetId : row.sourceEvidenceSetId;
    const details = await this.evidenceDetail(tx, project, content, { ...row, basisRevisionId: reviewedBasis, sourceEvidenceSetId: reviewedSourceSet });
    const blockingReasons = details.issues.map(issue => issue.reason);
    if (row.projectId !== project || canonicalManifestHash(row.content) !== row.sha256) blockingReasons.push('CONTENT_INTEGRITY');
    if (!content.text.trim() || format !== 'TELEGRAM_POST' && format.includes('COVER') && !content.cover?.text.trim()) blockingReasons.push('EMPTY_CONTENT');
    if (format.includes('COVER') && !content.cover?.instruction.trim()) blockingReasons.push('COVER_INSTRUCTION_REQUIRED');
    if (!row.claimsSealed) blockingReasons.push('UNSEALED_EVIDENCE');
    if (row.withdrawnAt) blockingReasons.push('APPROVAL_WITHDRAWN');
    if (staleReasons.some(reason => ['INVALID_ORIGINAL_FACTUAL_BASIS', 'INVALID_ORIGINAL_SOURCE_ARTICLE', 'INVALID_ORIGINAL_SOURCE_EVIDENCE'].includes(reason))) blockingReasons.push('ORIGINAL_DEPENDENCY_BLOCKED');
    if (row.sourceEvidenceSetId) {
      if (!row.sourceEvidenceSealed || !await this.sourceCitationIntegrity(tx, project, row, content)) blockingReasons.push('SOURCE_CITATIONS_UNSEALED');
      if (row.contentMode !== 'FACTUAL' || !reviewedSourceSet) blockingReasons.push('SOURCE_EVIDENCE_MODE_INVALID');
    } else if (row.contentMode === 'FACTUAL') blockingReasons.push('SOURCE_EVIDENCE_REQUIRED');
    let sourceEvidence: Awaited<ReturnType<TelegramService['inspectSourceEvidence']>> = null;
    if (row.sourceEvidenceSetId) {
      try { sourceEvidence = await this.inspectSourceEvidence(tx, project, row); }
      catch { if (!blockingReasons.includes('SOURCE_CITATIONS_UNSEALED')) blockingReasons.push('SOURCE_CITATION_INTEGRITY'); }
    }
    return { staleReasons, blockingReasons: [...new Set(blockingReasons)], hasUnmapped: details.hasUnmapped, sourceEvidence,
      eligible: !!row.approvedAt && !row.withdrawnAt && !staleReasons.length && !blockingReasons.length };
  }

  private async writeDraft(tx: Prisma.TransactionClient, adaptationId: string, project: string, user: string, content: TelegramContent, inputs: Inputs, baseRevisionId: string | null, origin: 'MANUAL' | 'AI') {
    await this.evidenceDetail(tx, project, content, inputs, true);
    const data = { content: json(content), sha256: canonicalManifestHash(content), baseRevisionId, ...this.inputData(inputs), origin, updatedBy: user, updatedAt: new Date() };
    await tx.adaptationDraft.upsert({ where: { adaptationId }, create: { adaptationId, projectId: project, ...data }, update: data });
    const check = await tx.adaptationDraft.findUniqueOrThrow({ where: { adaptationId } });
    if (check.sha256 !== data.sha256) throw new ConflictException('Telegram draft update was not persisted');
    await tx.adaptation.update({ where: { id: adaptationId }, data: { revision: { increment: 1 } } });
  }
  private inputData(inputs: Inputs): Inputs {
    return { inputMode: inputs.inputMode, contentMode: inputs.contentMode, briefRevisionId: inputs.briefRevisionId,
      basisRevisionId: inputs.basisRevisionId, sourceEvidenceSetId: inputs.sourceEvidenceSetId, sourceArticleVersionId: inputs.sourceArticleVersionId,
      workspaceId: inputs.workspaceId, workspaceStyleRevision: inputs.workspaceStyleRevision, includeLink: inputs.includeLink };
  }
  private async sourceCitationIntegrity(tx: Prisma.TransactionClient, project: string, revision: AdaptationRevision, content: TelegramContent) {
    const mappings = content.sourceMappings ?? [];
    if (!revision.sourceEvidenceSetId) return !revision.sourceEvidenceSealed && mappings.length === 0;
    if (!revision.sourceEvidenceSealed || mappings.length === 0) return false;
    const rows = await tx.adaptationRevisionSourceCitation.findMany({ where: { projectId: project, revisionId: revision.id }, orderBy: { locator: 'asc' } });
    const expected = mappings.map(mapping => {
      const field = mapping.field ?? 'text', target = field === 'cover' ? content.cover?.text ?? '' : content.text;
      return { sourceEvidenceSetId: revision.sourceEvidenceSetId, packetId: mapping.packetId, spanId: mapping.passageId,
        locator: `${field}:${mapping.startOffset}:${mapping.endOffset}`, text: target.slice(mapping.startOffset, mapping.endOffset), quote: mapping.quote };
    }).sort((a,b) => a.locator.localeCompare(b.locator));
    const actual = rows.map(({ sourceEvidenceSetId, packetId, spanId, locator, text, quote }) => ({ sourceEvidenceSetId, packetId, spanId, locator, text, quote })).sort((a,b) => a.locator.localeCompare(b.locator));
    return rows.length === expected.length && canonicalManifestHash(actual) === canonicalManifestHash(expected);
  }
  /** Validated used-source view for editor/export consumers. */
  async inspectSourceEvidence(tx: Prisma.TransactionClient, project: string, revision: AdaptationRevision) {
    if (!revision.sourceEvidenceSetId || !revision.briefRevisionId) return null;
    const grounding = await this.grounding.inspectSet(tx, project, revision.sourceEvidenceSetId, revision.briefRevisionId, false);
    const content = validateFormatContent((await tx.adaptation.findUniqueOrThrow({ where: { id: revision.adaptationId }, select: { format: true } })).format as AdaptationFormat,
      telegramContentSchema.parse(revision.content));
    if (!await this.sourceCitationIntegrity(tx, project, revision, content)) throw new ConflictException('Telegram source citations failed integrity checks');
    const rows = await tx.adaptationRevisionSourceCitation.findMany({ where: { projectId: project, revisionId: revision.id }, orderBy: { locator: 'asc' } });
    return { sourceEvidenceSetId: grounding.id, sourceEvidenceSetHash: grounding.sha256, passages: rows.map(row => {
      const passage = grounding.passages.find(item => item.id === row.spanId && item.packetId === row.packetId);
      if (!passage) throw new ConflictException('Telegram citation is outside its frozen source set');
      return { passageId: row.spanId, packetId: row.packetId, snapshotId: passage.snapshotId, sourceQuote: passage.quote,
        field: row.locator.startsWith('cover:') ? 'cover' : 'text', locator: row.locator, text: row.text, quote: row.quote };
    }) };
  }
  saveDraft(user: string, project: string, raw: SaveTelegramDraftInput) {
    const input = raw;
    return this.command(user, project, async tx => {
      const format = input.format ?? 'TELEGRAM_POST';
      const includeLink = input.includeLink ?? false;
      const adaptation = await this.adaptation(tx, project, input.expectedRevision, format);
      const sameShape = adaptation.draft && adaptation.draft.inputMode === input.inputMode && adaptation.draft.contentMode === input.contentMode;
      const preservingTuple = !!(sameShape && !input.refreshInputs);
      let inputs = preservingTuple ? adaptation.draft! : await this.currentInputs(tx, project, input.inputMode, input.contentMode, includeLink);
      if (!preservingTuple && sameShape && adaptation.draft?.sourceEvidenceSetId && !inputs.sourceEvidenceSetId) {
        inputs = { ...inputs, sourceEvidenceSetId: adaptation.draft.sourceEvidenceSetId, basisRevisionId: null };
      }
      if (inputs.inputMode !== input.inputMode || inputs.contentMode !== input.contentMode) throw new BadRequestException('Telegram input shape mismatch');
      // Include-link is a draft choice and may be changed without recapturing provenance.
      if (format !== 'TELEGRAM_POST' && includeLink) throw new BadRequestException('Links are supported only for Telegram posts');
      const selectedInputs = { ...inputs, includeLink: format === 'TELEGRAM_POST' && includeLink };
      if (preservingTuple) await this.validateSavedAncestry(tx, project, selectedInputs);
      else await this.validateInputs(tx, project, selectedInputs);
      let content: TelegramContent;
      try { content = validateFormatContent(format, telegramContentSchema.parse(input.content)); } catch { throw new BadRequestException('Adaptation content does not match the selected format'); }
      await this.writeDraft(tx, adaptation.id, project, user, content, selectedInputs, sameShape ? adaptation.draft?.baseRevisionId ?? null : null, 'MANUAL');
      return this.state(tx, project, format);
    });
  }
  private sameInputs(a: Inputs, b: Inputs) { return ['inputMode', 'contentMode', 'briefRevisionId', 'basisRevisionId', 'sourceEvidenceSetId', 'sourceArticleVersionId', 'workspaceId', 'workspaceStyleRevision', 'includeLink'].every(k => a[k as keyof Inputs] === b[k as keyof Inputs]); }
  private async append(tx: Prisma.TransactionClient, project: string, adaptationId: string, user: string, content: TelegramContent, inputs: Inputs, sourceAdaptationRevision: number, jobId?: string, executionId?: string) {
    const latest = await tx.adaptationRevision.findFirst({ where: { adaptationId }, orderBy: { number: 'desc' } });
    const provenance = this.inputData(inputs);
    const version = await tx.adaptationRevision.create({ data: { id: randomUUID(), adaptationId, projectId: project, number: (latest?.number ?? 0) + 1,
      content: json(content), sha256: canonicalManifestHash(content), ...provenance, sourceAdaptationRevision, origin: jobId ? 'AI' : 'MANUAL', createdBy: user,
      ...(jobId ? { jobId } : {}), ...(executionId ? { aiExecutionId: executionId } : {}) } });
    if (content.mappings.length) await tx.adaptationRevisionClaim.createMany({ data: content.mappings.map(mapping => ({ projectId: project, revisionId: version.id,
      locator: `${mapping.field ?? 'text'}:${mapping.startOffset}:${mapping.endOffset}`, claimRevisionId: mapping.claimRevisionId, evidenceId: mapping.evidenceId,
      quote: mapping.quote, linkedText: ((mapping.field ?? 'text') === 'cover' ? content.cover?.text ?? '' : content.text).slice(mapping.startOffset, mapping.endOffset) })) });
    if (inputs.sourceEvidenceSetId && content.sourceMappings?.length) await tx.adaptationRevisionSourceCitation.createMany({ data: content.sourceMappings.map(mapping => {
      const field = mapping.field ?? 'text', target = field === 'cover' ? content.cover?.text ?? '' : content.text;
      return { projectId: project, revisionId: version.id, sourceEvidenceSetId: inputs.sourceEvidenceSetId!, packetId: mapping.packetId, spanId: mapping.passageId,
        locator: `${field}:${mapping.startOffset}:${mapping.endOffset}`, text: target.slice(mapping.startOffset, mapping.endOffset), quote: mapping.quote };
    }) });
    await tx.adaptationRevision.update({ where: { id: version.id }, data: { claimsSealed: true, ...(inputs.sourceEvidenceSetId ? { sourceEvidenceSealed: true } : {}) } });
    return version;
  }
  /** Append a source-grounded, unapproved candidate without replacing the working draft or approval pointer. */
  async appendSourceCandidate(tx: Prisma.TransactionClient, user: string, project: string, format: AdaptationFormat, content: TelegramContent,
    sourceInputs: SourceAdaptationInputs, expectedRevision: number, jobId?: string, executionId?: string): Promise<{ adaptationRevisionId: string }> {
    await this.lock(tx, user, project);
    if (sourceInputs.contentMode !== 'FACTUAL' || !sourceInputs.sourceEvidenceSetId || sourceInputs.basisRevisionId !== null
      || sourceInputs.workspaceId !== (await tx.project.findUniqueOrThrow({ where: { id: project }, select: { workspaceId: true } })).workspaceId) {
      throw new ConflictException('Source-grounded Telegram requires a factual source set and matching Project inputs');
    }
    const adaptation = await this.adaptation(tx, project, expectedRevision, format);
    await this.validateInputs(tx, project, sourceInputs);
    let parsed: TelegramContent;
    try { parsed = validateFormatContent(format, telegramContentSchema.parse(content)); }
    catch { throw new ConflictException('Source-grounded channel content does not match its selected format'); }
    const detail = await this.evidenceDetail(tx, project, parsed, sourceInputs);
    const brief = await tx.briefRevision.findFirstOrThrow({ where: { id: sourceInputs.briefRevisionId, projectId: project }, include: briefInclude });
    if (brief.requiredClaims.length) throw new ConflictException('REQUIRED_CLAIMS_RETIRED');
    if (!parsed.text.trim() || !parsed.sourceMappings?.length || detail.issues.length
      || format.includes('COVER') && (!parsed.cover?.text.trim() || !parsed.cover.instruction.trim())) {
      throw new ConflictException('Source-grounded channel candidate needs cited source passages');
    }
    const version = await this.append(tx, project, adaptation.id, user, parsed, sourceInputs, adaptation.revision, jobId, executionId);
    return { adaptationRevisionId: version.id };
  }
  checkpoint(user: string, project: string, input: { expectedRevision: number; format?: AdaptationFormat }) {
    return this.command(user, project, async tx => {
      const format = input.format ?? 'TELEGRAM_POST';
      const adaptation = await this.adaptation(tx, project, input.expectedRevision, format, false), draft = adaptation.draft;
      if (!draft) throw new ConflictException('Save the adaptation draft first');
      const base = draft.baseRevisionId ? await tx.adaptationRevision.findUnique({ where: { id: draft.baseRevisionId } }) : null;
      if (base && !base.withdrawnAt && base.sha256 === draft.sha256 && this.sameInputs(base, draft)) return this.state(tx, project, format);
      const version = await this.append(tx, project, adaptation.id, user, validateFormatContent(format, telegramContentSchema.parse(draft.content)), draft, adaptation.revision);
      await tx.adaptationDraft.update({ where: { adaptationId: adaptation.id }, data: { baseRevisionId: version.id, origin: 'MANUAL', updatedBy: user, updatedAt: new Date() } });
      await tx.adaptation.update({ where: { id: adaptation.id }, data: { revision: { increment: 1 } } });
      return this.state(tx, project, format);
    });
  }
  private async reviewable(tx: Prisma.TransactionClient, project: string, version: AdaptationRevision, reReview = false) {
    if (!reReview) {
      const stale = await this.stale(tx, project, version);
      if (stale.length) throw new ConflictException('Telegram inputs need review against the current Brief, basis and source');
      await this.validateInputs(tx, project, version);
    } else {
      if (version.contentMode === 'FACTUAL' && version.sourceEvidenceSetId) {
        try { await this.grounding.inspectSet(tx, project, version.sourceEvidenceSetId, version.briefRevisionId, true); }
        catch { throw new ConflictException('Original Telegram source evidence is no longer valid'); }
      } else if (version.contentMode === 'FACTUAL' && (!version.basisRevisionId || !(await this.facts.inspectBasisRevision(tx, project, version.basisRevisionId)).valid)) throw new ConflictException('Original Telegram factual basis is no longer valid');
      if (version.inputMode === 'ARTICLE_DERIVED') {
        const original = version.sourceArticleVersionId ? await tx.articleVersion.findFirst({ where: { id: version.sourceArticleVersionId, projectId: project }, include: { claims: true } }) : null;
        if (!original || !original.approvedAt || original.withdrawnAt || (await this.articles.inspectVersion(tx, project, original)).blockingReasons.length) throw new ConflictException('Original source article approval or evidence is no longer valid');
      }
    }
    const parent = await tx.adaptation.findUnique({ where: { id: version.adaptationId }, select: { format: true } });
    if (!parent) throw new ConflictException('Adaptation format is unavailable');
    const format = parent.format as AdaptationFormat;
    const content = validateFormatContent(format, telegramContentSchema.parse(version.content));
    const currentInputs = reReview ? await this.currentInputs(tx, project, version.inputMode, version.contentMode, version.includeLink) : version;
    const effectiveInputs = reReview && version.sourceEvidenceSetId ? { ...currentInputs, sourceEvidenceSetId: version.sourceEvidenceSetId, basisRevisionId: null } : currentInputs;
    if (reReview) await this.validateInputs(tx, project, effectiveInputs);
    const details = await this.evidenceDetail(tx, project, content, { ...version, basisRevisionId: effectiveInputs.basisRevisionId, sourceEvidenceSetId: effectiveInputs.sourceEvidenceSetId });
    if (!content.text.trim() || format.includes('COVER') && (!content.cover?.text.trim() || !content.cover.instruction.trim())) throw new ConflictException('Publication and cover instruction are required');
    if (details.issues.length) throw new ConflictException('Relink or remove invalid Telegram evidence mappings');
    if (version.sourceEvidenceSetId && !await this.sourceCitationIntegrity(tx, project, version, content)) throw new ConflictException('Telegram source citations are not sealed to the saved content');
    return details;
  }
  review(user: string, project: string, revisionId: string, action: 'apply' | 'approve' | 'withdraw', input: ReviewTelegramInput) {
    return this.command(user, project, async tx => {
      const format = input.format ?? 'TELEGRAM_POST';
      const adaptation = await this.adaptation(tx, project, input.expectedRevision, format);
      const version = await tx.adaptationRevision.findFirst({ where: { id: revisionId, projectId: project, adaptationId: adaptation.id } });
      if (!version) throw new NotFoundException('Adaptation revision not found');
      if (version.withdrawnAt) throw new ConflictException('Adaptation withdrawal is terminal');
      if (canonicalManifestHash(version.content) !== version.sha256) throw new ConflictException('Adaptation revision integrity check failed');
      if (action === 'withdraw') {
        if (!version.approvedAt) throw new ConflictException('Only an approved Telegram revision can be withdrawn');
        await tx.adaptationRevision.update({ where: { id: version.id }, data: { withdrawnBy: user, withdrawnAt: new Date(), withdrawalReason: input.reason ?? null } });
        await tx.adaptation.update({ where: { id: adaptation.id }, data: { revision: { increment: 1 }, ...(adaptation.currentApprovedRevisionId === version.id ? { currentApprovedRevisionId: null } : {}) } });
      } else if (action === 'apply') {
        if (version.origin === 'AI' && version.sourceAdaptationRevision !== adaptation.revision) throw new ConflictException('Telegram changed after generation; preserve local work');
        await this.reviewable(tx, project, version);
        await this.writeDraft(tx, adaptation.id, project, user, validateFormatContent(format, telegramContentSchema.parse(version.content)), version, version.id, 'MANUAL');
      } else {
        const draft = adaptation.draft;
        if (input.expectedReviewCounter === undefined || input.expectedReviewCounter !== version.reviewCounter) throw new ConflictException('Telegram review counter is required and must match');
        if (version.approvedAt || !draft || draft.baseRevisionId !== version.id || draft.sha256 !== version.sha256 || !this.sameInputs(draft, version)) throw new ConflictException('Approve only the exact current saved Telegram checkpoint');
        const details = await this.reviewable(tx, project, version);
        await tx.adaptationRevision.update({ where: { id: version.id }, data: { approvedBy: user, approvedAt: new Date(), acknowledgedUnmapped: details.hasUnmapped && input.acknowledgeUnmapped === true,
        } });
        await tx.adaptation.update({ where: { id: adaptation.id }, data: { currentApprovedRevisionId: version.id, revision: { increment: 1 } } });
      }
      return this.state(tx, project, format);
    });
  }
  rereview(user: string, project: string, revisionId: string, input: ReviewTelegramInput & { expectedReviewCounter: number }) {
    return this.command(user, project, async tx => {
      const format = input.format ?? 'TELEGRAM_POST';
      const adaptation = await this.adaptation(tx, project, input.expectedRevision, format, false);
      const version = await tx.adaptationRevision.findFirst({ where: { id: revisionId, projectId: project, adaptationId: adaptation.id } });
      if (!version) throw new NotFoundException('Telegram revision not found');
      if (adaptation.currentApprovedRevisionId !== version.id || !version.approvedAt || version.withdrawnAt || version.reviewCounter !== input.expectedReviewCounter) throw new ConflictException('Re-review only the current active approval with its exact review counter');
      if (canonicalManifestHash(version.content) !== version.sha256) throw new ConflictException('Telegram revision integrity check failed');
      await this.reviewable(tx, project, version, true);
      const current = await this.currentInputs(tx, project, version.inputMode, version.contentMode, version.includeLink);
      await tx.adaptationRevision.update({ where: { id: version.id }, data: { reviewCounter: { increment: 1 },
        reviewedBriefRevisionId: current.briefRevisionId, reviewedBasisRevisionId: version.sourceEvidenceSetId ? null : current.basisRevisionId,
        reviewedSourceEvidenceSetId: version.sourceEvidenceSetId,
        reviewedSourceArticleVersionId: current.sourceArticleVersionId, reviewedWorkspaceStyleRevision: current.workspaceStyleRevision,
        reviewedBy: user, reviewedAt: new Date() } });
      await tx.adaptation.update({ where: { id: adaptation.id }, data: { revision: { increment: 1 } } });
      return this.state(tx, project, format);
    });
  }
  async freezeTelegram(user: string, project: string, input: GenerateTelegramInput, releaseInput: TelegramWorkflowRelease) {
    const release = telegramWorkflowReleaseSchema.parse(releaseInput);
    return this.command(user, project, async tx => {
      await this.jobs.assertEffects(tx, project, user);
      const p = await tx.project.findUniqueOrThrow({ where: { id: project, archivedAt: null, trashedAt: null }, include: { workspace: true } });
      const format = input.format ?? 'TELEGRAM_POST';
      if (!p.formats.includes(format)) throw new ConflictException(`Select ${format} before generation`);
      const includeLink = input.includeLink ?? false;
      if (format !== 'TELEGRAM_POST' && includeLink) throw new BadRequestException('Links are supported only for Telegram posts');
      const adaptation = await this.adaptation(tx, project, input.expectedRevision, format);
      const current = await this.currentInputs(tx, project, input.inputMode, input.contentMode, format === 'TELEGRAM_POST' && includeLink);
      if (!current.briefRevisionId || current.inputMode !== input.inputMode || current.contentMode !== input.contentMode) throw new ConflictException('Save a matching Brief and source tuple before generation');
      if (current.contentMode === 'FACTUAL') throw new ConflictException('Factual channel generation must use source preparation');
      if (current.sourceEvidenceSetId) throw new ConflictException('Source-grounded channel generation must use the source-writing coordinator');
      await this.validateInputs(tx, project, current);
      const brief = await tx.briefRevision.findFirstOrThrow({ where: { id: current.briefRevisionId, projectId: project }, include: briefInclude });
      const source = current.sourceArticleVersionId ? await tx.articleVersion.findFirstOrThrow({ where: { id: current.sourceArticleVersionId, projectId: project } }) : null;
      const profile = await tx.userProfile.findUniqueOrThrow({ where: { id: user } });
      const manifest = telegramInputManifestSchema.parse({ schemaVersion: 'adaptation-input-v1', format, adaptationRevision: adaptation.revision,
        inputMode: current.inputMode, contentMode: current.contentMode, includeLink: current.includeLink, briefRevisionId: brief.id, briefHash: brief.sha256,
        basisRevisionId: null, basisHash: null, sourceArticleVersionId: source?.id ?? null, sourceArticleHash: source?.sha256 ?? null,
        workspaceId: p.workspaceId, workspaceStyleRevision: p.workspace.styleRevision, contextSnapshotIds: brief.contextSnapshots.map(row => row.snapshotId).sort(),
        release, noticeVersion: EXTERNAL_PROCESSING_NOTICE.version, acceptedAt: profile.externalProcessingAcceptedAt?.toISOString() });
      return this.jobs.create(tx, { projectId: project, userId: user, operation: 'TELEGRAM_GENERATION', contractVersion: 'adaptation-v1', commandKey: input.commandKey,
        inputManifest: manifest, deadlineMs: TELEGRAM_GENERATION_DEADLINE_MS });
    });
  }
  async frozenContext(tx: Prisma.TransactionClient, project: string, manifestInput: TelegramInputManifest) {
    const manifest = telegramInputManifestSchema.parse(manifestInput);
    const projectRow = await tx.project.findFirst({ where: { id: project, archivedAt: null, trashedAt: null }, select: { id: true, workspaceId: true, formats: true } });
    const brief = await tx.briefRevision.findFirst({ where: { id: manifest.briefRevisionId, projectId: project }, include: briefInclude });
    if (!projectRow || !projectRow.formats.includes(manifest.format) || projectRow.workspaceId !== manifest.workspaceId || !brief || canonicalBriefHash(brief) !== manifest.briefHash || brief.sha256 !== manifest.briefHash || brief.contentMode !== manifest.contentMode
      || brief.workspaceId !== manifest.workspaceId
      || canonicalManifestHash(brief.contextSnapshots.map(row => row.snapshotId).sort()) !== canonicalManifestHash([...manifest.contextSnapshotIds].sort())) throw new JobFailure('INVALID_CONTRACT', 'KNOWN_SUCCEEDED');
    if (manifest.contentMode === 'FACTUAL') {
      const basis = await this.facts.inspectBasisRevision(tx, project, manifest.basisRevisionId!);
      if (!basis.valid || basis.sha256 !== manifest.basisHash) throw new JobFailure('INVALID_CONTRACT', 'KNOWN_SUCCEEDED');
    }
    if (manifest.inputMode === 'ARTICLE_DERIVED') {
      const source = await tx.articleVersion.findFirst({ where: { id: manifest.sourceArticleVersionId!, projectId: project }, include: { claims: true } });
      if (!source || source.sha256 !== manifest.sourceArticleHash || canonicalManifestHash(source.content) !== source.sha256 || source.contentMode !== manifest.contentMode || !source.approvedAt || source.withdrawnAt) throw new JobFailure('INVALID_CONTRACT', 'KNOWN_SUCCEEDED');
      const inspection = await this.articles.inspectVersion(tx, project, source);
      if (inspection.blockingReasons.length) throw new JobFailure('INVALID_CONTRACT', 'KNOWN_SUCCEEDED');
    }
    return { format: manifest.format, brief: json(brief), basis: manifest.basisRevisionId ? await this.facts.inspectBasisRevision(tx, project, manifest.basisRevisionId) : null,
      sourceArticle: manifest.sourceArticleVersionId ? json(await tx.articleVersion.findFirstOrThrow({ where: { id: manifest.sourceArticleVersionId, projectId: project }, include: { claims: true } })) : null,
      style: json(await tx.workspaceStyleRevision.findUniqueOrThrow({ where: { workspaceId_revision: { workspaceId: manifest.workspaceId, revision: manifest.workspaceStyleRevision } } })) };
  }
  async commitGenerated(tx: Prisma.TransactionClient, job: Job, raw: unknown, executionId: string) {
    await this.lock(tx, job.requestedBy, job.projectId);
    const parsed = telegramContentSchema.safeParse(raw), m = telegramInputManifestSchema.safeParse(job.inputManifest);
    if (!parsed.success || !m.success || job.operation !== 'TELEGRAM_GENERATION' || job.contractVersion !== 'adaptation-v1') throw new JobFailure('INVALID_CONTRACT', 'KNOWN_SUCCEEDED');
    const frozen = m.data;
    let content: TelegramContent;
    try { content = validateFormatContent(frozen.format, parsed.data); } catch { throw new JobFailure('INVALID_CONTRACT', 'KNOWN_SUCCEEDED'); }
    await this.frozenContext(tx, job.projectId, frozen);
    const execution = await tx.aIExecution.findFirst({ where: { id: executionId, projectId: job.projectId, jobId: job.id } });
    if (!execution || execution.contractVersion !== 'adaptation-v1' || execution.workflowId !== frozen.release.workflowId || execution.releaseId !== frozen.release.releaseId
      || execution.configDigest !== frozen.release.configDigest || execution.promptTemplateVersion !== frozen.release.promptTemplateVersion
      || execution.inputHash !== job.inputHash || canonicalManifestHash({ contractVersion: job.contractVersion, inputManifest: job.inputManifest }) !== job.inputHash
      || canonicalManifestHash(execution.inputManifest) !== canonicalManifestHash(job.inputManifest)) throw new JobFailure('INVALID_CONTRACT', 'KNOWN_SUCCEEDED');
    if (frozen.contentMode === 'FACTUAL') throw new JobFailure('INVALID_CONTRACT', 'KNOWN_SUCCEEDED');
    const adaptation = await tx.adaptation.findUnique({ where: { projectId_format: { projectId: job.projectId, format: frozen.format } } });
    if (!adaptation) throw new JobFailure('INVALID_CONTRACT', 'KNOWN_SUCCEEDED');
    const inputs: Inputs = { inputMode: frozen.inputMode, contentMode: frozen.contentMode, briefRevisionId: frozen.briefRevisionId, basisRevisionId: frozen.basisRevisionId, sourceEvidenceSetId: null,
      sourceArticleVersionId: frozen.sourceArticleVersionId, workspaceId: frozen.workspaceId, workspaceStyleRevision: frozen.workspaceStyleRevision, includeLink: frozen.includeLink };
    const details = await this.evidenceDetail(tx, job.projectId, content, inputs);
    const brief = await tx.briefRevision.findFirstOrThrow({ where: { id: frozen.briefRevisionId, projectId: job.projectId }, include: briefInclude });
    if (!content.text.trim() || frozen.format.includes('COVER') && (!content.cover?.text.trim() || !content.cover.instruction.trim()) || details.issues.length || brief.requiredClaims.length) throw new JobFailure('INVALID_CONTRACT', 'KNOWN_SUCCEEDED');
    const version = await this.append(tx, job.projectId, adaptation.id, job.requestedBy, content, inputs, frozen.adaptationRevision, job.id, executionId);
    return { adaptationRevisionId: version.id };
  }
}
