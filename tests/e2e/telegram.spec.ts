import { mkdirSync } from 'node:fs';
import { test, expect, type Page } from '@playwright/test';

const projectId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const workspaceId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const base = `/api/v1/projects/${projectId}`;
const evidence = { claimRevisionId: 'claim-revision-1', evidenceId: 'evidence-1', wording: 'У звіті описано досвід мешканців.', quote: 'У звіті описано досвід мешканців.', snapshotId: 'snapshot-1', materialTitle: 'Звіт про поїздки' };
interface TestContent { text: string; mappings: { startOffset: number; endOffset: number; quote: string; claimRevisionId: string; evidenceId: string }[] }
interface TestDraft { content: TestContent; inputMode: string; contentMode: string; includeLink: boolean; baseRevisionId: string | null }
interface TestRevision { id: string; number: number; content: TestContent; hasUnmapped: boolean; status: string; origin: string; reviewCounter: number; approvedAt: string | null; approvedBy: string | null; staleReasons: string[]; reviewedAt: string | null; reviewedBy: string | null; reviewedBriefRevisionId: string | null }
interface TestState { adaptation: null | { id: string; revision: number; draft: TestDraft | null; currentApprovedRevisionId: string | null; revisions: TestRevision[] }; telegramSelected: boolean; brief: { id: string; revision: number; currentRevision: { id: string; contentMode: string }; history: unknown[] }; style: { revision: number }; prerequisites: { blockingReasons: string[]; missingBasis: boolean; unverified: boolean }; approvedArticle: null | { id: string; number: number; contentMode: string; title: string; approvedAt: string; inspection: { eligible?: boolean; blockingReasons: string[] } }; eligibleEvidence: typeof evidence[]; staleReasons: string[]; mappingIssues: unknown[]; hasUnmapped: boolean; blockingReasons: string[] }
interface PostBody { expectedRevision: number; content: TestContent; inputMode: string; contentMode: string; includeLink: boolean; acknowledgeUnmapped?: boolean; expectedReviewCounter?: number }
function state(contentMode = 'FACTUAL') {
  return {
    adaptation: null as TestState['adaptation'], telegramSelected: true,
    brief: { id: 'brief', revision: 1, currentRevision: { id: 'brief-revision-1', contentMode }, history: [] },
    style: { revision: 1 }, prerequisites: { blockingReasons: [], missingBasis: false, unverified: false }, approvedArticle: null,
    eligibleEvidence: [evidence], staleReasons: [], mappingIssues: [], hasUnmapped: false, blockingReasons: [],
  } satisfies TestState;
}
async function fixture(page: Page, hasApprovedArticle = false, contentMode = 'FACTUAL') {
  let current: TestState = state(contentMode); let rejectNextSave = false;
  if (hasApprovedArticle) current.approvedArticle = { id: 'article-version-1', number: 1, contentMode: 'FACTUAL', title: 'Погоджена стаття', approvedAt: '2026-10-10T10:00:00Z', inspection: { eligible: true, blockingReasons: [] } };
  const actions: { path: string; body: PostBody }[] = [];
  const json = (route: import('@playwright/test').Route, body: unknown, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
  await page.route('**/api/**', async route => {
    const request = route.request(), path = new URL(request.url()).pathname;
    if (path === '/api/auth/session') return json(route, { authenticated: true, csrfToken: 'csrf', user: { id: 'editor', email: 'test@example.test', displayName: 'Редактор' } });
    if (path === '/api/auth/preferences') return json(route, { preferences: { idleTimeoutMinutes: 60 } });
    if (path === '/api/auth/external-processing') return json(route, { notice: { version: '1', text: 'Тестова згода' }, accepted: true });
    if (path === '/api/auth/activity') return json(route, { authenticated: true });
    if (path === '/api/auth/logout') return json(route, { authenticated: false });
    if (path === '/api/v1/workspaces') return json(route, { workspaces: [{ id: workspaceId, ownerId: 'editor', name: 'Редакція', archivedAt: null, members: [] }], nextCursor: null });
    if (path === `/api/v1/workspaces/${workspaceId}`) return json(route, { workspace: { id: workspaceId, ownerId: 'editor', name: 'Редакція', archivedAt: null, members: [] } });
    if (path === base) return json(route, { project: { id: projectId, workspaceId, topic: 'Міські поїздки', formats: hasApprovedArticle ? ['ARTICLE', 'TELEGRAM_POST'] : ['TELEGRAM_POST'], revision: 1, createdAt: '2026-10-10T10:00:00Z', updatedAt: '2026-10-10T10:00:00Z', archivedAt: null } });
    if (path === `${base}/article`) return json(route, { article: hasApprovedArticle ? { currentApprovedVersionId: 'article-version-1' } : null });
    if (path === `${base}/telegram` && request.method() === 'GET') return json(route, current);
    if (path === `${base}/jobs`) return json(route, { jobs: [] });
    if (request.method() === 'POST') expect(request.headers()['x-csrf-token']).toBe('csrf');
    const post = request.postDataJSON() as PostBody;
    if (path === `${base}/telegram/draft`) {
      if (rejectNextSave) { rejectNextSave = false; return json(route, { error: 'CONFLICT' }, 409); }
      actions.push({ path, body: post });
      const old = current.adaptation;
      current = { ...current, adaptation: { id: 'adaptation', revision: (old?.revision ?? 0) + 1, draft: { ...post, baseRevisionId: old?.draft?.baseRevisionId ?? null }, currentApprovedRevisionId: old?.currentApprovedRevisionId ?? null, revisions: old?.revisions ?? [] }, hasUnmapped: post.content.text.trim().length > 0 && !post.content.mappings.length };
      return json(route, structuredClone(current));
    }
    if (path === `${base}/telegram/checkpoint`) {
      const adaptation = current.adaptation!; const draft = adaptation.draft; if (!draft) throw new Error('Expected a saved Telegram draft'); const n = adaptation.revisions.length + 1;
      const version = { id: `revision-${n}`, number: n, ...draft, content: structuredClone(draft.content), hasUnmapped: draft.content.text.trim().length > 0 && !draft.content.mappings.length, status: 'PROPOSED', origin: 'MANUAL', reviewCounter: 0, approvedAt: null, approvedBy: null, withdrawnAt: null, withdrawalReason: null, reviewedBriefRevisionId: null, reviewedBasisRevisionId: null, reviewedSourceArticleVersionId: null, reviewedWorkspaceStyleRevision: null, reviewedBy: null, reviewedAt: null, acknowledgedUnmapped: false, staleReasons: [], blockingReasons: [], claims: [] };
      current = { ...current, adaptation: { ...adaptation, revision: adaptation.revision + 1, draft: { ...draft, baseRevisionId: version.id }, revisions: [version, ...adaptation.revisions] } };
      return json(route, structuredClone(current));
    }
    if (path.startsWith(`${base}/telegram/revision-`) && (path.endsWith('/approve') || path.endsWith('/rereview'))) {
      actions.push({ path, body: post }); const revision = current.adaptation!.revisions.find(row => path.includes(row.id))!;
      if (path.endsWith('/approve')) { revision.status = 'APPROVED'; revision.approvedAt = '2026-10-10T10:30:00Z'; revision.approvedBy = 'editor'; current.adaptation!.currentApprovedRevisionId = revision.id; }
      else { revision.reviewCounter += 1; revision.reviewedAt = '2026-10-10T11:00:00Z'; revision.reviewedBy = 'editor'; revision.reviewedBriefRevisionId = 'brief-revision-2'; revision.staleReasons = []; }
      current.adaptation!.revision += 1;
      return json(route, structuredClone(current));
    }
    return json(route, {});
  });
  await page.goto(`/projects/${projectId}/telegram`);
  await expect(page.getByRole('heading', { name: 'Допис у Telegram' })).toBeVisible();
  return { current: () => current, actions, conflict: () => { rejectNextSave = true; }, markStale: () => { current.adaptation!.revisions[0]!.staleReasons = ['BRIEF_CHANGED']; } };
}

test('channels-only direct Telegram saves, links exact wording, checkpoints, approves and re-reviews without changing first approval', async ({ page }) => {
  const context = await fixture(page);
  const writing = page.getByRole('textbox', { name: 'Текст публікації' });
  await expect(page.getByText(/працює без статті та структури/)).toBeVisible();
  await expect(page.getByRole('link', { name: 'Канали' })).toHaveAttribute('aria-current', 'page');
  await writing.fill(evidence.wording);
  await writing.selectText();
  await page.getByRole('button', { name: 'Прив’язати виділення' }).click();
  await expect(page.getByText('Збережено', { exact: true })).toBeVisible();
  expect(context.actions.at(-1)?.body.content.mappings).toEqual([{ startOffset: 0, endOffset: evidence.wording.length, quote: evidence.wording, claimRevisionId: evidence.claimRevisionId, evidenceId: evidence.evidenceId }]);
  await page.getByRole('button', { name: 'Зберегти версію' }).click();
  await page.getByRole('button', { name: 'Історія й походження' }).click();
  await page.getByRole('button', { name: 'Погодити версію' }).click();
  const originalApproval = context.current().adaptation!.revisions[0]!.approvedAt;
  expect(originalApproval).toBeTruthy();
  expect(context.current().adaptation!.currentApprovedRevisionId).toBe('revision-1');
  context.markStale(); await page.reload(); await page.getByRole('button', { name: 'Історія й походження' }).click();
  await expect(page.getByText(/Потребує перегляду/).first()).toBeVisible();
  await page.getByRole('button', { name: 'Переглянути без зміни тексту' }).click();
  expect(context.actions.at(-1)?.body).toMatchObject({ expectedReviewCounter: 0 });
  expect(context.current().adaptation!.revisions[0]!.reviewCounter).toBe(1);
  expect(context.current().adaptation!.revisions[0]!.approvedAt).toBe(originalApproval);
  await expect(page.locator('.telegram-history-title').first()).toContainText('Погоджено');
  await page.emulateMedia({ reducedMotion: 'reduce' });
  expect(await page.evaluate(() => matchMedia('(prefers-reduced-motion: reduce)').matches)).toBe(true);
  await writing.focus(); await page.keyboard.press('Tab');
  await expect(page.getByRole('button', { name: 'Вставити [ПОСИЛАННЯ]' })).toBeFocused();
  mkdirSync('.local-checks/m33', { recursive: true });
  for (const width of [1280, 768, 390]) { await page.setViewportSize({ width, height: 900 }); await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true); await page.screenshot({ path: `.local-checks/m33/telegram-direct-${width}.png`, fullPage: true }); }
});

