import { z } from 'zod';

const nonEmpty = z.string().min(1).max(1000);
const operationIdSchema = z.uuid();
const createTitleSchema = z.string().min(1).max(200);
const documentIdSchema = z.string().min(1).max(1024).refine(value => new TextEncoder().encode(value).byteLength <= 1024);
const driveFileIdSchema = documentIdSchema;
const createMarkerSchema = z.object({ contextFlowCreate: operationIdSchema }).passthrough();
const createdDriveFileSchema = z.object({
  id: driveFileIdSchema,
  name: createTitleSchema,
  mimeType: z.literal('application/vnd.google-apps.document'),
  appProperties: createMarkerSchema,
}).passthrough();
const driveListSchema = z.object({
  nextPageToken: z.string().min(1).optional(),
  incompleteSearch: z.boolean().optional(),
  files: z.array(z.unknown()).max(100),
}).passthrough();
const MAX_CREATE_RECONCILE_PAGES = 5;
const DRIVE_API_BASE_URL = 'https://www.googleapis.com/drive/v3';
const GOOGLE_DOCUMENT_MIME_TYPE = 'application/vnd.google-apps.document';
const CREATE_MARKER_KEY = 'contextFlowCreate';
const rangeSchema = z.object({ startIndex: z.number().int().min(0), endIndex: z.number().int().min(1), tabId: nonEmpty.optional(), segmentId: z.string().max(1000).optional() }).strict().refine(value => value.endIndex > value.startIndex, 'Range must be non-empty');
const locationSchema = z.object({ index: z.number().int().min(0), tabId: nonEmpty.optional(), segmentId: z.string().max(1000).optional() }).strict();

export type GoogleDocsRange = z.infer<typeof rangeSchema>;
export type GoogleDocsLocation = z.infer<typeof locationSchema>;
export type GoogleDocsRequest =
  | { insertText: { location: GoogleDocsLocation; text: string } }
  | { deleteContentRange: { range: GoogleDocsRange } }
  | { updateTextStyle: { range: GoogleDocsRange; textStyle: { bold?: boolean; italic?: boolean; strikethrough?: boolean }; fields: string } }
  | { updateParagraphStyle: { range: GoogleDocsRange; paragraphStyle: { namedStyleType?: 'HEADING_1' | 'HEADING_2' | 'HEADING_3' | 'NORMAL_TEXT'; indentStart?: { magnitude: number; unit: 'PT' } }; fields: string } }
  | { createParagraphBullets: { range: GoogleDocsRange; bulletPreset: 'BULLET_DISC_CIRCLE_SQUARE' | 'NUMBERED_DECIMAL_ALPHA_ROMAN' } }
  | { insertComment: { content: string; range: GoogleDocsRange } }
  | { addCommentReply: { commentId: string; post: { content?: string; commentAction?: 'RESOLVE' | 'REOPEN' } } }
  | { acceptSuggestion: { suggestionId: string } }
  | { rejectSuggestion: { suggestionId: string } };

