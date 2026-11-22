import { expect, test } from '@playwright/test';
import { installBriefProposalFixture } from './fixtures/brief-proposal.js';
import { projectId } from './fixtures/m63-editorial.js';

const briefUrl = `/projects/${projectId}/brief`;

test('an incomplete AI proposal offers an editable starter without overwriting existing fields', async ({ page }) => {
  const fixture = await installBriefProposalFixture(page, 'needs-human');
  await page.goto(briefUrl);
  await page.locator('#brief-audience').fill('Моя аудиторія');
  await page.getByRole('button', { name: 'Запропонувати бриф' }).click();
  await page.getByRole('button', { name: 'Заповнити порожні поля' }).click();
  await expect(page.locator('#brief-audience')).toHaveValue('Моя аудиторія');
  await expect(page.locator('#brief-message')).not.toHaveValue('');
  expect(fixture.briefSaves).toHaveLength(0);
});

test('AI brief proposal is a reviewable draft and only the normal save persists it', async ({ page }) => {
  const fixture = await installBriefProposalFixture(page);
  await page.goto(briefUrl);
  await expect(page.getByRole('button', { name: 'Запропонувати бриф' })).toBeEnabled();
  await page.locator('#brief-audience').fill('Моя незбережена аудиторія');
  await page.getByRole('button', { name: 'Запропонувати бриф' }).click();

  await expect.poll(() => fixture.proposals.length).toBe(1);
  expect(fixture.proposals[0]).toMatchObject({ contentMode: 'FACTUAL', expectedRevision: 1,
    currentBrief: { audience: 'Моя незбережена аудиторія' } });
  await expect(page.getByText('Мешканці, які щодня їздять містом', { exact: true })).toBeVisible({ timeout: 10_000 });
  await expect(page.getByText('Враховано 1 джерело', { exact: false })).toBeVisible();
  await expect(page.locator('#brief-audience')).toHaveValue('Моя незбережена аудиторія');

  for (const [width, height] of [[1280, 900], [768, 1024], [390, 844]] as const) {
    await page.setViewportSize({ width, height });
    await expect(page.getByRole('button', { name: 'Використати пропозицію' })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
    await page.screenshot({ path: test.info().outputPath(`brief-proposal-${width}.png`), fullPage: true });
  }

  await page.locator('#brief-audience').fill('Змінена вручну після відповіді AI');
  await expect(page.getByRole('button', { name: 'Замінити поля пропозицією' })).toBeVisible();
  await page.getByRole('button', { name: 'Замінити поля пропозицією' }).click();

  await expect(page.locator('#brief-audience')).toHaveValue('Мешканці, які щодня їздять містом');
  await expect(page.locator('#brief-message')).toHaveValue('Пояснити щоденний досвід поїздок на прикладі учасників дослідження.');
  expect(fixture.briefSaves).toHaveLength(0);

  await page.getByRole('button', { name: 'Зберегти бриф' }).click();
  await expect.poll(() => fixture.briefSaves.length).toBe(1);
  expect(fixture.briefSaves[0]).toMatchObject({ audience: 'Мешканці, які щодня їздять містом',
    centralMessage: 'Пояснити щоденний досвід поїздок на прикладі учасників дослідження.' });
  expect((fixture.briefSaves[0] as { requiredClaimRevisionIds?: string[] }).requiredClaimRevisionIds ?? []).toEqual([]);
  expect(fixture.violations).toEqual([]);
});

test('stale AI brief proposal cannot overwrite the editor’s current draft', async ({ page }) => {
  const fixture = await installBriefProposalFixture(page, 'stale');
  await page.goto(briefUrl);
  await page.locator('#brief-audience').fill('Поточна ручна чернетка');
  await page.getByRole('button', { name: 'Запропонувати бриф' }).click();
  await expect.poll(() => fixture.proposals.length).toBe(1);
  await expect(page.getByText(/після запиту\. Створіть нову пропозицію/iu)).toBeVisible({ timeout: 10_000 });
  await expect(page.locator('#brief-audience')).toHaveValue('Поточна ручна чернетка');
  await expect(page.getByRole('button', { name: 'Використати пропозицію' })).toBeDisabled();
  expect(fixture.briefSaves).toHaveLength(0);
  expect(fixture.violations).toEqual([]);
});

test('pending proposal and manual draft survive a reload in this project and user session', async ({ page }) => {
  const fixture = await installBriefProposalFixture(page, 'pending');
  await page.goto(briefUrl);
  await page.locator('#brief-audience').fill('Чернетка до перезавантаження');
  await page.getByRole('button', { name: 'Запропонувати бриф' }).click();
  await expect.poll(() => fixture.proposals.length).toBe(1);
  await expect(page.getByText('Готуємо пропозицію брифу…')).toBeVisible();

  await page.reload();
  await expect(page.locator('#brief-audience')).toHaveValue('Чернетка до перезавантаження');
  await expect(page.getByText('Готуємо пропозицію брифу…')).toBeVisible({ timeout: 10_000 });
  expect(fixture.proposals).toHaveLength(1);
  expect(fixture.briefSaves).toHaveLength(0);
  expect(fixture.violations).toEqual([]);
});

test('manual topic-only brief can be saved without AI proposal configuration', async ({ page }) => {
  const fixture = await installBriefProposalFixture(page, 'unconfigured');
  await page.goto(briefUrl);
  await expect(page.getByText(/AI-пропозицію брифу ще не підключено/iu)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Запропонувати бриф' })).toBeDisabled();
  await page.locator('#brief-topic').fill('Нова тема без AI');
  await page.getByRole('button', { name: 'Зберегти бриф' }).click();
  await expect.poll(() => fixture.briefSaves.length).toBe(1);
  expect(fixture.briefSaves[0]).toMatchObject({ topic: 'Нова тема без AI', audience: '', centralMessage: '' });
  expect(fixture.proposals).toHaveLength(0);
  expect(fixture.violations).toEqual([]);
});
