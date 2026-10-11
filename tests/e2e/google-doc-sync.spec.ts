import { test, expect, type Page } from '@playwright/test';

const project = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', workspace = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const connection = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', version = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const base = `/api/v1/projects/${project}`, sync = `${base}/google-docs/sync`;

async function fixture(page: Page, uncertain = false, options: { backgroundEnabled?: boolean; noConnection?: boolean; localReplyTransfer?: boolean; failConfirm?: boolean } = {}) {
  const content = { title: 'Стаття для Google', document: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Збережений текст статті.' }] }] } };
  const saved = { id: version, number: 1, sha256: 'hash', content, plainText: 'Збережений текст статті.', origin: 'MANUAL', approvedAt: null };
  const article = { id: 'article', revision: 7, draft: { baseVersionId: version, sha256: 'hash', content, contentMode: 'CREATIVE', origin: 'MANUAL' }, currentApprovedVersionId: null, versions: [saved] };
  const binding = { id: 'binding', documentId: 'synthetic-doc', tabId: 'tab', connectionId: connection, createdAt: '2026-10-11T10:00:00Z', snapshot: null };
  const calls: { path: string; body: Record<string, unknown> }[] = [];
  let failConfirm = options.failConfirm ?? true;
  let backgroundGranted = Boolean(options.backgroundEnabled);
  const linkedPostIds = new Set<string>(['local-linked-reply']);
  let pendingLocalPostId: string | null = null;
  const localAnnotation = { id: 'local-comment', articleVersionId: version, kind: 'COMMENT', status: 'OPEN', quote: 'Збережений', body: 'Локальний коментар', anchor: { status: 'anchored', start: 0, end: 10 }, posts: [
    { id: 'local-linked-reply', body: 'Відповідь уже перенесено', action: 'REPLY' },
    { id: 'local-reply', body: 'Локальна відповідь редактора', action: 'REPLY' },
  ] };
  await page.route('**/api/**', async route => {
    const request = route.request(), path = new URL(request.url()).pathname;
    const json = (value: unknown, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(value) });
    if (request.method() === 'POST') calls.push({ path, body: request.postDataJSON() as Record<string, unknown> });
    if (path === '/api/auth/session') return json({ authenticated: true, csrfToken: 'csrf', user: { id: 'editor', email: 'synthetic@example.test', displayName: 'Редактор' } });
    if (path === '/api/auth/preferences') return json({ preferences: { idleTimeoutMinutes: 60 } });
    if (path === '/api/auth/external-processing') return json({ accepted: true, notice: { version: '1', text: 'Тестова згода' } });
    if (path === '/api/auth/activity') return json({ authenticated: true });
    const workspaceRow = { id: workspace, ownerId: 'editor', name: 'Синтетична редакція', archivedAt: null, members: [] };
    if (path === '/api/v1/workspaces') return json({ workspaces: [workspaceRow], nextCursor: null });
    if (path === `/api/v1/workspaces/${workspace}`) return json({ workspace: workspaceRow });
    if (path === base) return json({ project: { id: project, workspaceId: workspace, topic: 'Синтетична стаття', formats: ['ARTICLE'], revision: 1, archivedAt: null } });
    if (path === `${base}/article`) return json({ article, articleSelected: true, eligibleEvidence: [], mappingIssues: [], staleReasons: [], hasUnmapped: false, editorial: { brief: null, outline: { currentApprovedRevisionId: null } } });
    if (path === `${base}/jobs`) return json({ jobs: [] });
    if (path === `${base}/google-docs/binding`) return json({ binding });
    if (path === '/api/v1/google-docs/connections') return json({ connections: options.noConnection ? [] : [{ id: connection, displayName: 'Мій Google', status: 'connected', providerAccess: 'authorized' }] });
    if (path === sync) return json({ binding, state: { status: 'READY', backgroundGeneration: backgroundGranted ? 5 : 0, ...(backgroundGranted ? { backgroundGrantedAt: '2026-10-11T10:00:00Z', backgroundConnectionId: connection } : {}) }, versions: [saved], localAnnotations: options.localReplyTransfer ? [localAnnotation] : [],
      threads: [
        { id: 'remote-thread', kind: 'comment', status: 'OPEN', author: { displayName: 'Автор Google' }, quoteText: 'Збережений', anchorStatus: 'anchored', localAnnotationId: options.localReplyTransfer ? 'local-comment' : null,
          payload: { headPost: { postId: 'post', content: 'Зберегти це обговорення', author: { displayName: 'Автор Google' } }, replies: [], localPostLinks: Object.fromEntries([...linkedPostIds].map(id => [id, `remote-${id}`])) } },
        { id: 'remote-suggestion', remoteId: 'suggestion-1', kind: 'suggestion', status: 'PENDING', author: { displayName: 'Редактор Google' }, quoteText: 'Збережений', anchorStatus: 'anchored', localAnnotationId: null,
          payload: { suggestionParts: [
            { suggestionId: 'suggestion-1', type: 'insertion', text: 'оновлений', startIndex: 0, endIndex: 5, supported: true },
            { suggestionId: 'suggestion-1', type: 'style', style: { weightedFontFamily: { fontFamily: 'Example' } }, startIndex: 0, endIndex: 5, supported: false },
          ] } },
      ],
      operations: uncertain ? [{ id: 'unknown-operation', kind: 'COMMENT_CREATE', state: 'UNKNOWN' }] : [] });
    if (path === `${sync}/preview`) { pendingLocalPostId = typeof request.postDataJSON().localPostId === 'string' ? request.postDataJSON().localPostId as string : null; return json({ previewId: 'preview', kind: request.postDataJSON().kind, sourceVersionId: version, remoteRevision: 'r1',
      localContent: content, remoteContent: { ...content, document: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Текст Google для порівняння.' }] }] } },
      baselineContent: null, hasConflict: false, unsupported: [], writeMode: 'SUGGEST', summary: 'Пропозиції правок', expiresAt: '2099-10-11T10:00:00Z' }); }
    if (path === `${sync}/confirm`) { if (failConfirm) { failConfirm = false; return json({ message: 'Тимчасова помилка' }, 503); } if (pendingLocalPostId) linkedPostIds.add(pendingLocalPostId); return json({ operation: { id: 'operation', state: 'QUEUED' } }); }
    if (path === `${sync}/background`) { backgroundGranted = Boolean(request.postDataJSON().enabled); return json({ state: { backgroundGeneration: 6, ...(backgroundGranted ? { backgroundGrantedAt: '2026-10-11T10:01:00Z' } : {}) } }); }
    if (path.endsWith('/reconcile')) return json({ operation: { id: 'read-reconciliation', state: 'QUEUED' } });
    return json({});
  });
  await page.goto(`/projects/${project}/article`);
  await page.getByRole('button', { name: 'Google Документи' }).click();
  await expect(page.getByRole('heading', { name: 'Синхронізація', exact: true })).toBeVisible();
  return calls;
}

test('previews readable text, preserves native author and reuses confirm key after a lost response', async ({ page }) => {
  const calls = await fixture(page);
  await expect(page.getByText('Зберегти це обговорення')).toBeVisible();
  await expect(page.getByText('Автор Google').first()).toBeVisible();
  await page.getByRole('button', { name: 'Переглянути експорт' }).click();
  await page.getByText('Порівняти тексти', { exact: true }).click();
  await expect(page.getByText('Текст Google для порівняння.', { exact: true })).toBeVisible();
  expect(calls.filter(call => call.path === `${sync}/confirm`)).toHaveLength(0);
  await page.getByRole('button', { name: 'Підтвердити й надіслати' }).click();
  await expect(page.getByText('Google Docs тимчасово недоступний. Дані статті збережено.')).toBeVisible();
  await page.getByRole('button', { name: 'Підтвердити й надіслати' }).click();
  const confirms = calls.filter(call => call.path === `${sync}/confirm`);
  expect(confirms).toHaveLength(2);
  expect(confirms[0]!.body.commandKey).toBe(confirms[1]!.body.commandKey);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: '.local-checks/google-doc-sync-1280.png', fullPage: true });
});

