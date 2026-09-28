import { mkdirSync } from 'node:fs';
import { test, expect, type Page } from '@playwright/test';

const TEST_PASSWORD = 'TestOnly!ContextFlow2026';
const SCREENSHOT_DIR = '.codex/artifacts/m21';

function sourceItem(page: Page, label: string) {
  return page.locator('.source-item-open').filter({ hasText: label });
}

async function setFormats(page: Page, selected: readonly string[]): Promise<void> {
  const formats = [
    'Стаття',
    'Публікація у LinkedIn',
    'Обкладинка LinkedIn',
    'Карусель LinkedIn',
    'Обкладинка Instagram',
    'Карусель Instagram',
    'Історії Instagram',
    'Допис у Telegram',
  ];
  for (const name of formats) {
    const checkbox = page.getByRole('checkbox', { name });
    if (selected.includes(name)) await checkbox.check();
    else await checkbox.uncheck();
  }
}

async function createWorkspace(page: Page): Promise<void> {
  await page.goto('/projects');
  await expect(page.getByRole('button', { name: 'Новий простір' })).toBeVisible();
  await page.getByRole('button', { name: 'Новий простір' }).click();
  await page.getByLabel('Назва простору').fill(`M21 Sources ${Date.now()}`);
  await page.getByRole('button', { name: 'Створити простір' }).click();
  await expect(page.getByLabel('Поточний простір')).toHaveValue(/.+/);
}

async function captureAtWidths(page: Page, state: string): Promise<void> {
  for (const width of [1440, 1280, 768, 390]) {
    await page.setViewportSize({ width, height: 900 });
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.screenshot({ path: `${SCREENSHOT_DIR}/sources-${state}-${width}.png`, fullPage: true });
  }
  await page.setViewportSize({ width: 1440, height: 900 });
}

