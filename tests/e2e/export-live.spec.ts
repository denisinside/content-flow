import { mkdirSync, writeFileSync } from 'node:fs';
import { test, expect, type APIResponse, type Page } from '@playwright/test';

type Headers = { 'X-CSRF-Token': string; Origin: string };
interface Project { project: { id: string } }
interface ExportRow { id: string; format: 'TXT' | 'MARKDOWN' | 'ZIP'; status: string; jobId: string; filename: string | null }
interface Readiness { projectRevision: number; ready: boolean; items: { format: string; ready: boolean; revisionId: string | null; reviewCounter: number | null; reasons: string[] }[]; exports: ExportRow[] }
interface TelegramState { adaptation: { id: string; revision: number; draft: unknown; currentApprovedRevisionId: string | null; revisions: { id: string; number: number; reviewCounter: number; content: { text: string }; status: string; approvedAt: string | null; approvedBy: string | null }[] } | null }
interface ArticleState { article: { revision: number; currentApprovedVersionId: string | null; versions: { id: string; reviewCounter: number; content: unknown; approvedAt: string | null; approvedBy: string | null }[] } | null }

async function checked<T>(response: Pick<APIResponse, 'text' | 'ok' | 'url' | 'status'>): Promise<T> {
  const body = await response.text();
  expect(response.ok(), `${response.url()} ${response.status()}: ${body}`).toBe(true);
  return JSON.parse(body) as T;
}

async function capture(page: Page, name: string) {
  for (const width of [1440, 1280, 768, 390]) {
    await page.setViewportSize({ width, height: 900 });
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: `.local-checks/m34/export-live-${name}-${width}.png`, fullPage: true });
  }
  await page.setViewportSize({ width: 1280, height: 900 });
}

async function createIdentity(page: Page, nonce: string) {
  const displayName = `M34 ${nonce.slice(-6)}`;
  await page.goto('/');
  await page.getByRole('button', { name: 'Реєстрація' }).click();
  await page.getByLabel(/Ваше ім’я/).fill(displayName);
  await page.getByLabel('Електронна пошта').fill(`m34-live-${nonce}@example.test`);
  await page.getByLabel('Пароль').fill('TestOnly!ContextFlow2026');
  await page.getByRole('button', { name: 'Створити обліковий запис' }).click();
  await expect(page.locator('#account-title')).toContainText(displayName, { timeout: 20_000 });
  const session = await checked<{ csrfToken: string }>(await page.request.get('/api/auth/session'));
  const headers: Headers = { 'X-CSRF-Token': session.csrfToken, Origin: new URL(page.url()).origin };
  const notice = await checked<{ notice: { version: string } }>(await page.request.get('/api/auth/external-processing'));
  await checked(await page.request.post('/api/auth/external-processing', { headers, data: { noticeVersion: notice.notice.version } }));
  return headers;
}