test('reply preview targets the imported native Google comment thread', async ({ page }) => {
  const calls = await fixture(page);
  const reply = page.getByLabel('Відповісти');
  await reply.fill('Дякую, врахую цю примітку.');
  await page.getByRole('button', { name: 'Додати відповідь' }).click();
  const previewCall = calls.find(call => call.path === `${sync}/preview`);
  expect(previewCall?.body).toMatchObject({ kind: 'COMMENT_REPLY', threadId: 'remote-thread', body: 'Дякую, врахую цю примітку.' });
  await expect(page.getByRole('heading', { name: 'Перевірте дію перед відправленням' })).toBeVisible();
});

test('explicitly previews one unlinked editor reply and removes its action after sync status links it', async ({ page }) => {
  const calls = await fixture(page, false, { localReplyTransfer: true, failConfirm: false });
  await expect(page.getByText('Автор Google').first()).toBeVisible();
  const transfer = page.getByRole('button', { name: 'Перенести відповідь у Google' });
  await expect(transfer).toHaveCount(1);
  await transfer.click();
  const preview = calls.find(call => call.path === `${sync}/preview` && call.body.kind === 'COMMENT_REPLY');
  expect(preview?.body).toMatchObject({ threadId: 'remote-thread', annotationId: 'local-comment', localPostId: 'local-reply', body: 'Локальна відповідь редактора' });
  await page.getByRole('button', { name: 'Підтвердити й надіслати' }).click();
  await expect(page.getByText('Автор Google').first()).toBeVisible();
  await expect(page.getByRole('button', { name: 'Перенести відповідь у Google' })).toHaveCount(0);
});

test('shows native suggestion parts and blocks acceptance when one part is unsupported', async ({ page }) => {
  await fixture(page);
  await expect(page.getByText('Додати: «оновлений»')).toBeVisible();
  await expect(page.getByText(/цю частину не можна безпечно застосувати автоматично/)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Прийняти всі частини' })).toBeDisabled();
});

test('any active editor can stop background reading without their own Google connection', async ({ page }) => {
  const calls = await fixture(page, false, { backgroundEnabled: true, noConnection: true });
  const toggle = page.getByLabel('Дозволити фонове читання Google Документа');
  await expect(toggle).toBeChecked();
  await toggle.uncheck();
  const change = calls.find(call => call.path === `${sync}/background`);
  expect(change?.body).toMatchObject({ connectionId: connection, enabled: false, expectedGeneration: 5 });
  await expect(toggle).not.toBeChecked();
});

test('unknown remote effect blocks export and offers a read reconciliation on mobile', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const calls = await fixture(page, true);
  await expect(page.getByRole('button', { name: 'Переглянути експорт' })).toBeDisabled();
  await page.getByRole('button', { name: 'Перевірити результат у Google' }).click();
  expect(calls.some(call => call.path.endsWith('/unknown-operation/reconcile'))).toBe(true);
  expect(calls.some(call => call.path === `${sync}/confirm`)).toBe(false);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: '.local-checks/google-doc-sync-390.png', fullPage: true });
});
