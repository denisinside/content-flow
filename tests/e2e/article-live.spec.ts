import { mkdirSync, writeFileSync } from 'node:fs';
import { test, expect, type APIResponse, type Page } from '@playwright/test';

async function checked<T>(response: Pick<APIResponse, 'text' | 'ok' | 'url' | 'status'>): Promise<T> { const body = await response.text(); expect(response.ok(), `${response.url()} ${response.status()}: ${body}`).toBe(true); return JSON.parse(body) as T; }
interface ArticleState { article: { revision: number; currentApprovedVersionId: string | null; draft: { origin: string; baseVersionId: string | null; content: { title: string; document: unknown } }; versions: { id: string; number: number; status: string; content: { title: string; document: unknown }; approvedAt: string | null }[] } | null; mappingIssues: { reason: string }[] }
async function capture(page: Page, name: string) { for (const width of [1440, 1280, 768, 390]) { await page.setViewportSize({ width, height: 900 }); await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true); await page.screenshot({ path: `.codex/artifacts/m32/article-live-${name}-${width}.png`, fullPage: true }); }; await page.setViewportSize({ width: 1440, height: 900 }); }

test('real editor saves and reloads a ready article without outline, checkpoints exact approvals and preserves conflict text', async ({ page }) => {
  test.setTimeout(120_000); mkdirSync('.codex/artifacts/m32', { recursive: true });
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  const nonce = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  await page.goto('/'); await page.getByRole('button', { name: 'Реєстрація' }).click();
  await page.getByLabel(/Ваше ім’я/).fill(`M32 ${nonce.slice(-6)}`); await page.getByLabel('Електронна пошта').fill(`m32-live-${nonce}@example.test`); await page.getByLabel('Пароль').fill('TestOnly!ContextFlow2026'); await page.getByRole('button', { name: 'Створити обліковий запис' }).click();
  await expect(page.locator('#account-title')).toHaveText(`M32 ${nonce.slice(-6)}`, { timeout: 20_000 });
  await page.goto('/settings#external-processing-notice');
  await page.getByRole('checkbox', { name: 'Я прочитав(-ла) повідомлення й погоджуюся на зовнішню обробку матеріалів.', exact: true }).check();
  await page.getByRole('button', { name: 'Погодитися на зовнішню обробку' }).click();
  await expect(page.getByText('Зовнішня обробка · Згоду збережено', { exact: true })).toBeVisible();
  await page.goto('/projects');
  const session = await checked<{ csrfToken: string; user: { id: string } }>(await page.request.get('/api/auth/session'));
  const headers = { 'X-CSRF-Token': session.csrfToken, Origin: new URL(page.url()).origin };
  const workspace = await checked<{ workspace: { id: string } }>(await page.request.post('/api/v1/workspaces', { headers, data: { name: `M32 acceptance ${nonce}` } }));
  const project = await checked<{ project: { id: string } }>(await page.request.post('/api/v1/projects', { headers, data: { workspaceId: workspace.workspace.id, topic: 'Ранок у міському транспорті', formats: ['ARTICLE'] } }));
  const base = `/api/v1/projects/${project.project.id}`;
  await page.goto(`/projects/${project.project.id}/article`);
  const writing = page.getByRole('textbox', { name: 'Текст статті' }); await expect(writing).toBeVisible();
  const initial = await checked<ArticleState>(await page.request.get(`${base}/article`)); expect(initial.article).toBeNull();
  await page.getByRole('button', { name: 'Додати готову статтю' }).click(); await page.getByLabel('Готовий текст').fill('Сонце піднімається над тихим містом.\n\nАвтобус відкриває двері для першого пасажира.'); await page.getByRole('button', { name: 'Додати як чернетку' }).click();
  await expect(page.getByText(/Готова стаття · Не перевірено/)).toBeVisible();
  const imported = await checked<ArticleState>(await page.request.get(`${base}/article`)); expect(imported.article!.draft.origin).toBe('UNVERIFIED_IMPORTED'); expect(imported.article!.versions).toHaveLength(0);
  await page.reload(); await expect(writing).toContainText('Автобус відкриває двері');
  await writing.fill('Відредагована сцена: пасажир дивиться у вікно.'); await expect(page.getByText('Збережено', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Зберегти версію' }).click(); await page.getByRole('button', { name: 'Історія версій' }).click();
  const firstApprovalResponse = page.waitForResponse(response => response.url().endsWith('/approve') && response.request().method() === 'POST');
  await page.getByRole('button', { name: 'Погодити версію 1', exact: true }).click();
  await checked<ArticleState>(await firstApprovalResponse);
  await expect(page.getByText('Погоджено, версія 1', { exact: true })).toBeVisible();
  const approved = await checked<ArticleState>(await page.request.get(`${base}/article`)); const firstVersion = approved.article!.versions[0]!; expect(firstVersion.status).toBe('APPROVED'); expect(firstVersion.approvedAt).toBeTruthy(); expect(approved.article!.currentApprovedVersionId).toBe(firstVersion.id);
  await capture(page, 'approved-history');
  await writing.fill('Нова сцена для окремої чернетки.'); await expect(page.getByText('Збережено', { exact: true })).toBeVisible(); await page.reload(); await expect(writing).toContainText('Нова сцена для окремої чернетки.');
  const newer = await checked<ArticleState>(await page.request.get(`${base}/article`)); expect(newer.article!.versions.find(version => version.id === firstVersion.id)!.content).toEqual(firstVersion.content);
  // A genuine second writer updates the exact optimistic counter; the editor retains its own bytes.
  await checked(await page.request.post(`${base}/article/draft`, { headers, data: { expectedRevision: newer.article!.revision, contentMode: 'CREATIVE', content: { title: 'Серверна паралельна правка', document: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Текст іншого редактора.' }] }] } } } }));
  await writing.fill('Моя локальна правка після паралельного збереження.'); await expect(page.getByRole('alert')).toContainText('Ваш текст залишився'); await expect(writing).toContainText('Моя локальна правка після паралельного збереження.');
  await capture(page, 'conflict');
  await page.getByRole('button', { name: 'Зберегти мій текст як нову чернетку' }).click(); await expect(page.getByText('Збережено', { exact: true })).toBeVisible(); await page.reload(); await expect(writing).toContainText('Моя локальна правка після паралельного збереження.');
  // Create genuine reviewed source evidence, then link the actual selected editor wording.
  const sourceText = 'У дослідженні міської мобільності взяли участь 12 мешканців.';
  const source = await checked<{ material: { id: string; currentSnapshotId: string } }>(await page.request.post(`${base}/materials`, { headers, data: { label: 'Джерело для статті M32', purpose: 'FACTUAL_SOURCE', text: sourceText } }));
  const captured = await checked<{ snapshot: { id: string; normalizedText: string; fragments: { id: string; startOffset: number; endOffset: number; sha256: string }[] } }>(await page.request.get(`${base}/materials/${source.material.id}/snapshots/${source.material.currentSnapshotId}`));
  const fragment = captured.snapshot.fragments[0]!;
  const created = await checked<{ claim: { id: string; revision: number; currentRevisionId: string } }>(await page.request.post(`${base}/claims`, { headers, data: { wording: sourceText, evidence: [{ snapshotId: captured.snapshot.id, fragmentId: fragment.id, startOffset: fragment.startOffset, endOffset: fragment.endOffset, quote: captured.snapshot.normalizedText.slice(fragment.startOffset, fragment.endOffset), sha256: fragment.sha256, relation: 'SUPPORTS' }] } }));
  await checked(await page.request.post(`${base}/claims/${created.claim.id}/revisions/${created.claim.currentRevisionId}/approve`, { headers, data: { expectedRevision: created.claim.revision } }));
  await checked(await page.request.post(`${base}/basis`, { headers, data: { claimRevisionIds: [created.claim.currentRevisionId] } }));
  await page.reload();
  await page.getByLabel('Матеріал на перевірених фактах').check();
  await writing.fill(sourceText); await expect(page.getByText('Збережено', { exact: true })).toBeVisible();
  await writing.focus(); await page.keyboard.press('ControlOrMeta+a');
  await page.getByRole('button', { name: 'Доказ', exact: true }).click();
  await page.getByRole('button', { name: 'Прив’язати виділення', exact: true }).click();
  await expect(page.getByText('Збережено', { exact: true })).toBeVisible();
  expect((await checked<ArticleState>(await page.request.get(`${base}/article`))).mappingIssues).toEqual([]);
  await expect(writing.locator('.article-evidence')).toHaveAttribute('role', 'button');
  await writing.focus(); await page.keyboard.press('ControlOrMeta+Home'); await page.keyboard.press('ArrowRight'); await page.keyboard.type('змінено ');
  await expect(page.getByText('Посилання потребують перегляду.', { exact: false })).toBeVisible();
  expect((await checked<ArticleState>(await page.request.get(`${base}/article`))).mappingIssues).toContainEqual(expect.objectContaining({ reason: 'WORDING_CHANGED' }));
  await capture(page, 'evidence-needs-review');
  await writing.focus(); await page.keyboard.press('ControlOrMeta+a'); await page.getByRole('button', { name: 'Прив’язати виділення', exact: true }).click();
  await expect(page.getByText('Збережено', { exact: true })).toBeVisible();
  expect((await checked<ArticleState>(await page.request.get(`${base}/article`))).mappingIssues).toEqual([]);
  await page.getByRole('button', { name: 'Зберегти версію' }).click(); await page.getByRole('button', { name: 'Історія версій' }).click();
  await page.getByRole('button', { name: 'Погодити версію 2', exact: true }).click(); await expect(page.getByText('Погоджено, версія 2', { exact: true })).toBeVisible();
  writeFileSync('.codex/artifacts/m32/article-live-accessibility.yml', await page.locator('.article-workspace').ariaSnapshot()); expect(errors).toEqual([]);
});
