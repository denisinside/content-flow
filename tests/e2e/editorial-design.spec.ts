import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { test, expect, type Page } from '@playwright/test';

// Synthetic browser contracts only: no account, source, provider or domain API
// request is allowed to leave this fresh Playwright browser context.
const projectId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const workspaceId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const base = `/api/v1/projects/${projectId}`;
const artifacts = process.env.AUTHOR_DESK_ARTIFACTS ?? '.local-checks/author-desk/screenshots';
const now = '2026-10-09T10:00:00Z';
const topic = 'Міська мобільність: як щоденні поїздки змінюють життя міста';
const sourceText = 'У дослідженні взяли участь 12 мешканців міста. Вони описали щоденні поїздки громадським транспортом.\n\nРедакція перевірила збережений звіт і точні цитати учасників.';
const digest = createHash('sha256').update(sourceText).digest('hex');
const wording = 'У дослідженні взяли участь 12 мешканців міста.';
const stages = [
  { route: 'sources', heading: 'Джерела', nav: 'Джерела', id: 'sources-title' },
  { route: 'facts', heading: 'Фактична основа', nav: 'Факти', id: 'facts-title' },
  { route: 'brief', heading: 'Бриф', nav: 'Бриф', id: 'brief-title' },
  { route: 'article', heading: 'Стаття', nav: 'Стаття', id: 'article-heading' },
] as const;
type ArticleContent = { title: string; document: { type: string; content: unknown[] } };

