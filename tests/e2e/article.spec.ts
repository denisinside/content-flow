import { mkdirSync } from 'node:fs';
import { test, expect, type Page } from '@playwright/test';

const id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const workspaceId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const base = `/api/v1/projects/${id}`;
type Content = { title: string; document: { type: string; content: unknown[] } };
type Version = { id: string; number: number; sourceArticleRevision: number; status: string; origin: string; content: Content; contentMode: string; hasUnmapped: boolean };
async function fixture(page: Page, selected = true) {
  let article: { id: string; revision: number; draft: { content: Content; contentMode: string; origin: string; baseVersionId: string | null }; currentApprovedVersionId: string | null; versions: Version[] } | null = null;
  let failSave = false, delaySave = false;
  const submitted: Content[] = [];
  const state = () => ({ article, articleSelected: selected, eligibleEvidence: [], mappingIssues: [], staleReasons: [], hasUnmapped: true, editorial: { brief: null, outline: { currentApprovedRevisionId: 'approved-outline' } } });
  await page.route('**/api/**', async route => {
    const request = route.request(), path = new URL(request.url()).pathname;
    const json = (body: unknown, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    if (path === '/api/auth/session') return json({ authenticated: true, csrfToken: 'csrf', user: { id: 'editor', email: 'test@example.test', displayName: 'Редактор' } });
    if (path === '/api/auth/preferences') return json({ preferences: { idleTimeoutMinutes: 60 } });
    if (path === '/api/auth/external-processing') return json({ notice: { version: '1', text: 'Тестова згода' }, accepted: true });
    if (path === '/api/auth/activity') return json({ authenticated: true });
    if (path === '/api/auth/logout') return json({ authenticated: false });
    const workspace = { id: workspaceId, ownerId: 'editor', name: 'Редакція', archivedAt: null, members: [] };
    if (path === '/api/v1/workspaces') return json({ workspaces: [workspace], nextCursor: null });
    if (path === `/api/v1/workspaces/${workspaceId}`) return json({ workspace });
    if (path === base) return json({ project: { id, workspaceId, topic: 'Транспорт щодня', formats: selected ? ['ARTICLE'] : ['TELEGRAM_POST'], revision: 1, createdAt: '2026-10-06T10:00:00Z', updatedAt: '2026-10-06T10:00:00Z', archivedAt: null } });
    if (path === `${base}/article` && request.method() === 'GET') return json(state());
    if (path === `${base}/jobs`) return json({ jobs: [] });
    if (request.method() === 'POST') expect(request.headers()['x-csrf-token']).toBe('csrf');
    if (path === `${base}/article/draft` || path === `${base}/article/import`) {
      const body = request.postDataJSON() as { expectedRevision: number; content: Content; contentMode: string };
      if (failSave || body.expectedRevision !== (article?.revision ?? 0)) return json({ error: 'CONFLICT' }, 409);
      submitted.push(body.content);
      const old = article;
      article = { id: 'article', revision: (old?.revision ?? 0) + 1, draft: { content: body.content, contentMode: body.contentMode, origin: path.endsWith('/import') ? 'UNVERIFIED_IMPORTED' : 'MANUAL', baseVersionId: null }, currentApprovedVersionId: old?.currentApprovedVersionId ?? null, versions: old?.versions ?? [] };
      const captured = JSON.parse(JSON.stringify(state()));
      if (delaySave) { delaySave = false; await new Promise(resolve => setTimeout(resolve, 900)); }
      return json(captured);
    }
    if (path === `${base}/article/checkpoint`) { const version: Version = { id: `v${article!.versions.length + 1}`, number: article!.versions.length + 1, sourceArticleRevision: article!.revision, content: structuredClone(article!.draft.content), contentMode: article!.draft.contentMode, origin: article!.draft.origin, status: 'PROPOSED', hasUnmapped: true }; article!.versions.unshift(version); article!.draft.baseVersionId = version.id; article!.revision++; return json(state()); }
    if (path.endsWith('/approve')) { const version = article!.versions.find(item => path.includes(`/${item.id}/`))!; version.status = 'APPROVED'; article!.currentApprovedVersionId = version.id; article!.revision++; return json(state()); }
    if (path.endsWith('/withdraw')) { const version = article!.versions.find(item => path.includes(`/${item.id}/`))!; version.status = 'WITHDRAWN'; article!.currentApprovedVersionId = null; article!.revision++; return json(state()); }
    return json({});
  });
  await page.goto(`/projects/${id}/article`);
  await expect(page.getByRole('heading', { name: 'Стаття', exact: true })).toBeVisible();
  if (selected) await expect(page.getByRole('textbox', { name: 'Текст статті' })).toBeVisible();
  return { submitted, conflict: () => { failSave = true; }, delay: () => { delaySave = true; }, state, candidate: () => { article!.versions.unshift({ id: 'candidate', number: article!.versions.length + 1, sourceArticleRevision: article!.revision, content: { title: 'AI заголовок', document: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'AI пропозиція для порівняння.' }] }] } }, contentMode: 'CREATIVE', origin: 'AI', status: 'PROPOSED', hasUnmapped: true }); } };
}
const writing = (page: Page) => page.getByRole('textbox', { name: 'Текст статті' });

