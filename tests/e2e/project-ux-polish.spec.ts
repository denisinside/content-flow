import { test, expect, type Page } from '@playwright/test';
import { installM63Fixture, projectId } from './fixtures/m63-editorial.js';

const base = '/api/v1/projects/' + projectId;
const exportItems = [
  { format: 'ARTICLE', title: 'Стаття', revisionId: 'article-1', number: 1, reviewCounter: 0, contentMode: 'FACTUAL', ready: true, reasons: [] },
  { format: 'LINKEDIN_CAROUSEL_SCRIPT', title: 'Сценарій', revisionId: null, number: null, reviewCounter: null, contentMode: null, ready: false, reasons: ['APPROVAL_REQUIRED'] },
  { format: 'LINKEDIN_COVER_VISUAL', title: 'Візуал', revisionId: null, number: null, reviewCounter: null, contentMode: null, ready: false, reasons: ['PARENT_NOT_APPROVED'] },
];
async function setup(page: Page) {
  const ctx = await installM63Fixture(page);
  let readinessRequests = 0;
  await page.route('**' + base + '/exports*', async route => {
    const view = new URL(route.request().url()).searchParams.get('view');
    if (view !== 'history') readinessRequests++;
    await route.fulfill({ json: { projectRevision: 1, ready: false, items: view === 'history' ? [] : exportItems, exports: [] } });
  });
  return { ...ctx, getReadinessRequests: () => readinessRequests };
}
test('overview shows real progress and reuses readiness when opening export', async ({ page }) => {
  const ctx = await setup(page);
  await page.goto('/projects/' + projectId);
  await expect(page.getByRole('heading', { name: 'Етапи проєкту' })).toBeVisible();
  await expect(page.locator('.project-step-row')).toHaveCount(7);
  await expect(page.locator('.project-step-row').filter({ hasText: 'Джерела' })).toContainText('1 джерело');
  await expect(page.locator('.project-step-row').filter({ hasText: 'Готовність і експорт' })).toContainText('1 з 3 готово');
  expect(ctx.getReadinessRequests()).toBe(1);
  await page.locator('.project-step-row').filter({ hasText: 'Готовність і експорт' }).click();
  await expect(page.getByRole('heading', { name: 'Матеріали проєкту' })).toBeVisible();
  await expect(page.locator('.export-item')).toHaveCount(3);
  await expect(page.locator('.export-group-title')).toHaveText(['Готові до експорту', 'Потрібні дії']);
  expect(ctx.getReadinessRequests()).toBe(1);
  await page.getByRole('button', { name: 'Оновити перевірку' }).click();
  await expect.poll(ctx.getReadinessRequests).toBe(2);
  await page.getByRole('button', { name: 'Потребують дій (2)' }).click();
  await expect(page.locator('.export-item')).toHaveCount(2);
  await expect(page.locator('.export-reasons-list')).toHaveCount(2);
  await expect(page.getByRole('button', { name: 'Підготувати та погодити' })).toHaveCount(1);
  await page.getByRole('button', { name: 'Готові (1)' }).click();
  await expect(page.locator('.export-item')).toHaveCount(1);
  expect(ctx.pageErrors).toEqual([]);
});
test('source and evidence list filtering leaves selections intact', async ({ page }) => {
  const ctx = await setup(page);
  await page.route('**' + base + '/evidence', route => route.fulfill({ json: {
    configuration: { configured: true },
    materials: [
      { id: 'source-1', label: 'Звіт про щоденні поїздки', snapshotId: 'snapshot-1', snapshotSequence: 1, indexState: 'READY', chunkCount: 2, readyChunkCount: 2 },
      { id: 'source-2', label: 'Зовсім інше джерело', snapshotId: 'snapshot-2', snapshotSequence: 1, indexState: 'MISSING', chunkCount: 0, readyChunkCount: 0 },
    ],
  } }));
  await page.goto('/projects/' + projectId + '/sources');
  await expect(page.getByRole('searchbox', { name: 'Пошук серед джерел' })).toBeVisible();
  await expect(page.locator('.source-items li')).toHaveCount(1);
  await page.getByRole('searchbox', { name: 'Пошук серед джерел' }).fill('немає-такого');
  await expect(page.getByText('За цими фільтрами джерел немає.')).toBeVisible();
  await page.getByRole('button', { name: 'Скинути фільтри' }).click();
  await expect(page.locator('.source-items li')).toHaveCount(1);
  await page.getByRole('link', { name: 'Докази' }).click();
  await expect(page.getByRole('heading', { name: 'Джерела', exact: true })).toBeVisible();
  const sourceDetails = page.locator('.evidence-source-disclosure');
  await expect(sourceDetails).toBeVisible();
  if (!(await sourceDetails.evaluate(element => (element as HTMLDetailsElement).open))) await sourceDetails.locator('summary').click();
  await expect(page.getByRole('searchbox', { name: 'Знайти джерело для пошуку' })).toBeVisible();
  await page.getByRole('searchbox', { name: 'Знайти джерело для пошуку' }).fill('немає-такого');
  await expect(page.getByText('Немає джерел за вибраними фільтрами.')).toBeVisible();
  await page.getByRole('searchbox', { name: 'Знайти джерело для пошуку' }).fill('');
  await expect(page.locator('.evidence-material-list li')).toHaveCount(2);
  expect(ctx.pageErrors).toEqual([]);
});
test('mobile project progress and export actions do not overflow viewport', async ({ page }) => {
  await setup(page);
  await page.setViewportSize({ width: 390, height: 820 });
  await page.goto('/projects/' + projectId);
  await expect(page.getByRole('heading', { name: 'Етапи проєкту' })).toBeVisible();
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.locator('.project-step-row').filter({ hasText: 'Готовність і експорт' }).click();
  await expect(page.locator('.export-item')).toHaveCount(3);
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});


