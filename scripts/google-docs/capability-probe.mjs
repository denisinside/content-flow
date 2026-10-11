// GD-00 only: loopback OAuth and synthetic document checks. No product connection or token persistence.
import { createServer } from 'node:http';
import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { GoogleDocsClient } from '../../packages/backend/dist/google-docs/google-docs-client.js';

process.loadEnvFile('.env');
const clientId = process.env.GOOGLE_DOCS_CLIENT_ID;
const clientSecret = process.env.GOOGLE_DOCS_CLIENT_SECRET;
const redirectUri = process.env.GOOGLE_DOCS_REDIRECT_URI;
if (!clientId || !clientSecret || redirectUri !== 'http://localhost:3000/api/v1/google-docs/oauth/callback') throw new Error('Configure the agreed local Google OAuth client first');
const state = randomBytes(32).toString('base64url');
const verifier = randomBytes(48).toString('base64url');
let started = false, consumed = false;
const receipt = { schemaVersion: 'gd00-probe-v1', startedAt: new Date().toISOString(), checks: [], status: 'PENDING', limitations: ['Single owner/editor account; commenter/reader rights and application sync are not tested.'] };
const verifyExisting = process.argv.includes('--verify-existing');
const previous = process.argv.includes('--resume-initial-text') || verifyExisting ? JSON.parse(await readFile('.local-checks/google-docs-capability-receipt.json', 'utf8')) : null;
if (previous && (typeof previous.documentId !== 'string' || (verifyExisting ? previous.status !== 'PASS_SCOPED' && previous.stage !== 'verify_existing_anchors' : previous.status !== 'FAILED' || previous.checks.length !== 0))) throw new Error('Invalid recovery receipt');
function safeStatus(error) { return { kind: error?.kind ?? 'probe_failed', status: error?.status ?? null, mayHaveCommitted: error?.mayHaveCommitted ?? false }; }
function committedText(document, tabId) {
  const tab = document.tabs.find(item => item.tabProperties.tabId === tabId);
  return (tab?.documentTab.body.content ?? []).flatMap(item => item.paragraph?.elements ?? []).map(item => item.textRun?.suggestedInsertionIds?.length ? '' : item.textRun?.content ?? '').join('');
}
async function runProbe(token) {
  const docs = new GoogleDocsClient({ getAccessToken: () => token });
  receipt.stage = 'create_or_resume';
  let document = previous;
  if (!document) {
    const created = await fetch('https://docs.googleapis.com/v1/documents', { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ title: 'ContextFlow GD-00 synthetic capability check' }), signal: AbortSignal.timeout(30000) });
    if (!created.ok) throw Object.assign(new Error('Create failed'), { status: created.status });
    document = await created.json();
  }
  if (typeof document.documentId !== 'string') throw new Error('Invalid create response');
  receipt.documentId = document.documentId;
  const id = document.documentId;
  let current = await docs.getDocument(id);
  if (current.title !== 'ContextFlow GD-00 synthetic capability check') throw new Error('Unexpected recovery document');
  const tabId = current.tabs[0]?.tabProperties.tabId;
  if (!tabId) throw new Error('Missing tab');
  receipt.tabId = tabId;
  if (verifyExisting) {
    receipt.stage = 'verify_existing_anchors';
    const knownCommentId = previous.checks.find(item => item.name === 'native_comment_readback')?.commentId;
    const matching = current.comments?.filter(item => knownCommentId ? item.commentId === knownCommentId : item.headPost.content === 'Synthetic review comment') ?? [];
    const existing = matching.length === 1 ? matching[0] : undefined;
    const anchors = current.tabs[0]?.documentTab.commentAnchors;
    const anchor = existing?.anchorId ? anchors?.[existing.anchorId] : undefined;
    const prefix = 'Пропозиція ';
    receipt.anchorReadback = { ranges: anchor?.ranges ?? [], authorMe: existing?.headPost.author?.me ?? null, authorFields: Object.keys(existing?.headPost.author ?? {}), threadStatus: existing?.status ?? null, matchingThreads: matching.length, textMatches: committedText(current, tabId) === prefix + 'Перевірка 😀 коментарів і правок.\n\n', openSuggestions: current.suggestions?.filter(item => item.status === 'OPEN').length ?? 0 };
    if (current.tabs.length !== 1 || !existing || existing.status !== 'OPEN' || existing.headPost.author?.me !== true
      || existing.headPost.content !== 'Synthetic review comment' || !anchor || anchor.ranges.length !== 1
      || (anchor.ranges[0]?.tabId !== undefined && anchor.ranges[0]?.tabId !== tabId) || anchor.ranges[0]?.startIndex !== 1 + prefix.length
      || anchor.ranges[0]?.endIndex !== 10 + prefix.length || !!anchor.ranges[0]?.segmentId
      || committedText(current, tabId) !== prefix + 'Перевірка 😀 коментарів і правок.\n\n'
      || current.suggestions?.some(item => item.status === 'OPEN')) throw new Error('Existing exact anchor/text/author readback failed');
    receipt.checks = [{ name: 'selected_tab_exact_comment_anchor_actual_author', status: 'PASS', commentId: existing.commentId }];
    receipt.status = 'PASS_SCOPED';
    return;
  }
  receipt.stage = 'initial_text_readback';
  // A blank Docs body already has its terminal paragraph newline.
  const expectedText = 'Перевірка 😀 коментарів і правок.\n\n';
  if (committedText(current, tabId) === '\n') {
    await docs.batchUpdate(id, current.revisionId, [{ insertText: { location: { index: 1, tabId }, text: 'Перевірка 😀 коментарів і правок.\n' } }]);
    current = await docs.getDocument(id);
  }
  receipt.textReadback = { utf16Length: committedText(current, tabId).length, expectedUtf16Length: expectedText.length, sha256: createHash('sha256').update(committedText(current, tabId)).digest('hex') };
  if (committedText(current, tabId) !== expectedText) throw new Error('Text readback not confirmed');
  receipt.checks.push({ name: 'selected_tab_utf16_text', status: 'PASS' });
  receipt.stage = 'native_comment';
  await docs.insertComment(id, current.revisionId, { startIndex: 1, endIndex: 10, tabId }, 'Synthetic review comment');
  current = await docs.getDocument(id);
  const comment = current.comments?.find(item => item.headPost.content === 'Synthetic review comment');
  if (!comment || comment.status !== 'OPEN') throw new Error('Comment readback not confirmed');
  const insertedAnchor = comment.anchorId ? current.tabs[0]?.documentTab.commentAnchors?.[comment.anchorId] : undefined;
  if (comment.headPost.author?.me !== true || !insertedAnchor || insertedAnchor.ranges.length !== 1
    || insertedAnchor.ranges[0]?.startIndex !== 1 || insertedAnchor.ranges[0]?.endIndex !== 10
    || (insertedAnchor.ranges[0]?.tabId !== undefined && insertedAnchor.ranges[0]?.tabId !== tabId)
    || !!insertedAnchor.ranges[0]?.segmentId) throw new Error('Exact comment anchor/author readback not confirmed');
  receipt.checks.push({ name: 'native_comment_readback', status: 'PASS', commentId: comment.commentId });
  receipt.stage = 'reply_resolve_reopen';
  await docs.reply(id, current.revisionId, comment.commentId, 'Synthetic reply');
  current = await docs.getDocument(id);
  if (!current.comments?.find(item => item.commentId === comment.commentId)?.replies?.some(post => post.content === 'Synthetic reply')) throw new Error('Reply readback not confirmed');
  await docs.resolve(id, current.revisionId, comment.commentId);
  current = await docs.getDocument(id);
  if (current.comments?.find(item => item.commentId === comment.commentId)?.status !== 'RESOLVED') throw new Error('Resolve readback not confirmed');
  await docs.reopen(id, current.revisionId, comment.commentId);
  current = await docs.getDocument(id);
  if (current.comments?.find(item => item.commentId === comment.commentId)?.status !== 'OPEN') throw new Error('Reopen readback not confirmed');
  receipt.checks.push({ name: 'reply_resolve_reopen', status: 'PASS' });
  const staleRevision = current.revisionId;
  receipt.stage = 'suggest_accept';
  await docs.batchUpdate(id, current.revisionId, [{ insertText: { location: { index: 1, tabId }, text: 'Пропозиція ' } }], 'SUGGEST');
  current = await docs.getDocument(id);
  const suggestion = current.suggestions?.find(item => item.status === 'OPEN');
  if (!suggestion) throw new Error('Suggestion readback not confirmed');
  await docs.acceptSuggestion(id, current.revisionId, suggestion.suggestionId);
  current = await docs.getDocument(id);
  if (current.suggestions?.find(item => item.suggestionId === suggestion.suggestionId)?.status === 'OPEN') throw new Error('Accept readback not confirmed');
  if (!committedText(current, tabId).startsWith('Пропозиція Перевірка 😀')) throw new Error('Accepted text readback not confirmed');
  receipt.checks.push({ name: 'suggest_accept', status: 'PASS' });
  receipt.stage = 'suggest_reject';
  await docs.batchUpdate(id, current.revisionId, [{ insertText: { location: { index: 1, tabId }, text: 'Відхилення ' } }], 'SUGGEST');
  current = await docs.getDocument(id);
  const rejected = current.suggestions?.find(item => item.status === 'OPEN');
  if (!rejected) throw new Error('Second suggestion readback not confirmed');
  await docs.rejectSuggestion(id, current.revisionId, rejected.suggestionId);
  current = await docs.getDocument(id);
  if (current.suggestions?.find(item => item.suggestionId === rejected.suggestionId)?.status === 'OPEN') throw new Error('Reject readback not confirmed');
  if (!committedText(current, tabId).startsWith('Пропозиція Перевірка 😀')) throw new Error('Rejected text readback not confirmed');
  receipt.checks.push({ name: 'suggest_reject', status: 'PASS' });
  try { await docs.batchUpdate(id, staleRevision, [{ insertText: { location: { index: 1, tabId }, text: 'STALE' } }]); throw new Error('Stale write succeeded'); }
  catch (error) { if (error.kind !== 'conflict') throw error; receipt.checks.push({ name: 'required_revision_conflict', status: 'PASS' }); }
  receipt.status = 'PASS_SCOPED';
}
const server = createServer(async (request, response) => {
  const url = new URL(request.url ?? '/', 'http://localhost:3000');
  response.setHeader('Cache-Control', 'no-store'); response.setHeader('Content-Security-Policy', "default-src 'none'");
  if (url.pathname === '/start' && !started) {
    started = true;
    const auth = new URL('https://accounts.google.com/o/oauth2/v2/auth');
    auth.search = new URLSearchParams({ client_id: clientId, redirect_uri: redirectUri, response_type: 'code', scope: 'https://www.googleapis.com/auth/drive.file', state, code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256', access_type: 'online' }).toString();
    response.writeHead(302, { Location: auth.toString() }).end(); return;
  }
  const receivedState = url.searchParams.get('state') ?? '';
  if (url.pathname !== '/api/v1/google-docs/oauth/callback' || !started || consumed || receivedState.length !== state.length || !timingSafeEqual(Buffer.from(receivedState), Buffer.from(state))) { response.writeHead(400).end('Invalid OAuth callback'); return; }
  consumed = true;
  try {
    const code = url.searchParams.get('code');
    if (!code || url.searchParams.has('error')) throw new Error('OAuth was not granted');
    const exchanged = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, redirect_uri: redirectUri, grant_type: 'authorization_code', code, code_verifier: verifier }), signal: AbortSignal.timeout(30000) });
    if (!exchanged.ok) throw Object.assign(new Error('OAuth exchange failed'), { status: exchanged.status });
    const tokens = await exchanged.json();
    if (typeof tokens.access_token !== 'string') throw new Error('Missing access token');
    await runProbe(tokens.access_token);
    response.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' }).end('GD-00 synthetic checks completed. See the local sanitized receipt. Product sync remains pending.');
  } catch (error) { receipt.status = 'FAILED'; receipt.failure = { ...safeStatus(error), mayHaveCommitted: error?.mayHaveCommitted ?? (!verifyExisting && !!receipt.documentId) }; response.writeHead(502).end('Probe failed. See the sanitized local receipt; do not retry unknown writes blindly.'); }
  finally { receipt.finishedAt = new Date().toISOString(); await mkdir('.local-checks', { recursive: true }); const serialized = JSON.stringify(receipt, null, 2); await writeFile(`.local-checks/google-docs-capability-${receipt.startedAt.replace(/[:.]/g, '-')}.json`, serialized); await writeFile('.local-checks/google-docs-capability-receipt.json', serialized); server.close(); console.log('GD-00 probe finished:', receipt.status); }
});
server.requestTimeout = 30000;
server.listen(3000, '127.0.0.1', () => console.log('GD-00 probe ready at http://localhost:3000/start; grant requires owner approval.'));
server.on('error', () => { console.error('Cannot start loopback probe. Existing API/server is not stopped.'); process.exitCode = 1; });
setTimeout(() => { if (!consumed) { server.close(); console.log('GD-00 probe expired without OAuth grant.'); } }, 3600000).unref();