async function buildExactJob(jobId: string, actorId: string) {
  // Dynamic import ensures test-mode routing is selected before runtime config is loaded.
  const previous = process.env['NODE_ENV'];
  process.env['NODE_ENV'] = 'test';
  let health: import('@contextflow/backend').DependencyHealthService | undefined;
  try {
    const backend = await import('@contextflow/backend');
    const config = backend.loadRuntimeConfig();
    expect(new URL(config.databaseUrl).hostname).toMatch(/^(localhost|127\.0\.0\.1)$/u);
    expect(new URL(config.databaseUrl).port).toBe('54330');
    expect(new URL(config.directDatabaseUrl).hostname).toMatch(/^(localhost|127\.0\.0\.1)$/u);
    expect(new URL(config.directDatabaseUrl).port).toBe('54330');
    health = new backend.DependencyHealthService(config);
    const jobs = new backend.DurableJobService(health.prisma, { noticeVersion: backend.EXTERNAL_PROCESSING_NOTICE.version });
    const facts = new backend.FactualBasisService(health.prisma, jobs);
    const articles = new backend.ArticleService(health.prisma, jobs, facts);
    const telegram = new backend.TelegramService(health.prisma, jobs, facts, articles);
    const assets = new backend.PrivateAssetStore();
    expect(assets.config.driver).toBe('filesystem');
    const service = new backend.ExportService(health.prisma, jobs, articles, telegram, assets);
    const handler = backend.createExportJobHandler(service);
    const claimed = await jobs.claim(jobId, 1, `m34-live-${actorId}`);
    expect(claimed, `Export job ${jobId} must be queued and claimable`).not.toBeNull();
    const { job, attempt } = claimed!;
    const context = { job, attempt, signal: new AbortController().signal,
      recordSubmissionIntent: async () => { throw new Error('Local export must not submit to an external provider'); },
      recordProviderRun: async () => { throw new Error('Local export must not create a provider run'); },
      setProgress: (stage: string) => jobs.progress(job, attempt, stage) };
    try {
      const result = await handler.execute(context);
      await jobs.succeed(job, attempt, handler, result);
      await handler.completed?.(context, result);
    } catch (error) {
      await jobs.fail(job, attempt, error);
      await handler.failed?.(context, error);
      throw error;
    }
  } finally {
    if (health) await health.onModuleDestroy();
    if (previous === undefined) delete process.env['NODE_ENV']; else process.env['NODE_ENV'] = previous;
  }
}

function unzipStored(bytes: Buffer): Map<string, Buffer> {
  const files = new Map<string, Buffer>();
  let offset = 0;
  while (offset + 4 <= bytes.length && bytes.readUInt32LE(offset) === 0x04034b50) {
    const method = bytes.readUInt16LE(offset + 8);
    const compressedSize = bytes.readUInt32LE(offset + 18);
    const nameLength = bytes.readUInt16LE(offset + 26);
    const extraLength = bytes.readUInt16LE(offset + 28);
    const nameStart = offset + 30;
    const name = bytes.toString('utf8', nameStart, nameStart + nameLength);
    const dataStart = nameStart + nameLength + extraLength;
    expect(method, `ZIP entry ${name} uses the supported deterministic STORE method`).toBe(0);
    files.set(name, bytes.subarray(dataStart, dataStart + compressedSize));
    offset = dataStart + compressedSize;
  }
  expect(files.size, 'ZIP contains at least one local file entry').toBeGreaterThan(0);
  return files;
}

async function createWorkspaceProject(page: Page, headers: Headers, nonce: string, topic: string, formats: ('ARTICLE' | 'TELEGRAM_POST')[]) {
  const workspace = await checked<{ workspace: { id: string } }>(await page.request.post('/api/v1/workspaces', { headers, data: { name: `M34 ${nonce}` } }));
  return checked<Project>(await page.request.post('/api/v1/projects', { headers, data: { workspaceId: workspace.workspace.id, topic, formats } }));
}

const creativeBrief = (nonce: string, expectedRevision: number, notes = 'Коротке авторське повідомлення для редакційної перевірки.') => ({
  expectedRevision, contentMode: 'CREATIVE', topic: `Міський маршрут ${nonce}`, audience: 'Мешканці міста',
  centralMessage: 'Знайомий шлях може починатися з маленької зміни.', category: 'Міське життя', tone: 'Спокійний, уважний',
  targetLength: 240, cta: 'Поділіться своїм маршрутом.', exclusions: ['Без неперевірених чисел'], notes, requiredClaimRevisionIds: [],
});

