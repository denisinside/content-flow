import { mkdirSync, writeFileSync } from 'node:fs';
import { test, expect, type Page } from '@playwright/test';

const ARTIFACTS = '.codex/artifacts/m23';
const PASSWORD = 'TestOnly!ContextFlow2026';

interface ClaimRevision {
  id: string;
  number: number;
  wording: string;
  status: 'PROPOSED' | 'APPROVED' | 'REJECTED';
  approvedBy: string | null;
  approvedAt: string | null;
  withdrawnAt: string | null;
  withdrawnBy: string | null;
  withdrawalReason: string | null;
  evidence: { id: string; snapshotId: string; fragmentId: string; quote: string; sha256: string; invalidatedAt: string | null }[];
}
interface ClaimDetail {
  claim: { id: string; revision: number; currentRevisionId: string; currentRevision: ClaimRevision };
  revisions: ClaimRevision[];
}
interface BasisResult {
  basis: { id: string; sequence: number; valid: boolean; blockingReasons: string[]; manifest: { schemaVersion: string; claims: { claimId: string; claimRevisionId: string; evidenceIds: string[] }[] } } | null;
  eligibleClaims: { id: string; currentRevisionId: string }[];
  missingBasis: boolean;
  blockingReasons: string[];
}

async function capture(page: Page, state: string): Promise<void> {
  for (const width of [1440, 1280, 768, 390]) {
    await page.setViewportSize({ width, height: 900 });
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: `${ARTIFACTS}/facts-live-${state}-${width}.png`, fullPage: true });
  }
  await page.setViewportSize({ width: 1440, height: 900 });
}

