import { randomBytes, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import {
  ArticleAnnotationService, ArticleService, DependencyHealthService, DurableJobService, EXTERNAL_PROCESSING_NOTICE,
  FactualBasisService, GoogleDocSyncService, GoogleSyncCredentials,
  GOOGLE_DOCS_FILE_SCOPE, GoogleDocsApiError, GoogleOAuthError,
  createGoogleDocSyncHandler, googleTabToArticleContent, loadGoogleOAuthRuntime, loadRuntimeConfig,
  type ArticleContent, type JobContext,
} from '@contextflow/backend';
import { SessionService } from '../../apps/api/dist/auth/session-service.js';
import { SESSION_COOKIE } from '../../apps/api/src/auth/csrf.js';
import { tokenDigest } from '../../apps/api/src/auth/session-crypto.js';
import { ExternalProcessingService } from '../../apps/api/dist/auth/external-processing.js';
import type { AuthenticatedRequest } from '../../apps/api/src/auth/session.guard.js';
import { GoogleOAuthService } from '../../apps/api/dist/google-docs/google-oauth.service.js';
import { GoogleDocCreateService } from '../../apps/api/dist/google-docs/google-doc-create.service.js';
import { GoogleDocBindingService } from '../../apps/api/dist/google-docs/google-doc-binding.service.js';

/**
 * Opt-in live product-path harness. Uses the real OAuth client/crypto, Google
 * client, encrypted TEST connection, binding/create/sync services and durable
 * TEST job journal. The only app-auth seam is a local synthetic SessionService
 * identity for the callback; no production account, article, or auth cookie is
 * read. A separate explicit CLI flag is required before asking Google for an
 * offline refresh grant that will be stored encrypted in isolated TEST.
 */

const envFile = resolve(process.cwd(), '.env');
process.loadEnvFile(envFile);
if (!process.argv.includes('--confirmed-offline-google-access')) {
  throw new Error('Refusing to request/store an offline Google refresh grant. Re-run only after owner authorization with --confirmed-offline-google-access.');
}

process.env['NODE_ENV'] = 'test';
process.env['API_HOST'] = 'localhost';
process.env['API_PORT'] = '3000';
for (const key of ['GOOGLE_DOCS_CLIENT_ID', 'GOOGLE_DOCS_CLIENT_SECRET', 'GOOGLE_DOCS_REDIRECT_URI'] as const) {
  const value = process.env[key];
  if (!value) throw new Error(`Missing ${key} in ignored .env`);
  process.env[`TEST_${key}`] = value;
}
if (process.env['GOOGLE_DOCS_REDIRECT_URI'] !== 'http://localhost:3000/api/v1/google-docs/oauth/callback') {
  throw new Error('The configured local Google callback does not match localhost:3000');
}
if (!process.env['TEST_GOOGLE_DOCS_TOKEN_ENCRYPTION_KEY'] || !process.env['TEST_GOOGLE_DOCS_TOKEN_ENCRYPTION_KEY_VERSION']) {
  throw new Error('Missing TEST-only Google token encryption key in ignored .env');
}

const config = loadRuntimeConfig();
if (config.nodeEnv !== 'test' || new URL(config.databaseUrl).port !== '54330') {
  throw new Error('Refusing to run outside isolated TEST PostgreSQL on port 54330');
}
const runtime = loadGoogleOAuthRuntime();
if (runtime.kind !== 'configured') throw new Error('Google OAuth runtime is not configured');
const oauthCrypto = runtime.crypto;

const health = new DependencyHealthService(config);
const jobs = new DurableJobService(health.prisma, { noticeVersion: EXTERNAL_PROCESSING_NOTICE.version });
const facts = new FactualBasisService(health.prisma, jobs);
const articles = new ArticleService(health.prisma, jobs, facts);
const externalProcessing = new ExternalProcessingService(health);
const userId = randomUUID(), workspaceId = randomUUID(), projectId = randomUUID(), sessionId = randomUUID();
const cookie = randomBytes(32).toString('base64url');
const noticeAcceptedAt = new Date();
const sessionIsActive = new Map([[cookie, true]]);
const request = {
  headers: { cookie: `${SESSION_COOKIE}=${cookie}` },
  sessionUser: { id: userId, email: 'synthetic-google-roundtrip@example.invalid', displayName: 'Synthetic Google roundtrip' },
} as unknown as AuthenticatedRequest;
const sessions = {
  check: async (value: string) => sessionIsActive.get(value)
    ? { kind: 'active' as const, user: { id: userId, email: 'synthetic-google-roundtrip@example.invalid', displayName: 'Synthetic Google roundtrip' } }
    : { kind: 'expired' as const },
} as unknown as SessionService;
const oauth = new GoogleOAuthService(health, sessions, externalProcessing, runtime);
const create = new GoogleDocCreateService(health, oauth);
const bindingService = new GoogleDocBindingService(health, oauth);
const credentials = new GoogleSyncCredentials(health.prisma, runtime);
const sync = new GoogleDocSyncService(health.prisma, jobs, articles, credentials);
const handler = createGoogleDocSyncHandler({ prisma: health.prisma, articles, credentials, sync });
const annotationService = new ArticleAnnotationService(health.prisma, articles);
const receiptPath = resolve(process.cwd(), '.local-checks/google-docs-product-roundtrip.json');

const safeReceipt: Record<string, unknown> = {
  schemaVersion: 'google-docs-product-roundtrip-v1',
  startedAt: new Date().toISOString(),
  status: 'PENDING',
  boundary: 'Synthetic fixture identity stubs only SessionService.check in this local harness; OAuth callback, encryption, Google client, create/bind, sync credentials and durable job path are real.',
  checks: [],
};
await health.prisma.userProfile.create({ data: { id: userId, displayName: 'Synthetic Google roundtrip',
  externalProcessingNoticeVersion: EXTERNAL_PROCESSING_NOTICE.version, externalProcessingAcceptedAt: noticeAcceptedAt } });
await health.prisma.workspace.create({ data: { id: workspaceId, name: 'Synthetic Google Docs roundtrip', ownerId: userId,
  members: { create: [{ userId }] }, styles: { create: { revision: 1, createdBy: userId } } } });
await health.prisma.project.create({ data: { id: projectId, workspaceId, topic: 'Synthetic Google Docs roundtrip', createdBy: userId, formats: ['ARTICLE'] } });
await health.prisma.appSession.create({ data: { id: sessionId, userId, cookieDigest: tokenDigest(cookie), tokenKeyVersion: 1,
  encryptedProviderTokens: 'synthetic-test-session-only', providerTokenExpiresAt: new Date(Date.now() + 3_600_000),
  expiresAt: new Date(Date.now() + 3_600_000), lastUserActivityAt: new Date() } });
await articles.importArticle(userId, projectId, { expectedRevision: 0, contentMode: 'CREATIVE', content: {
  title: 'Synthetic Google Docs review', document: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Synthetic Google Docs roundtrip 😀.' }] }] },
} });
const checkpoint = await articles.checkpoint(userId, projectId, { expectedRevision: 1 });
const sourceVersion = checkpoint.article!.versions[0]!;
const approvedSource = await articles.review(userId, projectId, sourceVersion.id, 'approve', {
  expectedRevision: checkpoint.article!.revision, acknowledgeUnmapped: true,
});
let articleRevision = approvedSource.article!.revision;
const approvedVersionId = approvedSource.article!.currentApprovedVersionId;
const originalDraft = approvedSource.article!.draft;
if (approvedVersionId !== sourceVersion.id || !originalDraft) throw new Error('Synthetic source checkpoint was not approved with its draft intact');
const actor = { userId, sessionId, noticeAcceptedAt };
let connectionId = '';
let bindingId = '';
let documentId = '';
let tabId = '';
let currentStage = 'test_fixture_setup';

async function persistReceipt(): Promise<void> {
  await mkdir(resolve(process.cwd(), '.local-checks'), { recursive: true });
  await writeFile(receiptPath, `${JSON.stringify(safeReceipt, null, 2)}\n`, { mode: 0o600 });
}

async function setStage(stage: string): Promise<void> {
  currentStage = stage;
  safeReceipt['currentStage'] = stage;
  await persistReceipt();
}

function safeFailureCategory(error: unknown): string {
  if (error instanceof GoogleOAuthError) return `GOOGLE_OAUTH_${error.kind}`;
  if (error instanceof GoogleDocsApiError) return `GOOGLE_DOCS_${error.kind}`;
  if (error && typeof error === 'object') {
    const code = 'code' in error && typeof error.code === 'string' ? error.code : '';
    if (/^P\d{4}$/u.test(code)) return `PRISMA_${code}`;
    const category = 'category' in error && typeof error.category === 'string' ? error.category : '';
    if (/^[A-Z][A-Z0-9_]{1,63}$/u.test(category)) return `JOB_${category}`;
    const status = 'status' in error && typeof error.status === 'number' ? error.status : null;
    if (status !== null && Number.isInteger(status) && status >= 400 && status <= 599) return `APP_HTTP_${status}`;
  }
  return 'UNEXPECTED_ERROR';
}

async function executeJob(jobId: string) {
  const claimed = await jobs.claim(jobId, 1, randomUUID());
  if (!claimed) throw new Error('Durable TEST job could not be claimed');
  const { job, attempt } = claimed;
  const context: JobContext = {
    job, attempt, signal: new AbortController().signal,
    recordSubmissionIntent: () => jobs.providerIntent(job, attempt, undefined, tx => handler.validateSubmission!(tx, job)),
    recordProviderRun: id => jobs.providerIntent(job, attempt, id),
    setProgress: stage => jobs.progress(job, attempt, stage),
  };
  try {
    const result = await handler.execute(context);
    await jobs.succeed(job, attempt, handler, result);
  } catch (error) {
    await jobs.fail(job, attempt, error).catch(() => undefined);
    await handler.failed?.(context, error).catch(() => undefined);
    throw error;
  }
  return health.prisma.googleDocSyncOperation.findUniqueOrThrow({ where: { projectId_jobId: { projectId, jobId } } });
}

async function finishRoundtrip(): Promise<void> {
  await setStage('document_create_and_bind');
  const created = await create.create(request, projectId, { connectionId, commandKey: randomUUID(), title: 'ContextFlow synthetic Google Docs roundtrip', expectedArticleRevision: articleRevision });
  if (created.command.state !== 'CREATED' || !created.document?.documentId) throw new Error('Synthetic Google Doc creation did not confirm');
  documentId = created.document.documentId;
  const inspected = await bindingService.inspect(request, projectId, { connectionId, documentId });
  const firstTab = inspected.document.tabs[0];
  if (!firstTab) throw new Error('Created synthetic document has no selectable tab');
  tabId = firstTab.tabId;
  const bound = await bindingService.bind(request, projectId, { connectionId, documentId, tabId, commandKey: randomUUID(), expectedArticleRevision: articleRevision, acknowledgeWorkspaceSharing: true });
  bindingId = bound.binding.id;
  safeReceipt['documentId'] = documentId;
  safeReceipt['connectionId'] = connectionId;
  safeReceipt['bindingId'] = bindingId;
  safeReceipt['projectId'] = projectId;
  safeReceipt['sourceVersionId'] = sourceVersion.id;
  safeReceipt['articleRevision'] = articleRevision;
  safeReceipt['currentStage'] = currentStage;
  safeReceipt['checks'] = [{ name: 'oauth_offline_connection_encrypted_in_test', status: 'PASS', scope: GOOGLE_DOCS_FILE_SCOPE },
    { name: 'blank_document_created_and_selected_tab_bound', status: 'PASS' }];
  await persistReceipt();

  await setStage('initial_approved_article_push');
  const preview = await sync.preview(actor, projectId, { connectionId, sourceVersionId: sourceVersion.id, kind: 'PUSH', expectedArticleRevision: articleRevision });
  if (preview.unsupported.length || !preview.writeMode) throw new Error('Synthetic Article push preview is unsupported');
  const confirmed = await sync.confirm(actor, projectId, { previewId: preview.previewId, commandKey: randomUUID(), expectedArticleRevision: articleRevision });
  const pushed = await executeJob(confirmed.job.id);
  if (pushed.state !== 'SUCCEEDED') throw new Error('Initial Article push did not succeed');
  const docContext = { projectId, bindingId, userId, connectionId, sessionId, noticeAcceptedAt, backgroundGeneration: null };
  const afterPush = await credentials.withClient(docContext, client => client.getDocument(documentId));
  const imported = googleTabToArticleContent(afterPush, tabId);
  if (imported.plainText !== 'Synthetic Google Docs roundtrip 😀.') throw new Error('Initial Article text was not confirmed by Google readback');
  safeReceipt['checks'] = [...safeReceipt['checks'] as unknown[], { name: 'durable_initial_article_push_and_readback', status: 'PASS' }];
  await persistReceipt();

  await setStage('native_comment_and_google_reply_import');
  const anchor = { startIndex: 1, endIndex: 10, tabId };
  await credentials.withClient(docContext, client => client.insertComment(documentId, afterPush.revisionId, anchor, 'Synthetic native comment'));
  const commentAfterCreate = await credentials.withClient(docContext, client => client.getDocument(documentId));
  const nativeComment = commentAfterCreate.comments?.find(item => item.headPost.content === 'Synthetic native comment');
  if (!nativeComment) throw new Error('Synthetic native comment was not created');
  await credentials.withClient(docContext, client => client.reply(documentId, commentAfterCreate.revisionId, nativeComment.commentId, 'Synthetic reply from Google'));
  const pullNativeComment = async () => {
    const queued = await sync.pull(actor, projectId, { connectionId, sourceVersionId: sourceVersion.id, commandKey: randomUUID(), expectedArticleRevision: articleRevision });
    const pulled = await executeJob(queued.job.id);
    if (pulled.state !== 'SUCCEEDED') throw new Error('Native comment pull did not succeed');
    return sync.status(actor, projectId, sourceVersion.id);
  };
  let status = await pullNativeComment();
  const threadMatches = () => status.threads.filter(item => item.kind === 'comment' && item.remoteId === nativeComment.commentId);
  if (threadMatches().length !== 1 || threadMatches()[0]?.anchorStatus !== 'anchored') throw new Error('Native comment/anchor was not imported from Google');
  const importedThread = threadMatches()[0]!;
  const nativePayload = importedThread.payload as { headPost?: { author?: { displayName?: string; me?: boolean } }; replies?: Array<{ content?: string; author?: { displayName?: string; me?: boolean } }> };
  if (!nativePayload.headPost?.author?.displayName || nativePayload.headPost.author.me !== true
    || !nativePayload.replies?.some(item => item.content === 'Synthetic reply from Google' && item.author?.displayName)) {
    throw new Error('Google comment author or native reply was not preserved');
  }
  status = await pullNativeComment();
  if (threadMatches().length !== 1) throw new Error('Repeated Google comment import duplicated the native thread');
  safeReceipt['checks'] = [...safeReceipt['checks'] as unknown[], { name: 'native_comment_author_reply_anchor_and_repeat_pull', status: 'PASS' }];
  await persistReceipt();

  await setStage('contextflow_reply_export');
  const replyPreview = await sync.preview(actor, projectId, { connectionId, sourceVersionId: sourceVersion.id, kind: 'COMMENT_REPLY', threadId: importedThread.id,
    body: 'Synthetic reply from ContextFlow', expectedArticleRevision: articleRevision });
  if (replyPreview.unsupported.length) throw new Error('Native comment reply preview is unsupported');
  const replyQueued = await sync.confirm(actor, projectId, { previewId: replyPreview.previewId, commandKey: randomUUID(), expectedArticleRevision: articleRevision });
  if ((await executeJob(replyQueued.job.id)).state !== 'SUCCEEDED') throw new Error('Comment reply export failed');

  const comment = await credentials.withClient(docContext, client => client.getDocument(documentId));
  const nativeThread = comment.comments?.find(item => item.headPost.content === 'Synthetic native comment');
  if (!nativeThread?.replies?.some(item => item.content === 'Synthetic reply from ContextFlow')) throw new Error('Reply was not confirmed on the native Google thread');
  safeReceipt['checks'] = [...safeReceipt['checks'] as unknown[], { name: 'contextflow_reply_exported_and_read_back', status: 'PASS' }];
  await persistReceipt();

  await setStage('native_comment_resolve_reopen_identity');
  for (const action of ['COMMENT_RESOLVE', 'COMMENT_REOPEN'] as const) {
    const decisionPreview = await sync.preview(actor, projectId, { connectionId, sourceVersionId: sourceVersion.id, kind: action,
      threadId: importedThread.id, expectedArticleRevision: articleRevision });
    if (decisionPreview.unsupported.length) throw new Error('Native comment status preview is unsupported');
    const decision = await sync.confirm(actor, projectId, { previewId: decisionPreview.previewId, commandKey: randomUUID(), expectedArticleRevision: articleRevision });
    if ((await executeJob(decision.job.id)).state !== 'SUCCEEDED') throw new Error('Native comment status action did not succeed');
    status = await pullNativeComment();
    status = await pullNativeComment();
    const identity = status.threads.filter(item => item.kind === 'comment' && item.remoteId === nativeComment.commentId);
    const expectedStatus = action === 'COMMENT_RESOLVE' ? 'RESOLVED' : 'OPEN';
    if (identity.length !== 1 || identity[0]?.id !== importedThread.id || identity[0]?.status !== expectedStatus) {
      throw new Error('Native comment identity/status changed after resolve, reopen, or repeated pull');
    }
  }
  safeReceipt['checks'] = [...safeReceipt['checks'] as unknown[], { name: 'resolve_reopen_and_repeated_pull_keep_native_thread_id', status: 'PASS' }];
  await persistReceipt();

  await setStage('local_comment_export');
  const localComment = await annotationService.create(userId, projectId, { articleVersionId: sourceVersion.id, contentHash: sourceVersion.sha256,
    kind: 'COMMENT', anchorStart: 0, anchorEnd: 9, body: 'Synthetic local comment', commandKey: randomUUID() });
  const localThread = localComment.threads[0];
  if (!localThread) throw new Error('Synthetic local comment was not created');
  const exportPreview = await sync.preview(actor, projectId, { connectionId, sourceVersionId: sourceVersion.id, kind: 'COMMENT_CREATE', annotationId: localThread.id,
    body: localThread.body, rangeStart: 0, rangeEnd: 9, expectedArticleRevision: articleRevision });
  if (exportPreview.unsupported.length) throw new Error('Local comment export preview is unsupported');
  const exportQueued = await sync.confirm(actor, projectId, { previewId: exportPreview.previewId, commandKey: randomUUID(), expectedArticleRevision: articleRevision });
  if ((await executeJob(exportQueued.job.id)).state !== 'SUCCEEDED') throw new Error('Local comment export did not succeed');
  const afterCommentExport = await credentials.withClient(docContext, client => client.getDocument(documentId));
  if (afterCommentExport.comments?.filter(item => item.headPost.content === 'Synthetic local comment').length !== 1) throw new Error('Exported local comment was not present exactly once');
  safeReceipt['checks'] = [...safeReceipt['checks'] as unknown[], { name: 'local_comment_exported_once', status: 'PASS' }];
  await persistReceipt();

  await setStage('native_suggestion_import');
  const beforeSuggestion = await credentials.withClient(docContext, client => client.getDocument(documentId));
  await credentials.withClient(docContext, client => client.batchUpdate(documentId, beforeSuggestion.revisionId,
    [{ insertText: { location: { index: 1, tabId }, text: 'Suggested ' } }], 'SUGGEST'));
  const pullNativeSuggestion = async () => {
    const queued = await sync.pull(actor, projectId, { connectionId, sourceVersionId: sourceVersion.id, commandKey: randomUUID(), expectedArticleRevision: articleRevision });
    if ((await executeJob(queued.job.id)).state !== 'SUCCEEDED') throw new Error('Native suggestion pull did not succeed');
    return sync.status(actor, projectId, sourceVersion.id);
  };
  let finalStatus = await pullNativeSuggestion();
  const nativeSuggestion = finalStatus.threads.filter(item => item.kind === 'suggestion' && item.status === 'OPEN');
  if (nativeSuggestion.length !== 1) {
    throw new Error('Open native Google suggestion was not preserved in the sync projection');
  }
  finalStatus = await pullNativeSuggestion();
  if (finalStatus.threads.filter(item => item.kind === 'suggestion' && item.remoteId === nativeSuggestion[0]!.remoteId).length !== 1) {
    throw new Error('Repeated native suggestion pull duplicated its thread');
  }
  safeReceipt['checks'] = [...safeReceipt['checks'] as unknown[], { name: 'native_open_suggestion_imported_once', status: 'PASS' }];
  await persistReceipt();

  await setStage('native_suggestion_accept_and_candidate');
  const beforeSuggestionAccept = await articles.get(userId, projectId);
  const beforeAcceptDraft = beforeSuggestionAccept.article!.draft!;
  const suggestionPreview = await sync.preview(actor, projectId, { connectionId, sourceVersionId: sourceVersion.id, kind: 'SUGGESTION_ACCEPT',
    threadId: nativeSuggestion[0]!.id, expectedArticleRevision: articleRevision });
  if (suggestionPreview.unsupported.length) throw new Error('Native suggestion accept preview is unsupported');
  const suggestionConfirm = await sync.confirm(actor, projectId, { previewId: suggestionPreview.previewId, commandKey: randomUUID(), expectedArticleRevision: articleRevision });
  const acceptedSuggestion = await executeJob(suggestionConfirm.job.id);
  if (acceptedSuggestion.state !== 'SUCCEEDED' || !acceptedSuggestion.resultVersionId) throw new Error('Native suggestion acceptance did not create an Article candidate');
  const candidate = await health.prisma.articleVersion.findUniqueOrThrow({ where: { id: acceptedSuggestion.resultVersionId } });
  const afterSuggestionAccept = await articles.get(userId, projectId);
  if (candidate.origin !== 'UNVERIFIED_IMPORTED' || candidate.approvedAt !== null || candidate.plainText !== 'Suggested Synthetic Google Docs roundtrip 😀.'
    || afterSuggestionAccept.article?.currentApprovedVersionId !== approvedVersionId
    || afterSuggestionAccept.article?.revision !== articleRevision
    || afterSuggestionAccept.article?.draft?.baseVersionId !== beforeAcceptDraft.baseVersionId
    || afterSuggestionAccept.article?.draft?.sha256 !== beforeAcceptDraft.sha256) {
    throw new Error('Imported suggestion changed approval, draft, or Article revision before explicit apply');
  }
  safeReceipt['candidateVersionId'] = candidate.id;
  safeReceipt['checks'] = [...safeReceipt['checks'] as unknown[], { name: 'accepted_native_suggestion_appended_unverified_candidate', status: 'PASS' }];
  await persistReceipt();

  await setStage('apply_candidate_and_advance_baseline');
  const applied = await articles.review(userId, projectId, candidate.id, 'apply', { expectedRevision: articleRevision, acknowledgeUnmapped: true });
  articleRevision = applied.article!.revision;
  const stateAfterApply = await health.prisma.googleDocSyncState.findUniqueOrThrow({ where: { bindingId } });
  const acceptedOperation = await health.prisma.googleDocSyncOperation.findUniqueOrThrow({ where: { id: acceptedSuggestion.id } });
  if (stateAfterApply.baselineVersionId !== candidate.id || stateAfterApply.baselineSnapshotId !== acceptedOperation.readbackSnapshotId
    || applied.article?.currentApprovedVersionId !== approvedVersionId || applied.article.draft?.baseVersionId !== candidate.id) {
    throw new Error('Applying the imported candidate did not advance its exact baseline while preserving approval');
  }
  safeReceipt['articleRevisionAfterApply'] = articleRevision;
  safeReceipt['checks'] = [...safeReceipt['checks'] as unknown[], { name: 'explicit_candidate_apply_advances_baseline_preserves_approval', status: 'PASS' }];
  await persistReceipt();

  await setStage('candidate_followup_local_comment_export');
  const followup = await annotationService.create(userId, projectId, { articleVersionId: candidate.id, contentHash: candidate.sha256,
    kind: 'COMMENT', anchorStart: 0, anchorEnd: 9, body: 'Synthetic follow-up on applied candidate', commandKey: randomUUID() });
  const followupThread = followup.threads[0];
  if (!followupThread) throw new Error('Follow-up local annotation was not created');
  const followupPreview = await sync.preview(actor, projectId, { connectionId, sourceVersionId: candidate.id, kind: 'COMMENT_CREATE', annotationId: followupThread.id,
    body: followupThread.body, rangeStart: 0, rangeEnd: 9, expectedArticleRevision: articleRevision });
  if (followupPreview.unsupported.length) throw new Error('Follow-up local annotation export preview is unsupported');
  const followupQueued = await sync.confirm(actor, projectId, { previewId: followupPreview.previewId, commandKey: randomUUID(), expectedArticleRevision: articleRevision });
  if ((await executeJob(followupQueued.job.id)).state !== 'SUCCEEDED') throw new Error('Follow-up local annotation export failed');
  const followupReadback = await credentials.withClient(docContext, client => client.getDocument(documentId));
  if (followupReadback.comments?.filter(item => item.headPost.content === 'Synthetic follow-up on applied candidate').length !== 1) {
    throw new Error('Follow-up annotation on the applied candidate was not exported exactly once');
  }
  safeReceipt['checks'] = [...safeReceipt['checks'] as unknown[], { name: 'applied_candidate_followup_annotation_export', status: 'PASS' }];
  await persistReceipt();

  await setStage('local_replacement_suggestion_export_and_native_group_import');
  const localSuggestion = await annotationService.create(userId, projectId, { articleVersionId: candidate.id, contentHash: candidate.sha256,
    kind: 'SUGGESTION', anchorStart: 10, anchorEnd: 19, body: 'Synthetic local replacement proposal', replacementText: 'Reviewed', commandKey: randomUUID() });
  const localSuggestionThread = localSuggestion.threads[0];
  if (!localSuggestionThread) throw new Error('Synthetic local replacement suggestion was not created');
  const replacementPreview = await sync.preview(actor, projectId, { connectionId, sourceVersionId: candidate.id, kind: 'SUGGESTION_CREATE',
    annotationId: localSuggestionThread.id, body: localSuggestionThread.body, replacementText: 'Reviewed', rangeStart: 10, rangeEnd: 19, expectedArticleRevision: articleRevision });
  if (replacementPreview.unsupported.length || replacementPreview.writeMode !== 'SUGGEST') throw new Error('Local replacement suggestion preview is unsupported');
  const replacementFrozen = await health.prisma.googleDocSyncPreview.findUniqueOrThrow({ where: { id: replacementPreview.previewId } });
  const replacementRequests = (replacementFrozen.frozenJson as { requests?: Array<Record<string, unknown>> }).requests ?? [];
  const expectedQuoteRange = replacementRequests.find(request => 'deleteContentRange' in request) as { deleteContentRange?: { range?: { startIndex?: number; endIndex?: number; tabId?: string } } } | undefined;
  const expectedInsertion = replacementRequests.find(request => 'insertText' in request) as { insertText?: { location?: { index?: number; tabId?: string }; text?: string } } | undefined;
  if (!expectedQuoteRange?.deleteContentRange?.range || !expectedInsertion?.insertText
    || expectedQuoteRange.deleteContentRange.range.startIndex !== expectedInsertion.insertText.location?.index
    || expectedQuoteRange.deleteContentRange.range.endIndex! - expectedQuoteRange.deleteContentRange.range.startIndex! !== 'Synthetic'.length
    || expectedInsertion.insertText.text !== 'Reviewed' || expectedQuoteRange.deleteContentRange.range.tabId !== tabId
    || expectedInsertion.insertText.location?.tabId !== tabId) {
    throw new Error('Local replacement suggestion did not freeze exact Google delete/insert coordinates');
  }
  const replacementQueued = await sync.confirm(actor, projectId, { previewId: replacementPreview.previewId, commandKey: randomUUID(), expectedArticleRevision: articleRevision });
  if ((await executeJob(replacementQueued.job.id)).state !== 'SUCCEEDED') throw new Error('Local replacement suggestion export did not confirm');
  const pullReplacement = await sync.pull(actor, projectId, { connectionId, sourceVersionId: candidate.id, commandKey: randomUUID(), expectedArticleRevision: articleRevision });
  if ((await executeJob(pullReplacement.job.id)).state !== 'SUCCEEDED') throw new Error('Local replacement suggestion readback failed');
  const linkedReplacementParts = await health.prisma.googleDocRemoteThread.findMany({ where: { bindingId, localAnnotationId: localSuggestionThread.id, kind: 'SUGGESTION' } });
  const replacementReadback = await credentials.withClient(docContext, client => client.getDocument(documentId));
  const importedReplacementParts = googleTabToArticleContent(replacementReadback, tabId).suggestions.filter(part => part.type !== 'style'
    && (part.text === 'Synthetic' || part.text === 'Reviewed'));
  const linkedIds = new Set(linkedReplacementParts.map(row => row.remoteId));
  if (linkedReplacementParts.length < 1 || linkedIds.size !== linkedReplacementParts.length
    || !linkedReplacementParts.every(row => row.status === 'OPEN')
    || !importedReplacementParts.some(part => part.type === 'deletion' && part.text === 'Synthetic' && linkedIds.has(part.suggestionId))
    || !importedReplacementParts.some(part => part.type === 'insertion' && part.text === 'Reviewed' && linkedIds.has(part.suggestionId))) {
    throw new Error('Google replacement suggestion delete/insert parts were not conservatively linked to native IDs');
  }
  const stillOpenLocalComment = await health.prisma.articleAnnotation.findUniqueOrThrow({ where: { id: followupThread.id } });
  if (stillOpenLocalComment.status !== 'OPEN') throw new Error('Open local comment changed while the replacement suggestion was exported');
  safeReceipt['replacementAnnotationId'] = localSuggestionThread.id;
  safeReceipt['replacementNativeSuggestionCount'] = linkedIds.size;
  safeReceipt['checks'] = [...safeReceipt['checks'] as unknown[], { name: 'local_replacement_delete_insert_parts_linked_to_native_ids_open_local_comment_preserved', status: 'PASS' }];
  await persistReceipt();

  await setStage('local_replacement_accept_whole_group_and_candidate');
  const beforeLocalReplacementAccept = await articles.get(userId, projectId);
  const replacementBaseDraft = beforeLocalReplacementAccept.article!.draft!;
  const replacementAcceptPreview = await sync.preview(actor, projectId, { connectionId, sourceVersionId: candidate.id, kind: 'SUGGESTION_ACCEPT',
    threadId: linkedReplacementParts[0]!.id, expectedArticleRevision: articleRevision });
  if (replacementAcceptPreview.unsupported.length) throw new Error('Local replacement suggestion accept preview is unsupported');
  const acceptFrozen = await health.prisma.googleDocSyncPreview.findUniqueOrThrow({ where: { id: replacementAcceptPreview.previewId } });
  const acceptRequests = (acceptFrozen.frozenJson as { requests?: Array<Record<string, unknown>> }).requests ?? [];
  const requestedIds = acceptRequests.map(request => (request.acceptSuggestion as { suggestionId?: string } | undefined)?.suggestionId).filter((id): id is string => !!id).sort();
  if (JSON.stringify(requestedIds) !== JSON.stringify([...linkedIds].sort())) throw new Error('Accept preview did not freeze decisions for the complete native replacement suggestion group');
  const replacementAcceptQueued = await sync.confirm(actor, projectId, { previewId: replacementAcceptPreview.previewId, commandKey: randomUUID(), expectedArticleRevision: articleRevision });
  const acceptedReplacement = await executeJob(replacementAcceptQueued.job.id);
  if (acceptedReplacement.state !== 'SUCCEEDED' || !acceptedReplacement.resultVersionId) throw new Error('Local replacement acceptance did not create a candidate');
  const replacementCandidate = await health.prisma.articleVersion.findUniqueOrThrow({ where: { id: acceptedReplacement.resultVersionId } });
  const afterLocalReplacementAccept = await articles.get(userId, projectId);
  if (replacementCandidate.origin !== 'UNVERIFIED_IMPORTED' || replacementCandidate.approvedAt !== null
    || afterLocalReplacementAccept.article?.currentApprovedVersionId !== approvedVersionId
    || afterLocalReplacementAccept.article?.revision !== articleRevision
    || afterLocalReplacementAccept.article?.draft?.baseVersionId !== replacementBaseDraft.baseVersionId
    || afterLocalReplacementAccept.article?.draft?.sha256 !== replacementBaseDraft.sha256
    || replacementCandidate.plainText !== 'Suggested Reviewed Google Docs roundtrip 😀.') {
    throw new Error('Whole-group replacement acceptance changed approval/draft or failed to append exact unverified candidate');
  }
  const applyReplacement = await articles.review(userId, projectId, replacementCandidate.id, 'apply', { expectedRevision: articleRevision, acknowledgeUnmapped: true });
  articleRevision = applyReplacement.article!.revision;
  const replacementOperation = await health.prisma.googleDocSyncOperation.findUniqueOrThrow({ where: { id: acceptedReplacement.id } });
  const replacementState = await health.prisma.googleDocSyncState.findUniqueOrThrow({ where: { bindingId } });
  if (replacementState.baselineVersionId !== replacementCandidate.id || replacementState.baselineSnapshotId !== replacementOperation.readbackSnapshotId
    || applyReplacement.article?.currentApprovedVersionId !== approvedVersionId || applyReplacement.article?.draft?.baseVersionId !== replacementCandidate.id
    || (await health.prisma.articleAnnotation.findUniqueOrThrow({ where: { id: followupThread.id } })).status !== 'OPEN') {
    throw new Error('Explicit replacement apply did not advance exact baseline and preserve approval/open local comment');
  }
  safeReceipt['replacementCandidateVersionId'] = replacementCandidate.id;
  safeReceipt['checks'] = [...safeReceipt['checks'] as unknown[], { name: 'whole_native_suggestion_group_accept_candidate_apply_and_baseline', status: 'PASS' }];
  await persistReceipt();

  await setStage('formatting_only_bold_suggestion_roundtrip');
  const styledContent: ArticleContent = { title: 'Synthetic Google Docs review', document: { type: 'doc', content: [{ type: 'paragraph', content: [
    { type: 'text', text: 'Suggested ' }, { type: 'text', text: 'Reviewed', marks: [{ type: 'bold' }] }, { type: 'text', text: ' Google Docs roundtrip 😀.' },
  ] }] } };
  const styledDraftResult = await articles.saveDraft(userId, projectId, { expectedRevision: articleRevision, contentMode: 'CREATIVE', content: styledContent });
  articleRevision = styledDraftResult.article!.revision;
  const styledCheckpoint = await articles.checkpoint(userId, projectId, { expectedRevision: articleRevision });
  articleRevision = styledCheckpoint.article!.revision;
  const styledSourceVersion = styledCheckpoint.article!.versions[0]!;
  const stylePushPreview = await sync.preview(actor, projectId, { connectionId, sourceVersionId: styledSourceVersion.id, kind: 'PUSH', expectedArticleRevision: articleRevision });
  if (stylePushPreview.unsupported.length || stylePushPreview.writeMode !== 'SUGGEST') throw new Error('Formatting-only bold change did not produce a safe Google suggestion preview');
  const styleFrozen = await health.prisma.googleDocSyncPreview.findUniqueOrThrow({ where: { id: stylePushPreview.previewId } });
  const styleRequests = (styleFrozen.frozenJson as { requests?: Array<Record<string, unknown>> }).requests ?? [];
  if (!styleRequests.length || styleRequests.some(request => !('updateTextStyle' in request))) throw new Error('Formatting-only suggestion froze a text mutation instead of formatting requests');
  const styleQueued = await sync.confirm(actor, projectId, { previewId: stylePushPreview.previewId, commandKey: randomUUID(), expectedArticleRevision: articleRevision });
  const styleOperation = await executeJob(styleQueued.job.id);
  if (styleOperation.state !== 'SUCCEEDED') throw new Error('Formatting-only suggestion export did not confirm');
  const stylePull = await sync.pull(actor, projectId, { connectionId, sourceVersionId: styledSourceVersion.id, commandKey: randomUUID(), expectedArticleRevision: articleRevision });
  if ((await executeJob(stylePull.job.id)).state !== 'SUCCEEDED') throw new Error('Formatting-only suggestion import failed');
  const styleReadback = await credentials.withClient(docContext, client => client.getDocument(documentId));
  const boldSuggestionParts = googleTabToArticleContent(styleReadback, tabId).suggestions.filter(part => part.type === 'style' && part.scope === 'text'
    && part.startIndex === 11 && part.endIndex === 19 && part.style && typeof part.style === 'object' && 'textStyle' in part.style && (part.style.textStyle as { bold?: boolean }).bold === true);
  if (!boldSuggestionParts.length) throw new Error('Native formatting-only bold suggestion was not represented with exact range and style');
  const linkedStyleRows = await health.prisma.googleDocRemoteThread.findMany({ where: { bindingId, status: 'OPEN', kind: 'SUGGESTION' } });
  const styleNativeId = boldSuggestionParts[0]!.suggestionId;
  const styleThread = linkedStyleRows.find(row => row.remoteId === styleNativeId);
  if (!styleThread) throw new Error('Native bold suggestion ID was not reconciled into the local thread projection');
  const styleAcceptPreview = await sync.preview(actor, projectId, { connectionId, sourceVersionId: styledSourceVersion.id, kind: 'SUGGESTION_ACCEPT',
    threadId: styleThread.id, expectedArticleRevision: articleRevision });
  if (styleAcceptPreview.unsupported.length) throw new Error('Native bold suggestion acceptance preview is unsupported');
  const styleAcceptQueued = await sync.confirm(actor, projectId, { previewId: styleAcceptPreview.previewId, commandKey: randomUUID(), expectedArticleRevision: articleRevision });
  const acceptedStyle = await executeJob(styleAcceptQueued.job.id);
  if (acceptedStyle.state !== 'SUCCEEDED' || !acceptedStyle.resultVersionId) throw new Error('Native bold suggestion acceptance did not create an unverified candidate');
  const styleCandidate = await health.prisma.articleVersion.findUniqueOrThrow({ where: { id: acceptedStyle.resultVersionId } });
  if (styleCandidate.origin !== 'UNVERIFIED_IMPORTED' || styleCandidate.approvedAt !== null || styleCandidate.plainText !== replacementCandidate.plainText) {
    throw new Error('Accepted native bold suggestion changed text, approval, or imported provenance unexpectedly');
  }
  const styleCandidateContent = styleCandidate.content as { document?: { content?: Array<{ content?: Array<{ text?: string; marks?: Array<{ type?: string }> }> }> } };
  if (!styleCandidateContent.document?.content?.flatMap(block => block.content ?? []).some(run => run.text === 'Reviewed' && run.marks?.some(mark => mark.type === 'bold'))) {
    throw new Error('Accepted bold suggestion was not preserved in the imported Article candidate formatting');
  }
  const applyStyleCandidate = await articles.review(userId, projectId, styleCandidate.id, 'apply', { expectedRevision: articleRevision, acknowledgeUnmapped: true });
  articleRevision = applyStyleCandidate.article!.revision;
  if (applyStyleCandidate.article?.currentApprovedVersionId !== approvedVersionId || applyStyleCandidate.article.draft?.baseVersionId !== styleCandidate.id) {
    throw new Error('Applying formatting candidate changed approval or failed to advance draft baseline');
  }
  safeReceipt['formattingCandidateVersionId'] = styleCandidate.id;
  safeReceipt['checks'] = [...safeReceipt['checks'] as unknown[], { name: 'formatting_only_bold_suggestion_roundtrip_candidate_apply', status: 'PASS' }];
  await persistReceipt();

  await setStage('oauth_refresh_roundtrip');
  const storedConnection = await health.prisma.googleDriveConnection.findUniqueOrThrow({ where: { id: connectionId } });
  const storedTokens = oauthCrypto.decryptTokens({ ciphertext: storedConnection.encryptedTokens!, keyVersion: storedConnection.tokenKeyVersion }, userId, connectionId);
  const expiredAt = Date.now() - 120_000;
  const expiredCiphertext = oauthCrypto.encryptTokens({ ...storedTokens, expiresAtMs: expiredAt }, userId, connectionId);
  const generationBeforeRefresh = storedConnection.generation;
  await health.prisma.googleDriveConnection.update({ where: { id: connectionId }, data: { encryptedTokens: expiredCiphertext.ciphertext,
    tokenKeyVersion: expiredCiphertext.keyVersion, accessExpiresAt: new Date(expiredAt), generation: { increment: 1 } } });
  await credentials.withClient(docContext, client => client.getDocument(documentId));
  const afterRefresh = await health.prisma.googleDriveConnection.findUniqueOrThrow({ where: { id: connectionId } });
  if (afterRefresh.generation <= generationBeforeRefresh + 1 || afterRefresh.accessExpiresAt.getTime() <= Date.now()) {
    throw new Error('Google OAuth refresh was not confirmed by encrypted TEST connection rotation');
  }
  safeReceipt['checks'] = [...safeReceipt['checks'] as unknown[], { name: 'real_google_refresh_rotated_encrypted_test_connection', status: 'PASS' }];
  await persistReceipt();

  await setStage('background_consent_due_pull_disable');
  const currentSyncState = await health.prisma.googleDocSyncState.findUniqueOrThrow({ where: { bindingId } });
  const enabledBackground = await sync.background(actor, projectId, { connectionId, enabled: true, expectedGeneration: currentSyncState.backgroundGeneration });
  await health.prisma.googleDocSyncState.update({ where: { bindingId }, data: { nextPollAt: new Date(Date.now() - 1_000) } });
  const dueCount = await sync.queueDuePulls();
  if (dueCount < 1) throw new Error('Explicit background consent did not queue a due TEST pull');
  const backgroundOperation = await health.prisma.googleDocSyncOperation.findFirstOrThrow({ where: { bindingId, backgroundGeneration: enabledBackground.backgroundGeneration,
    sessionId: null, state: 'QUEUED' }, orderBy: { createdAt: 'desc' } });
  if ((await executeJob(backgroundOperation.jobId)).state !== 'SUCCEEDED') throw new Error('Background Google Docs pull failed');
  const disabledBackground = await sync.background(actor, projectId, { connectionId, enabled: false, expectedGeneration: enabledBackground.backgroundGeneration });
  if (disabledBackground.backgroundGrantedAt !== null || disabledBackground.nextPollAt !== null
    || disabledBackground.backgroundGeneration <= enabledBackground.backgroundGeneration) throw new Error('Background consent did not stop and fence further polling');
  safeReceipt['checks'] = [...safeReceipt['checks'] as unknown[], { name: 'explicit_background_due_pull_and_disable', status: 'PASS' }];
  await persistReceipt();

  await setStage('final_projection');
  finalStatus = await sync.status(actor, projectId, styleCandidate.id);
  safeReceipt['summary'] = { nativeThreads: finalStatus.threads.length, nativeCommentCount: finalStatus.threads.filter(item => item.kind === 'comment').length,
    importedCandidateCount: finalStatus.versions.filter(item => (item as { origin?: string }).origin === 'UNVERIFIED_IMPORTED').length,
    pendingGoogleComment: finalStatus.threads.some(item => item.payload && typeof item.payload === 'object'
      && 'headPost' in item.payload && (item.payload as { headPost?: { content?: string } }).headPost?.content === 'Synthetic follow-up on applied candidate') };
  safeReceipt['status'] = 'PASS';
  safeReceipt['finishedAt'] = new Date().toISOString();
  await persistReceipt();
}

function html(content: string) { return `<!doctype html><meta charset="utf-8"><title>ContextFlow Google Docs test</title><main style="font:16px system-ui;max-width:720px;margin:4rem auto">${content}</main>`; }

const server = createServer(async (incoming, response) => {
  const url = new URL(incoming.url ?? '/', 'http://localhost:3000');
  if (!['localhost:3000', '127.0.0.1:3000'].includes(incoming.headers.host ?? '')) {
    response.writeHead(400).end('Invalid local host'); return;
  }
  try {
    if (url.pathname === '/' && incoming.method === 'GET') {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' });
      response.end(html(`<h1>ContextFlow synthetic Google Docs roundtrip</h1><p>This creates one synthetic test document and stores the offline grant encrypted in isolated TEST PostgreSQL. Scope: <code>${GOOGLE_DOCS_FILE_SCOPE}</code>.</p><p>Auth boundary: the Google OAuth service is real. The application SessionService identity is a local synthetic fixture; the product API guard and real user login are not exercised by this harness.</p><p><a href="/start">Start Google authorization</a></p>`)); return;
    }
    if (url.pathname === '/start' && incoming.method === 'GET') {
      const started = await oauth.start(request);
      response.writeHead(302, { location: started.authorizationUrl, 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' }).end(); return;
    }
    if (url.pathname === '/api/v1/google-docs/oauth/callback' && incoming.method === 'GET') {
      const result = await oauth.callback(request, Object.fromEntries(url.searchParams.entries()));
      connectionId = result.connection.id;
      safeReceipt['connectionId'] = connectionId;
      safeReceipt['status'] = 'OAUTH_CONNECTED';
      safeReceipt['connectedAt'] = new Date().toISOString();
      await persistReceipt();
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' });
      response.end(html('<h1>Google connection confirmed</h1><p>The authorization result has been recorded without printing tokens. The synthetic document create, bind and roundtrip is running; keep this tab open.</p>'));
      void finishRoundtrip().catch(async error => {
        safeReceipt['status'] = 'FAILED';
        safeReceipt['currentStage'] = currentStage;
        safeReceipt['failureCategory'] = safeFailureCategory(error);
        safeReceipt['finishedAt'] = new Date().toISOString();
        await persistReceipt().catch(() => undefined);
      });
      return;
    }
    if (url.pathname === '/status' && incoming.method === 'GET') {
      response.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      response.end(JSON.stringify({ status: safeReceipt['status'], checks: safeReceipt['checks'], finishedAt: safeReceipt['finishedAt'] ?? null,
        receiptPath: '.local-checks/google-docs-product-roundtrip.json' })); return;
    }
    response.writeHead(404).end('Not found');
  } catch (error) {
    safeReceipt['status'] = 'FAILED';
    safeReceipt['currentStage'] = currentStage;
    safeReceipt['failureCategory'] = safeFailureCategory(error);
    safeReceipt['finishedAt'] = new Date().toISOString();
    await persistReceipt().catch(() => undefined);
    response.writeHead(error instanceof Error && 'status' in error ? Number((error as { status: number }).status) : 500,
      { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
    response.end('Google Docs roundtrip setup failed. Inspect the sanitized local receipt for the failure category.');
  }
});

server.listen(3000, '127.0.0.1', () => {
  console.log('Google Docs synthetic product roundtrip ready at http://localhost:3000/');
  console.log('Status endpoint: http://localhost:3000/status');
});
const stop = async () => {
  sessionIsActive.set(cookie, false);
  await health.onModuleDestroy();
  server.close();
  process.exit(0);
};
process.once('SIGINT', () => void stop());
process.once('SIGTERM', () => void stop());