test('409 retains manuscript through reload and session-local recovery', async ({ page }) => {
  const context = await fixture(page); context.conflict();
  const writing = page.getByRole('textbox', { name: 'Текст публікації' });
  await writing.fill('Локальний текст, який треба зберегти.');
  await expect(page.locator('.telegram-error')).toContainText('Ваш текст збережено');
  await page.reload();
  expect(await page.evaluate(() => sessionStorage.getItem('cf:channel:editor:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa:TELEGRAM_POST'))).toContain('Локальний текст');
  await page.getByRole('button', { name: 'Відновити' }).click();
  await expect(writing).toHaveValue('Локальний текст, який треба зберегти.');
});

test('shortening linked wording saves bounded ranges and keeps the old quote for review', async ({ page }) => {
  const context = await fixture(page);
  const writing = page.getByRole('textbox', { name: 'Текст публікації' });
  await writing.fill(evidence.wording); await writing.selectText();
  await page.getByRole('button', { name: 'Прив’язати виділення' }).click();
  await expect(page.getByText('Збережено', { exact: true })).toBeVisible();
  const shortened = 'У звіті описано досвід.';
  await writing.fill(shortened);
  await expect(page.getByText('Збережено', { exact: true })).toBeVisible();
  expect(context.actions.at(-1)?.body.content).toMatchObject({ text: shortened, mappings: [{ startOffset: 0, endOffset: shortened.length, quote: evidence.wording }] });
  await expect(page.locator('.telegram-mapping-warning')).toBeVisible();
});

