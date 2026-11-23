import { mkdirSync, writeFileSync } from 'node:fs';
import { test, expect, type APIResponse, type Page } from '@playwright/test';

async function checked<T>(response: Pick<APIResponse, 'text' | 'ok' | 'url' | 'status'>): Promise<T> {
  const body = await response.text();
  expect(response.ok(), `${response.url()} ${response.status()}: ${body}`).toBe(true);
  return JSON.parse(body) as T;
}
interface TelegramState { adaptation: { revision: number; draft: { baseRevisionId: string | null } | null; currentApprovedRevisionId: string | null; revisions: { id: string; number: number; inputMode: string; contentMode: string; briefRevisionId: string; sourceArticleVersionId: string | null; status: string; approvedAt: string | null; approvedBy: string | null; reviewedBriefRevisionId: string | null; reviewCounter: number; content: { text: string } }[] } | null; telegramSelected: boolean; staleReasons: string[] }
interface ArticleState { article: { revision: number; versions: { id: string; approvedAt: string | null; approvedBy: string | null; reviewCounter: number; content: unknown; eligible: boolean }[] } }
async function capture(page: Page, stage: string) {
  for (const width of [1280, 768, 390]) {
    await page.setViewportSize({ width, height: 900 });
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: `.local-checks/m33/telegram-live-${stage}-${width}.png`, fullPage: true });
  }
  await page.setViewportSize({ width: 1280, height: 900 });
}

