import { mkdirSync } from 'node:fs';
import { test, expect, type Page, type Route } from '@playwright/test';

const projectId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const workspaceId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const base = `/api/v1/projects/${projectId}`;
const future = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
const screenshotDir = '.local-checks/m43';
const json = (route: Route, value: unknown, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(value) });
interface FixtureProject {
  id: string; workspaceId: string; topic: string; formats: string[]; revision: number;
  createdAt: string; updatedAt: string; archivedAt: string | null; trashedAt: string | null;
  purgeAfter: string | null; canPurge: boolean;
}

async function captureAtWidths(page: Page, name: string) {
  mkdirSync(screenshotDir, { recursive: true });
  for (const width of [1280, 768, 390]) {
    await page.setViewportSize({ width, height: 900 });
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: `${screenshotDir}/${name}-${width}.png`, fullPage: true });
  }
  await page.setViewportSize({ width: 1280, height: 900 });
}

async function fixture(page: Page) {
  const project: FixtureProject = {
    id: projectId, workspaceId, topic: 'Міський транспорт', formats: ['ARTICLE'], revision: 1,
    createdAt: '2026-10-12T08:00:00Z', updatedAt: '2026-10-12T08:00:00Z', archivedAt: null,
    trashedAt: null, purgeAfter: null, canPurge: true,
  };
  const workspace = {
    id: workspaceId, name: 'Редакція', ownerId: 'editor', archivedAt: null, trashedAt: null,
    purgeAfter: null, lifecycleRevision: 1, members: [{ userId: 'editor', displayName: 'Редактор' }],
  };
  const workspaces = [structuredClone(workspace),
    { ...structuredClone(workspace), id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', name: 'Архівований простір', archivedAt: '2026-10-10T08:00:00Z' },
    { ...structuredClone(workspace), id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', name: 'Простір у кошику', trashedAt: '2026-10-11T08:00:00Z', purgeAfter: future },
  ];
  const style = { revision: 1, brandbook: '', tone: '', settings: {} as Record<string, string | number | boolean> };
  const presenceCalls: Array<{ method: string; page?: string; clientId?: string }> = [];
  let conflictNextStyle = false;

  await page.route('**/api/**', async route => {
    const request = route.request(), url = new URL(request.url()), path = url.pathname;
    if (path === '/api/auth/session') return json(route, { authenticated: true, csrfToken: 'csrf', user: { id: 'editor', email: 'editor@example.test', displayName: 'Редактор' } });
    if (path === '/api/auth/preferences') return json(route, { preferences: { idleTimeoutMinutes: 60 } });
    if (path === '/api/auth/external-processing') return json(route, { notice: { version: '1', text: 'Тестова згода' }, accepted: true });
    if (path === '/api/auth/activity') return json(route, { authenticated: true });
    if (path === '/api/v1/workspaces') return json(route, { workspaces: structuredClone(workspaces), nextCursor: null });
    if (path === `/api/v1/workspaces/${workspaceId}`) return json(route, { workspace: structuredClone(workspace) });
    if (path === `/api/v1/workspaces/${workspaceId}/style` && request.method() === 'GET') return json(route, { style: structuredClone(style) });
    if (path === `/api/v1/workspaces/${workspaceId}/style` && request.method() === 'PATCH') {
      const body = request.postDataJSON() as { expectedRevision: number; brandbook: string; tone: string; settings: Record<string, string | number | boolean> };
      if (conflictNextStyle) {
        conflictNextStyle = false;
        style.revision++;
        style.brandbook = 'Оновлена серверна версія';
        return json(route, { message: 'stale' }, 409);
      }
      if (body.expectedRevision !== style.revision) return json(route, { message: 'stale' }, 409);
      style.revision++;
      style.brandbook = body.brandbook;
      style.tone = body.tone;
      style.settings = body.settings;
      return json(route, { style: structuredClone(style) });
    }
    if (path === '/api/v1/projects') {
      const state = url.searchParams.get('state') ?? 'ACTIVE';
      const matches = state === 'TRASHED' ? !!project.trashedAt : state === 'ARCHIVED' ? !!project.archivedAt && !project.trashedAt : !project.archivedAt && !project.trashedAt;
      return json(route, { projects: matches ? [structuredClone(project)] : [], nextCursor: null });
    }
    if (path === base && request.method() === 'GET') return json(route, { project: structuredClone(project) });
    if (path === `${base}/presence`) {
      const body = request.method() === 'GET' ? {} : request.postDataJSON() as { page?: string; clientId?: string };
      const pageName = request.method() === 'GET' ? url.searchParams.get('page') ?? undefined : body.page;
      presenceCalls.push({
        method: request.method(),
        ...(pageName === undefined ? {} : { page: pageName }),
        ...(body.clientId === undefined ? {} : { clientId: body.clientId }),
      });
      return request.method() === 'GET'
        ? json(route, { page: pageName, people: pageName === 'outline' ? [{ userId: 'colleague', displayName: 'Колега' }] : [], ttlSeconds: 60 })
        : json(route, { ok: true });
    }
    if (path.startsWith(`${base}/`) && request.method() === 'POST') {
      const action = path.slice(base.length + 1);
      const body = request.postDataJSON() as { expectedRevision?: number };
      if (body.expectedRevision !== project.revision) return json(route, { message: 'stale' }, 409);
      project.revision++;
      if (action === 'trash') { project.trashedAt = new Date().toISOString(); project.purgeAfter = future; }
      if (action === 'archive') project.archivedAt = new Date().toISOString();
      if (action === 'restore') { project.trashedAt = null; project.purgeAfter = null; }
      if (action === 'purge') project.trashedAt = new Date().toISOString();
      return json(route, { project: structuredClone(project) });
    }
    return json(route, {});
  });
  return { project, presenceCalls, causeStyleConflict: () => { conflictNextStyle = true; } };
}

test('project trash blocks editing, enforces retention and restores an archived project to its prior state', async ({ page }) => {
  const { project } = await fixture(page);
  await page.goto(`/projects/${projectId}`);
  await expect(page.getByRole('heading', { name: project.topic })).toBeVisible();
  await page.getByRole('button', { name: 'До архіву' }).click();
  await expect(page.getByRole('button', { name: 'Архів', exact: true })).toHaveAttribute('aria-current', 'page');
  await expect(page.getByRole('link', { name: project.topic })).toBeVisible();
  await page.once('dialog', dialog => dialog.accept());
  await page.getByRole('button', { name: 'Перемістити в кошик', exact: true }).click();
  await expect(page).toHaveURL(/\/projects$/);
  await expect(page.getByRole('button', { name: 'Кошик' })).toHaveAttribute('aria-current', 'page');
  await expect(page.getByText(project.topic, { exact: true })).toBeVisible();
  await expect(page.getByRole('link', { name: project.topic })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Видалити остаточно' })).toBeDisabled();
  await captureAtWidths(page, 'project-trash');
  await page.getByRole('button', { name: 'Відновити' }).click();
  await expect(page.getByRole('button', { name: 'Архів', exact: true })).toHaveAttribute('aria-current', 'page');
  await expect(page.getByRole('link', { name: project.topic })).toBeVisible();
});

test('editor presence leaves one page before entering another and does not show on the source page', async ({ page }) => {
  const { presenceCalls } = await fixture(page);
  await page.goto(`/projects/${projectId}`);
  await expect.poll(() => presenceCalls.some(call => call.method === 'POST' && call.page === 'outline')).toBe(true);
  await expect(page.getByText('Також тут: Колега')).toBeVisible();
  const firstClient = presenceCalls.find(call => call.method === 'POST' && call.page === 'outline')?.clientId;
  await page.getByRole('link', { name: 'Джерела' }).click();
  await expect(page).toHaveURL(new RegExp(`/projects/${projectId}/sources$`));
  await expect.poll(() => presenceCalls.some(call => call.method === 'DELETE' && call.page === 'outline')).toBe(true);
  await expect.poll(() => page.locator('.editor-presence').count()).toBe(0);
  await page.locator('.project-navigation-title').click();
  await expect(page).toHaveURL(new RegExp(`/projects/${projectId}$`));
  await expect.poll(() => presenceCalls.filter(call => call.method === 'POST' && call.page === 'outline').length).toBe(2);
  const lastClient = presenceCalls.filter(call => call.method === 'POST' && call.page === 'outline').at(-1)?.clientId;
  expect(lastClient).toBeTruthy();
  expect(lastClient).not.toBe(firstClient);
});

test('workspace settings save one shared text brandbook revision', async ({ page }) => {
  const { causeStyleConflict } = await fixture(page);
  await page.goto('/projects');
  await page.getByText('Міський транспорт', { exact: true }).waitFor();
  await page.getByText('Редактор', { exact: true }).first().click();
  await page.getByRole('link', { name: 'Налаштування профілю' }).click();
  await expect(page).toHaveURL(/\/settings$/);
  const brandbook = page.getByRole('textbox', { name: 'Брендбук', exact: true });
  await expect(brandbook).toBeVisible();
  await brandbook.fill('Назву бренду пишемо без скорочень.');
  await captureAtWidths(page, 'workspace-settings-recovery');
  causeStyleConflict();
  await page.getByRole('button', { name: 'Зберегти для всіх проєктів' }).click();
  await expect(page.getByRole('button', { name: 'Завантажити нову версію й залишити мої зміни' })).toBeVisible();
  await expect(brandbook).toHaveValue('Назву бренду пишемо без скорочень.');
  await page.getByRole('button', { name: 'Завантажити нову версію й залишити мої зміни' }).click();
  await expect(brandbook).toHaveValue('Назву бренду пишемо без скорочень.');
  await page.getByRole('button', { name: 'Зберегти для всіх проєктів' }).click();
  await expect(page.getByText('Збережено версію 3.')).toBeVisible();
  await page.getByRole('combobox', { name: 'Поточний простір' }).click();
  await page.getByRole('option', { name: 'Простір у кошику' }).click();
  await expect(page.getByText('Відновіть простір, щоб відкрити брендбук.')).toBeVisible();
  await expect(page.getByRole('textbox', { name: 'Брендбук', exact: true })).toHaveCount(0);
});