async function makeExportFromUi(page: Page, projectId: string, format: 'ZIP' | 'TXT' | 'MARKDOWN') {
  await page.goto(`/projects/${projectId}/export`);
  await expect(page.getByRole('heading', { name: 'Готовність і експорт' })).toBeVisible();
  await expect(page.getByRole('checkbox', { name: 'Вибрати Допис у Telegram' })).toBeEnabled();
  await page.getByRole('checkbox', { name: 'Вибрати Допис у Telegram' }).check();
  const formatLabel = format === 'ZIP' ? 'ZIP-архів' : format === 'TXT' ? 'Текст TXT' : 'Markdown';
  await page.getByLabel(formatLabel).check();
  const response = page.waitForResponse(row => row.request().method() === 'POST' && row.url().endsWith('/exports'));
  await page.getByRole('button', { name: 'Підготувати файл' }).click();
  const created = await checked<{ exportId: string; jobId: string }>(await response);
  await buildExactJob(created.jobId, projectId);
  await page.reload();
  await expect(page.locator('.export-history-row').first()).toContainText('Готовий', { timeout: 10_000 });
  return created;
}

test('live M3.4 channels-only ZIP, immutable reviewed export, factual source provenance and private delivery', async ({ page }) => {
  test.setTimeout(240_000);
  mkdirSync('.local-checks/m34', { recursive: true });
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  const nonce = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const headers = await createIdentity(page, nonce);

  // DIRECT creative output: this selected project has no Article or Outline row.
  const directProject = await createWorkspaceProject(page, headers, `direct-${nonce}`, `Самостійний Telegram ${nonce}`, ['TELEGRAM_POST']);
  const directBase = `/api/v1/projects/${directProject.project.id}`;
  const brief = creativeBrief(nonce, 0);
  await checked(await page.request.post(`${directBase}/brief`, { headers, data: brief }));
  await checked(await page.request.post(`${directBase}/telegram/draft`, { headers, data: {
    expectedRevision: 0, inputMode: 'DIRECT', contentMode: 'CREATIVE', includeLink: true,
    content: { text: 'Ранковий маршрут починається з тихої вулиці. [ПОСИЛАННЯ] Яка деталь додає вам спокою?', mappings: [] },
  } }));
  const saved = await checked<TelegramState>(await page.request.post(`${directBase}/telegram/checkpoint`, { headers, data: { expectedRevision: 1 } }));
  const directVersion = saved.adaptation!.revisions[0]!;
  const approvedDirect = await checked<TelegramState>(await page.request.post(`${directBase}/telegram/${directVersion.id}/approve`, { headers, data: { expectedRevision: 2, expectedReviewCounter: 0, acknowledgeUnmapped: true } }));
  expect(approvedDirect.adaptation!.currentApprovedRevisionId).toBe(directVersion.id);
  expect(await checked<{ article: unknown }>(await page.request.get(`${directBase}/article`))).toMatchObject({ article: null });
  expect(await checked<{ outline: unknown }>(await page.request.get(`${directBase}/editorial`))).toMatchObject({ outline: null });
  const initialReady = await checked<Readiness>(await page.request.get(`${directBase}/exports`));
  expect(initialReady.items).toHaveLength(1);
  expect(initialReady.items[0]).toMatchObject({ format: 'TELEGRAM_POST', ready: true, revisionId: directVersion.id, reviewCounter: 0 });

  const zipExport = await makeExportFromUi(page, directProject.project.id, 'ZIP');
  await capture(page, 'direct-ready');
  const zipResponse = await page.request.get(`${directBase}/exports/${zipExport.exportId}/download`);
  expect(zipResponse.status()).toBe(200);
  const directZipBytes = await zipResponse.body();
  writeFileSync('.local-checks/m34/telegram-direct.zip', directZipBytes);
  const zip = unzipStored(directZipBytes);
  expect([...zip.keys()]).toEqual(['telegram.txt', 'telegram.md', 'manifest.json', 'sources.json']);
  const directTxt = zip.get('telegram.txt')!.toString('utf8');
  expect(directTxt).toContain('Ранковий маршрут');
  expect(directTxt).toContain('[ПОСИЛАННЯ]');
  expect(directTxt).toContain('Авторський текст');
  expect(JSON.parse(zip.get('sources.json')!.toString('utf8'))).toEqual([]);
  const directManifest = JSON.parse(zip.get('manifest.json')!.toString('utf8')) as { items: { revisionId: string; format: string }[] };
  expect(directManifest.items).toEqual([expect.objectContaining({ revisionId: directVersion.id, format: 'TELEGRAM_POST' })]);

  // An unsaved-as-approval creative draft does not rewrite or obsolete the frozen package.
  await checked(await page.request.post(`${directBase}/telegram/draft`, { headers, data: {
    expectedRevision: 3, inputMode: 'DIRECT', contentMode: 'CREATIVE', includeLink: false,
    content: { text: 'Окремий новий чернетковий текст без зміни погодженої версії.', mappings: [] },
  } }));
  const preserved = await page.request.get(`${directBase}/exports/${zipExport.exportId}/download`);
  expect(preserved.status()).toBe(200);
  const markdownExport = await makeExportFromUi(page, directProject.project.id, 'MARKDOWN');
  const markdownDelivery = await page.request.get(`${directBase}/exports/${markdownExport.exportId}/download`);
  expect(markdownDelivery.status()).toBe(200);
  const markdownBytes = await markdownDelivery.body();
  writeFileSync('.local-checks/m34/telegram-direct.md', markdownBytes);
  expect(markdownBytes.toString('utf8')).toContain('Авторський текст');
  expect(markdownBytes.toString('utf8')).toContain('\\[ПОСИЛАННЯ\\]');

  // A changed saved brief makes the first exact manifest obsolete until re-review.
  await checked(await page.request.post(`${directBase}/brief`, { headers, data: creativeBrief(nonce, 1, 'Новий редакційний контекст для перегляду погодженого тексту.') }));
  const stale = await checked<Readiness>(await page.request.get(`${directBase}/exports`));
  expect(stale.items[0]).toMatchObject({ ready: false, revisionId: directVersion.id, reviewCounter: 0 });
  await page.goto(`/projects/${directProject.project.id}/export`);
  await expect(page.getByText('Потрібне погодження редактора.')).toHaveCount(0);
  await expect(page.getByText('Після погодження змінився бриф.', { exact: false })).toBeVisible();
  await capture(page, 'direct-stale');
  const deniedStale = await page.request.get(`${directBase}/exports/${zipExport.exportId}/download`);
  expect([403, 409]).toContain(deniedStale.status());
  const obsoleteState = await checked<Readiness>(await page.request.get(`${directBase}/exports`));
  expect(obsoleteState.exports.find(row => row.id === zipExport.exportId)?.status).toBe('OBSOLETE');

  await page.goto(`/projects/${directProject.project.id}/telegram`);
  await page.getByRole('button', { name: 'Історія й походження' }).click();
  const rereviewResponse = page.waitForResponse(row => row.request().method() === 'POST' && row.url().endsWith(`/telegram/${directVersion.id}/rereview`));
  await page.getByRole('button', { name: 'Переглянути без зміни тексту' }).click();
  const rereview = await checked<TelegramState>(await rereviewResponse);
  expect(rereview.adaptation!.revisions.find(version => version.id === directVersion.id)).toMatchObject({ status: 'APPROVED', reviewCounter: 1 });
  const txtExport = await makeExportFromUi(page, directProject.project.id, 'TXT');
  await capture(page, 'direct-rereviewed');
  const txtDelivery = await page.request.get(`${directBase}/exports/${txtExport.exportId}/download`);
  expect(txtDelivery.status()).toBe(200);
  const directTxtBytes = await txtDelivery.body();
  writeFileSync('.local-checks/m34/telegram-rereviewed.txt', directTxtBytes);
  const txt = directTxtBytes.toString('utf8');
  expect(txt).toContain('Авторський текст');
  expect(txt).toContain('Ранковий маршрут');
  expect(txt).toContain('[ПОСИЛАННЯ]');

  // Factual mixed output: source list follows the exact article and Telegram evidence edges.
  const mixedProject = await createWorkspaceProject(page, headers, `mixed-${nonce}`, `Фактичний Telegram ${nonce}`, ['ARTICLE', 'TELEGRAM_POST']);
  const mixedBase = `/api/v1/projects/${mixedProject.project.id}`;
  const sourceText = 'У перевіреному опитуванні взяли участь 12 мешканців.';
  const source = await checked<{ material: { id: string; currentSnapshotId: string } }>(await page.request.post(`${mixedBase}/materials`, { headers, data: { label: 'Джерело для фактичного експорту', purpose: 'FACTUAL_SOURCE', text: sourceText } }));
  const snapshot = await checked<{ snapshot: { id: string; normalizedText: string; fragments: { id: string; startOffset: number; endOffset: number; sha256: string }[] } }>(await page.request.get(`${mixedBase}/materials/${source.material.id}/snapshots/${source.material.currentSnapshotId}`));
  const fragment = snapshot.snapshot.fragments[0]!;
  const claim = await checked<{ claim: { id: string; revision: number; currentRevisionId: string; currentRevision: { evidence: { id: string }[] } } }>(await page.request.post(`${mixedBase}/claims`, { headers, data: { wording: sourceText, evidence: [{
    snapshotId: snapshot.snapshot.id, fragmentId: fragment.id, startOffset: fragment.startOffset, endOffset: fragment.endOffset,
    quote: snapshot.snapshot.normalizedText.slice(fragment.startOffset, fragment.endOffset), sha256: fragment.sha256, relation: 'SUPPORTS',
  }] } }));
  await checked(await page.request.post(`${mixedBase}/claims/${claim.claim.id}/revisions/${claim.claim.currentRevisionId}/approve`, { headers, data: { expectedRevision: claim.claim.revision } }));
  await checked(await page.request.post(`${mixedBase}/basis`, { headers, data: { claimRevisionIds: [claim.claim.currentRevisionId] } }));
  await checked(await page.request.post(`${mixedBase}/brief`, { headers, data: {
    ...creativeBrief(nonce, 0), contentMode: 'FACTUAL', topic: 'Перевірене опитування',
    centralMessage: sourceText, requiredClaimRevisionIds: [claim.claim.currentRevisionId],
  } }));
  const unused = await checked<{ material: { id: string } }>(await page.request.post(`${mixedBase}/materials`, { headers, data: { label: 'Невикористане джерело', purpose: 'FACTUAL_SOURCE', text: 'Цей матеріал не пов’язаний із вибраними твердженнями.' } }));
  const evidenceId = claim.claim.currentRevision.evidence[0]!.id;
  const evidenceMark = { type: 'evidence', attrs: { claimRevisionId: claim.claim.currentRevisionId, evidenceId, quote: sourceText } };
  await checked(await page.request.post(`${mixedBase}/article/draft`, { headers, data: { expectedRevision: 0, contentMode: 'FACTUAL', content: {
    title: 'Результат опитування', document: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: sourceText, marks: [evidenceMark] }] }] },
  } } }));
  const articleCheckpoint = await checked<ArticleState>(await page.request.post(`${mixedBase}/article/checkpoint`, { headers, data: { expectedRevision: 1 } }));
  const articleVersion = articleCheckpoint.article!.versions[0]!;
  const articleApproval = await checked<ArticleState>(await page.request.post(`${mixedBase}/article/${articleVersion.id}/approve`, { headers, data: { expectedRevision: 2, acknowledgeUnmapped: true } }));
  const approvedArticle = articleApproval.article!.versions[0]!;
  const telegramText = sourceText;
  await checked(await page.request.post(`${mixedBase}/telegram/draft`, { headers, data: { expectedRevision: 0, inputMode: 'ARTICLE_DERIVED', contentMode: 'FACTUAL', includeLink: false,
    content: { text: telegramText, mappings: [{ startOffset: 0, endOffset: telegramText.length, quote: sourceText, claimRevisionId: claim.claim.currentRevisionId, evidenceId }] },
  } }));
  const telegramCheckpoint = await checked<TelegramState>(await page.request.post(`${mixedBase}/telegram/checkpoint`, { headers, data: { expectedRevision: 1 } }));
  const factualTelegram = telegramCheckpoint.adaptation!.revisions[0]!;
  const factualApproval = await checked<TelegramState>(await page.request.post(`${mixedBase}/telegram/${factualTelegram.id}/approve`, { headers, data: { expectedRevision: 2, expectedReviewCounter: 0, acknowledgeUnmapped: false } }));
  expect(factualApproval.adaptation!.currentApprovedRevisionId).toBe(factualTelegram.id);
  expect(approvedArticle.approvedAt).toBeTruthy();
  const factualReadiness = await checked<Readiness>(await page.request.get(`${mixedBase}/exports`));
  expect(factualReadiness.items).toHaveLength(2);
  expect(factualReadiness.items.every(item => item.ready)).toBe(true);
  await page.goto(`/projects/${mixedProject.project.id}/export`);
  await expect(page.getByRole('heading', { name: 'Готовність і експорт' })).toBeVisible();
  await page.getByRole('checkbox', { name: 'Вибрати Стаття' }).check();
  await page.getByRole('checkbox', { name: 'Вибрати Допис у Telegram' }).check();
  await expect(page.getByLabel('ZIP-архів')).toBeChecked();
  const factualPost = page.waitForResponse(row => row.request().method() === 'POST' && row.url().endsWith('/exports'));
  await page.getByRole('button', { name: 'Підготувати файл' }).click();
  const factualExport = await checked<{ exportId: string; jobId: string }>(await factualPost);
  await buildExactJob(factualExport.jobId, mixedProject.project.id);
  await page.reload();
  await expect(page.locator('.export-history-row').first()).toContainText('Готовий', { timeout: 10_000 });
  await capture(page, 'factual-ready');
  const factualDownload = await page.request.get(`${mixedBase}/exports/${factualExport.exportId}/download`);
  expect(factualDownload.status()).toBe(200);
  const factualZipBytes = await factualDownload.body();
  writeFileSync('.local-checks/m34/article-telegram-factual.zip', factualZipBytes);
  const factualZip = unzipStored(factualZipBytes);
  const factualSources = JSON.parse(factualZip.get('sources.json')!.toString('utf8')) as unknown[];
  const sourceJSON = JSON.stringify(factualSources);
  expect(sourceJSON).toContain(source.material.id);
  expect(sourceJSON).toContain(fragment.id);
  expect(sourceJSON).not.toContain(unused.material.id);
  expect(sourceJSON).not.toContain('Цей матеріал не пов’язаний');
  expect(factualZip.get('article.txt')!.toString('utf8')).toContain(sourceText);
  expect(factualZip.get('telegram.txt')!.toString('utf8')).toContain(sourceText);
  const manifest = JSON.parse(factualZip.get('manifest.json')!.toString('utf8')) as { items: { revisionId: string; requiredParentIds?: string[] }[] };
  expect(manifest.items.map(item => item.revisionId)).toEqual([articleVersion.id, factualTelegram.id]);

  // Re-review records the new effective article without rewriting original lineage.
  const currentArticle = await checked<ArticleState>(await page.request.get(`${mixedBase}/article`));
  const nextDraft = await checked<ArticleState>(await page.request.post(`${mixedBase}/article/draft`, { headers, data: {
    expectedRevision: currentArticle.article!.revision, contentMode: 'FACTUAL', content: {
      title: 'Оновлений заголовок опитування', document: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: sourceText, marks: [evidenceMark] }] }] },
    },
  } }));
  const nextCheckpoint = await checked<ArticleState>(await page.request.post(`${mixedBase}/article/checkpoint`, { headers, data: { expectedRevision: nextDraft.article!.revision } }));
  const nextArticle = nextCheckpoint.article!.versions[0]!;
  await checked(await page.request.post(`${mixedBase}/article/${nextArticle.id}/approve`, { headers, data: {
    expectedRevision: nextCheckpoint.article!.revision, acknowledgeUnmapped: true,
  } }));
  const currentTelegram = await checked<TelegramState>(await page.request.get(`${mixedBase}/telegram`));
  await checked(await page.request.post(`${mixedBase}/telegram/${factualTelegram.id}/rereview`, { headers, data: {
    expectedRevision: currentTelegram.adaptation!.revision, expectedReviewCounter: 0, acknowledgeUnmapped: false,
  } }));
  expect((await page.request.get(`${mixedBase}/exports/${factualExport.exportId}/download`)).status()).toBe(409);
  const reviewedReadiness = await checked<Readiness>(await page.request.get(`${mixedBase}/exports`));
  const reviewedExport = await checked<{ exportId: string; jobId: string }>(await page.request.post(`${mixedBase}/exports`, { headers, data: {
    expectedProjectRevision: reviewedReadiness.projectRevision, commandKey: `reviewed-${nonce}`, format: 'ZIP',
    items: reviewedReadiness.items.map(item => ({ format: item.format, revisionId: item.revisionId, reviewCounter: item.reviewCounter })),
  } }));
  await buildExactJob(reviewedExport.jobId, mixedProject.project.id);
  const reviewedDownload = await page.request.get(`${mixedBase}/exports/${reviewedExport.exportId}/download`);
  expect(reviewedDownload.status()).toBe(200);
  const reviewedBytes = await reviewedDownload.body();
  writeFileSync('.local-checks/m34/article-telegram-reviewed.zip', reviewedBytes);
  const reviewedZip = unzipStored(reviewedBytes);
  const reviewedManifest = JSON.parse(reviewedZip.get('manifest.json')!.toString('utf8')) as { items: Array<{ format: string; provenance: {
    originalInputs: { sourceArticleVersionId: string }; effectiveDependencies: { sourceArticle: { revisionId: string } };
  } }> };
  expect(reviewedManifest.items.find(item => item.format === 'TELEGRAM_POST')?.provenance).toMatchObject({
    originalInputs: { sourceArticleVersionId: articleVersion.id }, effectiveDependencies: { sourceArticle: { revisionId: nextArticle.id } },
  });
  const reviewedSources = reviewedZip.get('sources.json')!.toString('utf8');
  expect(reviewedSources).toContain('ORIGINAL_SOURCE_ARTICLE');
  expect(reviewedSources).toContain('REVIEWED_SOURCE_ARTICLE');
  expect(reviewedSources).not.toContain(unused.material.id);

  // A changed factual dependency blocks delivery even though the archived bytes remain immutable.
  await checked(await page.request.post(`${mixedBase}/claims/${claim.claim.id}/evidence/${evidenceId}/invalidate`, { headers, data: { expectedRevision: claim.claim.revision + 1, reason: 'Перевірка джерела виявила потребу в повторній оцінці.' } }));
  const factualStale = await checked<Readiness>(await page.request.get(`${mixedBase}/exports`));
  expect(factualStale.items.every(item => !item.ready)).toBe(true);
  const blockedDownload = await page.request.get(`${mixedBase}/exports/${factualExport.exportId}/download`);
  expect([403, 409]).toContain(blockedDownload.status());
  expect((await page.request.get(`${mixedBase}/exports/${reviewedExport.exportId}/download`)).status()).toBe(409);
  await page.goto(`/projects/${mixedProject.project.id}/export`);
  await expect(page.getByText('Є недійсна або відкликана фактична основа.')).toHaveCount(2);
  await expect(page.getByText('Є недійсна або відкликана фактична основа.').first()).toBeVisible();
  await capture(page, 'factual-invalidated');

  await checked(await page.request.post('/api/auth/logout', { headers, data: {} }));
  const unauthenticated = await page.request.get(`${directBase}/exports/${txtExport.exportId}/download`);
  expect(unauthenticated.status()).toBe(401);
  expect(errors).toEqual([]);
  writeFileSync('.local-checks/m34/export-live-accessibility.yml', await page.locator('.export-workspace').ariaSnapshot());
});
