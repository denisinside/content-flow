import { describe, expect, it, vi } from 'vitest';
import { GoogleDocsApiError, GoogleDocsClient, GoogleDocsPartialUpdateError, type GoogleDocsRequest } from './google-docs-client.js';

const doc = {
  documentId: 'doc-1', title: 'Стаття', revisionId: 'rev-1',
  tabs: [{
    tabProperties: { tabId: 'tab-1' },
    documentTab: { body: { content: [] }, commentAnchors: { anchor1: { anchorId: 'anchor1', ranges: [{ startIndex: 1, endIndex: 5, tabId: 'tab-1' }] } } },
  }],
  comments: [{ commentId: 'comment-1', anchorId: 'anchor1', headPost: { postId: 'post-1', content: 'Уточнити', author: { displayName: 'Редактор', user: 'users/123' }, createTime: '2026-10-11T08:00:00Z' }, replies: [{ postId: 'post-2', content: 'Так', deleted: false }], status: 'OPEN', plainTextQuote: 'Текст' }],
  suggestions: [{ suggestionId: 'suggestion-1', headPost: { postId: 'post-3', content: 'Заміна', author: { displayName: 'Автор' } }, replies: [], status: 'OPEN', summaryText: 'змінений текст' }],
};

function reply(body: unknown, status = 200): Response { return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }); }

