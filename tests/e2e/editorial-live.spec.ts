import { mkdirSync, writeFileSync } from 'node:fs';
import { test, expect, type Page, type APIResponse } from '@playwright/test';

const ARTIFACTS = '.codex/artifacts/m31';
interface BriefRevision { id: string; number: number; contentMode: string; topic: string; notes: string; tone: string; workspaceStyleRevision: number; requiredClaims: { claimRevisionId: string }[] }
interface OutlineRevision { id: string; number: number; status: string; origin: string; approvedBy: string | null; approvedAt: string | null; briefRevisionId: string; content: { title: string; sections: { title: string; purpose: string; claimRevisionIds: string[] }[] } }
interface Editorial { brief: { revision: number; currentRevision: BriefRevision; history: BriefRevision[] } | null; outline: { revision: number; currentRevision: OutlineRevision; currentApprovedRevisionId: string | null; revisions: OutlineRevision[] } | null; style: { revision: number }; prerequisites: { missingBasis: boolean; eligibleClaims: { currentRevisionId: string }[] } }
async function checked<T>(response: APIResponse): Promise<T> {
  const body = await response.text();
  expect(response.ok(), `${response.url()} returned ${response.status()}: ${body}`).toBe(true);
  return JSON.parse(body) as T;
}
async function capture(page: Page, state: string) {
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 900 });
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: `${ARTIFACTS}/brief-live-${state}-${width}.png`, fullPage: true });
  }
  await page.setViewportSize({ width: 1440, height: 900 });
}

