import { BadRequestException, ConflictException, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import type { Prisma, PrismaClient, Job, ArticleVersion, AdaptationRevision } from '../generated/prisma/client.js';
import { DurableJobService, canonicalManifestHash } from '../jobs/job-service.js';
import { JobFailure, retryAllowed } from '../jobs/contracts.js';
import { PrivateAssetStore } from '../storage/private-asset-store.js';
import type { ArticleService } from '../editorial/article.service.js';
import type { TelegramService } from '../editorial/telegram.service.js';
import { articleContentSchema } from '../editorial/article-contracts.js';
import { telegramContentSchema } from '../editorial/telegram-contracts.js';
import { ZodError } from 'zod';
import { createExportInput, exportJobManifestSchema, exportManifestSchema, type CreateExportInput, type ExportManifest } from './export-contracts.js';
import { renderExportFiles, zipExportFiles } from './export-renderer.js';

const EXPORT_CONTRACT = 'export-v1';
const supportedFormats = new Set(['ARTICLE', 'TELEGRAM_POST']);
const itemOrder = (format: string) => format === 'ARTICLE' ? 0 : format === 'TELEGRAM_POST' ? 1 : 2;
function json<T>(value: T): T { return JSON.parse(JSON.stringify(value)) as T; }
function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
function comparisonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(comparisonValue);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .filter(([key]) => key !== 'materialLabel' && key !== 'sourceUrl').map(([key, entry]) => [key, comparisonValue(entry)]));
  return value;
}
function comparisonHash(value: unknown): string { return canonicalManifestHash(comparisonValue(value)); }
function iso(value: Date | null | undefined): string | null { return value?.toISOString() ?? null; }
function titleOf(format: string, value: unknown): string {
  if (format === 'ARTICLE') { const parsed = articleContentSchema.safeParse(value); return parsed.success ? parsed.data.title : 'Стаття'; }
  if (format === 'TELEGRAM_POST') { const parsed = telegramContentSchema.safeParse(value); return parsed.success ? parsed.data.text.slice(0, 120) || 'Дописи Telegram' : 'Дописи Telegram'; }
  return format;
}

type FrozenStage = { assetId: string; bucket: string; objectKey: string; sha256: string; byteSize: number; contentType: string; filename: string };
/** Private, immutable exports over explicitly selected approved revisions. */
export class ExportService {
  constructor(readonly prisma: PrismaClient, private readonly jobs: DurableJobService, private readonly articles: ArticleService,
    private readonly telegram: TelegramService, private readonly assets: PrivateAssetStore) {}

  private async lock(tx: Prisma.TransactionClient, user: string, project: string, write = true): Promise<void> {
    const access = write
      ? await tx.$queryRaw<Array<{ id: string }>>`SELECT p."id" FROM contextflow."Project" p
        JOIN contextflow."Workspace" w ON w."id"=p."workspaceId" JOIN contextflow."WorkspaceMember" m ON m."workspaceId"=w."id"
        WHERE p."id"=${project}::uuid AND p."archivedAt" IS NULL AND w."archivedAt" IS NULL
        AND m."userId"=${user}::uuid AND m."leftAt" IS NULL FOR UPDATE OF p FOR SHARE OF w,m`
      : await tx.$queryRaw<Array<{ id: string }>>`SELECT p."id" FROM contextflow."Project" p
        JOIN contextflow."Workspace" w ON w."id"=p."workspaceId" JOIN contextflow."WorkspaceMember" m ON m."workspaceId"=w."id"
        WHERE p."id"=${project}::uuid AND p."archivedAt" IS NULL AND w."archivedAt" IS NULL
        AND m."userId"=${user}::uuid AND m."leftAt" IS NULL FOR SHARE OF p,w,m`;
    if (!access.length) throw new NotFoundException('Project not found');
  }

  private command<T>(user: string, project: string, action: (tx: Prisma.TransactionClient) => Promise<T>, write = false): Promise<T> {
    return this.prisma.$transaction(async tx => { await this.lock(tx, user, project, write); return action(tx); }, { maxWait: 5_000, timeout: 30_000 });
  }

  private async evidenceSources(tx: Prisma.TransactionClient, project: string, edges: Array<{ claimRevisionId: string; evidenceId: string }>,
    usedByRevisionId: string, originRole: string) {
    const rows = await Promise.all(edges.map(edge => tx.claimEvidence.findFirst({ where: { projectId: project, id: edge.evidenceId, claimRevisionId: edge.claimRevisionId },
      include: { claimRevision: { select: { id: true, claimId: true, number: true, wording: true, sha256: true, approvedBy: true, approvedAt: true, withdrawnBy: true, withdrawnAt: true } },
        snapshot: { include: { material: { select: { id: true, label: true, purpose: true, sourceUrl: true } } } },
        fragment: { select: { id: true, ordinal: true, startOffset: true, endOffset: true, sha256: true } } } })));
    const sources: Array<Record<string, unknown>> = [];
    for (const edge of rows) {
      if (!edge) throw new ConflictException('An approved output references missing project evidence');
      sources.push({ claimRevisionId: edge.claimRevision.id, claimId: edge.claimRevision.claimId, claimRevisionNumber: edge.claimRevision.number,
        wording: edge.claimRevision.wording, claimSha256: edge.claimRevision.sha256,
        claimApproval: { actorId: edge.claimRevision.approvedBy, approvedAt: iso(edge.claimRevision.approvedAt), withdrawnBy: edge.claimRevision.withdrawnBy,
          withdrawnAt: iso(edge.claimRevision.withdrawnAt) },
        evidenceId: edge.id, quote: edge.quote, evidenceSha256: edge.sha256, relation: edge.relation, invalidatedAt: iso(edge.invalidatedAt),
        snapshotId: edge.snapshot.id, snapshotSequence: edge.snapshot.sequence, snapshotSha256: edge.snapshot.sha256,
        snapshotOrigin: edge.snapshot.origin, snapshotCreatedAt: edge.snapshot.createdAt.toISOString(),
        materialId: edge.snapshot.material.id, materialLabel: edge.snapshot.material.label, materialPurpose: edge.snapshot.material.purpose,
        sourceUrl: edge.snapshot.material.sourceUrl, fragmentId: edge.fragment.id, fragmentOrdinal: edge.fragment.ordinal,
        fragmentStartOffset: edge.fragment.startOffset, fragmentEndOffset: edge.fragment.endOffset, fragmentSha256: edge.fragment.sha256,
        startOffset: edge.startOffset, endOffset: edge.endOffset, usedByRevisionId, originRole });
    }
    return sources.sort((a, b) => String(a.snapshotId).localeCompare(String(b.snapshotId))
      || Number(a.startOffset) - Number(b.startOffset) || String(a.claimRevisionId).localeCompare(String(b.claimRevisionId))
      || String(a.evidenceId).localeCompare(String(b.evidenceId)));
  }