test('real channels-only DIRECT Telegram approval and exact-input re-review preserve first approval without AI', async ({ page }) => {
  test.setTimeout(180_000); mkdirSync('.local-checks/m33', { recursive: true });
  const pageErrors: string[] = []; page.on('pageerror', error => pageErrors.push(error.message));
  const nonce = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const displayName = `M33 ${nonce.slice(-6)}`;
  await page.goto('/'); await page.getByRole('button', { name: 'Реєстрація' }).click();
  await page.getByLabel(/Ваше ім’я/).fill(displayName); await page.getByLabel('Електронна пошта').fill(`m33-live-${nonce}@example.test`); await page.getByLabel('Пароль').fill('TestOnly!ContextFlow2026'); await page.getByRole('button', { name: 'Створити обліковий запис' }).click();
  await expect(page.locator('#account-title')).toContainText(displayName, { timeout: 20_000 });
  const session = await checked<{ csrfToken: string }>(await page.request.get('/api/auth/session'));
  const headers = { 'X-CSRF-Token': session.csrfToken, Origin: new URL(page.url()).origin };
  const notice = await checked<{ notice: { version: string } }>(await page.request.get('/api/auth/external-processing'));
  await checked(await page.request.post('/api/auth/external-processing', { headers, data: { noticeVersion: notice.notice.version } }));
  const workspace = await checked<{ workspace: { id: string } }>(await page.request.post('/api/v1/workspaces', { headers, data: { name: `M33 Telegram ${nonce}` } }));
  const project = await checked<{ project: { id: string } }>(await page.request.post('/api/v1/projects', { headers, data: { workspaceId: workspace.workspace.id, topic: `Самостійний Telegram допис ${nonce}`, formats: ['TELEGRAM_POST'] } }));
  const base = `/api/v1/projects/${project.project.id}`;
  const brief = { expectedRevision: 0, contentMode: 'CREATIVE', topic: `Самостійний Telegram допис ${nonce}`, audience: 'Мешканці міста', centralMessage: 'Щоденні поїздки складаються з коротких людських історій.', category: 'Міське життя', tone: 'Спокійний, уважний', targetLength: 240, cta: 'Поділіться власним досвідом.', exclusions: ['Без неперевірених чисел'], notes: 'Написати самостійний короткий допис.', requiredClaimRevisionIds: [] };
  await checked(await page.request.post(`${base}/brief`, { headers, data: brief }));
  await page.goto(`/projects/${project.project.id}/telegram`);
  await expect(page.getByRole('heading', { name: 'Допис у Telegram' })).toBeVisible();
  const writing = page.getByRole('textbox', { name: 'Текст публікації', exact: true });
  await expect(page.getByText(/працює без статті та структури/)).toBeVisible();
  const before = await checked<{ article: unknown }>(await page.request.get(`${base}/article`)); expect(before.article).toBeNull();
  const editorial = await checked<{ outline: unknown }>(await page.request.get(`${base}/editorial`)); expect(editorial.outline).toBeNull();
  await writing.fill('Ранкова поїздка починається з невеликого рішення: вийти раніше й пройтися знайомою вулицею. Яка частина вашого маршруту додає спокою?');
  await page.getByRole('checkbox', { name: /Передбачити місце для посилання/ }).check();
  await page.getByRole('button', { name: 'Вставити [ПОСИЛАННЯ]' }).click();
  await expect(writing).toHaveValue(/\[ПОСИЛАННЯ\]/);
  await expect(page.getByText('Збережено', { exact: true })).toBeVisible();
  await capture(page, 'direct-draft');
  await page.getByRole('button', { name: 'Зберегти версію' }).click();
  await page.getByRole('button', { name: 'Історія й походження' }).click();
  const approvalResponse = page.waitForResponse(response => response.url().endsWith('/approve') && response.request().method() === 'POST');
  await page.getByRole('button', { name: 'Погодити версію' }).click();
  const firstReview = await checked<TelegramState>(await approvalResponse);
  await expect(page.getByText(/Поточне погодження · версія 1/)).toBeVisible();
  const first = firstReview.adaptation!.revisions[0]!;
  expect(firstReview.adaptation!.currentApprovedRevisionId).toBe(first.id);
  expect(first).toMatchObject({ inputMode: 'DIRECT', contentMode: 'CREATIVE', status: 'APPROVED', sourceArticleVersionId: null, approvedBy: session ? expect.any(String) : undefined, reviewCounter: 0 });
  expect(first.content.text).toContain('[ПОСИЛАННЯ]');
  const approvedAt = first.approvedAt, approvedBy = first.approvedBy;
  await capture(page, 'approved-direct');

  await checked(await page.request.post(`${base}/brief`, { headers, data: { ...brief, expectedRevision: 1, notes: 'Оновлений контекст до перевірки вже погодженого тексту.' } }));
  await page.reload(); await page.getByRole('button', { name: 'Історія й походження' }).click();
  await expect(page.locator('.telegram-notice.telegram-stale')).toContainText('змінився бриф');
  const reviewResponse = page.waitForResponse(response => response.url().endsWith('/rereview') && response.request().method() === 'POST');
  await page.getByRole('button', { name: 'Переглянути без зміни тексту' }).click();
  const rereviewed = await checked<TelegramState>(await reviewResponse);
  const latest = rereviewed.adaptation!.revisions.find(version => version.id === first.id)!;
  expect(latest).toMatchObject({ approvedAt, approvedBy, reviewCounter: 1, reviewedBriefRevisionId: expect.any(String), status: 'APPROVED' });
  expect(latest.content).toEqual(first.content);
  expect(rereviewed.adaptation!.currentApprovedRevisionId).toBe(first.id);
  await capture(page, 'rereviewed-direct');
  mkdirSync('.local-checks/m33', { recursive: true });
  writeFileSync('.local-checks/m33/telegram-live-accessibility.yml', await page.locator('.telegram-workspace').ariaSnapshot());

  const refreshResponse = page.waitForResponse(response => response.url().endsWith('/telegram/draft') && response.request().method() === 'POST');
  await page.getByRole('button', { name: 'Оновити входи чернетки' }).click();
  const refreshed = await checked<TelegramState & { adaptation: { draft: { briefRevisionId: string; content: { text: string } } } }>(await refreshResponse);
  expect(refreshed.adaptation.draft.briefRevisionId).toBe(latest.reviewedBriefRevisionId);
  expect(refreshed.adaptation.draft.content).toEqual(first.content);
  expect(refreshed.adaptation.currentApprovedRevisionId).toBe(first.id);
  await expect(page.locator('.telegram-notice.telegram-stale')).toHaveCount(0);
  await writing.fill(`${first.content.text}\nНова авторська правка.`);
  await page.getByRole('button', { name: 'Зберегти версію' }).click();
  const secondApprovalResponse = page.waitForResponse(response => response.url().endsWith('/approve') && response.request().method() === 'POST');
  await page.getByRole('button', { name: 'Погодити версію' }).click();
  const secondApproval = await checked<TelegramState>(await secondApprovalResponse);
  expect(secondApproval.adaptation!.currentApprovedRevisionId).not.toBe(first.id);
  expect(secondApproval.adaptation!.revisions.find(version => version.id === first.id)).toMatchObject({ content: first.content, approvedAt, approvedBy, reviewCounter: 1 });
  await capture(page, 'refreshed-direct');

  const mixed = await checked<{ project: { id: string } }>(await page.request.post('/api/v1/projects', { headers, data: { workspaceId: workspace.workspace.id, topic: `Похідний допис ${nonce}`, formats: ['ARTICLE', 'TELEGRAM_POST'] } }));
  const mixedBase = `/api/v1/projects/${mixed.project.id}`;
  await checked(await page.request.post(`${mixedBase}/brief`, { headers, data: brief }));
  await checked(await page.request.post(`${mixedBase}/article/draft`, { headers, data: { expectedRevision: 0, contentMode: 'CREATIVE', content: { title: 'Прогулянка містом', document: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Знайомий маршрут допомагає побачити невеликі зміни навколо.' }] }] } } } }));
  const articleCheckpoint = await checked<ArticleState>(await page.request.post(`${mixedBase}/article/checkpoint`, { headers, data: { expectedRevision: 1 } }));
  const source = articleCheckpoint.article.versions[0]!;
  const approvedSource = await checked<ArticleState>(await page.request.post(`${mixedBase}/article/${source.id}/approve`, { headers, data: { expectedRevision: 2, acknowledgeUnmapped: true } }));
  const initialSource = approvedSource.article.versions[0]!;
  await checked(await page.request.post(`${mixedBase}/telegram/draft`, { headers, data: { expectedRevision: 0, inputMode: 'ARTICLE_DERIVED', contentMode: 'CREATIVE', includeLink: false, content: { text: 'Звична прогулянка відкриває маленькі зміни у місті.', mappings: [] } } }));
  const derivedCheckpoint = await checked<TelegramState>(await page.request.post(`${mixedBase}/telegram/checkpoint`, { headers, data: { expectedRevision: 1 } }));
  const derived = derivedCheckpoint.adaptation!.revisions[0]!;
  const derivedApproval = await checked<TelegramState>(await page.request.post(`${mixedBase}/telegram/${derived.id}/approve`, { headers, data: { expectedRevision: 2, expectedReviewCounter: 0, acknowledgeUnmapped: true } }));
  const initialDerived = derivedApproval.adaptation!.revisions[0]!;
  await checked(await page.request.post(`${mixedBase}/brief`, { headers, data: { ...brief, expectedRevision: 1, notes: 'Перевірити незмінний текст із новим контекстом.' } }));
  await page.goto(`/projects/${mixed.project.id}/article`);
  await page.getByRole('button', { name: 'Історія версій' }).click();
  const articleResponse = page.waitForResponse(response => response.url().endsWith(`/article/${source.id}/rereview`) && response.request().method() === 'POST');
  await page.getByRole('button', { name: 'Переглянути без зміни тексту' }).click();
  const reviewedSource = await checked<ArticleState>(await articleResponse);
  expect(reviewedSource.article.versions[0]).toMatchObject({ approvedAt: initialSource.approvedAt, approvedBy: initialSource.approvedBy, content: initialSource.content, reviewCounter: 1, eligible: true });
  await page.goto(`/projects/${mixed.project.id}/telegram`);
  await page.getByRole('button', { name: 'Історія й походження' }).click();
  const derivedResponse = page.waitForResponse(response => response.url().endsWith(`/telegram/${derived.id}/rereview`) && response.request().method() === 'POST');
  await page.getByRole('button', { name: 'Переглянути без зміни тексту' }).click();
  const reviewedDerived = await checked<TelegramState>(await derivedResponse);
  expect(reviewedDerived.adaptation!.revisions[0]).toMatchObject({ sourceArticleVersionId: source.id, inputMode: 'ARTICLE_DERIVED', approvedAt: initialDerived.approvedAt, approvedBy: initialDerived.approvedBy, content: initialDerived.content, reviewCounter: 1 });
  await capture(page, 'rereviewed-derived');
  expect(pageErrors).toEqual([]);
});
