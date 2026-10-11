import { randomUUID } from 'node:crypto';
import type { Prisma, PrismaClient, Job } from '../generated/prisma/client.js';
import { JobFailure, type JobContext, type JobHandler } from '../jobs/contracts.js';
import { canonicalManifestHash } from '../jobs/job-service.js';
import { EXTERNAL_PROCESSING_NOTICE } from '../external-processing-notice.js';
import type { ArticleService, FrozenGoogleArticleInputs } from '../editorial/article.service.js';
import { articleContentSchema } from '../editorial/article-contracts.js';
import { GoogleDocsApiError, type GoogleDocsDocument, type GoogleDocsRequest } from './google-docs-client.js';
import { googleTabToArticleContent } from './article-conversion.js';
import { extractGoogleThreads, reconcileGoogleCreatedThread, type GoogleThreadExpectation } from './sync-conversion.js';
import type { GoogleSyncCredentials, GoogleSyncCredentialsContext } from './google-sync-credentials.js';
import { canonicalGoogleArticleDocument, type GoogleDocSyncService } from './google-doc-sync.service.js';

type Manifest = { schemaVersion: string; operationId: string; bindingId: string; connectionId: string; sessionId: string | null;
  noticeAcceptedAt: string; backgroundGeneration: number | null; kind: string; sourceVersionId: string | null;
  expectedArticleRevision: number; frozenInputs: FrozenGoogleArticleInputs; detail: Detail };
type Detail = { requests?: GoogleDocsRequest[]; remoteRevision?: string; writeMode?: 'EDIT' | 'SUGGEST'; snapshotId?: string;
  expectedPlainText?: string; expectedThread?: GoogleThreadExpectation; payload?: Record<string, unknown>; targetOperationId?: string };
type Result = { document: GoogleDocsDocument; matchedIds: string[]; targetOperationId: string | null; confirmed: boolean;
  localPostLink?: { threadId: string; localPostId: string; remotePostId: string } };