  private async dependencySnapshot(tx: Prisma.TransactionClient, project: string, ids: {
    briefRevisionId: string | null; basisRevisionId: string | null; outlineRevisionId: string | null; workspaceId: string;
    workspaceStyleRevision: number; sourceSnapshotId?: string | null;
  }) {
    const [brief, basis, outline, style, suppliedSnapshot] = await Promise.all([
      ids.briefRevisionId ? tx.briefRevision.findFirst({ where: { projectId: project, id: ids.briefRevisionId }, include: {
        requiredClaims: { orderBy: { claimRevisionId: 'asc' }, include: { claimRevision: { select: { id: true, claimId: true, number: true, wording: true, sha256: true,
          approvedBy: true, approvedAt: true, withdrawnBy: true, withdrawnAt: true } } } },
        contextSnapshots: { orderBy: { snapshotId: 'asc' }, include: { snapshot: { include: { material: { select: { id: true, label: true, purpose: true, sourceUrl: true } } } } } },
      } }) : null,
      ids.basisRevisionId ? tx.factualBasisRevision.findFirst({ where: { projectId: project, id: ids.basisRevisionId }, include: { claims: { orderBy: { claimRevisionId: 'asc' }, include: {
        claimRevision: { select: { id: true, claimId: true, number: true, wording: true, sha256: true, status: true, approvedBy: true, approvedAt: true, withdrawnBy: true, withdrawnAt: true } },
        evidence: { orderBy: { evidenceId: 'asc' }, include: { evidence: { select: { id: true, sha256: true, relation: true, invalidatedAt: true, snapshotId: true } } } },
      } } } }) : null,
      ids.outlineRevisionId ? tx.outlineRevision.findFirst({ where: { projectId: project, id: ids.outlineRevisionId }, select: { id: true, number: true, sha256: true,
        briefRevisionId: true, basisRevisionId: true, contentMode: true, origin: true, createdAt: true, approvedBy: true, approvedAt: true, withdrawnBy: true, withdrawnAt: true } }) : null,
      tx.workspaceStyleRevision.findUnique({ where: { workspaceId_revision: { workspaceId: ids.workspaceId, revision: ids.workspaceStyleRevision } },
        select: { workspaceId: true, revision: true, brandbook: true, tone: true, settings: true, createdAt: true } }),
      ids.sourceSnapshotId ? tx.sourceSnapshot.findFirst({ where: { projectId: project, id: ids.sourceSnapshotId }, include: { material: { select: { id: true, label: true, purpose: true, sourceUrl: true } } } }) : null,
    ]);
    if (ids.briefRevisionId && !brief || ids.basisRevisionId && !basis || ids.outlineRevisionId && !outline || !style
      || ids.sourceSnapshotId && !suppliedSnapshot) throw new ConflictException('An immutable export dependency is missing');
    const contextSnapshots = brief?.contextSnapshots.map(row => ({ snapshotId: row.snapshot.id, snapshotSequence: row.snapshot.sequence,
      snapshotSha256: row.snapshot.sha256, materialId: row.snapshot.material.id, materialLabel: row.snapshot.material.label,
      materialPurpose: row.capturedPurpose, sourceUrl: row.snapshot.material.sourceUrl })) ?? [];
    return {
      brief: brief ? { id: brief.id, number: brief.number, sha256: brief.sha256, contentMode: brief.contentMode, workspaceId: brief.workspaceId,
        workspaceStyleRevision: brief.workspaceStyleRevision, createdAt: brief.createdAt.toISOString(), requiredClaims: brief.requiredClaims.map(row => ({
          claimRevisionId: row.claimRevision.id, claimId: row.claimRevision.claimId, claimRevisionNumber: row.claimRevision.number,
          wording: row.claimRevision.wording, sha256: row.claimRevision.sha256, approval: { actorId: row.claimRevision.approvedBy,
            approvedAt: iso(row.claimRevision.approvedAt), withdrawnBy: row.claimRevision.withdrawnBy, withdrawnAt: iso(row.claimRevision.withdrawnAt) },
        })), contextSnapshots } : null,
      basis: basis ? { id: basis.id, sequence: basis.sequence, sha256: basis.sha256, createdAt: basis.createdAt.toISOString(), claims: basis.claims.map(row => ({
        claimRevisionId: row.claimRevision.id, claimId: row.claimRevision.claimId, claimRevisionNumber: row.claimRevision.number, wording: row.claimRevision.wording,
        claimSha256: row.claimRevision.sha256, status: row.claimRevision.status, approval: { actorId: row.claimRevision.approvedBy,
          approvedAt: iso(row.claimRevision.approvedAt), withdrawnBy: row.claimRevision.withdrawnBy, withdrawnAt: iso(row.claimRevision.withdrawnAt) },
        evidence: row.evidence.map(item => ({ evidenceId: item.evidence.id, sha256: item.evidence.sha256, relation: item.evidence.relation,
          invalidatedAt: iso(item.evidence.invalidatedAt), snapshotId: item.evidence.snapshotId })),
      })) } : null,
      outline: outline ? { id: outline.id, number: outline.number, sha256: outline.sha256, briefRevisionId: outline.briefRevisionId,
        basisRevisionId: outline.basisRevisionId, contentMode: outline.contentMode, origin: outline.origin, createdAt: outline.createdAt.toISOString(),
        approval: { actorId: outline.approvedBy, approvedAt: iso(outline.approvedAt), withdrawnBy: outline.withdrawnBy, withdrawnAt: iso(outline.withdrawnAt) } } : null,
      workspaceStyle: { workspaceId: style.workspaceId, revision: style.revision, brandbook: style.brandbook, tone: style.tone,
        settings: style.settings, sha256: canonicalManifestHash({ brandbook: style.brandbook, tone: style.tone, settings: style.settings }), createdAt: style.createdAt.toISOString() },
      suppliedArticle: suppliedSnapshot ? { snapshotId: suppliedSnapshot.id, sequence: suppliedSnapshot.sequence, sha256: suppliedSnapshot.sha256,
        origin: suppliedSnapshot.origin, materialId: suppliedSnapshot.material.id, materialLabel: suppliedSnapshot.material.label,
        materialPurpose: suppliedSnapshot.material.purpose, sourceUrl: suppliedSnapshot.material.sourceUrl } : null,
    };
  }

