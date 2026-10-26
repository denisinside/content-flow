import { createHash } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';

export const projectId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
export const workspaceId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
export const topic = 'Міська мобільність: як щоденні поїздки змінюють життя міста';
export const sourceName = 'Звіт про щоденні поїздки';
export const snapshotVersion = 1;

type ArticleContent = { title: string; document: { type: string; content: unknown[] } };



const base = `/api/v1/projects/${projectId}`;
const now = '2026-10-09T10:00:00Z';

const sourceText = 'У дослідженні взяли участь 12 мешканців міста. Вони описали щоденні поїздки громадським транспортом.\n\nРедакція перевірила збережений звіт і точні цитати учасників.';
const digest = createHash('sha256').update(sourceText).digest('hex');
const wording = 'У дослідженні взяли участь 12 мешканців міста.';

export async function installM63Fixture(page: Page, emptySources = false, linkedEvidence = false, articleSelected = true, options: { longName?: boolean; member?: boolean; consent?: boolean; preferenceFailure?: boolean; switchable?: boolean; signedOut?: boolean; articleFailure?: 'conflict' | 'network'; sourceFailure?: boolean; telegramFailure?: boolean; claimJob?: 'failed' | 'running'; jobsPollFailure?: boolean; jobSucceedsOnSecondPoll?: boolean } = {}) {
  const violations: string[] = [];
  const pageErrors: string[] = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  const project = { id: projectId, workspaceId, topic, formats: articleSelected ? ['ARTICLE', 'TELEGRAM_POST', 'LINKEDIN_COVER', 'LINKEDIN_CAROUSEL'] : ['TELEGRAM_POST'], revision: 1, createdAt: now, updatedAt: now, archivedAt: null };
  const workspace = { id: workspaceId, ownerId: options.member ? 'other-user' : 'fixture-user', name: options.longName ? 'Редакція міських досліджень та громадського транспорту з довгою назвою' : 'Редакційний простір', archivedAt: null, members: [] };
  const workspaceActions: { path: string; body: unknown }[] = [];
  const workspaceList = [workspace];
  if (options.switchable) workspaceList.push({ ...workspace, id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', name: 'Інша редакція' });
  let consent = options.consent ?? true;
  let preferenceFailure = options.preferenceFailure ?? false;
  let authenticated = !options.signedOut;
  let jobsPollCount = 0;
  const claimJob = (status: 'FAILED' | 'RUNNING' | 'SUCCEEDED') => ({
    id: 'synthetic-claim-extraction-job', operation: 'CLAIM_EXTRACTION', status,
    progressStage: status === 'FAILED' ? 'FAILED' : status === 'SUCCEEDED' ? 'COMPLETE' : 'PROCESSING',
    attemptCount: status === 'FAILED' ? 3 : 1, maxAttempts: 3, retryAllowed: status === 'FAILED',
    errorCategory: status === 'FAILED' ? 'TIMEOUT' : null, updatedAt: now,
  });
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
  await page.context().route('**/*', async route => {
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
    if (path === `${base}/jobs` && request.method() === 'GET') {
      jobsPollCount++;
      if (options.jobsPollFailure && jobsPollCount === 1) return json({ error: 'FIXTURE_UNAVAILABLE' }, 503);
      if (!options.claimJob) return json({ jobs: [] });
      const status = options.jobSucceedsOnSecondPoll && jobsPollCount >= 2 ? 'SUCCEEDED' : options.claimJob === 'failed' ? 'FAILED' : 'RUNNING';
      return json({ jobs: [claimJob(status)] });
    }
    if (path === `${base}/materials` && request.method() === 'GET') return json({ materials });
    if (request.method() === 'GET' && path.startsWith(`${base}/materials/`)) {
      const parts = path.slice(`${base}/materials/`.length).split('/');
      const selected = materials.find(item => item.id === parts[0]);
      if (selected && parts.length === 1) return json({ material: selected, snapshots: [snapshots.get(selected.currentSnapshotId)!] });
      const selectedSnapshot = snapshots.get(parts[2] ?? '');
      if (selected && parts[1] === 'snapshots' && selectedSnapshot?.materialId === selected.id) return json({ snapshot: selectedSnapshot });
    }
    if (path === `${base}/materials` && request.method() === 'POST') {
      if (options.sourceFailure) return json({ error: 'FIXTURE_UNAVAILABLE' }, 503);
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
      if (options.articleFailure === 'conflict') return json({ error: 'REVISION_CONFLICT' }, 409);
      if (options.articleFailure === 'network') return route.abort('failed');
      const body = request.postDataJSON() as { expectedRevision: number; content: ArticleContent; contentMode: string };
      expect(body.expectedRevision).toBe(article.revision);
      articleSaves.push(body.content);
      article = { ...article, revision: article.revision + 1, draft: { ...article.draft, content: body.content, contentMode: body.contentMode } };
      return json(articleState());
    }
    if (path === `${base}/visuals` && request.method() === 'GET') {
      const format = url.searchParams.get('format') ?? 'LINKEDIN_COVER';
      return json({
        format, formatSelected: true,
        style: { revision: 1, revisionId: '20000000-0000-4000-8000-000000000001', defaults: { background: '#ffffff', text: '#20262b', accent: '#b86f45', font: 'onest', logo: null } },
        parent: { kind: 'ADAPTATION', id: '30000000-0000-4000-8000-000000000001', sha256: 'synthetic-approved-parent', reviewCounter: 0, content: {}, staleReasons: [], blockingReasons: [], eligible: true },
        composition: { id: '40000000-0000-4000-8000-000000000001', revision: 1,
          draft: { counter: 0, content: { schemaVersion: 'visual-v1', rendererVersion: 'konva-10.7.1-visual-v1', width: 1080, height: 1080, frames: [{ id: '00000000-0000-4000-8000-000000000001', sourceFrameId: null, purpose: 'Заголовок', templateId: 'editorial', background: '#ffffff', layers: [{ id: '10000000-0000-4000-8000-000000000001', type: 'text', x: 84, y: 110, width: 912, height: 860, text: 'Міський сервіс стає доступнішим', font: 'onest', fontSize: 56, fontWeight: '600', color: '#20262b', align: 'left', lineHeight: 1.2, mappings: [] }] }] }, sha256: 'synthetic-visual-draft', parentKind: 'ADAPTATION', parentRevisionId: '30000000-0000-4000-8000-000000000001', parentRevisionHash: 'synthetic-approved-parent', parentReviewCounter: 0 }, revisions: [] },
      });
    }
    if (path === `${base}/visuals/backgrounds` && request.method() === 'GET') return json({ configured: false, jobs: [], candidates: [] });
    if (path === `${base}/telegram` && request.method() === 'GET') {
      const format = url.searchParams.get('format') ?? 'TELEGRAM_POST';
      return json({
        format, formatSelected: true, telegramSelected: format === 'TELEGRAM_POST', adaptation: null,
        brief: { id: 'brief-1', revision: 1, currentRevision: { id: 'brief-1', contentMode: 'CREATIVE' }, history: [] },
        style: { revision: 3 }, prerequisites: { blockingReasons: [], missingBasis: false, unverified: false },
        approvedArticle: null, eligibleEvidence: [], staleReasons: [], mappingIssues: [], hasUnmapped: false, blockingReasons: [],
      });
    }
    if (path === `${base}/telegram/draft` && request.method() === 'POST' && options.telegramFailure) return json({ error: 'REVISION_CONFLICT' }, 409);
    if (path === `${base}/scripts` && request.method() === 'GET') {
      const format = url.searchParams.get('format') ?? 'LINKEDIN_CAROUSEL';
      const parentId = 'caption-approved';
      const frame = { id: 'frame-1', purpose: 'Щоденні поїздки', text: 'Мешканці щодня користуються громадським транспортом.', visualHint: 'Чиста схема міських маршрутів', transition: 'Далі — про зміну сервісу', mappings: [] };
      const content = { frames: [frame] };
      return json({
        format, formatSelected: true,
        adaptation: { id: `adaptation-${format}`, revision: 2, currentApprovedRevisionId: parentId, revisions: [{ id: parentId, number: 1, approvedAt: now, withdrawnAt: null }] },
        script: { id: `script-${format}`, format, revision: 1, currentApprovedRevisionId: null, draft: { counter: 1, parentAdaptationRevisionId: parentId, parentAdaptationRevisionHash: 'caption-hash', parentAdaptationReviewCounter: 0, content, sha256: 'synthetic-script-draft', baseRevisionId: null }, revisions: [] },
        parent: { id: parentId, sha256: 'caption-hash', eligible: true, staleReasons: [], blockingReasons: [] },
      });
    }
    if (path === `${base}/exports` && request.method() === 'GET') return json({
      projectRevision: 1, ready: true, exports: [], items: [
        { format: 'ARTICLE', title: 'Стаття про міські поїздки', revisionId: 'article-1', number: 1, reviewCounter: 0, contentMode: 'FACTUAL', ready: true, reasons: [] },
        { format: 'TELEGRAM_POST', title: 'Короткий допис', revisionId: 'telegram-1', number: 1, reviewCounter: 0, contentMode: 'CREATIVE', ready: true, reasons: [] },
        { format: 'LINKEDIN_CAROUSEL_SCRIPT', title: 'Сценарій каруселі LinkedIn', revisionId: 'script-1', number: 1, reviewCounter: 0, contentMode: 'CREATIVE', ready: true, reasons: [] },
      ],
    });
    violations.push(`Unknown API: ${request.method()} ${path}`);
    return json({ error: 'UNMOCKED_API_REQUEST' }, 599);
  });
  return { violations, pageErrors, articleSaves, workspaceActions };
}