test('ARTICLE_DERIVED becomes available only with a current approved article and saves its explicit route', async ({ page }) => {
  const context = await fixture(page, true);
  const sourceSelect = page.getByLabel('Джерело матеріалу');
  await sourceSelect.selectOption('ARTICLE_DERIVED');
  await expect(page.getByText(/Джерело: Погоджена стаття/)).toBeVisible();
  const writing = page.getByRole('textbox', { name: 'Текст публікації' });
  await writing.fill('Редакція створила цей короткий допис на основі погодженої статті.');
  await expect(page.getByText('Збережено', { exact: true })).toBeVisible();
  expect(context.actions.at(-1)?.body.inputMode).toBe('ARTICLE_DERIVED');
  await expect(page.getByRole('button', { name: 'Запропонувати текст' })).toBeEnabled();
});

test('unmapped creative text needs an explicit revision-level acknowledgment before approval and re-review', async ({ page }) => {
  const context = await fixture(page, false, 'CREATIVE');
  await page.getByRole('textbox', { name: 'Текст публікації' }).fill('Неперевірений творчий текст для погодження.');
  await page.getByRole('button', { name: 'Зберегти версію' }).click();
  await page.getByRole('button', { name: 'Історія й походження' }).click();
  const acknowledgment = page.getByRole('checkbox', { name: /переглянув непов’язані твердження/ });
  await acknowledgment.check();
  await page.getByRole('button', { name: 'Погодити версію' }).click();
  expect(context.actions.at(-1)?.body.acknowledgeUnmapped).toBe(true);
  const original = structuredClone(context.current().adaptation!.revisions[0]!);
  context.markStale(); await page.reload(); await page.getByRole('button', { name: 'Історія й походження' }).click();
  const rereview = page.getByRole('button', { name: 'Переглянути без зміни тексту' });
  await expect(acknowledgment).toBeVisible();
  await expect(rereview).toBeDisabled();
  await acknowledgment.check(); await expect(rereview).toBeEnabled(); await rereview.click();
  expect(context.actions.at(-1)?.body).toMatchObject({ expectedReviewCounter: 0, acknowledgeUnmapped: true });
  expect(context.current().adaptation!.revisions[0]).toMatchObject({ approvedAt: original.approvedAt, approvedBy: original.approvedBy, content: original.content, reviewCounter: 1 });
});

test('logout clears Telegram session recovery before leaving the editor', async ({ page }) => {
  await fixture(page);
  const writing = page.getByRole('textbox', { name: 'Текст публікації' });
  await writing.fill('Приватна чернетка поточної сесії.');
  const key = 'cf:channel:editor:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa:TELEGRAM_POST';
  expect(await page.evaluate(recoveryKey => sessionStorage.getItem(recoveryKey), key)).toContain('Приватна чернетка');
  await page.locator('#account-title').click();
  await page.getByRole('button', { name: 'Вийти', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Реєстрація' })).toBeVisible();
  expect(await page.evaluate(recoveryKey => sessionStorage.getItem(recoveryKey), key)).toBeNull();
});
