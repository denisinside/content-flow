import { mkdirSync } from 'node:fs';
import { test, expect, type Page, type Route } from '@playwright/test';

const projectId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const workspaceId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const base = `/api/v1/projects/${projectId}`;
type ChannelFormat = 'LINKEDIN_TEXT' | 'INSTAGRAM_COVER';
type Content = { text: string; mappings: unknown[]; cover?: { text: string; instruction: string } };
type Draft = { content: Content; inputMode: string; contentMode: string; includeLink: boolean; baseRevisionId: string | null };
type Version = { id: string; number: number; content: Content; inputMode: string; contentMode: string; includeLink: boolean; status: string;
  origin: string; reviewCounter: number; approvedAt: string | null; approvedBy: string | null; staleReasons: string[]; blockingReasons: string[] };
type ChannelState = { format: ChannelFormat; formatSelected: boolean; adaptation: { id: string; revision: number; draft: Draft | null;
  currentApprovedRevisionId: string | null; revisions: Version[] } | null; telegramSelected: boolean; brief: { id: string; revision: number;
    currentRevision: { id: string; contentMode: string }; history: unknown[] }; style: { revision: number };
  prerequisites: { blockingReasons: string[]; missingBasis: boolean; unverified: boolean }; approvedArticle: null;
  eligibleEvidence: unknown[]; staleReasons: string[]; mappingIssues: unknown[]; hasUnmapped: boolean; blockingReasons: string[] };
type LanguageSuggestion = { id: string; sourceRevisionId: string; locator: { start: number; end: number }; originalText: string;
  replacementText: string; finding: string; status: 'OPEN' | 'ACCEPTED' | 'REJECTED'; stale: boolean };

const json = (route: Route, value: unknown, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(value) });
function makeState(format: ChannelFormat): ChannelState {
  return { format, formatSelected: true, adaptation: null, telegramSelected: false,
    brief: { id: 'brief', revision: 1, currentRevision: { id: 'brief-v1', contentMode: 'CREATIVE' }, history: [] },
    style: { revision: 1 }, prerequisites: { blockingReasons: [], missingBasis: false, unverified: true }, approvedArticle: null,
    eligibleEvidence: [], staleReasons: [], mappingIssues: [], hasUnmapped: false, blockingReasons: [] };
}
async function fixture(page: Page) {
  const states: Record<ChannelFormat, ChannelState> = { LINKEDIN_TEXT: makeState('LINKEDIN_TEXT'), INSTAGRAM_COVER: makeState('INSTAGRAM_COVER') };
  const commands: Array<{ format: ChannelFormat; path: string; body: Record<string, unknown> }> = [];
  const suggestions = new Map<string, LanguageSuggestion[]>();
  const acceptedSources: string[] = [];
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
    if (path === base) return json(route, { project: { id: projectId, workspaceId, topic: 'Міський сервіс', formats: ['LINKEDIN_TEXT', 'INSTAGRAM_COVER'],
      revision: 1, createdAt: '2026-10-11T08:00:00Z', updatedAt: '2026-10-11T08:00:00Z', archivedAt: null } });
    if (path === `${base}/article`) return json(route, { article: null });
    if (path === `${base}/brief`) return json(route, { brief: { id: 'brief', revision: 1, currentRevision: { id: 'brief-v1', contentMode: 'CREATIVE' } } });
    if (path === `${base}/jobs`) return json(route, { jobs: [] });
    if (path === `${base}/telegram` && request.method() === 'GET') {
      const format = url.searchParams.get('format') as ChannelFormat;
      return json(route, states[format]);
    }
    if (path === `${base}/language-suggestions` && request.method() === 'GET') {
      const key = url.searchParams.get('sourceRevisionId') ?? '';
      return json(route, { suggestions: suggestions.get(key) ?? [] });
    }
    if (request.method() === 'POST') expect(request.headers()['x-csrf-token']).toBe('csrf');
    if (path.startsWith(`${base}/language-suggestions`)) {
      const body = request.postDataJSON() as Record<string, unknown>;
      if (path.endsWith('/review')) {
        const sourceRevisionId = String(body['sourceRevisionId']);
        const state = states['INSTAGRAM_COVER'];
        const source = state.adaptation!.revisions.find(row => row.id === sourceRevisionId)!;
        const originalText = source.content.text;
        const suggestion: LanguageSuggestion = { id: 'suggestion-1', sourceRevisionId, locator: { start: 0, end: originalText.length },
          originalText, replacementText: 'Оновлення міського сервісу вже близько.', finding: 'Уточнити формулювання', status: 'OPEN', stale: false };
        suggestions.set(sourceRevisionId, [suggestion]);
        commands.push({ format: 'INSTAGRAM_COVER', path, body });
        return json(route, { suggestions: [suggestion] });
      }
      if (path.endsWith('/accept')) {
        const sourceRevisionId = String(body['sourceRevisionId']);
        acceptedSources.push(sourceRevisionId);
        const state = states['INSTAGRAM_COVER'];
        const source = state.adaptation!.revisions.find(row => row.id === sourceRevisionId)!;
        state.adaptation!.revision++;
        state.adaptation!.draft = { content: { ...source.content, text: 'Оновлення міського сервісу вже близько.' }, inputMode: source.inputMode,
          contentMode: source.contentMode, includeLink: false, baseRevisionId: sourceRevisionId };
        const rows = suggestions.get(sourceRevisionId) ?? [];
        for (const row of rows) row.status = 'ACCEPTED';
        commands.push({ format: 'INSTAGRAM_COVER', path, body });
        return json(route, { accepted: [String((body['suggestionIds'] as string[])[0])] });
      }
      return json(route, {});
    }
    if (path.includes('/telegram')) {
      const body = request.postDataJSON() as Record<string, unknown>, format = body['format'] as ChannelFormat;
      const state = states[format], adaptation = state.adaptation, action = path.slice(`${base}/telegram`.length);
      commands.push({ format, path, body });
      if (action === '/draft') {
        const revision = (adaptation?.revision ?? 0) + 1;
        state.adaptation = { id: `adaptation-${format}`, revision, draft: { content: structuredClone(body['content']) as Content, inputMode: String(body['inputMode']),
          contentMode: String(body['contentMode']), includeLink: false, baseRevisionId: adaptation?.draft?.baseRevisionId ?? null },
          currentApprovedRevisionId: adaptation?.currentApprovedRevisionId ?? null, revisions: adaptation?.revisions ?? [] };
      } else if (action === '/checkpoint') {
        const current = state.adaptation!; const draft = current.draft!;
        const revision: Version = { id: `revision-${format}`, number: current.revisions.length + 1, content: structuredClone(draft.content), inputMode: draft.inputMode,
          contentMode: draft.contentMode, includeLink: false, status: 'PROPOSED', origin: 'MANUAL', reviewCounter: 0, approvedAt: null, approvedBy: null, staleReasons: [], blockingReasons: [] };
        current.revision++; current.draft = { ...draft, baseRevisionId: revision.id }; current.revisions.unshift(revision);
      } else if (action.endsWith('/approve')) {
        const current = state.adaptation!, revision = current.revisions[0]!;
        revision.status = 'APPROVED'; revision.approvedAt = '2026-10-11T09:00:00Z'; revision.approvedBy = 'editor';
        current.currentApprovedRevisionId = revision.id; current.revision++;
      }
      return json(route, structuredClone(state));
    }
    return json(route, {});
  });
  await page.goto(`/projects/${projectId}/channels?format=LINKEDIN_TEXT`);
  await expect(page.getByRole('heading', { name: 'Публікація у LinkedIn' })).toBeVisible();
  return { states, commands, acceptedSources };
}

