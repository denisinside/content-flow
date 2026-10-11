import { createHash } from 'node:crypto';
import { test, expect, type Page } from '@playwright/test';

const projectId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const workspaceId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const base = `/api/v1/projects/${projectId}`;
const versionId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const initialText = 'Текст для коментаря.';
const sha256 = createHash('sha256').update(initialText).digest('hex');
type Thread = { id: string; articleVersionId: string; kind: 'COMMENT' | 'SUGGESTION'; status: 'OPEN' | 'RESOLVED' | 'ACCEPTED' | 'REJECTED'; revision: number; quote: string; body: string; replacementText: string | null; resultVersionId: string | null; createdBy: string; createdAt: string; authorName: string; anchor: { status: 'EXACT' | 'UNRESOLVED'; start: number | null; end: number | null }; posts: { id: string; body: string; action: string; createdBy: string; createdAt: string; authorName: string }[] };

async function fixture(page: Page) {
  const content = { title: 'Редакторська стаття', document: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: initialText }] }] } };
  const version = { id: versionId, number: 1, content, contentMode: 'CREATIVE', origin: 'MANUAL', status: 'PROPOSED', sourceArticleRevision: 1, sha256, hasUnmapped: true };
  const article = { id: 'article-1', revision: 1, draft: { baseVersionId: versionId, sha256, content, contentMode: 'CREATIVE', origin: 'MANUAL' }, currentApprovedVersionId: null, versions: [version] };
  const threads: Thread[] = [];
  const commands: { path: string; body: unknown }[] = [];
  let conflictNext = false, unknownCreateNext = false;
  const createKeys: string[] = [];
  const state = () => ({ article, articleSelected: true, eligibleEvidence: [], mappingIssues: [], staleReasons: [], hasUnmapped: true, editorial: { brief: null, outline: { currentApprovedRevisionId: null } } });
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
    if (path === `${base}/article/annotations` && request.method() === 'GET') return json({ threads });
    if (path === `${base}/article/annotations` && request.method() === 'POST') {
      expect(request.headers()['x-csrf-token']).toBe('csrf');
      const body = request.postDataJSON() as { articleVersionId: string; contentHash: string; anchorStart: number; anchorEnd: number; body: string; kind: Thread['kind']; replacementText?: string; commandKey: string };
      expect(body).toMatchObject({ articleVersionId: versionId, contentHash: sha256 });
      createKeys.push(body.commandKey);
      const existing = threads.find(thread => thread.createdBy === 'editor' && (thread as Thread & { commandKey?: string }).commandKey === body.commandKey);
      if (existing) return json({ threads: [existing], replayed: true });
      const thread: Thread = { id: `thread-${threads.length + 1}`, articleVersionId: versionId, kind: body.kind, status: 'OPEN', revision: 0, quote: initialText.slice(body.anchorStart, body.anchorEnd), body: body.body, replacementText: body.replacementText ?? null, resultVersionId: null, createdBy: 'editor', createdAt: '2026-10-11T10:00:00Z', authorName: 'Редактор тесту', anchor: { status: 'EXACT', start: body.anchorStart, end: body.anchorEnd }, posts: [] };
      (thread as Thread & { commandKey?: string }).commandKey = body.commandKey;
      threads.push(thread); commands.push({ path, body });
      if (unknownCreateNext) { unknownCreateNext = false; return json({ error: 'TEMPORARY_RESPONSE_FAILURE' }, 503); }
      return json({ threads: [thread] }, 201);
    }
    const annotationAction = path.match(new RegExp(`^${base}/article/annotations/([^/]+)/(reply|action)$`));
    if (annotationAction && request.method() === 'POST') {
      expect(request.headers()['x-csrf-token']).toBe('csrf');
      if (conflictNext) { conflictNext = false; return json({ error: 'CONFLICT' }, 409); }
      const thread = threads.find(item => item.id === annotationAction[1]);
      if (!thread) return json({ error: 'NOT_FOUND' }, 404);
      const payload = request.postDataJSON() as { expectedRevision: number; body?: string; action?: string };
      if (annotationAction[2] === 'reply') { thread.revision++; thread.posts.push({ id: `post-${thread.revision}`, body: payload.body!, action: 'REPLY', createdBy: 'editor', createdAt: '2026-10-11T10:01:00Z', authorName: 'Редактор тесту' }); }
      else if (payload.action === 'RESOLVE') { thread.revision++; thread.status = 'RESOLVED'; }
      else if (payload.action === 'ACCEPT') {
        thread.revision++; thread.status = 'ACCEPTED'; thread.resultVersionId = 'candidate-1';
        article.versions.unshift({ ...version, id: 'candidate-1', number: 2, content: { title: content.title, document: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Виправлений текст.' }] }] } }, sourceArticleRevision: article.revision });
      }
      else if (payload.action === 'REJECT') { thread.revision++; thread.status = 'REJECTED'; }
      return json({ threads: [thread], ...(payload.action === 'ACCEPT' ? { candidateVersionId: 'candidate-1' } : {}) });
    }
    if (path === `${base}/article/checkpoint` && request.method() === 'POST') { commands.push({ path, body: request.postDataJSON() }); return json(state()); }
    return json({});
  });
  await page.goto(`/projects/${projectId}/article`);
  await expect(page.getByRole('heading', { name: 'Стаття', exact: true })).toBeVisible();
  await expect(page.getByRole('textbox', { name: 'Текст статті' })).toContainText(initialText);
  return { threads, commands, createKeys, conflict: () => { conflictNext = true; }, unknownCreate: () => { unknownCreateNext = true; }, orphan: (id: string) => { const thread = threads.find(item => item.id === id); if (thread) thread.anchor = { status: 'UNRESOLVED', start: null, end: null }; } };
}