  private async articleProvenance(tx: Prisma.TransactionClient, project: string, version: ArticleVersion) {
    const [brief, basis, outline, sourceSnapshot, originalStyle] = await Promise.all([
      version.briefRevisionId ? tx.briefRevision.findFirst({ where: { projectId: project, id: version.briefRevisionId }, select: { id: true, sha256: true, workspaceId: true, workspaceStyleRevision: true } }) : null,
      version.basisRevisionId ? tx.factualBasisRevision.findFirst({ where: { projectId: project, id: version.basisRevisionId }, select: { id: true, sha256: true } }) : null,
      version.outlineRevisionId ? tx.outlineRevision.findFirst({ where: { projectId: project, id: version.outlineRevisionId }, select: { id: true, sha256: true, approvedAt: true, approvedBy: true, withdrawnAt: true, withdrawnBy: true } }) : null,
      version.sourceSnapshotId ? tx.sourceSnapshot.findFirst({ where: { projectId: project, id: version.sourceSnapshotId }, select: { id: true, sha256: true } }) : null,
      tx.workspaceStyleRevision.findUnique({ where: { workspaceId_revision: { workspaceId: version.workspaceId, revision: version.workspaceStyleRevision } },
        select: { brandbook: true, tone: true, settings: true } }),
    ]);
    const reviewed = version.reviewCounter > 0;
    const ids = { briefRevisionId: reviewed ? version.reviewedBriefRevisionId : version.briefRevisionId,
      basisRevisionId: reviewed ? version.reviewedBasisRevisionId : version.basisRevisionId,
      outlineRevisionId: reviewed ? version.reviewedOutlineRevisionId : version.outlineRevisionId,
      workspaceId: version.workspaceId, workspaceStyleRevision: reviewed ? version.reviewedWorkspaceStyleRevision ?? version.workspaceStyleRevision : version.workspaceStyleRevision,
      sourceSnapshotId: version.sourceSnapshotId };
    const effective = await this.dependencySnapshot(tx, project, ids);
    return { kind: 'ARTICLE', revisionId: version.id, number: version.number, sha256: version.sha256, contentMode: version.contentMode, origin: version.origin,
      approval: { actorId: version.approvedBy, approvedAt: iso(version.approvedAt), withdrawnBy: version.withdrawnBy, withdrawnAt: iso(version.withdrawnAt) },
      reviewCounter: version.reviewCounter, originalInputs: { briefRevisionId: version.briefRevisionId, briefSha256: brief?.sha256 ?? null,
        basisRevisionId: version.basisRevisionId, basisSha256: basis?.sha256 ?? null, outlineRevisionId: version.outlineRevisionId,
        outlineSha256: outline?.sha256 ?? null, workspaceId: version.workspaceId, workspaceStyleRevision: version.workspaceStyleRevision,
        workspaceStyleSha256: originalStyle ? canonicalManifestHash({ brandbook: originalStyle.brandbook, tone: originalStyle.tone, settings: originalStyle.settings }) : null,
        sourceSnapshotId: version.sourceSnapshotId, sourceSnapshotSha256: sourceSnapshot?.sha256 ?? null },
      reviewedTuple: version.reviewCounter > 0 ? { briefRevisionId: version.reviewedBriefRevisionId, basisRevisionId: version.reviewedBasisRevisionId,
        outlineRevisionId: version.reviewedOutlineRevisionId, workspaceStyleRevision: version.reviewedWorkspaceStyleRevision,
        reviewedBy: version.reviewedBy, reviewedAt: iso(version.reviewedAt) } : null,
      effectiveDependencies: effective };
  }