async function fixture(page: Page, emptySources = false, linkedEvidence = false, articleSelected = true, options: { longName?: boolean; member?: boolean; consent?: boolean; preferenceFailure?: boolean; switchable?: boolean } = {}) {
  const violations: string[] = [];
  const pageErrors: string[] = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  const project = { id: projectId, workspaceId, topic, formats: articleSelected ? ['ARTICLE', 'TELEGRAM_POST'] : ['TELEGRAM_POST'], revision: 1, createdAt: now, updatedAt: now, archivedAt: null };
  const workspace = { id: workspaceId, ownerId: options.member ? 'other-user' : 'fixture-user', name: options.longName ? 'Редакція міських досліджень та громадського транспорту з довгою назвою' : 'Редакційний простір', archivedAt: null, members: [] };
  const workspaceActions: { path: string; body: unknown }[] = [];
  const workspaceList = [workspace];
  if (options.switchable) workspaceList.push({ ...workspace, id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', name: 'Інша редакція' });
  let consent = options.consent ?? true;
  let preferenceFailure = options.preferenceFailure ?? false;
  let authenticated = true;
  const material = { id: 'source-1', projectId, kind: 'TEXT', purpose: 'FACTUAL_SOURCE', label: 'Звіт про щоденні поїздки', included: true, revision: 1, currentSnapshotId: 'snapshot-1', createdAt: now, updatedAt: now };
  const snapshot = { id: 'snapshot-1', sequence: 1, origin: 'MANUAL_TEXT', createdAt: now, createdBy: 'Редактор', projectId, materialId: material.id, normalizedText: sourceText, sha256: digest, bytes: sourceText.length, previousSnapshotId: null, fragments: [{ id: 'fragment-1', ordinal: 0, startOffset: 0, endOffset: sourceText.length, sha256: digest }] };
  const evidence = { id: 'evidence-1', snapshotId: snapshot.id, fragmentId: 'fragment-1', startOffset: 0, endOffset: sourceText.length, quote: sourceText, sha256: digest, relation: 'SUPPORTS', materialId: material.id, materialLabel: material.label, snapshotSequence: 1, invalidatedAt: null, invalidatedBy: null, invalidationReason: null };
  const revision = { id: 'claim-revision-1', number: 1, wording, status: 'APPROVED', approvedBy: 'Редактор', approvedAt: now, rejectedBy: null, rejectedAt: null, withdrawnBy: null, withdrawnAt: null, withdrawalReason: null, evidence: [evidence] };
  const claim = { id: 'claim-1', revision: 1, currentRevisionId: revision.id, currentRevision: revision, revisions: [revision] };
  let materials = emptySources ? [] : [material];
  const snapshots = new Map([[snapshot.id, snapshot]]);
  let briefRevision = { id: 'brief-1', number: 1, contentMode: 'FACTUAL', topic, audience: 'Мешканці міста, які користуються громадським транспортом', centralMessage: 'Надійний транспорт робить щоденні поїздки зручнішими.', category: 'Міське життя', tone: 'Спокійний і точний', targetLength: 600, cta: 'Поділіться досвідом поїздок.', exclusions: ['Уникаємо неперевірених обіцянок'], notes: 'Почніть із короткої сцени ранкової поїздки.', requiredClaimRevisionIds: [revision.id], contextSnapshots: {}, workspaceStyleRevision: 3 };
  const briefHistory = [briefRevision];
  const outline = { id: 'outline-1', number: 1, briefRevisionId: briefRevision.id, origin: 'MANUAL', status: 'APPROVED', content: { title: topic, sections: [{ title: 'Ранкова поїздка', purpose: 'Показати щоденний досвід мешканців.', claimRevisionIds: [revision.id] }] } };
  const editorial = () => ({ brief: { revision: briefHistory.length, currentRevision: briefRevision, history: briefHistory }, outline: { revision: 1, currentRevision: outline, currentApprovedRevisionId: outline.id, revisions: [outline] }, style: { revision: 3, tone: briefRevision.tone, brandbook: '', settings: {} }, articleSelected: true, prerequisites: { eligibleClaims: [claim], missingBasis: false, unverified: false, blockingReasons: [] } });
  let article = { id: 'article-1', revision: 1, draft: { content: { title: 'Коли місто прокидається: щоденні поїздки очима мешканців', document: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Ранкова поїздка починається на зупинці. Мешканці планують день, поки місто поступово прокидається.' }] }, { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'Поїздки очима мешканців' }] }, { type: 'paragraph', content: [{ type: 'text', text: 'Стабільний розклад допомагає узгодити дорогу до роботи й час із родиною.' }] }, { type: 'heading', attrs: { level: 3 }, content: [{ type: 'text', text: 'Час на пересадку' }] }, { type: 'paragraph', content: [{ type: 'text', text: 'У цьому демонстраційному матеріалі автор розглядає досвід поїздки, не узагальнюючи його на всіх мешканців.' }] }] } } as ArticleContent, contentMode: 'CREATIVE', origin: 'MANUAL', baseVersionId: null }, currentApprovedVersionId: null, versions: [] };
  const articleEvidence = [{ claimRevisionId: revision.id, evidenceId: 'evidence-1', wording, quote: sourceText, snapshotId: snapshot.id, materialTitle: material.label }, { claimRevisionId: 'claim-revision-2', evidenceId: 'evidence-2', wording: 'Мешканці описали щоденні поїздки.', quote: 'Мешканці описали щоденні поїздки громадським транспортом.', snapshotId: 'snapshot-2', materialTitle: 'Нотатки інтерв’ю' }];
  if (linkedEvidence) {
    article.draft.contentMode = 'FACTUAL';
    article.draft.content.document.content = [{ type: 'paragraph', content: [{ type: 'text', text: wording, marks: [{ type: 'evidence', attrs: { claimRevisionId: revision.id, evidenceId: 'evidence-1', quote: wording } }] }] }];
  }
  const articleState = () => ({ article, articleSelected: true, eligibleEvidence: linkedEvidence ? articleEvidence : [], mappingIssues: [], staleReasons: [], hasUnmapped: true, editorial: editorial() });
  const articleSaves: ArticleContent[] = [];
  let idleTimeoutMinutes = 60;
  await page.route('**/*', async route => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    const json = (body: unknown, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    if (url.origin !== new URL(test.info().project.use.baseURL!).origin) { violations.push(`External request: ${request.method()} ${url.origin}${path}`); return route.abort(); }
    if (!path.startsWith('/api/')) return route.continue();
    if (request.method() !== 'GET') expect(request.headers()['x-csrf-token']).toBe('fixture-csrf');
    if (path === '/api/auth/session') return json(authenticated ? { authenticated: true, csrfToken: 'fixture-csrf', user: { id: 'fixture-user', email: 'editor@example.test', displayName: 'Редактор' } } : { authenticated: false, csrfToken: 'fixture-csrf' });
    if (path === '/api/auth/logout') { authenticated = false; return json({ ok: true }); }
    if (path === '/api/auth/preferences') {
      if (preferenceFailure) { preferenceFailure = false; return json({ error: 'FIXTURE_UNAVAILABLE' }, 503); }
      if (request.method() === 'PATCH') idleTimeoutMinutes = (request.postDataJSON() as { idleTimeoutMinutes: number }).idleTimeoutMinutes;
      return json({ preferences: { idleTimeoutMinutes } });
    }
    if (path === '/api/auth/external-processing') {
      if (request.method() === 'POST') { expect(request.postDataJSON()).toEqual({ noticeVersion: '1' }); consent = true; }
      return json({ notice: { version: '1', text: 'Синтетичне повідомлення' }, accepted: consent, acceptedAt: consent ? now : null });
    }
    if (path === '/api/auth/activity') return json({ authenticated: true });
    if (request.method() === 'GET' && workspaceList.some(item => path === `/api/v1/workspaces/${item.id}/style`)) {
      return json({ style: { revision: 3, tone: briefRevision.tone, brandbook: '', settings: {} } });
    }
    if (path === `${base}/presence` && ['GET', 'POST', 'DELETE'].includes(request.method())) {
      if (request.method() === 'GET') return json({ page: url.searchParams.get('page'), people: [], ttlSeconds: 60 });
      const body = request.postDataJSON() as { page: string; clientId: string };
      expect(['article', 'outline', 'brief', 'telegram', 'linkedin-text', 'linkedin-cover', 'instagram-cover',
        'linkedin-carousel', 'instagram-carousel', 'instagram-stories']).toContain(body.page);
      expect(body.clientId).toMatch(/^[0-9a-f-]{36}$/i);
      return json({ ok: true });
    }
    if (path === '/api/v1/workspaces' && request.method() === 'GET') return json({ workspaces: workspaceList, nextCursor: null });
    if (path === '/api/v1/workspaces' && request.method() === 'POST') {
      const body = request.postDataJSON() as { name: string };
      expect(body).toEqual({ name: 'Нова редакція' });
      const added = { ...workspace, id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', name: body.name };
      workspaceList.push(added); workspaceActions.push({ path, body }); return json({ workspace: added }, 201);
    }
    if (path === '/api/v1/workspace-invites/accept') {
      const body = request.postDataJSON(); expect(body).toEqual({ token: 'fixture-invitation' });
      const joined = { ...workspace, id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', name: 'Спільна редакція', ownerId: 'other-user' };
      workspaceList.push(joined); workspaceActions.push({ path, body }); return json({ workspace: joined });
    }
    if (path.startsWith('/api/v1/workspaces/') && request.method() === 'GET') {
      const found = workspaceList.find(item => path === `/api/v1/workspaces/${item.id}`);
      if (found) return json({ workspace: found });
    }
    if (path === '/api/v1/projects') return json({ projects: [project], nextCursor: null });
    if (path === base) return json({ project });
    if (path === `${base}/jobs`) return json({ jobs: [] });
    if (path === `${base}/materials` && request.method() === 'GET') return json({ materials });
    if (request.method() === 'GET' && path.startsWith(`${base}/materials/`)) {
      const parts = path.slice(`${base}/materials/`.length).split('/');
      const selected = materials.find(item => item.id === parts[0]);
      if (selected && parts.length === 1) return json({ material: selected, snapshots: [snapshots.get(selected.currentSnapshotId)!] });
      const selectedSnapshot = snapshots.get(parts[2] ?? '');
      if (selected && parts[1] === 'snapshots' && selectedSnapshot?.materialId === selected.id) return json({ snapshot: selectedSnapshot });
    }
    if (path === `${base}/materials` && request.method() === 'POST') {
      const body = request.postDataJSON() as { label: string; text: string; purpose: string };
      expect(body).toMatchObject({ label: 'Додатковий текст', text: 'Новий синтетичний уривок.' });
      const added = { ...material, id: 'source-2', label: body.label, currentSnapshotId: 'snapshot-2' };
      const addedSnapshot = { ...snapshot, id: added.currentSnapshotId, materialId: added.id, normalizedText: body.text, sha256: createHash('sha256').update(body.text).digest('hex'), bytes: body.text.length };
      materials = [...materials, added]; snapshots.set(addedSnapshot.id, addedSnapshot);
      return json({ material: added, snapshot: addedSnapshot }, 201);
    }
    if (path === `${base}/claims`) return json({ claims: [claim], nextCursor: null });
    if (path === `${base}/claims/${claim.id}`) return json({ claim, revisions: [revision] });
    if (path === `${base}/conflicts`) return json({ conflicts: [], nextCursor: null });
    if (path === `${base}/basis`) return json({ mode: url.searchParams.get('mode'), basis: { id: 'basis-1', sequence: 1, manifest: { claimRevisionIds: [revision.id] }, valid: true, blockingReasons: [] }, eligibleClaims: [claim], missingBasis: false, unverified: false, blockingReasons: [] });
    if (path === `${base}/editorial`) return json(editorial());
    if (path === `${base}/brief` && request.method() === 'POST') {
      const body = request.postDataJSON() as typeof briefRevision;
      briefRevision = { ...briefRevision, ...body, id: `brief-${briefHistory.length + 1}`, number: briefHistory.length + 1 };
      briefHistory.unshift(briefRevision); return json(editorial());
    }
    if (path === `${base}/article` && request.method() === 'GET') return json(articleSelected ? articleState() : { article: null, articleSelected: false });
    if (path === `${base}/article/draft` && request.method() === 'POST') {
      const body = request.postDataJSON() as { expectedRevision: number; content: ArticleContent; contentMode: string };
      expect(body.expectedRevision).toBe(article.revision);
      articleSaves.push(body.content);
      article = { ...article, revision: article.revision + 1, draft: { ...article.draft, content: body.content, contentMode: body.contentMode } };
      return json(articleState());
    }
    violations.push(`Unknown API: ${request.method()} ${path}`);
    return json({ error: 'UNMOCKED_API_REQUEST' }, 599);
  });
  return { violations, pageErrors, articleSaves, workspaceActions };
}

async function assertClean(context: Awaited<ReturnType<typeof fixture>>) {
  expect(context.violations).toEqual([]);
  expect(context.pageErrors).toEqual([]);
}

async function assertTaskInFirstViewport(page: Page) {
  const heading = page.locator('h1:visible');
  await expect(heading).toHaveCount(1);
  const box = await heading.boundingBox();
  expect(box).not.toBeNull();
  expect(box!.y).toBeGreaterThanOrEqual(0);
  expect(box!.y + box!.height).toBeLessThan(900);
}

async function captureScreen(page: Page, name: string) {
  if (process.env.AUTHOR_DESK_CAPTURE_ONLY && !name.startsWith(`${process.env.AUTHOR_DESK_CAPTURE_ONLY}-`)) return;
  const files = ['apps/web/src/App.vue', 'apps/web/src/style.css', 'apps/web/src/components/WorkspaceHub.vue', 'apps/web/src/components/ProfileSettings.vue', 'apps/web/src/components/SiteFooter.vue', 'apps/web/src/components/ExternalProcessingNotice.vue', ...['Project', 'Source', 'Facts', 'Brief', 'Article'].map(component => `apps/web/src/components/${component}Workspace.vue`)];
  const sourceHashes = Object.fromEntries(files.map(file => [file, createHash('sha256').update(readFileSync(file)).digest('hex')]));
  const metrics = await page.evaluate(() => ({ width: innerWidth, documentWidth: document.documentElement.scrollWidth, fonts: document.fonts.status, background: getComputedStyle(document.body).backgroundColor }));
  expect(metrics.documentWidth).toBeLessThanOrEqual(metrics.width);
  const overlay = page.locator('.workspace-dialog:visible, .workspace-select-menu:visible');
  if (await overlay.count()) {
    await expect.poll(() => overlay.evaluate(element => {
      const bounds = element.getBoundingClientRect();
      return { internalOverflow: element.scrollWidth > element.clientWidth + 1, outsideViewport: bounds.left < 0 || bounds.right > innerWidth };
    })).toEqual({ internalOverflow: false, outsideViewport: false });
  }
  const path = `${artifacts}/${name}.png`;
  await page.screenshot({ path, fullPage: true });
  writeFileSync(`${path}.provenance.json`, JSON.stringify({ origin: 'Browser-rendered production Vue frontend; isolated synthetic API fixtures; no real account data.', url: page.url(), viewport: page.viewportSize(), capturedAt: new Date().toISOString(), sourceHashes, ...metrics }, null, 2));
}

async function assertResponsiveNavigation(page: Page, width: number) {
  const nav = page.getByRole('navigation', { name: 'Робота над проєктом' });
  const overview = await nav.getByRole('link', { name: 'Огляд', exact: true }).boundingBox();
  const sources = await nav.getByRole('link', { name: 'Джерела', exact: true }).boundingBox();
  expect(overview).not.toBeNull(); expect(sources).not.toBeNull();
  expect(Math.abs(overview!.y - sources!.y)).toBeLessThan(2);
  expect(sources!.x).toBeGreaterThan(overview!.x + overview!.width - 1);
  expect(sources!.x + sources!.width).toBeLessThan(width);
}

test('article contents follows edited headings without persisting navigation attributes; mobile and inspector preserve access', async ({ page }) => {
  const context = await fixture(page);
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(`/projects/${projectId}/article`);
  const contents = page.getByRole('navigation', { name: 'Зміст статті' });
  await expect(contents.getByRole('link', { name: 'Поїздки очима мешканців', exact: true })).toBeVisible();
  const writing = page.getByRole('textbox', { name: 'Текст статті', exact: true });
  const heading = writing.locator('h2');
  await heading.fill('Щоденна дорога до роботи');
  const section = contents.getByRole('link', { name: 'Щоденна дорога до роботи', exact: true });
  await expect(section).toBeVisible();
  const previousScroll = await page.evaluate(() => scrollY);
  await section.click();
  const box = await heading.boundingBox();
  expect(box!.y).toBeGreaterThanOrEqual(0);
  expect(box!.y + box!.height).toBeLessThan(900);
  expect(await page.evaluate(() => scrollY)).toBeGreaterThan(previousScroll);
  await expect(page.getByText('Збережено', { exact: true })).toBeVisible();
  const saved = context.articleSaves.at(-1)!;
  const savedHeading = saved.document.content.find(
    (node): node is { type: 'heading'; attrs?: unknown } =>
      typeof node === 'object' && node !== null && 'type' in node && node.type === 'heading',
  );
  expect(savedHeading?.attrs).toEqual({ level: 2 });
  await page.getByRole('button', { name: 'Історія версій', exact: true }).click();
  await expect(contents).toBeHidden();
  await page.getByRole('button', { name: 'Закрити контекст', exact: true }).click();
  await expect(contents).toBeVisible();
  await page.setViewportSize({ width: 390, height: 900 });
  const disclosure = page.locator('.article-contents > details');
  await expect(disclosure).not.toHaveAttribute('open', '');
  await disclosure.locator('summary').click();
  await contents.getByRole('link', { name: 'Час на пересадку', exact: true }).click();
  const mobileSection = (await writing.locator('h3').boundingBox())!;
  expect(mobileSection.y).toBeGreaterThanOrEqual(0);
  expect(mobileSection.y + mobileSection.height).toBeLessThan(900);
  await page.reload();
  await disclosure.locator('summary').click();
  await expect(contents.getByRole('link', { name: 'Щоденна дорога до роботи', exact: true })).toBeVisible();
  await assertClean(context);
});

test('all four editorial routes share a compact shell, route headings and navigation; responsive captures', async ({ page }) => {
  test.setTimeout(90_000);
  const context = await fixture(page);
  mkdirSync(artifacts, { recursive: true });
  for (const stage of stages) {
    await page.goto(`/projects/${projectId}/${stage.route}`);
    await expect(page.getByRole('heading', { level: 1, name: stage.heading, exact: true })).toBeVisible();
    await expect(page.locator('h1:visible')).toHaveCount(1);
    await expect(page.locator('.project-detail')).toHaveAttribute('aria-labelledby', stage.id);
    const nav = page.getByRole('navigation', { name: 'Робота над проєктом' });
    await expect(nav.getByRole('link', { name: stage.nav, exact: true })).toHaveAttribute('aria-current', 'page');
    await expect(nav.locator('[aria-current="page"]')).toHaveCount(1);
    await expect(nav.getByRole('link', { name: 'Огляд', exact: true })).toHaveAttribute('href', `/projects/${projectId}`);
    await expect(page.getByRole('button', { name: 'Керування простором', exact: true })).toBeVisible();
    await expect(page.locator('.editorial-project-context')).toHaveCount(0);
    await expect(page.locator('.account-email')).toBeHidden();
    const account = page.locator('.account-details > summary');
    await account.click();
    await expect(page.getByRole('button', { name: 'Вийти', exact: true })).toBeVisible();
    await account.press('Escape');
    if (stage.route === 'sources') {
      await expect(page.locator('.source-add')).not.toHaveAttribute('open', '');
      await expect(page.locator('.source-reader')).toHaveCount(0);
      await page.getByRole('button', { name: 'Звіт про щоденні поїздки Фактичне джерело', exact: true }).click();
      await expect(page.locator('.source-plain-text')).toHaveText(sourceText);
    }
    if (stage.route === 'facts') {
      await expect(page.locator('.facts-reader')).toHaveCount(0);
      await page.locator('.claim-open').filter({ hasText: wording }).click();
      await expect(page.locator('.claim-document')).toHaveText(wording);
      await expect(page.locator('.claim-evidence')).toContainText(sourceText);
    }
    if (stage.route === 'brief') await expect(page.getByLabel('Аудиторія', { exact: true })).toHaveValue(/Мешканці/);
    if (stage.route === 'article') await expect(page.getByRole('textbox', { name: 'Текст статті' })).toContainText('Ранкова поїздка');
    for (const width of [1280, 768, 390]) {
      await page.setViewportSize({ width, height: 900 });
      await page.evaluate(() => document.fonts.ready);
      await page.evaluate(() => scrollTo(0, 0));
      await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await expect(page.getByRole('heading', { level: 1, name: stage.heading, exact: true })).toBeVisible();
      await assertTaskInFirstViewport(page);
      await assertResponsiveNavigation(page, width);
      await captureScreen(page, `${stage.route}-${width}`);
    }
    writeFileSync(`${artifacts}/${stage.route}-accessibility.yml`, await page.locator('.signed-in-workspace').ariaSnapshot());
    await nav.getByRole('link', { name: 'Огляд', exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`/projects/${projectId}$`));
    await expect(page.getByRole('heading', { level: 1, name: topic, exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Керування простором', exact: true })).toBeVisible();
    await expect(nav.getByRole('link', { name: 'Огляд', exact: true })).toHaveAttribute('aria-current', 'page');
  }
  await assertClean(context);
});

test('Projects and Overview lead with the task and link to every selected editorial route; responsive captures', async ({ page }) => {
  const context = await fixture(page);
  mkdirSync(artifacts, { recursive: true });
  for (const screen of ['projects', 'overview']) {
    await page.goto(screen === 'projects' ? '/projects' : `/projects/${projectId}`);
    await expect(page.locator('h1:visible')).toHaveText(screen === 'projects' ? 'Ваші проєкти' : topic);
    await expect(page.getByRole('button', { name: 'Керування простором', exact: true })).toBeVisible();
    await expect(page.locator('.account-email')).toBeHidden();
    await expect(page.getByLabel('Поточний простір', { exact: true })).toBeVisible();
    if (screen === 'projects') {
      await expect(page.getByRole('link', { name: topic, exact: true })).toHaveAttribute('href', `/projects/${projectId}`);
      await expect(page.getByRole('button', { name: 'Створити проєкт', exact: true })).toBeVisible();
    } else {
      for (const stage of stages) {
        const name = stage.route === 'sources' ? 'джерела' : stage.route === 'facts' ? 'факти' : stage.route === 'brief' ? 'бриф' : 'статтю';
        await page.getByRole('button', { name: `Відкрити ${name}`, exact: true }).click();
        await expect(page).toHaveURL(new RegExp(`/projects/${projectId}/${stage.route}$`));
        await page.getByRole('navigation', { name: 'Робота над проєктом' }).getByRole('link', { name: 'Огляд', exact: true }).click();
        await expect(page).toHaveURL(new RegExp(`/projects/${projectId}$`));
      }
    }
    for (const width of [1280, 768, 390]) {
      await page.setViewportSize({ width, height: 900 });
      await page.evaluate(() => document.fonts.ready);
      await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await assertTaskInFirstViewport(page);
      if (screen === 'overview') await assertResponsiveNavigation(page, width);
      const footer = page.getByRole('contentinfo');
      await expect(footer.getByRole('link')).toHaveCount(0);
      const geometry = await footer.evaluate(element => {
        const rect = element.getBoundingClientRect();
        return { left: rect.left, right: rect.right, height: rect.height, viewport: document.documentElement.clientWidth };
      });
      expect(geometry.left).toBe(0);
      expect(geometry.right).toBe(geometry.viewport);
      expect(geometry.height).toBeCloseTo(width <= 760 ? 152 : 137, 0);
      await captureScreen(page, `${screen}-${width}`);
    }
    writeFileSync(`${artifacts}/${screen}-accessibility.yml`, await page.locator('.signed-in-workspace').ariaSnapshot());
  }
  await assertClean(context);
});

test('account icons and profile settings remain keyboard accessible without remounting an unsaved source form', async ({ page }) => {
  const context = await fixture(page);
  await page.setViewportSize({ width: 390, height: 900 });
  await page.goto(`/projects/${projectId}/sources`);
  const disclosure = page.locator('.source-add > summary');
  await disclosure.click();
  await page.getByLabel('Назва', { exact: true }).fill('Незбережена редакторська нотатка');
  const draft = page.getByLabel('Текст джерела', { exact: true });
  await draft.fill('Цей текст має залишитися після відкриття налаштувань.');
  const mountedDraft = await draft.elementHandle();
  const account = page.locator('.account-details > summary');
  await expect(page.locator('.account-email')).toBeHidden();
  await account.focus(); await page.keyboard.press('Enter');
  await expect(page.locator('.account-email')).toHaveText('editor@example.test');
  await expect(page.locator('.account-email')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator('.account-email')).toBeHidden();
  await expect(account).toBeFocused();
  await account.press('Enter');
  await page.getByRole('link', { name: 'Налаштування профілю', exact: true }).press('Enter');
  await expect(page).toHaveURL(/\/settings$/);
  await expect(page.getByRole('heading', { level: 1, name: 'Налаштування', exact: true })).toBeFocused();
  await page.getByRole('button', { name: 'Змінити ліміт', exact: true }).click();
  await page.getByLabel('Завершувати після бездіяльності, хвилин').fill('120');
  await page.getByRole('button', { name: 'Зберегти', exact: true }).click();
  await expect(page.getByText('Налаштування збережено.', { exact: true })).toBeVisible();
  await expect(page.locator('.profile-current-limit')).toContainText('2 год');
  await page.getByRole('button', { name: 'До роботи', exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/projects/${projectId}/sources$`));
  expect(await mountedDraft!.evaluate(element => element.isConnected)).toBe(true);
  await expect(draft).toHaveValue('Цей текст має залишитися після відкриття налаштувань.');
  await expect(page.getByLabel('Назва', { exact: true })).toHaveValue('Незбережена редакторська нотатка');
  await account.click();
  await page.getByRole('link', { name: 'Налаштування профілю', exact: true }).click();
  await page.goBack();
  await expect(draft).toBeVisible();
  await page.goForward();
  await expect(page.getByRole('heading', { name: 'Налаштування', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'До роботи', exact: true }).click();
  expect(await mountedDraft!.evaluate(element => element.isConnected)).toBe(true);
  await expect(draft).toHaveValue('Цей текст має залишитися після відкриття налаштувань.');
  await assertClean(context);
});

test('header controls and profile present all seven requested changes at desktop and mobile widths', async ({ page }) => {
  test.setTimeout(90_000);
  const context = await fixture(page, false, false, true, { longName: true });
  mkdirSync(artifacts, { recursive: true });
  for (const width of [1280, 390]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto('/projects');
    const header = page.locator('.site-header');
    await expect(header.locator('#external-processing-notice')).toHaveCount(0);
    await expect(header.locator('.session-settings')).toHaveCount(0);
    const selector = header.getByRole('combobox', { name: 'Поточний простір', exact: true });
    await expect(selector).toBeVisible();
    await expect(page.locator('.workspace-switcher')).toHaveCount(0);
    if (width === 1280) {
      const choiceBox = (await selector.boundingBox())!;
      const nameBox = (await page.locator('.account-details > summary').boundingBox())!;
      expect(choiceBox.x + choiceBox.width).toBeLessThan(nameBox.x);
    }
    await page.locator('.account-details > summary').click();
    await expect(page.getByRole('link', { name: 'Налаштування профілю', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Вийти', exact: true })).toBeVisible();
    await expect(page.locator('.workspace-utilities-menu')).toContainText('editor@example.test');
    await captureScreen(page, `account-${width}`);
    await page.locator('.account-details > summary').press('Escape');
    await selector.press('Enter');
    await expect(page.getByRole('option')).toBeVisible();
    await captureScreen(page, `workspace-options-${width}`);
    await page.keyboard.press('Escape');
    await expect(selector).toBeFocused();
    const add = header.getByRole('button', { name: 'Новий простір', exact: true });
    await add.click();
    await expect(page.getByRole('dialog', { name: 'Додати простір', exact: true })).toBeVisible();
    await captureScreen(page, `workspace-choice-${width}`);
    await page.getByRole('button', { name: 'Створити новий простір', exact: true }).click();
    await expect(page.getByLabel('Назва простору', { exact: true })).toBeFocused();
    await page.getByLabel('Назва простору', { exact: true }).fill('Незбережена назва');
    await captureScreen(page, `workspace-create-${width}`);
    await page.keyboard.press('Escape');
    await expect(add).toBeFocused();
    await add.click();
    await page.getByRole('button', { name: 'Створити новий простір', exact: true }).click();
    await expect(page.getByLabel('Назва простору', { exact: true })).toHaveValue('Незбережена назва');
    await page.keyboard.press('Escape');
    await add.click();
    await page.getByRole('button', { name: 'Прийняти запрошення', exact: true }).click();
    await expect(page.getByLabel('Код запрошення', { exact: true })).toBeFocused();
    await captureScreen(page, `workspace-join-${width}`);
    await page.keyboard.press('Escape');
    await header.getByRole('button', { name: 'Керування простором', exact: true }).click();
    await expect(page.getByLabel('Запросити людину', { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Архівувати простір', exact: true })).toBeVisible();
    await captureScreen(page, `workspace-manage-${width}`);
    await page.keyboard.press('Escape');
    await expect(header.getByRole('button', { name: 'Керування простором', exact: true })).toBeFocused();
    await page.locator('.account-details > summary').click();
    await page.getByRole('link', { name: 'Налаштування профілю', exact: true }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'Налаштування', exact: true })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Зовнішня обробка матеріалів', exact: true })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Сесія', exact: true })).toBeVisible();
    await captureScreen(page, `profile-${width}`);
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  }
  await page.setViewportSize({ width: 768, height: 900 });
  await captureScreen(page, 'profile-768');
  await assertClean(context);
});

test('workspace creation and invitation dialogs submit existing API contracts and select returned workspaces', async ({ page }) => {
  const context = await fixture(page);
  await page.goto('/projects');
  await page.getByRole('button', { name: 'Новий простір', exact: true }).click();
  await page.getByRole('button', { name: 'Створити новий простір', exact: true }).click();
  await page.getByLabel('Назва простору', { exact: true }).fill('Нова редакція');
  await page.getByRole('button', { name: 'Створити простір', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByRole('combobox', { name: 'Поточний простір', exact: true })).toContainText('Нова редакція');
  await page.getByRole('button', { name: 'Новий простір', exact: true }).click();
  await page.getByRole('button', { name: 'Прийняти запрошення', exact: true }).click();
  await page.getByLabel('Код запрошення', { exact: true }).fill('fixture-invitation');
  await page.getByRole('button', { name: 'Приєднатися', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByRole('combobox', { name: 'Поточний простір', exact: true })).toContainText('Спільна редакція');
  await page.getByRole('combobox', { name: 'Поточний простір', exact: true }).click();
  await page.getByRole('option', { name: 'Редакційний простір', exact: true }).click();
  await expect(page.getByRole('combobox', { name: 'Поточний простір', exact: true })).toContainText('Редакційний простір');
  expect(context.workspaceActions).toHaveLength(2);
  await assertClean(context);
});

test('invitation deep link opens the join dialog and member management retains its permission boundary', async ({ page }) => {
  const context = await fixture(page, false, false, true, { member: true });
  await page.goto('/projects#invite=fixture-invitation');
  await expect(page.getByRole('dialog', { name: 'Приєднатися до простору', exact: true })).toBeVisible();
  await expect(page.getByLabel('Код запрошення', { exact: true })).toHaveValue('fixture-invitation');
  await expect(page).toHaveURL(/\/projects$/);
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Керування простором', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Вийти з простору', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Архівувати простір', exact: true })).toHaveCount(0);
  await expect(page.getByLabel('Передати право власності', { exact: true })).toHaveCount(0);
  await assertClean(context);
});

test('direct profile route preserves its URL, recovers preference loading and records required consent', async ({ page }) => {
  const context = await fixture(page, false, false, true, { consent: false, preferenceFailure: true });
  await page.goto('/settings#external-processing-notice');
  await expect(page).toHaveURL(/\/settings#external-processing-notice$/);
  const profile = page.locator('#profile-settings');
  await expect(profile.getByRole('heading', { level: 1, name: 'Налаштування', exact: true })).toBeVisible();
  await expect(profile.getByText('Не вдалося завантажити налаштування сесії.', { exact: true })).toBeVisible();
  await profile.getByRole('button', { name: 'Спробувати ще раз', exact: true }).click();
  await expect(page.locator('.profile-current-limit')).toContainText('1 год');
  await profile.getByRole('checkbox', { name: 'Я прочитав(-ла) повідомлення й погоджуюся на зовнішню обробку матеріалів.', exact: true }).check();
  await profile.getByRole('button', { name: 'Погодитися на зовнішню обробку', exact: true }).click();
  await expect(profile.getByText('Зовнішня обробка · Згоду збережено', { exact: true })).toBeVisible();
  await page.reload();
  await expect(page).toHaveURL(/\/settings#external-processing-notice$/);
  await expect(profile.getByText('Зовнішня обробка · Згоду збережено', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'До роботи', exact: true }).click();
  await expect(page).toHaveURL(/\/projects$/);
  await expect(page.getByRole('heading', { level: 1, name: 'Ваші проєкти', exact: true })).toBeVisible();
  await assertClean(context);
});

test('logout icon ends the synthetic session and returns to the sign-in form', async ({ page }) => {
  const context = await fixture(page);
  await page.goto('/projects');
  await page.locator('.account-details > summary').click();
  await page.getByRole('button', { name: 'Вийти', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Раді вас бачити', exact: true })).toBeVisible();
  await expect(page.locator('.account-details')).toHaveCount(0);
  await assertClean(context);
});

test('cancelled workspace selection, creation and joining preserve unsaved editor forms', async ({ page }) => {
  const context = await fixture(page, false, false, true, { switchable: true });
  await page.goto(`/projects/${projectId}/sources`);
  await page.locator('.source-add > summary').click();
  const draft = page.getByLabel('Текст джерела', { exact: true });
  await draft.fill('Незбережений текст перед зміною простору.');
  const mounted = await draft.elementHandle();
  let confirmations = 0;
  page.on('dialog', async dialog => {
    expect(dialog.type()).toBe('confirm');
    expect(dialog.message()).toContain('незбережені зміни');
    confirmations++;
    await dialog.dismiss();
  });
  const choice = page.getByRole('combobox', { name: 'Поточний простір', exact: true });
  await choice.click();
  await page.getByRole('option', { name: 'Інша редакція', exact: true }).click();
  await expect(choice).toContainText('Редакційний простір');
  await expect(draft).toHaveValue('Незбережений текст перед зміною простору.');
  await page.getByRole('button', { name: 'Новий простір', exact: true }).click();
  await page.getByRole('button', { name: 'Створити новий простір', exact: true }).click();
  await page.getByLabel('Назва простору', { exact: true }).fill('Нова редакція');
  await page.getByRole('button', { name: 'Створити простір', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Новий простір', exact: true })).toBeVisible();
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Новий простір', exact: true }).click();
  await page.getByRole('button', { name: 'Прийняти запрошення', exact: true }).click();
  await page.getByLabel('Код запрошення', { exact: true }).fill('fixture-invitation');
  await page.getByRole('button', { name: 'Приєднатися', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Приєднатися до простору', exact: true })).toBeVisible();
  await page.keyboard.press('Escape');
  expect(await mounted!.evaluate(element => element.isConnected)).toBe(true);
  await expect(draft).toHaveValue('Незбережений текст перед зміною простору.');
  expect(context.workspaceActions).toEqual([]);
  await page.getByRole('navigation', { name: 'Робота над проєктом' }).getByRole('link', { name: 'Бриф', exact: true }).click();
  await page.getByLabel('Авторські нотатки', { exact: true }).fill('Незбережений бриф.');
  await choice.click(); await page.getByRole('option', { name: 'Інша редакція', exact: true }).click();
  await expect(page.getByLabel('Авторські нотатки', { exact: true })).toHaveValue('Незбережений бриф.');
  await page.goto('/projects');
  await page.getByRole('button', { name: 'Створити проєкт', exact: true }).click();
  await page.getByLabel('Назва й тема проєкту', { exact: true }).fill('Незбережена тема.');
  await choice.click(); await page.getByRole('option', { name: 'Інша редакція', exact: true }).click();
  await expect(page.getByLabel('Назва й тема проєкту', { exact: true })).toHaveValue('Незбережена тема.');
  expect(confirmations).toBe(5);
  await assertClean(context);
});

test('a channel-only project offers Brief without imposing an Article route or placeholder', async ({ page }) => {
  const context = await fixture(page, false, false, false);
  await page.goto(`/projects/${projectId}`);
  await expect(page.getByRole('heading', { level: 1, name: topic, exact: true })).toBeVisible();
  const nav = page.getByRole('navigation', { name: 'Робота над проєктом' });
  await expect(nav.getByRole('link', { name: 'Бриф', exact: true })).toBeVisible();
  await expect(nav.getByRole('link', { name: 'Стаття', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Відкрити статтю', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Відкрити бриф', exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/projects/${projectId}/brief$`));
  await assertClean(context);
});

test('evidence highlighting can be toggled without changing the manuscript', async ({ page }) => {
  const context = await fixture(page, false, true);
  await page.goto(`/projects/${projectId}/article`);
  const toggle = page.getByRole('button', { name: 'Підкреслення доказів', exact: true });
  const mark = page.locator('.article-writing .article-evidence');
  await expect(toggle).toHaveAttribute('aria-pressed', 'true');
  await expect(mark).toHaveCSS('border-bottom-width', '1px');
  await toggle.focus(); await page.keyboard.press('Space');
  await expect(toggle).toHaveAttribute('aria-pressed', 'false');
  await expect(mark).toHaveCSS('border-bottom-width', '0px');
  await expect(mark).toHaveText(wording);
  await expect(mark).toHaveAttribute('data-evidence-id', 'evidence-1');
  for (const width of [1280, 768, 390]) {
    await page.setViewportSize({ width, height: 900 });
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: `.local-checks/evidence-toggle-${width}.png` });
  }
  await toggle.click();
  await expect(mark).toHaveCSS('border-bottom-width', '1px');
  expect(context.articleSaves).toHaveLength(0);
  await assertClean(context);
});

test('linking a newly selected sentence replaces the wording in the evidence inspector', async ({ page }) => {
  const context = await fixture(page, false, true);
  await page.goto(`/projects/${projectId}/article`);
  const writing = page.getByRole('textbox', { name: 'Текст статті', exact: true });
  await writing.getByRole('button', { name: 'Переглянути доказ для цього речення', exact: true }).click();
  const selectedProof = page.getByRole('region', { name: 'Вибраний доказ', exact: true });
  await expect(selectedProof).toContainText(wording);
  const replacement = 'Мешканці описали свої щоденні поїздки містом.';
  await writing.fill(replacement);
  await writing.focus(); await page.keyboard.press('ControlOrMeta+a');
  await page.locator('.article-evidence-item').filter({ hasText: 'Нотатки інтерв’ю' }).getByRole('button', { name: 'Прив’язати виділення', exact: true }).click();
  await expect(selectedProof).toContainText(`Спочатку прив’язане речення: «${replacement}».`);
  await expect(selectedProof).toContainText('Нотатки інтерв’ю');
  await expect(writing.locator('[data-evidence-id="evidence-2"]')).toHaveText(replacement);
  await expect(page.getByText('Збережено', { exact: true })).toBeVisible();
  await assertClean(context);
});

test('source disclosure is keyboard accessible, keeps its draft and exposes every existing import mode', async ({ page }) => {
  const context = await fixture(page);
  await page.setViewportSize({ width: 390, height: 900 });
  await page.goto(`/projects/${projectId}/sources`);
  const disclosure = page.locator('.source-add > summary');
  await expect(disclosure).toContainText('Додати джерело');
  await disclosure.focus(); await page.keyboard.press('Enter');
  await expect(page.getByLabel('Назва', { exact: true })).toBeVisible();
  await page.getByLabel('Назва', { exact: true }).fill('Додатковий текст');
  await page.getByLabel('Текст джерела', { exact: true }).fill('Новий синтетичний уривок.');
  await disclosure.click(); await expect(page.getByLabel('Текст джерела', { exact: true })).toBeHidden();
  await disclosure.focus(); await page.keyboard.press('Space');
  await expect(page.getByLabel('Текст джерела', { exact: true })).toHaveValue('Новий синтетичний уривок.');
  const modes = page.getByRole('group', { name: 'Тип нового матеріалу' });
  await modes.getByRole('button', { name: 'TXT / Markdown', exact: true }).click();
  await expect(page.getByLabel('Файл TXT або Markdown', { exact: true })).toBeVisible();
  await modes.getByRole('button', { name: 'PDF / DOCX', exact: true }).click();
  await expect(page.getByLabel('Файл PDF або DOCX', { exact: true })).toBeVisible();
  await modes.getByRole('button', { name: 'Посилання', exact: true }).click();
  await expect(page.getByLabel('Посилання на сторінку', { exact: true })).toBeVisible();
  await modes.getByRole('button', { name: 'Текст', exact: true }).click();
  await expect(page.getByLabel('Текст джерела', { exact: true })).toHaveValue('Новий синтетичний уривок.');
  await page.getByRole('button', { name: 'Додати джерело', exact: true }).click();
  await expect(page.locator('.source-plain-text')).toHaveText('Новий синтетичний уривок.');
  const readerTitle = page.locator('#source-reader-title');
  await expect(readerTitle).toBeFocused();
  const readerBox = (await readerTitle.boundingBox())!;
  expect(readerBox.y).toBeGreaterThanOrEqual(0);
  expect(readerBox.y + readerBox.height).toBeLessThan(900);
  await assertClean(context);
});

test('empty sources show the add task immediately without an empty reader panel', async ({ page }) => {
  const context = await fixture(page, true);
  await page.goto(`/projects/${projectId}/sources`);
  await expect(page.locator('.source-add')).toHaveAttribute('open', '');
  await expect(page.getByLabel('Текст джерела', { exact: true })).toBeVisible();
  await expect(page.locator('.source-reader')).toHaveCount(0);
  await assertClean(context);
});

test('brief saves named controls and article title reflows, autosaves and keeps keyboard formatting', async ({ page }) => {
  const context = await fixture(page);
  await page.goto(`/projects/${projectId}/brief`);
  await expect(page.getByLabel('Аудиторія', { exact: true })).toBeVisible();
  await page.getByLabel('Авторські нотатки').fill('Нова редакторська нотатка.');
  await page.getByRole('button', { name: 'Зберегти бриф', exact: true }).click();
  await expect(page.getByText('Бриф збережено', { exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByLabel('Авторські нотатки')).toHaveValue('Нова редакторська нотатка.');
  await page.getByRole('navigation', { name: 'Робота над проєктом' }).getByRole('link', { name: 'Стаття', exact: true }).click();
  const title = page.getByRole('textbox', { name: 'Заголовок статті', exact: true });
  const longTitle = 'Як надійний громадський транспорт допомагає мешканцям міста планувати щоденні поїздки та залишати більше часу для родини, роботи й відпочинку';
  await title.fill(longTitle);
  for (const width of [390, 768, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    await expect.poll(() => title.evaluate(element => element.scrollHeight <= element.clientHeight + 1)).toBe(true);
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  }
  const writing = page.getByRole('textbox', { name: 'Текст статті', exact: true });
  await writing.fill('Нова редакторська думка про щоденні поїздки.');
  await expect(page.getByText('Збережено', { exact: true })).toBeVisible();
  expect(context.articleSaves.at(-1)?.title).toBe(longTitle);
  await writing.focus(); await page.keyboard.press('ControlOrMeta+a'); await page.keyboard.press('ControlOrMeta+b');
  await expect(page.getByRole('button', { name: 'Жирний', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByText('Збережено', { exact: true })).toBeVisible();
  await page.reload();
  await expect(title).toHaveValue(longTitle);
  await expect(writing.locator('strong')).toHaveText('Нова редакторська думка про щоденні поїздки.');
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.getByRole('button', { name: 'Історія версій', exact: true }).click();
  await expect(page.getByRole('complementary', { name: 'Версії статті', exact: true })).toBeVisible();
  await expect.poll(() => title.evaluate(element => element.scrollHeight <= element.clientHeight + 1)).toBe(true);
  await page.getByRole('button', { name: 'Закрити контекст', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Історія версій', exact: true })).toBeFocused();
  await expect.poll(() => title.evaluate(element => element.scrollHeight <= element.clientHeight + 1)).toBe(true);
  await assertClean(context);
});
