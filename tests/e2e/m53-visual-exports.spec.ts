import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { test, expect, type Page, type Route } from '@playwright/test';

const projectId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const workspaceId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const base = `/api/v1/projects/${projectId}`;
type Format = 'LINKEDIN_COVER' | 'INSTAGRAM_CAROUSEL';
type Json = Record<string, unknown>;
type Frame = { id: string; sourceFrameId: string; purpose: string; templateId: string; background: string; layers: Array<Record<string, unknown>> };
type Composition = { schemaVersion: 'visual-v1'; rendererVersion: string; width: 1080; height: 1080; frames: Frame[] };
type Preview = { id: string; frameId: string; assetId: string; sha256: string; overflow: string[]; rendererVersion: string; fontHashes: Record<string, string> };
type Revision = { id: string; number: number; content: Composition; sha256: string; parentKind: string; parentRevisionId: string; parentRevisionHash: string; parentReviewCounter: number; reviewCounter: number; approvedBy: string | null; approvedAt: string | null; withdrawnBy: string | null; withdrawnAt: string | null; eligible: boolean; staleReasons: string[]; blockingReasons: string[]; hasUnmapped: boolean; previews: Preview[] };
type VisualState = { format: Format; formatSelected: boolean; style: { revision: number; revisionId: string; defaults: { background: string; text: string; accent: string; font: string; logo: null } }; parent: { kind: 'ADAPTATION' | 'SCRIPT'; id: string; sha256: string; reviewCounter: number; content: unknown; staleReasons: string[]; blockingReasons: string[]; eligible: boolean }; composition: { id: string; revision: number; currentApprovedRevisionId: string | null; draft: { counter: number; content: Composition; sha256: string; parentKind: string; parentRevisionId: string; parentRevisionHash: string; parentReviewCounter: number }; revisions: Revision[] } };
type ExportBody = { expectedProjectRevision: number; commandKey: string; format: 'PNG' | 'PDF' | 'ZIP'; items: Array<{ format: string; revisionId: string; reviewCounter: number }> };
type ExportRecord = { id: string; format: 'PNG' | 'PDF' | 'ZIP'; status: 'READY'; createdAt: string; jobId: string; retryAllowed: boolean; errorCategory: null; filename: string };

const json = (route: Route, value: unknown, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(value) });
const frameId = (index: number) => `00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`;
const revisionId = (format: Format) => format === 'LINKEDIN_COVER' ? '50000000-0000-4000-8000-000000000001' : '50000000-0000-4000-8000-000000000002';

function composition(format: Format): Composition {
  const count = format === 'LINKEDIN_COVER' ? 1 : 3;
  const height = 1080;
  return {
    schemaVersion: 'visual-v1', rendererVersion: 'konva-10.7.1-visual-v1', width: 1080, height,
    frames: Array.from({ length: count }, (_, index): Frame => ({
      id: frameId(index), sourceFrameId: frameId(index), purpose: `Кадр ${index + 1}`, templateId: 'editorial', background: '#ffffff',
      layers: [{ id: `10000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`, type: 'text', x: 84, y: 110, width: 912, height: 860,
        text: `Міський сервіс — кадр ${index + 1}`, font: 'onest', fontSize: 56, fontWeight: '600', color: '#20262b', align: 'left', lineHeight: 1.2, mappings: [] }],
    })),
  };
}

