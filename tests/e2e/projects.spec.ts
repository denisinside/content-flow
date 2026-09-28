import { mkdirSync } from 'node:fs';
import { test, expect, type Page } from '@playwright/test';
import { webOrigin } from './ports.js';

const TEST_PASSWORD = 'TestOnly!ContextFlow2026';
const SCREENSHOT_DIR = '.codex/artifacts/m13';

const formats = [
  'Стаття',
  'Публікація у LinkedIn',
  'Обкладинка LinkedIn',
  'Карусель LinkedIn',
  'Обкладинка Instagram',
  'Карусель Instagram',
  'Історії Instagram',
  'Допис у Telegram',
] as const;

async function setFormats(page: Page, selected: readonly string[]): Promise<void> {
  for (const name of formats) {
    const checkbox = page.getByRole('checkbox', { name });
    if (selected.includes(name)) await checkbox.check();
    else await checkbox.uncheck();
  }
}

async function captureAtWidths(page: Page, state: string): Promise<void> {
  for (const width of [1440, 1280, 768, 390]) {
    await page.setViewportSize({ width, height: 900 });
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.screenshot({ path: `${SCREENSHOT_DIR}/projects-${state}-${width}.png`, fullPage: true });
  }
  await page.setViewportSize({ width: 1440, height: 900 });
}

async function createWorkspace(page: Page, name: string): Promise<void> {
  await page.goto('/projects');
  await expect(page.getByRole('heading', { name: 'Робочі простори' })).toBeVisible();
  await page.getByRole('button', { name: 'Новий простір' }).click();
  await page.getByLabel('Назва простору').fill(name);
  await page.getByRole('button', { name: 'Створити простір' }).click();
  await expect(page.getByLabel('Поточний простір')).toHaveValue(/.+/);
  await expect(page.getByLabel('Поточний простір')).toContainText(name);
}

