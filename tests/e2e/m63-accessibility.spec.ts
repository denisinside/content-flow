import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { test, expect, type Page } from '@playwright/test';
import type { AxeResults } from 'axe-core';
import { installM63Fixture, projectId, sourceName, snapshotVersion } from './fixtures/m63-editorial.js';

type AxeRunner = {
  version: string;
  run: (context: Document, options: { runOnly: { type: 'tag'; values: string[] } }) => Promise<AxeResults>;
};
declare global {
  interface Window { axe?: AxeRunner }
}

const require = createRequire(import.meta.url);
const axeScript = require.resolve('axe-core/axe.min.js');
const axeSource = readFileSync(axeScript, 'utf8');
const axeRoutes = new WeakSet<Page>();
const round = process.env['M63_ROUND'] === '2' ? 'round2' : 'round1';
const artifacts = process.env['M63_ARTIFACT_DIR'] ?? `.local-checks/m63/${round}`;
const sourceFiles = [
  'apps/web/src/App.vue', 'apps/web/src/style.css', 'apps/web/src/components/WorkspaceHub.vue',
  'apps/web/src/components/ProjectWorkspace.vue', 'apps/web/src/components/SourceWorkspace.vue',
  'apps/web/src/components/FactsWorkspace.vue', 'apps/web/src/components/BriefWorkspace.vue',
  'apps/web/src/components/ArticleWorkspace.vue', 'apps/web/src/components/ProfileSettings.vue',
  'apps/web/src/components/VisualWorkspace.vue', 'apps/web/src/components/WorkspaceStyleEditor.vue',
  'apps/web/src/components/TelegramWorkspace.vue', 'apps/web/src/components/ScriptWorkspace.vue',
  'apps/web/src/components/ExportWorkspace.vue', 'apps/web/src/components/ExternalProcessingNotice.vue',
  'apps/web/src/components/SiteFooter.vue',
];
const checkoutSourceHashes = Object.fromEntries(sourceFiles.map(file => [file, createHash('sha256').update(readFileSync(file)).digest('hex')]));
function listBuiltAssets(directory: string, prefix = ''): Record<string, string> {
  if (!existsSync(directory)) return {};
  return Object.fromEntries(readdirSync(directory).flatMap(name => {
    const path = `${directory}/${name}`;
    const key = prefix ? `${prefix}/${name}` : name;
    return statSync(path).isDirectory() ? Object.entries(listBuiltAssets(path, key)) : [[key, createHash('sha256').update(readFileSync(path)).digest('hex')]];
  }));
}
const servedAssetHashes = listBuiltAssets('apps/web/dist/assets');
const buildProvenancePath = process.env['M63_BUILD_PROVENANCE'];
const buildProvenance = buildProvenancePath && existsSync(buildProvenancePath)
  ? JSON.parse(readFileSync(buildProvenancePath, 'utf8')) as unknown
  : null;
const evidenceSourceHashes = buildProvenance && typeof buildProvenance === 'object' && 'sourceHashes' in buildProvenance
  ? buildProvenance.sourceHashes
  : checkoutSourceHashes;
const surfaces = [
  { name: 'projects', path: '/projects' },
  { name: 'overview', path: `/projects/${projectId}` },
  { name: 'sources', path: `/projects/${projectId}/sources` },
  { name: 'facts', path: `/projects/${projectId}/facts` },
  { name: 'brief', path: `/projects/${projectId}/brief` },
  { name: 'article', path: `/projects/${projectId}/article` },
  { name: 'channels', path: `/projects/${projectId}/channels?format=TELEGRAM_POST` },
  { name: 'scripts', path: `/projects/${projectId}/channels?format=LINKEDIN_CAROUSEL` },
  { name: 'visuals', path: `/projects/${projectId}/visuals?format=LINKEDIN_COVER` },
  { name: 'export', path: `/projects/${projectId}/export` },
  { name: 'settings', path: '/settings' },
] as const;
const viewports = [{ width: 1440, height: 1000 }, { width: 768, height: 900 }, { width: 360, height: 800 }] as const;

async function assertFixtureClean(context: Awaited<ReturnType<typeof installM63Fixture>>) {
  expect(context.violations, 'Only the synthetic API contract and same-origin static assets may be requested').toEqual([]);
  expect(context.pageErrors).toEqual([]);
}