test('real editorial APIs persist brief modes, immutable outline approvals and exact required evidence', async ({ page }) => {
  test.setTimeout(120_000);
  mkdirSync(ARTIFACTS, { recursive: true });
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  const nonce = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const displayName = `M31 Live ${nonce.slice(-6)}`;
  const topic = `Редакційна перевірка міської мобільності ${nonce}`;
  await page.goto('/');
  await page.getByRole('button', { name: 'Реєстрація' }).click();
  await page.getByLabel(/Ваше ім’я/).fill(displayName);
  await page.getByLabel('Електронна пошта').fill(`m31-live-${nonce}@example.test`);
  await page.getByLabel('Пароль').fill('TestOnly!ContextFlow2026');
  await page.getByRole('button', { name: 'Створити обліковий запис' }).click();
  await expect(page.locator('#account-title')).toHaveText(displayName, { timeout: 20_000 });
  await page.goto('/settings#external-processing-notice');
  await page.getByRole('checkbox', { name: 'Я прочитав(-ла) повідомлення й погоджуюся на зовнішню обробку матеріалів.', exact: true }).check();
  await page.getByRole('button', { name: 'Погодитися на зовнішню обробку' }).click();
  await expect(page.getByText('Зовнішня обробка · Згоду збережено', { exact: true })).toBeVisible();
  await page.goto('/projects');
  const session = await checked<{ authenticated: boolean; csrfToken: string; user: { id: string } }>(await page.request.get('/api/auth/session'));
  expect(session.authenticated).toBe(true);
  const headers = { 'X-CSRF-Token': session.csrfToken, Origin: new URL(page.url()).origin };
  await page.goto('/projects');
  await page.getByRole('button', { name: 'Новий простір' }).click();
  await page.getByRole('button', { name: 'Створити новий простір', exact: true }).click();
  await page.getByLabel('Назва простору').fill(`M31 Live ${nonce}`);
  await page.getByRole('button', { name: 'Створити простір' }).click();
  await page.getByRole('button', { name: 'Створити проєкт', exact: true }).click();
  await page.getByLabel('Назва й тема проєкту').fill(topic);
  await page.getByRole('checkbox', { name: 'Стаття', exact: true }).check();
  await page.getByRole('button', { name: 'Створити проєкт', exact: true }).last().click();
  await expect(page.getByRole('heading', { name: topic, exact: true })).toBeVisible();
  const projectId = new URL(page.url()).pathname.split('/')[2]!;
  const base = `/api/v1/projects/${projectId}`;
  await page.getByRole('link', { name: 'Бриф', exact: true }).click();
  await expect(page.getByText(/Немає придатної затвердженої фактичної/)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Запропонувати план' })).toBeDisabled();
  const initial = await checked<Editorial>(await page.request.get(`${base}/editorial`));
  expect(initial.brief).toBeNull();
  expect(initial.outline).toBeNull();
  expect(initial.prerequisites.missingBasis).toBe(true);
  await capture(page, 'missing-basis');

  await page.getByLabel('Творчий матеріал', { exact: true }).check();
  await page.getByLabel('Аудиторія', { exact: true }).fill('Мешканці міста');
  await page.getByLabel('Головне повідомлення').fill('Доступна мобільність починається з повсякденного досвіду.');
  await page.getByLabel('Авторські нотатки').fill('Почати зі сцени ранкової поїздки.');
  await page.getByRole('button', { name: 'Зберегти бриф', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Зберегти бриф', exact: true })).toBeDisabled();
  const creative = await checked<Editorial>(await page.request.get(`${base}/editorial`));
  expect(creative.brief!.currentRevision).toMatchObject({ number: 1, contentMode: 'CREATIVE', topic, notes: 'Почати зі сцени ранкової поїздки.', workspaceStyleRevision: creative.style.revision });
  expect(creative.brief!.currentRevision.requiredClaims).toEqual([]);
  await page.reload();
  await expect(page.getByLabel('Авторські нотатки')).toHaveValue('Почати зі сцени ранкової поїздки.');
  await expect(page.getByText(/Без перевіреної фактологічної/)).toBeVisible();
  await page.getByRole('button', { name: 'Додати розділ' }).click();
  await page.getByLabel('Назва розділу', { exact: true }).fill('Ранок у дорозі');
  await page.getByLabel('Про що цей розділ', { exact: true }).fill('Описати поїздку очима мешканця.');
  await page.getByRole('button', { name: 'Зберегти план', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Схвалити план' })).toBeEnabled();
  await page.getByRole('button', { name: 'Схвалити план' }).click();
  await expect(page.getByText('План схвалено', { exact: true })).toBeVisible();
  const approved = await checked<Editorial>(await page.request.get(`${base}/editorial`));
  const firstOutline = approved.outline!.currentRevision;
  expect(firstOutline).toMatchObject({ status: 'APPROVED', origin: 'MANUAL', approvedBy: session.user.id, briefRevisionId: creative.brief!.currentRevision.id });
  expect(firstOutline.approvedAt).toBeTruthy();
  expect(approved.outline!.currentApprovedRevisionId).toBe(firstOutline.id);
  await page.reload();
  await expect(page.getByText('План схвалено', { exact: true })).toBeVisible();
  await expect(page.getByLabel('Назва розділу', { exact: true })).toHaveValue('Ранок у дорозі');
  await capture(page, 'approved');
  await page.locator('.outline-edit > summary').click();
  await page.getByLabel('Назва розділу', { exact: true }).fill('Новий погляд на ранкову поїздку');
  await page.getByRole('button', { name: 'Зберегти план', exact: true }).click();
  await expect(page.getByText('Структура потребує перегляду', { exact: true })).toBeVisible();
  const edited = await checked<Editorial>(await page.request.get(`${base}/editorial`));
  expect(edited.outline!.currentRevision).toMatchObject({ number: 2, status: 'PROPOSED', approvedAt: null });
  expect(edited.outline!.currentRevision.id).not.toBe(firstOutline.id);
  expect(edited.outline!.revisions.find(row => row.id === firstOutline.id)).toMatchObject({ status: 'APPROVED', approvedBy: session.user.id, content: firstOutline.content });
  expect(edited.outline!.currentApprovedRevisionId).toBe(firstOutline.id);

  // Prepare genuine reviewed evidence through the existing APIs, with this test's session and exact capture.
  await page.getByRole('link', { name: 'Джерела', exact: true }).click();
  const sourceText = 'У міському дослідженні взяли участь 12 мешканців.';
  await page.getByLabel('Назва', { exact: true }).fill('Джерело M31 live');
  await page.getByLabel('Текст джерела').fill(sourceText);
  await page.getByRole('button', { name: 'Додати джерело' }).click();
  await expect(page.locator('.source-plain-text')).toContainText(sourceText);
  const materials = await checked<{ materials: { id: string; currentSnapshotId: string }[] }>(await page.request.get(`${base}/materials`));
  const material = materials.materials[0]!;
  const captured = await checked<{ snapshot: { id: string; normalizedText: string; fragments: { id: string; startOffset: number; endOffset: number; sha256: string }[] } }>(await page.request.get(`${base}/materials/${material.id}/snapshots/${material.currentSnapshotId}`));
  const fragment = captured.snapshot.fragments[0]!;
  const created = await checked<{ claim: { id: string; revision: number; currentRevisionId: string } }>(await page.request.post(`${base}/claims`, { headers, data: { wording: sourceText, evidence: [{ snapshotId: captured.snapshot.id, fragmentId: fragment.id, startOffset: fragment.startOffset, endOffset: fragment.endOffset, quote: captured.snapshot.normalizedText.slice(fragment.startOffset, fragment.endOffset), sha256: fragment.sha256, relation: 'SUPPORTS' }] } }));
  const claim = created.claim;
  await checked(await page.request.post(`${base}/claims/${claim.id}/revisions/${claim.currentRevisionId}/approve`, { headers, data: { expectedRevision: claim.revision } }));
  await checked(await page.request.post(`${base}/basis`, { headers, data: { claimRevisionIds: [claim.currentRevisionId] } }));
  await page.getByRole('link', { name: 'Бриф', exact: true }).click();
  await page.getByLabel('На перевірених фактах', { exact: true }).check();
  await page.getByRole('group', { name: 'Обов’язкові факти', exact: true }).getByRole('checkbox', { name: sourceText, exact: true }).check();
  await page.getByRole('button', { name: 'Зберегти бриф', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Зберегти бриф', exact: true })).toBeDisabled();
  const factual = await checked<Editorial>(await page.request.get(`${base}/editorial`));
  expect(factual.brief!.currentRevision).toMatchObject({ contentMode: 'FACTUAL', number: 2, requiredClaims: [{ claimRevisionId: claim.currentRevisionId }] });
  expect(factual.prerequisites.missingBasis).toBe(false);
  await page.locator('.outline-edit > summary').click();
  await page.locator('.outline-section .brief-claims').getByRole('checkbox', { name: sourceText, exact: true }).check();
  await page.getByRole('button', { name: 'Зберегти план', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Схвалити план' })).toBeEnabled();
  await page.getByRole('button', { name: 'Схвалити план' }).click();
  await expect(page.getByText('План схвалено', { exact: true })).toBeVisible();
  const final = await checked<Editorial>(await page.request.get(`${base}/editorial`));
  expect(final.outline!.currentRevision).toMatchObject({ status: 'APPROVED', briefRevisionId: factual.brief!.currentRevision.id, content: { sections: [{ claimRevisionIds: [claim.currentRevisionId] }] } });
  expect(final.outline!.revisions.find(row => row.id === firstOutline.id)).toMatchObject({ status: 'APPROVED', content: firstOutline.content });
  await page.reload();
  await expect(page.getByText('План схвалено', { exact: true })).toBeVisible();
  await expect(page.getByRole('group', { name: 'Обов’язкові факти', exact: true }).getByRole('checkbox', { name: sourceText, exact: true })).toBeChecked();
  writeFileSync(`${ARTIFACTS}/brief-live-accessibility.yml`, await page.locator('.brief-workspace').ariaSnapshot());
  expect(errors).toEqual([]);
});