  private async telegramProvenance(tx: Prisma.TransactionClient, project: string, version: AdaptationRevision) {
    const [brief, basis, originalStyle, originalSourceArticle] = await Promise.all([
      tx.briefRevision.findFirst({ where: { projectId: project, id: version.briefRevisionId }, select: { id: true, sha256: true } }),
      version.basisRevisionId ? tx.factualBasisRevision.findFirst({ where: { projectId: project, id: version.basisRevisionId }, select: { id: true, sha256: true } }) : null,
      tx.workspaceStyleRevision.findUnique({ where: { workspaceId_revision: { workspaceId: version.workspaceId, revision: version.workspaceStyleRevision } }, select: { workspaceId: true, revision: true, brandbook: true, tone: true, settings: true, createdAt: true } }),
      version.inputMode === 'ARTICLE_DERIVED' && version.sourceArticleVersionId ? tx.articleVersion.findFirst({ where: { projectId: project, id: version.sourceArticleVersionId } }) : null,
    ]);
    if (!brief || !originalStyle || version.basisRevisionId && !basis || version.inputMode === 'ARTICLE_DERIVED' && !originalSourceArticle) throw new ConflictException('An immutable Telegram dependency is missing');
    const reviewed = version.reviewCounter > 0;
    const effectiveBriefId = reviewed ? version.reviewedBriefRevisionId : version.briefRevisionId;
    const effectiveBasisId = reviewed ? version.reviewedBasisRevisionId : version.basisRevisionId;
    const effectiveStyleRevision = reviewed ? version.reviewedWorkspaceStyleRevision ?? version.workspaceStyleRevision : version.workspaceStyleRevision;
    const effectiveSourceId = reviewed ? version.reviewedSourceArticleVersionId : version.sourceArticleVersionId;
    const effectiveSourceArticle = version.inputMode === 'ARTICLE_DERIVED' && effectiveSourceId
      ? await tx.articleVersion.findFirst({ where: { projectId: project, id: effectiveSourceId } }) : null;
    if (version.inputMode === 'ARTICLE_DERIVED' && !effectiveSourceArticle) throw new ConflictException('An effective Telegram article dependency is missing');
    const [effective, effectiveSourceArticleDetails, originalSourceArticleDetails] = await Promise.all([
      this.dependencySnapshot(tx, project, { briefRevisionId: effectiveBriefId, basisRevisionId: effectiveBasisId, outlineRevisionId: null,
        workspaceId: version.workspaceId, workspaceStyleRevision: effectiveStyleRevision }),
      effectiveSourceArticle ? this.articleProvenance(tx, project, effectiveSourceArticle) : null,
      originalSourceArticle ? this.articleProvenance(tx, project, originalSourceArticle) : null,
    ]);
    return { kind: 'TELEGRAM_POST', revisionId: version.id, number: version.number, sha256: version.sha256, contentMode: version.contentMode,
      inputMode: version.inputMode, includeLink: version.includeLink,
      approval: { actorId: version.approvedBy, approvedAt: iso(version.approvedAt), withdrawnBy: version.withdrawnBy, withdrawnAt: iso(version.withdrawnAt) },
      reviewCounter: version.reviewCounter, originalInputs: { briefRevisionId: version.briefRevisionId, briefSha256: brief.sha256,
        basisRevisionId: version.basisRevisionId, basisSha256: basis?.sha256 ?? null, sourceArticleVersionId: version.sourceArticleVersionId,
        sourceArticleSha256: originalSourceArticle?.sha256 ?? null, sourceArticle: originalSourceArticleDetails,
        workspaceId: version.workspaceId, workspaceStyleRevision: version.workspaceStyleRevision,
        workspaceStyleSha256: canonicalManifestHash({ brandbook: originalStyle.brandbook, tone: originalStyle.tone, settings: originalStyle.settings }) },
      reviewedTuple: version.reviewCounter > 0 ? { briefRevisionId: version.reviewedBriefRevisionId, basisRevisionId: version.reviewedBasisRevisionId,
        sourceArticleVersionId: version.reviewedSourceArticleVersionId, workspaceStyleRevision: version.reviewedWorkspaceStyleRevision,
        reviewedBy: version.reviewedBy, reviewedAt: iso(version.reviewedAt) } : null,
      effectiveDependencies: { ...effective, sourceArticle: effectiveSourceArticleDetails } };
  }