async function runAxe(page: Page, surface: string, viewport: { width: number; height: number }) {
  if (!axeRoutes.has(page)) {
    await page.route('**/__m63/axe.min.js', route => route.fulfill({ status: 200, contentType: 'text/javascript', body: axeSource }));
    axeRoutes.add(page);
  }
  // Serve the official axe bundle from this same-origin test-only route. The
  // production CSP remains enabled and unchanged; inline script injection is blocked.
  await page.addScriptTag({ url: '/__m63/axe.min.js' });
  const results = await page.evaluate(async () => {
    if (!window.axe) throw new Error('axe-core did not attach to this page');
    return { version: window.axe.version, results: await window.axe.run(document, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'] } }) };
  });
  const layout = await page.evaluate(() => {
    const offenders = [...document.querySelectorAll<HTMLElement>('body *')].flatMap(element => {
      const rect = element.getBoundingClientRect();
      const overflow = rect.right > innerWidth + 1 || element.scrollWidth > element.clientWidth + 1;
      if (!overflow || !rect.width || !rect.height) return [];
      return [{ tag: element.tagName, id: element.id, className: typeof element.className === 'string' ? element.className : '', left: rect.left, right: rect.right, width: rect.width, clientWidth: element.clientWidth, scrollWidth: element.scrollWidth, text: (element.innerText || '').replace(/\s+/g, ' ').slice(0, 120) }];
    }).slice(0, 30);
    return { viewportWidth: innerWidth, documentWidth: document.documentElement.scrollWidth, viewportHeight: innerHeight, documentHeight: document.documentElement.scrollHeight, overflowOffenders: offenders };
  });
  const evidence = {
    surface, url: page.url(), viewport, browserVersion: page.context().browser()?.version() ?? 'unknown',
    axeVersion: results.version, layout, sourceHashes: buildProvenance && typeof buildProvenance === 'object' && 'sourceHashes' in buildProvenance ? buildProvenance.sourceHashes : checkoutSourceHashes,
    sourceHashBasis: buildProvenancePath && buildProvenance ? 'M63_BUILD_PROVENANCE' : 'checkout snapshot at test module load; see servedAssetHashes for exact Vite dist files',
    servedAssetHashes,
    violations: results.results.violations.map(({ id, impact, help, helpUrl, nodes }) => ({ id, impact, help, helpUrl, nodes: nodes.map(node => ({ target: node.target, html: node.html, failureSummary: node.failureSummary })) })),
    incomplete: results.results.incomplete.map(({ id, impact, help, helpUrl, nodes }) => ({ id, impact, help, helpUrl, nodes: nodes.map(node => ({ target: node.target, html: node.html, any: node.any.map(check => ({ message: check.message, data: check.data })), all: node.all.map(check => ({ message: check.message, data: check.data })), none: node.none.map(check => ({ message: check.message, data: check.data })) })) })),
  };
  const path = `${artifacts}/axe-${surface}-${viewport.width}.json`;
  writeFileSync(path, JSON.stringify(evidence, null, 2));
  return evidence;
}

test.beforeEach(async () => {
  mkdirSync(artifacts, { recursive: true });
});

test('WCAG 2.2 AA scan covers the primary editorial workspace at wide, tablet, and narrow widths', async ({ page }) => {
  test.setTimeout(180_000);
  const fixture = await installM63Fixture(page);
  const pageErrors: string[] = [];
  const overflows: Array<{ surface: string; viewport: number; documentWidth: number }> = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  const reports: unknown[] = [];
  for (const viewport of viewports) {
    await page.setViewportSize(viewport);
    for (const surface of surfaces) {
      await page.goto(surface.path);
      await expect(page.locator('#main-content')).toBeVisible();
      await expect(page.getByRole('main')).toHaveCount(1);
      const heading = page.locator('h1:visible').first();
      await expect(heading).toBeVisible();
      const layout = await page.evaluate(() => ({ viewport: innerWidth, documentWidth: document.documentElement.scrollWidth }));
      if (layout.documentWidth > layout.viewport) overflows.push({ surface: surface.name, viewport: layout.viewport, documentWidth: layout.documentWidth });
      reports.push(await runAxe(page, surface.name, viewport));
      if (['projects', 'sources', 'facts', 'article', 'visuals'].includes(surface.name) || (surface.name === 'settings' && viewport.width === 360)) {
        const path = `${artifacts}/${surface.name}-${viewport.width}.png`;
        await page.screenshot({ path, fullPage: true });
        writeFileSync(`${path}.provenance.json`, JSON.stringify({ url: page.url(), viewport, browserVersion: page.context().browser()?.version(), sourceHashes: evidenceSourceHashes, sourceHashBasis: buildProvenancePath && buildProvenance ? 'M63_BUILD_PROVENANCE' : 'checkout snapshot at test module load', servedAssetHashes, buildProvenance }, null, 2));
      }
    }
  }
  writeFileSync(`${artifacts}/run.json`, JSON.stringify({ round, engine: process.env['M63_ENGINE'] ?? (process.env['CI'] ? 'chromium' : 'chrome'), browserVersion: page.context().browser()?.version(), axeVersion: reports[0] ? (reports[0] as { axeVersion: string }).axeVersion : null, scans: reports.length, pageErrors, overflows, checkoutSourceHashes, sourceHashBasis: buildProvenancePath && buildProvenance ? 'M63_BUILD_PROVENANCE' : 'checkout snapshot at test module load', servedAssetHashes, buildProvenance }, null, 2));
  expect(reports.flatMap(report => (report as { violations: unknown[] }).violations.map(violation => ({ surface: (report as { surface: string }).surface, violation }))), 'WCAG 2.2 AA automated findings; full node evidence is saved with each scan').toEqual([]);
  expect(pageErrors).toEqual([]);
  expect(overflows, 'Document-level horizontal overflow at tested viewport widths').toEqual([]);
  await assertFixtureClean(fixture);
});

test('keyboard skip link reaches main content and Workspace dialog contains focus and restores its opener', async ({ page }) => {
  const fixture = await installM63Fixture(page);
  await page.goto('/projects');
  await expect(page.getByRole('heading', { name: 'Ваші проєкти', exact: true })).toBeVisible();
  await page.keyboard.press('Tab');
  const skip = page.getByRole('link', { name: 'До робочої області', exact: true });
  await expect(skip).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.locator('#workspace-task')).toBeFocused();

  const opener = page.getByRole('button', { name: 'Новий простір', exact: true });
  await opener.click();
  await page.getByRole('button', { name: 'Створити новий простір', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Новий простір', exact: true });
  await expect(dialog).toBeVisible();
  await expect.poll(() => dialog.evaluate(element => element.contains(document.activeElement))).toBe(true);
  for (let index = 0; index < 8; index++) {
    await page.keyboard.press('Tab');
    await expect.poll(() => page.getByRole('dialog').evaluate(element => element.contains(document.activeElement))).toBe(true);
  }
  await page.keyboard.press('Shift+Tab');
  await expect.poll(() => page.getByRole('dialog').evaluate(element => element.contains(document.activeElement))).toBe(true);
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(opener).toBeFocused();
  await assertFixtureClean(fixture);
});

test('signed-out authentication surface has no automated WCAG 2.2 AA violations', async ({ page }) => {
  const fixture = await installM63Fixture(page, false, false, true, { signedOut: true });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Раді вас бачити', exact: true })).toBeVisible();
  const result = await runAxe(page, 'signed-out', { width: 1440, height: 1000 });
  expect(result.violations).toEqual([]);
  await assertFixtureClean(fixture);
});

test('first signed-in use shows explicit consent without a settings detour and retains acceptance', async ({ page }) => {
  const fixture = await installM63Fixture(page, false, false, true, { consent: false });
  await page.setViewportSize({ width: 360, height: 800 });
  await page.goto('/projects');
  const notice = page.getByRole('region', { name: 'Повідомлення про зовнішню обробку', exact: true });
  const confirm = notice.getByRole('button', { name: 'Погодитися на зовнішню обробку', exact: true });
  const checkbox = notice.getByRole('checkbox');
  await expect(checkbox).not.toBeChecked();
  await expect(confirm).toBeDisabled();
  const scan = await runAxe(page, 'first-use-consent', { width: 360, height: 800 });
  expect(scan.violations).toEqual([]);
  await page.screenshot({ path: `${artifacts}/first-use-consent-360.png`, fullPage: true });
  await checkbox.check();
  await confirm.click();
  await expect(notice).toHaveCount(0);
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Ваші проєкти', exact: true })).toBeVisible();
  await expect(notice).toHaveCount(0);
  await assertFixtureClean(fixture);
});

test('one claim action reveals its exact excerpt, source name, and immutable snapshot version', async ({ page }) => {
  const fixture = await installM63Fixture(page);
  await page.goto(`/projects/${projectId}/facts`);
  const claim = page.getByRole('button', { name: /У дослідженні взяли участь 12 мешканців міста/ });
  await expect(claim).toBeVisible();
  await claim.focus();
  await page.keyboard.press('Enter');
  const evidence = page.locator('.facts-reader');
  await expect(evidence).toBeVisible();
  await expect(evidence).toContainText(sourceName);
  await expect(evidence).toContainText(`Версія ${snapshotVersion}`);
  await expect(evidence).toContainText('У дослідженні взяли участь 12 мешканців міста.');
  await assertFixtureClean(fixture);
});

for (const failure of ['conflict', 'network'] as const) {
  test(`failed article save (${failure}) keeps the typed text visible for recovery`, async ({ page }) => {
    const fixture = await installM63Fixture(page, false, false, true, { articleFailure: failure });
    await page.goto(`/projects/${projectId}/article`);
    const editor = page.getByRole('textbox', { name: 'Текст статті', exact: true });
    const draft = `Чернетка зберігається після помилки ${failure}.`;
    await editor.fill(draft);
    await expect(page.locator('.article-error')).toBeVisible();
    await expect(editor).toContainText(draft);
    await assertFixtureClean(fixture);
  });
}

test('source creation failure explains the problem and retains the entered source text', async ({ page }) => {
  const fixture = await installM63Fixture(page, true, false, true, { sourceFailure: true });
  await page.goto(`/projects/${projectId}/sources`);
  const label = 'Матеріал міського дослідження';
  const text = 'Довгий введений текст джерела залишається доступним для виправлення після збою.';
  await page.getByLabel('Назва', { exact: true }).fill(label);
  await page.getByLabel('Текст джерела', { exact: true }).fill(text);
  await page.screenshot({ path: `${artifacts}/optional-source-name.png`, fullPage: true });
  await page.getByRole('button', { name: 'Додати джерело', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('Не вдалося виконати дію');
  await expect(page.getByLabel('Назва', { exact: true })).toHaveValue(label);
  await expect(page.getByLabel('Текст джерела', { exact: true })).toHaveValue(text);
  await assertFixtureClean(fixture);
});

test('channel draft conflict keeps edited copy in the current editor', async ({ page }) => {
  const fixture = await installM63Fixture(page, false, false, true, { telegramFailure: true });
  await page.goto(`/projects/${projectId}/channels?format=TELEGRAM_POST`);
  const text = page.getByRole('textbox', { name: 'Текст публікації', exact: true });
  const draft = 'Текст допису зберігається навіть після відповіді 409.';
  await text.fill(draft);
  await expect(page.locator('.telegram-error[role="alert"]')).toContainText('Ваш текст збережено в цьому вікні');
  await expect(text).toHaveValue(draft);
  await assertFixtureClean(fixture);
});

test('long Ukrainian project and article titles remain editable at a narrow viewport', async ({ page }) => {
  const fixture = await installM63Fixture(page, false, false, true, { longName: true });
  await page.setViewportSize({ width: 360, height: 800 });
  await page.goto(`/projects/${projectId}/article`);
  const title = page.getByRole('textbox', { name: 'Заголовок статті', exact: true });
  const longTitle = 'Як щоденні поїздки мешканців змінюють доступність громадського транспорту в українському місті';
  await title.fill(longTitle);
  await expect(title).toHaveValue(longTitle);
  await expect(page.getByRole('main')).toHaveCount(1);
  const result = await runAxe(page, 'article-long-title', { width: 360, height: 800 });
  expect(result.violations).toEqual([]);
  await assertFixtureClean(fixture);
});

test('reduced-motion preference is honored on the editorial channel surface', async ({ page }) => {
  const fixture = await installM63Fixture(page);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto(`/projects/${projectId}/channels?format=TELEGRAM_POST`);
  await expect.poll(() => page.evaluate(() => matchMedia('(prefers-reduced-motion: reduce)').matches)).toBe(true);
  const result = await runAxe(page, 'channels-reduced-motion', { width: 1440, height: 1000 });
  expect(result.violations).toEqual([]);
  await assertFixtureClean(fixture);
});

test('visual composition exposes equivalent DOM controls for its canvas', async ({ page }) => {
  const fixture = await installM63Fixture(page);
  await page.goto(`/projects/${projectId}/visuals?format=LINKEDIN_COVER`);
  const editor = page.getByRole('textbox', { name: 'Текст', exact: true });
  await expect(editor).toBeVisible();
  await expect(page.getByRole('complementary', { name: 'Властивості шару', exact: true })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Прев’ю кадру', exact: true })).toBeVisible();
  const data = await runAxe(page, 'visuals', { width: 1440, height: 1000 });
  expect(data.violations).toEqual([]);
  await assertFixtureClean(fixture);
});
