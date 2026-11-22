import { mkdirSync } from 'node:fs';
import { test, expect, type Page, type Route } from '@playwright/test';

const projectId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const workspaceId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const base = `/api/v1/projects/${projectId}`;
const article = { format: 'ARTICLE', title: 'Ранкова поїздка', revisionId: 'article-v1', number: 1, reviewCounter: 0, contentMode: 'FACTUAL', ready: true, reasons: [] } as const;
const telegram = { format: 'TELEGRAM_POST', title: 'Короткий допис', revisionId: 'telegram-v1', number: 1, reviewCounter: 0, contentMode: 'CREATIVE', ready: true, reasons: [] } as const;
type Item = typeof article | typeof telegram | { format: string; title: string; revisionId: string | null; number: number | null; reviewCounter: number | null; contentMode: 'FACTUAL' | 'CREATIVE' | null; ready: boolean; reasons: string[] };
type ExportRow = { id: string; format: 'TXT' | 'MARKDOWN' | 'ZIP'; status: 'REQUESTED' | 'BUILDING' | 'READY' | 'FAILED' | 'CANCELLED' | 'OBSOLETE'; createdAt: string; jobId: string; retryAllowed: boolean; errorCategory: string | null; filename: string | null };
type Data = { projectRevision: number; ready: boolean; items: Item[]; exports: ExportRow[] };
type Command = { expectedProjectRevision: number; commandKey: string; format: string; items: { format: string; revisionId: string; reviewCounter: number }[] };

