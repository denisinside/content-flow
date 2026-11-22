import { mkdirSync } from 'node:fs';
import { test, expect, type Page } from '@playwright/test';

const id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const workspaceId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const base = `/api/v1/projects/${id}`;
const artifacts = '.codex/artifacts/m31';
type Content = { title: string; sections: { title: string; purpose: string; claimRevisionIds: string[] }[] };
type Brief = { id: string; number: number; contentMode: string; topic: string; audience: string; centralMessage: string; category: string; tone: string; targetLength: number; cta: string; exclusions: string[]; notes: string; requiredClaimRevisionIds: string[]; contextSnapshots: object };
type Outline = { id: string; number: number; briefRevisionId: string; origin: string; status: string; content: Content };
async function fixture(page: Page, article: boolean) {
  let brief: Brief | null = null;
  let current: Outline | null = null;
  const history: Brief[] = [];
  const revisions: Outline[] = [];
  let briefConflict = false;
  const jobs: { id: string; operation: string; status: string; progressStage: string; retryAllowed: boolean }[] = [];
  const state = () => ({ brief: brief ? { revision: history.length, currentRevision: brief, history } : null, outline: revisions.length ? { revision: revisions.length, currentRevision: current, currentApprovedRevisionId: current?.status === 'APPROVED' ? current.id : null, revisions } : null, style: { revision: 3, tone: 'Спокійний і точний', brandbook: '', settings: {} }, articleSelected: article, prerequisites: { eligibleClaims: [], missingBasis: true, unverified: true, blockingReasons: ['MISSING_BASIS'] } });
  await page.route('**/api/**', async route => {
    const req = route.request();
    const path = new URL(req.url()).pathname;
    const json = (body: unknown, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    if (path === '/api/auth/session') return json({ authenticated: true, csrfToken: 'fixture-csrf', user: { id: 'fixture-user', email: 'test@example.test', displayName: 'Редактор' } });
    if (path === '/api/auth/preferences') return json({ preferences: { idleTimeoutMinutes: 60 } });
    if (path === '/api/auth/external-processing') return json({ notice: { version: '1', text: 'Тестова згода' }, accepted: true, acceptedAt: null });
    if (path === '/api/auth/activity') return json({ authenticated: true });
    const workspace = { id: workspaceId, ownerId: 'fixture-user', name: 'Редакційний простір', archivedAt: null, members: [] };
    if (path === '/api/v1/workspaces') return json({ workspaces: [workspace], nextCursor: null });
    if (path === `/api/v1/workspaces/${workspaceId}`) return json({ workspace });
    if (path === base) return json({ project: { id, workspaceId, topic: 'Міська мобільність', formats: article ? ['ARTICLE', 'TELEGRAM_POST'] : ['TELEGRAM_POST'], revision: 1, createdAt: '2026-10-05T12:00:00Z', updatedAt: '2026-10-05T12:00:00Z', archivedAt: null } });
    if (path === `${base}/editorial`) return json(state());
    if (path === `${base}/jobs`) return json({ jobs });
    if (req.method() === 'POST') expect(req.headers()['x-csrf-token']).toBe('fixture-csrf');
    if (path === `${base}/brief`) {
      if (briefConflict) return json({ error: 'CONFLICT' }, 409);
      const body = req.postDataJSON() as Omit<Brief, 'id' | 'number' | 'contextSnapshots'>;
      brief = { ...body, id: `brief-${history.length + 1}`, number: history.length + 1, contextSnapshots: { style: { revision: 3, tone: body.tone } } };
      history.unshift(brief); return json(state());
    }
    if (path === `${base}/outline/manual`) {
      const body = req.postDataJSON() as { content: Content; briefRevisionId: string };
      expect(body.briefRevisionId).toBe(brief?.id);
      current = { id: `outline-${revisions.length + 1}`, number: revisions.length + 1, briefRevisionId: body.briefRevisionId, origin: 'MANUAL', status: 'PROPOSED', content: body.content };
      revisions.unshift(current); return json(state());
    }
    if (path.endsWith('/cancel')) { jobs[0]!.status = 'CANCELLED'; return json({ job: jobs[0] }); }
    if (path.endsWith('/retry')) { jobs[0]!.status = 'QUEUED'; jobs[0]!.retryAllowed = false; return json({ job: jobs[0] }); }
    if (path === `${base}/outline/generate`) { jobs.push({ id: 'generation-job', operation: 'OUTLINE_GENERATION', status: 'QUEUED', progressStage: 'WAITING', retryAllowed: false }); return json(state()); }
    if (path.endsWith('/approve')) { current!.status = 'APPROVED'; return json(state()); }
    if (path.endsWith('/apply')) { current = revisions.find(item => path.includes(item.id))!; return json(state()); }
    return json({});
  });
  await page.goto(`/projects/${id}/brief`);
  await expect(page.getByRole('heading', { name: 'Бриф', exact: true })).toBeVisible();
  return { failJob: () => { jobs[0]!.status = 'FAILED'; jobs[0]!.retryAllowed = true; }, setConflict: () => { briefConflict = true; }, candidate: () => { revisions.unshift({ id: 'ai-candidate', number: revisions.length + 1, briefRevisionId: brief!.id, origin: 'AI', status: 'PROPOSED', content: { title: 'Пропозиція заголовка AI', sections: [{ title: 'Пропозиція розділу', purpose: 'Нова пропозиція', claimRevisionIds: [] }] } }); } };
}
async function fillBrief(page: Page) {
  await page.getByLabel('Аудиторія', { exact: true }).fill('Мешканці міста');
  await page.getByLabel('Головне повідомлення').fill('Безпечний транспорт робить місто доступнішим.');
  await page.getByLabel('Творчий матеріал', { exact: true }).check();
  await page.getByLabel('Авторські нотатки').fill('Сцена ранкової поїздки.');
  await page.getByRole('button', { name: 'Зберегти бриф', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Зберегти бриф', exact: true })).toBeDisabled();
}

test('channel-only brief saves explicit mode and survives reload; conflict preserves local text', async ({ page }) => {
  const context = await fixture(page, false);
  await expect(page.getByText(/Немає придатної затвердженої/)).toBeVisible();
  await expect(page.getByLabel('Тон', { exact: true })).toHaveValue('Спокійний і точний');
  await expect(page.getByRole('heading', { name: 'Структура статті' })).toHaveCount(0);
  await fillBrief(page);
  await page.reload();
  await expect(page.getByLabel('Авторські нотатки')).toHaveValue('Сцена ранкової поїздки.');
  await expect(page.getByText(/Без перевіреної фактологічної/)).toBeVisible();
  context.setConflict();
  await page.getByLabel('Авторські нотатки').fill('Ручна правка, яку потрібно зберегти.');
  await page.getByRole('button', { name: 'Зберегти бриф', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('Ваш текст збережено у формі');
  await expect(page.getByLabel('Авторські нотатки')).toHaveValue('Ручна правка, яку потрібно зберегти.');
});

test('manual article structure approves exact revision; late AI remains an explicit proposal', async ({ page }) => {
  const context = await fixture(page, true);
  await fillBrief(page);
  await page.getByRole('button', { name: 'Додати розділ' }).click();
  await page.getByLabel('Назва розділу', { exact: true }).fill('Поїздка містом');
  await page.getByLabel('Про що цей розділ', { exact: true }).fill('Показати щоденний досвід мешканця.');
  await page.getByRole('button', { name: 'Зберегти план', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Схвалити план', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: 'Схвалити план', exact: true }).click();
  await expect(page.getByText('План схвалено', { exact: true })).toBeVisible();
  context.candidate();
  await page.reload();
  await expect(page.getByLabel('Назва розділу', { exact: true })).toHaveValue('Поїздка містом');
  await page.getByText('Пропозиція AI · Не застосовано', { exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Пропозиція заголовка AI', exact: true })).toBeVisible();
  await page.locator('.outline-edit > summary').click();
  await page.getByLabel('Назва розділу', { exact: true }).fill('Незбережений ручний розділ');
  await expect(page.getByRole('button', { name: 'Застосувати план', exact: true })).toBeDisabled();
  mkdirSync(artifacts, { recursive: true });
  for (const width of [1440, 1280, 768, 390]) {
    await page.setViewportSize({ width, height: 900 });
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: `${artifacts}/brief-${width}.png`, fullPage: true });
  }
  await page.getByLabel('Заголовок статті', { exact: true }).focus();
  await page.keyboard.press('Tab');
  await expect(page.getByRole('button', { name: 'Видалити розділ 1' })).toBeFocused();
});


test('outline generation waits for factual prerequisites and exposes retry and cancellation without changing manual work', async ({ page }) => {
  const context = await fixture(page, true);
  await expect(page.getByRole('button', { name: 'Запропонувати план' })).toBeDisabled();
  await fillBrief(page);
  await page.getByRole('button', { name: 'Додати розділ' }).click();
  await page.getByLabel('Назва розділу', { exact: true }).fill('Ручний розділ');
  await page.getByLabel('Про що цей розділ', { exact: true }).fill('Ручний зміст має залишитися.');
  await page.getByLabel('Авторські нотатки').fill('Нові нотатки для брифу.');
  await page.getByRole('button', { name: 'Зберегти бриф', exact: true }).click();
  await expect(page.getByLabel('Назва розділу', { exact: true })).toHaveValue('Ручний розділ');
  await page.getByRole('button', { name: 'Запропонувати план' }).click();
  await expect(page.getByText('Очікує обробки', { exact: true })).toBeVisible();
  context.failJob();
  await expect(page.getByText('Не вдалося створити план', { exact: true })).toBeVisible({ timeout: 8000 });
  await expect(page.getByLabel('Назва розділу', { exact: true })).toHaveValue('Ручний розділ');
  await page.getByRole('button', { name: 'Повторити спробу' }).click();
  await expect(page.getByText('Очікує обробки', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Скасувати генерацію' }).click();
  await expect(page.getByText('Генерацію скасовано', { exact: true })).toBeVisible();
  await expect(page.getByLabel('Про що цей розділ', { exact: true })).toHaveValue('Ручний зміст має залишитися.');
});
