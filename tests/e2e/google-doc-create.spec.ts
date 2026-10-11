import { test, expect, type Page } from '@playwright/test';

const projectId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const workspaceId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const base = `/api/v1/projects/${projectId}`;
const connectionId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const commandId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const documentId = 'doc_abcdefghijk123456789';

async function fixture(page: Page, mode: 'success' | 'unknown' | 'known-failure') {
  const content = { title: 'Чернетка статті', document: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Поточний текст статті.' }] }] } };
  const draft = { baseVersionId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', sha256: 'content-hash', content, contentMode: 'CREATIVE', origin: 'MANUAL' };
  const article = { id: 'article', revision: 7, draft, currentApprovedVersionId: null, versions: [] };
  const commands: { path: string; body?: unknown }[] = [];
  let commandKey = '';
  let record: Record<string, unknown> | null = null;
  let createCalls = 0;
  let reconcileCalls = 0;
  const command = (state: 'SUBMITTED' | 'UNKNOWN' | 'CREATED' | 'FAILED'): Record<string, unknown> => ({ id: commandId, commandKey, title: 'Чернетка перевірки', state, documentId: state === 'CREATED' ? documentId : null, connectionId, createdAt: '2026-10-11T10:00:00Z', updatedAt: '2026-10-11T10:01:00Z' });
  const state = () => ({ article, articleSelected: true, eligibleEvidence: [], mappingIssues: [], staleReasons: [], hasUnmapped: false, editorial: { brief: null, outline: { currentApprovedRevisionId: null } } });
  await page.route('**/api/**', async route => {
    const request = route.request(), path = new URL(request.url()).pathname;
    const json = (body: unknown, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    if (path === '/api/auth/session') return json({ authenticated: true, csrfToken: 'csrf', user: { id: 'editor', email: 'test@example.test', displayName: 'Редактор тесту' } });
    if (path === '/api/auth/preferences') return json({ preferences: { idleTimeoutMinutes: 60 } });
    if (path === '/api/auth/external-processing') return json({ notice: { version: '1', text: 'Тестова згода' }, accepted: true });
    if (path === '/api/auth/activity') return json({ authenticated: true });
    const workspace = { id: workspaceId, ownerId: 'editor', name: 'Редакція', archivedAt: null, members: [] };
    if (path === '/api/v1/workspaces') return json({ workspaces: [workspace], nextCursor: null });
    if (path === `/api/v1/workspaces/${workspaceId}`) return json({ workspace });
    if (path === base) return json({ project: { id: projectId, workspaceId, topic: 'Тестова стаття', formats: ['ARTICLE'], revision: 1, createdAt: '2026-10-10T10:00:00Z', updatedAt: '2026-10-10T10:00:00Z', archivedAt: null } });
    if (path === `${base}/jobs`) return json({ jobs: [] });
    if (path === `${base}/article` && request.method() === 'GET') return json(state());
    if (path === `${base}/google-docs/binding`) return json({ binding: null });
    if (path === '/api/v1/google-docs/connections') return json({ connections: [{ id: connectionId, displayName: 'Редактор Google', status: 'connected', providerAccess: 'authorized' }] });
    if (path === `${base}/google-docs/create-commands` && request.method() === 'GET') return json({ commands: record ? [record] : [] });
    if (path === `${base}/google-docs/create` && request.method() === 'POST') {
      createCalls++;
      const body = request.postDataJSON() as { connectionId: string; title: string; commandKey: string; expectedArticleRevision: number };
      commands.push({ path, body });
      expect(request.headers()['x-csrf-token']).toBe('csrf');
      expect(body).toMatchObject({ connectionId, title: 'Чернетка перевірки', expectedArticleRevision: 7 });
      expect(body.commandKey).toMatch(/^[0-9a-f-]{36}$/u);
      if (!commandKey) commandKey = body.commandKey;
      if (mode === 'unknown') { record = command('UNKNOWN'); return json({ error: 'Google may have created it' }, 503); }
      if (mode === 'known-failure' && createCalls === 1) return json({ error: 'ACCESS_DENIED' }, 403);
      if (body.commandKey !== commandKey) commandKey = body.commandKey;
      record = command('CREATED');
      return json({ command: record, replayed: false }, 201);
    }
    if (path === `${base}/google-docs/create-commands/${commandId}/reconcile` && request.method() === 'POST') {
      reconcileCalls++;
      const body = request.postDataJSON() as { connectionId: string };
      commands.push({ path, body });
      expect(body).toEqual({ connectionId });
      record = command('CREATED');
      return json({ command: record, replayed: false });
    }
    if (path === `${base}/google-docs/inspect`) {
      const body = request.postDataJSON() as { connectionId: string; documentId: string };
      commands.push({ path, body });
      expect(body).toEqual({ connectionId, documentId });
      return json({ document: { documentId, title: 'Створений документ', revisionId: 'remote-rev-1', tabs: [{ tabId: 't.tab-one', title: 'Перша вкладка' }, { tabId: 't.tab-two', title: 'Друга вкладка' }] } });
    }
    return json({});
  });
  await page.goto(`/projects/${projectId}/article`);
  await expect(page.getByRole('heading', { name: 'Стаття', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Google Документи' }).click();
  await expect(page.getByRole('heading', { name: 'Google Документи' })).toBeVisible();
  await expect(page.getByLabel('Назва документа')).toBeVisible();
  await page.getByLabel('Назва документа').fill('Чернетка перевірки');
  return { article, commands, createCalls: () => createCalls, reconcileCalls: () => reconcileCalls, getRecord: () => record };
}

test('creates a blank document and requires a separate explicit selection', async ({ page }) => {
  const context = await fixture(page, 'success');
  await page.getByRole('button', { name: 'Створити порожній документ' }).click();
  await expect(page.getByText('Документ створено.', { exact: false })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Вибрати створений документ' })).toBeVisible();
  expect(context.article.revision).toBe(7);
  expect(context.article.draft.content.document.content[0]?.content?.[0]?.text).toBe('Поточний текст статті.');
  expect(context.commands.some(item => item.path.endsWith('/article/draft') || item.path.endsWith('/article/checkpoint'))).toBe(false);
  expect(context.commands.some(item => item.path.endsWith('/google-docs/bind'))).toBe(false);

  for (const width of [1280, 390]) {
    await page.setViewportSize({ width, height: 900 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.screenshot({ path: `.local-checks/google-doc-create-${width}.png`, fullPage: true });
  }

  await page.getByRole('button', { name: 'Вибрати створений документ' }).click();
  await expect(page.getByText('Створений документ', { exact: true })).toBeVisible();
  await expect(page.getByLabel('Вкладка документа')).toHaveValue('');
  await expect(page.getByRole('button', { name: 'Прив’язати документ' })).toBeDisabled();
  expect(context.commands.some(item => item.path.endsWith('/google-docs/inspect'))).toBe(true);
  expect(context.commands.some(item => item.path.endsWith('/google-docs/bind'))).toBe(false);
});

test('reconciles an unknown create result without sending a second create command', async ({ page }) => {
  const context = await fixture(page, 'unknown');
  await page.getByRole('button', { name: 'Створити порожній документ' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Google міг створити документ' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Перевірити результат' })).toBeVisible();
  for (const width of [1280, 390]) {
    await page.setViewportSize({ width, height: 900 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.screenshot({ path: `.local-checks/google-doc-create-unknown-${width}.png`, fullPage: true });
  }
  await page.getByRole('button', { name: 'Перевірити результат' }).click();
  await expect(page.getByRole('button', { name: 'Вибрати створений документ' })).toBeVisible();
  expect(context.createCalls()).toBe(1);
  expect(context.reconcileCalls()).toBe(1);
  expect(context.commands.filter(item => item.path.endsWith('/google-docs/create'))).toHaveLength(1);
  expect(context.commands.some(item => item.path.endsWith('/google-docs/bind'))).toBe(false);
  expect(context.article.revision).toBe(7);
  expect((context.commands.find(item => item.path.endsWith('/google-docs/create'))?.body as { commandKey: string }).commandKey).toBe((context.getRecord() as { commandKey: string }).commandKey);
});

test('allows a corrected retry after a definitive access failure with no journaled command', async ({ page }) => {
  const context = await fixture(page, 'known-failure');
  await page.getByRole('button', { name: 'Створити порожній документ' }).click();
  await expect(page.getByRole('alert')).toContainText('Немає доступу');
  await expect(page.getByRole('button', { name: 'Створити порожній документ' })).toBeVisible();
  await page.getByRole('button', { name: 'Створити порожній документ' }).click();
  await expect(page.getByRole('button', { name: 'Вибрати створений документ' })).toBeVisible();
  const attempts = context.commands.filter(item => item.path.endsWith('/google-docs/create'));
  expect(attempts).toHaveLength(2);
  expect((attempts[0]?.body as { commandKey: string }).commandKey).not.toBe((attempts[1]?.body as { commandKey: string }).commandKey);
  expect(context.article.revision).toBe(7);
});