  private async selectedItem(tx: Prisma.TransactionClient, project: string, format: 'ARTICLE' | 'TELEGRAM_POST', revisionId: string, reviewCounter: number) {
    if (format === 'ARTICLE') {
      const article = await tx.article.findUnique({ where: { projectId: project } });
      const version = await tx.articleVersion.findFirst({ where: { projectId: project, id: revisionId, ...(article ? { articleId: article.id } : {}) }, include: { claims: true } });
      if (!article || !version || article.currentApprovedVersionId !== version.id || version.reviewCounter !== reviewCounter || !version.approvedAt || version.withdrawnAt) {
        throw new ConflictException('Select the current approved article revision with its latest review counter');
      }
      const inspection = await this.articles.inspectVersion(tx, project, version);
      if (!inspection.eligible) throw new ConflictException(`Article needs review: ${[...inspection.staleReasons, ...inspection.blockingReasons].join(', ')}`);
      const provenance = await this.articleProvenance(tx, project, version);
      const sources = await this.evidenceSources(tx, project, version.claims, version.id, 'SELECTED_ARTICLE');
      return { format, title: titleOf(format, version.content), revisionId: version.id, number: version.number,
        reviewCounter: version.reviewCounter, contentMode: version.contentMode, sha256: version.sha256,
        manifest: { format, revisionId: version.id, number: version.number, sha256: version.sha256, contentMode: version.contentMode,
          reviewCounter: version.reviewCounter, provenance }, sources, content: version.content, inspection };
    }
    const adaptation = await tx.adaptation.findUnique({ where: { projectId_format: { projectId: project, format: 'TELEGRAM_POST' } } });
    const version = await tx.adaptationRevision.findFirst({ where: { projectId: project, id: revisionId, ...(adaptation ? { adaptationId: adaptation.id } : {}) }, include: { claims: true } });
    if (!adaptation || !version || adaptation.currentApprovedRevisionId !== version.id || version.reviewCounter !== reviewCounter || !version.approvedAt || version.withdrawnAt) {
      throw new ConflictException('Select the current approved Telegram revision with its latest review counter');
    }
    const inspection = await this.telegram.inspectRevision(tx, project, version);
    if (!inspection.eligible) throw new ConflictException(`Telegram output needs review: ${[...inspection.staleReasons, ...inspection.blockingReasons].join(', ')}`);
    const provenance = await this.telegramProvenance(tx, project, version);
    const ownSources = await this.evidenceSources(tx, project, version.claims, version.id, 'SELECTED_TELEGRAM');
    const originalSource = version.inputMode === 'ARTICLE_DERIVED' && version.sourceArticleVersionId
      ? await tx.articleVersion.findFirst({ where: { projectId: project, id: version.sourceArticleVersionId }, include: { claims: true } }) : null;
    const effectiveSourceId = version.reviewCounter > 0 ? version.reviewedSourceArticleVersionId : version.sourceArticleVersionId;
    const effectiveSource = version.inputMode === 'ARTICLE_DERIVED' && effectiveSourceId
      ? await tx.articleVersion.findFirst({ where: { projectId: project, id: effectiveSourceId }, include: { claims: true } }) : null;
    if (version.inputMode === 'ARTICLE_DERIVED' && (!originalSource || !effectiveSource)) throw new ConflictException('Telegram source article lineage is missing');
    const parentSources = [
      ...(originalSource ? await this.evidenceSources(tx, project, originalSource.claims, version.id, 'ORIGINAL_SOURCE_ARTICLE') : []),
      ...(effectiveSource && effectiveSource.id !== originalSource?.id ? await this.evidenceSources(tx, project, effectiveSource.claims, version.id, 'REVIEWED_SOURCE_ARTICLE') : []),
    ];
    const sources = [...ownSources, ...parentSources];
    return { format, title: titleOf(format, version.content), revisionId: version.id, number: version.number,
      reviewCounter: version.reviewCounter, contentMode: version.contentMode, sha256: version.sha256,
      manifest: { format, revisionId: version.id, number: version.number, sha256: version.sha256, contentMode: version.contentMode,
        reviewCounter: version.reviewCounter, provenance }, sources, content: version.content, inspection };
  }

  private async readinessItems(tx: Prisma.TransactionClient, projectId: string, formats: string[]) {
    const items: Array<{ format: string; title: string; revisionId: string | null; number: number | null; reviewCounter: number | null; contentMode: string | null; ready: boolean; reasons: string[] }> = [];
    for (const format of [...formats].sort((a, b) => itemOrder(a) - itemOrder(b) || a.localeCompare(b))) {
      if (!supportedFormats.has(format)) {
        items.push({ format, title: format, revisionId: null, number: null, reviewCounter: null, contentMode: null, ready: false, reasons: ['FORMAT_NOT_IMPLEMENTED'] });
        continue;
      }
      if (format === 'ARTICLE') {
        const article = await tx.article.findUnique({ where: { projectId }, include: { currentApprovedVersion: { include: { claims: true } } } });
        const version = article?.currentApprovedVersion;
        if (!version) { items.push({ format, title: 'Стаття', revisionId: null, number: null, reviewCounter: null, contentMode: null, ready: false, reasons: ['APPROVAL_REQUIRED'] }); continue; }
        const inspection = await this.articles.inspectVersion(tx, projectId, version);
        const reasons = [...new Set([...(version.approvedAt ? [] : ['APPROVAL_REQUIRED']), ...inspection.staleReasons, ...inspection.blockingReasons])];
        items.push({ format, title: titleOf(format, version.content), revisionId: version.id, number: version.number, reviewCounter: version.reviewCounter,
          contentMode: version.contentMode, ready: inspection.eligible, reasons });
        continue;
      }
      const adaptation = await tx.adaptation.findUnique({ where: { projectId_format: { projectId, format: 'TELEGRAM_POST' } }, include: { currentApprovedRevision: { include: { claims: true } } } });
      const version = adaptation?.currentApprovedRevision;
      if (!version) { items.push({ format, title: 'Дописи Telegram', revisionId: null, number: null, reviewCounter: null, contentMode: null, ready: false, reasons: ['APPROVAL_REQUIRED'] }); continue; }
      const inspection = await this.telegram.inspectRevision(tx, projectId, version);
      const reasons = [...new Set([...(version.approvedAt ? [] : ['APPROVAL_REQUIRED']), ...inspection.staleReasons, ...inspection.blockingReasons])];
      items.push({ format, title: titleOf(format, version.content), revisionId: version.id, number: version.number, reviewCounter: version.reviewCounter,
        contentMode: version.contentMode, ready: inspection.eligible, reasons });
    }
    return items;
  }

