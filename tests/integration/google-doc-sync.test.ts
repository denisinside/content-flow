import { randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ArticleAnnotationService, ArticleService, createGoogleDocSyncHandler, DependencyHealthService, DurableJobService, EXTERNAL_PROCESSING_NOTICE, FactualBasisService,
  GoogleDocSyncService, loadRuntimeConfig, type ArticleContent, type GoogleSyncCredentials, type GoogleDocsDocument, type GoogleDocsClient, type JobContext } from '@contextflow/backend';
import type { GoogleDocsRequest } from '../../packages/backend/src/google-docs/google-docs-client.js';

describe('Google sync durable candidate and revision boundaries on isolated TEST', () => {
  const health = new DependencyHealthService(loadRuntimeConfig());
  const jobs = new DurableJobService(health.prisma, { noticeVersion: EXTERNAL_PROCESSING_NOTICE.version });
  const articles = new ArticleService(health.prisma, jobs, new FactualBasisService(health.prisma, jobs));
  const user = randomUUID(), workspace = randomUUID(), project = randomUUID(), session = randomUUID(), connection = randomUUID(), binding = randomUUID();
  const acceptedAt = new Date();
  const documentId = 'synthetic-sync-' + randomUUID();
  const actor = { userId: user, sessionId: session, noticeAcceptedAt: acceptedAt };
  let remoteRevision = 'r1', remoteText = 'Synthetic remote 😀';
  let reads = 0, writes = 0, loseNextResponse = false, failReadNext = false, formattingBold = false, mutateFormattingAtRead = 0;
  let comment: NonNullable<GoogleDocsDocument['comments']>[number] | null = null;
  let anchor: { startIndex: number; endIndex: number; tabId: string } | null = null;
  let pendingSuggestionIds: string[] = [];
  let suggestions: NonNullable<GoogleDocsDocument['suggestions']> = [];
  let replacementText: string | null = null;
  const document = (): GoogleDocsDocument => ({ documentId, title: 'Synthetic Google', revisionId: remoteRevision,
    tabs: [{ tabProperties: { tabId: 'tab' }, documentTab: { ...(anchor ? { commentAnchors: { 'anchor-1': { anchorId: 'anchor-1', ranges: [anchor] } } } : {}), body: { content: [{ startIndex: 1, endIndex: remoteText.length + 2 + (replacementText?.length ?? 0),
      paragraph: { elements: replacementText ? [
        { startIndex: 1, endIndex: replacementText.length + 1, textRun: { content: replacementText, suggestedInsertionIds: ['replacement'],
          suggestedTextStyleChanges: { replacement: { textStyle: {}, textStyleSuggestionState: { boldSuggested: true } } } } },
        { startIndex: replacementText.length + 1, endIndex: replacementText.length + 10, textRun: { content: remoteText.slice(0, 9), suggestedDeletionIds: ['replacement'] } },
        { startIndex: replacementText.length + 10, endIndex: replacementText.length + remoteText.length + 2, textRun: { content: remoteText.slice(9) + '\n' } },
      ] : pendingSuggestionIds.length === 2 ? [
        { startIndex: 1, endIndex: 10, textRun: { content: remoteText.slice(0, 9), suggestedDeletionIds: [pendingSuggestionIds[0]!] } },
        { startIndex: 10, endIndex: remoteText.length + 2, textRun: { content: remoteText.slice(9) + '\n', suggestedDeletionIds: [pendingSuggestionIds[1]!] } },
      ] : pendingSuggestionIds.length === 1
        ? [{ startIndex: 1, endIndex: remoteText.length + 2, textRun: { content: remoteText + '\n', suggestedDeletionIds: [pendingSuggestionIds[0]!] } }]
        : [{ startIndex: 1, endIndex: remoteText.length + 2, textRun: { content: remoteText + '\n', ...(formattingBold ? { textStyle: { bold: true } } : {}) } }] } }] } } }], comments: comment ? [comment] : [], suggestions });
  const credentials = { withClient: async (_context: unknown, operation: (client: GoogleDocsClient) => Promise<unknown>) => operation({
    getDocument: async () => { reads++; if (failReadNext) { failReadNext = false; throw new Error('synthetic read failure'); }
      if (mutateFormattingAtRead === reads) { formattingBold = true; remoteRevision = `${remoteRevision}-format`; }
      return document(); },
    batchUpdate: async (_id: string, revision: string, requests: GoogleDocsRequest[]) => {
      expect(revision).toBe(remoteRevision);
      writes++;
      if (requests.length === 2 && 'deleteContentRange' in requests[0]! && 'insertText' in requests[1]!) {
        replacementText = requests[1].insertText.text;
        suggestions = [{ suggestionId: 'replacement', status: 'OPEN', headPost: { postId: 'replacement-post', content: 'replacement', author: { me: true } } }];
        remoteRevision = `r${writes + 2}`;
        return { documentId, replies: [{}, {}], writeControl: { requiredRevisionId: remoteRevision } };
      }
      if (requests.every(request => 'acceptSuggestion' in request || 'rejectSuggestion' in request)) {
        const accepted = requests.every(request => 'acceptSuggestion' in request);
        const ids = requests.map(request => 'acceptSuggestion' in request ? request.acceptSuggestion.suggestionId : 'rejectSuggestion' in request ? request.rejectSuggestion.suggestionId : '');
        suggestions = suggestions.map(row => ids.includes(row.suggestionId) ? { ...row, status: accepted ? 'ACCEPTED' : 'REJECTED' } : row);
        pendingSuggestionIds = [];
        remoteRevision = `r${writes + 2}`;
        return { documentId, replies: requests.map(() => ({})), writeControl: { requiredRevisionId: remoteRevision } };
      }
      expect(requests).toHaveLength(1);
      if (requests[0] && 'insertComment' in requests[0]) {
        const create = requests[0];
        anchor = { ...create.insertComment.range, tabId: create.insertComment.range.tabId ?? 'tab' };
        comment = { commentId: `native-comment-${writes}`, anchorId: 'anchor-1', plainTextQuote: remoteText.slice(anchor!.startIndex - 1, anchor!.endIndex - 1), status: 'OPEN', headPost: { postId: `post-${writes}`, content: create.insertComment.content, author: { displayName: 'Actual Google author', me: true } }, replies: [] };
      } else {
        const replyRequest = requests[0] as Extract<GoogleDocsRequest, { addCommentReply: unknown }>;
        expect(comment?.commentId).toBe(replyRequest.addCommentReply.commentId);
        const action = replyRequest.addCommentReply.post.commentAction;
        comment = action
          ? { ...comment!, status: action === 'RESOLVE' ? 'RESOLVED' : 'OPEN' }
          : { ...comment!, replies: [...(comment!.replies ?? []), { postId: `post-${writes}`, content: replyRequest.addCommentReply.post.content, author: { displayName: 'Actual Google author', me: true } }] };
      }
      remoteRevision = `r${writes + 2}`;
      if (loseNextResponse) { loseNextResponse = false; throw new Error('synthetic lost response after commit'); }
      return { documentId, replies: [{}], writeControl: { requiredRevisionId: remoteRevision }, commentUpdateState: 'ALL_SAVED' };
    },
  } as unknown as GoogleDocsClient) } as unknown as GoogleSyncCredentials;
  const sync = new GoogleDocSyncService(health.prisma, jobs, articles, credentials);
  const handler = createGoogleDocSyncHandler({ prisma: health.prisma, articles, credentials, sync });

  beforeAll(async () => {
    expect(new URL(loadRuntimeConfig().databaseUrl).port).toBe('54330');
    await health.prisma.userProfile.create({ data: { id: user, externalProcessingNoticeVersion: EXTERNAL_PROCESSING_NOTICE.version, externalProcessingAcceptedAt: acceptedAt } });
    await health.prisma.workspace.create({ data: { id: workspace, name: 'Synthetic Google sync acceptance', ownerId: user,
      members: { create: { userId: user } }, styles: { create: { revision: 1, createdBy: user } } } });
    await health.prisma.project.create({ data: { id: project, workspaceId: workspace, topic: 'Synthetic Google sync acceptance', createdBy: user, formats: ['ARTICLE'] } });
    await health.prisma.appSession.create({ data: { id: session, userId: user, cookieDigest: randomBytes(32).toString('hex'), encryptedProviderTokens: 'synthetic-session', tokenKeyVersion: 1,
      providerTokenExpiresAt: new Date(Date.now() + 3600_000), expiresAt: new Date(Date.now() + 3600_000), lastUserActivityAt: new Date() } });
    await health.prisma.googleDriveConnection.create({ data: { id: connection, userId: user, googlePermissionId: randomUUID(), encryptedTokens: 'synthetic-token-' + randomBytes(32).toString('hex'), tokenKeyVersion: 1,
      grantedScope: 'https://www.googleapis.com/auth/drive.file', accessExpiresAt: new Date(Date.now() + 3600_000) } });
    await health.prisma.googleDocBinding.create({ data: { id: binding, projectId: project, connectionId: connection, connectionUserId: user,
      documentId, tabId: 'tab', createdBy: user } });
  });
  beforeEach(() => { replacementText = null; pendingSuggestionIds = []; suggestions = []; formattingBold = false; mutateFormattingAtRead = 0; });
  // Retain synthetic immutable history in TEST, marking this disposable project archived.
  afterAll(async () => { await health.prisma.project.updateMany({ where: { id: project }, data: { archivedAt: new Date() } }); await health.prisma.$disconnect(); });

  async function run(jobId: string) {
    const claimed = await jobs.claim(jobId, 1, randomUUID());
    expect(claimed).not.toBeNull();
    const { job, attempt } = claimed!;
    const context: JobContext = { job, attempt, signal: new AbortController().signal,
      recordSubmissionIntent: () => jobs.providerIntent(job, attempt, undefined, tx => handler.validateSubmission!(tx, job)),
      recordProviderRun: id => jobs.providerIntent(job, attempt, id), setProgress: stage => jobs.progress(job, attempt, stage) };
    const result = await handler.execute(context);
    await jobs.succeed(job, attempt, handler, result);
    return health.prisma.googleDocSyncOperation.findUniqueOrThrow({ where: { projectId_jobId: { projectId: project, jobId } } });
  }
  async function fail(jobId: string) {
    const claimed = (await jobs.claim(jobId, 1, randomUUID()))!;
    const context: JobContext = { ...claimed, signal: new AbortController().signal,
      recordSubmissionIntent: () => jobs.providerIntent(claimed.job, claimed.attempt, undefined, tx => handler.validateSubmission!(tx, claimed.job)),
      recordProviderRun: async () => {}, setProgress: async () => {} };
    await expect(handler.execute(context)).rejects.toMatchObject({ outcome: 'UNKNOWN' });
    await jobs.fail(claimed.job, claimed.attempt, new Error('provider outcome unknown'));
    await handler.failed!(context, new Error('provider outcome unknown'));
    return health.prisma.googleDocSyncOperation.findUniqueOrThrow({ where: { projectId_jobId: { projectId: project, jobId } } });
  }

  it('pull replay and repeated read create one unapproved candidate, keeping draft and approval intact', async () => {
    const input = { connectionId: connection, commandKey: randomUUID(), expectedArticleRevision: 0 };
    const queued = await sync.pull(actor, project, input);
    const replay = await sync.pull(actor, project, input);
    expect(replay.operation.id).toBe(queued.operation.id);
    const result = await run(queued.job.id);
    expect(result.state).toBe('SUCCEEDED');
    expect(result.resultVersionId).toBeTruthy();
    const candidate = await health.prisma.articleVersion.findUniqueOrThrow({ where: { id: result.resultVersionId! } });
    expect(candidate).toMatchObject({ origin: 'UNVERIFIED_IMPORTED', approvedAt: null, jobId: null, aiExecutionId: null });
    const before = await health.prisma.article.findUniqueOrThrow({ where: { projectId: project }, include: { draft: true } });
    const second = await sync.pull(actor, project, { ...input, commandKey: randomUUID() });
    expect((await run(second.job.id)).resultVersionId).toBe(candidate.id);
    expect(await health.prisma.articleVersion.count({ where: { projectId: project } })).toBe(1);
    expect(await health.prisma.article.findUniqueOrThrow({ where: { projectId: project }, include: { draft: true } })).toEqual(before);
    expect(writes).toBe(0);
  });

  it('rejects stale Google preview before a write and preserves the local saved version', async () => {
    const candidate = await health.prisma.articleVersion.findFirstOrThrow({ where: { projectId: project } });
    remoteText = '';
    const preview = await sync.preview(actor, project, { connectionId: connection, sourceVersionId: candidate.id, kind: 'PUSH', expectedArticleRevision: 0 });
    const queued = await sync.confirm(actor, project, { previewId: preview.previewId, commandKey: randomUUID(), expectedArticleRevision: 0 });
    remoteRevision = 'r2';
    const claim = (await jobs.claim(queued.job.id, 1, randomUUID()))!;
    const context: JobContext = { ...claim, signal: new AbortController().signal, recordSubmissionIntent: async () => {}, recordProviderRun: async () => {}, setProgress: async () => {} };
    await expect(handler.execute(context)).rejects.toMatchObject({ category: 'REMOTE_CHANGED', outcome: 'NOT_SUBMITTED' });
    await jobs.fail(claim.job, claim.attempt, new Error('Remote changed'));
    await handler.failed!(context, new Error('Remote changed'));
    expect(writes).toBe(0);
    expect((await health.prisma.googleDocSyncOperation.findUniqueOrThrow({ where: { id: queued.operation.id } })).state).toBe('FAILED');
  });

  it('confirms an unchanged PUSH as a read-only no-op without recording provider intent or sending an empty batch', async () => {
    const candidate = await health.prisma.articleVersion.findFirstOrThrow({ where: { projectId: project } });
    remoteText = candidate.plainText;
    const preview = await sync.preview(actor, project, { connectionId: connection, sourceVersionId: candidate.id, kind: 'PUSH', expectedArticleRevision: 0 });
    expect(preview.writeMode).toBe('SUGGEST');
    const before = writes;
    const queued = await sync.confirm(actor, project, { previewId: preview.previewId, commandKey: randomUUID(), expectedArticleRevision: 0 });
    const result = await run(queued.job.id);
    expect(result.state).toBe('SUCCEEDED');
    expect(writes).toBe(before);
    expect((await health.prisma.job.findUniqueOrThrow({ where: { id: queued.job.id } })).providerOutcome).toBe('KNOWN_SUCCEEDED');
  });

  it('rejects a no-op confirmation when Google formatting changes between its two reads', async () => {
    const candidate = await health.prisma.articleVersion.findFirstOrThrow({ where: { projectId: project } });
    remoteText = candidate.plainText;
    formattingBold = false;
    const preview = await sync.preview(actor, project, { connectionId: connection, sourceVersionId: candidate.id, kind: 'PUSH', expectedArticleRevision: 0 });
    const queued = await sync.confirm(actor, project, { previewId: preview.previewId, commandKey: randomUUID(), expectedArticleRevision: 0 });
    mutateFormattingAtRead = reads + 2;
    const claim = (await jobs.claim(queued.job.id, 1, randomUUID()))!;
    const context: JobContext = { ...claim, signal: new AbortController().signal, recordSubmissionIntent: async () => {}, recordProviderRun: async () => {}, setProgress: async () => {} };
    await expect(handler.execute(context)).rejects.toMatchObject({ category: 'REMOTE_CHANGED', outcome: 'NOT_SUBMITTED' });
    mutateFormattingAtRead = 0;
    await jobs.fail(claim.job, claim.attempt, new Error('Google formatting changed during no-op check'));
    await handler.failed!(context, new Error('Google formatting changed during no-op check'));
    expect(writes).toBe(0);
    expect((await health.prisma.googleDocSyncOperation.findUniqueOrThrow({ where: { id: queued.operation.id } })).state).toBe('FAILED');
  });

  it('serializes queued reads per binding while allowing them after the current read completes', async () => {
    const queued = await sync.pull(actor, project, { connectionId: connection, commandKey: randomUUID(), expectedArticleRevision: 0 });
    await expect(sync.pull(actor, project, { connectionId: connection, commandKey: randomUUID(), expectedArticleRevision: 0 }))
      .rejects.toThrow(/another Google Docs operation is active/iu);
    await run(queued.job.id);
    const next = await sync.pull(actor, project, { connectionId: connection, commandKey: randomUUID(), expectedArticleRevision: 0 });
    expect((await run(next.job.id)).state).toBe('SUCCEEDED');
  });

  it('records provider read failures as failed reads that do not block the next pull', async () => {
    const queued = await sync.pull(actor, project, { connectionId: connection, commandKey: randomUUID(), expectedArticleRevision: 0 });
    const claimed = (await jobs.claim(queued.job.id, 1, randomUUID()))!;
    const context: JobContext = { ...claimed, signal: new AbortController().signal, recordSubmissionIntent: async () => {}, recordProviderRun: async () => {}, setProgress: async () => {} };
    failReadNext = true;
    await expect(handler.execute(context)).rejects.toThrow('synthetic read failure');
    await jobs.fail(claimed.job, claimed.attempt, new Error('synthetic read failure'));
    await handler.failed!(context, new Error('synthetic read failure'));
    expect((await health.prisma.googleDocSyncOperation.findUniqueOrThrow({ where: { id: queued.operation.id } })).state).toBe('FAILED');
    const next = await sync.pull(actor, project, { connectionId: connection, commandKey: randomUUID(), expectedArticleRevision: 0 });
    expect((await run(next.job.id)).state).toBe('SUCCEEDED');
  });

  it('decides every explicitly linked part of a native suggestion group in one fresh readback', async () => {
    const candidate = await health.prisma.articleVersion.findFirstOrThrow({ where: { projectId: project } });
    remoteText = candidate.plainText;
    const annotations = new ArticleAnnotationService(health.prisma, articles);
    const local = await annotations.create(user, project, { articleVersionId: candidate.id, contentHash: candidate.sha256, kind: 'SUGGESTION',
      anchorStart: 0, anchorEnd: 9, body: 'Use the replacement', replacementText: 'Synthetic', commandKey: randomUUID() });
    const localAnnotation = local.threads[0]!;
    pendingSuggestionIds = ['native-suggestion-1', 'native-suggestion-2'];
    suggestions = pendingSuggestionIds.map((suggestionId, index) => ({ suggestionId, status: 'OPEN' as const, summaryText: `part-${index}`,
      headPost: { postId: `suggestion-post-${index}`, content: `part-${index}`, author: { displayName: 'Synthetic editor' } }, replies: [] }));
    const imported = await sync.pull(actor, project, { connectionId: connection, sourceVersionId: candidate.id, commandKey: randomUUID(), expectedArticleRevision: 0 });
    await run(imported.job.id);
    const nativeParts = await health.prisma.googleDocRemoteThread.findMany({ where: { bindingId: binding, kind: 'SUGGESTION', remoteId: { in: pendingSuggestionIds } } });
    expect(nativeParts).toHaveLength(2);
    await health.prisma.googleDocRemoteThread.updateMany({ where: { id: { in: nativeParts.map(row => row.id) } }, data: { localAnnotationId: localAnnotation.id, updatedAt: new Date(Date.now() + 1) } });
    const decision = await sync.preview(actor, project, { connectionId: connection, sourceVersionId: candidate.id, kind: 'SUGGESTION_REJECT',
      threadId: nativeParts[0]!.id, expectedArticleRevision: 0 });
    expect(decision.unsupported).toHaveLength(0);
    const queued = await sync.confirm(actor, project, { previewId: decision.previewId, commandKey: randomUUID(), expectedArticleRevision: 0 });
    expect((await run(queued.job.id)).state).toBe('SUCCEEDED');
    const updated = await health.prisma.googleDocRemoteThread.findMany({ where: { id: { in: nativeParts.map(row => row.id) } } });
    expect(updated.map(row => row.status)).toEqual(['REJECTED', 'REJECTED']);
    expect(writes).toBe(1);
  });

  it('confirms replacement with shifted deletion coordinates and empty insertion style metadata', async () => {
    const candidate = await health.prisma.articleVersion.findFirstOrThrow({ where: { projectId: project } });
    remoteText = candidate.plainText;
    const local = await new ArticleAnnotationService(health.prisma, articles).create(user, project, {
      articleVersionId: candidate.id, contentHash: candidate.sha256, kind: 'SUGGESTION', anchorStart: 0, anchorEnd: 9,
      body: 'Replacement proof', replacementText: 'Reviewed', commandKey: randomUUID() });
    const annotation = local.threads[0]!;
    const preview = await sync.preview(actor, project, { connectionId: connection, sourceVersionId: candidate.id,
      kind: 'SUGGESTION_CREATE', annotationId: annotation.id, body: annotation.body, replacementText: 'Reviewed',
      rangeStart: 0, rangeEnd: 9, expectedArticleRevision: 0 });
    expect(preview.unsupported).toEqual([]);
    const queued = await sync.confirm(actor, project, { previewId: preview.previewId, commandKey: randomUUID(), expectedArticleRevision: 0 });
    expect((await run(queued.job.id)).state).toBe('SUCCEEDED');
    expect(await health.prisma.googleDocRemoteThread.findFirst({ where: { bindingId: binding, localAnnotationId: annotation.id, remoteId: 'replacement' } })).not.toBeNull();
  });

  it('exports one local comment, retains native identity through repeated pull, and never duplicates the thread', async () => {
    const candidate = await health.prisma.articleVersion.findFirstOrThrow({ where: { projectId: project } });
    remoteText = candidate.plainText;
    const writesBeforeComments = writes;
    const annotations = new ArticleAnnotationService(health.prisma, articles);
    const created = await annotations.create(user, project, { articleVersionId: candidate.id, contentHash: candidate.sha256, kind: 'COMMENT', anchorStart: 0, anchorEnd: 9, body: 'Keep this discussion open', commandKey: randomUUID() });
    const annotation = created.threads[0]!;
    const preview = await sync.preview(actor, project, { connectionId: connection, sourceVersionId: candidate.id, kind: 'COMMENT_CREATE', annotationId: annotation.id,
      body: annotation.body, rangeStart: 0, rangeEnd: 9, expectedArticleRevision: 0 });
    expect(preview.unsupported).toHaveLength(0);
    const queued = await sync.confirm(actor, project, { previewId: preview.previewId, commandKey: randomUUID(), expectedArticleRevision: 0 });
    expect((await run(queued.job.id)).state).toBe('SUCCEEDED');
    const thread = await health.prisma.googleDocRemoteThread.findFirstOrThrow({ where: { bindingId: binding, kind: 'COMMENT' } });
    expect(thread).toMatchObject({ remoteId: `native-comment-${writesBeforeComments + 1}`, localAnnotationId: annotation.id, status: 'OPEN' });
    const pulled = await sync.pull(actor, project, { connectionId: connection, sourceVersionId: candidate.id, commandKey: randomUUID(), expectedArticleRevision: 0 });
    await run(pulled.job.id);
    expect(await health.prisma.googleDocRemoteThread.count({ where: { bindingId: binding, kind: 'COMMENT' } })).toBe(1);
    expect((await health.prisma.googleDocRemoteThread.findUniqueOrThrow({ where: { id: thread.id } })).localAnnotationId).toBe(annotation.id);
    expect(writes).toBe(writesBeforeComments + 1);

    const replied = await annotations.reply(user, project, annotation.id, annotation.revision, 'A linked local reply');
    const localPost = replied.threads[0]!.posts[0]!;
    const replyPreview = await sync.preview(actor, project, { connectionId: connection, sourceVersionId: candidate.id, kind: 'COMMENT_REPLY', threadId: thread.id,
      annotationId: annotation.id, localPostId: localPost.id, body: localPost.body, expectedArticleRevision: 0 });
    const replyQueued = await sync.confirm(actor, project, { previewId: replyPreview.previewId, commandKey: randomUUID(), expectedArticleRevision: 0 });
    expect((await run(replyQueued.job.id)).state).toBe('SUCCEEDED');
    const linkedThread = await health.prisma.googleDocRemoteThread.findUniqueOrThrow({ where: { id: thread.id } });
    const linkedPosts = (linkedThread.payloadJson as { localPostLinks?: Record<string, string> }).localPostLinks;
    expect(linkedPosts?.[localPost.id]).toBe(`post-${writes}`);
    await expect(sync.preview(actor, project, { connectionId: connection, sourceVersionId: candidate.id, kind: 'COMMENT_REPLY', threadId: thread.id,
      annotationId: annotation.id, localPostId: localPost.id, body: localPost.body, expectedArticleRevision: 0 })).rejects.toThrow(/already linked/u);

    const second = await annotations.create(user, project, { articleVersionId: candidate.id, contentHash: candidate.sha256, kind: 'COMMENT', anchorStart: 10, anchorEnd: 14, body: 'Recover this native thread', commandKey: randomUUID() });
    const secondAnnotation = second.threads[0]!;
    const uncertainPreview = await sync.preview(actor, project, { connectionId: connection, sourceVersionId: candidate.id, kind: 'COMMENT_CREATE', annotationId: secondAnnotation.id,
      body: secondAnnotation.body, rangeStart: 10, rangeEnd: 14, expectedArticleRevision: 0 });
    const uncertain = await sync.confirm(actor, project, { previewId: uncertainPreview.previewId, commandKey: randomUUID(), expectedArticleRevision: 0 });
    loseNextResponse = true;
    expect((await fail(uncertain.job.id)).state).toBe('UNKNOWN');
    const recovery = await sync.reconcile(actor, project, { operationId: uncertain.operation.id, connectionId: connection, commandKey: randomUUID() });
    expect((await run(recovery.job.id)).state).toBe('SUCCEEDED');
    expect((await health.prisma.googleDocSyncOperation.findUniqueOrThrow({ where: { id: uncertain.operation.id } })).state).toBe('SUCCEEDED');
    expect(await health.prisma.googleDocRemoteThread.count({ where: { bindingId: binding, kind: 'COMMENT' } })).toBe(2);
    const disappeared = await health.prisma.googleDocRemoteThread.findUniqueOrThrow({ where: { id: thread.id } });
    expect(disappeared).toMatchObject({ status: 'MISSING', rangesJson: [] });
    expect((disappeared.payloadJson as { projectAnchorStatus?: string }).projectAnchorStatus).toBe('missing');
    expect(writes).toBe(writesBeforeComments + 3);
  });

  it('blocks a multibyte comment locally when its UTF-8 payload exceeds the Google limit', async () => {
    const candidate = await health.prisma.articleVersion.findFirstOrThrow({ where: { projectId: project, origin: 'UNVERIFIED_IMPORTED' }, orderBy: { number: 'asc' } });
    remoteText = candidate.plainText;
    const annotations = new ArticleAnnotationService(health.prisma, articles);
    const body = '界'.repeat(900);
    const local = await annotations.create(user, project, { articleVersionId: candidate.id, contentHash: candidate.sha256, kind: 'COMMENT',
      anchorStart: 0, anchorEnd: 8, body, commandKey: randomUUID() });
    const annotation = local.threads[0]!;
    const preview = await sync.preview(actor, project, { connectionId: connection, sourceVersionId: candidate.id, kind: 'COMMENT_CREATE', annotationId: annotation.id,
      body: annotation.body, rangeStart: 0, rangeEnd: 8, expectedArticleRevision: 0 });
    expect(preview.unsupported).toContainEqual(expect.objectContaining({ type: 'comment-too-long' }));
    const before = writes, operationCount = await health.prisma.googleDocSyncOperation.count({ where: { projectId: project } });
    await expect(sync.confirm(actor, project, { previewId: preview.previewId, commandKey: randomUUID(), expectedArticleRevision: 0 }))
      .rejects.toThrow(/unsupported Google Docs content/iu);
    expect(writes).toBe(before);
    expect(await health.prisma.googleDocSyncOperation.count({ where: { projectId: project } })).toBe(operationCount);
  });

  it('stores an unapproved Article candidate after accepting a native suggestion even when committed text matches source', async () => {
    const candidate = await health.prisma.articleVersion.findFirstOrThrow({ where: { projectId: project, origin: 'UNVERIFIED_IMPORTED' }, orderBy: { number: 'asc' } });
    remoteText = candidate.plainText;
    pendingSuggestionIds = ['native-accepted-1'];
    suggestions = [{ suggestionId: 'native-accepted-1', status: 'OPEN', summaryText: 'formatting-only change',
      headPost: { postId: 'native-accepted-post', content: 'Formatting update', author: { displayName: 'Synthetic editor' } }, replies: [] }];
    const imported = await sync.pull(actor, project, { connectionId: connection, sourceVersionId: candidate.id, commandKey: randomUUID(), expectedArticleRevision: 0 });
    await run(imported.job.id);
    const thread = await health.prisma.googleDocRemoteThread.findFirstOrThrow({ where: { bindingId: binding, remoteId: 'native-accepted-1', kind: 'SUGGESTION' } });
    const preview = await sync.preview(actor, project, { connectionId: connection, sourceVersionId: candidate.id, kind: 'SUGGESTION_ACCEPT', threadId: thread.id, expectedArticleRevision: 0 });
    const queued = await sync.confirm(actor, project, { previewId: preview.previewId, commandKey: randomUUID(), expectedArticleRevision: 0 });
    const result = await run(queued.job.id);
    expect(result.resultVersionId).toBeTruthy();
    expect(await health.prisma.articleVersion.findUniqueOrThrow({ where: { id: result.resultVersionId! } }))
      .toMatchObject({ origin: 'UNVERIFIED_IMPORTED', approvedAt: null, jobId: null, aiExecutionId: null });
  });

  it('uses only an explicitly applied Google candidate as the baseline for later local edits', async () => {
    const imported = await health.prisma.articleVersion.findFirstOrThrow({ where: { projectId: project, origin: 'UNVERIFIED_IMPORTED' }, orderBy: { number: 'asc' } });
    const applied = await articles.review(user, project, imported.id, 'apply', { expectedRevision: 0 });
    const appliedArticle = await health.prisma.article.findUniqueOrThrow({ where: { projectId: project }, include: { draft: true } });
    const baseline = await health.prisma.googleDocSyncState.findUniqueOrThrow({ where: { bindingId: binding } });
    expect(baseline).toMatchObject({ baselineVersionId: imported.id });
    expect(baseline.baselineSnapshotId).toBeTruthy();
    expect(applied.article?.revision).toBe(appliedArticle.revision);

    const editedContent = structuredClone(imported.content) as ArticleContent;
    const firstText = editedContent.document.content?.[0]?.content?.[0];
    expect(firstText?.type).toBe('text');
    if (!firstText || firstText.type !== 'text') throw new Error('Synthetic Google candidate must have a first text node');
    firstText.text = `${firstText.text ?? ''} accepted suggestion`;
    await articles.saveDraft(user, project, { expectedRevision: appliedArticle.revision, contentMode: 'CREATIVE', content: editedContent });
    const savedB = await articles.checkpoint(user, project, { expectedRevision: appliedArticle.revision + 1 });
    const versionB = await health.prisma.articleVersion.findFirstOrThrow({ where: { projectId: project }, orderBy: { number: 'desc' } });
    remoteText = versionB.plainText;
    const pullB = await sync.pull(actor, project, { connectionId: connection, sourceVersionId: versionB.id, commandKey: randomUUID(), expectedArticleRevision: savedB.article!.revision });
    await run(pullB.job.id);
    const acceptedBaseline = await health.prisma.googleDocSyncState.findUniqueOrThrow({ where: { bindingId: binding } });
    expect(acceptedBaseline).toMatchObject({ baselineVersionId: versionB.id });

    const editedC = structuredClone(versionB.content) as ArticleContent;
    const changedText = editedC.document.content?.[0]?.content?.[0];
    if (!changedText || changedText.type !== 'text') throw new Error('Synthetic Article version must have a first text node');
    changedText.text = `${changedText.text ?? ''} local edit`;
    const liveArticle = await health.prisma.article.findUniqueOrThrow({ where: { projectId: project } });
    await articles.saveDraft(user, project, { expectedRevision: liveArticle.revision, contentMode: 'CREATIVE', content: editedC });
    const saved = await articles.checkpoint(user, project, { expectedRevision: liveArticle.revision + 1 });
    const checkpoint = await health.prisma.articleVersion.findFirstOrThrow({ where: { projectId: project }, orderBy: { number: 'desc' } });
    const current = await health.prisma.article.findUniqueOrThrow({ where: { projectId: project } });
    const preview = await sync.preview(actor, project, { connectionId: connection, sourceVersionId: checkpoint.id, kind: 'PUSH', expectedArticleRevision: current.revision });
    expect(saved.article?.revision).toBe(current.revision);
    expect(preview.hasConflict).toBe(false);
    expect(preview.baselineContent).toBeTruthy();
  });

  it('normalizes an orphaned submitted write after lease reconciliation and recovers it with a read only', async () => {
    const candidate = await health.prisma.articleVersion.findFirstOrThrow({ where: { projectId: project, origin: 'UNVERIFIED_IMPORTED' }, orderBy: { number: 'asc' } });
    const article = await health.prisma.article.findUniqueOrThrow({ where: { projectId: project } });
    remoteText = candidate.plainText;
    const annotations = new ArticleAnnotationService(health.prisma, articles);
    const local = await annotations.create(user, project, { articleVersionId: candidate.id, contentHash: candidate.sha256, kind: 'COMMENT',
      anchorStart: 0, anchorEnd: 8, body: 'Recover after worker loss', commandKey: randomUUID() });
    const annotation = local.threads[0]!;
    const preview = await sync.preview(actor, project, { connectionId: connection, sourceVersionId: candidate.id, kind: 'COMMENT_CREATE', annotationId: annotation.id,
      body: annotation.body, rangeStart: 0, rangeEnd: 8, expectedArticleRevision: article.revision });
    const queued = await sync.confirm(actor, project, { previewId: preview.previewId, commandKey: randomUUID(), expectedArticleRevision: article.revision });
    loseNextResponse = true;
    const claim = (await jobs.claim(queued.job.id, 1, randomUUID()))!;
    const context: JobContext = { ...claim, signal: new AbortController().signal,
      recordSubmissionIntent: () => jobs.providerIntent(claim.job, claim.attempt, undefined, tx => handler.validateSubmission!(tx, claim.job)),
      recordProviderRun: async () => {}, setProgress: async () => {} };
    await expect(handler.execute(context)).rejects.toMatchObject({ outcome: 'UNKNOWN' });
    await health.prisma.jobAttempt.update({ where: { id: claim.attempt.id }, data: { leaseExpiresAt: new Date(Date.now() - 1) } });
    await jobs.reconcile();
    const status = await sync.status(actor, project);
    expect((status.operations as Array<{ id: string; state: string }>).find(row => row.id === queued.operation.id)?.state).toBe('UNKNOWN');
    const recovered = await sync.reconcile(actor, project, { operationId: queued.operation.id, connectionId: connection, commandKey: randomUUID() });
    const result = await run(recovered.job.id);
    expect(result.state).toBe('SUCCEEDED');
    expect(await health.prisma.googleDocRemoteThread.count({ where: { bindingId: binding, localAnnotationId: annotation.id } })).toBe(1);
  });

  it('lets the initiating editor stop background pulls without a usable connection selection', async () => {
    const enabled = await sync.background(actor, project, { connectionId: connection, enabled: true, expectedGeneration: 0 });
    const stopped = await sync.background(actor, project, { connectionId: randomUUID(), enabled: false, expectedGeneration: enabled.backgroundGeneration });
    expect(stopped).toMatchObject({ backgroundGrantedAt: null, backgroundConnectionId: null, status: 'PAUSED' });
  });

  it('expired initiating session stops before any provider read', async () => {
    const article = await health.prisma.article.findUniqueOrThrow({ where: { projectId: project } });
    const queued = await sync.pull(actor, project, { connectionId: connection, commandKey: randomUUID(), expectedArticleRevision: article.revision });
    await health.prisma.appSession.update({ where: { id: session }, data: { revokedAt: new Date(), encryptedProviderTokens: null } });
    const before = reads;
    const claim = (await jobs.claim(queued.job.id, 1, randomUUID()))!;
    expect(claim).toBeTruthy();
    const context: JobContext = { ...claim, signal: new AbortController().signal, recordSubmissionIntent: async () => {}, recordProviderRun: async () => {}, setProgress: async () => {} };
    await expect(handler.execute(context)).rejects.toMatchObject({ category: 'SESSION_EXPIRED' });
    await jobs.fail(claim.job, claim.attempt, new Error('Session expired'));
    await handler.failed!(context, new Error('Session expired'));
    expect(reads).toBe(before);
  });
});