test('a real signed-in user can create, list, open and edit a private project', async ({ page, browser }) => {
  test.setTimeout(90_000);
  mkdirSync(SCREENSHOT_DIR, { recursive: true });
  const ownerEmail = `m13-owner-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.test`;
  const ownerName = 'M13 Browser Test';

  await page.goto('/');
  await expect(page.getByRole('heading', { level: 2, name: 'Раді вас бачити' })).toBeVisible();
  await page.getByRole('button', { name: 'Реєстрація' }).click();
  await page.getByLabel(/Ваше ім’я/).fill(ownerName);
  await page.getByLabel('Електронна пошта').fill(ownerEmail);
  await page.getByLabel('Пароль').fill(TEST_PASSWORD);
  await page.getByRole('button', { name: 'Створити обліковий запис' }).click();
  await expect(page.getByText(`Вітаємо, ${ownerName}`)).toBeVisible({ timeout: 20_000 });

  await page.goto('/projects');
  await expect(page.getByText('Створіть простір для команди та її проєктів або прийміть запрошення.')).toBeVisible();
  await captureAtWidths(page, 'workspace-empty');
  await createWorkspace(page, 'M14 Browser Workspace');
  await expect(page.getByRole('button', { name: 'Створити проєкт' })).toBeVisible();
  await expect(page.getByText(/поки немає проєктів|створіть перший проєкт/i)).toBeVisible();
  await captureAtWidths(page, 'empty');

  await page.keyboard.press('Tab');
  const focusVisible = await page.evaluate(() => {
    const active = document.activeElement;
    if (!(active instanceof HTMLElement)) return false;
    const style = getComputedStyle(active);
    return active.matches(':focus-visible')
      && ((style.outlineStyle !== 'none' && style.outlineWidth !== '0px') || style.boxShadow !== 'none');
  });
  expect(focusVisible).toBe(true);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  expect(await page.evaluate(() => matchMedia('(prefers-reduced-motion: reduce)').matches)).toBe(true);

  await page.getByRole('button', { name: 'Створити проєкт' }).click();
  await expect(page.getByLabel('Тема проєкту')).toBeVisible();
  const reducedTransitionMs = await page.getByLabel('Тема проєкту').evaluate(element => {
    const duration = getComputedStyle(element).transitionDuration.split(',')[0]?.trim() ?? '0s';
    const amount = Number.parseFloat(duration);
    return duration.endsWith('ms') ? amount : amount * 1000;
  });
  expect(reducedTransitionMs).toBeLessThanOrEqual(0.01);
  await captureAtWidths(page, 'create');
  const originalTopic = `M13 test project ${Date.now()}`;
  await page.getByLabel('Тема проєкту').fill(originalTopic);
  await setFormats(page, ['Публікація у LinkedIn', 'Обкладинка Instagram']);
  await page.getByRole('button', { name: 'Створити проєкт', exact: true }).last().click();

  await expect(page).toHaveURL(/\/projects\/[^/]+$/);
  const projectId = new URL(page.url()).pathname.split('/').at(-1)!;
  await expect(page.getByRole('heading', { name: originalTopic })).toBeVisible();
  await expect(page.getByText('Публікація у LinkedIn')).toBeVisible();
  await expect(page.getByText('Обкладинка Instagram')).toBeVisible();
  await captureAtWidths(page, 'detail');

  await page.getByRole('button', { name: 'Редагувати проєкт' }).click();
  await expect(page.getByLabel('Тема проєкту')).toHaveValue(originalTopic);
  const updatedTopic = `${originalTopic} — updated`;
  await page.getByLabel('Тема проєкту').fill(updatedTopic);
  await setFormats(page, ['Обкладинка Instagram', 'Допис у Telegram']);
  await captureAtWidths(page, 'edit');
  await page.getByRole('button', { name: 'Зберегти зміни' }).click();

  await expect(page.getByRole('heading', { name: updatedTopic })).toBeVisible();
  await expect(page.getByText('Допис у Telegram')).toBeVisible();
  await expect(page.getByText('Публікація у LinkedIn')).toHaveCount(0);
  await page.reload();
  await expect(page.getByRole('heading', { name: updatedTopic })).toBeVisible();
  await expect(page.getByText('Допис у Telegram')).toBeVisible();
  await page.goto('/projects');
  await expect(page.getByText(updatedTopic, { exact: true })).toBeVisible();
  await captureAtWidths(page, 'list');

  // A separate isolated browser registers a distinct real TEST user through the
  // BFF API, then attempts to address the first user's project directly.
  const otherContext = await browser.newContext({ baseURL: webOrigin });
  try {
    const otherPage = await otherContext.newPage();
    await otherPage.goto('/');
    const registration = await otherPage.evaluate(async ({ email, password }) => {
      const sessionResponse = await fetch('/api/auth/session', { credentials: 'same-origin' });
      const session = await sessionResponse.json() as { csrfToken: string };
      const response = await fetch('/api/auth/register', {
        method: 'POST', credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': session.csrfToken },
        body: JSON.stringify({ email, password, displayName: 'M13 Nonmember' }),
      });
      return { status: response.status, body: await response.json() as { authenticated?: boolean } };
    }, { email: `m13-outsider-${Date.now()}@example.test`, password: TEST_PASSWORD });
    expect(registration.status).toBe(201);
    expect(registration.body.authenticated).toBe(true);

    const outsiderList = await otherPage.evaluate(async () => {
      const response = await fetch('/api/v1/projects', { credentials: 'same-origin' });
      return { status: response.status, body: await response.json() as { projects?: unknown[]; nextCursor?: unknown } };
    });
    expect(outsiderList.status).toBe(200);
    expect(outsiderList.body.projects).toEqual([]);

    const outsiderProject = await otherPage.evaluate(async projectIdValue => {
      const response = await fetch(`/api/v1/projects/${encodeURIComponent(projectIdValue)}`, { credentials: 'same-origin' });
      return { status: response.status, body: await response.json().catch(() => null) };
    }, projectId);
    expect(outsiderProject.status).toBe(404);
    expect(JSON.stringify(outsiderProject.body)).not.toContain(updatedTopic);
    expect(JSON.stringify(outsiderProject.body)).not.toContain(projectId);
  } finally {
    await otherContext.close();
  }

  // The allowed 500-character boundary may contain no spaces; both the detail
  // heading and list link still have to fit a narrow viewport.
  await page.getByRole('link', { name: updatedTopic, exact: true }).click();
  await page.getByRole('button', { name: 'Редагувати проєкт' }).click();
  const longTopic = 'Д'.repeat(500);
  await page.getByLabel('Тема проєкту').fill(longTopic);
  await page.getByRole('button', { name: 'Зберегти зміни' }).click();
  await expect(page.getByRole('heading', { name: longTopic, exact: true })).toBeVisible();
  await page.setViewportSize({ width: 390, height: 900 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.getByRole('button', { name: 'Усі проєкти' }).click();
  await expect(page.getByRole('link', { name: longTopic, exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);

  // Article is opt-in: it can be the only selected format, and stays absent
  // from a channels-only project's detail and list text.
  const channelsOnlyRow = page.locator('.project-row').filter({ hasText: longTopic });
  await expect(channelsOnlyRow).not.toContainText('Стаття');
  await channelsOnlyRow.getByRole('link', { name: longTopic, exact: true }).click();
  await expect(page.getByRole('heading', { name: longTopic, exact: true })).toBeVisible();
  await expect(page.getByText('Стаття', { exact: true })).toHaveCount(0);

  await page.getByRole('button', { name: 'Усі проєкти' }).click();
  await page.getByRole('button', { name: 'Створити проєкт', exact: true }).click();
  const articleTopic = `M13 article-only ${Date.now()}`;
  await page.getByLabel('Тема проєкту').fill(articleTopic);
  await expect(page.getByRole('checkbox', { name: 'Стаття' })).not.toBeChecked();
  await expect(page.getByText('Стаття — за бажанням.')).toBeVisible();
  await captureAtWidths(page, 'article-create');
  await setFormats(page, ['Стаття']);
  await page.getByRole('button', { name: 'Створити проєкт', exact: true }).last().click();
  await expect(page).toHaveURL(/\/projects\/[^/]+$/);
  await expect(page.getByRole('heading', { name: articleTopic, exact: true })).toBeVisible();
  await expect(page.getByText('Стаття', { exact: true })).toBeVisible();
  await expect(page.getByText('Публікація у LinkedIn', { exact: true })).toHaveCount(0);
  await page.reload();
  await expect(page.getByRole('heading', { name: articleTopic, exact: true })).toBeVisible();
  await expect(page.getByText('Стаття', { exact: true })).toBeVisible();

  // Add a channel beside Article, then remove Article in a later revision.
  // The persisted display after reload must follow only the current selection.
  await page.getByRole('button', { name: 'Редагувати проєкт' }).click();
  await setFormats(page, ['Стаття', 'Публікація у LinkedIn']);
  await captureAtWidths(page, 'article-and-channel-settings');
  await page.getByRole('button', { name: 'Зберегти зміни' }).click();
  await expect(page.getByText('Стаття', { exact: true })).toBeVisible();
  await expect(page.getByText('Публікація у LinkedIn', { exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByText('Стаття', { exact: true })).toBeVisible();
  await expect(page.getByText('Публікація у LinkedIn', { exact: true })).toBeVisible();

  await page.getByRole('button', { name: 'Редагувати проєкт' }).click();
  await setFormats(page, ['Публікація у LinkedIn']);
  await page.getByRole('button', { name: 'Зберегти зміни' }).click();
  await expect(page.getByText('Стаття', { exact: true })).toHaveCount(0);
  await expect(page.getByText('Публікація у LinkedIn', { exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByText('Стаття', { exact: true })).toHaveCount(0);
  await expect(page.getByText('Публікація у LinkedIn', { exact: true })).toBeVisible();
  await page.goto('/projects');
  const articleProjectRow = page.locator('.project-row').filter({ hasText: articleTopic });
  await expect(articleProjectRow).toContainText('Публікація у LinkedIn');
  await expect(articleProjectRow).not.toContainText('Стаття');
  await expect(page.locator('.project-row').filter({ hasText: longTopic })).not.toContainText('Стаття');

  await page.getByRole('button', { name: 'Вийти' }).click();
  await expect(page.getByRole('heading', { level: 2, name: 'Раді вас бачити' })).toBeVisible();
  const protectedAfterLogout = await page.evaluate(async projectIdValue => {
    const response = await fetch(`/api/v1/projects/${encodeURIComponent(projectIdValue)}`, { credentials: 'same-origin' });
    return response.status;
  }, projectId);
  expect(protectedAfterLogout).toBe(401);
});

test('project loading, outages, edit conflicts and a delayed create survive recovery and logout', async ({ page, context }) => {
  test.setTimeout(90_000);
  mkdirSync(SCREENSHOT_DIR, { recursive: true });
  await page.goto('/');
  await page.getByRole('button', { name: 'Реєстрація' }).click();
  await page.getByLabel(/Ваше ім’я/).fill('M13 Recovery Test');
  await page.getByLabel('Електронна пошта').fill(`m13-recovery-${Date.now()}@example.test`);
  await page.getByLabel('Пароль').fill(TEST_PASSWORD);
  await page.getByRole('button', { name: 'Створити обліковий запис' }).click();
  await expect(page.getByText('Вітаємо, M13 Recovery Test')).toBeVisible({ timeout: 20_000 });
  await createWorkspace(page, 'M14 Recovery Workspace');

  let releaseList!: () => void;
  const heldList = new Promise<void>(resolve => { releaseList = resolve; });
  await page.route('**/api/v1/projects*', async route => {
    await heldList;
    await route.continue();
  }, { times: 1 });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await expect(page.getByRole('heading', { name: 'Завантажуємо ваші проєкти' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Створити проєкт', exact: true })).toBeDisabled();
  await captureAtWidths(page, 'loading');
  releaseList();
  await expect(page.getByText('Проєктів поки немає', { exact: true })).toBeVisible();

  await page.route('**/api/v1/projects*', route => route.fulfill({
    status: 503, contentType: 'application/json', body: JSON.stringify({ message: 'Unavailable' }),
  }), { times: 1 });
  await page.reload();
  await expect(page.getByRole('alert')).toContainText('Не вдалося завантажити проєкти');
  await captureAtWidths(page, 'unavailable');
  await page.getByRole('button', { name: 'Створити проєкт', exact: true }).click();
  await page.getByLabel('Тема проєкту').fill('Concurrent project settings');
  await setFormats(page, ['Допис у Telegram']);
  let releaseRetry!: () => void;
  const heldRetry = new Promise<void>(resolve => { releaseRetry = resolve; });
  await page.route('**/api/v1/projects*', async route => {
    await heldRetry;
    await route.continue();
  }, { times: 1 });
  await page.getByRole('button', { name: 'Спробувати ще раз' }).click();
  await expect(page.getByRole('heading', { name: 'Завантажуємо ваші проєкти' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Створити проєкт', exact: true }).last()).toBeDisabled();
  releaseRetry();
  await expect(page.getByRole('heading', { name: 'Завантажуємо ваші проєкти' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Скасувати' }).click();
  await expect(page.getByText('Проєктів поки немає', { exact: true })).toBeVisible();

  await page.getByRole('button', { name: 'Створити проєкт', exact: true }).click();
  await page.getByLabel('Тема проєкту').fill('Concurrent project settings');
  await setFormats(page, ['Допис у Telegram']);
  await page.route('**/api/v1/projects*', route => route.fulfill({
    status: 503, contentType: 'application/json', body: JSON.stringify({ message: 'Unavailable' }),
  }), { times: 1 });
  await page.getByRole('button', { name: 'Створити проєкт', exact: true }).last().click();
  await expect(page.getByRole('alert')).toContainText('Не вдалося зберегти');
  await expect(page.getByRole('heading', { name: 'Завантажуємо ваші проєкти' })).toHaveCount(0);
  await expect(page.getByLabel('Тема проєкту')).toHaveValue('Concurrent project settings');
  await page.getByRole('button', { name: 'Створити проєкт', exact: true }).last().click();
  await expect(page).toHaveURL(/\/projects\/[^/]+$/);
  const projectUrl = page.url();
  const secondPage = await context.newPage();
  await secondPage.goto(projectUrl);
  await secondPage.getByRole('button', { name: 'Редагувати проєкт' }).click();
  await secondPage.getByLabel('Тема проєкту').fill('My unsaved stale edit');
  await page.getByRole('button', { name: 'Редагувати проєкт' }).click();
  await page.getByLabel('Тема проєкту').fill('Settings saved by the other tab');
  await page.getByRole('button', { name: 'Зберегти зміни' }).click();
  await expect(page.getByRole('heading', { name: 'Settings saved by the other tab' })).toBeVisible();
  await secondPage.getByRole('button', { name: 'Зберегти зміни' }).click();
  await expect(secondPage.getByRole('alert')).toContainText('Є нові зміни');
  await expect(secondPage.getByLabel('Тема проєкту')).toHaveValue('My unsaved stale edit');
  await captureAtWidths(secondPage, 'conflict');
  await secondPage.getByRole('button', { name: 'Скинути мої зміни й оновити' }).click();
  await expect(secondPage.getByRole('heading', { name: 'Settings saved by the other tab' })).toBeVisible();
  await secondPage.close();

  // Leaving the edit screen resets its mode, so a list creation form cannot
  // accidentally PATCH the project whose settings were open previously.
  await page.getByRole('button', { name: 'Редагувати проєкт' }).click();
  await page.getByLabel('Тема проєкту').fill('This edit must be discarded on navigation');
  await page.getByRole('button', { name: 'Усі проєкти' }).click();
  await expect(page.getByLabel('Тема проєкту')).toHaveCount(0);
  await page.getByRole('link', { name: 'Settings saved by the other tab', exact: true }).click();
  await page.getByRole('button', { name: 'Редагувати проєкт' }).click();
  await page.getByLabel('Тема проєкту').fill('Discard this edit on browser Back too');
  await page.goBack();
  await expect(page.getByLabel('Тема проєкту')).toHaveCount(0);
  await page.goForward();
  await expect(page.getByRole('heading', { name: 'Settings saved by the other tab' })).toBeVisible();

  // Let the server commit the create, but hold its browser response until logout
  // has unmounted the workspace. A late reply must not navigate or restore it.
  await page.getByRole('button', { name: 'Усі проєкти' }).click();
  await page.getByRole('button', { name: 'Створити проєкт', exact: true }).click();
  await page.getByLabel('Тема проєкту').fill('Delayed create during logout');
  await setFormats(page, ['Публікація у LinkedIn']);
  let releaseCreate!: () => void;
  let sawCreate!: () => void;
  let finishCreate!: () => void;
  const heldCreate = new Promise<void>(resolve => { releaseCreate = resolve; });
  const intercepted = new Promise<void>(resolve => { sawCreate = resolve; });
  const delivered = new Promise<void>(resolve => { finishCreate = resolve; });
  await page.route('**/api/v1/projects*', async route => {
    const original = await route.fetch();
    expect(original.status()).toBe(201);
    sawCreate();
    await heldCreate;
    try { await route.fulfill({ response: original }); }
    catch (error) { if (!route.request().failure()) throw error; }
    finally { finishCreate(); }
  }, { times: 1 });
  await page.getByRole('button', { name: 'Створити проєкт', exact: true }).last().click();
  await intercepted;
  await expect(page.getByRole('button', { name: 'Зберігаємо…' })).toBeDisabled();
  await page.getByRole('button', { name: 'Вийти' }).click();
  await expect(page.getByRole('heading', { name: 'Раді вас бачити' })).toBeVisible();
  const loggedOutUrl = page.url();
  releaseCreate();
  await delivered;
  await expect(page).toHaveURL(loggedOutUrl);
  await expect(page.getByRole('heading', { name: 'Раді вас бачити' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Delayed create during logout' })).toHaveCount(0);
});

test('Workspace switching and targeted invitation consent control nested Project access', async ({ page, browser }) => {
  test.setTimeout(90_000);
  const nonce = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const recipientEmail = `m14-recipient-${nonce}@example.test`;
  await page.goto('/');
  await page.getByRole('button', { name: 'Реєстрація' }).click();
  await page.getByLabel(/Ваше ім’я/).fill('M14 Owner');
  await page.getByLabel('Електронна пошта').fill(`m14-owner-${nonce}@example.test`);
  await page.getByLabel('Пароль').fill(TEST_PASSWORD);
  await page.getByRole('button', { name: 'Створити обліковий запис' }).click();
  await expect(page.getByText('Вітаємо, M14 Owner')).toBeVisible({ timeout: 20_000 });
  await createWorkspace(page, 'M14 Shared Workspace');
  const sharedWorkspaceId = await page.getByLabel('Поточний простір').inputValue();
  await page.getByRole('button', { name: 'Створити проєкт', exact: true }).click();
  const topic = `Shared story ${nonce}`;
  await page.getByLabel('Тема проєкту').fill(topic);
  await setFormats(page, ['Стаття']);
  await page.getByRole('button', { name: 'Створити проєкт', exact: true }).last().click();
  await expect(page.getByRole('heading', { name: topic })).toBeVisible();
  const projectId = new URL(page.url()).pathname.split('/').at(-1)!;
  await page.getByRole('button', { name: 'Усі проєкти' }).click();
  await createWorkspace(page, 'M14 Private Workspace');
  await expect(page.getByText('Проєктів поки немає', { exact: true })).toBeVisible();
  await page.getByLabel('Поточний простір').selectOption(sharedWorkspaceId);
  await expect(page.getByRole('link', { name: topic, exact: true })).toBeVisible();

  const recipientContext = await browser.newContext({ baseURL: webOrigin });
  try {
    const recipient = await recipientContext.newPage();
    await recipient.goto('/');
    await recipient.getByRole('button', { name: 'Реєстрація' }).click();
    await recipient.getByLabel(/Ваше ім’я/).fill('M14 Recipient');
    await recipient.getByLabel('Електронна пошта').fill(recipientEmail);
    await recipient.getByLabel('Пароль').fill(TEST_PASSWORD);
    await recipient.getByRole('button', { name: 'Створити обліковий запис' }).click();
    await expect(recipient.getByText('Вітаємо, M14 Recipient')).toBeVisible({ timeout: 20_000 });
    await expect(recipient.getByText('Створіть простір для команди та її проєктів або прийміть запрошення.')).toBeVisible();
    expect((await recipient.request.get(`/api/v1/projects/${projectId}`)).status()).toBe(404);

    await page.getByText('Учасники та керування простором').click();
    await page.getByLabel('Запросити людину').fill(recipientEmail);
    await page.getByRole('button', { name: 'Запросити', exact: true }).click();
    const invitationUrl = await page.getByLabel('Посилання для запрошеної людини').inputValue();
    expect(invitationUrl).toContain('/projects#invite=');
    expect((await recipient.request.get(`/api/v1/projects/${projectId}`)).status()).toBe(404);
    await recipient.goto(invitationUrl);
    await expect(recipient.getByLabel('Код запрошення')).toHaveValue(/.+/);
    await recipient.getByRole('button', { name: 'Приєднатися' }).click();
    await expect(recipient.getByLabel('Поточний простір')).toContainText('M14 Shared Workspace');
    await expect(recipient.getByRole('link', { name: topic, exact: true })).toBeVisible();
    expect((await recipient.request.get(`/api/v1/projects/${projectId}`)).status()).toBe(200);
    await recipient.getByText('Учасники та керування простором').click();
    await recipient.getByRole('button', { name: 'Вийти з простору' }).click();
    await recipient.getByRole('button', { name: 'Підтвердити' }).click();
    await expect(recipient.getByText('Створіть простір для команди та її проєктів або прийміть запрошення.')).toBeVisible();
    expect((await recipient.request.get(`/api/v1/projects/${projectId}`)).status()).toBe(404);
  } finally {
    await recipientContext.close();
  }
});