  async readiness(userId: string, projectId: string) {
    return this.command(userId, projectId, async tx => {
      const project = await tx.project.findUniqueOrThrow({ where: { id: projectId }, select: { revision: true, formats: true } });
      const items = await this.readinessItems(tx, projectId, project.formats);
      const exports = await this.exportList(tx, projectId);
      return { projectRevision: project.revision, ready: items.length > 0 && items.every(item => item.ready), items, exports };
    });
  }

  private async exportList(tx: Prisma.TransactionClient, projectId: string) {
    const requests = await tx.exportRequest.findMany({ where: { projectId }, include: { job: true, artifact: true }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: 50 });
    const rows = [];
    for (const request of requests) {
      let status: string;
      if (request.job.status === 'CANCELLED') status = 'CANCELLED';
      else if (request.job.status === 'FAILED' || request.job.status === 'OUTCOME_UNKNOWN') status = 'FAILED';
      else if (request.job.status === 'SUCCEEDED') status = request.artifact
        ? await this.manifestMatches(tx, request.projectId, request.manifest, request.manifestHash) ? 'READY' : 'OBSOLETE' : 'FAILED';
      else if (request.job.status === 'RUNNING' || request.job.status === 'RETRY_WAIT') status = 'BUILDING';
      else status = 'REQUESTED';
      rows.push({ id: request.id, format: request.format, status, createdAt: request.createdAt.toISOString(), jobId: request.jobId,
        retryAllowed: retryAllowed(request.job), errorCategory: request.job.errorCategory, filename: status === 'READY' ? request.artifact?.filename ?? null : null });
    }
    return rows;
  }

  async freeze(userId: string, projectId: string, raw: CreateExportInput) {
    const input = createExportInput.parse(raw);
    return this.command(userId, projectId, async tx => {
      const commandHash = canonicalManifestHash(input);
      // Idempotent lost-response replays are resolved before mutable project state checks.
      const existing = await tx.job.findUnique({ where: { projectId_operation_commandKey: { projectId, operation: 'EXPORT_BUILD', commandKey: input.commandKey } } });
      if (existing) {
        const replay = exportJobManifestSchema.safeParse(existing.inputManifest);
        if (!replay.success || replay.data.commandHash !== commandHash) throw new ConflictException('Export command key belongs to different frozen inputs');
        const request = await tx.exportRequest.findFirst({ where: { projectId, jobId: existing.id } });
        if (!request || request.id !== replay.data.requestId) throw new ConflictException('Export command replay has no matching immutable request');
        return { exportId: request.id, jobId: existing.id };
      }
      const project = await tx.project.findUniqueOrThrow({ where: { id: projectId }, select: { revision: true, formats: true } });
      if (project.revision !== input.expectedProjectRevision) throw new ConflictException('Project changed; review the current export selection');
      if (input.items.some(item => !project.formats.includes(item.format))) throw new ConflictException('Export selection contains an unselected project format');

      const items = [];
      for (const selected of [...input.items].sort((a, b) => itemOrder(a.format) - itemOrder(b.format))) {
        const item = await this.selectedItem(tx, projectId, selected.format, selected.revisionId, selected.reviewCounter);
        items.push(item);
      }
      const sources = await this.allSources(items.map(item => item.sources));
      const manifest = exportManifestSchema.parse({ schemaVersion: 'export-manifest-v1', projectId, projectRevision: project.revision,
        formats: items.map(item => item.format), format: input.format, frozenAt: new Date().toISOString(),
        items: items.map(item => item.manifest), sources });
      const manifestHash = canonicalManifestHash(manifest);
      const requestId = randomUUID();
      const inputManifest = exportJobManifestSchema.parse({ schemaVersion: 'export-job-v1', requestId, manifestHash, commandHash });
      await this.jobs.assertEffects(tx, projectId, userId, this.assets.config.driver === 'supabase');
      const job = await this.jobs.create(tx, { projectId, userId, operation: 'EXPORT_BUILD', contractVersion: EXPORT_CONTRACT,
        commandKey: input.commandKey, inputManifest: json(inputManifest) as Prisma.InputJsonObject });
      const request = await tx.exportRequest.create({ data: { id: requestId, projectId, requestedBy: userId, jobId: job.id,
        format: input.format, manifest: json(manifest) as Prisma.InputJsonObject, manifestHash } });
      await tx.exportItem.createMany({ data: items.map((item, ordinal) => ({ id: randomUUID(), projectId, requestId: request.id, ordinal,
        articleVersionId: item.format === 'ARTICLE' ? item.revisionId : null,
        adaptationRevisionId: item.format === 'TELEGRAM_POST' ? item.revisionId : null })) });
      await tx.exportRequest.update({ where: { id: request.id }, data: { itemsSealed: true } });
      return { exportId: request.id, jobId: job.id };
    }, true);
  }