function initialState(format: Format, approved = false): VisualState {
  const content = composition(format);
  const id = revisionId(format);
  const hash = `sha256-${format}`;
  const previews: Preview[] = approved ? content.frames.map((frame, index) => ({
    id: `60000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`, frameId: frame.id,
    assetId: `70000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`, sha256: '', overflow: [], rendererVersion: 'chromium-visual-v1', fontHashes: {},
  })) : [];
  return {
    format, formatSelected: true,
    style: { revision: 1, revisionId: '20000000-0000-4000-8000-000000000001', defaults: { background: '#ffffff', text: '#20262b', accent: '#343a40', font: 'onest', logo: null } },
    parent: { kind: format === 'LINKEDIN_COVER' ? 'ADAPTATION' : 'SCRIPT', id: '30000000-0000-4000-8000-000000000001', sha256: 'approved-parent-hash', reviewCounter: 3, content: {}, staleReasons: [], blockingReasons: [], eligible: true },
    composition: {
      id: `40000000-0000-4000-8000-${format === 'LINKEDIN_COVER' ? '000000000001' : '000000000002'}`,
      revision: 2, currentApprovedRevisionId: approved ? id : null,
      draft: { counter: 1, content, sha256: hash, parentKind: format === 'LINKEDIN_COVER' ? 'ADAPTATION' : 'SCRIPT', parentRevisionId: '30000000-0000-4000-8000-000000000001', parentRevisionHash: 'approved-parent-hash', parentReviewCounter: 3 },
      revisions: [{ id, number: 1, content, sha256: hash, parentKind: format === 'LINKEDIN_COVER' ? 'ADAPTATION' : 'SCRIPT', parentRevisionId: '30000000-0000-4000-8000-000000000001', parentRevisionHash: 'approved-parent-hash', parentReviewCounter: 3,
        reviewCounter: approved ? 4 : 0, approvedBy: approved ? 'editor' : null, approvedAt: approved ? '2026-10-13T10:00:00.000Z' : null, withdrawnBy: null, withdrawnAt: null, eligible: true, staleReasons: [], blockingReasons: [], hasUnmapped: true, previews }],
    },
  };
}