const inlineElement = z.object({ startIndex: z.number().int().optional(), endIndex: z.number().int().optional(), textRun: z.object({ content: z.string(), textStyle: z.record(z.string(), z.unknown()).optional(), suggestedInsertionIds: z.array(z.string()).optional(), suggestedDeletionIds: z.array(z.string()).optional() }).passthrough().optional() }).passthrough();
const structuralElement = z.object({ startIndex: z.number().int().optional(), endIndex: z.number().int().optional(), paragraph: z.object({ elements: z.array(inlineElement).optional(), paragraphStyle: z.record(z.string(), z.unknown()).optional(), bullet: z.object({ listId: z.string().optional(), nestingLevel: z.number().int().optional() }).passthrough().optional() }).passthrough().optional() }).passthrough();
const bodySchema = z.object({ content: z.array(structuralElement).max(50000) }).passthrough();
interface GoogleDocsTabData {
  tabProperties: { tabId: string; title?: string | undefined; [key: string]: unknown };
  documentTab: { body: z.infer<typeof bodySchema>; commentAnchors?: Record<string, { anchorId: string; ranges: GoogleDocsRange[]; [key: string]: unknown }> | undefined; [key: string]: unknown };
  childTabs?: GoogleDocsTabData[] | undefined;
  [key: string]: unknown;
}
const tabSchema: z.ZodType<GoogleDocsTabData> = z.lazy(() => z.object({
  tabProperties: z.object({ tabId: z.string().min(1), title: z.string().optional() }).passthrough(),
  documentTab: z.object({ body: bodySchema, commentAnchors: z.record(z.string(), z.object({ anchorId: z.string().min(1), ranges: z.array(rangeSchema).max(1000) }).passthrough()).optional() }).passthrough(),
  childTabs: z.array(tabSchema).optional(),
}).passthrough());
const postSchema = z.object({ postId: z.string().min(1), content: z.string().optional(), contentHtml: z.string().optional(), author: z.object({ displayName: z.string().optional(), me: z.boolean().optional(), anonymous: z.boolean().optional(), user: z.string().optional() }).passthrough().optional(), createTime: z.string().optional(), updateTime: z.string().optional(), deleted: z.boolean().optional(), fromImportedDocument: z.boolean().optional(), fromCopiedDocument: z.boolean().optional(), fromDocumentComparison: z.boolean().optional(), assigneeEmail: z.string().optional(), commentAction: z.enum(['COMMENT_ACTION_TYPE_UNSPECIFIED', 'NO_COMMENT_ACTION_CHANGE', 'RESOLVE', 'REOPEN']).optional(), suggestionAction: z.enum(['SUGGESTION_ACTION_TYPE_UNSPECIFIED', 'NO_SUGGESTION_ACTION_CHANGE', 'ACCEPT', 'REJECT']).optional() }).passthrough();
const commentThreadSchema = z.object({ commentId: z.string().min(1), anchorId: z.string().min(1).optional(), headPost: postSchema, replies: z.array(postSchema).optional(), status: z.enum(['STATUS_UNSPECIFIED', 'OPEN', 'RESOLVED']), plainTextQuote: z.string().optional() }).passthrough();
const suggestionThreadSchema = z.object({ suggestionId: z.string().min(1), headPost: postSchema, replies: z.array(postSchema).optional(), status: z.enum(['STATUS_UNSPECIFIED', 'OPEN', 'ACCEPTED', 'REJECTED']), summaryText: z.string().optional(), summaryHtml: z.string().optional() }).passthrough();
const documentSchema = z.object({ documentId: z.string().min(1), title: z.string().optional(), revisionId: z.string().min(1), tabs: z.array(tabSchema).min(1).max(100), comments: z.array(commentThreadSchema).max(10000).optional(), suggestions: z.array(suggestionThreadSchema).max(10000).optional() }).passthrough();
const batchResponseSchema = z.object({ documentId: z.string().min(1), replies: z.array(z.unknown()), writeControl: z.object({ requiredRevisionId: z.string().min(1) }).passthrough(), commentUpdateState: z.enum(['NO_UPDATES_REQUESTED', 'ALL_SAVED', 'ALL_FAILED_UNKNOWN_REASON', 'COMMENT_UPDATE_STATE_UNSPECIFIED']).optional(), suggestionResponses: z.array(z.object({ createdSuggestionIds: z.array(z.string()).optional(), updatedSummarySuggestionIds: z.array(z.string()).optional(), deletedSuggestionIds: z.array(z.string()).optional(), acceptedSuggestionIds: z.array(z.string()).optional(), rejectedSuggestionIds: z.array(z.string()).optional() }).passthrough()).optional() }).passthrough();

export type GoogleDocsDocument = z.infer<typeof documentSchema>;
export type GoogleDocsBatchResponse = z.infer<typeof batchResponseSchema>;

export type GoogleDocsErrorKind = 'unauthenticated' | 'forbidden' | 'not_found' | 'conflict' | 'rate_limited' | 'invalid_request' | 'server' | 'transport' | 'timeout' | 'response_too_large' | 'invalid_response';

export class GoogleDocsApiError extends Error {
  constructor(readonly kind: GoogleDocsErrorKind, readonly status?: number, readonly mayHaveCommitted = false) {
    super(`Google Docs API request failed (${kind}${status ? `, HTTP ${status}` : ''})`);
    this.name = 'GoogleDocsApiError';
  }
}