async function openForSelectedText(page: Page) {
  await page.getByRole('textbox', { name: 'Текст статті' }).locator('p').selectText();
  await page.getByRole('button', { name: 'Коментарі й правки' }).click();
  await expect(page.getByRole('heading', { name: 'Коментарі й правки' })).toBeVisible();
  await expect(page.getByRole('blockquote').first()).toHaveText(initialText);
}

test('creates a comment, replies, and resolves its thread on an immutable saved version', async ({ page }) => {
  const context = await fixture(page);
  await openForSelectedText(page);
  await page.getByLabel('Коментар', { exact: true }).fill('Перевірити цей фрагмент.');
  await page.getByRole('button', { name: 'Додати коментар' }).click();
  await expect(page.getByText('Редактор тесту', { exact: false }).first()).toBeVisible();
  for (const width of [1280, 768, 390]) {
    await page.setViewportSize({ width, height: 900 });
    await expect(page.getByLabel('Відповісти')).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.screenshot({ path: `.local-checks/article-annotations-${width}.png`, fullPage: true });
  }
  const create = context.commands.find(command => command.path.endsWith('/article/annotations'));
  expect(create?.body).toMatchObject({ kind: 'COMMENT', articleVersionId: versionId, anchorStart: 0, anchorEnd: initialText.length });
  await page.getByLabel('Відповісти').fill('Додав уточнення.');
  await page.getByRole('button', { name: 'Додати відповідь' }).click();
  await expect(page.getByText('Додав уточнення.')).toBeVisible();
  await page.getByRole('button', { name: 'Закрити коментар' }).click();
  await expect(page.getByText('Закрито', { exact: false })).toBeVisible();
});