  private async allSources(groups: Array<Array<Record<string, unknown>>>) {
    const byKey = new Map<string, Record<string, unknown> & { usedBy: Array<{ revisionId: string; role: string }> }>();
    for (const source of groups.flat()) {
      const key = `${String(source.claimRevisionId)}:${String(source.evidenceId)}`;
      const existing = byKey.get(key);
      const usage = { revisionId: String(source.usedByRevisionId), role: String(source.originRole) };
      if (existing) {
        if (!existing.usedBy.some(row => row.revisionId === usage.revisionId && row.role === usage.role)) existing.usedBy.push(usage);
      } else {
        const details = { ...source };
        delete details.usedByRevisionId;
        delete details.originRole;
        byKey.set(key, { ...details, usedBy: [usage] });
      }
    }
    const sources = [...byKey.values()];
    for (const source of sources) source.usedBy.sort((a, b) => a.revisionId.localeCompare(b.revisionId) || a.role.localeCompare(b.role));
    sources.sort((a, b) => String(a.snapshotId).localeCompare(String(b.snapshotId))
      || Number(a.startOffset) - Number(b.startOffset) || String(a.claimRevisionId).localeCompare(String(b.claimRevisionId))
      || String(a.evidenceId).localeCompare(String(b.evidenceId)));
    if (sources.length > 10_000) throw new ConflictException('Export source list exceeds its limit');
    return sources;
  }

  private async manifestMatches(tx: Prisma.TransactionClient, projectId: string, manifestInput: unknown, expectedHash: string) {
    const parsed = exportManifestSchema.safeParse(manifestInput);
    if (!parsed.success || parsed.data.projectId !== projectId || canonicalManifestHash(parsed.data) !== expectedHash) return false;
    const manifest = parsed.data;
    const project = await tx.project.findFirst({ where: { id: projectId, archivedAt: null, formats: { hasEvery: manifest.items.map(item => item.format) } }, select: { id: true } });
    if (!project) return false;
    const items = [];
    for (const frozen of manifest.items) {
      let current: Awaited<ReturnType<ExportService['selectedItem']>>;
      try {
        current = await this.selectedItem(tx, projectId, frozen.format, frozen.revisionId, frozen.reviewCounter);
      } catch (error) {
        if (error instanceof BadRequestException || error instanceof ConflictException || error instanceof NotFoundException || error instanceof ZodError) return false;
        throw error;
      }
      if (comparisonHash(current.manifest) !== comparisonHash(frozen)) return false;
      items.push(current);
    }
    const sources = await this.allSources(items.map(item => item.sources));
    return comparisonHash(sources) === comparisonHash(manifest.sources);
  }

  private async frozenRequest(tx: Prisma.TransactionClient, job: Job) {
    if (job.operation !== 'EXPORT_BUILD' || job.contractVersion !== EXPORT_CONTRACT
      || canonicalManifestHash({ contractVersion: job.contractVersion, inputManifest: job.inputManifest }) !== job.inputHash) throw new JobFailure('INPUT_INTEGRITY', 'NOT_SUBMITTED');
    const jobManifest = exportJobManifestSchema.safeParse(job.inputManifest);
    if (!jobManifest.success) throw new JobFailure('INPUT_INTEGRITY', 'NOT_SUBMITTED');
    const request = await tx.exportRequest.findFirst({ where: { id: jobManifest.data.requestId, projectId: job.projectId, jobId: job.id }, include: { items: { orderBy: { ordinal: 'asc' } } } });
    if (!request || !request.itemsSealed || request.manifestHash !== jobManifest.data.manifestHash
      || !exportManifestSchema.safeParse(request.manifest).success || canonicalManifestHash(request.manifest) !== request.manifestHash
      || request.items.length !== (request.manifest as unknown as ExportManifest).items.length) throw new JobFailure('INPUT_INTEGRITY', 'NOT_SUBMITTED');
    const manifest = exportManifestSchema.parse(request.manifest);
    const refsMatch = request.items.every((item, index) => {
      const target = manifest.items[index];
      return !!target && item.ordinal === index && item.projectId === job.projectId
        && (target.format === 'ARTICLE' ? item.articleVersionId === target.revisionId && item.adaptationRevisionId === null
          : item.adaptationRevisionId === target.revisionId && item.articleVersionId === null);
    });
    if (!refsMatch) throw new JobFailure('INPUT_INTEGRITY', 'NOT_SUBMITTED');
    if (!await this.manifestMatches(tx, job.projectId, manifest, request.manifestHash)) throw new JobFailure('INPUTS_CHANGED', 'KNOWN_FAILED');
    return { request, manifest };
  }

  async build(job: Job, signal?: AbortSignal): Promise<FrozenStage> {
    const { manifest } = await this.prisma.$transaction(tx => this.frozenRequest(tx, job), { maxWait: 5_000, timeout: 30_000 });
    const contents = new Map<string, { kind: 'ARTICLE' | 'TELEGRAM_POST'; content: unknown }>();
    for (const item of manifest.items) {
      if (item.format === 'ARTICLE') {
        const version = await this.prisma.articleVersion.findFirst({ where: { id: item.revisionId, projectId: job.projectId }, select: { content: true, sha256: true } });
        if (!version || version.sha256 !== item.sha256 || canonicalManifestHash(version.content) !== item.sha256) throw new JobFailure('INPUTS_CHANGED', 'KNOWN_FAILED');
        contents.set(item.revisionId, { kind: 'ARTICLE', content: version.content });
      } else {
        const version = await this.prisma.adaptationRevision.findFirst({ where: { id: item.revisionId, projectId: job.projectId }, select: { content: true, sha256: true } });
        if (!version || version.sha256 !== item.sha256 || canonicalManifestHash(version.content) !== item.sha256) throw new JobFailure('INPUTS_CHANGED', 'KNOWN_FAILED');
        contents.set(item.revisionId, { kind: 'TELEGRAM_POST', content: version.content });
      }
    }
    const rendered = renderExportFiles(manifest, contents);
    const file = manifest.format === 'ZIP'
      ? { bytes: zipExportFiles(rendered), contentType: 'application/zip', filename: 'contextflow-export.zip' }
      : { bytes: rendered[0]!.bytes, contentType: rendered[0]!.contentType, filename: rendered[0]!.name };
    if (signal?.aborted) throw new JobFailure('CANCELLED', 'NOT_SUBMITTED');
    const assetId = randomUUID(), sha256 = createHash('sha256').update(file.bytes).digest('hex');
    let stored: { bucket: string; objectKey: string };
    if (this.assets.config.driver === 'supabase') await this.prisma.$transaction(tx => this.jobs.assertEffects(tx, job.projectId, job.requestedBy, true), { maxWait: 5_000, timeout: 10_000 });
    if (signal?.aborted) throw new JobFailure('CANCELLED', 'NOT_SUBMITTED');
    try { stored = await this.assets.putExport(job.projectId, assetId, file.bytes); }
    catch { throw new JobFailure('TRANSIENT_TRANSPORT', 'NOT_SUBMITTED'); }
    if (signal?.aborted) {
      await this.cleanupStaged({ bucket: stored.bucket, objectKey: stored.objectKey });
      throw new JobFailure('CANCELLED', 'NOT_SUBMITTED');
    }
    return { assetId, bucket: stored.bucket, objectKey: stored.objectKey, sha256, byteSize: file.bytes.byteLength, contentType: file.contentType, filename: file.filename };
  }

