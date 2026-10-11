import { test, expect, type Page } from '@playwright/test';

const projectId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const workspaceId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const base = `/api/v1/projects/${projectId}`;
const documentId = 'doc_abcdefghijk123456789';
const connectionId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const bindingId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';

async function fixture(page: Page) {
  const content = { title: 'Чернетка статті', document: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Текст статті до прив’язки.' }] }] } };
  const draft = { baseVersionId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', sha256: 'content-hash', content, contentMode: 'CREATIVE', origin: 'MANUAL' };
  const article = { id: 'article', revision: 7, draft, currentApprovedVersionId: null, versions: [] };
  const commands: { path: string; body: unknown }[] = [];
  const tabId = 't.google-tab-2';
  let binding: Record<string, unknown> | null = null;
  let failBindNext: 409 | 503 | null = null;
  let delayConnections = false;
  let holdDraftSave = false;
  let releaseDraft: (() => void) | null = null;
  let finishConnections: (() => void) | null = null;
  const state = () => ({ article, articleSelected: true, eligibleEvidence: [], mappingIssues: [], staleReasons: [], hasUnmapped: false, editorial: { brief: null, outline: { currentApprovedRevisionId: null } } });
  await page.route('**/api/**', async route => {
    const request = route.request(), path = new URL(request.url()).pathname;
    const json = (body: unknown, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    if (path === '/api/auth/session') return json({ authenticated: true, csrfToken: 'csrf', user: { id: 'editor', email: 'test@example.test', displayName: 'Редактор тесту' } });
    if (path === '/api/auth/preferences') return json({ preferences: { idleTimeoutMinutes: 60 } });
    if (path === '/api/auth/external-processing') return json({ notice: { version: '1', text: 'Тестова згода' }, accepted: true });
    if (path === '/api/auth/activity') return json({ authenticated: true });
    if (path === '/api/auth/logout') return json({ authenticated: false });
    const workspace = { id: workspaceId, ownerId: 'editor', name: 'Редакція', archivedAt: null, members: [] };
    if (path === '/api/v1/workspaces') return json({ workspaces: [workspace], nextCursor: null });
    if (path === `/api/v1/workspaces/${workspaceId}`) return json({ workspace });
    if (path === base) return json({ project: { id: projectId, workspaceId, topic: 'Тестова стаття', formats: ['ARTICLE'], revision: 1, createdAt: '2026-10-10T10:00:00Z', updatedAt: '2026-10-10T10:00:00Z', archivedAt: null } });
    if (path === `${base}/jobs`) return json({ jobs: [] });
    if (path === `${base}/article` && request.method() === 'GET') return json(state());
    if (path === `${base}/article/draft` && request.method() === 'POST') {
      const body = request.postDataJSON() as { content: typeof content; contentMode: string; expectedRevision: number };
      commands.push({ path, body });
      if (holdDraftSave) await new Promise<void>(resolve => { releaseDraft = resolve; });
      article.revision++;
      article.draft = { ...draft, content: body.content, contentMode: body.contentMode };
      return json(state());
    }
    if (path === `${base}/google-docs/binding`) return json({ binding });
    if (path === '/api/v1/google-docs/connections') {
      if (delayConnections) await new Promise<void>(resolve => { finishConnections = resolve; });
      return json({ connections: [{ id: connectionId, displayName: 'Редактор Google', status: 'connected', providerAccess: 'authorized' }] });
    }
    if (path === `${base}/google-docs/inspect`) {
      expect(request.headers()['x-csrf-token']).toBe('csrf');
      const body = request.postDataJSON() as { connectionId: string; documentId: string };
      expect(body).toEqual({ connectionId, documentId });
      return json({ document: { documentId, title: 'Тестовий документ', revisionId: 'remote-rev-4', tabs: [{ tabId: 't.google-tab-1', title: 'Вступ' }, { tabId, title: 'Редакторська версія' }] } });
    }
    if (path === `${base}/google-docs/bind`) {
      expect(request.headers()['x-csrf-token']).toBe('csrf');
      const body = request.postDataJSON() as { connectionId: string; documentId: string; tabId: string; commandKey: string; expectedArticleRevision: number; acknowledgeWorkspaceSharing: boolean };
      commands.push({ path, body });
      if (failBindNext) { const status = failBindNext; failBindNext = null; return json({ error: status === 409 ? 'CONFLICT' : 'TEMPORARY' }, status); }
      binding = { id: bindingId, connectionId, documentId, tabId: body.tabId, createdAt: '2026-10-11T10:00:00Z', snapshot: { id: 'snapshot-1', remoteRevision: 'remote-rev-4', contentHash: 'hash', capturedAt: '2026-10-11T10:00:00Z', converted: { unsupported: [], inlineCoordinatesValid: true } } };
      return json({ binding, replayed: false }, 201);
    }
    if (path === `${base}/google-docs/unbind`) { binding = null; return json({ binding: null }); }
    return json({});
  });
  await page.goto(`/projects/${projectId}/article`);
  await expect(page.getByRole('heading', { name: 'Стаття', exact: true })).toBeVisible();
  return { article, commands, binding: () => binding, failBind: (status: 409 | 503) => { failBindNext = status; }, delayConnectionList: () => { delayConnections = true; }, releaseConnectionList: () => { finishConnections?.(); }, holdDraft: () => { holdDraftSave = true; }, releaseDraftSave: () => { releaseDraft?.(); } };
}

async function openBinding(page: Page) {
  await page.getByRole('button', { name: 'Google Документи' }).click();
  await expect(page.getByRole('heading', { name: 'Google Документи' })).toBeVisible();
}

test('requires explicit tab and workspace-sharing acknowledgement before metadata-only binding', async ({ page }) => {
  const context = await fixture(page);
  context.holdDraft();
  const articleText = page.getByRole('textbox', { name: 'Текст статті' });
  await articleText.fill('Текст статті з незбереженою правкою.');
  await page.waitForRequest(request => new URL(request.url()).pathname === `${base}/article/draft`);
  await openBinding(page);
  await page.getByLabel('Посилання або ID документа').fill(`https://docs.google.com/document/d/${documentId}/edit`);
  await page.getByRole('button', { name: 'Перевірити документ' }).click();
  await expect(page.getByText('Тестовий документ')).toBeVisible();
  await expect(page.getByLabel('Вкладка документа')).toHaveValue('');
  await expect(page.getByRole('button', { name: 'Прив’язати документ' })).toBeDisabled();
  await page.getByLabel('Вкладка документа').selectOption('t.google-tab-2');
  await expect(page.getByRole('button', { name: 'Прив’язати документ' })).toBeDisabled();
  await page.getByLabel(/Підтверджую/).check();
  await page.getByRole('button', { name: 'Прив’язати документ' }).click();
  await expect(page.getByRole('heading', { name: 'Прив’язаний документ' })).toBeVisible();
  const bindCommand = context.commands.find(command => command.path.endsWith('/google-docs/bind'));
  expect(bindCommand?.body).toMatchObject({ connectionId, documentId, tabId: 't.google-tab-2', expectedArticleRevision: 7, acknowledgeWorkspaceSharing: true });
  expect(context.article.revision).toBe(7);
  expect(context.article.draft.content.document.content[0]?.content?.[0]?.text).toBe('Текст статті до прив’язки.');
  expect(context.commands.some(command => command.path.endsWith('/article/checkpoint'))).toBe(false);
  for (const width of [1280, 390]) {
    await page.setViewportSize({ width, height: 900 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.screenshot({ path: `.local-checks/google-doc-binding-${width}.png`, fullPage: true });
  }
  context.releaseDraftSave();
  await expect(articleText).toContainText('Текст статті з незбереженою правкою.');
});

test('reuses the same command after an unknown response and then completes the binding', async ({ page }) => {
  const context = await fixture(page);
  await openBinding(page);
  await page.getByLabel('Посилання або ID документа').fill(documentId);
  await page.getByRole('button', { name: 'Перевірити документ' }).click();
  await page.getByLabel('Вкладка документа').selectOption('t.google-tab-2');
  await page.getByLabel(/Підтверджую/).check();
  context.failBind(503);
  await page.getByRole('button', { name: 'Прив’язати документ' }).click();
  await expect(page.getByRole('alert')).toContainText('тимчасово недоступний');
  await page.getByRole('button', { name: 'Прив’язати документ' }).click();
  await expect(page.getByRole('heading', { name: 'Прив’язаний документ' })).toBeVisible();
  expect((context.commands[0]?.body as { commandKey: string }).commandKey).toBe((context.commands[1]?.body as { commandKey: string }).commandKey);
});

test('does not restore a delayed Google connection response after logout', async ({ page }) => {
  const context = await fixture(page);
  context.delayConnectionList();
  const connectionRequest = page.waitForRequest(request => new URL(request.url()).pathname === '/api/v1/google-docs/connections');
  await openBinding(page);
  await connectionRequest;
  await page.locator('summary').filter({ hasText: 'Редактор тесту' }).click();
  await expect(page.getByRole('button', { name: 'Вийти' })).toBeVisible();
  await page.getByRole('button', { name: 'Вийти' }).click();
  await expect(page.getByLabel('Електронна пошта')).toBeVisible();
  context.releaseConnectionList();
  await expect(page.getByLabel('Посилання або ID документа')).toHaveCount(0);
});
