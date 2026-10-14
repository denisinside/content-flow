import { mkdirSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { test, expect, type Page } from '@playwright/test';

const ARTIFACTS = '.codex/artifacts/m23';
const NOW = '2026-09-29T14:00:00.000Z';
interface Evidence { id: string; snapshotId: string; fragmentId: string; startOffset: number; endOffset: number; quote: string; sha256: string; relation: 'SUPPORTS' | 'CONTRADICTS'; materialId: string; materialLabel: string; snapshotSequence: number; invalidatedAt: string | null; invalidatedBy: string | null; invalidationReason: string | null }
interface Revision { id: string; number: number; wording: string; status: 'PROPOSED' | 'APPROVED' | 'REJECTED'; approvedBy: string | null; approvedAt: string | null; rejectedBy: string | null; rejectedAt: string | null; withdrawnBy: string | null; withdrawnAt: string | null; withdrawalReason: string | null; evidence: Evidence[] }
interface Claim { id: string; revision: number; currentRevisionId: string; currentRevision: Revision; revisions: Revision[] }
interface Conflict { id: string; origin: string; rationale: string; resolvedAt: string | null; resolvedBy: string | null; formulation: string | null; resolutionRationale: string | null; selectedRevisionId: string | null; participants: { claimId: string; revisionId: string; wording: string }[]; selectedEvidenceIds: string[]; supersedesId?: string | null; supersededById?: string | null }
interface Job { id: string; operation: string; status: string; progressStage: string; attemptCount: number; maxAttempts: number; retryAllowed: boolean; errorCategory: string | null; updatedAt: string }

async function capture(page: Page, state: string) {
  for (const width of [1440, 1280, 768, 390]) {
    await page.setViewportSize({ width, height: 900 });
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: `${ARTIFACTS}/facts-${state}-${width}.png`, fullPage: true });
  }
  await page.setViewportSize({ width: 1440, height: 900 });
}