test('reuses the same create key after an unknown response and retains other threads after mutations', async ({ page }) => {
  const context = await fixture(page);
  await openForSelectedText(page);
  await page.getByLabel('Коментар', { exact: true }).fill('Перший коментар.');
  await page.getByRole('button', { name: 'Додати коментар' }).click();
  await expect(page.getByText('Перший коментар.')).toBeVisible();

  await page.getByLabel('Тип').selectOption('SUGGESTION');
  await page.getByLabel('Коментар', { exact: true }).fill('Друга думка.');
  await page.getByLabel('Запропонований текст').fill('Новий варіант.');
  await page.getByRole('button', { name: 'Додати пропозицію' }).click();
  await expect(page.getByText('Перший коментар.')).toBeVisible();
  await expect(page.getByText('Друга думка.')).toBeVisible();
  expect(context.threads).toHaveLength(2);
  await page.getByLabel('Тип').selectOption('COMMENT');
  await page.getByLabel('Коментар', { exact: true }).fill('Повторити без дубля.');
  context.unknownCreate();
  await page.getByRole('button', { name: 'Додати коментар' }).click();
  await expect(page.getByRole('alert')).toContainText('Не вдалося зберегти');
  await page.getByRole('button', { name: 'Додати коментар' }).click();
  await expect(page.getByText('Повторити без дубля.')).toBeVisible();
  expect(context.createKeys.at(-1)).toBe(context.createKeys.at(-2));
  expect(context.threads).toHaveLength(3);
});

test('keeps an entered suggestion and comment form text after a revision conflict', async ({ page }) => {
  const context = await fixture(page);
  await openForSelectedText(page);
  await page.getByLabel('Тип').selectOption('SUGGESTION');
  await page.getByLabel('Коментар', { exact: true }).fill('Можна точніше.');
  await page.getByLabel('Запропонований текст').fill('Текст із редакторською правкою.');
  await page.getByRole('button', { name: 'Додати пропозицію' }).click();
  await expect(page.getByText('Текст із редакторською правкою.')).toBeVisible();
  context.conflict();
  await page.getByRole('button', { name: 'Створити версію з правкою' }).click();
  await expect(page.getByRole('alert')).toContainText('змінився');
  await expect(page.getByRole('textbox', { name: 'Текст статті' })).toContainText(initialText);
  await expect(page.getByText('Текст із редакторською правкою.')).toBeVisible();
});

test('keeps an unresolved open suggestion visible with reply and reject actions', async ({ page }) => {
  const context = await fixture(page);
  await openForSelectedText(page);
  await page.getByLabel('Тип').selectOption('SUGGESTION');
  await page.getByLabel('Коментар', { exact: true }).fill('Потрібне уточнення.');
  await page.getByLabel('Запропонований текст').fill('Нова редакція.');
  await page.getByRole('button', { name: 'Додати пропозицію' }).click();
  context.orphan('thread-1');
  await page.reload();
  await page.getByRole('button', { name: 'Коментарі й правки' }).click();
  await expect(page.getByText('Цей фрагмент не вдалося зіставити')).toBeVisible();
  await expect(page.getByLabel('Відповісти')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Створити версію з правкою' })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Відхилити' })).toBeEnabled();
});

test('accepts a suggestion into a candidate and leaves manual article text unchanged until explicit apply', async ({ page }) => {
  await fixture(page);
  await openForSelectedText(page);
  await page.getByLabel('Тип').selectOption('SUGGESTION');
  await page.getByLabel('Коментар', { exact: true }).fill('Уточнити формулювання.');
  await page.getByLabel('Запропонований текст').fill('Виправлений текст.');
  await page.getByRole('button', { name: 'Додати пропозицію' }).click();
  await page.getByRole('button', { name: 'Створити версію з правкою' }).click();
  await expect(page.getByRole('heading', { name: 'Пропозиція правки' })).toBeVisible();
  await expect(page.getByText('Виправлений текст.', { exact: true })).toBeVisible();
  await expect(page.getByRole('textbox', { name: 'Текст статті' })).toContainText(initialText);
  await expect(page.getByRole('button', { name: 'Застосувати до чернетки' })).toBeEnabled();
});