test('members add, inspect, revise and download immutable source snapshots', async ({ page }) => {
  test.setTimeout(90_000);
  mkdirSync(SCREENSHOT_DIR, { recursive: true });
  const nonce = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  await page.goto('/');
  await page.getByRole('button', { name: 'Реєстрація' }).click();
  await page.getByLabel(/Ваше ім’я/).fill('M21 Sources Test');
  await page.getByLabel('Електронна пошта').fill(`m21-sources-${nonce}@example.test`);
  await page.getByLabel('Пароль').fill(TEST_PASSWORD);
  await page.getByRole('button', { name: 'Створити обліковий запис' }).click();
  await expect(page.getByText('Вітаємо, M21 Sources Test')).toBeVisible({ timeout: 20_000 });

  await expect(page.getByRole('heading', { name: 'Зовнішня обробка матеріалів' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Погодитися на зовнішню обробку' })).toBeVisible();

  await createWorkspace(page);
  await page.getByRole('button', { name: 'Створити проєкт', exact: true }).click();
  const topic = `M21 source project ${nonce}`;
  await page.getByLabel('Тема проєкту').fill(topic);
  await setFormats(page, ['Публікація у LinkedIn']);
  await page.getByRole('button', { name: 'Створити проєкт', exact: true }).last().click();
  await expect(page.getByRole('heading', { name: topic })).toBeVisible();
  await page.getByRole('button', { name: 'Відкрити джерела' }).click();
  await expect(page).toHaveURL(/\/projects\/[0-9a-f-]+\/sources$/i);
  await expect(page.getByRole('heading', { name: 'Додати матеріал' })).toBeVisible();
  await expect(page.getByText('Джерел поки немає. Додайте текст або файл вище.')).toBeVisible();
  await captureAtWidths(page, 'empty');
  await page.getByLabel('Назва', { exact: true }).focus();
  await page.keyboard.press('Tab');
  await expect(page.locator('#source-purpose')).toBeFocused();
  expect(await page.locator('#source-purpose').evaluate(element => element.matches(':focus-visible'))).toBe(true);
  await page.screenshot({ path: `${SCREENSHOT_DIR}/sources-keyboard-focus-1440.png`, fullPage: true });

  // The product does not expose a theme switch in this milestone. This visual
  // fixture applies the canonical dark semantic palette to the real source UI.
  await page.route('**/__m21_dark_fixture.css', route => route.fulfill({ contentType: 'text/css', body: `
    :root { color-scheme: dark; --paper: #10171d; --document: #182128; --ink: #e5ebed; --muted: #a0b0ba; --rule: #34434e; --copper: #a6d9cf; --copper-hover: #c0e5de; --copper-foreground: #182128; --error: #f0a7a1; }
    html, body, .site-shell, .signed-in-workspace { background: #10171d; color: #e5ebed; }
  ` }));
  const darkThemeFixture = await page.addStyleTag({ url: new URL('/__m21_dark_fixture.css', page.url()).href });
  await page.screenshot({ path: `${SCREENSHOT_DIR}/sources-dark-palette-1440.png`, fullPage: true });
  await darkThemeFixture.evaluate(element => element.parentNode?.removeChild(element));
  await page.unroute('**/__m21_dark_fixture.css');

  const safePayload = 'Редакційне джерело українською.\n\n<script>alert("must remain text")</script>\nНадійні факти потребують точного контексту.';
  await page.getByLabel('Назва', { exact: true }).fill('Ручне джерело');
  await page.getByLabel('Текст джерела').fill(safePayload);
  await page.getByRole('button', { name: 'Додати джерело' }).click();
  await expect(page.locator('.source-plain-text')).toContainText(safePayload);
  expect(await page.locator('.source-plain-text script').count()).toBe(0);
  expect(await page.locator('script').evaluateAll(nodes => nodes.every(node => !node.textContent?.includes('must remain text')))).toBe(true);
  await page.locator('.source-metadata > summary').click();
  await page.locator('.source-fragments > summary').click();
  await expect(page.locator('.source-fragments')).toContainText('Надійні факти потребують точного контексту.');
  await expect(page.locator('.source-metadata')).toContainText('Введено вручну');
  await page.locator('.source-fragments > summary').click();
  await page.locator('.source-metadata > summary').click();
  await captureAtWidths(page, 'manual');

  const markdown = '# Витяг\n\nЦе файл **Markdown** з українським текстом.';
  await page.getByRole('button', { name: 'TXT / Markdown' }).click();
  await page.getByLabel('Назва', { exact: true }).fill('Завантажений конспект');
  await page.locator('#source-file').setInputFiles({ name: 'interview.md', mimeType: 'text/markdown', buffer: Buffer.from(markdown, 'utf8') });
  await page.getByRole('button', { name: 'Додати джерело' }).click();
  await expect(page.locator('.source-plain-text')).toContainText('Це файл **Markdown**');
  await expect(page.locator('.source-plain-text')).not.toContainText('<script>');
  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Завантажити оригінал' }).click();
  expect((await downloadPromise).suggestedFilename()).toBe('interview.md');
  await captureAtWidths(page, 'uploaded');

  await sourceItem(page, 'Ручне джерело').click();
  await expect(page.locator('.source-plain-text')).toContainText('Надійні факти потребують точного контексту.');
  await page.getByRole('button', { name: 'Редагувати текст' }).click();
  const revisedText = 'Нова редакція збережена окремою версією.\nСтарий текст залишається доступним в історії.';
  await page.getByLabel('Нова версія тексту').fill(revisedText);
  await expect(sourceItem(page, 'Завантажений конспект')).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Додати джерело' })).toBeDisabled();
  await expect(page.getByLabel('Нова версія тексту')).toHaveValue(revisedText);
  await page.getByRole('button', { name: 'Зберегти нову версію' }).click();
  await expect(page.locator('.source-plain-text')).toContainText('Нова редакція збережена');
  await page.locator('.source-history').locator('summary').click();
  await page.getByRole('button', { name: /Версія 1/ }).click();
  await expect(page.locator('.source-plain-text')).toContainText('Надійні факти потребують точного контексту.');
  await page.locator('.source-history').locator('summary').click();
  await page.getByRole('button', { name: /Версія 2/ }).click();
  await expect(page.locator('.source-plain-text')).toContainText('Нова редакція збережена');

  const versionConflictText = 'Мій текст після конфлікту лишається доступним.';
  await page.getByRole('button', { name: 'Редагувати текст' }).click();
  await page.getByLabel('Нова версія тексту').fill(versionConflictText);
  await page.route('**/api/v1/projects/*/materials/*/snapshots', async route => {
    if (route.request().method() !== 'POST') return route.continue();
    await route.fulfill({ status: 409, contentType: 'application/json', body: JSON.stringify({ message: 'Revision conflict' }) });
  }, { times: 1 });
  await page.getByRole('button', { name: 'Зберегти нову версію' }).click();
  await expect(page.getByRole('alert')).toContainText('вже змінилося в іншій вкладці');
  await expect(page.getByLabel('Нова версія тексту')).toHaveValue(versionConflictText);
  await page.route('**/api/v1/projects/*/materials/*', async route => {
    if (route.request().method() !== 'GET') return route.continue();
    await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ message: 'Unavailable' }) });
  }, { times: 1 });
  await page.getByRole('button', { name: 'Завантажити актуальну версію' }).click();
  await expect(page.getByRole('alert')).toContainText('Ваш текст залишився у полі редагування');
  await expect(page.getByLabel('Нова версія тексту')).toHaveValue(versionConflictText);
  await expect(page.getByRole('button', { name: 'Завантажити актуальну версію' })).toBeEnabled();
  await page.getByRole('button', { name: 'Завантажити актуальну версію' }).click();
  await expect(page.getByLabel('Нова версія тексту')).toHaveValue(versionConflictText);
  await expect(page.getByText('Завантажено актуальну версію. Ваш текст залишився у полі редагування.')).toBeVisible();
  await page.getByRole('button', { name: 'Зберегти нову версію' }).click();
  await expect(page.locator('.source-plain-text')).toContainText(versionConflictText);

  await page.getByRole('button', { name: 'Виключити Ручне джерело' }).click();
  await expect(page.getByRole('button', { name: 'Включити Ручне джерело' })).toHaveAttribute('aria-pressed', 'false');
  await page.reload();
  await expect(page.getByRole('button', { name: 'Включити Ручне джерело' })).toHaveAttribute('aria-pressed', 'false');
  await page.getByRole('button', { name: 'Включити Ручне джерело' }).click();
  await expect(page.getByRole('button', { name: 'Виключити Ручне джерело' })).toHaveAttribute('aria-pressed', 'true');

  let releaseDownload!: () => void;
  let markDownloadStarted!: () => void;
  const delayedDownload = new Promise<void>(resolve => { releaseDownload = resolve; });
  const downloadStarted = new Promise<void>(resolve => { markDownloadStarted = resolve; });
  await page.route('**/api/v1/projects/*/assets/*/download', async route => {
    markDownloadStarted();
    await delayedDownload;
    try { await route.continue(); } catch { /* The save supersedes this stale download request. */ }
  }, { times: 1 });
  await sourceItem(page, 'Завантажений конспект').click();
  await page.getByRole('button', { name: 'Завантажити оригінал' }).click();
  await downloadStarted;
  await page.getByRole('button', { name: 'Редагувати текст' }).click();
  const fileRevisionText = 'Файл оновлено вручну, його попередній оригінал залишається доступним.';
  await page.getByLabel('Нова версія тексту').fill(fileRevisionText);
  await page.getByRole('button', { name: 'Зберегти нову версію' }).click();
  await expect(page.locator('.source-plain-text')).toContainText(fileRevisionText);
  releaseDownload();
  await expect(page.getByRole('button', { name: 'Завантажити оригінал' })).toBeEnabled();

  const pendingWriteText = 'Під час збереження завантаження та повторне редагування вимкнені.';
  await page.getByRole('button', { name: 'Редагувати текст' }).click();
  await page.getByLabel('Нова версія тексту').fill(pendingWriteText);
  let releaseWrite!: () => void;
  let markWriteCommitted!: () => void;
  const delayedWrite = new Promise<void>(resolve => { releaseWrite = resolve; });
  const writeCommitted = new Promise<void>(resolve => { markWriteCommitted = resolve; });
  let releaseRefresh!: () => void;
  let markRefreshStarted!: () => void;
  const delayedRefresh = new Promise<void>(resolve => { releaseRefresh = resolve; });
  const refreshStarted = new Promise<void>(resolve => { markRefreshStarted = resolve; });
  await page.route('**/api/v1/projects/*/materials/*/snapshots', async route => {
    if (route.request().method() !== 'POST') return route.continue();
    const response = await route.fetch();
    markWriteCommitted();
    await delayedWrite;
    try { await route.fulfill({ response }); } catch { /* The page may navigate while this response is held. */ }
  }, { times: 1 });
  await page.route('**/api/v1/projects/*/materials', async route => {
    if (route.request().method() !== 'GET') return route.continue();
    markRefreshStarted();
    await delayedRefresh;
    try { await route.continue(); } catch { /* The page may navigate while this refresh is held. */ }
  }, { times: 1 });
  await page.getByRole('button', { name: 'Зберегти нову версію' }).click();
  await writeCommitted;
  await expect(page.getByRole('button', { name: 'Завантажити оригінал' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Редагувати текст' })).toHaveCount(0);
  releaseWrite();
  await refreshStarted;
  await expect(page.getByRole('button', { name: 'Завантажити оригінал' })).toBeDisabled();
  await expect(sourceItem(page, 'Ручне джерело')).toHaveCount(0);
  releaseRefresh();
  await expect(page.locator('.source-plain-text')).toContainText(pendingWriteText);
  await expect(page.getByRole('button', { name: 'Завантажити оригінал' })).toBeEnabled();

  await page.getByRole('button', { name: 'Текст', exact: true }).click();
  await page.getByLabel('Назва', { exact: true }).fill('Збережено попри збій списку');
  await page.getByLabel('Текст джерела').fill('Запис уже збережено; збій оновлення списку має видиму дію відновлення.');
  await page.route('**/api/v1/projects/*/materials', async route => {
    if (route.request().method() !== 'GET') return route.continue();
    await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ message: 'Unavailable' }) });
  });
  await page.getByRole('button', { name: 'Додати джерело' }).click();
  await expect(page.locator('.source-plain-text')).toContainText('Запис уже збережено');
  await expect(page.getByRole('button', { name: 'Оновити список джерел' })).toBeVisible();
  await page.unroute('**/api/v1/projects/*/materials');
  await page.getByRole('button', { name: 'Оновити список джерел' }).click();
  await expect(sourceItem(page, 'Збережено попри збій списку')).toBeEnabled();
  await expect(page.getByRole('button', { name: 'Оновити список джерел' })).toHaveCount(0);

  await page.getByRole('button', { name: 'TXT / Markdown' }).click();
  await page.getByLabel('Назва', { exact: true }).fill('Відмова зовнішньої обробки');
  await page.locator('#source-file').setInputFiles({ name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('Синтетичний тест згоди.', 'utf8') });
  await page.route('**/api/v1/projects/*/materials/upload', route => route.fulfill({
    status: 403, contentType: 'application/json', body: JSON.stringify({ message: 'Notice acceptance required' }),
  }), { times: 1 });
  await page.getByRole('button', { name: 'Додати джерело' }).click();
  await expect(page.getByRole('alert')).toContainText('Перевірте повідомлення про зовнішню обробку');
  const noticeLink = page.getByRole('link', { name: 'Переглянути повідомлення й надати потрібну згоду' });
  await expect(noticeLink).toBeVisible();
  await noticeLink.click();
  await page.getByRole('button', { name: 'Погодитися на зовнішню обробку' }).click();
  await expect(page.getByText(/Згоду збережено/)).toBeVisible();
  await page.reload();
  await expect(page.getByText(/Згоду збережено/)).toBeVisible();

  await page.getByRole('button', { name: 'Текст', exact: true }).click();
  await page.getByLabel('Назва', { exact: true }).fill('Збереження після помилки');
  await page.getByLabel('Текст джерела').fill('Цей текст має залишитися у формі після помилки мережі.');
  await page.route('**/api/v1/projects/*/materials', async route => {
    if (route.request().method() !== 'POST') return route.continue();
    await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ message: 'Unavailable' }) });
  }, { times: 1 });
  await page.getByRole('button', { name: 'Додати джерело' }).click();
  await expect(page.getByRole('alert')).toContainText('тимчасово недоступний');
  await expect(page.getByLabel('Текст джерела')).toHaveValue('Цей текст має залишитися у формі після помилки мережі.');
  await expect(page.getByLabel('Назва', { exact: true })).toHaveValue('Збереження після помилки');
  await captureAtWidths(page, 'error-preserved');
});