test('members review exact evidence, resolve conflicts and freeze eligible claim revisions', async ({ page }) => {
  test.setTimeout(150_000);
  mkdirSync(ARTIFACTS, { recursive: true });
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  const nonce = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  await page.goto('/');
  await page.getByRole('button', { name: 'Реєстрація' }).click();
  await page.getByLabel(/Ваше ім’я/).fill('M23 Facts Test');
  await page.getByLabel('Електронна пошта').fill(`m23-facts-${nonce}@example.test`);
  await page.getByLabel('Пароль').fill('TestOnly!ContextFlow2026');
  await page.getByRole('button', { name: 'Створити обліковий запис' }).click();
  await expect(page.locator('#account-title')).toHaveText('M23 Facts Test', { timeout: 20_000 });
  await page.goto('/settings#external-processing-notice');
  await page.getByRole('checkbox', { name: 'Я прочитав(-ла) повідомлення й погоджуюся на зовнішню обробку матеріалів.', exact: true }).check();
  await page.getByRole('button', { name: 'Погодитися на зовнішню обробку' }).click();
  await expect(page.getByText('Зовнішня обробка · Згоду збережено', { exact: true })).toBeVisible();
  await page.goto('/projects');
  await page.goto('/projects');
  await page.getByRole('button', { name: 'Новий простір' }).click();
  await page.getByRole('button', { name: 'Створити новий простір', exact: true }).click();
  await page.getByLabel('Назва простору').fill(`M23 Facts ${nonce}`);
  await page.getByRole('button', { name: 'Створити простір' }).click();
  await page.getByRole('button', { name: 'Створити проєкт', exact: true }).click();
  await page.getByLabel('Назва й тема проєкту').fill(`M23 factual project ${nonce}`);
  await page.getByRole('checkbox', { name: 'Публікація у LinkedIn', exact: true }).check();
  await page.getByRole('button', { name: 'Створити проєкт', exact: true }).last().click();
  await page.getByRole('button', { name: 'Відкрити джерела' }).click();
  const projectId = new URL(page.url()).pathname.split('/')[2]!;
  const base = `/api/v1/projects/${projectId}`;
  const originalText = 'У дослідженні взяли участь 12 учасників. Це точний український уривок зі збереженого джерела.';
  const partialText = originalText.slice(0, originalText.indexOf('.') + 1);
  await page.getByLabel('Назва', { exact: true }).fill('Звіт дослідження');
  await page.getByLabel('Текст джерела').fill(originalText);
  await page.getByRole('button', { name: 'Додати джерело' }).click();
  await expect(page.locator('.source-plain-text')).toContainText(originalText);
  const materialResult = await (await page.request.get(`${base}/materials`)).json() as { materials: { id: string; label: string; currentSnapshotId: string }[] };
  const material = materialResult.materials[0]!;
  const snapshotResult = await (await page.request.get(`${base}/materials/${material.id}/snapshots/${material.currentSnapshotId}`)).json() as { snapshot: { id: string; sequence: number; fragments: { id: string; startOffset: number; endOffset: number; sha256: string }[] } };
  const snapshot = snapshotResult.snapshot, fragment = snapshot.fragments[0]!;
  const evidence = (id: string): Evidence => ({ id, snapshotId: snapshot.id, fragmentId: fragment.id, startOffset: fragment.startOffset, endOffset: fragment.endOffset, quote: originalText, sha256: fragment.sha256, relation: 'SUPPORTS', materialId: material.id, materialLabel: material.label, snapshotSequence: 1, invalidatedAt: null, invalidatedBy: null, invalidationReason: null });
  const revision = (id: string, number: number, wording: string, proof: Evidence[]): Revision => ({ id, number, wording, status: 'PROPOSED', approvedBy: null, approvedAt: null, rejectedBy: null, rejectedAt: null, withdrawnBy: null, withdrawnAt: null, withdrawalReason: null, evidence: proof });
  const firstRevision = revision('claim-revision-1', 1, 'У дослідженні взяли участь 12 учасників.', [evidence('evidence-1')]);
  const secondRevision = revision('claim-revision-2', 1, 'У дослідженні взяли участь 15 учасників.', [evidence('evidence-2')]);
  const claims: Claim[] = [];
  const conflicts: Conflict[] = [];
  const jobs: Job[] = [];
  const commands: string[] = [];
  let conflictOnce = false;
  let frozen: { id: string; sequence: number; ids: string[] } | null = null;
  let retryCount = 0, cancelCount = 0;
  let claimPageCount = 0, conflictPageCount = 0;

  // UI contracts use deterministic extraction/domain doubles. Identity,
  // membership, project and the selected source snapshot are real TEST data.
  await page.route(`**${base}/**`, async route => {
    const request = route.request(), url = new URL(request.url()), path = url.pathname.slice(base.length);
    const json = (body: unknown, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    if (path === '/jobs') return json({ jobs });
    if (path.endsWith('/retry')) { retryCount += 1; jobs[0]!.status = 'QUEUED'; jobs[0]!.retryAllowed = false; return json({ job: jobs[0] }); }
    if (path.endsWith('/cancel')) { cancelCount += 1; jobs[0]!.status = 'CANCELLED'; return json({ job: jobs[0] }); }
    if (path === '/claims/extract') {
      const body = request.postDataJSON() as { commandKey: string };
      expect(request.headers()['x-csrf-token']).toBeTruthy();
      commands.push(body.commandKey);
      jobs.unshift({ id: `extraction-${commands.length}`, operation: 'CLAIM_EXTRACTION', status: 'QUEUED', progressStage: 'WAITING', attemptCount: 0, maxAttempts: 3, retryAllowed: false, errorCategory: null, updatedAt: NOW });
      return json({ job: jobs[0] }, 202);
    }
    if (path === '/claims' && request.method() === 'GET') {
      const offset = Number(url.searchParams.get('cursor') ?? 0);
      if (offset) claimPageCount += 1;
      return json({ claims: claims.slice(offset, offset + 1), nextCursor: offset + 1 < claims.length ? String(offset + 1) : null });
    }
    if (path === '/claims' && request.method() === 'POST') {
      const body = request.postDataJSON() as { wording: string; evidence: Omit<Evidence, 'id'>[] };
      expect(body.evidence[0]).toMatchObject({ snapshotId: snapshot.id, fragmentId: fragment.id, quote: originalText, sha256: fragment.sha256, startOffset: fragment.startOffset, endOffset: fragment.endOffset });
      expect(body.evidence[1]).toMatchObject({ snapshotId: snapshot.id, fragmentId: fragment.id, quote: partialText, sha256: createHash('sha256').update(partialText).digest('hex'), startOffset: fragment.startOffset, endOffset: fragment.startOffset + partialText.length });
      const next = revision(`manual-revision-${claims.length}`, 1, body.wording, body.evidence.map((item, index) => ({ ...evidence(`manual-evidence-${claims.length}-${index}`), ...item })));
      const claim = { id: `manual-claim-${claims.length}`, revision: 1, currentRevisionId: next.id, currentRevision: next, revisions: [next] };
      claims.push(claim); return json({ claim });
    }
    if (path.startsWith('/claims/')) {
      const claim = claims.find(item => item.id === path.split('/')[2])!;
      if (request.method() === 'GET') return json({ claim, revisions: claim.revisions });
      const body = request.postDataJSON() as { expectedRevision: number; wording?: string; evidence?: Evidence[]; reason?: string };
      if (request.method() === 'PATCH') {
        if (conflictOnce) { conflictOnce = false; claim.revision += 1; return json({ message: 'Revision conflict' }, 409); }
        expect(body.expectedRevision).toBe(claim.revision);
        const next = revision(`${claim.id}-revision-${claim.revisions.length + 1}`, claim.revisions.length + 1, body.wording!, body.evidence!.map((item, index) => ({ ...evidence(`${claim.id}-new-evidence-${index}`), ...item })));
        claim.currentRevision = next; claim.currentRevisionId = next.id; claim.revisions.unshift(next); claim.revision += 1;
      } else if (path.endsWith('/approve')) { claim.currentRevision.status = 'APPROVED'; claim.currentRevision.approvedAt ??= NOW; claim.currentRevision.approvedBy ??= 'M23 Facts Test'; claim.revision += 1; }
      else if (path.endsWith('/reject')) { claim.currentRevision.status = 'REJECTED'; claim.currentRevision.rejectedAt = NOW; claim.currentRevision.rejectedBy = 'M23 Facts Test'; claim.revision += 1; }
      else if (path.endsWith('/withdraw')) { claim.currentRevision.withdrawnAt = NOW; claim.currentRevision.withdrawnBy = 'M23 Facts Test'; claim.currentRevision.withdrawalReason = body.reason ?? null; claim.revision += 1; }
      else if (path.endsWith('/invalidate')) { const proof = claim.currentRevision.evidence.find(item => item.id === path.split('/')[4])!; proof.invalidatedAt = NOW; proof.invalidatedBy = 'M23 Facts Test'; proof.invalidationReason = body.reason!; claim.revision += 1; }
      return json({ claim });
    }
    if (path === '/conflicts' && request.method() === 'GET') {
      const offset = Number(url.searchParams.get('cursor') ?? 0);
      if (offset) conflictPageCount += 1;
      return json({ conflicts: conflicts.slice(offset, offset + 1), nextCursor: offset + 1 < conflicts.length ? String(offset + 1) : null });
    }
    if (path === '/conflicts' && request.method() === 'POST') {
      const body = request.postDataJSON() as { revisionIds: string[]; rationale: string };
      const participants = claims.filter(claim => body.revisionIds.includes(claim.currentRevisionId)).map(claim => ({ claimId: claim.id, revisionId: claim.currentRevisionId, wording: claim.currentRevision.wording }));
      const conflict: Conflict = { id: `manual-conflict-${conflicts.length}`, origin: 'MANUAL', rationale: body.rationale, resolvedAt: null, resolvedBy: null, formulation: null, resolutionRationale: null, selectedRevisionId: null, participants, selectedEvidenceIds: [] };
      conflicts.push(conflict); return json({ conflict });
    }
    if (path.endsWith('/reopen')) {
      const prior = conflicts.find(item => item.id === path.split('/')[2])!;
      const body = request.postDataJSON() as { rationale: string };
      const participants = prior.participants.map(participant => { const claim = claims.find(claim => claim.id === participant.claimId)!; return { claimId: claim.id, revisionId: claim.currentRevisionId, wording: claim.currentRevision.wording }; });
      const conflict: Conflict = { id: `reopened-${conflicts.length}`, origin: 'MANUAL', rationale: body.rationale, resolvedAt: null, resolvedBy: null, formulation: null, resolutionRationale: null, selectedRevisionId: null, selectedEvidenceIds: [], participants, supersedesId: prior.id };
      prior.supersededById = conflict.id; conflicts.push(conflict); return json({ conflict });
    }
    if (path.endsWith('/resolve')) {
      const conflict = conflicts.find(item => item.id === path.split('/')[2])!;
      const body = request.postDataJSON() as { selectedRevisionId: string; selectedEvidenceIds: string[]; formulation: string; rationale: string };
      expect(body.selectedEvidenceIds.length).toBeGreaterThan(0);
      expect(conflict.participants.some(participant => claims.find(claim => claim.id === participant.claimId)?.currentRevisionId === body.selectedRevisionId)).toBe(true);
      conflict.resolvedAt = NOW; conflict.resolvedBy = 'M23 Facts Test'; conflict.formulation = body.formulation; conflict.resolutionRationale = body.rationale; conflict.selectedRevisionId = body.selectedRevisionId; conflict.selectedEvidenceIds = body.selectedEvidenceIds;
      return json({ conflict });
    }
    if (path === '/basis') {
      const eligibleClaims = claims.filter(claim => claim.currentRevision.status === 'APPROVED' && !claim.currentRevision.withdrawnAt && claim.currentRevision.evidence.every(item => !item.invalidatedAt) && claim.currentRevision.evidence.some(item => item.relation === 'SUPPORTS') && !conflicts.some(conflict => !conflict.supersededById && conflict.participants.some(item => item.claimId === claim.id) && (!conflict.resolvedAt || conflict.selectedRevisionId !== claim.currentRevisionId)));
      if (request.method() === 'POST') { const body = request.postDataJSON() as { claimRevisionIds: string[] }; expect(body.claimRevisionIds.every(id => eligibleClaims.some(claim => claim.currentRevisionId === id))).toBe(true); frozen = { id: `basis-${(frozen?.sequence ?? 0) + 1}`, sequence: (frozen?.sequence ?? 0) + 1, ids: body.claimRevisionIds }; return json({ basis: frozen }); }
      const valid = !!frozen && frozen.ids.every(id => eligibleClaims.some(claim => claim.currentRevisionId === id));
      return json({ mode: url.searchParams.get('mode'), basis: frozen ? { id: frozen.id, sequence: frozen.sequence, manifest: { claimRevisionIds: frozen.ids }, valid, blockingReasons: valid ? [] : ['CLAIM_CHANGED'] } : null, eligibleClaims, missingBasis: !valid, unverified: !valid, blockingReasons: valid ? [] : ['MISSING_BASIS'] });
    }
    return route.continue();
  });

  await page.goto(`/projects/${projectId}`);
  await page.getByRole('button', { name: 'Відкрити факти' }).click();
  await expect(page).toHaveURL(/\/facts$/);
  await expect(page.getByText(/Немає схваленої фактичної основи/)).toBeVisible();
  await capture(page, 'empty');
  await page.getByRole('button', { name: 'Виділити твердження', exact: true }).click();
  await expect(page.getByText('Очікує обробки', { exact: true })).toBeVisible();
  jobs[0]!.status = 'RUNNING'; jobs[0]!.progressStage = 'PROCESSING';
  await expect(page.getByText('Виділяємо твердження', { exact: true })).toBeVisible({ timeout: 5000 });
  claims.push({ id: 'claim-1', revision: 1, currentRevisionId: firstRevision.id, currentRevision: firstRevision, revisions: [firstRevision] }, { id: 'claim-2', revision: 1, currentRevisionId: secondRevision.id, currentRevision: secondRevision, revisions: [secondRevision] });
  conflicts.push({ id: 'detected-conflict', origin: 'DETECTED', rationale: 'Джерела дають різну кількість учасників: 12 або 15.', resolvedAt: null, resolvedBy: null, formulation: null, resolutionRationale: null, selectedRevisionId: null, participants: claims.map(claim => ({ claimId: claim.id, revisionId: claim.currentRevisionId, wording: claim.currentRevision.wording })), selectedEvidenceIds: [] });
  jobs[0]!.status = 'SUCCEEDED'; jobs[0]!.progressStage = 'COMPLETE';
  await expect(page.locator('.claim-list')).toContainText(firstRevision.wording, { timeout: 5000 });
  await page.locator('.claim-open').filter({ hasText: firstRevision.wording }).click();
  await expect(page.locator('.claim-evidence')).toContainText(originalText);
  await expect(page.locator('.claim-evidence')).toContainText('Звіт дослідження · Версія 1');
  await expect(page.getByRole('button', { name: 'Схвалити твердження' })).toBeDisabled();
  await page.getByRole('button', { name: 'Переглянути рішення' }).click();
  await expect(page.getByLabel('Обране формулювання')).toBeFocused();
  await page.getByLabel('Обране формулювання').selectOption(firstRevision.id);
  await page.getByLabel('Чому обрано це формулювання й докази').fill('Точний уривок звіту прямо вказує 12 учасників.');
  await capture(page, 'conflict-review');
  await page.getByRole('button', { name: 'Записати рішення' }).click();
  await expect(page.getByRole('button', { name: 'Схвалити твердження' })).toBeEnabled();
  await page.getByRole('button', { name: 'Схвалити твердження' }).click();
  await expect(page.locator('.facts-reader .claim-status')).toHaveText('Схвалено');
  await page.locator('.basis-selection input').check();
  await page.getByRole('button', { name: 'Зберегти фактичну основу' }).click();
  await expect(page.getByText('Збережена фактична основа придатна до використання.')).toBeVisible();
  await capture(page, 'approved-basis');

  await page.getByRole('button', { name: 'Створити нову версію' }).click();
  const revisedWording = 'За збереженим звітом у дослідженні взяли участь 12 людей.';
  await page.getByLabel('Формулювання твердження').fill(revisedWording);
  conflictOnce = true;
  await page.getByRole('button', { name: 'Зберегти пропозицію' }).click();
  await expect(page.getByRole('alert')).toContainText('Ваш текст збережено у формі');
  await expect(page.getByLabel('Формулювання твердження')).toHaveValue(revisedWording);
  await page.getByRole('button', { name: 'Оновити версію, зберігши мій текст' }).click();
  await expect(page.getByLabel('Формулювання твердження')).toHaveValue(revisedWording);
  await page.getByRole('button', { name: 'Зберегти пропозицію' }).click();
  await expect(page.locator('.facts-reader .claim-status')).toHaveText('Потребує перегляду');
  await page.locator('.facts-reader .facts-details').filter({ hasText: 'Історія та схвалення' }).locator('summary').first().click();
  await page.getByRole('button', { name: 'Версія 1 · Схвалено', exact: true }).click();
  await expect(page.locator('.claim-document')).toHaveText(firstRevision.wording);
  await expect(page.locator('.claim-evidence')).toContainText(originalText);
  await expect(page.locator('.facts-reader')).toContainText('M23 Facts Test');
  await page.getByRole('button', { name: /Версія 2 · Потребує перегляду/ }).click();
  await page.locator('.resolved-conflicts > summary').click();
  await page.locator('.resolved-conflicts').getByRole('button', { name: 'Переглянути рішення' }).click();
  await expect(page.getByLabel('Чому рішення потрібно переглянути')).toBeFocused();
  await page.getByLabel('Чому рішення потрібно переглянути').fill('Формулювання обраного твердження відредаговано; потрібен перегляд поточних версій.');
  await page.getByRole('button', { name: 'Почати новий перегляд' }).click();
  await expect(page.getByRole('button', { name: 'Схвалити твердження' })).toBeDisabled();
  await page.locator('.facts-conflicts > .conflict-list').getByRole('button', { name: 'Переглянути рішення' }).click();
  await page.getByLabel('Обране формулювання').selectOption(claims[0]!.currentRevisionId);
  await page.getByLabel('Чому обрано це формулювання й докази').fill('Нова редакція точно відповідає збереженому уривку звіту.');
  await page.getByRole('button', { name: 'Записати рішення' }).click();
  expect(conflicts[0]!.formulation).toBe(firstRevision.wording);
  expect(conflicts[0]!.selectedEvidenceIds).toEqual(['evidence-1']);
  await page.getByRole('button', { name: 'Схвалити твердження' }).click();
  await page.getByRole('button', { name: 'Відкликати схвалення' }).click();
  await page.getByLabel('Причина відкликання (необов’язково)').fill('Потрібна додаткова редакційна перевірка.');
  await page.getByRole('button', { name: 'Підтвердити відкликання' }).click();
  await expect(page.locator('.facts-reader .claim-status')).toHaveText('Схвалення відкликано');
  expect(firstRevision.approvedBy).toBe('M23 Facts Test');
  expect(firstRevision.wording).not.toBe(revisedWording);
  await page.locator('.claim-open').filter({ hasText: secondRevision.wording }).click();
  await page.getByRole('button', { name: 'Відхилити пропозицію' }).click();
  await expect(page.locator('.facts-reader .claim-status')).toHaveText('Відхилено');

  await page.getByRole('button', { name: 'Додати твердження вручну' }).click();
  await expect(page.getByLabel('Формулювання твердження')).toBeFocused();
  await page.getByLabel('Формулювання твердження').fill('Звіт містить дані про 12 учасників.');
  await page.getByLabel('Фактичне джерело', { exact: true }).selectOption(material.id);
  await page.getByLabel('Уривок · Версія 1').selectOption(fragment.id);
  await expect(page.locator('.evidence-preview')).toContainText(originalText);
  await page.getByRole('button', { name: 'Додати обраний доказ' }).click();
  await page.getByLabel('Уривок · Версія 1').selectOption(fragment.id);
  await page.locator('.evidence-picker .facts-details > summary').click();
  const excerptInput = page.getByLabel('Виділіть точний текст у збереженому уривку');
  await excerptInput.focus();
  await expect(excerptInput).toBeFocused();
  await excerptInput.evaluate((element, end) => (element as HTMLTextAreaElement).setSelectionRange(0, end), partialText.length);
  await page.getByRole('button', { name: 'Використати виділений текст' }).click();
  await expect(page.locator('.evidence-preview')).toHaveText(partialText);
  await page.getByRole('button', { name: 'Додати обраний доказ' }).click();
  await page.getByRole('button', { name: 'Зберегти пропозицію' }).click();
  await page.getByRole('button', { name: 'Схвалити твердження' }).click();
  await page.locator('.claim-evidence .facts-details > summary').first().click();
  await page.getByRole('button', { name: 'Позначити доказ непридатним' }).first().click();
  await page.getByLabel('Чому доказ непридатний').fill('Потрібна повторна перевірка джерела.');
  await page.getByRole('button', { name: 'Визнати доказ непридатним' }).click();
  await expect(page.locator('.claim-evidence')).toContainText('Доказ визнано непридатним');
  await expect(page.locator('.basis-selection')).toHaveCount(0);
  await page.getByRole('button', { name: 'Позначити суперечність' }).click();
  await page.locator('.conflict-form input').nth(0).check();
  await page.locator('.conflict-form input').nth(2).check();
  const manualConflictRationale = 'Редактор зафіксував додаткову розбіжність.';
  await page.getByLabel('Пояснення суперечності').fill(manualConflictRationale);
  await page.getByRole('button', { name: 'Записати суперечність' }).click();
  await expect(page.getByText('Позначена вручну', { exact: true })).toBeVisible();
  const manualClaim = claims[2]!;
  const manualConflict = conflicts.find(conflict => conflict.origin === 'MANUAL' && conflict.participants.some(participant => participant.claimId === manualClaim.id));
  expect(manualConflict).toBeTruthy();
  expect(manualConflict!.participants.find(participant => participant.claimId === manualClaim.id)?.revisionId).toBe(manualClaim.currentRevisionId);
  await page.getByLabel('Режим роботи з основою').selectOption('CREATIVE');
  await expect(page.getByText(/Творчий \/ авторський режим · Без перевіреної фактичної основи/)).toBeVisible();
  await capture(page, 'withdrawn-unverified');
  writeFileSync(`${ARTIFACTS}/facts-accessibility.yml`, await page.locator('.facts-workspace').ariaSnapshot());

  // A conflict keeps its original participants as history, while an explicit
  // resolution selects each stable claim's latest wording and evidence.
  const conflictedRevisionId = manualClaim.currentRevisionId;
  await page.locator('.claim-open').filter({ hasText: manualClaim.currentRevision.wording }).click();
  await page.getByRole('button', { name: 'Створити нову версію' }).click();
  const currentConflictWording = 'Уточнений звіт описує дослідження за участі 12 людей.';
  await page.getByLabel('Формулювання твердження').fill(currentConflictWording);
  await page.getByRole('button', { name: 'Зберегти пропозицію' }).click();
  await expect(page.getByRole('button', { name: 'Схвалити твердження' })).toBeDisabled();
  await page.locator('.facts-conflicts > .conflict-list > li').filter({ hasText: manualConflictRationale }).getByRole('button', { name: 'Переглянути рішення' }).click();
  await expect(page.getByLabel('Обране формулювання').locator(`option[value="${manualClaim.currentRevisionId}"]`)).toHaveText(currentConflictWording);
  await page.getByLabel('Обране формулювання').selectOption(manualClaim.currentRevisionId);
  await page.getByLabel('Чому обрано це формулювання й докази').fill('Переглянуто нову редакцію та точний уривок первинного звіту.');
  await page.getByRole('button', { name: 'Записати рішення' }).click();
  expect(manualConflict!.participants.some(participant => participant.revisionId === conflictedRevisionId)).toBe(true);
  expect(manualConflict!.selectedRevisionId).toBe(manualClaim.currentRevisionId);
  expect(manualConflict!.formulation).toBe(currentConflictWording);
  await expect(page.locator('.facts-reader .claim-status')).toHaveText('Потребує перегляду');

  await page.getByRole('button', { name: 'Виділити твердження', exact: true }).click();
  jobs[0]!.status = 'FAILED'; jobs[0]!.errorCategory = 'ENGINE_UNAVAILABLE'; jobs[0]!.retryAllowed = true;
  await page.getByRole('button', { name: 'Оновити стан виділення' }).click();
  await page.getByRole('button', { name: 'Повторити спробу виділення' }).click();
  await page.getByRole('button', { name: 'Скасувати виділення' }).click();
  expect(retryCount).toBe(1); expect(cancelCount).toBe(1);
  jobs[0]!.status = 'OUTCOME_UNKNOWN'; jobs[0]!.errorCategory = 'TIMEOUT';
  await page.getByRole('button', { name: 'Оновити стан виділення' }).click();
  await expect(page.getByText(/Явний новий запуск може спричинити повторну оплату/)).toBeVisible();
  const commandCount = commands.length;
  await page.getByRole('button', { name: 'Запустити виділення знову' }).click();
  expect(commands.length).toBe(commandCount);
  await page.getByRole('button', { name: 'Підтвердити новий запуск виділення' }).click();
  expect(commands.length).toBe(commandCount + 1);
  expect(new Set(commands).size).toBe(commands.length);
  expect(claimPageCount).toBeGreaterThan(0);
  expect(conflictPageCount).toBeGreaterThan(0);
  expect(errors).toEqual([]);
});