export class GoogleDocsPartialUpdateError extends GoogleDocsApiError {
  constructor(readonly reason: 'comment_updates_failed' | 'comment_update_state_unknown' | 'invalid_batch_response', readonly response?: GoogleDocsBatchResponse) {
    super('invalid_response', undefined, true);
    this.name = 'GoogleDocsPartialUpdateError';
    this.message = `Google Docs batch outcome requires a fresh read (${reason})`;
  }
}

export interface GoogleDocsClientOptions {
  getAccessToken: () => string | Promise<string>;
  fetchImpl?: typeof fetch;
  maxResponseBytes?: number;
  timeoutMs?: number;
  baseUrl?: string;
}

const DOCS_API_BASE_URL = 'https://docs.googleapis.com/v1';

export class GoogleDocsClient {
  private readonly fetchImpl: typeof fetch;
  private readonly maxResponseBytes: number;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;

  constructor(private readonly options: GoogleDocsClientOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.maxResponseBytes = options.maxResponseBytes ?? 8_000_000;
    this.baseUrl = options.baseUrl ?? DOCS_API_BASE_URL;
    this.timeoutMs = options.timeoutMs ?? 10_000;
    if (!Number.isSafeInteger(this.maxResponseBytes) || this.maxResponseBytes < 1024 || this.maxResponseBytes > 32_000_000) throw new Error('Invalid Google Docs response size limit');
    if (this.baseUrl !== DOCS_API_BASE_URL) throw new Error('Google Docs API endpoint must use the official fixed endpoint');
    if (!Number.isSafeInteger(this.timeoutMs) || this.timeoutMs < 1 || this.timeoutMs > 60_000) throw new Error('Invalid Google Docs request timeout');
  }

  async getDocument(documentId: string): Promise<GoogleDocsDocument> {
    const id = documentIdSchema.parse(documentId);
    const url = `${this.baseUrl}/documents/${encodeURIComponent(id)}?includeTabsContent=true&suggestionsViewMode=SUGGESTIONS_INLINE&commentsViewMode=COMMENTS_VIEW_MODE_INCLUDED`;
    const { response, payload } = await this.requestJson(url, { method: 'GET' });
    if (!hasBoundedTabTree(payload)) throw new GoogleDocsApiError('invalid_response', response.status);
    const parsed = documentSchema.safeParse(payload);
    if (!parsed.success || parsed.data.documentId !== id) throw new GoogleDocsApiError('invalid_response', response.status);
    return parsed.data;
  }