test('channels-only LinkedIn and Instagram edits stay separate; language proposals change text only after acceptance', async ({ page }) => {
  const context = await fixture(page);
  const publication = page.getByRole('textbox', { name: 'Текст публікації' });
  await publication.fill('Ручний текст для LinkedIn.');
  await expect(page.getByText('Збережено', { exact: true })).toBeVisible();
  await page.getByLabel('Формат').selectOption('INSTAGRAM_COVER');
  await page.waitForURL(/format=INSTAGRAM_COVER/);
  await expect(page.getByRole('heading', { name: 'Обкладинка Instagram' })).toBeVisible();
  const caption = page.getByRole('textbox', { name: 'Текст публікації' });
  await caption.fill('Міський сервіс оновлюється.');
  await page.getByRole('textbox', { name: 'Текст на обкладинці' }).fill('Місто змінюється щодня');
  await page.getByRole('textbox', { name: 'Завдання для обкладинки' }).fill('Використати світлу фотографію міської вулиці.');
  await expect(page.getByText('Збережено', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Зберегти версію' }).click();
  await page.getByRole('button', { name: 'Перевірити мову' }).click();
  await expect(page.getByText('Перегляньте пропозиції та виберіть, які застосувати.')).toBeVisible();
  await expect(caption).toHaveValue('Міський сервіс оновлюється.');
  expect(context.states['INSTAGRAM_COVER'].adaptation!.revisions[0]!.content.text).toBe('Міський сервіс оновлюється.');
  await page.getByRole('button', { name: 'Застосувати вибрані правки' }).click();
  await expect(caption).toHaveValue('Оновлення міського сервісу вже близько.');
  expect(context.acceptedSources).toEqual(['revision-INSTAGRAM_COVER']);
  expect(context.states['INSTAGRAM_COVER'].adaptation!.revisions[0]!.content.text).toBe('Міський сервіс оновлюється.');
  mkdirSync('.local-checks/m41', { recursive: true });
  for (const width of [1280, 768, 390]) {
    await page.setViewportSize({ width, height: 900 });
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: `.local-checks/m41/cover-${width}.png`, fullPage: true });
  }
  await page.getByLabel('Формат').selectOption('LINKEDIN_TEXT');
  await page.waitForURL(/format=LINKEDIN_TEXT/);
  await expect(page.getByRole('textbox', { name: 'Текст публікації' })).toHaveValue('Ручний текст для LinkedIn.');
  expect(context.commands.some(command => command.format === 'INSTAGRAM_COVER' && command.body['content'] &&
    (command.body['content'] as Content).cover?.text === 'Місто змінюється щодня')).toBe(true);
  mkdirSync('.local-checks/m41', { recursive: true });
  for (const width of [1280, 768, 390]) {
    await page.setViewportSize({ width, height: 900 });
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: `.local-checks/m41/channels-${width}.png`, fullPage: true });
  }
});