test('autosave acknowledges exact submitted text and coalesces later edits; approved history survives a new draft', async ({ page }) => {
  const context = await fixture(page);
  context.delay();
  await writing(page).fill('Перша редакторська думка.');
  await expect(page.getByText('Зберігаємо…', { exact: true })).toBeVisible();
  await writing(page).fill('Нова думка, введена під час збереження.');
  await expect(page.getByText('Збережено', { exact: true })).toBeVisible();
  await expect.poll(() => context.submitted.length).toBe(2);
  await expect(writing(page)).toContainText('Нова думка, введена під час збереження.');
  await page.reload();
  await expect(writing(page)).toContainText('Нова думка, введена під час збереження.');
  await page.getByRole('button', { name: 'Зберегти версію' }).click();
  await page.getByRole('button', { name: 'Історія версій' }).click();
  await page.getByLabel('Переглянув твердження без посилань').check();
  await page.getByRole('button', { name: 'Погодити версію 1', exact: true }).click();
  await expect(page.getByText('Погоджено · Версія 1.', { exact: false })).toBeVisible();
  await writing(page).fill('Окрема нова редакторська чернетка.');
  await expect(page.getByText('Збережено', { exact: true })).toBeVisible();
  expect(context.state().article!.versions[0]!.content.document).toEqual(context.submitted[1]!.document);
  await expect(writing(page)).toContainText('Окрема нова редакторська чернетка.');
});

test('conflict retains text across reload and session recovery; late AI candidate requires explicit comparison', async ({ page }) => {
  const context = await fixture(page);
  await writing(page).fill('Початкова редакторська думка.');
  await expect(page.getByText('Збережено', { exact: true })).toBeVisible();
  context.candidate(); context.conflict();
  await writing(page).fill('Незбережені слова, які не можна втратити.');
  await expect(page.getByRole('alert')).toContainText('Ваш текст залишився');
  await page.reload();
  await page.getByRole('button', { name: 'Відновити мою чернетку' }).click();
  await expect(writing(page)).toContainText('Незбережені слова, які не можна втратити.');
  await page.getByRole('button', { name: 'Переглянути пропозицію AI · Не застосовано' }).click();
  await expect(page.getByText('AI пропозиція для порівняння.', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Застосувати до чернетки' })).toBeDisabled();
  mkdirSync('.codex/artifacts/m32', { recursive: true });
  for (const width of [1440, 1280, 768, 390]) { await page.setViewportSize({ width, height: 900 }); await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true); await page.screenshot({ path: `.codex/artifacts/m32/article-conflict-proposal-${width}.png`, fullPage: true }); }
});

test('ready article imports without outline, remains unverified and permits keyboard formatting', async ({ page }) => {
  const context = await fixture(page);
  await page.getByRole('button', { name: 'Додати готову статтю' }).click();
  await page.getByLabel('Готовий текст').fill('Ранкова поїздка починається з кроку.\n\nМісто поступово прокидається.');
  await page.getByRole('button', { name: 'Додати як чернетку' }).click();
  await expect(page.getByText(/Готова стаття · Не перевірено/)).toBeVisible();
  expect(context.state().article?.draft.origin).toBe('UNVERIFIED_IMPORTED');
  await writing(page).focus(); await page.keyboard.press('ControlOrMeta+a'); await page.keyboard.press('ControlOrMeta+b');
  await expect(page.getByRole('button', { name: 'Жирний', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(writing(page).locator('strong').first()).toContainText('Ранкова поїздка');
  await expect(page.getByText('Збережено', { exact: true })).toBeVisible();
  for (const width of [1440, 1280, 768, 390]) { await page.setViewportSize({ width, height: 900 }); await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true); await page.screenshot({ path: `.codex/artifacts/m32/article-ready-saved-${width}.png`, fullPage: true }); }
});

test('channels-only route shows historical boundary without creating an article', async ({ page }) => {
  const context = await fixture(page, false);
  await expect(page.getByText(/Статтю не вибрано/)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Зберегти версію' })).toHaveCount(0);
  expect(context.state().article).toBeNull();
  expect(context.submitted).toHaveLength(0);
});

test('logout erases unsaved recovery and unmount does not recreate the prior user text', async ({ page }) => {
  const context = await fixture(page);
  context.conflict();
  await writing(page).fill('Особистий незбережений текст попереднього користувача.');
  await expect(page.getByRole('alert')).toContainText('Ваш текст залишився');
  expect(await page.evaluate(() => sessionStorage.getItem('cf:article:editor:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'))).toContain('Особистий');
  await page.locator('#account-title').click();
  await page.getByRole('button', { name: 'Вийти', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Реєстрація' })).toBeVisible();
  expect(await page.evaluate(() => sessionStorage.getItem('cf:article:editor:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'))).toBeNull();
  await expect(writing(page)).toHaveCount(0);
});