test('large source and evidence collections reveal more rows without changing selection', async ({ page }) => {
  await setup(page);
  const materials = Array.from({ length: 32 }, (_, index) => ({
    id: 'source-' + index, projectId, kind: 'TEXT', purpose: 'FACTUAL_SOURCE',
    label: 'Джерело № ' + String(index + 1).padStart(2, '0'),
    included: index % 2 === 0, revision: 1, currentSnapshotId: 'snapshot-' + index,
    createdAt: '2026-10-09T10:00:00Z', updatedAt: '2026-10-09T10:00:00Z',
  }));
  await page.route('**' + base + '/materials', route => route.fulfill({ json: { materials } }));
  await page.route('**' + base + '/evidence', route => route.fulfill({ json: {
    configuration: { configured: true },
    materials: materials.map(item => ({
      id: item.id, label: item.label, snapshotId: item.currentSnapshotId,
      snapshotSequence: 1, indexState: 'READY', chunkCount: 1, readyChunkCount: 1,
    })),
  } }));
  await page.goto('/projects/' + projectId + '/sources');
  await expect(page.locator('.source-items li')).toHaveCount(25);
  await expect(page.getByRole('button', { name: 'Показати ще (7)' })).toBeVisible();
  await page.getByRole('button', { name: 'Показати ще (7)' }).click();
  await expect(page.locator('.source-items li')).toHaveCount(32);
  await page.getByRole('link', { name: 'Докази' }).click();
  const details = page.locator('.evidence-source-disclosure');
  await expect(details).toBeVisible();
  if (!(await details.evaluate(node => (node as HTMLDetailsElement).open))) await details.locator('summary').click();
  await expect(page.locator('.evidence-material-list li')).toHaveCount(25);
  await page.getByRole('button', { name: 'Показати ще (7)' }).click();
  await expect(page.locator('.evidence-material-list li')).toHaveCount(32);
  await page.getByRole('combobox', { name: 'Фільтр джерел для пошуку' }).selectOption('SELECTED');
  await expect(page.locator('.evidence-material-list li')).toHaveCount(25);
  // Visibility filter must not accidentally change the underlying selected snapshots.
  await page.getByRole('combobox', { name: 'Фільтр джерел для пошуку' }).selectOption('NEEDS_INDEX');
  await expect(page.getByText('Немає джерел за вибраними фільтрами.')).toBeVisible();
  await page.getByRole('combobox', { name: 'Фільтр джерел для пошуку' }).selectOption('ALL');
  await expect(page.locator('.evidence-material-list li')).toHaveCount(25);
});