  async createBlankDocument(operationId: string, title: string, onDispatch?: () => void): Promise<{ documentId: string; title: string }> {
    const marker = operationIdSchema.parse(operationId);
    const safeTitle = createTitleSchema.parse(title);
    const fields = 'id,name,mimeType,appProperties';
    const url = `${DRIVE_API_BASE_URL}/files?fields=${encodeURIComponent(fields)}`;
    const { response, payload } = await this.requestJson(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        mimeType: GOOGLE_DOCUMENT_MIME_TYPE,
        name: safeTitle,
        appProperties: { [CREATE_MARKER_KEY]: marker },
      }),
    }, onDispatch);
    const parsed = createdDriveFileSchema.safeParse(payload);
    if (!parsed.success || parsed.data.name !== safeTitle || parsed.data.appProperties[CREATE_MARKER_KEY] !== marker) {
      throw new GoogleDocsApiError('invalid_response', response.status, true);
    }
    return { documentId: parsed.data.id, title: parsed.data.name };
  }

  async findCreatedDocuments(operationId: string): Promise<Array<{ documentId: string; title: string }>> {
    const marker = operationIdSchema.parse(operationId);
    const query = `appProperties has { key='${CREATE_MARKER_KEY}' and value='${marker}' } and trashed = false`;
    const fields = 'nextPageToken,incompleteSearch,files(id,name,mimeType,appProperties)';
    const files: Array<{ documentId: string; title: string }> = [];
    let pageToken: string | undefined;
    for (let page = 0; page < MAX_CREATE_RECONCILE_PAGES; page++) {
      const params = new URLSearchParams({ q: query, fields, pageSize: '100' });
      if (pageToken) params.set('pageToken', pageToken);
      const { response, payload } = await this.requestJson(`${DRIVE_API_BASE_URL}/files?${params.toString()}`, { method: 'GET' });
      const parsed = driveListSchema.safeParse(payload);
      if (!parsed.success || parsed.data.incompleteSearch === true) throw new GoogleDocsApiError('invalid_response', response.status);
      for (const candidate of parsed.data.files) {
        const file = createdDriveFileSchema.safeParse(candidate);
        if (!file.success || file.data.appProperties[CREATE_MARKER_KEY] !== marker) throw new GoogleDocsApiError('invalid_response', response.status);
        files.push({ documentId: file.data.id, title: file.data.name });
      }
      pageToken = parsed.data.nextPageToken;
      if (!pageToken) return files;
    }
    throw new GoogleDocsApiError('invalid_response');
  }

  async batchUpdate(documentId: string, requiredRevisionId: string, requests: GoogleDocsRequest[], writeMode: 'EDIT' | 'SUGGEST' = 'EDIT'): Promise<GoogleDocsBatchResponse> {
    const id = documentIdSchema.parse(documentId);
    const revision = nonEmpty.parse(requiredRevisionId);
    if (!Array.isArray(requests) || requests.length < 1 || requests.length > 1000) throw new TypeError('Google Docs batches require 1..1000 requests');
    for (const request of requests) validateRequest(request);
    const includesCommentOrSuggestion = requests.some(request => 'insertComment' in request || 'addCommentReply' in request || 'acceptSuggestion' in request || 'rejectSuggestion' in request || writeMode === 'SUGGEST');
    const { response, payload } = await this.requestJson(`${this.baseUrl}/documents/${encodeURIComponent(id)}:batchUpdate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ requests, writeControl: { requiredRevisionId: revision, writeMode } }),
    });
    const parsed = batchResponseSchema.safeParse(payload);
    if (!parsed.success) {
      if (includesCommentOrSuggestion) throw new GoogleDocsPartialUpdateError('invalid_batch_response');
      throw new GoogleDocsApiError('invalid_response', response.status, true);
    }
    if (parsed.data.documentId !== id || !parsed.data.writeControl.requiredRevisionId || parsed.data.replies.length !== requests.length) {
      if (includesCommentOrSuggestion) throw new GoogleDocsPartialUpdateError('invalid_batch_response', parsed.data);
      throw new GoogleDocsApiError('invalid_response', response.status, true);
    }
    const includesComments = requests.some(request => 'insertComment' in request || 'addCommentReply' in request);
    if (includesComments && parsed.data.commentUpdateState !== 'ALL_SAVED') {
      const reason = parsed.data.commentUpdateState === 'ALL_FAILED_UNKNOWN_REASON' ? 'comment_updates_failed' : 'comment_update_state_unknown';
      throw new GoogleDocsPartialUpdateError(reason, parsed.data);
    }
    return parsed.data;
  }

  insertComment(documentId: string, revisionId: string, range: GoogleDocsRange, content: string): Promise<GoogleDocsBatchResponse> {
    const safeContent = validateCommentContent(content);
    return this.batchUpdate(documentId, revisionId, [{ insertComment: { content: safeContent, range: rangeSchema.parse(range) } }]);
  }

  reply(documentId: string, revisionId: string, commentId: string, content: string): Promise<GoogleDocsBatchResponse> {
    const safeContent = validateCommentContent(content);
    return this.batchUpdate(documentId, revisionId, [{ addCommentReply: { commentId: nonEmpty.parse(commentId), post: { content: safeContent } } }]);
  }

  resolve(documentId: string, revisionId: string, commentId: string): Promise<GoogleDocsBatchResponse> {
    return this.batchUpdate(documentId, revisionId, [{ addCommentReply: { commentId: nonEmpty.parse(commentId), post: { commentAction: 'RESOLVE' } } }]);
  }

  reopen(documentId: string, revisionId: string, commentId: string): Promise<GoogleDocsBatchResponse> {
    return this.batchUpdate(documentId, revisionId, [{ addCommentReply: { commentId: nonEmpty.parse(commentId), post: { commentAction: 'REOPEN' } } }]);
  }

  acceptSuggestion(documentId: string, revisionId: string, suggestionId: string): Promise<GoogleDocsBatchResponse> {
    return this.batchUpdate(documentId, revisionId, [{ acceptSuggestion: { suggestionId: nonEmpty.parse(suggestionId) } }]);
  }

  rejectSuggestion(documentId: string, revisionId: string, suggestionId: string): Promise<GoogleDocsBatchResponse> {
    return this.batchUpdate(documentId, revisionId, [{ rejectSuggestion: { suggestionId: nonEmpty.parse(suggestionId) } }]);
  }

  private async requestJson(url: string, init: RequestInit, onDispatch?: () => void): Promise<{ response: Response; payload: unknown }> {
    let token: string;
    try { token = await this.options.getAccessToken(); } catch { throw new GoogleDocsApiError('unauthenticated'); }
    if (typeof token !== 'string' || token.length < 1 || token.length > 8192) throw new GoogleDocsApiError('unauthenticated');
    const controller = new AbortController();
    const post = init.method === 'POST';
    let timeoutReject: ((error: GoogleDocsApiError) => void) | undefined;
    const timeout = new Promise<never>((_resolve, reject) => { timeoutReject = reject; });
    const timer = setTimeout(() => {
      controller.abort();
      timeoutReject?.(new GoogleDocsApiError('timeout', undefined, post));
    }, this.timeoutMs);
    try {
      const operation = (async () => {
        const requestInit: RequestInit = { ...init, redirect: 'error', signal: controller.signal, headers: { ...init.headers, authorization: `Bearer ${token}`, accept: 'application/json' } };
        onDispatch?.();
        const response = await this.fetchImpl(url, requestInit);
        if (!response.ok) {
          const status = response.status;
          await response.body?.cancel().catch(() => undefined);
          // requiredRevisionId mismatch returns 400. Batch callers must re-read before deciding
          // whether the payload is invalid or the preview revision is stale.
          const kind: GoogleDocsErrorKind = status === 401 ? 'unauthenticated' : status === 403 ? 'forbidden' : status === 404 ? 'not_found' : status === 409 || status === 412 || (status === 400 && post) ? 'conflict' : status === 429 ? 'rate_limited' : status >= 500 ? 'server' : 'invalid_request';
          throw new GoogleDocsApiError(kind, status, post && status >= 500);
        }
        let payload: unknown;
        try { payload = await readJson(response, this.maxResponseBytes, controller.signal); }
        catch (error) {
          if (post && error instanceof GoogleDocsApiError) throw new GoogleDocsApiError(error.kind, error.status, true);
          throw error;
        }
        return { response, payload };
      })();
      return await Promise.race([operation, timeout]);
    } catch (error) {
      if (error instanceof GoogleDocsApiError) {
        if (post && error.status === undefined && !error.mayHaveCommitted) throw new GoogleDocsApiError(error.kind, undefined, true);
        throw error;
      }
      throw new GoogleDocsApiError('transport', undefined, post);
    } finally {
      clearTimeout(timer);
    }
  }
}

function validateCommentContent(content: string): string {
  if (typeof content !== 'string' || content.trim().length === 0 || new TextEncoder().encode(content).byteLength > 2048) throw new TypeError('Comment content must be non-empty and at most 2048 UTF-8 bytes');
  return content;
}

function validateRequest(request: GoogleDocsRequest): void {
  if (!request || typeof request !== 'object') throw new TypeError('Invalid Google Docs request');
  assertOnlyKeys(request, ['insertText', 'deleteContentRange', 'updateTextStyle', 'updateParagraphStyle', 'createParagraphBullets', 'insertComment', 'addCommentReply', 'acceptSuggestion', 'rejectSuggestion']);
  if (Object.keys(request).length !== 1) throw new TypeError('Each Google Docs request must contain exactly one operation');
  if ('insertText' in request) {
    const value = request.insertText;
    assertOnlyKeys(value, ['location', 'text']);
    if (!value || typeof value.text !== 'string' || value.text.length === 0) throw new TypeError('Invalid insertText request');
    locationSchema.parse(value.location);
  } else if ('deleteContentRange' in request) { assertOnlyKeys(request.deleteContentRange, ['range']); rangeSchema.parse(request.deleteContentRange.range); }
  else if ('updateTextStyle' in request) {
    assertOnlyKeys(request.updateTextStyle, ['range', 'textStyle', 'fields']);
    rangeSchema.parse(request.updateTextStyle.range);
    assertOnlyKeys(request.updateTextStyle.textStyle, ['bold', 'italic', 'strikethrough']);
    if (Object.values(request.updateTextStyle.textStyle).some(value => typeof value !== 'boolean')) throw new TypeError('Invalid text style value');
    if (!request.updateTextStyle.fields || !Object.keys(request.updateTextStyle.textStyle).length) throw new TypeError('Invalid updateTextStyle request');
  } else if ('updateParagraphStyle' in request) {
    assertOnlyKeys(request.updateParagraphStyle, ['range', 'paragraphStyle', 'fields']);
    rangeSchema.parse(request.updateParagraphStyle.range);
    assertOnlyKeys(request.updateParagraphStyle.paragraphStyle, ['namedStyleType', 'indentStart']);
    if (request.updateParagraphStyle.paragraphStyle.indentStart) assertOnlyKeys(request.updateParagraphStyle.paragraphStyle.indentStart, ['magnitude', 'unit']);
    if (!request.updateParagraphStyle.fields) throw new TypeError('Invalid updateParagraphStyle request');
  } else if ('createParagraphBullets' in request) { assertOnlyKeys(request.createParagraphBullets, ['range', 'bulletPreset']); rangeSchema.parse(request.createParagraphBullets.range); }
  else if ('insertComment' in request) { assertOnlyKeys(request.insertComment, ['content', 'range']); validateCommentContent(request.insertComment.content); rangeSchema.parse(request.insertComment.range); }
  else if ('addCommentReply' in request) {
    assertOnlyKeys(request.addCommentReply, ['commentId', 'post']);
    nonEmpty.parse(request.addCommentReply.commentId);
    const post = request.addCommentReply.post;
    assertOnlyKeys(post, ['content', 'commentAction']);
    if (post.content !== undefined) validateCommentContent(post.content);
    if (post.content === undefined && post.commentAction === undefined) throw new TypeError('Comment reply requires content or an action');
  } else if ('acceptSuggestion' in request) { assertOnlyKeys(request.acceptSuggestion, ['suggestionId']); nonEmpty.parse(request.acceptSuggestion.suggestionId); }
  else if ('rejectSuggestion' in request) { assertOnlyKeys(request.rejectSuggestion, ['suggestionId']); nonEmpty.parse(request.rejectSuggestion.suggestionId); }
  else throw new TypeError('Unsupported Google Docs request type');
}

function assertOnlyKeys(value: object, allowed: string[]): void {
  if (Object.keys(value).some(key => !allowed.includes(key))) throw new TypeError('Unsupported Google Docs request field');
}

function hasBoundedTabTree(payload: unknown): boolean {
  if (!payload || typeof payload !== 'object' || !Array.isArray((payload as { tabs?: unknown }).tabs)) return true;
  const queue = ((payload as { tabs: unknown[] }).tabs).map(tab => ({ tab, depth: 1 }));
  let count = 0;
  while (queue.length) {
    const current = queue.pop()!;
    if (++count > 1000 || current.depth > 32 || !current.tab || typeof current.tab !== 'object') return false;
    const children = (current.tab as { childTabs?: unknown }).childTabs;
    if (children !== undefined) {
      if (!Array.isArray(children) || children.length > 100) return false;
      for (const child of children) queue.push({ tab: child, depth: current.depth + 1 });
    }
  }
  return true;
}

async function readJson(response: Response, limit: number, signal?: AbortSignal): Promise<unknown> {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > limit) { await response.body?.cancel().catch(() => undefined); throw new GoogleDocsApiError('response_too_large', response.status); }
  if (!response.body) throw new GoogleDocsApiError('invalid_response', response.status);
  const reader = response.body.getReader();
  const cancelOnAbort = () => { void reader.cancel().catch(() => undefined); };
  signal?.addEventListener('abort', cancelOnAbort, { once: true });
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > limit) { await reader.cancel(); throw new GoogleDocsApiError('response_too_large', response.status); }
      chunks.push(value);
    }
  } catch (error) {
    if (error instanceof GoogleDocsApiError) throw error;
    throw new GoogleDocsApiError('transport');
  } finally {
    signal?.removeEventListener('abort', cancelOnAbort);
  }
  try {
    const bytes = new Uint8Array(total); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown;
  } catch { throw new GoogleDocsApiError('invalid_response', response.status); }
}
