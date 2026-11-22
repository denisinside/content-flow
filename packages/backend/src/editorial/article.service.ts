import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { z } from 'zod';
import type { Prisma, PrismaClient, Job, ArticleDraft, ArticleVersion, ArticleOrigin, ContentMode } from '../generated/prisma/client.js';
import { FactualBasisService } from '../claims/factual-basis.service.js';
import { SourceGroundingService } from '../evidence/source-grounding.service.js';
import { DurableJobService, canonicalManifestHash } from '../jobs/job-service.js';
import { JobFailure } from '../jobs/contracts.js';
import { EXTERNAL_PROCESSING_NOTICE } from '../external-processing-notice.js';
import { canonicalBriefHash } from './editorial.service.js';
import { articleContentSchema, articleDocumentDetails, articleInputManifestSchema, articleWorkflowReleaseSchema, type ArticleContent, type ArticleWorkflowRelease,
  type saveArticleDraftInput, type importArticleInput, type reviewArticleInput } from './article-contracts.js';

function json<T>(value: T): T { return JSON.parse(JSON.stringify(value)) as T; }
type Inputs = Pick<ArticleDraft, 'briefRevisionId' | 'basisRevisionId' | 'sourceEvidenceSetId' | 'outlineRevisionId' | 'workspaceId' | 'workspaceStyleRevision' | 'sourceSnapshotId' | 'contentMode' | 'origin'>;
type ArticleMappingDetails = ReturnType<typeof articleDocumentDetails> & { issues: { locator: string; claimRevisionId?: string; evidenceId?: string; passageId?: string; reason: string }[] };
export type SourceArticleInputs = Pick<Inputs, 'briefRevisionId' | 'basisRevisionId' | 'sourceEvidenceSetId' | 'outlineRevisionId' | 'workspaceId' | 'workspaceStyleRevision' | 'sourceSnapshotId' | 'contentMode' | 'origin'>;
export type FrozenGoogleArticleInputs = {
  sourceVersionId: string | null;
  expectedArticleRevision: number;
  contentMode: ContentMode;
  origin: ArticleOrigin;
  briefRevisionId: string | null;
  basisRevisionId: string | null;
  sourceEvidenceSetId: string | null;
  outlineRevisionId: string | null;
  workspaceId: string;
  workspaceStyleRevision: number;
  sourceSnapshotId: string | null;
};
function inputData(value: Inputs): Inputs { return { briefRevisionId: value.briefRevisionId, basisRevisionId: value.basisRevisionId, sourceEvidenceSetId: value.sourceEvidenceSetId, outlineRevisionId: value.outlineRevisionId, workspaceId: value.workspaceId, workspaceStyleRevision: value.workspaceStyleRevision, sourceSnapshotId: value.sourceSnapshotId, contentMode: value.contentMode, origin: value.origin }; }
const briefInclude = { requiredClaims: true, contextSnapshots: true, style: true } as const;
// Up to 30 sections with bounded author/reviewer passes run in the worker.
export const ARTICLE_GENERATION_DEADLINE_MS = 3_600_000;
export class ArticleService {
  private readonly grounding: SourceGroundingService;
  constructor(readonly prisma: PrismaClient, private readonly jobs: DurableJobService, private readonly facts: FactualBasisService) {
    this.grounding = new SourceGroundingService();
  }
  private async lock(tx: Prisma.TransactionClient, user: string, project: string, write = true) {
    const rows = write ? await tx.$queryRaw<{ id: string }[]>`SELECT p."id" FROM contextflow."Project" p JOIN contextflow."Workspace" w ON w."id"=p."workspaceId" JOIN contextflow."WorkspaceMember" m ON m."workspaceId"=w."id" WHERE p."id"=${project}::uuid AND p."archivedAt" IS NULL AND p."trashedAt" IS NULL AND w."archivedAt" IS NULL AND w."trashedAt" IS NULL AND m."userId"=${user}::uuid AND m."leftAt" IS NULL FOR UPDATE OF p FOR SHARE OF w,m`
      : await tx.$queryRaw<{ id: string }[]>`SELECT p."id" FROM contextflow."Project" p JOIN contextflow."Workspace" w ON w."id"=p."workspaceId" JOIN contextflow."WorkspaceMember" m ON m."workspaceId"=w."id" WHERE p."id"=${project}::uuid AND p."archivedAt" IS NULL AND p."trashedAt" IS NULL AND w."archivedAt" IS NULL AND w."trashedAt" IS NULL AND m."userId"=${user}::uuid AND m."leftAt" IS NULL FOR SHARE OF p,w,m`;
    if (!rows.length) throw new NotFoundException('Project not found');
  }
  private command<T>(user: string, project: string, action: (tx: Prisma.TransactionClient) => Promise<T>, write = true, options?: { maxWait: number; timeout: number }) {
    return this.prisma.$transaction(async tx => { await this.lock(tx, user, project, write); return action(tx); }, options);
  }
  private async article(tx: Prisma.TransactionClient, project: string, expected: number, create = true) {
    const p = await tx.project.findUniqueOrThrow({ where: { id: project } });
    if (!p.formats.includes('ARTICLE')) throw new ConflictException('Select Article before working on an article');
    const current = await tx.article.findUnique({ where: { projectId: project }, include: { draft: true } });
    if ((current?.revision ?? 0) !== expected) throw new ConflictException('Article changed; retain local text and reload before saving');
    if (!current && !create) throw new NotFoundException('Article not found');
    return current ?? { ...await tx.article.create({ data: { projectId: project } }), draft: null };
  }
  private async currentInputs(tx: Prisma.TransactionClient, project: string, mode: 'FACTUAL' | 'CREATIVE', origin: Inputs['origin'], sourceSnapshotId: string | null = null): Promise<Inputs> {
    const p = await tx.project.findUniqueOrThrow({ where: { id: project }, include: { workspace: true } });
    const brief = await tx.brief.findUnique({ where: { projectId: project }, include: { currentRevision: true } });
    const outline = await tx.outline.findUnique({ where: { projectId: project }, include: { currentRevision: true } });
    const currentBrief = brief?.currentRevision?.contentMode === mode ? brief.currentRevision : null;
    const currentOutline = currentBrief && outline?.currentRevision?.briefRevisionId === currentBrief.id && outline.currentRevision.approvedAt && !outline.currentRevision.withdrawnAt ? outline.currentRevision : null;
    const sourceEvidenceSetId = mode === 'FACTUAL' && currentOutline?.sourceEvidenceSealed ? currentOutline.sourceEvidenceSetId : null;
    return { contentMode: mode, origin, briefRevisionId: currentBrief?.id ?? null, basisRevisionId: null, sourceEvidenceSetId,
      outlineRevisionId: currentOutline?.id ?? null,
      workspaceId: p.workspaceId, workspaceStyleRevision: p.workspace.styleRevision, sourceSnapshotId };
  }
  private async mappings(tx: Prisma.TransactionClient, project: string, content: ArticleContent, inputs: Inputs, ancestryOnly = false) {
    const details = articleDocumentDetails(content), issues: { locator: string; claimRevisionId?: string; evidenceId?: string; passageId?: string; reason: string }[] = [];
    const grounding = inputs.sourceEvidenceSetId && inputs.briefRevisionId
      ? await this.grounding.inspectSet(tx, project, inputs.sourceEvidenceSetId, inputs.briefRevisionId, false) : null;
    for (const mapping of details.mappings) {
      const evidence = await tx.claimEvidence.findFirst({ where: { id: mapping.evidenceId, claimRevisionId: mapping.claimRevisionId, projectId: project } });
      if (!evidence) throw new BadRequestException('Article evidence must belong to its exact claim and project');
      let reason = inputs.contentMode === 'CREATIVE' ? 'CREATIVE_MAPPING' : !grounding && mapping.text !== mapping.quote ? 'WORDING_CHANGED' : null;
      if (!ancestryOnly) {
        const requiredClaim = grounding?.requiredClaims.find(claim => claim.claimRevisionId === mapping.claimRevisionId);
        const requiredEvidence = requiredClaim?.evidence.some(row => row.evidenceId === mapping.evidenceId && row.quote === mapping.quote) ?? false;
        const edge = !grounding && inputs.basisRevisionId ? await tx.basisClaimEvidence.findFirst({ where: { projectId: project, basisId: inputs.basisRevisionId, claimRevisionId: mapping.claimRevisionId, evidenceId: mapping.evidenceId } }) : null;
        if (!reason && (grounding ? !requiredEvidence : !edge)) reason = grounding ? 'OUTSIDE_REQUIRED_CLAIMS' : 'OUTSIDE_BASIS';
        if (!reason && (evidence.invalidatedAt || evidence.relation !== 'SUPPORTS')) reason = 'INVALID_EVIDENCE';
      }
      if (reason) issues.push({ locator: mapping.locator, claimRevisionId: mapping.claimRevisionId, evidenceId: mapping.evidenceId, reason });
    }
    for (const mapping of details.sourceMappings) {
      const passage = grounding?.passages.find(item => item.id === mapping.passageId && item.packetId === mapping.packetId);
      if (inputs.contentMode !== 'FACTUAL' || !passage || !passage.quote.includes(mapping.quote) || !mapping.text.trim()) {
        issues.push({ locator: mapping.locator, passageId: mapping.passageId, reason: inputs.contentMode !== 'FACTUAL' ? 'CREATIVE_SOURCE_MAPPING' : grounding ? 'INVALID_SOURCE_PASSAGE' : 'MISSING_SOURCE_EVIDENCE_SET' });
      }
    }
    return { ...details, issues };
  }
  private async stale(tx: Prisma.TransactionClient, project: string, inputs: Inputs) {
    const current = await this.currentInputs(tx, project, inputs.contentMode, inputs.origin, inputs.sourceSnapshotId), reasons: string[] = [];
    if (current.workspaceStyleRevision !== inputs.workspaceStyleRevision) reasons.push('WORKSPACE_STYLE_CHANGED');
    if (current.briefRevisionId !== inputs.briefRevisionId) reasons.push('BRIEF_CHANGED');
    if (inputs.contentMode === 'FACTUAL' && inputs.sourceEvidenceSetId) {
      if (!inputs.briefRevisionId) reasons.push('MISSING_SOURCE_BRIEF');
      else {
        try { await this.grounding.inspectSet(tx, project, inputs.sourceEvidenceSetId, inputs.briefRevisionId, true); }
        catch { reasons.push('INVALID_SOURCE_EVIDENCE_SET'); }
      }
    } else if (inputs.contentMode === 'FACTUAL') {
      reasons.push('SOURCE_EVIDENCE_REQUIRED');
    }
    if (inputs.outlineRevisionId && current.outlineRevisionId !== inputs.outlineRevisionId) reasons.push('OUTLINE_CHANGED');
    return reasons;
  }
  private async sourceCitationIntegrity(tx: Prisma.TransactionClient, project: string, version: ArticleVersion, detail: ArticleMappingDetails) {
    if (!version.sourceEvidenceSetId) return !version.sourceEvidenceSealed && !detail.sourceMappings.length;
    if (!version.sourceEvidenceSealed || !detail.sourceMappings.length) return false;
    const citations = await tx.articleVersionSourceCitation.findMany({ where: { projectId: project, articleVersionId: version.id }, orderBy: { locator: 'asc' } });
    const expected = detail.sourceMappings.map(({ passageId, packetId, quote, text, locator }) => ({ spanId: passageId, packetId, quote, text, locator })).sort((a,b) => a.locator.localeCompare(b.locator));
    const actual = citations.map(({ spanId, packetId, quote, text, locator }) => ({ spanId, packetId, quote, text, locator })).sort((a,b) => a.locator.localeCompare(b.locator));
    return citations.length === expected.length && citations.every(row => row.sourceEvidenceSetId === version.sourceEvidenceSetId)
      && canonicalManifestHash(actual) === canonicalManifestHash(expected);
  }
  /** Read-only export boundary: returns validated selected-set passages and their exact article locators. */
  async inspectSourceEvidence(tx: Prisma.TransactionClient, project: string, version: ArticleVersion) {
    if (!version.sourceEvidenceSetId || !version.briefRevisionId) return null;
    const grounding = await this.grounding.inspectSet(tx, project, version.sourceEvidenceSetId, version.briefRevisionId, false);
    const detail = await this.mappings(tx, project, articleContentSchema.parse(version.content), version);
    if (detail.issues.length || !await this.sourceCitationIntegrity(tx, project, version, detail)) throw new ConflictException('Article source citations failed integrity checks');
    const citations = await tx.articleVersionSourceCitation.findMany({ where: { projectId: project, articleVersionId: version.id }, orderBy: { locator: 'asc' } });
    return { sourceEvidenceSetId: grounding.id, sourceEvidenceSetHash: grounding.sha256, passages: citations.map(row => {
      const passage = grounding.passages.find(item => item.id === row.spanId && item.packetId === row.packetId);
      if (!passage) throw new ConflictException('Article citation is outside its frozen source set');
      return { passageId: row.spanId, packetId: row.packetId, snapshotId: passage.snapshotId, sourceQuote: passage.quote,
        articleLocator: row.locator, articleText: row.text, quote: row.quote };
    }) };
  }
  private async passageViews(tx: Prisma.TransactionClient, project: string, setId: string, briefId: string) {
    const set = await this.grounding.inspectSet(tx,project,setId,briefId,false);
    const sources = await tx.sourceSnapshot.findMany({ where: { projectId: project,id: { in: set.snapshots.map(row => row.snapshotId) } },
      select: { id: true,materialId: true,material: { select: { label: true } } } });
    return set.passages.map(({ id,packetId,snapshotId,fragmentId,startOffset,endOffset,quote }) => {
      const source = sources.find(row => row.id === snapshotId);
      if (!source) throw new ConflictException('Source passage ancestry failed');
      return { passageId: id,packetId,snapshotId,fragmentId,startOffset,endOffset,quote,materialId: source.materialId,materialTitle: source.material.label };
    });
  }
  sourcePassages(user: string, project: string, versionId: string) {
    return this.command(user,project,async tx => {
      const version = await tx.articleVersion.findFirst({ where: { projectId: project,id: versionId } });
      if (!version) throw new NotFoundException('Article version not found');
      return { passages: version.sourceEvidenceSetId && version.briefRevisionId
        ? await this.passageViews(tx,project,version.sourceEvidenceSetId,version.briefRevisionId) : [] };
    },false);
  }
  private async state(tx: Prisma.TransactionClient, project: string, editorOnly = false) {
    const p = await tx.project.findUniqueOrThrow({ where: { id: project }, include: { workspace: true } });
    const article = await tx.article.findUnique({ where: { projectId: project }, include: { draft: true,
      versions: { include: { claims: !editorOnly }, orderBy: { number: 'desc' },
        ...(editorOnly ? { where: { OR: [{ approvedAt: null, withdrawnAt: null }, { approvedFor: { some: {} } }, { draftBases: { some: {} } }] } } : {}) } } });
    const brief = await tx.brief.findUnique({ where: { projectId: project }, include: { currentRevision: { include: briefInclude }, revisions: editorOnly ? false : { include: briefInclude, orderBy: { number: 'desc' } } } });
    const outline = await tx.outline.findUnique({ where: { projectId: project }, include: { currentRevision: true, revisions: editorOnly ? false : { orderBy: { number: 'desc' } } } });
    const style = editorOnly ? null : await tx.workspaceStyleRevision.findUniqueOrThrow({ where: { workspaceId_revision: { workspaceId: p.workspaceId, revision: p.workspace.styleRevision } } });
    const mode = article?.draft?.contentMode ?? brief?.currentRevision?.contentMode ?? 'CREATIVE';
    const prerequisites = { sourceEvidenceRequired: mode === 'FACTUAL' };
    const detail = !editorOnly && article?.draft ? await this.mappings(tx, project, articleContentSchema.parse(article.draft.content), article.draft) : null;
    const staleReasons = !editorOnly && article?.draft ? await this.stale(tx, project, article.draft) : [];
    const versions = [];
    for (const version of article?.versions ?? []) versions.push({ ...json(version), ...(!editorOnly ? await this.inspectVersion(tx, project, version) : {}), status: version.withdrawnAt ? 'WITHDRAWN' : version.approvedAt ? 'APPROVED' : 'PROPOSED' });
    const selectedSource = article?.draft?.sourceEvidenceSetId ? article.draft : article?.versions.find(row => row.sourceEvidenceSetId) ?? outline?.currentRevision;
    const eligibleSourcePassages = !editorOnly && selectedSource?.sourceEvidenceSetId && selectedSource.briefRevisionId
      ? await this.passageViews(tx,project,selectedSource.sourceEvidenceSetId,selectedSource.briefRevisionId) : [];
    return { editorOnly, article: article ? { id: article.id, revision: article.revision, draft: json(article.draft), currentApprovedVersionId: article.currentApprovedVersionId,
      versions } : null,
      articleSelected: p.formats.includes('ARTICLE'), editorial: { brief: brief ? { id: brief.id, revision: brief.revision, currentRevision: json(brief.currentRevision), history: json(brief.revisions ?? []) } : null,
        outline: outline ? { ...json(outline), revisions: (outline.revisions ?? []).map(row => ({ ...json(row), status: row.withdrawnAt ? 'WITHDRAWN' : row.approvedAt ? 'APPROVED' : 'PROPOSED' })) } : null, style: json(style), prerequisites, articleSelected: p.formats.includes('ARTICLE') },
      eligibleEvidence: [],
      eligibleSourcePassages,
      mappingIssues: detail?.issues ?? [], hasUnmapped: detail?.hasUnmapped ?? false, staleReasons };
  }
  get(user: string, project: string, editorOnly = false) {
    return this.command(user, project, tx => this.state(tx, project, editorOnly), false, { maxWait: 5_000, timeout: 30_000 });
  }
  private async writeDraft(tx: Prisma.TransactionClient, articleId: string, project: string, user: string, content: ArticleContent, inputs: Inputs, baseVersionId: string | null) {
    await this.mappings(tx, project, content, inputs, true);
    const data = { ...inputData(inputs), content: json(content), plainText: articleDocumentDetails(content).plainText, sha256: canonicalManifestHash(content), baseVersionId, updatedBy: user, updatedAt: new Date() };
    await tx.articleDraft.upsert({ where: { articleId }, create: { articleId, projectId: project, ...data }, update: data });
    await tx.article.update({ where: { id: articleId }, data: { revision: { increment: 1 } } });
  }
  saveDraft(user: string, project: string, input: z.infer<typeof saveArticleDraftInput>, editorOnly = false) {
    return this.command(user, project, async tx => {
      const article = await this.article(tx, project, input.expectedRevision);
      const inputs = inputData(!input.refreshInputs && article.draft?.contentMode === input.contentMode ? article.draft : await this.currentInputs(tx, project, input.contentMode, article.draft?.origin === 'UNVERIFIED_IMPORTED' ? 'UNVERIFIED_IMPORTED' : 'MANUAL', article.draft?.sourceSnapshotId ?? null));
      if (inputs.origin === 'AI' && article.draft?.sha256 !== canonicalManifestHash(input.content)) inputs.origin = 'MANUAL';
      await this.writeDraft(tx, article.id, project, user, articleContentSchema.parse(input.content), inputs, article.draft?.baseVersionId ?? null);
      return this.state(tx, project, editorOnly);
    }, true, { maxWait: 5_000, timeout: 30_000 });
  }
  importArticle(user: string, project: string, input: z.infer<typeof importArticleInput>) {
    return this.command(user, project, async tx => {
      const article = await this.article(tx, project, input.expectedRevision); let content = input.content;
      if (input.snapshotId) {
        const snapshot = await tx.sourceSnapshot.findFirst({ where: { id: input.snapshotId, projectId: project, material: { purpose: 'SUPPLIED_ARTICLE' } }, include: { material: true } });
        if (!snapshot) throw new BadRequestException('Select a supplied article snapshot of this project');
        content = { title: snapshot.material.label.slice(0, 500), document: { type: 'doc', content: snapshot.normalizedText.split(/\n\s*\n/u).map(text => ({ type: 'paragraph', ...(text ? { content: [{ type: 'text', text }] } : {}) })) } };
      }
      if (!content) throw new BadRequestException('Provide supplied article content');
      await this.writeDraft(tx, article.id, project, user, articleContentSchema.parse(content), await this.currentInputs(tx, project, input.contentMode, 'UNVERIFIED_IMPORTED', input.snapshotId ?? null), null);
      return this.state(tx, project);
    });
  }
  private async append(tx: Prisma.TransactionClient, project: string, articleId: string, user: string, content: ArticleContent, inputs: Inputs, sourceArticleRevision: number, jobId?: string, executionId?: string) {
    const latest = await tx.articleVersion.findFirst({ where: { articleId }, orderBy: { number: 'desc' } });
    const details = articleDocumentDetails(content);
    const version = await tx.articleVersion.create({ data: { id: randomUUID(), articleId, projectId: project, number: (latest?.number ?? 0) + 1, content: json(content), plainText: details.plainText,
      sha256: canonicalManifestHash(content), ...inputData(inputs), sourceArticleRevision, createdBy: user, ...(jobId ? { jobId } : {}), ...(executionId ? { aiExecutionId: executionId } : {}) } });
    const mappings = details.mappings;
    if (mappings.length) await tx.articleVersionClaim.createMany({ data: mappings.map(({ text, ...mapping }) => ({ ...mapping, linkedText: text, projectId: project, articleVersionId: version.id })) });
    if (inputs.sourceEvidenceSetId && details.sourceMappings.length) await tx.articleVersionSourceCitation.createMany({ data: details.sourceMappings.map(({ passageId, packetId, ...mapping }) => ({
      projectId: project, articleVersionId: version.id, sourceEvidenceSetId: inputs.sourceEvidenceSetId!, packetId, spanId: passageId, ...mapping,
    })) });
    await tx.articleVersion.update({ where: { id: version.id }, data: { claimsSealed: true,
      ...(inputs.sourceEvidenceSetId && details.sourceMappings.length ? { sourceEvidenceSealed: true } : {}) } });
    return version;
  }
  /** Append an unapproved candidate produced by the source-writing coordinator. Caller holds Project authorization. */
  async appendSourceCandidate(tx: Prisma.TransactionClient, user: string, project: string, content: ArticleContent,
    sourceInputs: SourceArticleInputs, expectedArticleRevision: number, jobId?: string, executionId?: string): Promise<{ articleVersionId: string }> {
    await this.lock(tx, user, project);
    const p = await tx.project.findUniqueOrThrow({ where: { id: project }, include: { workspace: true } });
    const article = await this.article(tx, project, expectedArticleRevision);
    if (!p.formats.includes('ARTICLE') || sourceInputs.contentMode !== 'FACTUAL' || !sourceInputs.sourceEvidenceSetId
      || sourceInputs.basisRevisionId !== null || !sourceInputs.briefRevisionId || !sourceInputs.outlineRevisionId
      || sourceInputs.workspaceId !== p.workspaceId || sourceInputs.workspaceStyleRevision !== p.workspace.styleRevision) {
      throw new ConflictException('Source article inputs do not match the current factual Article task');
    }
    const [brief, outline] = await Promise.all([
      tx.briefRevision.findFirst({ where: { id: sourceInputs.briefRevisionId, projectId: project }, include: briefInclude }),
      tx.outlineRevision.findFirst({ where: { id: sourceInputs.outlineRevisionId, projectId: project } }),
    ]);
    const currentBrief = await tx.brief.findUnique({ where: { projectId: project }, select: { currentRevisionId: true } });
    const currentOutline = await tx.outline.findUnique({ where: { projectId: project }, select: { currentRevisionId: true, currentApprovedRevisionId: true } });
    if (!brief || brief.contentMode !== 'FACTUAL' || brief.requiredClaims.length || currentBrief?.currentRevisionId !== brief.id || !outline || !outline.approvedAt || outline.withdrawnAt
      || !outline.sourceEvidenceSetId || !outline.sourceEvidenceSealed
      || outline.briefRevisionId !== brief.id || currentOutline?.currentRevisionId !== outline.id || currentOutline.currentApprovedRevisionId !== outline.id) {
      throw new ConflictException('Source article requires the current approved factual outline');
    }
    const grounding = await this.grounding.inspectSet(tx, project, sourceInputs.sourceEvidenceSetId, brief.id, true);
    const inputs: Inputs = { ...sourceInputs, origin: 'AI', sourceSnapshotId: null };
    const parsed = articleContentSchema.parse(content), detail = await this.mappings(tx, project, parsed, inputs);
    if (!detail.plainText.trim() || !detail.sourceMappings.length || detail.issues.length
      || grounding.requiredClaims.some(required => !detail.mappings.some(mapping => mapping.claimRevisionId === required.claimRevisionId))) {
      throw new ConflictException('Source article needs text grounded in this source set and every required approved claim');
    }
    const version = await this.append(tx, project, article.id, user, parsed, inputs, article.revision, jobId, executionId);
    return { articleVersionId: version.id };
  }
  // Annotation service holds the same authorized Project lock in this transaction.
  // Accepted suggestions create candidates; draft and approval pointers stay intact.
  async appendAnnotationCandidate(tx: Prisma.TransactionClient, user: string, project: string, sourceVersionId: string, content: ArticleContent, expectedRevision: number) {
    const article = await this.article(tx, project, expectedRevision, false);
    const source = await tx.articleVersion.findFirst({ where: { id: sourceVersionId, projectId: project, articleId: article.id } });
    if (!source || source.withdrawnAt || !article.draft || article.draft.baseVersionId !== source.id || article.draft.sha256 !== source.sha256 || !this.sameInputs(source, article.draft)) {
      throw new ConflictException('The saved article changed; review the suggestion against the current version');
    }
    const parsed = articleContentSchema.parse(content), inputs = inputData(source);
    if (inputs.origin === 'AI') inputs.origin = 'MANUAL';
    await this.mappings(tx, project, parsed, inputs, true);
    const version = await this.append(tx, project, article.id, user, parsed, inputs, article.revision);
    await tx.article.update({ where: { id: article.id }, data: { revision: { increment: 1 } } });
    return version.id;
  }
  /** Freeze the selected source's exact input tuple without refreshing stale parents. */
  async freezeGoogleInputs(tx: Prisma.TransactionClient, user: string, project: string, sourceVersionId: string | null, expectedRevision: number): Promise<FrozenGoogleArticleInputs> {
    await this.lock(tx, user, project);
    const p = await tx.project.findUniqueOrThrow({ where: { id: project }, include: { workspace: true } });
    if (!p.formats.includes('ARTICLE')) throw new ConflictException('Select Article before syncing Google Docs');
    const article = await tx.article.findUnique({ where: { projectId: project }, include: { draft: true } });
    if ((article?.revision ?? 0) !== expectedRevision) throw new ConflictException('Article changed; reload before syncing Google Docs');

    let inputs: Inputs;
    if (sourceVersionId) {
      if (!article) throw new NotFoundException('Article version not found');
      const source = await tx.articleVersion.findFirst({ where: { id: sourceVersionId, projectId: project, articleId: article.id } });
      if (!source || !source.claimsSealed || source.sourceEvidenceSetId && !source.sourceEvidenceSealed || canonicalManifestHash(source.content) !== source.sha256) throw new ConflictException('Selected article version failed integrity checks');
      inputs = inputData(source);
    } else if (article?.draft) {
      inputs = inputData(article.draft);
    } else {
      const mode = (await tx.brief.findUnique({ where: { projectId: project }, include: { currentRevision: true } }))?.currentRevision?.contentMode ?? 'CREATIVE';
      inputs = await this.currentInputs(tx, project, mode, 'UNVERIFIED_IMPORTED');
    }
    if (inputs.workspaceId !== p.workspaceId) throw new ConflictException('Article inputs belong to a different Workspace');
    if (inputs.sourceSnapshotId && !await tx.sourceSnapshot.findFirst({ where: { id: inputs.sourceSnapshotId, projectId: project } })) {
      throw new ConflictException('Article source snapshot is unavailable for this Project');
    }
    return { sourceVersionId, expectedArticleRevision: expectedRevision, ...inputData(inputs) };
  }
  /** Append an unverified Google-import candidate while preserving the draft and approval. */
  async appendGoogleCandidate(tx: Prisma.TransactionClient, user: string, project: string, content: ArticleContent, frozen: FrozenGoogleArticleInputs, jobId?: string): Promise<string> {
    await this.lock(tx, user, project);
    const p = await tx.project.findUniqueOrThrow({ where: { id: project }, include: { workspace: true } });
    if (!p.formats.includes('ARTICLE')) throw new ConflictException('Select Article before syncing Google Docs');
    if (frozen.workspaceId !== p.workspaceId || frozen.expectedArticleRevision < 0) throw new ConflictException('Frozen Article inputs do not match this Project');
    const frozenInputs: Inputs = { contentMode: frozen.contentMode, origin: frozen.origin, briefRevisionId: frozen.briefRevisionId,
      basisRevisionId: frozen.basisRevisionId, sourceEvidenceSetId: frozen.sourceEvidenceSetId ?? null, outlineRevisionId: frozen.outlineRevisionId, workspaceId: frozen.workspaceId,
      workspaceStyleRevision: frozen.workspaceStyleRevision, sourceSnapshotId: frozen.sourceSnapshotId };
    if (frozen.sourceSnapshotId && !await tx.sourceSnapshot.findFirst({ where: { id: frozen.sourceSnapshotId, projectId: project } })) {
      throw new ConflictException('Frozen source snapshot is unavailable for this Project');
    }

    if (frozen.sourceVersionId) {
      const articleForSource = await tx.article.findUnique({ where: { projectId: project } });
      const source = articleForSource ? await tx.articleVersion.findFirst({ where: { id: frozen.sourceVersionId, projectId: project, articleId: articleForSource.id } }) : null;
      if (!source || !source.claimsSealed || source.sourceEvidenceSetId && !source.sourceEvidenceSealed || canonicalManifestHash(source.content) !== source.sha256 || !articleContentSchema.safeParse(source.content).success || !this.sameInputs(source, frozenInputs)) {
        throw new ConflictException('Selected article version or its frozen inputs failed integrity checks');
      }
    }

    const parsed = articleContentSchema.parse(content);
    const stripEvidence = (node: ArticleContent['document']): ArticleContent['document'] => ({
      ...node,
      ...(node.marks ? { marks: node.marks.filter(mark => mark.type !== 'evidence' && mark.type !== 'source_evidence') } : {}),
      ...(node.content ? { content: node.content.map(stripEvidence) } : {}),
    });
    const imported = articleContentSchema.parse({ ...parsed, document: stripEvidence(parsed.document) });
    const candidateInputs: Inputs = { ...frozenInputs, origin: 'UNVERIFIED_IMPORTED' };
    const payloadHash = canonicalManifestHash(imported);
    const operation = jobId ? await tx.googleDocSyncOperation.findUnique({ where: { projectId_jobId: { projectId: project, jobId } } }) : null;
    if (jobId && !operation) throw new ConflictException('Google sync operation not found for candidate replay');
    const existing = operation?.resultVersionId ? await tx.articleVersion.findFirst({ where: { id: operation.resultVersionId, projectId: project } }) : null;
    if (existing) {
      if (existing.sha256 !== payloadHash || canonicalManifestHash(existing.content) !== payloadHash || !this.sameInputs(existing, candidateInputs)
        || existing.sourceArticleRevision !== frozen.expectedArticleRevision || existing.origin !== 'UNVERIFIED_IMPORTED'
        || operation?.sourceVersionId !== frozen.sourceVersionId) {
        throw new ConflictException('Google sync job already produced a different Article candidate');
      }
      return existing.id;
    }

    const article = await tx.article.findUnique({ where: { projectId: project } }) ?? await tx.article.create({ data: { projectId: project } });
    const version = await this.append(tx, project, article.id, user, imported, candidateInputs, frozen.expectedArticleRevision);
    return version.id;
  }
  checkpoint(user: string, project: string, input: { expectedRevision: number }, editorOnly = false) {
    return this.command(user, project, async tx => {
      const article = await this.article(tx, project, input.expectedRevision, false), draft = article.draft;
      if (!draft) throw new ConflictException('Save the article draft first');
      const base = draft.baseVersionId ? await tx.articleVersion.findUnique({ where: { id: draft.baseVersionId } }) : null;
      if (base && !base.withdrawnAt && base.sha256 === draft.sha256 && this.sameInputs(base, draft)) return this.state(tx, project, editorOnly);
      const inputs = inputData(draft);
      // Reusing an intact AI checkpoint above retains its invocation. Creating a
      // replacement after terminal withdrawal is a new human editorial version.
      if (inputs.origin === 'AI') inputs.origin = 'MANUAL';
      const version = await this.append(tx, project, article.id, user, articleContentSchema.parse(draft.content), inputs, article.revision);
      await tx.articleDraft.update({ where: { articleId: article.id }, data: { baseVersionId: version.id, origin: inputs.origin, updatedBy: user, updatedAt: new Date() } });
      await tx.article.update({ where: { id: article.id }, data: { revision: { increment: 1 } } });
      return this.state(tx, project, editorOnly);
    }, true, { maxWait: 5_000, timeout: 30_000 });
  }
  private sameInputs(a: Inputs, b: Inputs) { return ['briefRevisionId', 'basisRevisionId', 'sourceEvidenceSetId', 'outlineRevisionId', 'workspaceId', 'workspaceStyleRevision', 'sourceSnapshotId', 'contentMode', 'origin'].every(key => a[key as keyof Inputs] === b[key as keyof Inputs]); }
  // Caller holds the authorized Project lock. Receipt freshness and factual
  // safety are separate: a receipt can acknowledge changed parents, never
  // invalid original evidence or a terminally withdrawn required approval.
  async inspectVersion(tx: Prisma.TransactionClient, project: string, version: ArticleVersion) {
    if (version.projectId !== project) throw new NotFoundException('Article version not found');
    const current = await this.currentInputs(tx, project, version.contentMode, version.origin, version.sourceSnapshotId);
    const tupleMatches = (candidate: Pick<Inputs, 'briefRevisionId' | 'basisRevisionId' | 'sourceEvidenceSetId' | 'outlineRevisionId' | 'workspaceStyleRevision'>) =>
      candidate.briefRevisionId === current.briefRevisionId && candidate.workspaceStyleRevision === current.workspaceStyleRevision
      && (version.contentMode !== 'FACTUAL' || (version.sourceEvidenceSetId ? candidate.sourceEvidenceSetId === version.sourceEvidenceSetId : candidate.basisRevisionId === current.basisRevisionId))
      && (!version.outlineRevisionId || candidate.outlineRevisionId === current.outlineRevisionId);
    const receipt = version.reviewedAt && version.reviewCounter > 0 && tupleMatches({ briefRevisionId: version.reviewedBriefRevisionId,
      basisRevisionId: version.reviewedBasisRevisionId, sourceEvidenceSetId: version.reviewedSourceEvidenceSetId, outlineRevisionId: version.reviewedOutlineRevisionId, workspaceStyleRevision: version.reviewedWorkspaceStyleRevision ?? -1 });
    const staleReasons = receipt || tupleMatches(version) ? [] : await this.stale(tx, project, version);
    const blockingReasons: string[] = [];
    if (canonicalManifestHash(version.content) !== version.sha256) blockingReasons.push('CONTENT_INTEGRITY');
    if (version.withdrawnAt) blockingReasons.push('APPROVAL_WITHDRAWN');
    const detail = await this.mappings(tx, project, articleContentSchema.parse(version.content), version);
    if (!detail.plainText.trim()) blockingReasons.push('EMPTY_CONTENT');
    if (detail.issues.length) blockingReasons.push('INVALID_EVIDENCE_MAPPING');
    if (version.contentMode === 'FACTUAL') {
      if (version.sourceEvidenceSetId) {
        if (version.origin === 'AI') {
          const assembly = await tx.sourceArticleAssembly.findFirst({ where: { projectId: project,articleVersionId: version.id } });
          if (!assembly || canonicalManifestHash(assembly.manifestJson) !== assembly.sha256) blockingReasons.push('SOURCE_ASSEMBLY_INTEGRITY');
        }
        if (!version.sourceEvidenceSealed || !detail.sourceMappings.length) blockingReasons.push('SOURCE_EVIDENCE_UNSEALED');
        else if (!await this.sourceCitationIntegrity(tx, project, version, detail)) blockingReasons.push('SOURCE_CITATION_INTEGRITY');
        if (!current.briefRevisionId) blockingReasons.push('CURRENT_SOURCE_BRIEF_MISSING');
        try { await this.grounding.inspectSet(tx, project, version.sourceEvidenceSetId, version.briefRevisionId ?? '', true); }
        catch { blockingReasons.push('SOURCE_EVIDENCE_CHANGED'); }
      } else blockingReasons.push('SOURCE_EVIDENCE_REQUIRED');
    }
    if (version.outlineRevisionId) {
      const original = await tx.outlineRevision.findFirst({ where: { projectId: project, id: version.outlineRevisionId } });
      if (!original?.approvedAt || original.withdrawnAt) blockingReasons.push('OUTLINE_APPROVAL_WITHDRAWN');
      if (!current.outlineRevisionId) blockingReasons.push('CURRENT_OUTLINE_MISSING');
    }
    return { staleReasons, blockingReasons, hasUnmapped: detail.hasUnmapped, eligible: !!version.approvedAt && !staleReasons.length && !blockingReasons.length };
  }
  rereview(user: string, project: string, versionId: string, input: { expectedRevision: number; expectedReviewCounter: number; acknowledgeUnmapped?: boolean | undefined }) {
    return this.command(user, project, async tx => {
      const article = await this.article(tx, project, input.expectedRevision, false);
      const version = await tx.articleVersion.findFirst({ where: { projectId: project, articleId: article.id, id: versionId } });
      if (!version) throw new NotFoundException('Article version not found');
      if (article.currentApprovedVersionId !== version.id || !version.approvedAt || version.withdrawnAt || version.reviewCounter !== input.expectedReviewCounter) throw new ConflictException('Re-review only the current active approval with its exact review counter');
      const inspection = await this.inspectVersion(tx, project, version);
      if (inspection.blockingReasons.length) throw new ConflictException('Required factual evidence or approval blocks re-review');
      const currentInputs = await this.currentInputs(tx, project, version.contentMode, version.origin, version.sourceSnapshotId);
      // A supplied/manual version without an outline never acquires that
      // optional dependency merely because an outline was later approved.
      const current = { ...currentInputs, sourceEvidenceSetId: version.sourceEvidenceSetId, basisRevisionId: version.sourceEvidenceSetId ? null : currentInputs.basisRevisionId,
        outlineRevisionId: version.outlineRevisionId ? currentInputs.outlineRevisionId : null };
      if (!!current.briefRevisionId !== !!version.briefRevisionId || !!current.outlineRevisionId !== !!version.outlineRevisionId) throw new ConflictException('Changed parent shape needs a new article version');
      const mappings = await this.mappings(tx, project, articleContentSchema.parse(version.content), current);
      if (mappings.issues.length) throw new ConflictException('Current source passages must support every retained mapping');
      if (version.sourceEvidenceSetId) {
        const sourceInputs = { ...current, sourceEvidenceSetId: version.sourceEvidenceSetId, basisRevisionId: null };
        const sourceMappings = await this.mappings(tx, project, articleContentSchema.parse(version.content), sourceInputs);
        if (sourceMappings.issues.length || !await this.sourceCitationIntegrity(tx, project, version, sourceMappings)) throw new ConflictException('Source citations must remain valid for re-review');
      }
      if (mappings.hasUnmapped && !input.acknowledgeUnmapped) throw new ConflictException('Acknowledge unmapped wording during re-review');
      await tx.articleVersion.update({ where: { id: version.id }, data: { reviewCounter: { increment: 1 }, reviewedBriefRevisionId: current.briefRevisionId,
        reviewedBasisRevisionId: current.basisRevisionId, reviewedSourceEvidenceSetId: version.sourceEvidenceSetId, reviewedOutlineRevisionId: version.outlineRevisionId ? current.outlineRevisionId : null,
        reviewedWorkspaceStyleRevision: current.workspaceStyleRevision, reviewedBy: user, reviewedAt: new Date() } });
      await tx.article.update({ where: { id: article.id }, data: { revision: { increment: 1 } } });
      return this.state(tx, project);
    });
  }
  private async reviewable(tx: Prisma.TransactionClient, project: string, version: ArticleVersion) {
    const stale = await this.stale(tx, project, version);
    if (stale.length) throw new ConflictException('Article inputs need a new version before review');
    const detail = await this.mappings(tx, project, articleContentSchema.parse(version.content), version);
    if (!detail.plainText.trim()) throw new ConflictException('Article requires a nonempty body before review');
    if (detail.issues.length) throw new ConflictException('Relink or remove invalid article evidence mappings');
    if (version.sourceEvidenceSetId && !await this.sourceCitationIntegrity(tx, project, version, detail)) throw new ConflictException('Article source citations are not sealed to its content');
    return detail;
  }
  review(user: string, project: string, versionId: string, action: 'apply' | 'approve' | 'withdraw', input: z.infer<typeof reviewArticleInput>) {
    return this.command(user, project, async tx => {
      const article = await this.article(tx, project, input.expectedRevision, false);
      const version = await tx.articleVersion.findFirst({ where: { id: versionId, projectId: project, articleId: article.id } });
      if (!version) throw new NotFoundException('Article version not found');
      if (version.withdrawnAt) throw new ConflictException('Article withdrawal is terminal');
      if (canonicalManifestHash(version.content) !== version.sha256) throw new ConflictException('Article integrity check failed');
      if (action === 'withdraw') {
        if (!version.approvedAt) throw new ConflictException('Only an approved article can be withdrawn');
        await tx.articleVersion.update({ where: { id: versionId }, data: { withdrawnBy: user, withdrawnAt: new Date(), withdrawalReason: input.reason ?? null } });
        await tx.article.update({ where: { id: article.id }, data: { revision: { increment: 1 }, ...(article.currentApprovedVersionId === versionId ? { currentApprovedVersionId: null } : {}) } });
      } else if (action === 'apply') {
        if (version.origin === 'AI' && version.sourceArticleRevision !== article.revision) throw new ConflictException('Article changed after generation; preserve local work');
        await this.reviewable(tx, project, version);
        await this.writeDraft(tx, article.id, project, user, articleContentSchema.parse(version.content), version, versionId);
        // Only an explicit application acknowledges this exact remote snapshot as
        // the comparison base. Merely fetching or approving never does so.
        const googleCandidates = await tx.googleDocSnapshotCandidate.findMany({ where: { projectId: project, articleVersionId: versionId }, include: { binding: true, snapshot: true } });
        for (const candidate of googleCandidates) {
          if (candidate.binding.endedAt || candidate.snapshot.bindingId !== candidate.bindingId) continue;
          const converted = candidate.snapshot.converted;
          const remote = converted && typeof converted === 'object' && !Array.isArray(converted) ? (converted as Record<string, unknown>)['content'] : null;
          const parsed = articleContentSchema.safeParse(remote);
          const candidateContent = articleContentSchema.parse(version.content);
          const source = candidate.sourceVersionId ? await tx.articleVersion.findFirst({ where: { projectId: project, id: candidate.sourceVersionId } }) : null;
          const expectedTitle = source ? articleContentSchema.parse(source.content).title : parsed.success ? parsed.data.title : null;
          if (!parsed.success || candidateContent.title !== expectedTitle || canonicalManifestHash({ ...parsed.data, title: candidateContent.title }) !== version.sha256) throw new ConflictException('Google candidate snapshot integrity check failed');
          await tx.googleDocSyncState.updateMany({ where: { projectId: project, bindingId: candidate.bindingId }, data: { baselineSnapshotId: candidate.snapshotId, baselineVersionId: versionId } });
        }
      } else {
        if (version.approvedAt || !article.draft || article.draft.baseVersionId !== versionId || article.draft.sha256 !== version.sha256 || !this.sameInputs(article.draft, version)) throw new ConflictException('Approve only the exact current saved checkpoint');
        const details = await this.reviewable(tx, project, version);
        if (details.hasUnmapped && !input.acknowledgeUnmapped) throw new ConflictException('Acknowledge that unmapped prose has not been completely fact checked');
        await tx.articleVersion.update({ where: { id: versionId }, data: { approvedBy: user, approvedAt: new Date(), acknowledgedUnmapped: details.hasUnmapped && input.acknowledgeUnmapped === true } });
        await tx.article.update({ where: { id: article.id }, data: { currentApprovedVersionId: versionId, revision: { increment: 1 } } });
      }
      return this.state(tx, project);
    }, true, { maxWait: 10_000, timeout: 30_000 });
  }
  freezeArticle(user: string, project: string, commandKey: string, expectedRevision: number, releaseInput: ArticleWorkflowRelease) {
    const release = articleWorkflowReleaseSchema.parse(releaseInput);
    return this.command(user, project, async tx => {
      await this.jobs.assertEffects(tx, project, user);
      const p = await tx.project.findUniqueOrThrow({ where: { id: project }, include: { workspace: true } });
      if (!p.formats.includes('ARTICLE')) throw new ConflictException('Select Article before generation');
      const article = await tx.article.findUnique({ where: { projectId: project } });
      if ((article?.revision ?? 0) !== expectedRevision) throw new ConflictException('Article changed; reload before generation');
      const brief = await tx.brief.findUnique({ where: { projectId: project }, include: { currentRevision: { include: briefInclude } } });
      const outline = await tx.outline.findUnique({ where: { projectId: project }, include: { currentRevision: true } });
      const b = brief?.currentRevision, o = outline?.currentRevision;
      if (!b || !o || outline?.currentApprovedRevisionId !== o.id || !o.approvedAt || o.withdrawnAt || o.briefRevisionId !== b.id || b.workspaceStyleRevision !== p.workspace.styleRevision || canonicalBriefHash(b) !== b.sha256 || canonicalManifestHash(o.content) !== o.sha256) throw new ConflictException('Generate from the latest brief and current approved outline');
      if (b.contentMode === 'FACTUAL') throw new ConflictException('Factual article generation must use source preparation');
      const profile = await tx.userProfile.findUniqueOrThrow({ where: { id: user } });
      const manifest = articleInputManifestSchema.parse({ schemaVersion: 'article-input-v1', articleRevision: expectedRevision, briefRevisionId: b.id, briefHash: b.sha256, outlineRevisionId: o.id, outlineHash: o.sha256,
        workspaceId: b.workspaceId, workspaceStyleRevision: b.workspaceStyleRevision, contentMode: b.contentMode, basisRevisionId: null, basisHash: null,
        contextSnapshotIds: b.contextSnapshots.map(row => row.snapshotId).sort(), release, noticeVersion: EXTERNAL_PROCESSING_NOTICE.version, acceptedAt: profile.externalProcessingAcceptedAt?.toISOString() });
      return this.jobs.create(tx, { projectId: project, userId: user, operation: 'ARTICLE_GENERATION', contractVersion: 'article-v1', commandKey, inputManifest: manifest, deadlineMs: ARTICLE_GENERATION_DEADLINE_MS });
    });
  }
  async commitGenerated(tx: Prisma.TransactionClient, job: Job, raw: unknown, executionId: string) {
    await this.lock(tx, job.requestedBy, job.projectId);
    const parsed = articleContentSchema.safeParse(raw), m = articleInputManifestSchema.safeParse(job.inputManifest);
    if (!parsed.success || !m.success || job.operation !== 'ARTICLE_GENERATION' || job.contractVersion !== 'article-v1') throw new JobFailure('INVALID_CONTRACT', 'KNOWN_SUCCEEDED');
    const frozen = m.data, b = await tx.briefRevision.findFirst({ where: { id: frozen.briefRevisionId, projectId: job.projectId }, include: briefInclude });
    if (frozen.contentMode === 'FACTUAL') throw new JobFailure('INVALID_CONTRACT', 'KNOWN_SUCCEEDED');
    const o = await tx.outlineRevision.findFirst({ where: { id: frozen.outlineRevisionId, projectId: job.projectId } });
    const execution = await tx.aIExecution.findFirst({ where: { id: executionId, projectId: job.projectId, jobId: job.id } });
    if (!b || !o || !execution || canonicalBriefHash(b) !== frozen.briefHash || b.sha256 !== frozen.briefHash || o.sha256 !== frozen.outlineHash || canonicalManifestHash(o.content) !== frozen.outlineHash || !o.approvedAt || o.withdrawnAt || o.briefRevisionId !== b.id || o.basisRevisionId !== frozen.basisRevisionId || b.workspaceId !== frozen.workspaceId || b.workspaceStyleRevision !== frozen.workspaceStyleRevision || b.contentMode !== frozen.contentMode
      || canonicalManifestHash(b.contextSnapshots.map(row => row.snapshotId).sort()) !== canonicalManifestHash([...frozen.contextSnapshotIds].sort())) throw new JobFailure('INVALID_CONTRACT', 'KNOWN_SUCCEEDED');
    const inputs: Inputs = { contentMode: frozen.contentMode, origin: 'AI', briefRevisionId: b.id, basisRevisionId: frozen.basisRevisionId, sourceEvidenceSetId: null, outlineRevisionId: o.id, workspaceId: frozen.workspaceId, workspaceStyleRevision: frozen.workspaceStyleRevision, sourceSnapshotId: null };
    try {
      const detail = await this.mappings(tx, job.projectId, parsed.data, inputs);
      if (!detail.plainText.trim() || detail.issues.length || b.requiredClaims.some(row => !detail.mappings.some(mapping => mapping.claimRevisionId === row.claimRevisionId))) throw new Error('Invalid generated evidence');
    } catch { throw new JobFailure('INVALID_CONTRACT', 'KNOWN_SUCCEEDED'); }
    const article = await tx.article.findUnique({ where: { projectId: job.projectId } }) ?? await tx.article.create({ data: { projectId: job.projectId } });
    const version = await this.append(tx, job.projectId, article.id, job.requestedBy, parsed.data, inputs, frozen.articleRevision, job.id, executionId);
    return { articleVersionId: version.id };
  }
}
