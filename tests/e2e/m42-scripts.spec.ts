import { mkdirSync } from 'node:fs';
import { test, expect, type Page, type Route } from '@playwright/test';

const projectId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const workspaceId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const base = `/api/v1/projects/${projectId}`;
type Format = 'LINKEDIN_CAROUSEL' | 'INSTAGRAM_CAROUSEL' | 'INSTAGRAM_STORIES';
interface Frame { id: string; purpose: string; text: string; visualHint: string; transition: string; mappings: unknown[] }
interface ScriptRevision { id: string; number: number; content: { frames: Frame[] }; parentAdaptationRevisionId: string; reviewCounter: number; approvedAt: string | null; withdrawnAt: string | null; claimsSealed: boolean; hasUnmapped: boolean; staleReasons: string[]; blockingReasons: string[]; eligible: boolean }
interface ScriptState {
  format: Format; formatSelected: boolean;
  adaptation: { id: string; revision: number; currentApprovedRevisionId: string; revisions: Array<{ id: string; number: number; approvedAt: string | null; withdrawnAt: string | null }> };
  script: { id: string; format: Format; revision: number; currentApprovedRevisionId: string | null; draft: { counter: number; parentAdaptationRevisionId: string; parentAdaptationRevisionHash: string; parentAdaptationReviewCounter: number; content: { frames: Frame[] }; sha256: string; baseRevisionId: string | null } | null; revisions: ScriptRevision[] };
  parent: { id: string; sha256: string; eligible: boolean; staleReasons: string[]; blockingReasons: string[] };
}
const json = (route: Route, value: unknown, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(value) });
function makeScriptState(format: Format): ScriptState {
  return { format, formatSelected: true,
    adaptation: { id: `adaptation-${format}`, revision: 2, currentApprovedRevisionId: 'caption-approved', revisions: [{ id: 'caption-approved', number: 1, approvedAt: '2026-10-12T08:00:00Z', withdrawnAt: null }] },
    script: { id: `script-${format}`, format, revision: 0, currentApprovedRevisionId: null, draft: null, revisions: [] },
    parent: { id: 'caption-approved', sha256: 'caption-hash', eligible: true, staleReasons: [], blockingReasons: [] } };
}
function channelState(format: Format) {
  return { format, formatSelected: true, adaptation: null, telegramSelected: false,
    brief: { id: 'brief', revision: 1, currentRevision: { id: 'brief-v1', contentMode: 'CREATIVE' }, history: [] },
    style: { revision: 1 }, prerequisites: { blockingReasons: [], missingBasis: false, unverified: true }, approvedArticle: null,
    eligibleEvidence: [], staleReasons: [], mappingIssues: [], hasUnmapped: false, blockingReasons: [] };
}
async function fixture(page: Page) {
  const format: Format = 'LINKEDIN_CAROUSEL';
  const state = makeScriptState(format);
  const commands: Array<{ path: string; body: Record<string, unknown> }> = [];
  let conflictNextDraft = false;
  let suggestionCounter = 0;
  await page.route('**/api/**', async route => {
    const request = route.request(), url = new URL(request.url()), path = url.pathname;
    if (path === '/api/auth/session') return json(route, { authenticated: true, csrfToken: 'csrf', user: { id: 'editor', email: 'test@example.test', displayName: 'Редактор' } });
    if (path === '/api/auth/preferences') return json(route, { preferences: { idleTimeoutMinutes: 60 } });
    if (path === '/api/auth/external-processing') return json(route, { notice: { version: '1', text: 'Тестова згода' }, accepted: true });
    if (path === '/api/auth/activity') return json(route, { authenticated: true });
    if (path === '/api/auth/logout') return json(route, { authenticated: false });
    if (path === '/api/v1/workspaces') return json(route, { workspaces: [{ id: workspaceId, ownerId: 'editor', name: 'Редакція', archivedAt: null, members: [] }], nextCursor: null });
    if (path === `/api/v1/workspaces/${workspaceId}`) return json(route, { workspace: { id: workspaceId, ownerId: 'editor', name: 'Редакція', archivedAt: null, members: [] } });
    if (path === '/api/v1/projects') return json(route, { projects: [], nextCursor: null });
    if (path === base) return json(route, { project: { id: projectId, workspaceId, topic: 'Міський сервіс', formats: [format], revision: 1, createdAt: '2026-10-12T08:00:00Z', updatedAt: '2026-10-12T08:00:00Z', archivedAt: null } });
    if (path === `${base}/article`) return json(route, { article: null });
    if (path === `${base}/brief`) return json(route, { brief: { id: 'brief', revision: 1, currentRevision: { id: 'brief-v1', contentMode: 'CREATIVE' } } });
    if (path === `${base}/jobs`) return json(route, { jobs: [] });
    if (path === `${base}/telegram` && request.method() === 'GET') return json(route, channelState(url.searchParams.get('format') as Format));
    if (path === `${base}/scripts` && request.method() === 'GET') return json(route, structuredClone(state));
    if (request.method() === 'POST') expect(request.headers()['x-csrf-token']).toBe('csrf');
    if (path === `${base}/scripts/draft`) {
      const body = request.postDataJSON() as Record<string, unknown>;
      commands.push({ path, body });
      if (conflictNextDraft) { conflictNextDraft = false; return json(route, { message: 'conflict' }, 409); }
      const content = body['content'] as { frames: Frame[] };
      const previous = state.script.draft;
      state.script.revision++;
      state.script.draft = { counter: (previous?.counter ?? 0) + 1, parentAdaptationRevisionId: String(body['parentAdaptationRevisionId']), parentAdaptationRevisionHash: 'caption-hash', parentAdaptationReviewCounter: 0,
        content: structuredClone(content), sha256: `draft-${state.script.revision}`, baseRevisionId: null };
      return json(route, structuredClone(state));
    }
    if (path === `${base}/scripts/checkpoint`) {
      const body = request.postDataJSON() as Record<string, unknown>;
      commands.push({ path, body });
      const draft = state.script.draft!;
      const revision: ScriptRevision = { id: `script-revision-${state.script.revisions.length + 1}`, number: state.script.revisions.length + 1, content: structuredClone(draft.content), parentAdaptationRevisionId: draft.parentAdaptationRevisionId,
        reviewCounter: 0, approvedAt: null, withdrawnAt: null, claimsSealed: true, hasUnmapped: true, staleReasons: [], blockingReasons: [], eligible: false };
      state.script.revisions.unshift(revision); state.script.revision++; draft.counter++; draft.baseRevisionId = revision.id;
      return json(route, structuredClone(state));
    }
    if (path.startsWith(`${base}/scripts/revisions/`)) {
      const body = request.postDataJSON() as Record<string, unknown>;
      commands.push({ path, body });
      const [, revisionId, action] = path.match(/\/scripts\/revisions\/([^/]+)\/([^/]+)$/)!;
      const revision = state.script.revisions.find(item => item.id === revisionId)!;
      if (action === 'apply') {
        const ids = body['frameIds'] as string[] | undefined;
        const chosen = ids ? revision.content.frames.filter(frame => ids.includes(frame.id)) : revision.content.frames;
        const old = state.script.draft!;
        const chosenById = new Map(chosen.map(frame => [frame.id, frame]));
        const existingIds = new Set(old.content.frames.map(frame => frame.id));
        const frames = ids ? [...old.content.frames.map(frame => chosenById.get(frame.id) ?? frame), ...chosen.filter(frame => !existingIds.has(frame.id))] : [...chosen];
        state.script.revision++; state.script.draft = { ...old, counter: old.counter + 1, baseRevisionId: ids ? null : revision.id, content: { frames } };
      } else if (action === 'approve') {
        revision.approvedAt = '2026-10-12T09:00:00Z'; revision.eligible = true; state.script.currentApprovedRevisionId = revision.id; state.script.revision++;
      } else if (action === 'withdraw') {
        revision.withdrawnAt = '2026-10-12T10:00:00Z'; state.script.currentApprovedRevisionId = null; state.script.revision++;
      }
      return json(route, structuredClone(state));
    }
    if (path === `${base}/scripts/language-suggestions/review`) {
      const body = request.postDataJSON() as Record<string, unknown>, frame = state.script.draft?.content.frames[0];
      if (!frame) return json(route, { suggestions: [] });
      const suggestion = { id: `script-language-${++suggestionCounter}`, frameId: frame.id, startOffset: 0, endOffset: frame.text.length, originalText: frame.text,
        replacementText: 'Оновлений точний текст кадру.', finding: 'Уточнити формулювання', status: 'OPEN', contentHash: 'hash' };
      commands.push({ path, body });
      return json(route, { sourceRevisionId: body['sourceRevisionId'], expectedRevision: state.script.revision, suggestions: [suggestion] });
    }
    if (path === `${base}/scripts/language-suggestions/accept`) {
      const body = request.postDataJSON() as Record<string, unknown>, frame = state.script.draft!.content.frames[0]!;
      commands.push({ path, body }); frame.text = 'Оновлений точний текст кадру.'; state.script.revision++; state.script.draft!.counter++; state.script.draft!.baseRevisionId = null;
      return json(route, { expectedRevision: state.script.revision, content: structuredClone(state.script.draft!.content) });
    }
    if (path.includes('/scripts/language-suggestions/') && path.endsWith('/reject')) return json(route, {});
    return json(route, {});
  });
  await page.goto(`/projects/${projectId}/channels?format=${format}`);
  await expect(page.getByRole('heading', { name: 'Сценарій каруселі LinkedIn' })).toBeVisible();
  return { state, commands, setConflict: () => { conflictNextDraft = true; } };
}