describe('Google Docs v1 adapter', () => {
  it('creates and reconciles blank Docs files by the exact operation marker', async () => {
    const operationId = 'e3a4b58d-d93b-4eb5-a297-40ac8368de65';
    const marker = { contextFlowCreate: operationId };
    const fetchImpl = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(reply({ id: 'drive-id-1', name: 'New article', mimeType: 'application/vnd.google-apps.document', appProperties: marker }))
      .mockResolvedValueOnce(reply({
        nextPageToken: 'next-page', incompleteSearch: false,
        files: [{ id: 'drive-id-1', name: 'New article', mimeType: 'application/vnd.google-apps.document', appProperties: marker }],
      }))
      .mockResolvedValueOnce(reply({
        files: [{ id: 'drive-id-2', name: 'New article copy', mimeType: 'application/vnd.google-apps.document', appProperties: { ...marker, other: 'preserved' } }],
      }));
    const client = new GoogleDocsClient({ getAccessToken: () => 'test-token', fetchImpl });

    await expect(client.createBlankDocument(operationId, 'New article')).resolves.toEqual({ documentId: 'drive-id-1', title: 'New article' });
    await expect(client.findCreatedDocuments(operationId)).resolves.toEqual([
      { documentId: 'drive-id-1', title: 'New article' },
      { documentId: 'drive-id-2', title: 'New article copy' },
    ]);

    const [createUrl, createInit] = fetchImpl.mock.calls[0]!;
    expect(String(createUrl)).toMatch(/^https:\/\/www\.googleapis\.com\/drive\/v3\/files\?/u);
    expect(new URL(String(createUrl)).searchParams.get('fields')).toBe('id,name,mimeType,appProperties');
    expect(JSON.parse(String(createInit?.body))).toEqual({
      mimeType: 'application/vnd.google-apps.document', name: 'New article', appProperties: marker,
    });
    const [listUrl] = fetchImpl.mock.calls[1]!;
    const listParams = new URL(String(listUrl)).searchParams;
    expect(listParams.get('q')).toBe("appProperties has { key='contextFlowCreate' and value='e3a4b58d-d93b-4eb5-a297-40ac8368de65' } and trashed = false");
    expect(listParams.get('fields')).toBe('nextPageToken,incompleteSearch,files(id,name,mimeType,appProperties)');
    expect(listParams.get('pageSize')).toBe('100');
    expect(new URL(String(fetchImpl.mock.calls[2]![0])).searchParams.get('pageToken')).toBe('next-page');
  });

  it('does not retry a create whose POST outcome is uncertain', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockRejectedValue(new TypeError('connection reset'));
    const client = new GoogleDocsClient({ getAccessToken: () => 'test-token', fetchImpl });
    const onDispatch = vi.fn();
    await expect(client.createBlankDocument('e3a4b58d-d93b-4eb5-a297-40ac8368de65', 'New article', onDispatch))
      .rejects.toMatchObject({ kind: 'transport', mayHaveCommitted: true });
    expect(onDispatch).toHaveBeenCalledTimes(1);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl.mock.calls[0]?.[1]?.method).toBe('POST');
  });

  it('does not signal create dispatch when access-token acquisition fails', async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const onDispatch = vi.fn();
    const client = new GoogleDocsClient({ getAccessToken: () => { throw new Error('token unavailable'); }, fetchImpl });
    await expect(client.createBlankDocument('e3a4b58d-d93b-4eb5-a297-40ac8368de65', 'New article', onDispatch))
      .rejects.toMatchObject({ kind: 'unauthenticated', mayHaveCommitted: false });
    expect(onDispatch).not.toHaveBeenCalled();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('fails closed on malformed or incomplete create reconciliation results', async () => {
    const operationId = 'e3a4b58d-d93b-4eb5-a297-40ac8368de65';
    const malformed = vi.fn<typeof fetch>().mockResolvedValue(reply({
      files: [{ id: 'drive-id-1', name: 'Wrong MIME', mimeType: 'text/plain', appProperties: { contextFlowCreate: operationId } }],
    }));
    await expect(new GoogleDocsClient({ getAccessToken: () => 'x', fetchImpl: malformed }).findCreatedDocuments(operationId))
      .rejects.toMatchObject({ kind: 'invalid_response' });
    const incomplete = vi.fn<typeof fetch>().mockResolvedValue(reply({ incompleteSearch: true, files: [] }));
    await expect(new GoogleDocsClient({ getAccessToken: () => 'x', fetchImpl: incomplete }).findCreatedDocuments(operationId))
      .rejects.toMatchObject({ kind: 'invalid_response' });
  });

  it('accepts 129-character document IDs and rejects IDs beyond the UTF-8 byte limit', async () => {
    const operationId = 'e3a4b58d-d93b-4eb5-a297-40ac8368de65';
    const longId = 'd'.repeat(129);
    const marker = { contextFlowCreate: operationId };
    const fetchImpl = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(reply({ id: longId, name: 'Article', mimeType: 'application/vnd.google-apps.document', appProperties: marker }))
      .mockResolvedValueOnce(reply({ files: [{ id: longId, name: 'Article', mimeType: 'application/vnd.google-apps.document', appProperties: marker }] }))
      .mockResolvedValueOnce(reply({ ...doc, documentId: longId }))
      .mockResolvedValueOnce(reply({ documentId: longId, replies: [{}], writeControl: { requiredRevisionId: 'rev-2' }, commentUpdateState: 'ALL_SAVED' }));
    const client = new GoogleDocsClient({ getAccessToken: () => 'x', fetchImpl });
    await expect(client.createBlankDocument(operationId, 'Article')).resolves.toEqual({ documentId: longId, title: 'Article' });
    await expect(client.findCreatedDocuments(operationId)).resolves.toEqual([{ documentId: longId, title: 'Article' }]);
    await expect(client.getDocument(longId)).resolves.toMatchObject({ documentId: longId });
    await expect(client.batchUpdate(longId, 'rev-1', [{ insertText: { location: { index: 1 }, text: 'Text' } }]))
      .resolves.toMatchObject({ documentId: longId });

    const oversizedId = 'é'.repeat(513);
    const invalidResponse = vi.fn<typeof fetch>().mockResolvedValue(reply({
      files: [{ id: oversizedId, name: 'Article', mimeType: 'application/vnd.google-apps.document', appProperties: marker }],
    }));
    await expect(new GoogleDocsClient({ getAccessToken: () => 'x', fetchImpl: invalidResponse }).findCreatedDocuments(operationId))
      .rejects.toMatchObject({ kind: 'invalid_response' });
  });

  it('allows suggestion-only batches with no comment updates and requires reread on batch 400', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(reply({ documentId: 'doc-1', replies: [{}], writeControl: { requiredRevisionId: 'rev-2' }, commentUpdateState: 'NO_UPDATES_REQUESTED' }));
    const client = new GoogleDocsClient({ getAccessToken: () => 'x', fetchImpl });
    await expect(client.acceptSuggestion('doc-1', 'rev-1', 's')).resolves.toMatchObject({ commentUpdateState: 'NO_UPDATES_REQUESTED' });
    fetchImpl.mockResolvedValue(reply({ error: { message: 'private' } }, 400));
    await expect(client.rejectSuggestion('doc-1', 'rev-1', 's')).rejects.toMatchObject({ kind: 'conflict', status: 400 });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
  it('reads tabs, inline suggestions and comments and validates critical document references', async () => {
    const encodedDocument = { ...doc, documentId: 'doc/1' };
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(reply(encodedDocument));
    const client = new GoogleDocsClient({ getAccessToken: () => 'test-token', fetchImpl });
    await expect(client.getDocument('doc/1')).resolves.toMatchObject({ documentId: 'doc/1', revisionId: 'rev-1', tabs: [{ tabProperties: { tabId: 'tab-1' }, documentTab: { commentAnchors: { anchor1: { ranges: [{ startIndex: 1, endIndex: 5 }] } } } }], comments: [{ commentId: 'comment-1', headPost: { postId: 'post-1' }, replies: [{ postId: 'post-2' }], status: 'OPEN' }], suggestions: [{ suggestionId: 'suggestion-1', summaryText: 'змінений текст' }] });
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(String(url)).toContain('documents/doc%2F1?includeTabsContent=true&suggestionsViewMode=SUGGESTIONS_INLINE&commentsViewMode=COMMENTS_VIEW_MODE_INCLUDED');
    expect(new Headers(init?.headers).get('authorization')).toBe('Bearer test-token');
    const badFetch = vi.fn<typeof fetch>().mockResolvedValue(reply({ ...doc, revisionId: '' }));
    await expect(new GoogleDocsClient({ getAccessToken: () => 'x', fetchImpl: badFetch }).getDocument('doc-1')).rejects.toMatchObject({ kind: 'invalid_response' });
    const mismatchedFetch = vi.fn<typeof fetch>().mockResolvedValue(reply(doc));
    await expect(new GoogleDocsClient({ getAccessToken: () => 'x', fetchImpl: mismatchedFetch }).getDocument('different-doc')).rejects.toMatchObject({ kind: 'invalid_response' });
  });

  it('uses requiredRevisionId and the selected write mode without retrying conflicts', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(reply({ documentId: 'doc-1', replies: [{}], writeControl: { requiredRevisionId: 'rev-2' }, commentUpdateState: 'ALL_SAVED' }));
    const client = new GoogleDocsClient({ getAccessToken: () => 'x', fetchImpl });
    const requests: GoogleDocsRequest[] = [{ insertText: { location: { index: 1, tabId: 'tab-1' }, text: 'Текст 😀' } }];
    await client.batchUpdate('doc-1', 'rev-1', requests, 'SUGGEST');
    const [, init] = fetchImpl.mock.calls[0]!;
    expect(JSON.parse(String(init?.body))).toMatchObject({ writeControl: { requiredRevisionId: 'rev-1', writeMode: 'SUGGEST' }, requests });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('reports comment/suggestion partial outcomes as unsafe for retry', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(reply({ documentId: 'doc-1', replies: [{}], writeControl: { requiredRevisionId: 'rev-2' }, commentUpdateState: 'ALL_FAILED_UNKNOWN_REASON' }));
    const client = new GoogleDocsClient({ getAccessToken: () => 'x', fetchImpl });
    await expect(client.insertComment('doc-1', 'rev-1', { startIndex: 1, endIndex: 3, tabId: 'tab-1' }, 'Перевірити')).rejects.toBeInstanceOf(GoogleDocsPartialUpdateError);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('supports native comment actions and suggestion decisions with required revisions', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as { requests: unknown[] };
      return reply({ documentId: 'doc-1', replies: body.requests.map(() => ({})), writeControl: { requiredRevisionId: 'rev-next' }, commentUpdateState: 'ALL_SAVED' });
    });
    const client = new GoogleDocsClient({ getAccessToken: () => 'x', fetchImpl });
    await client.reply('doc-1', 'rev-a', 'comment-1', 'Відповідь');
    await client.resolve('doc-1', 'rev-b', 'comment-1');
    await client.reopen('doc-1', 'rev-c', 'comment-1');
    await client.acceptSuggestion('doc-1', 'rev-d', 'suggestion-1');
    await client.rejectSuggestion('doc-1', 'rev-e', 'suggestion-2');
    const bodies = fetchImpl.mock.calls.map(([, init]) => JSON.parse(String(init?.body)) as { requests: unknown[]; writeControl: unknown });
    expect(bodies.map(value => value.writeControl)).toEqual([{ requiredRevisionId: 'rev-a', writeMode: 'EDIT' }, { requiredRevisionId: 'rev-b', writeMode: 'EDIT' }, { requiredRevisionId: 'rev-c', writeMode: 'EDIT' }, { requiredRevisionId: 'rev-d', writeMode: 'EDIT' }, { requiredRevisionId: 'rev-e', writeMode: 'EDIT' }]);
    expect(bodies.map(value => value.requests[0])).toEqual([
      { addCommentReply: { commentId: 'comment-1', post: { content: 'Відповідь' } } },
      { addCommentReply: { commentId: 'comment-1', post: { commentAction: 'RESOLVE' } } },
      { addCommentReply: { commentId: 'comment-1', post: { commentAction: 'REOPEN' } } },
      { acceptSuggestion: { suggestionId: 'suggestion-1' } },
      { rejectSuggestion: { suggestionId: 'suggestion-2' } },
    ]);
  });

  it('classifies HTTP failures without exposing response content', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(reply({ error: { message: 'secret document text' } }, 403));
    const httpFailure = await new GoogleDocsClient({ getAccessToken: () => 'x', fetchImpl }).getDocument('doc-1').catch(error => error as GoogleDocsApiError);
    expect(httpFailure).toMatchObject({ kind: 'forbidden', status: 403 });
    expect(httpFailure.message).not.toContain('secret document text');
    await expect(new GoogleDocsClient({ getAccessToken: () => 'x', fetchImpl: vi.fn<typeof fetch>().mockRejectedValue(new Error('network detail')) }).getDocument('doc-1')).rejects.toBeInstanceOf(GoogleDocsApiError);
  });

  it('pins the official endpoint and rejects redirect following', async () => {
    expect(() => new GoogleDocsClient({ getAccessToken: () => 'x', baseUrl: 'https://attacker.example/v1' })).toThrow(/official fixed endpoint/u);
    const redirectFetch = vi.fn<typeof fetch>().mockImplementation(async (_input, init) => {
      expect(init?.redirect).toBe('error');
      throw new TypeError('redirect target details');
    });
    await expect(new GoogleDocsClient({ getAccessToken: () => 'x', fetchImpl: redirectFetch }).getDocument('doc-1')).rejects.toMatchObject({ kind: 'transport' });
    expect(String(redirectFetch.mock.calls[0]?.[0])).toMatch(/^https:\/\/docs\.googleapis\.com\/v1\//u);
  });

  it('validates bounded request timeouts and times out hanging fetches without retrying', async () => {
    expect(() => new GoogleDocsClient({ getAccessToken: () => 'x', timeoutMs: 60_001 })).toThrow(/timeout/u);
    expect(() => new GoogleDocsClient({ getAccessToken: () => 'x', timeoutMs: 0 })).toThrow(/timeout/u);
    const hangingFetch = vi.fn<typeof fetch>().mockImplementation(() => new Promise<Response>(() => undefined));
    const client = new GoogleDocsClient({ getAccessToken: () => 'x', fetchImpl: hangingFetch, timeoutMs: 10 });
    await expect(client.getDocument('doc-1')).rejects.toMatchObject({ kind: 'timeout', mayHaveCommitted: false });
    await expect(client.batchUpdate('doc-1', 'rev-1', [{ insertText: { location: { index: 1 }, text: 'Текст' } }])).rejects.toMatchObject({ kind: 'timeout', mayHaveCommitted: true });
    expect(hangingFetch).toHaveBeenCalledTimes(2);
    expect(hangingFetch.mock.calls.every(([, init]) => init?.signal instanceof AbortSignal)).toBe(true);
  });

  it('times out a hanging response body across GET and POST and marks POST outcome unknown', async () => {
    const hangingBody = () => new Response(new ReadableStream<Uint8Array>({ pull: () => new Promise<void>(() => undefined) }), { status: 200 });
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async () => hangingBody());
    const client = new GoogleDocsClient({ getAccessToken: () => 'x', fetchImpl, timeoutMs: 10 });
    await expect(client.getDocument('doc-1')).rejects.toMatchObject({ kind: 'timeout', mayHaveCommitted: false });
    await expect(client.batchUpdate('doc-1', 'rev-1', [{ insertText: { location: { index: 1 }, text: 'Текст' } }])).rejects.toMatchObject({ kind: 'timeout', mayHaveCommitted: true });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});
