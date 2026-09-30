import { mkdirSync, writeFileSync } from 'node:fs';
import { test, expect, type Page } from '@playwright/test';

const SCREENSHOT_DIR = '.codex/artifacts/m22';
const now = '2026-09-29T10:00:00.000Z';

async function capture(page: Page, state: string) {
  for (const width of [1440, 1280, 768, 390]) {
    await page.setViewportSize({ width, height: 900 });
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: `${SCREENSHOT_DIR}/imports-${state}-${width}.png`, fullPage: true });
  }
  await page.setViewportSize({ width: 1440, height: 900 });
}

test('import progress, immutable comparison, failure recovery and explicit uncertain restart', async ({ page }) => {
  test.setTimeout(90_000);
  mkdirSync(SCREENSHOT_DIR, { recursive: true });
  const browserErrors: string[] = [];
  page.on('pageerror', error => browserErrors.push(error.message));
  const nonce = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  await page.goto('/');
  await page.getByRole('button', { name: 'Реєстрація' }).click();
  await page.getByLabel(/Ваше ім’я/).fill('M22 Imports Test');
  await page.getByLabel('Електронна пошта').fill(`m22-imports-${nonce}@example.test`);
  await page.getByLabel('Пароль').fill('TestOnly!ContextFlow2026');
  await page.getByRole('button', { name: 'Створити обліковий запис' }).click();
  await expect(page.getByText('Вітаємо, M22 Imports Test')).toBeVisible({ timeout: 20_000 });
  await page.getByRole('button', { name: 'Погодитися на зовнішню обробку' }).click();
  await page.goto('/projects');
  await page.getByRole('button', { name: 'Новий простір' }).click();
  await page.getByLabel('Назва простору').fill(`M22 Imports ${nonce}`);
  await page.getByRole('button', { name: 'Створити простір' }).click();
  await page.getByRole('button', { name: 'Створити проєкт', exact: true }).click();
  await page.getByLabel('Тема проєкту').fill(`M22 import project ${nonce}`);
  await page.getByRole('checkbox', { name: 'Публікація у LinkedIn', exact: true }).check();
  await page.getByRole('button', { name: 'Створити проєкт', exact: true }).last().click();
  await page.getByRole('button', { name: 'Відкрити джерела' }).click();
  await expect(page).toHaveURL(/\/projects\/[0-9a-f-]+\/sources$/i);
  const projectId = new URL(page.url()).pathname.split('/')[2]!;
  const base = `/api/v1/projects/${projectId}`;
  const urlMaterial = { id: 'url-material', projectId, label: 'Дослідження українською', kind: 'URL', purpose: 'FACTUAL_SOURCE', included: true, revision: 0, currentSnapshotId: null as string | null, sourceUrl: 'https://example.test/research', originalAssetId: null, originalFilename: null, createdAt: now, updatedAt: now };
  const fileMaterial = { ...urlMaterial, id: 'file-material', label: 'Сканований документ', kind: 'FILE', sourceUrl: null, originalAssetId: 'scan-original', originalFilename: 'scan.pdf' };
  const original = { id: 'url-copy-1', projectId, materialId: urlMaterial.id, sequence: 1, normalizedText: 'Українські абзаци збережено.\n\nРезультат дослідження: 12 учасників.', origin: 'WEB_IMPORT', sha256: 'first-hash', bytes: 100, previousSnapshotId: null, fragments: [], createdAt: now, createdBy: 'M22 Imports Test', originalAssetId: null, originalFilename: null, providerMetadata: { provider: 'Firecrawl', retrievedAt: now }, jobId: 'url-job' };
  const changed = { ...original, id: 'url-copy-2', sequence: 2, normalizedText: 'Українські абзаци збережено.\n\nРезультат дослідження: 15 учасників.', sha256: 'changed-hash', previousSnapshotId: original.id };
  const manual = { ...original, id: 'manual-copy', materialId: fileMaterial.id, normalizedText: 'Вручну внесено текст зі сканованого оригіналу.', origin: 'MANUAL_TEXT', originalAssetId: fileMaterial.originalAssetId, originalFilename: fileMaterial.originalFilename };
  const copies = [original, changed, manual];
  const materials: (typeof urlMaterial | typeof fileMaterial)[] = [];
  const jobs: { id: string; operation: string; status: string; progressStage: string; attemptCount: number; maxAttempts: number; retryAllowed: boolean; providerOutcome: string; errorCategory: string | null; inputSummary: { materialId: string; label: string }; resultRefs: { materialId: string; snapshotId: string } | null; createdAt: string; updatedAt: string }[] = [];
  const commands: string[] = [];
  let pollingTouchesSession = false;
  let retryCount = 0;
  let cancelCount = 0;
  let loseReimportResponse = false;

  // Provider/job endpoints are deterministic UI doubles. Backend worker and
  // storage invariants are covered by the real integration corpus separately.
  await page.route(`**${base}/**`, async route => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname.slice(base.length);
    const json = (body: unknown, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    if (path === '/jobs') {
      pollingTouchesSession ||= request.headers()['x-session-activity'] !== undefined;
      return json({ jobs });
    }
    if (path.endsWith('/retry')) { retryCount += 1; jobs[1]!.status = 'QUEUED'; jobs[1]!.retryAllowed = false; return json({ job: jobs[1] }); }
    if (path.endsWith('/cancel')) { cancelCount += 1; jobs[1]!.status = 'CANCELLED'; return json({ job: jobs[1] }); }
    if (path === '/materials' && request.method() === 'GET') return json({ materials });
    if (path === '/materials/url') {
      const body = request.postDataJSON() as { url: string; commandKey: string };
      expect(body.url).toBe(urlMaterial.sourceUrl);
      commands.push(body.commandKey);
      materials.push(urlMaterial);
      jobs.push({ id: 'url-job', operation: 'WEB_IMPORT', status: 'QUEUED', progressStage: 'WAITING', attemptCount: 0, maxAttempts: 3, retryAllowed: false, providerOutcome: 'NOT_SUBMITTED', errorCategory: null, inputSummary: { materialId: urlMaterial.id, label: urlMaterial.label }, resultRefs: null, createdAt: now, updatedAt: now });
      return json({ material: urlMaterial, job: jobs[0] }, 202);
    }
    if (path === '/materials/document') {
      expect(request.postData()).toContain('scan.pdf');
      expect(request.postData()).toContain('commandKey');
      materials.push(fileMaterial);
      jobs.push({ ...jobs[0]!, id: 'file-job', operation: 'DOCUMENT_IMPORT', status: 'FAILED', progressStage: 'CALLING_PROVIDER', attemptCount: 1, errorCategory: 'NO_TEXT', providerOutcome: 'KNOWN_FAILED', inputSummary: { materialId: fileMaterial.id, label: fileMaterial.label }, resultRefs: null });
      return json({ material: fileMaterial, job: jobs[1] }, 202);
    }
    if (path.endsWith('/reimport')) {
      const body = request.postDataJSON() as { expectedRevision: number; commandKey: string };
      expect(body.expectedRevision).toBe(urlMaterial.revision);
      commands.push(body.commandKey);
      jobs[0] = { ...jobs[0]!, id: `url-job-${commands.length}`, status: 'QUEUED', progressStage: 'WAITING', resultRefs: null };
      if (loseReimportResponse) {
        jobs[0]!.status = 'OUTCOME_UNKNOWN'; jobs[0]!.providerOutcome = 'UNKNOWN';
        return json({ message: 'Accepted execution response was lost' }, 503);
      }
      return json({ material: urlMaterial, job: jobs[0] }, 202);
    }
    if (path.endsWith('/compare')) {
      const left = copies.find(copy => copy.id === url.searchParams.get('left'))!;
      const right = copies.find(copy => copy.id === url.searchParams.get('right'))!;
      return json({ left, right, identical: left.sha256 === right.sha256 });
    }
    if (path === `/materials/${fileMaterial.id}/snapshots` && request.method() === 'POST') {
      const body = request.postDataJSON() as { text: string; expectedRevision: number };
      expect(body.expectedRevision).toBe(fileMaterial.revision);
      manual.normalizedText = body.text;
      fileMaterial.revision += 1;
      fileMaterial.currentSnapshotId = manual.id;
      return json({ material: fileMaterial, snapshot: manual });
    }
    if (path.includes('/snapshots/')) return json({ snapshot: copies.find(copy => copy.id === path.split('/').at(-1)) });
    if (path.startsWith('/materials/')) {
      const material = materials.find(item => item.id === path.split('/')[2]);
      return json({ material, snapshots: copies.filter(copy => copy.materialId === material?.id && (copy.id === material.currentSnapshotId || (material.currentSnapshotId === changed.id && copy.id === original.id))).reverse(), jobs: jobs.filter(job => job.inputSummary.materialId === material?.id) });
    }
    return route.continue();
  });

  await page.getByRole('button', { name: 'Посилання', exact: true }).click();
  await page.getByLabel('Назва', { exact: true }).fill(urlMaterial.label);
  await page.getByLabel('Посилання на сторінку').fill(urlMaterial.sourceUrl!);
  await page.getByRole('button', { name: 'Додати джерело' }).click();
  await expect(page.getByText('Очікує обробки', { exact: true })).toBeVisible();
  jobs[0]!.status = 'RUNNING'; jobs[0]!.progressStage = 'PROCESSING';
  await expect(page.locator('.import-stage')).toContainText('Виділення тексту', { timeout: 5000 });
  await capture(page, 'running');
  urlMaterial.currentSnapshotId = original.id; urlMaterial.revision = 1;
  jobs[0]!.status = 'SUCCEEDED'; jobs[0]!.resultRefs = { materialId: urlMaterial.id, snapshotId: original.id };
  await expect(page.locator('.source-plain-text')).toContainText('12 учасників', { timeout: 5000 });
  await page.locator('.source-metadata > summary').click();
  await expect(page.getByRole('link', { name: 'Перейти до оригіналу' })).toHaveAttribute('href', urlMaterial.sourceUrl!);
  await page.locator('.source-metadata > summary').click();
  await page.getByRole('button', { name: 'Імпортувати знову' }).click();
  await expect(page.getByText('Очікує обробки', { exact: true })).toBeVisible();
  await expect(page.locator('.source-plain-text')).toContainText('12 учасників');
  urlMaterial.currentSnapshotId = changed.id; urlMaterial.revision = 2;
  jobs[0]!.status = 'SUCCEEDED'; jobs[0]!.resultRefs = { materialId: urlMaterial.id, snapshotId: changed.id };
  await expect(page.locator('.source-plain-text')).toContainText('15 учасників', { timeout: 5000 });
  const compareButton = page.getByRole('button', { name: 'Порівняти версії' });
  await compareButton.focus(); await page.keyboard.press('Enter');
  await expect(page.locator('.comparison-copies')).toContainText('12 учасників');
  await expect(page.locator('.comparison-copies')).toContainText('15 учасників');
  await capture(page, 'comparison');
  await page.getByRole('combobox', { name: 'Попередня копія' }).focus();
  await page.keyboard.press('Escape');
  await expect(compareButton).toBeFocused();
  await compareButton.click();
  await page.getByRole('combobox', { name: 'Попередня копія' }).selectOption(changed.id);
  await page.getByRole('button', { name: 'Порівняти', exact: true }).click();
  await expect(page.getByText('Текст обох копій однаковий. Кожна версія збережена окремо.')).toBeVisible();
  await page.getByRole('button', { name: 'Закрити порівняння' }).click();

  await page.getByRole('button', { name: 'PDF / DOCX' }).click();
  await page.getByLabel('Назва', { exact: true }).fill(fileMaterial.label);
  await page.locator('#source-file').setInputFiles({ name: 'scan.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.7 synthetic browser fixture') });
  await page.getByRole('button', { name: 'Додати джерело' }).click();
  await expect(page.locator('.import-message')).toContainText('немає доступного тексту');
  await capture(page, 'no-text');
  await page.locator('.import-jobs').getByRole('button', { name: 'Ввести текст вручну' }).click();
  const fallback = page.getByLabel('Текст із оригінального джерела');
  await expect(fallback).toBeFocused();
  await fallback.fill(manual.normalizedText);
  await page.getByRole('button', { name: 'Зберегти нову версію' }).click();
  await expect(page.locator('.source-plain-text')).toContainText('Вручну внесено');
  await expect(page.getByRole('button', { name: 'Завантажити оригінал' })).toBeVisible();

  jobs[1]!.errorCategory = 'TRANSIENT_TRANSPORT'; jobs[1]!.retryAllowed = true;
  await page.getByRole('button', { name: 'Оновити стан' }).click();
  await page.getByRole('button', { name: 'Повторити спробу' }).click();
  expect(retryCount).toBe(1);
  await page.getByRole('button', { name: 'Скасувати імпорт' }).click();
  expect(cancelCount).toBe(1);
  jobs[0]!.status = 'OUTCOME_UNKNOWN'; jobs[0]!.errorCategory = 'TIMEOUT'; jobs[0]!.providerOutcome = 'UNKNOWN';
  await page.getByRole('button', { name: 'Оновити стан' }).click();
  await expect(page.getByText(/Новий запуск може спричинити повторну оплату/)).toBeVisible();
  await capture(page, 'unknown');
  writeFileSync(`${SCREENSHOT_DIR}/imports-accessibility.yml`, await page.locator('.sources-workspace').ariaSnapshot());
  const commandCount = commands.length;
  loseReimportResponse = true;
  await page.locator('.import-list').getByRole('button', { name: 'Запустити знову', exact: true }).first().click();
  expect(commands.length).toBe(commandCount);
  await page.getByRole('button', { name: 'Підтвердити новий запуск' }).click();
  expect(commands.length).toBe(commandCount + 1);
  await expect(page.getByRole('alert')).toContainText('тимчасово недоступний');
  loseReimportResponse = false;
  await page.getByRole('button', { name: 'Оновити стан' }).click();
  await page.locator('.import-list').getByRole('button', { name: 'Запустити знову', exact: true }).first().click();
  await page.getByRole('button', { name: 'Підтвердити новий запуск' }).click();
  expect(commands.length).toBe(commandCount + 2);
  expect(new Set(commands).size).toBe(commands.length);
  expect(pollingTouchesSession).toBe(false);
  expect(browserErrors).toEqual([]);
});