test('manual frames keep stable IDs through reorder and can be checkpointed and approved independently', async ({ page }) => {
  const ctx = await fixture(page);
  await page.locator('.script-workspace').getByLabel('Підпис, для якого створено сценарій').selectOption('caption-approved');
  await page.locator('.script-workspace').getByRole('button', { name: 'Додати кадр' }).click();
  await page.locator('.script-workspace').getByRole('textbox', { name: 'Призначення кадру' }).fill('Висновок');
  await page.locator('.script-workspace').getByRole('textbox', { name: 'Точний текст' }).fill('Зміна вже почалася.');
  await expect.poll(() => ctx.state.script.draft?.content.frames.length).toBe(1);
  const firstId = ctx.state.script.draft?.content.frames[0]?.id;
  await page.locator('.script-workspace').getByRole('button', { name: 'Додати кадр' }).click();
  await page.locator('.script-workspace').getByRole('textbox', { name: 'Призначення кадру' }).fill('Причина');
  await page.locator('.script-workspace').getByRole('textbox', { name: 'Точний текст' }).fill('Команда оновила сервіс.');
  await expect.poll(() => ctx.state.script.draft?.content.frames.length).toBe(2);
  const secondId = ctx.state.script.draft!.content.frames[1]!.id;
  await page.locator('.script-workspace').getByRole('button', { name: 'Кадр 2: Причина' }).focus();
  await page.locator('.script-workspace').getByRole('button', { name: 'Кадр 2: Причина' }).press('Alt+ArrowUp');
  await expect.poll(() => ctx.state.script.draft?.content.frames[0]?.id).toBe(secondId);
  expect(ctx.state.script.draft!.content.frames[1]!.id).toBe(firstId);
  await page.locator('.script-workspace').getByRole('button', { name: 'Зберегти версію' }).click();
  await expect(page.locator('.script-workspace').getByRole('region', { name: 'Історія сценаріїв' }).getByText('Версія 1', { exact: true })).toBeVisible();
  await page.locator('.script-workspace').getByLabel(/Підтверджую, що непов’язаний/).check();
  await page.locator('.script-workspace').getByRole('button', { name: 'Погодити' }).click();
  await expect.poll(() => ctx.state.script.currentApprovedRevisionId).toBe('script-revision-1');
  mkdirSync('.local-checks/m42', { recursive: true });
  for (const width of [1280, 768, 390]) {
    await page.setViewportSize({ width, height: 900 });
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: `.local-checks/m42/scripts-${width}.png`, fullPage: true });
  }
});