async function fixture(page: Page, options: { approved?: boolean } = {}) {
  const states = new Map<Format, VisualState>([
    ['LINKEDIN_COVER', initialState('LINKEDIN_COVER', options.approved)],
    ['INSTAGRAM_CAROUSEL', initialState('INSTAGRAM_CAROUSEL', options.approved)],
  ]);
  const commands: Array<{ path: string; body?: unknown }> = [];
  const previewCalls: string[] = [];
  const visualReadiness = (format: Format) => {
    const revision = states.get(format)!.composition.revisions[0]!;
    const ready = states.get(format)!.composition.currentApprovedRevisionId === revision.id && !revision.withdrawnBy;
    return { revisionId: revision.id, reviewCounter: revision.reviewCounter, ready, reasons: ready ? [] : ['VISUAL_NOT_APPROVED'] };
  };
  const exportItems = () => [
    { format: 'LINKEDIN_COVER_VISUAL', title: 'Готова обкладинка LinkedIn', number: 1, contentMode: 'CREATIVE', ...visualReadiness('LINKEDIN_COVER') },
    { format: 'INSTAGRAM_CAROUSEL_VISUAL', title: 'Готова карусель Instagram', number: 1, contentMode: 'CREATIVE', ...visualReadiness('INSTAGRAM_CAROUSEL') },
    { format: 'TELEGRAM_POST', title: 'Допис у Telegram', revisionId: '80000000-0000-4000-8000-000000000001', number: 2, reviewCounter: 2, contentMode: 'FACTUAL', ready: true, reasons: [] },
  ];
  const exports: ExportRecord[] = [];
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/S4kAAAAASUVORK5CYII=', 'base64');
  const pngHash = createHash('sha256').update(png).digest('hex');
  await page.route('**/api/**', async route => {
    const request = route.request(), url = new URL(request.url()), path = url.pathname;
    if (path === '/api/auth/session') return json(route, { authenticated: true, csrfToken: 'csrf', user: { id: 'editor', email: 'test@example.test', displayName: 'Редактор' } });
    if (path === '/api/auth/preferences') return json(route, { preferences: { idleTimeoutMinutes: 60 } });
    if (path === '/api/auth/external-processing') return json(route, { notice: { version: '1', text: 'Тестова згода' }, accepted: true });
    if (path === '/api/auth/activity') return json(route, { authenticated: true });
    if (path === '/api/v1/workspaces') return json(route, { workspaces: [{ id: workspaceId, ownerId: 'editor', name: 'Редакція', archivedAt: null, trashedAt: null, purgeAfter: null, lifecycleRevision: 1, members: [] }], nextCursor: null });
    if (path === `/api/v1/workspaces/${workspaceId}`) return json(route, { workspace: { id: workspaceId, ownerId: 'editor', name: 'Редакція', archivedAt: null, trashedAt: null, purgeAfter: null, lifecycleRevision: 1, members: [] } });
    if (path === '/api/v1/projects') return json(route, { projects: [], nextCursor: null });
    if (path === base) return json(route, { project: { id: projectId, workspaceId, topic: 'Міський сервіс', formats: ['LINKEDIN_COVER', 'INSTAGRAM_CAROUSEL', 'TELEGRAM_POST'], revision: 1, createdAt: '2026-10-13T08:00:00Z', updatedAt: '2026-10-13T08:00:00Z', archivedAt: null } });
    if (path === `${base}/article`) return json(route, { article: null });
    if (path === `${base}/visuals` && request.method() === 'GET') return json(route, structuredClone(states.get(url.searchParams.get('format') as Format)));
    if (request.method() === 'POST') expect(request.headers()['x-csrf-token']).toBe('csrf');
    const visual = path.match(new RegExp(`^${base}/visuals/revisions/([^/]+)/(preview|approve|withdraw)$`));
    if (visual?.[2] === 'preview') {
      const body = request.postDataJSON() as { frameId: string };
      previewCalls.push(String(body.frameId)); commands.push({ path, body });
      return json(route, { assetId: `70000000-0000-4000-8000-${String(previewCalls.length).padStart(12, '0')}`, frameId: body.frameId, sha256: pngHash, overflow: [], rendererVersion: 'chromium-visual-v1', fontHashes: {} });
    }
    if (path.startsWith(`${base}/visuals/preview/`)) return route.fulfill({ status: 200, contentType: 'image/png', body: png });
    if (visual?.[2] === 'approve') {
      const format = url.searchParams.get('format') as Format, current = states.get(format)!, revision = current.composition.revisions[0]!;
      commands.push({ path, body: request.postDataJSON() as Json });
      revision.previews = revision.content.frames.map((frame, index) => ({ id: `60000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`, frameId: frame.id, assetId: `70000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`, sha256: pngHash, overflow: [], rendererVersion: 'chromium-visual-v1', fontHashes: {} }));
      revision.reviewCounter++; revision.approvedBy = 'editor'; revision.approvedAt = '2026-10-13T10:00:00.000Z'; current.composition.currentApprovedRevisionId = revision.id;
      return json(route, structuredClone(current));
    }
    if (visual?.[2] === 'withdraw') {
      const format = url.searchParams.get('format') as Format, current = states.get(format)!, revision = current.composition.revisions[0]!;
      commands.push({ path, body: request.postDataJSON() as Json });
      revision.reviewCounter++; revision.withdrawnBy = 'editor'; revision.withdrawnAt = '2026-10-13T11:00:00.000Z'; current.composition.currentApprovedRevisionId = null;
      return json(route, structuredClone(current));
    }
    if (path === `${base}/exports` && request.method() === 'GET') return json(route, { projectRevision: 1, ready: true, items: exportItems(), exports: structuredClone(exports) });
    if (path === `${base}/exports` && request.method() === 'POST') {
      const body = request.postDataJSON() as ExportBody; commands.push({ path, body });
      const item: ExportRecord = { id: `90000000-0000-4000-8000-${String(exports.length + 1).padStart(12, '0')}`, format: body.format, status: 'READY', createdAt: '2026-10-13T12:00:00.000Z', jobId: `91000000-0000-4000-8000-${String(exports.length + 1).padStart(12, '0')}`, retryAllowed: false, errorCategory: null, filename: `synthetic-${String(body.format).toLowerCase()}.${String(body.format).toLowerCase()}` };
      exports.unshift(item);
      return json(route, { exportId: item.id, jobId: item.jobId }, 201);
    }
    if (path.includes('/exports/') && path.endsWith('/download')) {
      const exportId = path.split('/').at(-2), item = exports.find(value => value.id === exportId);
      return route.fulfill({ status: 200, contentType: 'application/octet-stream', headers: { 'Content-Disposition': `attachment; filename="${item?.filename ?? 'synthetic-export.bin'}"` }, body: png });
    }
    return json(route, {});
  });
  return { states, commands, previewCalls };
}