function json(route: Route, body: unknown, status = 200) { return route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) }); }
async function fixture(page: Page, initial: Data, historyFails = false) {
  let data = structuredClone(initial);
  let staleOnce = false;
  let downloadDenied = true;
  let rejectNextRead = false;
  let readinessReads = 0;
  const commands: Command[] = [];
  const jobs: { action: string; jobId: string }[] = [];
  const projectFormats = initial.items.map(row => row.format);
  await page.route('**/api/**', async route => {
    const request = route.request(), url = new URL(request.url()), path = url.pathname;
    if (path === '/api/auth/session') return json(route, { authenticated: true, csrfToken: 'csrf', user: { id: 'editor', email: 'test@example.test', displayName: 'Редактор' } });
    if (path === '/api/auth/preferences') return json(route, { preferences: { idleTimeoutMinutes: 60 } });
    if (path === '/api/auth/external-processing') return json(route, { notice: { version: '1', text: 'Тестова згода' }, accepted: true });
    if (path === '/api/auth/activity') return json(route, { authenticated: true });
    if (path === '/api/auth/logout') return json(route, { authenticated: false });
    const workspace = { id: workspaceId, ownerId: 'editor', name: 'Редакція', archivedAt: null, members: [] };
    if (path === '/api/v1/workspaces') return json(route, { workspaces: [workspace], nextCursor: null });
    if (path === `/api/v1/workspaces/${workspaceId}`) return json(route, { workspace });
    if (path === base) return json(route, { project: { id: projectId, workspaceId, topic: 'Міські поїздки', formats: projectFormats, revision: 1, createdAt: '2026-10-10T10:00:00Z', updatedAt: '2026-10-10T10:00:00Z', archivedAt: null } });
    if (path === `${base}/exports` && request.method() === 'GET') {
      readinessReads++;
      if (historyFails && url.searchParams.get('view') === 'history') return json(route, {}, 503);
      if (rejectNextRead) { rejectNextRead = false; return json(route, { error: 'UNAVAILABLE' }, 503); }
      return json(route, url.searchParams.get('view') === 'items' ? { ...data, exports: [] }
        : url.searchParams.get('view') === 'history' ? { ...data, items: [] } : data);
    }
    if (path === `${base}/exports` && request.method() === 'POST') {
      expect(request.headers()['x-csrf-token']).toBe('csrf');
      const body = request.postDataJSON() as Command; commands.push(body);
      if (staleOnce) { staleOnce = false; data = { ...data, projectRevision: data.projectRevision + 1, items: data.items.map(item => item.format === 'TELEGRAM_POST' ? { ...item, revisionId: 'telegram-v2', number: 2, ready: false, reasons: ['STALE_REVIEW'] } : item) }; return json(route, { error: 'CONFLICT' }, 409); }
      data = { ...data, exports: [{ id: 'export-new', format: body.format as ExportRow['format'], status: 'BUILDING', createdAt: '2026-10-10T10:30:00Z', jobId: 'job-new', retryAllowed: false, errorCategory: null, filename: null }, ...data.exports] };
      return json(route, { exportId: 'export-new', jobId: 'job-new' }, 202);
    }
    if (path === `${base}/exports/export-ready/download`) return downloadDenied
      ? route.fulfill({ status: 403, contentType: 'application/json', body: JSON.stringify({ error: 'DENIED' }) })
      : route.fulfill({ status: 200, contentType: 'text/markdown; charset=utf-8', headers: { 'Content-Disposition': "attachment; filename*=UTF-8''Telegram%20%D0%B4%D0%BE%D0%BF%D0%B8%D1%81.md" }, body: Buffer.from('Текст Telegram.\n', 'utf8') });
    const jobMatch = path.match(new RegExp(`^${base}/jobs/([^/]+)/(retry|cancel)$`));
    if (jobMatch && request.method() === 'POST') { expect(request.headers()['x-csrf-token']).toBe('csrf'); jobs.push({ jobId: jobMatch[1]!, action: jobMatch[2]! }); return json(route, { job: { id: jobMatch[1], status: jobMatch[2] === 'retry' ? 'QUEUED' : 'CANCELLED' } }); }
    return json(route, {});
  });
  await page.goto(`/projects/${projectId}/export`);
  await expect(page.getByRole('heading', { name: 'Готовність і експорт' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Матеріали проєкту' })).toBeVisible();
  return { commands, jobs, data: () => data, makeStale: () => { staleOnce = true; }, allowDownload: () => { downloadDenied = false; }, failNextRead: () => { rejectNextRead = true; }, readinessReads: () => readinessReads };
}
const readiness = (items: Item[], exports: ExportRow[] = []): Data => ({ projectRevision: 4, ready: items.every(item => item.ready), items, exports });

test('a blocked article gives a concrete reason and opens its review', async ({ page }) => {
  await fixture(page, readiness([{ ...article, ready: false, reasons: ['BRIEF_CHANGED'] }]));
  await expect(page.getByText('Після погодження змінився бриф.')).toBeVisible();
  await expect(page.getByRole('checkbox', { name: 'Вибрати Стаття' })).toBeDisabled();
  await page.getByRole('button', { name: 'Відкрити версії статті' }).click();
  await expect(page).toHaveURL(/\/article\?review=1$/);
});

test('a history error preserves readiness and offers retry', async ({ page }) => {
  await fixture(page, readiness([telegram]), true);
  await expect(page.getByRole('checkbox', { name: 'Вибрати Допис у Telegram' })).toBeEnabled();
  await expect(page.getByRole('alert')).toContainText('Не вдалося завантажити історію файлів.');
  await expect(page.getByText('Створені файли з’являться тут.')).toHaveCount(0);
  await page.getByRole('button', { name: 'Повторити перевірку' }).click();
  await expect(page.getByText('Створені файли з’являться тут.')).toBeVisible();
});

test('channels-only creative Telegram exports without an Article and preserves its label', async ({ page }) => {
  const context = await fixture(page, readiness([telegram]));
  await expect(page.getByRole('checkbox', { name: 'Вибрати Стаття' })).toHaveCount(0);
  await expect(page.getByText('Авторський текст · без перевірки в джерелах', { exact: true })).toBeVisible();
  await expect(page.getByText(/відсутній.*статт/i)).toHaveCount(0);
  const choice = page.getByRole('checkbox', { name: 'Вибрати Допис у Telegram' });
  await choice.focus(); await page.keyboard.press('Space');
  await expect(choice).toBeChecked();
  const markdown = page.getByRole('radio', { name: 'Markdown' });
  await markdown.focus(); await page.keyboard.press('Space');
  await expect(markdown).toBeChecked();
  const build = page.getByRole('button', { name: 'Підготувати файл' });
  await build.focus(); await page.keyboard.press('Enter');
  expect(context.commands[0]).toMatchObject({ expectedProjectRevision: 4, format: 'MARKDOWN', items: [{ format: 'TELEGRAM_POST', revisionId: 'telegram-v1', reviewCounter: 0 }] });
  await expect(page.getByText('Готуємо файл', { exact: false })).toBeVisible();
  await page.keyboard.press('Tab');
  await expect(page.locator('.export-workspace :focus-visible').first()).toBeVisible();
  mkdirSync('.local-checks/m34', { recursive: true });
  for (const width of [1280, 768, 390]) { await page.setViewportSize({ width, height: 900 }); await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true); await page.screenshot({ path: `.local-checks/m34/export-channels-${width}.png`, fullPage: true }); }
});

test('only selected ready outputs enter the package; missing unselected article does not block Telegram', async ({ page }) => {
  const missingArticle: Item = { ...article, ready: false, reasons: ['APPROVAL_REQUIRED'] };
  const context = await fixture(page, readiness([missingArticle, telegram]));
  await expect(page.getByRole('checkbox', { name: 'Вибрати Стаття' })).toBeDisabled();
  await expect(page.getByText('Потрібне погодження редактора.')).toBeVisible();
  await page.getByRole('checkbox', { name: 'Вибрати Допис у Telegram' }).check();
  await page.getByRole('button', { name: 'Підготувати файл' }).click();
  expect(context.commands[0]?.items).toEqual([{ format: 'TELEGRAM_POST', revisionId: 'telegram-v1', reviewCounter: 0 }]);
});

test('empty project output list explains why there is nothing to package', async ({ page }) => {
  await fixture(page, readiness([]));
  await expect(page.getByText('У проєкті поки немає підготовлених матеріалів для експорту.')).toBeVisible();
  await expect(page.getByText('Спочатку виберіть готовий матеріал.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Підготувати файл' })).toBeDisabled();
});

test('readiness request errors remain visible and can be retried', async ({ page }) => {
  const context = await fixture(page, readiness([telegram]));
  context.failNextRead();
  await page.getByRole('button', { name: 'Оновити перевірку' }).click();
  await expect(page.getByRole('alert')).toContainText('Не вдалося виконати запит');
  await page.getByRole('button', { name: 'Оновити перевірку' }).click();
  await expect(page.getByRole('alert')).toHaveCount(0);
  await expect(page.getByRole('checkbox', { name: 'Вибрати Допис у Telegram' })).toBeVisible();
});

test('a transient status-read failure is retried while an export remains pending', async ({ page }) => {
  const pending: ExportRow = { id: 'export-pending', format: 'TXT', status: 'BUILDING', createdAt: '2026-10-10T10:00:00Z', jobId: 'job-pending', retryAllowed: false, errorCategory: null, filename: null };
  const context = await fixture(page, readiness([telegram], [pending]));
  context.failNextRead();
  await expect.poll(() => context.readinessReads(), { timeout: 7000 }).toBeGreaterThan(2);
  await expect(page.getByRole('alert')).toHaveCount(0);
  await expect(page.getByText('Оновлюємо стан підготовки, поки файл у черзі.')).toBeVisible();
});

test('409 refreshes readiness while retaining the selected version for explicit reconciliation', async ({ page }) => {
  const context = await fixture(page, readiness([telegram]));
  context.makeStale();
  await page.getByRole('checkbox', { name: 'Вибрати Допис у Telegram' }).check();
  await page.getByRole('button', { name: 'Підготувати файл' }).click();
  await expect(page.getByRole('alert')).toContainText('Вибір збережено');
  await expect(page.getByText('Короткий допис · версія 1')).toBeVisible();
  await expect(page.getByText('Потрібно вибрати актуальну версію')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Підготувати файл' })).toBeDisabled();
  await expect(page.getByRole('checkbox', { name: 'Вибрати Допис у Telegram' })).toBeDisabled();
});

test('failed exports can retry, pending jobs can cancel, and denied download is surfaced', async ({ page }) => {
  const rows: ExportRow[] = [
    { id: 'export-failed', format: 'TXT', status: 'FAILED', createdAt: '2026-10-10T10:00:00Z', jobId: 'job-failed', retryAllowed: true, errorCategory: 'TRANSIENT_PROVIDER', filename: null },
    { id: 'export-pending', format: 'ZIP', status: 'BUILDING', createdAt: '2026-10-10T10:01:00Z', jobId: 'job-pending', retryAllowed: false, errorCategory: null, filename: null },
    { id: 'export-ready', format: 'MARKDOWN', status: 'READY', createdAt: '2026-10-10T10:02:00Z', jobId: 'job-ready', retryAllowed: false, errorCategory: null, filename: 'результат.md' },
  ];
  const context = await fixture(page, readiness([article], rows));
  await expect(page.locator('.export-reasons').first()).toContainText('Попередні погоджені матеріали залишилися доступними');
  await page.getByRole('button', { name: 'Повторити' }).click();
  await expect.poll(() => context.jobs.some(job => job.action === 'retry')).toBe(true);
  await page.getByRole('button', { name: 'Скасувати' }).click();
  await expect.poll(() => context.jobs.some(job => job.action === 'cancel')).toBe(true);
  await page.getByRole('button', { name: 'Завантажити' }).click();
  await expect(page.getByRole('alert')).toContainText('Завантаження недоступне');
});

test('authorized download uses the protected response and decodes the Unicode filename', async ({ page }) => {
  const ready: ExportRow = { id: 'export-ready', format: 'MARKDOWN', status: 'READY', createdAt: '2026-10-10T10:02:00Z', jobId: 'job-ready', retryAllowed: false, errorCategory: null, filename: null };
  const context = await fixture(page, readiness([telegram], [ready]));
  context.allowDownload();
  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Завантажити' }).click();
  expect((await downloadPromise).suggestedFilename()).toBe('Telegram допис.md');
});