test('a 409 keeps local frame text and allows an explicit retry against refreshed state', async ({ page }) => {
  const ctx = await fixture(page);
  await page.locator('.script-workspace').getByLabel('Підпис, для якого створено сценарій').selectOption('caption-approved');
  await page.locator('.script-workspace').getByRole('button', { name: 'Додати кадр' }).click();
  await page.locator('.script-workspace').getByRole('textbox', { name: 'Призначення кадру' }).fill('Пояснення');
  await page.locator('.script-workspace').getByRole('textbox', { name: 'Точний текст' }).fill('Початковий текст кадру.');
  await expect.poll(() => ctx.state.script.draft?.content.frames.length).toBe(1);
  ctx.setConflict();
  const text = page.locator('.script-workspace').getByRole('textbox', { name: 'Точний текст' });
  await text.fill('Локальний текст після конфлікту.');
  await expect(page.locator('.script-workspace').getByRole('alert').getByText(/новіша версія/)).toBeVisible();
  await expect(text).toHaveValue('Локальний текст після конфлікту.');
  await page.locator('.script-workspace').getByRole('button', { name: 'Спробувати зберегти мій текст' }).click();
  await expect.poll(() => ctx.state.script.draft?.content.frames[0]?.text).toBe('Локальний текст після конфлікту.');
  await expect(text).toHaveValue('Локальний текст після конфлікту.');
});