const json = (value: unknown): Prisma.InputJsonValue => JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
const obj = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
function sameJson(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) || Array.isArray(right)) return Array.isArray(left) && Array.isArray(right)
    && left.length === right.length && left.every((value, index) => sameJson(value, right[index]));
  if (left && right && typeof left === 'object' && typeof right === 'object') {
    const a = Object.entries(left), b = Object.entries(right);
    return a.length === b.length && a.every(([key, value]) => key in right && sameJson(value, (right as Record<string, unknown>)[key]));
  }
  return false;
}
/** Executes one frozen Google operation; uncertain writes are reconciled by reads only. */
export function createGoogleDocSyncHandler(deps: { prisma: PrismaClient; articles: ArticleService; credentials: GoogleSyncCredentials; sync: GoogleDocSyncService }): JobHandler {
  function manifest(job: Job): Manifest {
    const raw = obj(job.inputManifest);
    if (job.operation !== 'GOOGLE_DOCS_SYNC' || job.contractVersion !== 'google-doc-sync-v1' || raw.schemaVersion !== 'google-sync-job-v1'
      || typeof raw.operationId !== 'string' || typeof raw.bindingId !== 'string' || !raw.frozenInputs
      || job.inputHash !== canonicalManifestHash({ contractVersion: job.contractVersion, inputManifest: job.inputManifest })) {
      throw new JobFailure('INPUT_INTEGRITY', 'NOT_SUBMITTED');
    }
    return raw as unknown as Manifest;
  }
  const credentialContext = (job: Job, m: Manifest, signal?: AbortSignal): GoogleSyncCredentialsContext => ({ projectId: job.projectId,
    bindingId: m.bindingId, userId: job.requestedBy, connectionId: m.connectionId, sessionId: m.sessionId,
    noticeAcceptedAt: new Date(m.noticeAcceptedAt), backgroundGeneration: m.backgroundGeneration, ...(signal ? { signal } : {}) });

  async function fence(tx: Prisma.TransactionClient, job: Job, m: Manifest): Promise<void> {
    const journal = await tx.googleDocSyncOperation.findFirst({ where: { id: m.operationId, jobId: job.id, projectId: job.projectId, bindingId: m.bindingId } });
    if (!journal || canonicalManifestHash({ ...obj(journal.manifestJson), operationId: null }) !== journal.payloadHash
      || canonicalManifestHash(journal.manifestJson) !== canonicalManifestHash(job.inputManifest)) throw new JobFailure('JOURNAL_INTEGRITY', 'NOT_SUBMITTED');
    const rows = await tx.$queryRaw<Array<{ id: string }>>`SELECT b."id" FROM contextflow."GoogleDocBinding" b
      JOIN contextflow."Project" p ON p."id"=b."projectId" JOIN contextflow."Workspace" w ON w."id"=p."workspaceId"
      JOIN contextflow."WorkspaceMember" wm ON wm."workspaceId"=w."id" JOIN contextflow."UserProfile" u ON u."id"=wm."userId"
      JOIN contextflow."GoogleDriveConnection" c ON c."id"=${m.connectionId}::uuid AND c."userId"=u."id"
      WHERE b."id"=${m.bindingId}::uuid AND b."projectId"=${job.projectId}::uuid AND b."endedAt" IS NULL
      AND p."archivedAt" IS NULL AND w."archivedAt" IS NULL AND wm."leftAt" IS NULL AND wm."userId"=${job.requestedBy}::uuid
      AND 'ARTICLE'=ANY(p."formats") AND u."externalProcessingAcceptedAt"=${new Date(m.noticeAcceptedAt)}
      AND u."externalProcessingNoticeVersion"=${EXTERNAL_PROCESSING_NOTICE.version}
      AND c."revokedAt" IS NULL AND c."encryptedTokens" IS NOT NULL FOR SHARE OF b,p,w,wm,u,c`;
    if (!rows.length) throw new JobFailure('ACCESS_CHANGED', 'NOT_SUBMITTED');
    if (m.sessionId) {
      const sessions = await tx.$queryRaw<Array<{ id: string }>>`SELECT s."id" FROM contextflow."AppSession" s JOIN contextflow."UserProfile" u ON u."id"=s."userId"
        WHERE s."id"=${m.sessionId}::uuid AND s."userId"=${job.requestedBy}::uuid AND s."revokedAt" IS NULL
        AND s."expiresAt">CURRENT_TIMESTAMP AND s."lastUserActivityAt">CURRENT_TIMESTAMP-u."idleTimeoutMinutes"*INTERVAL '1 minute' FOR SHARE OF s,u`;
      if (!sessions.length) throw new JobFailure('SESSION_EXPIRED', 'NOT_SUBMITTED');
    } else {
      const state = await tx.googleDocSyncState.findUnique({ where: { bindingId: m.bindingId } });
      if (!state?.backgroundGrantedAt || state.backgroundUserId !== job.requestedBy || state.backgroundConnectionId !== m.connectionId
        || state.backgroundGeneration !== m.backgroundGeneration || state.backgroundNoticeAcceptedAt?.getTime() !== new Date(m.noticeAcceptedAt).getTime()) {
        throw new JobFailure('CONSENT_CHANGED', 'NOT_SUBMITTED');
      }
    }
    if (!['PULL', 'RECONCILE'].includes(m.kind)) {
      const article = await tx.article.findUnique({ where: { projectId: job.projectId } });
      if ((article?.revision ?? 0) !== m.expectedArticleRevision) throw new JobFailure('ARTICLE_CHANGED', 'NOT_SUBMITTED');
    }
  }

  async function transition(id: string, state: string, outcome?: unknown): Promise<void> {
    await deps.prisma.$transaction(async tx => {
      await tx.$queryRaw`SELECT "id" FROM contextflow."GoogleDocSyncOperation" WHERE "id"=${id}::uuid FOR UPDATE`;
      const row = await tx.googleDocSyncOperation.findUniqueOrThrow({ where: { id } });
      if (['SUCCEEDED', 'FAILED', 'CANCELLED'].includes(row.state)) return;
      await tx.googleDocSyncOperation.update({ where: { id }, data: { state,
        ...(state === 'SUBMITTED' ? { submittedAt: new Date() } : {}), ...(outcome ? { outcomeJson: json(outcome) } : {}),
        updatedAt: new Date(Math.max(Date.now(), row.updatedAt.getTime() + 1)) } });
    });
  }

  async function begin(job: Job, m: Manifest, submit = true): Promise<void> {
    await deps.prisma.$transaction(async tx => {
      await fence(tx, job, m);
      await tx.googleDocSyncState.upsert({ where: { bindingId: m.bindingId }, create: { bindingId: m.bindingId, projectId: job.projectId, status: 'READY' }, update: {} });
      await tx.$queryRaw`SELECT "bindingId" FROM contextflow."GoogleDocSyncState" WHERE "bindingId"=${m.bindingId}::uuid FOR UPDATE`;
      const active = await tx.googleDocSyncOperation.findMany({ where: { bindingId: m.bindingId, id: { not: m.operationId }, state: { in: ['QUEUED', 'SUBMITTED', 'UNKNOWN', 'PARTIAL'] } }, include: { job: true } });
      if (active.some(row => ['QUEUED', 'SUBMITTED'].includes(row.state) || row.job.status === 'RUNNING')) {
        throw new JobFailure('BINDING_OPERATION_ACTIVE', 'NOT_SUBMITTED');
      }
      if (active.length && !['PULL', 'RECONCILE'].includes(m.kind)) throw new JobFailure('UNCERTAIN_WRITE_BLOCKS', 'NOT_SUBMITTED');
      if (m.kind === 'RECONCILE' && (active.length !== 1 || active[0]!.id !== m.detail.targetOperationId
        || !['UNKNOWN', 'PARTIAL'].includes(active[0]!.state))) throw new JobFailure('INVALID_RECONCILIATION', 'NOT_SUBMITTED');
      const own = await tx.googleDocSyncOperation.findFirst({ where: { id: m.operationId, projectId: job.projectId, state: { in: submit ? ['QUEUED', 'SUBMITTED'] : ['QUEUED'] } } });
      if (!own) throw new JobFailure('OPERATION_STATE_CHANGED', 'NOT_SUBMITTED');
      if (own.state === 'SUBMITTED') {
        const priorEffect = await tx.jobAttempt.findFirst({ where: { jobId: job.id, ordinal: { lt: job.attemptCount }, providerSubmittedAt: { not: null } }, select: { id: true } });
        if (priorEffect) throw new JobFailure('UNCERTAIN_WRITE_BLOCKS', 'UNKNOWN');
      }
      if (submit && own.state === 'QUEUED') await tx.googleDocSyncOperation.update({ where: { id: own.id }, data: { state: 'SUBMITTED', submittedAt: new Date(), updatedAt: new Date() } });
    });
  }

  async function proof(job: Job, m: Manifest, document: GoogleDocsDocument, targetId: string | null = null): Promise<Result> {
    const binding = await deps.prisma.googleDocBinding.findUniqueOrThrow({ where: { id: m.bindingId } });
    const detail = m.detail;
    const after = extractGoogleThreads(document, binding.tabId);
    const beforeSnapshot = detail.snapshotId ? await deps.prisma.googleDocSnapshot.findFirst({ where: { id: detail.snapshotId, projectId: job.projectId, bindingId: m.bindingId } }) : null;
    const before = beforeSnapshot ? extractGoogleThreads(beforeSnapshot.payload as unknown as GoogleDocsDocument, binding.tabId) : [];
    let confirmed = m.kind === 'PULL';
    let matchedIds: string[] = [];
    let localPostLink: Result['localPostLink'];
    if (m.kind === 'PUSH' && detail.writeMode === 'EDIT') confirmed = googleTabToArticleContent(document, binding.tabId).plainText === detail.expectedPlainText;
    if (m.kind === 'COMMENT_CREATE' && detail.expectedThread) {
      const match = reconcileGoogleCreatedThread(before, after, detail.expectedThread);
      confirmed = match.outcome === 'MATCHED'
        && (detail.expectedThread.status === undefined || match.thread.status === detail.expectedThread.status)
        && (detail.expectedThread.content === undefined || obj(obj(match.thread.payload).headPost).content === detail.expectedThread.content);
      if (match.outcome === 'MATCHED') matchedIds = [match.thread.remoteId];
    }
    if (['PUSH', 'SUGGESTION_CREATE'].includes(m.kind) && detail.writeMode === 'SUGGEST') {
      // Verify every frozen edit part against new native IDs, never infer from committed text.
      const expected = obj(detail).expectedSuggestionParts;
      const priorIds = new Set(before.map(thread => thread.remoteId));
      const created = after.filter(thread => thread.kind === 'suggestion' && thread.status === 'OPEN' && !priorIds.has(thread.remoteId));
      const allParts = created.flatMap(thread => thread.suggestionParts.map(part => ({ thread, part })));
      // Docs attaches empty style metadata to the exact newly inserted run.
      // Retain it in snapshots, while matching the actual insertion separately.
      const parts = allParts.filter(({ thread, part }) => !(part.type === 'style'
        && part.scope === 'text' && Object.keys(obj(obj(part.style).textStyle)).length === 0
        && Object.keys(obj(part.style)).every(key => ['textStyle', 'textStyleSuggestionState'].includes(key))
        && allParts.some(other => other.thread.remoteId === thread.remoteId && other.part.type === 'insertion'
          && other.part.startIndex === part.startIndex && other.part.endIndex === part.endIndex && other.part.text === part.text)));
      const rows = Array.isArray(expected) ? expected : [];
      const matchesExpected = (part: typeof parts[number]['part'], value: unknown): boolean => {
        const item = obj(value);
        // Suggested deletion text remains inline and shifts after insertion.
        const shift = item.type === 'deletion' ? rows.reduce((sum: number, value) => {
          const insertion = obj(value);
          return insertion.type === 'insertion' && typeof insertion.startIndex === 'number'
            && typeof item.startIndex === 'number' && insertion.startIndex <= item.startIndex
            && typeof insertion.text === 'string' ? sum + insertion.text.length : sum;
        }, 0) : 0;
        if (part.type !== item.type || part.startIndex !== Number(item.startIndex) + shift || part.endIndex !== Number(item.endIndex) + shift) return false;
        if (part.type !== 'style') return part.text === item.text;
        if (!part.supported || part.scope !== item.scope || typeof item.field !== 'string') return false;
        const style = obj(part.style);
        const styleValue = obj(style[part.scope === 'text' ? 'textStyle' : 'paragraphStyle']);
        const actual = item.field in styleValue ? styleValue[item.field] : style[item.field];
        return sameJson(actual, item.value);
      };
      confirmed = rows.length > 0 && parts.length === rows.length && rows.every(value =>
        parts.filter(({ part }) => matchesExpected(part, value)).length === 1)
        && parts.every(({ part }) => rows.filter(value => matchesExpected(part, value)).length === 1);
      if (confirmed) matchedIds = created.filter(thread => thread.suggestionParts.some(part => rows.some(value => {
        return matchesExpected(part, value);
      }))).map(thread => thread.remoteId);
    }
    const threadId = detail.payload?.threadId;
    const target = typeof threadId === 'string' ? await deps.prisma.googleDocRemoteThread.findFirst({ where: { id: threadId, projectId: job.projectId, bindingId: m.bindingId } }) : null;
    if (target && m.kind === 'COMMENT_REPLY') {
      const current = after.find(thread => thread.remoteId === target.remoteId);
      const previous = before.find(thread => thread.remoteId === target.remoteId);
      const previousIds = new Set(previous?.posts.map(post => obj(post).postId));
      const body = detail.requests?.find(request => 'addCommentReply' in request);
      const expectedContent = body && 'addCommentReply' in body ? body.addCommentReply.post.content : undefined;
      const matches = expectedContent ? current?.posts.filter(post => !previousIds.has(obj(post).postId)
        && obj(post).content === expectedContent && obj(obj(post).author).me === true) ?? [] : [];
      confirmed = matches.length === 1 && typeof obj(matches[0]).postId === 'string';
      const localPostId = detail.payload?.localPostId;
      if (confirmed && typeof localPostId === 'string') localPostLink = { threadId: target.id, localPostId, remotePostId: String(obj(matches[0]).postId) };
    }
    if (target && ['COMMENT_RESOLVE', 'COMMENT_REOPEN', 'SUGGESTION_ACCEPT', 'SUGGESTION_REJECT'].includes(m.kind)) {
      const expected = ({ COMMENT_RESOLVE: 'RESOLVED', COMMENT_REOPEN: 'OPEN', SUGGESTION_ACCEPT: 'ACCEPTED', SUGGESTION_REJECT: 'REJECTED' } as Record<string, string>)[m.kind];
      const decisionIds = detail.payload?.decisionRemoteIds;
      const ids = Array.isArray(decisionIds) && decisionIds.every(id => typeof id === 'string') ? decisionIds as string[] : [target.remoteId];
      confirmed = ids.length > 0 && ids.every(id => after.find(thread => thread.remoteId === id)?.status === expected);
    }
    return { document, matchedIds, targetOperationId: targetId, confirmed, ...(localPostLink ? { localPostLink } : {}) };
  }

  return {
    operation: 'GOOGLE_DOCS_SYNC',
    validateSubmission: async (tx, job) => { await fence(tx, job, manifest(job)); },
    execute: async context => {
      const m = manifest(context.job);
      await deps.prisma.$transaction(tx => fence(tx, context.job, m));
      const binding = await deps.prisma.googleDocBinding.findUniqueOrThrow({ where: { id: m.bindingId } });
      if (m.kind === 'PULL' || m.kind === 'RECONCILE') await begin(context.job, m, false);
      return deps.credentials.withClient(credentialContext(context.job, m, context.signal), async client => {
        const before = await client.getDocument(binding.documentId);
        if (m.kind === 'RECONCILE') {
          if (!m.detail.targetOperationId) throw new JobFailure('INVALID_RECONCILIATION', 'NOT_SUBMITTED');
          const target = await deps.prisma.googleDocSyncOperation.findFirst({ where: { id: m.detail.targetOperationId, projectId: context.job.projectId, bindingId: m.bindingId } });
          if (!target || !['UNKNOWN', 'PARTIAL'].includes(target.state)) throw new JobFailure('INVALID_RECONCILIATION', 'NOT_SUBMITTED');
          const result = await proof(context.job, obj(target.manifestJson) as unknown as Manifest, before, target.id);
          if (!result.confirmed) {
            await transition(m.operationId, 'FAILED');
            throw new JobFailure('READBACK_UNCONFIRMED', 'KNOWN_FAILED');
          }
          // The reconciliation job is a read-only effect, but its journal must leave QUEUED
          // before the durable job commit can mark it successful.
          await transition(m.operationId, 'SUBMITTED');
          return result;
        }
        if (m.kind !== 'PULL' && before.revisionId !== m.detail.remoteRevision) throw new JobFailure('REMOTE_CHANGED', 'NOT_SUBMITTED');
        if (m.kind === 'PUSH' && (!m.detail.requests?.length) && googleTabToArticleContent(before, binding.tabId).plainText === m.detail.expectedPlainText) {
          // A frozen no-op is a read-only confirmation. It must not create a provider intent or empty batch.
          await begin(context.job, m, false);
          const stable = await client.getDocument(binding.documentId);
          // Require the same captured provider state, including formatting-only edits, across both reads.
          if (stable.revisionId !== before.revisionId || !sameJson(stable, before)
            || googleTabToArticleContent(stable, binding.tabId).plainText !== m.detail.expectedPlainText) {
            throw new JobFailure('REMOTE_CHANGED', 'NOT_SUBMITTED');
          }
          await transition(m.operationId, 'SUBMITTED');
          return { document: stable, matchedIds: [], targetOperationId: null, confirmed: true };
        }
        if (m.kind !== 'PULL' && m.kind !== 'RECONCILE') {
          await begin(context.job, m);
          await context.recordSubmissionIntent();
        }
        if (m.kind !== 'PULL') {
          if (!m.detail.requests?.length || !m.detail.writeMode) throw new JobFailure('INVALID_INPUT', 'NOT_SUBMITTED');
          try {
            const response = await client.batchUpdate(binding.documentId, before.revisionId, m.detail.requests, m.detail.writeMode);
            // Preserve known provider response before the closure's post-operation authorization fence.
            await transition(m.operationId, 'UNKNOWN', { response });
          } catch (error) {
            // GoogleDocsClient validates request shapes synchronously before dispatch and
            // wraps post-dispatch failures as GoogleDocsApiError. A raw TypeError is therefore
            // a known local rejection, never an uncertain provider effect.
            if (error instanceof TypeError) {
              await transition(m.operationId, 'FAILED');
              throw new JobFailure('INVALID_REQUEST', 'NOT_SUBMITTED');
            }
            const uncertain = !(error instanceof GoogleDocsApiError) || error.mayHaveCommitted;
            await transition(m.operationId, uncertain ? 'UNKNOWN' : 'FAILED');
            throw new JobFailure(uncertain ? 'UNKNOWN_OUTCOME' : 'PROVIDER_REJECTED', uncertain ? 'UNKNOWN' : 'KNOWN_FAILED');
          }
        }
        const after = m.kind === 'PULL' ? before : await client.getDocument(binding.documentId);
        const result = await proof(context.job, m, after);
        if (!result.confirmed) {
          if (m.kind === 'RECONCILE' || m.kind === 'PULL') {
            await transition(m.operationId, 'FAILED');
            throw new JobFailure('READBACK_UNCONFIRMED', 'KNOWN_FAILED');
          }
          await transition(m.operationId, 'PARTIAL');
          throw new JobFailure('READBACK_UNCONFIRMED', 'UNKNOWN');
        }
        if (m.kind === 'PULL' || m.kind === 'RECONCILE') await transition(m.operationId, 'SUBMITTED');
        return result;
      });
    },
    failed: async (context: JobContext) => {
      const m = manifest(context.job);
      const [row, job, attempt] = await Promise.all([
        deps.prisma.googleDocSyncOperation.findUnique({ where: { id: m.operationId } }),
        deps.prisma.job.findUnique({ where: { id: context.job.id } }),
        deps.prisma.jobAttempt.findFirst({ where: { jobId: context.job.id }, orderBy: { ordinal: 'desc' } }),
      ]);
      if (!row || !job || ['RETRY_WAIT', 'QUEUED', 'RUNNING'].includes(job.status)) return;
      const submitted = !!attempt?.providerSubmittedAt || ['UNKNOWN', 'MAY_STILL_RUN'].includes(job.providerOutcome);
      if (row.state === 'SUBMITTED') await transition(row.id, submitted ? 'UNKNOWN' : job.status === 'CANCELLED' ? 'CANCELLED' : 'FAILED');
      else if (row.state === 'QUEUED') await transition(row.id, job.status === 'CANCELLED' ? 'CANCELLED' : 'FAILED');
    },
    commit: async (tx, value, job) => {
      const m = manifest(job), result = value as Result;
      await fence(tx, job, m);
      const targetOperation = result.targetOperationId ? await tx.googleDocSyncOperation.findFirst({ where: { id: result.targetOperationId, projectId: job.projectId, bindingId: m.bindingId } }) : null;
      const effect = targetOperation ? obj(targetOperation.manifestJson) as unknown as Manifest : m;
      const binding = await tx.googleDocBinding.findUniqueOrThrow({ where: { id: m.bindingId } });
      const converted = googleTabToArticleContent(result.document, binding.tabId);
      const source = effect.sourceVersionId ? await tx.articleVersion.findFirst({ where: { id: effect.sourceVersionId, projectId: job.projectId } }) : null;
      const sourceContent = source ? articleContentSchema.parse(source.content) : null;
      const inboundContent = articleContentSchema.parse({ ...converted.content, title: sourceContent?.title ?? converted.content.title });
      const actor = { userId: job.requestedBy, sessionId: m.sessionId ?? '', noticeAcceptedAt: new Date(m.noticeAcceptedAt) };
      const { snapshot } = await deps.sync.persistSnapshot(tx, actor, job.projectId, m.bindingId, { document: result.document, content: converted.content,
        plainText: converted.plainText, threads: extractGoogleThreads(result.document, binding.tabId), contentHash: canonicalManifestHash({ document: result.document, tabId: binding.tabId }) });
      if (result.localPostLink) {
        const thread = await tx.googleDocRemoteThread.findFirst({ where: { id: result.localPostLink.threadId, bindingId: m.bindingId } });
        if (!thread) throw new JobFailure('ANNOTATION_LINK_LOST', 'KNOWN_SUCCEEDED');
        const payload = obj(thread.payloadJson), links = obj(payload.localPostLinks);
        if (typeof links[result.localPostLink.localPostId] === 'string' && links[result.localPostLink.localPostId] !== result.localPostLink.remotePostId) {
          throw new JobFailure('ANNOTATION_LINK_CONFLICT', 'KNOWN_SUCCEEDED');
        }
        await tx.googleDocRemoteThread.update({ where: { id: thread.id }, data: { payloadJson: json({ ...payload, localPostLinks: { ...links, [result.localPostLink.localPostId]: result.localPostLink.remotePostId } }), updatedAt: new Date(Date.now() + 1) } });
      }
      let candidateId: string | null = null;
      const changed = sourceContent === null || canonicalManifestHash(canonicalGoogleArticleDocument(sourceContent)) !== canonicalManifestHash(canonicalGoogleArticleDocument(converted.content));
      const acceptedSuggestion = effect.kind === 'SUGGESTION_ACCEPT';
      if (!converted.unsupported.length && converted.inlineCoordinatesValid && (changed || acceptedSuggestion) && result.confirmed) {
        const dedupeHash = canonicalManifestHash({ content: canonicalGoogleArticleDocument(inboundContent), frozenInputs: effect.frozenInputs });
        const prior = await tx.googleDocSnapshotCandidate.findUnique({ where: { bindingId_dedupeHash: { bindingId: m.bindingId, dedupeHash } } });
        candidateId = prior?.articleVersionId ?? await deps.articles.appendGoogleCandidate(tx, job.requestedBy, job.projectId, inboundContent, effect.frozenInputs, job.id);
        if (!prior) await tx.googleDocSnapshotCandidate.create({ data: { id: randomUUID(), projectId: job.projectId, bindingId: m.bindingId, snapshotId: snapshot.id,
          sourceVersionId: effect.sourceVersionId, articleVersionId: candidateId, dedupeHash, frozenInputsJson: json(effect.frozenInputs) } });
      }
      // A completed remote suggestion can become the shared baseline once a later read proves
      // that the exact frozen source version is now committed in Google Docs. This avoids a
      // false three-way conflict on the next local edit while preserving open suggestions.
      let baselineAdvance: { baselineSnapshotId: string; baselineVersionId: string } | null = null;
      if (result.confirmed && m.kind === 'PULL' && source && sourceContent && !converted.unsupported.length
        && converted.inlineCoordinatesValid
        && canonicalManifestHash(canonicalGoogleArticleDocument(sourceContent)) === canonicalManifestHash(canonicalGoogleArticleDocument(converted.content))
        && !extractGoogleThreads(result.document, binding.tabId).some(thread => thread.kind === 'suggestion' && thread.status === 'OPEN')) {
        baselineAdvance = { baselineSnapshotId: snapshot.id, baselineVersionId: source.id };
      }
      const annotationId = effect.detail.payload?.annotationId;
      if (typeof annotationId === 'string' && result.matchedIds.length) await tx.googleDocRemoteThread.updateMany({ where: { bindingId: m.bindingId, remoteId: { in: result.matchedIds }, localAnnotationId: null }, data: { localAnnotationId: annotationId, updatedAt: new Date(Date.now() + 1) } });
      for (const id of [m.operationId, ...(result.targetOperationId && result.confirmed ? [result.targetOperationId] : [])]) {
        const row = await tx.googleDocSyncOperation.findUniqueOrThrow({ where: { id } });
        await tx.googleDocSyncOperation.update({ where: { id }, data: { state: 'SUCCEEDED', readbackSnapshotId: snapshot.id,
          ...(id === m.operationId ? { resultVersionId: candidateId } : {}), updatedAt: new Date(Math.max(Date.now(), row.updatedAt.getTime() + 1)) } });
      }
      await tx.googleDocSyncState.update({ where: { bindingId: m.bindingId }, data: { status: converted.unsupported.length ? 'UNSUPPORTED' : result.confirmed ? 'SYNCED' : 'UNKNOWN', latestCandidateId: candidateId,
        lastSuccessAt: result.confirmed ? new Date() : null,
        ...(m.kind === 'PUSH' && m.detail.writeMode === 'EDIT' ? { baselineSnapshotId: snapshot.id, baselineVersionId: m.sourceVersionId } : {}),
        ...(baselineAdvance ?? {}), updatedAt: new Date() } });
      return json({ operationId: m.operationId, snapshotId: snapshot.id, candidateVersionId: candidateId, confirmed: result.confirmed });
    },
  };
}