  async commit(tx: Prisma.TransactionClient, job: Job, result: unknown): Promise<Prisma.InputJsonValue> {
    await this.lock(tx, job.requestedBy, job.projectId, true);
    await this.jobs.assertEffects(tx, job.projectId, job.requestedBy, this.assets.config.driver === 'supabase');
    const frozen = await this.frozenRequest(tx, job);
    const staged = record(result);
    if (!staged || typeof staged.assetId !== 'string' || typeof staged.bucket !== 'string' || typeof staged.objectKey !== 'string'
      || typeof staged.sha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(staged.sha256) || !Number.isInteger(staged.byteSize) || Number(staged.byteSize) < 1
      || Number(staged.byteSize) > 10 * 1024 * 1024 || typeof staged.contentType !== 'string' || typeof staged.filename !== 'string'
      || !/^[a-z0-9][a-z0-9._-]{0,199}$/iu.test(staged.filename)) throw new JobFailure('INVALID_CONTRACT', 'KNOWN_FAILED');
    const asset = await tx.asset.create({ data: { id: staged.assetId, projectId: job.projectId, bucket: staged.bucket, objectKey: staged.objectKey,
      mediaType: staged.contentType.split(';', 1)[0]!.trim(), bytes: BigInt(Number(staged.byteSize)), sha256: staged.sha256, state: 'AVAILABLE', purpose: 'EXPORT', createdBy: job.requestedBy } });
    const artifact = await tx.exportArtifact.create({ data: { id: randomUUID(), projectId: job.projectId, requestId: frozen.request.id, assetId: asset.id,
      sha256: staged.sha256, byteSize: Number(staged.byteSize), contentType: staged.contentType, filename: staged.filename } });
    return { exportId: frozen.request.id, artifactId: artifact.id, filename: artifact.filename };
  }

  async cleanupStaged(result: unknown): Promise<void> {
    const staged = record(result);
    if (!staged || typeof staged.bucket !== 'string' || typeof staged.objectKey !== 'string') return;
    const referenced = await this.prisma.asset.findFirst({ where: { bucket: staged.bucket, objectKey: staged.objectKey }, select: { id: true } });
    if (referenced) return;
    try { await this.assets.remove(staged.bucket, staged.objectKey); }
    catch {
      // Retry this exact unreferenced stage once. Surface persistent cleanup failure to the job handler.
      await this.assets.remove(staged.bucket, staged.objectKey);
    }
  }

  private async authorizedRequest(userId: string, projectId: string, requestId: string) {
    return this.command(userId, projectId, async tx => {
      const request = await tx.exportRequest.findFirst({ where: { id: requestId, projectId,
        project: { archivedAt: null, workspace: { archivedAt: null, members: { some: { userId, leftAt: null } } } },
        artifact: { isNot: null }, job: { status: 'SUCCEEDED' } }, include: { artifact: { include: { asset: true } }, job: true } });
      if (!request?.artifact || request.artifact.asset.state !== 'AVAILABLE' || request.artifact.asset.purpose !== 'EXPORT'
        || request.artifact.asset.projectId !== projectId || request.artifact.projectId !== projectId || !request.itemsSealed) throw new NotFoundException('Export not found');
      if (!await this.manifestMatches(tx, projectId, request.manifest, request.manifestHash)) throw new ConflictException('Export is obsolete; create a new export from current approved revisions');
      return request;
    });
  }

  async download(userId: string, projectId: string, requestId: string) {
    const request = await this.authorizedRequest(userId, projectId, requestId);
    const asset = request.artifact!.asset;
    const bytes = await this.assets.read(asset.bucket, asset.objectKey, asset.sha256);
    if (BigInt(bytes.byteLength) !== asset.bytes || asset.sha256 !== request.artifact!.sha256 || bytes.byteLength !== request.artifact!.byteSize) {
      throw new ServiceUnavailableException('Stored export failed integrity checks');
    }
    await this.assertDownloadReadable(userId, projectId, requestId);
    return { bytes, filename: request.artifact!.filename, contentType: request.artifact!.contentType };
  }

  async assertDownloadReadable(userId: string, projectId: string, requestId: string): Promise<void> {
    await this.authorizedRequest(userId, projectId, requestId);
  }
}

export { createExportInput };
