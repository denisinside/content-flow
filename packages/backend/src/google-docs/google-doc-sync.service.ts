import { ConflictException, ForbiddenException, NotFoundException, UnauthorizedException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { Prisma, PrismaClient } from '../generated/prisma/client.js';
import type { DurableJobService } from '../jobs/job-service.js';
import { canonicalManifestHash } from '../jobs/job-service.js';
import type { ArticleService } from '../editorial/article.service.js';
import { articleContentSchema, articleDocumentDetails, type ArticleNode } from '../editorial/article-contracts.js';
import { EXTERNAL_PROCESSING_NOTICE } from '../external-processing-notice.js';
import { jobView } from '../jobs/contracts.js';
import type { GoogleSyncCredentials } from './google-sync-credentials.js';
import { googleTabToArticleContent } from './article-conversion.js';
import { buildGoogleSyncPlan, extractGoogleThreads, mapArticleRangeToGoogle } from './sync-conversion.js';
import type { GoogleDocsDocument, GoogleDocsRange, GoogleDocsRequest } from './google-docs-client.js';
import type {
  GoogleSyncActor, GoogleSyncBackgroundInput, GoogleSyncConfirmInput, GoogleSyncPreview,
  GoogleSyncPreviewInput, GoogleSyncPullInput, GoogleSyncReconcileInput, GoogleSyncStatus,
} from './google-doc-sync-contracts.js';

const CONTRACT = 'google-doc-sync-v1';
const PREVIEW_TTL_MS = 20 * 60_000;
const POLL_INTERVAL_MS = 60_000;
type SyncKind = 'PUSH' | 'PULL' | 'RECONCILE' | 'COMMENT_CREATE' | 'COMMENT_REPLY' | 'COMMENT_RESOLVE' | 'COMMENT_REOPEN' | 'SUGGESTION_CREATE' | 'SUGGESTION_ACCEPT' | 'SUGGESTION_REJECT';
type BindingRow = { id: string; projectId: string; connectionId: string; connectionUserId: string; documentId: string; tabId: string; endedAt: Date | null; createdAt: Date };
type SnapshotData = { document: GoogleDocsDocument; content: unknown; plainText: string; threads: ReturnType<typeof extractGoogleThreads>; contentHash: string };
type FrozenPreview = {
  schemaVersion: 'google-sync-preview-v1'; kind: SyncKind; bindingId: string; connectionId: string; sessionId: string; noticeAcceptedAt: string;
  sourceVersionId: string | null; expectedArticleRevision: number; snapshotId: string; remoteRevision: string;
  localContent: unknown; remoteContent: unknown; baselineContent: unknown; hasConflict: boolean;
  requests: GoogleDocsRequest[]; writeMode: 'EDIT' | 'SUGGEST' | null; beforeCommittedHash: string;
  expectedPlainText: string; expectedSuggestionParts: unknown[]; expectedThread: { kind: 'comment' | 'suggestion'; status: string; content?: string; quoteText: string | null; ranges: GoogleDocsRange[] } | null;
  targetRanges: GoogleDocsRange[]; unsupported: unknown[]; payload: Record<string, unknown>;
};

function json(value: unknown): Prisma.InputJsonValue { return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue; }
function object(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
export function canonicalGoogleArticleDocument(value: unknown): unknown {
  const parsed = articleContentSchema.parse(value);
  const stable = (value: unknown): string => JSON.stringify(value, (_key, child: unknown) => {
    if (!child || typeof child !== 'object' || Array.isArray(child)) return child;
    return Object.fromEntries(Object.entries(child as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)));
  });
  const normalize = (node: ArticleNode): ArticleNode => {
    const marks = node.marks?.filter(mark => mark.type !== 'evidence').sort((a, b) => stable(a).localeCompare(stable(b)));
    const content = node.content?.map(normalize).reduce<ArticleNode[]>((rows, child) => {
      const prior = rows.at(-1);
      if (prior?.type === 'text' && child.type === 'text' && stable(prior.marks ?? []) === stable(child.marks ?? [])) {
        rows[rows.length - 1] = { ...prior, text: `${prior.text ?? ''}${child.text ?? ''}` };
      } else rows.push(child);
      return rows;
    }, []);
    const rest = { ...node };
    delete rest.marks;
    delete rest.content;
    return { ...rest, ...(marks?.length ? { marks } : {}), ...(content ? { content } : {}) };
  };
  return { document: normalize(parsed.document) };
}
function contentHash(value: unknown): string { return canonicalManifestHash(canonicalGoogleArticleDocument(value)); }
function frozen(value: unknown): FrozenPreview {
  const row = object(value);
  if (row.schemaVersion !== 'google-sync-preview-v1' || typeof row.kind !== 'string' || !Array.isArray(row.requests)
    || typeof row.snapshotId !== 'string' || typeof row.remoteRevision !== 'string') throw new ConflictException('Frozen Google Docs preview is invalid');
  return row as unknown as FrozenPreview;
}

/** Google-specific synchronization journal. Provider credentials and tokens never leave GoogleSyncCredentials. */
export class GoogleDocSyncService {
  constructor(readonly prisma: PrismaClient, private readonly jobs: DurableJobService, private readonly articles: ArticleService,
    private readonly credentials: GoogleSyncCredentials) {}

  private async lockProject(tx: Prisma.TransactionClient, actor: GoogleSyncActor, projectId: string, write = false): Promise<void> {
    const rows = write
      ? await tx.$queryRaw<Array<{ id: string }>>`SELECT p."id" FROM contextflow."Project" p JOIN contextflow."Workspace" w ON w."id"=p."workspaceId" JOIN contextflow."WorkspaceMember" m ON m."workspaceId"=w."id" WHERE p."id"=${projectId}::uuid AND p."archivedAt" IS NULL AND w."archivedAt" IS NULL AND m."userId"=${actor.userId}::uuid AND m."leftAt" IS NULL FOR UPDATE OF p FOR SHARE OF w,m`
      : await tx.$queryRaw<Array<{ id: string }>>`SELECT p."id" FROM contextflow."Project" p JOIN contextflow."Workspace" w ON w."id"=p."workspaceId" JOIN contextflow."WorkspaceMember" m ON m."workspaceId"=w."id" WHERE p."id"=${projectId}::uuid AND p."archivedAt" IS NULL AND w."archivedAt" IS NULL AND m."userId"=${actor.userId}::uuid AND m."leftAt" IS NULL FOR SHARE OF p,w,m`;
    if (!rows.length) throw new NotFoundException('Project not found');
  }
  private async lockManual(tx: Prisma.TransactionClient, actor: GoogleSyncActor, projectId: string, binding: BindingRow, connectionId: string, write = false): Promise<void> {
    await this.lockProject(tx, actor, projectId, write);
    await this.lockActor(tx, actor);
    const current = await tx.googleDocBinding.findFirst({ where: { id: binding.id, projectId, endedAt: null }, select: { id: true } });
    if (!current) throw new ForbiddenException('Google Docs binding is no longer active');
    const connection = await tx.googleDriveConnection.findFirst({ where: { id: connectionId, userId: actor.userId, revokedAt: null }, select: { id: true } });
    if (!connection) throw new ForbiddenException('Google connection is unavailable');
  }
  private async normalizeOperationJournals(tx: Prisma.TransactionClient, bindingId: string): Promise<void> {
    const rows = await tx.googleDocSyncOperation.findMany({ where: { bindingId, state: { in: ['QUEUED', 'SUBMITTED'] } }, include: { job: true } });
    for (const row of rows) {
      if (['RUNNING', 'QUEUED', 'RETRY_WAIT'].includes(row.job.status)) continue;
      const attempt = await tx.jobAttempt.findFirst({ where: { jobId: row.jobId }, orderBy: { ordinal: 'desc' }, select: { providerSubmittedAt: true } });
      const externalUnknown = row.state === 'SUBMITTED'
        && (!!attempt?.providerSubmittedAt || ['UNKNOWN', 'MAY_STILL_RUN'].includes(row.job.providerOutcome));
      const next = externalUnknown ? 'UNKNOWN' : row.job.status === 'CANCELLED' ? 'CANCELLED' : 'FAILED';
      const updatedAt = new Date(Math.max(Date.now(), row.updatedAt.getTime() + 1));
      await tx.googleDocSyncOperation.update({ where: { id: row.id }, data: { state: next, updatedAt } });
    }
  }
  private async lockActor(tx: Prisma.TransactionClient, actor: GoogleSyncActor): Promise<void> {
    const sessions = await tx.$queryRaw<Array<{ expiresAt: Date; lastUserActivityAt: Date; idleTimeoutMinutes: number; acceptedAt: Date | null; noticeVersion: string | null }>>`
      SELECT s."expiresAt",s."lastUserActivityAt",u."idleTimeoutMinutes",u."externalProcessingAcceptedAt" AS "acceptedAt",u."externalProcessingNoticeVersion" AS "noticeVersion"
      FROM contextflow."AppSession" s JOIN contextflow."UserProfile" u ON u."id"=s."userId"
      WHERE s."id"=${actor.sessionId}::uuid AND s."userId"=${actor.userId}::uuid AND s."revokedAt" IS NULL FOR SHARE OF s,u`;
    const session = sessions[0];
    if (!session || session.expiresAt <= new Date() || Date.now() - session.lastUserActivityAt.getTime() >= session.idleTimeoutMinutes * 60_000) throw new UnauthorizedException('Session expired');
    if (session.noticeVersion !== EXTERNAL_PROCESSING_NOTICE.version || session.acceptedAt?.getTime() !== actor.noticeAcceptedAt.getTime()) throw new ForbiddenException('External processing consent changed');
  }
  private async binding(projectId: string, userId?: string): Promise<BindingRow> {
    void userId;
    const row = await this.prisma.googleDocBinding.findFirst({ where: { projectId, endedAt: null } });
    if (!row) throw new NotFoundException('Active Google Docs binding not found');
    return row;
  }
  private async authorizeProject(actor: GoogleSyncActor, projectId: string): Promise<void> {
    await this.prisma.$transaction(async tx => { await this.lockProject(tx, actor, projectId); await this.lockActor(tx, actor); });
  }
  private credentialContext(actor: GoogleSyncActor, projectId: string, binding: BindingRow, connectionId: string, sessionId: string | null = actor.sessionId, backgroundGeneration: number | null = null, signal?: AbortSignal) {
    return { projectId, bindingId: binding.id, userId: actor.userId, connectionId, sessionId,
      noticeAcceptedAt: actor.noticeAcceptedAt, backgroundGeneration, ...(signal ? { signal } : {}) };
  }
  private async providerSnapshot(actor: GoogleSyncActor, projectId: string, binding: BindingRow, connectionId: string,
    sessionId: string | null = actor.sessionId, backgroundGeneration: number | null = null, signal?: AbortSignal): Promise<SnapshotData> {
    const document = await this.credentials.withClient(this.credentialContext(actor, projectId, binding, connectionId, sessionId, backgroundGeneration, signal), client => client.getDocument(binding.documentId));
    if (document.documentId !== binding.documentId) throw new ConflictException('Google returned a different document');
    const converted = googleTabToArticleContent(document, binding.tabId);
    const contentHash = canonicalManifestHash({ document, tabId: binding.tabId });
    return { document, content: converted.content, plainText: converted.plainText, threads: extractGoogleThreads(document, binding.tabId), contentHash };
  }
  async persistSnapshot(tx: Prisma.TransactionClient, actor: GoogleSyncActor, projectId: string, bindingId: string, data: SnapshotData) {
    const existing = await tx.googleDocSnapshot.findFirst({ where: { projectId, bindingId, remoteRevision: data.document.revisionId, contentHash: data.contentHash } });
    const imported = googleTabToArticleContent(data.document, (await tx.googleDocBinding.findUniqueOrThrow({ where: { id: bindingId } })).tabId);
    const snapshot = existing ?? await tx.googleDocSnapshot.create({ data: { id: randomUUID(), projectId, bindingId,
      remoteRevision: data.document.revisionId, payload: json(data.document), converted: json({ ...imported, content: imported.content, googleFileName: data.document.title }),
      contentHash: data.contentHash, capturedBy: actor.userId } });
    const state = await tx.googleDocSyncState.upsert({ where: { bindingId }, create: { bindingId, projectId, status: 'READY', latestSnapshotId: snapshot.id, lastReadAt: new Date() },
      update: { latestSnapshotId: snapshot.id, lastReadAt: new Date(), status: 'READY', errorCategory: null, updatedAt: new Date() } });
    const observedIds = new Set<string>();
    for (const thread of data.threads) {
      observedIds.add(`${thread.kind.toUpperCase()}:${thread.remoteId}`);
      const previous = await tx.googleDocRemoteThread.findUnique({ where: { bindingId_kind_remoteId: { bindingId, kind: thread.kind.toUpperCase(), remoteId: thread.remoteId } } });
      const payload = json({ ...thread.payload, projectAnchorStatus: thread.anchorStatus, projectSuggestionParts: thread.suggestionParts,
        localPostLinks: object(previous?.payloadJson).localPostLinks ?? {} });
      const row = await tx.googleDocRemoteThread.upsert({ where: { bindingId_kind_remoteId: { bindingId, kind: thread.kind.toUpperCase(), remoteId: thread.remoteId } },
        create: { id: randomUUID(), projectId, bindingId, remoteId: thread.remoteId, kind: thread.kind.toUpperCase(), status: thread.status,
          payloadJson: payload, quoteText: thread.quoteText ?? '', rangesJson: json(thread.ranges), authorJson: json(thread.author ?? {}), latestSnapshotId: snapshot.id },
        update: { status: thread.status, payloadJson: payload, quoteText: thread.quoteText ?? '', rangesJson: json(thread.ranges), authorJson: json(thread.author ?? {}), latestSnapshotId: snapshot.id, updatedAt: new Date(Math.max(Date.now(), (previous?.updatedAt.getTime() ?? 0) + 1)) } });
      const observation = json({ remoteId: thread.remoteId, kind: thread.kind, status: thread.status, payload: thread.payload, ranges: thread.ranges, quoteText: thread.quoteText });
      const eventHash = canonicalManifestHash(observation);
      await tx.googleDocAnnotationEvent.createMany({ data: [{ id: randomUUID(), projectId, bindingId, threadId: row.id, snapshotId: snapshot.id, eventHash, payloadJson: observation }], skipDuplicates: true });
    }
    const missing = await tx.googleDocRemoteThread.findMany({ where: { bindingId, latestSnapshotId: { not: snapshot.id } } });
    for (const row of missing) {
      if (observedIds.has(`${row.kind}:${row.remoteId}`)) continue;
      const observation = json({ remoteId: row.remoteId, kind: row.kind.toLowerCase(), status: 'MISSING', anchorStatus: 'missing' });
      const eventHash = canonicalManifestHash(observation);
      await tx.googleDocRemoteThread.update({ where: { id: row.id }, data: { status: 'MISSING', rangesJson: json([]),
        payloadJson: json({ ...object(row.payloadJson), projectAnchorStatus: 'missing' }), latestSnapshotId: snapshot.id,
        updatedAt: new Date(Math.max(Date.now(), row.updatedAt.getTime() + 1)) } });
      await tx.googleDocAnnotationEvent.createMany({ data: [{ id: randomUUID(), projectId, bindingId, threadId: row.id, snapshotId: snapshot.id, eventHash, payloadJson: observation }], skipDuplicates: true });
    }
    return { snapshot, state };
  }
  private async articleState(tx: Prisma.TransactionClient, projectId: string, versionId?: string | null) {
    const article = await tx.article.findUnique({ where: { projectId }, include: { draft: true } });
    const selected = versionId ? await tx.articleVersion.findFirst({ where: { projectId, id: versionId } })
      : article?.draft?.baseVersionId ? await tx.articleVersion.findFirst({ where: { projectId, id: article.draft.baseVersionId } })
        : await tx.articleVersion.findFirst({ where: { projectId }, orderBy: { number: 'desc' } });
    if (!selected) throw new NotFoundException('Saved Article version not found');
    const content = articleContentSchema.parse(selected.content);
    if (canonicalManifestHash(content) !== selected.sha256) throw new ConflictException('Saved Article version failed integrity checks');
    return { article, version: selected, content };
  }
  private async readAndPersist(actor: GoogleSyncActor, projectId: string, binding: BindingRow, connectionId: string): Promise<{ snapshotId: string; data: SnapshotData }> {
    const data = await this.providerSnapshot(actor, projectId, binding, connectionId);
    const stored = await this.prisma.$transaction(async tx => {
      await this.lockManual(tx, actor, projectId, binding, connectionId);
      return this.persistSnapshot(tx, actor, projectId, binding.id, data);
    });
    return { snapshotId: stored.snapshot.id, data };
  }

  async status(actor: GoogleSyncActor, projectId: string, targetVersionId?: string): Promise<GoogleSyncStatus> {
    await this.authorizeProject(actor, projectId);
    const binding = await this.binding(projectId);
    await this.prisma.$transaction(async tx => {
      await this.lockProject(tx, actor, projectId);
      await this.lockActor(tx, actor);
      const state = await tx.googleDocSyncState.findUnique({ where: { bindingId: binding.id }, select: { bindingId: true } });
      if (state) await tx.$queryRaw`SELECT "bindingId" FROM contextflow."GoogleDocSyncState" WHERE "bindingId"=${binding.id}::uuid FOR UPDATE`;
      await this.normalizeOperationJournals(tx, binding.id);
    });
    const [state, threads, annotations, versions, operations, baseline, latest, article] = await Promise.all([
      this.prisma.googleDocSyncState.findUnique({ where: { bindingId: binding.id } }),
      this.prisma.googleDocRemoteThread.findMany({ where: { bindingId: binding.id }, orderBy: { createdAt: 'asc' } }),
      this.prisma.articleAnnotation.findMany({ where: { projectId }, include: { posts: { orderBy: { createdAt: 'asc' } } }, orderBy: { createdAt: 'asc' } }),
      this.prisma.articleVersion.findMany({ where: { projectId }, orderBy: { number: 'desc' }, take: 30, select: { id: true, number: true, plainText: true, sha256: true, origin: true, approvedAt: true, withdrawnAt: true, createdAt: true } }),
      this.prisma.googleDocSyncOperation.findMany({ where: { projectId, bindingId: binding.id }, include: { job: true }, orderBy: { createdAt: 'desc' }, take: 20 })
        .then(async recent => {
          const active = await this.prisma.googleDocSyncOperation.findMany({ where: { projectId, bindingId: binding.id, state: { in: ['QUEUED', 'SUBMITTED', 'UNKNOWN', 'PARTIAL'] } }, include: { job: true }, orderBy: { createdAt: 'desc' } });
          const seen = new Set(recent.map(row => row.id));
          return [...recent, ...active.filter(row => !seen.has(row.id))];
        }),
      this.prisma.googleDocSyncState.findUnique({ where: { bindingId: binding.id } }).then(row => row?.baselineSnapshotId
        ? this.prisma.googleDocSnapshot.findFirst({ where: { id: row.baselineSnapshotId, projectId, bindingId: binding.id } }) : null),
      this.prisma.googleDocSyncState.findUnique({ where: { bindingId: binding.id } }).then(row => row?.latestSnapshotId
        ? this.prisma.googleDocSnapshot.findFirst({ where: { id: row.latestSnapshotId, projectId, bindingId: binding.id } }) : null),
      this.articleStateForStatus(projectId, targetVersionId),
    ]);
    const selectedText = article?.plainText ?? '';
    await this.prisma.$transaction(async tx => { await this.lockProject(tx, actor, projectId); await this.lockActor(tx, actor); });
    return {
      binding: { id: binding.id, projectId, documentId: binding.documentId, tabId: binding.tabId, createdAt: binding.createdAt.toISOString() },
      state, threads: threads.map(row => ({ id: row.id, remoteId: row.remoteId, kind: row.kind.toLowerCase() as 'comment' | 'suggestion', status: row.status,
        payload: row.payloadJson, quoteText: row.quoteText || null, ranges: Array.isArray(row.rangesJson) ? row.rangesJson : [],
        anchorStatus: object(row.payloadJson).projectAnchorStatus === 'anchored' ? 'anchored' : 'unanchored',
        author: row.authorJson, localAnnotationId: row.localAnnotationId, createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString() })),
      localAnnotations: annotations.map(row => ({ ...row, anchor: row.articleVersionId === article?.id ? { status: 'anchored', start: row.anchorStart, end: row.anchorEnd } : { status: 'unanchored', start: null, end: null } })), versions,
      operations: operations.map(op => ({ id: op.id, kind: op.kind, state: op.state, jobId: op.jobId, job: jobView(op.job),
        resultVersionId: op.resultVersionId, createdAt: op.createdAt, updatedAt: op.updatedAt })),
      baseline: baseline ? { snapshotId: baseline.id, remoteRevision: baseline.remoteRevision, content: baseline.converted, capturedAt: baseline.capturedAt.toISOString() } : null,
      localPreview: { versionId: article?.id ?? null, text: selectedText },
      remotePreview: latest ? { snapshotId: latest.id, remoteRevision: latest.remoteRevision, content: latest.converted, capturedAt: latest.capturedAt.toISOString() } : null,
    };
  }
  private async articleStateForStatus(projectId: string, versionId?: string) {
    if (versionId) return this.prisma.articleVersion.findFirst({ where: { projectId, id: versionId }, select: { id: true, plainText: true } });
    const article = await this.prisma.article.findUnique({ where: { projectId }, include: { draft: true } });
    const versionIdFromDraft = article?.draft?.baseVersionId;
    return versionIdFromDraft ? this.prisma.articleVersion.findFirst({ where: { projectId, id: versionIdFromDraft }, select: { id: true, plainText: true } }) : null;
  }

  async preview(actor: GoogleSyncActor, projectId: string, input: GoogleSyncPreviewInput): Promise<GoogleSyncPreview> {
    await this.authorizeProject(actor, projectId);
    const binding = await this.binding(projectId, actor.userId);
    const [{ snapshotId, data }, article] = await Promise.all([this.readAndPersist(actor, projectId, binding, input.connectionId),
      this.prisma.$transaction(async tx => { await this.lockManual(tx, actor, projectId, binding, input.connectionId); return this.articleState(tx, projectId, input.sourceVersionId); })]);
    if (input.expectedArticleRevision !== (article.article?.revision ?? 0)) throw new ConflictException('Article changed; reload before syncing Google Docs');
    const converted = googleTabToArticleContent(data.document, binding.tabId);
    const state = await this.prisma.googleDocSyncState.findUnique({ where: { bindingId: binding.id } });
    const baselineRow = state?.baselineSnapshotId ? await this.prisma.googleDocSnapshot.findFirst({ where: { id: state.baselineSnapshotId, projectId } }) : null;
    const baselineContent = baselineRow?.converted && object(baselineRow.converted).content ? object(baselineRow.converted).content : null;
    const localContent = article.content;
    const remoteContent = converted.content;
    const hasConflict = baselineContent !== null && contentHash(localContent) !== contentHash(baselineContent)
      && contentHash(remoteContent) !== contentHash(baselineContent)
      && contentHash(localContent) !== contentHash(remoteContent);
    let requests: GoogleDocsRequest[] = [], writeMode: 'EDIT' | 'SUGGEST' | null = null, unsupported: unknown[] = [], targetRanges: GoogleDocsRange[] = [];
    let expectedPlainText = articleDocumentDetails(article.content).plainText, beforeCommittedHash = data.contentHash;
    let expectedSuggestionParts: unknown[] = [], expectedThread: FrozenPreview['expectedThread'] = null;
    const payload: Record<string, unknown> = { kind: input.kind };
    if (input.kind === 'PUSH') {
      const plan = buildGoogleSyncPlan(data.document, binding.tabId, article.content, 'PUSH');
      ({ requests, writeMode, unsupported, targetRanges, expectedPlainText, beforeCommittedHash, expectedSuggestionParts } = plan);
      // A confirmed no-op is read-only; unsupported provider-side annotations stay visible but do not turn a harmless no-op into a write attempt.
      if (!plan.hasChanges && contentHash(article.content) === contentHash(converted.content)) unsupported = [];
    } else {
      const thread = input.threadId ? await this.prisma.googleDocRemoteThread.findFirst({ where: { id: input.threadId, bindingId: binding.id, projectId } }) : null;
      const annotation = input.annotationId ? await this.prisma.articleAnnotation.findFirst({ where: { id: input.annotationId, projectId }, include: { posts: { orderBy: { createdAt: 'asc' } } } }) : null;
      if (input.threadId && !thread) throw new NotFoundException('Remote annotation thread not found');
      if (input.annotationId && !annotation) throw new NotFoundException('Local annotation not found');
      if (annotation && ['COMMENT_CREATE', 'SUGGESTION_CREATE'].includes(input.kind)
        && (annotation.articleVersionId !== article.version.id || annotation.anchorStart !== input.rangeStart || annotation.anchorEnd !== input.rangeEnd)) {
        throw new ConflictException('Export the annotation from its exact saved version and range');
      }
      const imported = googleTabToArticleContent(data.document, binding.tabId);
      if (input.kind === 'COMMENT_CREATE') {
        if (annotation!.kind !== 'COMMENT' || annotation!.status !== 'OPEN') throw new ConflictException('Only an open local comment can be linked to Google Docs');
        if (input.body !== annotation!.body) throw new ConflictException('Google comment text must match the selected local annotation');
        if (await this.prisma.googleDocRemoteThread.findFirst({ where: { bindingId: binding.id, localAnnotationId: annotation!.id } })) throw new ConflictException('This local comment is already linked to Google Docs');
        const start = input.rangeStart!, end = input.rangeEnd!, quote = annotation!.quote;
        const mapped = mapRange(imported, start, end, quote);
        if (!mapped) unsupported = [{ type: 'ambiguous-range', message: 'The selected comment anchor cannot be mapped exactly to Google Docs' }];
        else if (new TextEncoder().encode(input.body!).byteLength > 2048) unsupported = [{ type: 'comment-too-long', message: 'Google Docs comments are limited to 2048 UTF-8 bytes' }];
        else { requests = [{ insertComment: { content: input.body!, range: mapped } }]; targetRanges = [mapped]; expectedThread = { kind: 'comment', status: 'OPEN', content: input.body!, quoteText: quote, ranges: [mapped] }; writeMode = 'EDIT'; }
      } else if (input.kind === 'COMMENT_REPLY') {
        if (thread!.kind !== 'COMMENT' || thread!.status !== 'OPEN') throw new ConflictException('Remote comment is no longer open');
        const linked = input.localPostId ? annotation!.posts.find(post => post.id === input.localPostId) : undefined;
        if (input.localPostId && (!linked || linked.action !== 'REPLY' || !annotation || thread!.localAnnotationId !== annotation.id || linked.annotationId !== thread!.localAnnotationId)) {
          throw new ConflictException('Selected local reply does not belong to this linked annotation thread');
        }
        const existingLinks = object(object(thread!.payloadJson).localPostLinks);
        if (linked && typeof existingLinks[linked.id] === 'string') throw new ConflictException('This local reply is already linked to the remote thread');
        const replyBody = linked?.body ?? input.body!;
        if (new TextEncoder().encode(replyBody).byteLength > 2048) unsupported = [{ type: 'comment-too-long', message: 'Google Docs replies are limited to 2048 UTF-8 bytes' }];
        else { requests = [{ addCommentReply: { commentId: thread!.remoteId, post: { content: replyBody } } }]; writeMode = 'EDIT'; }
        payload['localPostId'] = linked?.id ?? null; payload['localAnnotationId'] = thread!.localAnnotationId;
      } else if (input.kind === 'COMMENT_RESOLVE' || input.kind === 'COMMENT_REOPEN') {
        if (thread!.kind !== 'COMMENT' || (input.kind === 'COMMENT_RESOLVE' ? thread!.status !== 'OPEN' : thread!.status !== 'RESOLVED')) throw new ConflictException('Remote comment cannot take this action');
        requests = [{ addCommentReply: { commentId: thread!.remoteId, post: { commentAction: input.kind === 'COMMENT_RESOLVE' ? 'RESOLVE' : 'REOPEN' } } }]; writeMode = 'EDIT';
      } else if (input.kind === 'SUGGESTION_CREATE') {
        if (annotation!.kind !== 'SUGGESTION' || annotation!.status !== 'OPEN' || !annotation!.replacementText) throw new ConflictException('Only an open local suggestion with replacement text can be exported');
        const mapped = mapRange(imported, input.rangeStart!, input.rangeEnd!, annotation!.quote);
        if (!mapped) unsupported = [{ type: 'ambiguous-range', message: 'The selected suggestion anchor cannot be mapped exactly to Google Docs' }];
        else {
          expectedSuggestionParts = [
            ...(mapped.endIndex > mapped.startIndex ? [{ type: 'deletion', text: annotation!.quote, startIndex: mapped.startIndex, endIndex: mapped.endIndex, tabId: binding.tabId }] : []),
            ...(annotation!.replacementText ? [{ type: 'insertion', text: annotation!.replacementText, startIndex: mapped.startIndex, endIndex: mapped.startIndex + annotation!.replacementText.length, tabId: binding.tabId }] : []),
          ];
          requests = [...(mapped.endIndex > mapped.startIndex ? [{ deleteContentRange: { range: mapped } } as GoogleDocsRequest] : []),
            ...(annotation!.replacementText ? [{ insertText: { location: { index: mapped.startIndex, tabId: binding.tabId }, text: annotation!.replacementText } } as GoogleDocsRequest] : [])];
          writeMode = 'SUGGEST'; targetRanges = [mapped]; expectedThread = { kind: 'suggestion', status: 'OPEN', quoteText: annotation!.replacementText || annotation!.quote, ranges: [mapped] }; payload['expectedSuggestionParts'] = expectedSuggestionParts;
        }
      } else if (input.kind === 'SUGGESTION_ACCEPT' || input.kind === 'SUGGESTION_REJECT') {
        if (thread!.kind !== 'SUGGESTION' || thread!.status !== 'OPEN') throw new ConflictException('Remote suggestion is no longer open');
        const remoteDoc = thread!.payloadJson as Record<string, unknown>;
        const suggestionParts = (converted.suggestions ?? []).filter(row => row.suggestionId === thread!.remoteId);
        if (!suggestionParts.length) throw new ConflictException('All parts of this suggestion are no longer present');
        const related = thread!.localAnnotationId ? await this.prisma.googleDocRemoteThread.findMany({ where: { bindingId: binding.id, localAnnotationId: thread!.localAnnotationId, kind: 'SUGGESTION' } }) : [thread!];
        if (related.some(row => row.status !== 'OPEN' || !converted.suggestions.some(part => part.suggestionId === row.remoteId))) throw new ConflictException('The complete suggestion group is no longer open');
        payload['decisionRemoteIds'] = related.map(row => row.remoteId);
        requests = related.map(row => input.kind === 'SUGGESTION_ACCEPT' ? { acceptSuggestion: { suggestionId: row.remoteId } } : { rejectSuggestion: { suggestionId: row.remoteId } });
        void remoteDoc; writeMode = 'EDIT';
      }
      payload['threadId'] = input.threadId ?? null; payload['annotationId'] = input.annotationId ?? null;
    }
    if (unsupported.length) writeMode = writeMode ?? null;
    const frozenPreview: FrozenPreview = { schemaVersion: 'google-sync-preview-v1', kind: input.kind, bindingId: binding.id, connectionId: input.connectionId,
      sessionId: actor.sessionId, noticeAcceptedAt: actor.noticeAcceptedAt.toISOString(), sourceVersionId: article.version.id,
      expectedArticleRevision: input.expectedArticleRevision, snapshotId, remoteRevision: data.document.revisionId, localContent, remoteContent,
      baselineContent, hasConflict, requests, writeMode, beforeCommittedHash, expectedPlainText, expectedSuggestionParts, expectedThread, targetRanges, unsupported, payload };
    const now = new Date();
    const previewId = randomUUID();
    const payloadHash = canonicalManifestHash(frozenPreview);
    await this.prisma.$transaction(async tx => {
      await this.lockManual(tx, actor, projectId, binding, input.connectionId);
      await tx.googleDocSyncPreview.create({ data: { id: previewId, projectId, bindingId: binding.id, requestedBy: actor.userId,
        connectionId: input.connectionId, sessionId: actor.sessionId, noticeAcceptedAt: actor.noticeAcceptedAt, sourceVersionId: article.version.id,
        remoteSnapshotId: snapshotId, expectedArticleRevision: input.expectedArticleRevision, kind: input.kind, frozenJson: json(frozenPreview),
        payloadHash, createdAt: now, expiresAt: new Date(now.getTime() + PREVIEW_TTL_MS) } });
    });
    return { previewId, kind: input.kind, sourceVersionId: article.version.id, remoteRevision: data.document.revisionId,
      localContent, remoteContent, baselineContent, hasConflict, unsupported, writeMode,
      summary: input.kind === 'PUSH' && requests.length === 0 && expectedPlainText === converted.plainText && article.content.title !== data.document.title
        ? 'назва статті не змінює назву Google файла' : previewSummary(input.kind, writeMode, unsupported.length, hasConflict),
      expiresAt: new Date(now.getTime() + PREVIEW_TTL_MS).toISOString() };
  }

  async confirm(actor: GoogleSyncActor, projectId: string, input: GoogleSyncConfirmInput) {
    const preview = await this.prisma.googleDocSyncPreview.findFirst({ where: { id: input.previewId, projectId, requestedBy: actor.userId } });
    if (!preview) throw new NotFoundException('Google Docs preview not found');
    const binding = await this.binding(projectId, actor.userId);
    const captured = frozen(preview.frozenJson);
    if (preview.expiresAt <= new Date() || preview.payloadHash !== canonicalManifestHash(captured)) throw new ConflictException('Google Docs preview expired or failed integrity checks');
    if (preview.bindingId !== binding.id || captured.bindingId !== binding.id || preview.remoteSnapshotId !== captured.snapshotId
      || preview.sourceVersionId !== captured.sourceVersionId || preview.connectionId !== captured.connectionId) {
      throw new ConflictException('Google Docs binding or captured preview changed; create a new preview');
    }
    if (captured.sessionId !== actor.sessionId || new Date(captured.noticeAcceptedAt).getTime() !== actor.noticeAcceptedAt.getTime()) throw new ForbiddenException('Preview must be confirmed in the session that created it');
    if (captured.unsupported.length || captured.kind === 'PUSH' && captured.writeMode === null) throw new ConflictException('Unsupported Google Docs content blocks this operation');
    if (captured.hasConflict && captured.kind === 'PUSH') throw new ConflictException('Local and remote Article edits conflict; pull or reconcile before pushing');
    if (input.expectedArticleRevision !== captured.expectedArticleRevision) throw new ConflictException('Article revision differs from the confirmed preview');
    return this.enqueueManual(actor, projectId, binding, input.commandKey, captured.kind, input.expectedArticleRevision, captured.sourceVersionId, preview.id, captured.connectionId, captured);
  }
  async pull(actor: GoogleSyncActor, projectId: string, input: GoogleSyncPullInput) {
    await this.authorizeProject(actor, projectId);
    const binding = await this.binding(projectId, actor.userId);
    const article = await this.prisma.article.findUnique({ where: { projectId }, select: { revision: true } });
    if ((article?.revision ?? 0) !== input.expectedArticleRevision) throw new ConflictException('Article changed; reload before pulling');
    const sourceVersionId = input.sourceVersionId ?? (await this.prisma.article.findUnique({ where: { projectId }, select: { draft: { select: { baseVersionId: true } } } }))?.draft?.baseVersionId ?? null;
    return this.enqueueManual(actor, projectId, binding, input.commandKey, 'PULL', input.expectedArticleRevision, sourceVersionId, null, input.connectionId, { schemaVersion: 'google-sync-pull-v1', sourceVersionId });
  }
  async reconcile(actor: GoogleSyncActor, projectId: string, input: GoogleSyncReconcileInput) {
    await this.authorizeProject(actor, projectId);
    const binding = await this.binding(projectId, actor.userId);
    const operation = await this.prisma.googleDocSyncOperation.findFirst({ where: { id: input.operationId, projectId, bindingId: binding.id } });
    if (!operation) throw new NotFoundException('Google Docs operation not found');
    if (!['SUBMITTED', 'UNKNOWN', 'PARTIAL'].includes(operation.state)) throw new ConflictException('Only an uncertain operation can be reconciled');
    return this.enqueueManual(actor, projectId, binding, input.commandKey, 'RECONCILE', 0, operation.sourceVersionId, null, input.connectionId,
      { schemaVersion: 'google-sync-reconcile-v1', targetOperationId: operation.id });
  }
  private async enqueueManual(actor: GoogleSyncActor, projectId: string, binding: BindingRow, commandKey: string, kind: SyncKind,
    expectedArticleRevision: number, sourceVersionId: string | null, previewId: string | null, connectionId: string, detail: unknown) {
    const operationId = randomUUID();
    const manifest = { schemaVersion: 'google-sync-job-v1', operationId, bindingId: binding.id, connectionId, sessionId: actor.sessionId,
      noticeAcceptedAt: actor.noticeAcceptedAt.toISOString(), backgroundGeneration: null, kind, sourceVersionId,
      expectedArticleRevision, previewId, detail };
    return this.prisma.$transaction(async tx => {
      await this.lockManual(tx, actor, projectId, binding, connectionId, true);
      const prior = await tx.googleDocSyncOperation.findFirst({ where: { projectId, requestedBy: actor.userId, commandKey } });
      if (prior) {
        const priorManifest = object(prior.manifestJson);
        const replayHash = canonicalManifestHash({ ...manifest, operationId: null, frozenInputs: priorManifest['frozenInputs'] });
        if (prior.payloadHash !== replayHash) throw new ConflictException('Command key was already used with different inputs');
        return { operation: prior, job: await tx.job.findUniqueOrThrow({ where: { id: prior.jobId } }), replayed: true };
      }
      const article = await tx.article.findUnique({ where: { projectId }, select: { revision: true } });
      if (kind !== 'RECONCILE' && (article?.revision ?? 0) !== expectedArticleRevision) throw new ConflictException('Article changed; reload before syncing');
      const frozenInputs = await this.articles.freezeGoogleInputs(tx, actor.userId, projectId, sourceVersionId, article?.revision ?? 0);
      const frozenManifest = { ...manifest, frozenInputs };
      const payloadHash = canonicalManifestHash({ ...frozenManifest, operationId: null });
      await tx.googleDocSyncState.upsert({ where: { bindingId: binding.id }, create: { bindingId: binding.id, projectId, status: 'READY' }, update: {} });
      await tx.$queryRaw`SELECT "bindingId" FROM contextflow."GoogleDocSyncState" WHERE "bindingId"=${binding.id}::uuid FOR UPDATE`;
      await this.normalizeOperationJournals(tx, binding.id);
      const active = await tx.googleDocSyncOperation.findMany({ where: { bindingId: binding.id, state: { in: ['QUEUED', 'SUBMITTED', 'UNKNOWN', 'PARTIAL'] } }, include: { job: true }, orderBy: { createdAt: 'asc' } });
      if (active.length) {
        const isRead = kind === 'PULL' || kind === 'RECONCILE';
        if (!isRead || active.some(row => ['QUEUED', 'SUBMITTED'].includes(row.state) || row.job.status === 'RUNNING')) {
          throw new ConflictException('Another Google Docs operation is active; wait for it to finish before reconciling');
        }
        if (kind === 'RECONCILE') {
          const targetId = object(detail).targetOperationId;
          if (active.length !== 1 || !['UNKNOWN', 'PARTIAL'].includes(active[0]!.state) || active[0]!.id !== targetId) {
            throw new ConflictException('Reconcile the one uncertain completed operation before other reads');
          }
        } else if (active.some(row => !['OUTCOME_UNKNOWN', 'FAILED', 'CANCELLED', 'SUCCEEDED'].includes(row.job.status))) {
          throw new ConflictException('An uncertain operation is still running and cannot be read concurrently');
        }
      }
      const job = await this.jobs.create(tx, { projectId, userId: actor.userId, operation: 'GOOGLE_DOCS_SYNC', contractVersion: CONTRACT,
        commandKey, inputManifest: json(frozenManifest) as Prisma.InputJsonObject, deadlineMs: 600_000 });
      const operation = await tx.googleDocSyncOperation.create({ data: { id: operationId, projectId, bindingId: binding.id, requestedBy: actor.userId,
        connectionId, sessionId: actor.sessionId, noticeAcceptedAt: actor.noticeAcceptedAt, commandKey, kind, state: 'QUEUED', manifestJson: json(frozenManifest),
        payloadHash, jobId: job.id, sourceVersionId, previewId } });
      return { operation, job, replayed: false };
    });
  }
  async background(actor: GoogleSyncActor, projectId: string, input: GoogleSyncBackgroundInput) {
    await this.authorizeProject(actor, projectId);
    const binding = await this.binding(projectId, actor.userId);
    return this.prisma.$transaction(async tx => {
      if (input.enabled) await this.lockManual(tx, actor, projectId, binding, input.connectionId, true);
      else {
        await this.lockProject(tx, actor, projectId, true);
        await this.lockActor(tx, actor);
        const currentBinding = await tx.googleDocBinding.findFirst({ where: { id: binding.id, projectId, endedAt: null }, select: { id: true } });
        if (!currentBinding) throw new ForbiddenException('Google Docs binding is no longer active');
      }
      await tx.googleDocSyncState.upsert({ where: { bindingId: binding.id }, create: { bindingId: binding.id, projectId, status: 'READY' }, update: {} });
      await tx.$queryRaw`SELECT "bindingId" FROM contextflow."GoogleDocSyncState" WHERE "bindingId"=${binding.id}::uuid FOR UPDATE`;
      const state = await tx.googleDocSyncState.findUniqueOrThrow({ where: { bindingId: binding.id } });
      if (state.backgroundGeneration !== input.expectedGeneration) throw new ConflictException('Background consent changed; reload before updating it');
      if (input.enabled) {
        await tx.googleDocSyncState.update({ where: { bindingId: binding.id }, data: { backgroundConnectionId: input.connectionId,
          backgroundUserId: actor.userId, backgroundGrantedAt: new Date(), backgroundNoticeAcceptedAt: actor.noticeAcceptedAt,
          backgroundGeneration: { increment: 1 }, nextPollAt: new Date(Date.now() + POLL_INTERVAL_MS), updatedAt: new Date(), status: 'READY' } });
      } else {
        await tx.googleDocSyncState.update({ where: { bindingId: binding.id }, data: { backgroundConnectionId: null, backgroundUserId: null,
          backgroundGrantedAt: null, backgroundNoticeAcceptedAt: null, backgroundGeneration: { increment: 1 }, nextPollAt: null, updatedAt: new Date(), status: 'PAUSED' } });
      }
      return tx.googleDocSyncState.findUniqueOrThrow({ where: { bindingId: binding.id } });
    });
  }
  async queueDuePulls(): Promise<number> {
    const due = await this.prisma.$transaction(async tx => tx.$queryRaw<Array<{ bindingId: string; projectId: string; backgroundConnectionId: string; backgroundUserId: string; backgroundNoticeAcceptedAt: Date; backgroundGeneration: number }>>`
      SELECT s."bindingId",s."projectId",s."backgroundConnectionId",s."backgroundUserId",s."backgroundNoticeAcceptedAt",s."backgroundGeneration"
      FROM contextflow."GoogleDocSyncState" s JOIN contextflow."GoogleDocBinding" b ON b."id"=s."bindingId" AND b."projectId"=s."projectId"
      JOIN contextflow."Project" p ON p."id"=s."projectId" JOIN contextflow."Workspace" w ON w."id"=p."workspaceId"
      JOIN contextflow."WorkspaceMember" wm ON wm."workspaceId"=w."id" AND wm."userId"=s."backgroundUserId" AND wm."leftAt" IS NULL
      JOIN contextflow."UserProfile" u ON u."id"=s."backgroundUserId"
      JOIN contextflow."GoogleDriveConnection" c ON c."id"=s."backgroundConnectionId" AND c."userId"=s."backgroundUserId"
      WHERE s."backgroundGrantedAt" IS NOT NULL AND s."nextPollAt"<=CURRENT_TIMESTAMP AND b."endedAt" IS NULL
      AND p."archivedAt" IS NULL AND w."archivedAt" IS NULL AND 'ARTICLE'=ANY(p."formats")
      AND u."externalProcessingNoticeVersion"=${EXTERNAL_PROCESSING_NOTICE.version} AND u."externalProcessingAcceptedAt"=s."backgroundNoticeAcceptedAt"
      AND c."revokedAt" IS NULL AND c."encryptedTokens" IS NOT NULL AND (c."refreshExpiresAt" IS NULL OR c."refreshExpiresAt">CURRENT_TIMESTAMP)
      ORDER BY s."nextPollAt" FOR UPDATE OF s SKIP LOCKED LIMIT 20`);
    let queued = 0;
    for (const row of due) {
      const binding = await this.prisma.googleDocBinding.findFirst({ where: { id: row.bindingId, projectId: row.projectId } });
      if (!binding || !row.backgroundConnectionId || !row.backgroundUserId || !row.backgroundNoticeAcceptedAt) continue;
      const commandKey = randomUUID(), operationId = randomUUID();
      const manifest = { schemaVersion: 'google-sync-job-v1', operationId, bindingId: row.bindingId, connectionId: row.backgroundConnectionId,
        sessionId: null, noticeAcceptedAt: row.backgroundNoticeAcceptedAt.toISOString(), backgroundGeneration: row.backgroundGeneration,
        kind: 'PULL', sourceVersionId: null, expectedArticleRevision: 0, previewId: null, detail: { schemaVersion: 'google-sync-background-pull-v1' } };
      await this.prisma.$transaction(async tx => {
        await this.lockProject(tx, { userId: row.backgroundUserId, sessionId: '', noticeAcceptedAt: row.backgroundNoticeAcceptedAt }, row.projectId, true);
        const locked = await tx.$queryRaw<Array<{ bindingId: string }>>`UPDATE contextflow."GoogleDocSyncState" s SET "nextPollAt"=${new Date(Date.now() + POLL_INTERVAL_MS)}
          WHERE s."bindingId"=${row.bindingId}::uuid AND s."projectId"=${row.projectId}::uuid AND s."backgroundGeneration"=${row.backgroundGeneration}
          AND s."backgroundGrantedAt" IS NOT NULL AND s."nextPollAt"<=CURRENT_TIMESTAMP
          AND EXISTS (SELECT 1 FROM contextflow."GoogleDocBinding" b JOIN contextflow."Project" p ON p."id"=b."projectId"
            JOIN contextflow."Workspace" w ON w."id"=p."workspaceId"
            JOIN contextflow."WorkspaceMember" wm ON wm."workspaceId"=w."id" AND wm."userId"=s."backgroundUserId" AND wm."leftAt" IS NULL
            JOIN contextflow."UserProfile" u ON u."id"=s."backgroundUserId"
            JOIN contextflow."GoogleDriveConnection" c ON c."id"=s."backgroundConnectionId" AND c."userId"=s."backgroundUserId"
            WHERE b."id"=s."bindingId" AND b."projectId"=s."projectId" AND b."endedAt" IS NULL AND p."archivedAt" IS NULL AND w."archivedAt" IS NULL
            AND 'ARTICLE'=ANY(p."formats") AND u."externalProcessingNoticeVersion"=${EXTERNAL_PROCESSING_NOTICE.version}
            AND u."externalProcessingAcceptedAt"=s."backgroundNoticeAcceptedAt" AND c."revokedAt" IS NULL AND c."encryptedTokens" IS NOT NULL
            AND (c."refreshExpiresAt" IS NULL OR c."refreshExpiresAt">CURRENT_TIMESTAMP)) RETURNING s."bindingId"`;
        if (!locked.length) return;
        await this.normalizeOperationJournals(tx, row.bindingId);
        const active = await tx.googleDocSyncOperation.findMany({ where: { bindingId: row.bindingId, state: { in: ['QUEUED', 'SUBMITTED', 'UNKNOWN', 'PARTIAL'] } }, include: { job: true } });
        if (active.length && active.some(item => ['QUEUED', 'SUBMITTED'].includes(item.state) || item.job.status === 'RUNNING'
          || !['OUTCOME_UNKNOWN', 'FAILED', 'CANCELLED', 'SUCCEEDED'].includes(item.job.status))) return;
        const article = await tx.article.findUnique({ where: { projectId: row.projectId }, include: { draft: true } });
        const sourceVersionId = article?.draft?.baseVersionId ?? article?.currentApprovedVersionId ?? null;
        const frozenInputs = await this.articles.freezeGoogleInputs(tx, row.backgroundUserId, row.projectId, sourceVersionId, article?.revision ?? 0);
        const frozenManifest = { ...manifest, sourceVersionId, expectedArticleRevision: article?.revision ?? 0, frozenInputs };
        const payloadHash = canonicalManifestHash({ ...frozenManifest, operationId: null });
        const job = await this.jobs.create(tx, { projectId: row.projectId, userId: row.backgroundUserId, operation: 'GOOGLE_DOCS_SYNC',
          contractVersion: CONTRACT, commandKey, inputManifest: json(frozenManifest) as Prisma.InputJsonObject });
        await tx.googleDocSyncOperation.create({ data: { id: operationId, projectId: row.projectId, bindingId: row.bindingId, requestedBy: row.backgroundUserId,
          connectionId: row.backgroundConnectionId, sessionId: null, noticeAcceptedAt: row.backgroundNoticeAcceptedAt,
          backgroundGeneration: row.backgroundGeneration, commandKey, kind: 'PULL', state: 'QUEUED', manifestJson: json(frozenManifest), payloadHash, jobId: job.id, sourceVersionId } });
        queued++;
      });
    }
    return queued;
  }
}

function mapRange(imported: ReturnType<typeof googleTabToArticleContent>, start: number, end: number, quote: string): GoogleDocsRange | null {
  return mapArticleRangeToGoogle(imported, start, end, quote);
}
function previewSummary(kind: SyncKind, mode: 'EDIT' | 'SUGGEST' | null, unsupportedCount: number, conflict: boolean): string {
  if (unsupportedCount) return 'Some content cannot be represented safely in Google Docs';
  if (conflict) return 'Local and Google Docs content both changed since the last baseline';
  if (kind === 'PUSH') return mode === 'EDIT' ? 'Write Article text to the blank Google Docs tab' : mode === 'SUGGEST' ? 'Suggest the minimum text change in Google Docs' : 'Article text already matches Google Docs';
  return `Preview ${kind.toLowerCase().replaceAll('_', ' ')} against the current Google Docs revision`;
}