test('selective application carries only checked frames into the draft', async ({ page }) => {
  const ctx = await fixture(page);
  await page.locator('.script-workspace').getByLabel('Підпис, для якого створено сценарій').selectOption('caption-approved');
  await page.locator('.script-workspace').getByRole('button', { name: 'Додати кадр' }).click();
  await page.locator('.script-workspace').getByRole('textbox', { name: 'Призначення кадру' }).fill('Перший');
  await page.locator('.script-workspace').getByRole('textbox', { name: 'Точний текст' }).fill('Текст першого кадру.');
  await page.locator('.script-workspace').getByRole('button', { name: 'Додати кадр' }).click();
  await page.locator('.script-workspace').getByRole('textbox', { name: 'Призначення кадру' }).fill('Другий');
  await page.locator('.script-workspace').getByRole('textbox', { name: 'Точний текст' }).fill('Текст другого кадру.');
  await expect.poll(() => ctx.state.script.draft?.content.frames.length).toBe(2);
  await page.locator('.script-workspace').getByRole('button', { name: 'Зберегти версію' }).click();
  await page.locator('.script-workspace').getByText('Переглянути кадри й вибрати для застосування').click();
  const boxes = page.locator('.script-workspace').getByRole('checkbox');
  await boxes.first().check();
  await page.locator('.script-workspace').getByRole('button', { name: 'Застосувати вибрані (1)' }).click();
  await expect.poll(() => ctx.state.script.draft?.content.frames.length).toBe(2);
  await expect.poll(() => ctx.state.script.draft?.content.frames[0]?.purpose).toBe('Перший');
  expect(ctx.state.script.draft!.content.frames[1]!.purpose).toBe('Другий');
  expect(ctx.commands.some(command => command.path.endsWith('/apply') && (command.body['frameIds'] as string[]).length === 1)).toBe(true);
});

test('frame language proposals change exact text only after explicit acceptance', async ({ page }) => {
  const ctx = await fixture(page);
  await page.locator('.script-workspace').getByLabel('Підпис, для якого створено сценарій').selectOption('caption-approved');
  await page.locator('.script-workspace').getByRole('button', { name: 'Додати кадр' }).click();
  await page.locator('.script-workspace').getByRole('textbox', { name: 'Призначення кадру' }).fill('Фінал');
  await page.locator('.script-workspace').getByRole('textbox', { name: 'Точний текст' }).fill('Чернетка кадру.');
  await expect.poll(() => ctx.state.script.draft?.content.frames.length).toBe(1);
  await page.locator('.script-workspace').getByRole('button', { name: 'Зберегти версію' }).click();
  await page.locator('.script-workspace').getByRole('button', { name: 'Перевірити мову' }).click();
  await expect(page.locator('.script-workspace').getByText('Уточнити формулювання')).toBeVisible();
  const text = page.locator('.script-workspace').getByRole('textbox', { name: 'Точний текст' });
  await expect(text).toHaveValue('Чернетка кадру.');
  await page.locator('.script-workspace').getByRole('checkbox', { name: 'Застосувати цю правку' }).check();
  await page.locator('.script-workspace').getByRole('button', { name: 'Застосувати вибрані правки' }).click();
  await expect(text).toHaveValue('Оновлений точний текст кадру.');
  expect(ctx.commands.some(command => command.path.endsWith('/language-suggestions/accept'))).toBe(true);
});