async function openVisuals(page: Page, format: Format) {
  await page.goto(`/projects/${projectId}/visuals?format=${format}`);
  await expect(page.getByRole('heading', { name: 'Візуали' })).toBeVisible();
}

async function captureWidths(page: Page, name: string) {
  mkdirSync('.local-checks/m53/browser', { recursive: true });
  for (const width of [1280, 768, 390]) {
    await page.setViewportSize({ width, height: 980 });
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: `.local-checks/m53/browser/${name}-${width}.png`, fullPage: true });
  }
}

test('approval waits for every canonical frame preview and explicit unmapped-text acknowledgement', async ({ page }) => {
  const ctx = await fixture(page);
  await openVisuals(page, 'INSTAGRAM_CAROUSEL');
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.keyboard.press('Tab');
  await expect(page.locator(':focus-visible')).toHaveCount(1);
  const prepare = page.getByRole('button', { name: 'Підготувати прев’ю всіх кадрів і погодити' });
  await prepare.click();
  await expect(page.getByText('Підтвердьте окремо, що текст без зіставлення не підтверджений джерелами.')).toBeVisible();
  expect(ctx.previewCalls).toEqual([frameId(0), frameId(1), frameId(2)]);
  expect(ctx.commands.some(row => row.path.endsWith('/approve'))).toBe(false);
  await captureWidths(page, 'unapproved-visual');
  await page.getByRole('checkbox', { name: /Я перевірив текст без зіставлення/ }).check();
  await prepare.click();
  await expect(page.getByText(/Візуальну версію 1 погоджено/)).toBeVisible();
  const approve = ctx.commands.find(row => row.path.endsWith('/approve'))!;
  expect(approve.body).toMatchObject({ expectedRevision: 2, expectedReviewCounter: 0, acknowledgeUnmapped: true });
  expect(ctx.states.get('INSTAGRAM_CAROUSEL')!.composition.currentApprovedRevisionId).toBe(revisionId('INSTAGRAM_CAROUSEL'));
  expect(ctx.previewCalls).toHaveLength(6);
  await captureWidths(page, 'approved-visual');
});

test('withdrawal preserves the visual revision in history and leaves independently ready text selectable', async ({ page }) => {
  const ctx = await fixture(page, { approved: true });
  await openVisuals(page, 'LINKEDIN_COVER');
  await page.getByRole('button', { name: 'Відкликати погодження' }).click();
  await expect(page.getByText(/Погодження версії 1 відкликано/)).toBeVisible();
  await expect(page.getByText(/Погодження відкликано/)).toBeVisible();
  expect(ctx.states.get('LINKEDIN_COVER')!.composition.revisions[0]!.withdrawnBy).toBe('editor');
  await page.goto(`/projects/${projectId}/export`);
  await expect(page.getByRole('heading', { name: 'Готовність і експорт' })).toBeVisible();
  await expect(page.getByRole('checkbox', { name: 'Вибрати Готова обкладинка LinkedIn' })).toBeDisabled();
  await expect(page.getByRole('checkbox', { name: 'Вибрати Допис у Telegram' })).toBeEnabled();
  await captureWidths(page, 'withdrawn-export');
});

