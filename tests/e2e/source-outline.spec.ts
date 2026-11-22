import { expect, test } from '@playwright/test';
import { installSourceOutlineFixture } from './fixtures/source-outline.js';
import { projectId } from './fixtures/m63-editorial.js';

const briefUrl = `/projects/${projectId}/brief`;

test('offers a new source plan when the approved plan belongs to the previous brief', async ({ page }) => {
  const fixture = await installSourceOutlineFixture(page, 'succeed', true);
  await page.goto(briefUrl);
  await expect(page.getByText('План для попереднього брифу', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Зберегти план' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Оновити план із джерел' }).click();
  await page.getByText('Пропозиція AI · Не застосовано', { exact: true }).click({ timeout: 12_000 });
  await expect(page.getByRole('button', { name: 'Застосувати план' })).toBeEnabled();
  expect(fixture.prepareBodies).toHaveLength(1);
});

test('explains insufficient useful source passages and keeps manual outline notes', async ({ page }) => {
  const fixture = await installSourceOutlineFixture(page, 'irrelevant');
  await page.goto(briefUrl);
  await page.getByRole('button', { name: 'Додати розділ' }).click();
  await page.locator('#outline-heading').fill('Мій план');
  await page.getByRole('button', { name: 'Створити план із джерел' }).click();
  await expect(page.getByText('Серед перевірених уривків немає достатньої опори для цього плану.', { exact: false })).toBeVisible({ timeout: 8_000 });
  await expect(page.locator('#outline-heading')).toHaveValue('Мій план');
  expect(fixture.violations).toEqual([]);
});

test('factual outline uses source passages directly and preserves manual edits', async ({ page }) => {
  test.setTimeout(30_000);
  const fixture = await installSourceOutlineFixture(page);
  const legacyRequests: string[] = [];
  page.on('request', request => {
    const path = new URL(request.url()).pathname;
    if (/\/(?:claims|factual-basis)(?:\/|$)/u.test(path)) legacyRequests.push(path);
  });
  await page.goto(briefUrl);
  await expect(page.getByText('Бриф можна зберегти з темою.', { exact: false })).toBeVisible();
  await expect(page.getByText(/затверджених фактів|обов’язкові факти/iu)).toHaveCount(0);
  await expect(page.locator('.brief-claims')).toHaveCount(0);

  await page.getByRole('button', { name: 'Додати розділ' }).click();
  await page.locator('#outline-heading').fill('Мій незбережений план');
  await page.locator('#outline-title-0').fill('Чернетковий розділ');
  await page.locator('#outline-purpose-0').fill('Текст, який потрібно зберегти під час підготовки джерел.');

  await page.getByRole('button', { name: 'Створити план із джерел' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Готуємо джерела до пошуку' })).toBeVisible();
  await expect.poll(() => fixture.prepareBodies.length).toBe(1);
  await expect(page.getByRole('status').filter({ hasText: 'Шукаємо в джерелах уривки' })).toBeVisible({ timeout: 8_000 });
  await expect(page.getByText('Пропозиція плану готова до перегляду.')).toBeVisible({ timeout: 12_000 });
  await expect(page.locator('#outline-heading')).toHaveValue('Мій незбережений план');
  await expect(page.locator('#outline-title-0')).toHaveValue('Чернетковий розділ');

  const candidate = page.locator('.brief-candidate');
  await expect(candidate.getByText('Пропозиція AI · Не застосовано')).toBeVisible();
  await candidate.locator('summary').click();
  await expect(candidate.getByText('У плані використано 1 уривок із джерел.')).toBeVisible();
  await expect(candidate.getByRole('button', { name: 'Застосувати план' })).toBeVisible();
  await expect(page.getByText(/фактична основа|затверджені факти|обов’язкові факти/iu)).toHaveCount(0);
  await expect(page.locator('.brief-claims')).toHaveCount(0);
  expect(legacyRequests).toEqual([]);
  expect(fixture.violations).toEqual([]);
  expect(fixture.calls).toContain('prepare');
  await page.screenshot({ path: test.info().outputPath('desktop.png'), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: test.info().outputPath('mobile.png'), fullPage: true });
});

test('source outline preparation can be cancelled while keeping the manual outline draft', async ({ page }) => {
  const fixture = await installSourceOutlineFixture(page, 'cancel');
  await page.goto(briefUrl);
  await page.getByRole('button', { name: 'Додати розділ' }).click();
  await page.locator('#outline-heading').fill('Чернетка перед скасуванням');
  await page.locator('#outline-title-0').fill('Початковий розділ');
  await page.locator('#outline-purpose-0').fill('Збережіть ці нотатки.');
  await page.getByRole('button', { name: 'Створити план із джерел' }).click();
  await expect(page.getByRole('button', { name: 'Скасувати підготовку' })).toBeVisible();
  await page.getByRole('button', { name: 'Скасувати підготовку' }).click();
  await expect(page.getByText('Підготовку скасовано.')).toBeVisible();
  await expect(page.getByText(/Попередні записи та поточний план залишилися без змін/u)).toBeVisible();
  await expect(page.locator('#outline-heading')).toHaveValue('Чернетка перед скасуванням');
  await expect(page.locator('#outline-title-0')).toHaveValue('Початковий розділ');
  expect(fixture.calls).toContain('cancel');
  expect(fixture.violations).toEqual([]);
});

test('source search failure explains recovery and retains the unsaved manual outline', async ({ page }) => {
  const fixture = await installSourceOutlineFixture(page, 'fail');
  await page.goto(briefUrl);
  await page.getByRole('button', { name: 'Додати розділ' }).click();
  await page.locator('#outline-heading').fill('План після помилки');
  await page.locator('#outline-title-0').fill('Розділ після помилки');
  await page.locator('#outline-purpose-0').fill('Ручний текст не має зникати.');
  await page.getByRole('button', { name: 'Створити план із джерел' }).click();
  await expect(page.getByText('Не вдалося знайти придатні уривки у вибраних джерелах.', { exact: false })).toBeVisible({ timeout: 8_000 });
  await expect(page.locator('#outline-heading')).toHaveValue('План після помилки');
  await expect(page.locator('#outline-purpose-0')).toHaveValue('Ручний текст не має зникати.');
  await expect(page.getByRole('button', { name: 'Спробувати знову' })).toBeVisible();
  expect(fixture.violations).toEqual([]);
});