test('real Facts workflow persists exact evidence, immutable approvals and frozen basis history', async ({ page }) => {
  test.setTimeout(120_000);
  mkdirSync(ARTIFACTS, { recursive: true });
  const pageErrors: string[] = [];
  const factsResponses: { url: string; status: number; body?: string }[] = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  page.on('response', async response => {
    if (!/\/api\/v1\/projects\/[^/]+\/(claims|conflicts|basis|materials)/.test(response.url())) return;
    factsResponses.push({ url: response.url(), status: response.status(), ...(response.status() >= 400 ? { body: await response.text().catch(() => '<unreadable>') } : {}) });
  });
  const nonce = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const displayName = `M23 Live ${nonce.slice(-6)}`;
  const sourceText = `У дослідженні взяли участь 12 учасників. Вимірювання провели у вересні ${nonce}.`;
  const claimWording = 'У дослідженні взяли участь 12 учасників.';

  await page.goto('/');
  await page.getByRole('button', { name: 'Реєстрація' }).click();
  await page.getByLabel(/Ваше ім’я/).fill(displayName);
  await page.getByLabel('Електронна пошта').fill(`m23-live-${nonce}@example.test`);
  await page.getByLabel('Пароль').fill(PASSWORD);
  await page.getByRole('button', { name: 'Створити обліковий запис' }).click();
  await expect(page.locator('#account-title')).toHaveText(displayName, { timeout: 20_000 });
  const session = await (await page.request.get('/api/auth/session')).json() as { authenticated: boolean; user: { id: string; displayName: string } };
  expect(session).toMatchObject({ authenticated: true, user: { displayName } });
  const actorId = session.user.id;
  await page.goto('/settings#external-processing-notice');
  await page.getByRole('checkbox', { name: 'Я прочитав(-ла) повідомлення й погоджуюся на зовнішню обробку матеріалів.', exact: true }).check();
  await page.getByRole('button', { name: 'Погодитися на зовнішню обробку' }).click();
  await expect(page.getByText('Зовнішня обробка · Згоду збережено', { exact: true })).toBeVisible();
  await page.goto('/projects');

  await page.goto('/projects');
  await page.getByRole('button', { name: 'Новий простір' }).click();
  await page.getByRole('button', { name: 'Створити новий простір', exact: true }).click();
  await page.getByLabel('Назва простору').fill(`M23 Live ${nonce}`);
  await page.getByRole('button', { name: 'Створити простір' }).click();
  await page.getByRole('button', { name: 'Створити проєкт', exact: true }).click();
  const topic = `Live Facts acceptance ${nonce}`;
  await page.getByLabel('Назва й тема проєкту').fill(topic);
  await page.getByRole('checkbox', { name: 'Публікація у LinkedIn', exact: true }).check();
  await page.getByRole('button', { name: 'Створити проєкт', exact: true }).last().click();
  await expect(page.getByRole('heading', { name: topic })).toBeVisible();
  await page.getByRole('button', { name: 'Відкрити джерела' }).click();
  const projectId = new URL(page.url()).pathname.split('/')[2]!;
  const base = `/api/v1/projects/${projectId}`;

  await page.getByLabel('Назва', { exact: true }).fill('Звіт для реальної перевірки');
  await page.getByLabel('Текст джерела').fill(sourceText);
  await page.getByRole('button', { name: 'Додати джерело' }).click();
  await expect(page.locator('.source-plain-text')).toContainText(sourceText);
  await page.goto(`/projects/${projectId}`);
  await page.getByRole('button', { name: 'Відкрити факти' }).click();
  await expect(page).toHaveURL(/\/facts$/);
  const initialBasisResponse = await page.request.get(`${base}/basis?mode=FACTUAL`);
  const initialBasisBody = await initialBasisResponse.text();
  expect(initialBasisResponse.ok(), `GET ${base}/basis?mode=FACTUAL returned ${initialBasisResponse.status()}: ${initialBasisBody}`).toBe(true);
  await expect.poll(() => factsResponses.some(response => response.url.includes('/basis?mode=FACTUAL'))).toBe(true);
  await expect(page.getByText(/Немає схваленої фактичної основи/), JSON.stringify(factsResponses)).toBeVisible();
  await capture(page, 'live-empty');

  const materialResult = await (await page.request.get(`${base}/materials`)).json() as { materials: { id: string; label: string; purpose: string; included: boolean; currentSnapshotId: string }[] };
  const material = materialResult.materials.find(row => row.purpose === 'FACTUAL_SOURCE' && row.included)!;
  expect(material).toBeTruthy();
  const snapshotResponse = await page.request.get(`${base}/materials/${material.id}/snapshots/${material.currentSnapshotId}`);
  expect(snapshotResponse.ok()).toBe(true);
  const snapshot = (await snapshotResponse.json() as { snapshot: { id: string; sequence: number; normalizedText: string; fragments: { id: string; startOffset: number; endOffset: number; sha256: string }[] } }).snapshot;
  expect(snapshot.normalizedText).toBe(sourceText);
  const fragment = snapshot.fragments[0]!;

  await page.getByRole('button', { name: 'Додати твердження вручну' }).click();
  await page.getByLabel('Формулювання твердження').fill(claimWording);
  await page.getByLabel('Фактичне джерело', { exact: true }).selectOption(material.id);
  await page.getByLabel(`Уривок · Версія ${snapshot.sequence}`).selectOption(fragment.id);
  await expect(page.locator('.evidence-preview')).toContainText(sourceText);
  await page.getByRole('button', { name: 'Додати обраний доказ' }).click();
  await page.getByRole('button', { name: 'Зберегти пропозицію' }).click();
  await expect(page.locator('.facts-reader .claim-status')).toHaveText('Потребує перегляду');
  const claimsResponse = await page.request.get(`${base}/claims`);
  expect(claimsResponse.ok()).toBe(true);
  const claims = (await claimsResponse.json() as { claims: { id: string; currentRevisionId: string; currentRevision: ClaimRevision }[] }).claims;
  const claim = claims.find(row => row.currentRevision.wording === claimWording)!;
  expect(claim).toBeTruthy();
  expect(claim.currentRevision).toMatchObject({ status: 'PROPOSED', approvedAt: null, wording: claimWording });
  expect(claim.currentRevision.evidence[0]).toMatchObject({ snapshotId: snapshot.id, fragmentId: fragment.id, quote: sourceText, sha256: fragment.sha256, invalidatedAt: null });
  const firstRevisionId = claim.currentRevisionId;

  await page.getByRole('button', { name: 'Схвалити твердження' }).click();
  await expect(page.locator('.facts-reader .claim-status')).toHaveText('Схвалено');
  const approvedDetail = await (await page.request.get(`${base}/claims/${claim.id}`)).json() as ClaimDetail;
  expect(approvedDetail.claim.currentRevision).toMatchObject({ id: firstRevisionId, status: 'APPROVED', approvedBy: actorId, wording: claimWording });
  const firstBasisEligible = await (await page.request.get(`${base}/basis?mode=FACTUAL`)).json() as BasisResult;
  expect(firstBasisEligible.eligibleClaims.map(row => row.currentRevisionId)).toContain(firstRevisionId);
  await page.locator('.basis-selection input').check();
  await page.getByRole('button', { name: 'Зберегти фактичну основу' }).click();
  await expect(page.getByText('Збережена фактична основа придатна до використання.')).toBeVisible();
  const frozen = await (await page.request.get(`${base}/basis?mode=FACTUAL`)).json() as BasisResult;
  expect(frozen.basis).toMatchObject({ sequence: 1, valid: true, manifest: { schemaVersion: 'basis-v1', claims: [{ claimRevisionId: firstRevisionId }] } });
  const firstBasisId = frozen.basis!.id;
  await capture(page, 'live-approved-basis');

  await page.getByRole('button', { name: 'Створити нову версію' }).click();
  const revisedWording = 'У вересневому дослідженні взяли участь дванадцять учасників.';
  await page.getByLabel('Формулювання твердження').fill(revisedWording);
  await page.getByRole('button', { name: 'Зберегти пропозицію' }).click();
  await expect(page.locator('.facts-reader .claim-status')).toHaveText('Потребує перегляду');
  const editedDetail = await (await page.request.get(`${base}/claims/${claim.id}`)).json() as ClaimDetail;
  expect(editedDetail.claim.currentRevision).toMatchObject({ number: 2, status: 'PROPOSED', wording: revisedWording, approvedAt: null });
  expect(editedDetail.revisions.find(row => row.id === firstRevisionId)).toMatchObject({ number: 1, status: 'APPROVED', wording: claimWording, approvedBy: actorId });
  const staleBasis = await (await page.request.get(`${base}/basis?mode=FACTUAL`)).json() as BasisResult;
  expect(staleBasis.basis).toMatchObject({ id: firstBasisId, sequence: 1, valid: false, manifest: { schemaVersion: 'basis-v1', claims: [{ claimRevisionId: firstRevisionId }] } });
  expect(staleBasis.basis!.blockingReasons).toContain('CLAIM_CHANGED');
  await page.locator('.facts-reader .facts-details').filter({ hasText: 'Історія та схвалення' }).locator('summary').first().click();
  await page.getByRole('button', { name: 'Версія 1 · Схвалено', exact: true }).click();
  await expect(page.locator('.claim-document')).toHaveText(claimWording);
  await expect(page.locator('.claim-evidence')).toContainText(sourceText);
  await expect(page.locator('.facts-reader')).toContainText(displayName);
  await page.getByRole('button', { name: /Версія 2 · Потребує перегляду/ }).click();
  await page.reload();
  await page.locator('.claim-open').filter({ hasText: revisedWording }).click();
  await expect(page.locator('.claim-document')).toHaveText(revisedWording);
  await expect(page.locator('.facts-reader .claim-status')).toHaveText('Потребує перегляду');
  await page.locator('.facts-reader .facts-details').filter({ hasText: 'Історія та схвалення' }).locator('summary').first().click();
  const reloadedHistory = await page.request.get(`${base}/claims/${claim.id}`);
  const reloadedDetail = await reloadedHistory.json() as ClaimDetail;
  expect(reloadedDetail.revisions).toHaveLength(2);
  expect(reloadedDetail.revisions.find(row => row.id === firstRevisionId)).toMatchObject({ status: 'APPROVED', wording: claimWording, approvedBy: actorId });
  await capture(page, 'live-edited-stale-basis');

  await page.getByRole('button', { name: 'Схвалити твердження' }).click();
  await expect(page.locator('.facts-reader .claim-status')).toHaveText('Схвалено');
  const secondApproved = await (await page.request.get(`${base}/claims/${claim.id}`)).json() as ClaimDetail;
  const secondRevisionId = secondApproved.claim.currentRevisionId;
  expect(secondApproved.claim.currentRevision).toMatchObject({ status: 'APPROVED', number: 2, approvedBy: actorId });
  await page.locator('.basis-selection input').check();
  const refreezeResponsePromise = page.waitForResponse(response => response.request().method() === 'POST' && new URL(response.url()).pathname === `${base}/basis`);
  await page.getByRole('button', { name: 'Зберегти фактичну основу' }).click();
  expect((await refreezeResponsePromise).status()).toBe(201);
  const refrozen = await (await page.request.get(`${base}/basis?mode=FACTUAL`)).json() as BasisResult;
  expect(refrozen.basis).toMatchObject({ sequence: 2, valid: true, manifest: { schemaVersion: 'basis-v1', claims: [{ claimRevisionId: secondRevisionId }] } });
  expect(refrozen.basis!.id).not.toBe(firstBasisId);

  await page.getByRole('button', { name: 'Відкликати схвалення' }).click();
  await page.getByLabel('Причина відкликання (необов’язково)').fill('Додатково перевірити точність формулювання.');
  await page.getByRole('button', { name: 'Підтвердити відкликання' }).click();
  await expect(page.locator('.facts-reader .claim-status')).toHaveText('Схвалення відкликано');
  const withdrawnDetail = await (await page.request.get(`${base}/claims/${claim.id}`)).json() as ClaimDetail;
  expect(withdrawnDetail.claim.currentRevision).toMatchObject({ id: secondRevisionId, status: 'APPROVED', withdrawnBy: actorId, withdrawalReason: 'Додатково перевірити точність формулювання.' });
  expect(withdrawnDetail.revisions.find(row => row.id === firstRevisionId)).toMatchObject({ status: 'APPROVED', wording: claimWording, approvedBy: actorId, withdrawnAt: null });
  const invalidatedBasis = await (await page.request.get(`${base}/basis?mode=FACTUAL`)).json() as BasisResult;
  expect(invalidatedBasis.basis).toMatchObject({ id: refrozen.basis!.id, sequence: 2, valid: false, manifest: { schemaVersion: 'basis-v1', claims: [{ claimRevisionId: secondRevisionId }] } });
  expect(invalidatedBasis.basis!.blockingReasons).toContain('WITHDRAWN');
  await capture(page, 'live-withdrawn-basis');
  writeFileSync(`${ARTIFACTS}/facts-live-accessibility.yml`, await page.locator('.facts-workspace').ariaSnapshot());
  expect(pageErrors).toEqual([]);
});