test('exports approved PNG, carousel PDF and mixed ZIP without requiring an Article; downloads stay available', async ({ page }) => {
  const ctx = await fixture(page, { approved: true });
  await page.goto(`/projects/${projectId}/export`);
  await expect(page.getByRole('heading', { name: 'Готовність і експорт' })).toBeVisible();
  await page.getByRole('checkbox', { name: 'Вибрати Готова обкладинка LinkedIn' }).check();
  await expect(page.getByRole('radio', { name: 'PNG обкладинки' })).toBeChecked();
  await page.getByRole('button', { name: 'Підготувати файл' }).click();
  await expect(page.getByText('Файл додано до черги. Матеріали можна й далі переглядати.')).toBeVisible();
  await expect.poll(() => ctx.commands.filter(row => row.path === `${base}/exports`).length).toBe(1);
  const png = ctx.commands.find(row => row.path === `${base}/exports`)!.body as ExportBody;
  expect(png).toMatchObject({ format: 'PNG', items: [{ format: 'LINKEDIN_COVER_VISUAL', revisionId: revisionId('LINKEDIN_COVER'), reviewCounter: 4 }] });
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Завантажити' }).first().click();
  expect((await download).suggestedFilename()).toContain('png');

  await page.reload();
  await expect(page.getByRole('heading', { name: 'Готовність і експорт' })).toBeVisible();
  await page.getByRole('checkbox', { name: 'Вибрати Готова карусель Instagram' }).check();
  await expect(page.getByRole('radio', { name: 'PDF каруселі' })).toBeChecked();
  await page.getByRole('button', { name: 'Підготувати файл' }).click();
  await expect(page.getByText('Файл додано до черги. Матеріали можна й далі переглядати.')).toBeVisible();
  await expect.poll(() => ctx.commands.filter(row => row.path === `${base}/exports`).length).toBe(2);
  const pdf = ctx.commands.filter(row => row.path === `${base}/exports`)[1]!.body as ExportBody;
  expect(pdf).toMatchObject({ format: 'PDF', items: [{ format: 'INSTAGRAM_CAROUSEL_VISUAL', revisionId: revisionId('INSTAGRAM_CAROUSEL'), reviewCounter: 4 }] });
  const pdfDownload = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Завантажити' }).first().click();
  expect((await pdfDownload).suggestedFilename()).toContain('pdf');
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Готовність і експорт' })).toBeVisible();
  await page.getByRole('checkbox', { name: 'Вибрати Готова обкладинка LinkedIn' }).check();
  await page.getByRole('checkbox', { name: 'Вибрати Готова карусель Instagram' }).check();
  await page.getByRole('checkbox', { name: 'Вибрати Допис у Telegram' }).check();
  await expect(page.getByRole('radio', { name: 'ZIP-архів' })).toBeChecked();
  await page.getByRole('button', { name: 'Підготувати файл' }).click();
  await expect.poll(() => ctx.commands.filter(row => row.path === `${base}/exports`).length).toBe(3);
  const zip = ctx.commands.filter(row => row.path === `${base}/exports`)[2]!.body as ExportBody;
  expect(zip.format).toBe('ZIP');
  expect(zip.items).toHaveLength(3);
  expect(zip.items.some(item => item.format === 'ARTICLE')).toBe(false);
  expect(zip.items.map(item => item.format)).toEqual(['LINKEDIN_COVER_VISUAL', 'INSTAGRAM_CAROUSEL_VISUAL', 'TELEGRAM_POST']);
  await captureWidths(page, 'exports-ready');
});

test('unsaved visual text recovers after reload without replacing the approved revision', async ({ page }) => {
  const ctx = await fixture(page, { approved: true });
  await openVisuals(page, 'LINKEDIN_COVER');
  await page.clock.install();
  const text = page.getByRole('textbox', { name: 'Текст', exact: true });
  await text.fill('Локальна чернетка для відновлення');
  await expect(page.getByText('Чернетка', { exact: true })).toBeVisible();
  await captureWidths(page, 'visual-recovery');
  await page.reload();
  await expect(text).toHaveValue('Локальна чернетка для відновлення');
  await expect(page.getByText('Відновлено локальні правки.', { exact: false })).toBeVisible();
  expect(ctx.states.get('LINKEDIN_COVER')!.composition.currentApprovedRevisionId).toBe(revisionId('LINKEDIN_COVER'));
});
