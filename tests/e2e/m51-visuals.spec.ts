import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { test, expect, type Page, type Route } from '@playwright/test';

const projectId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const workspaceId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const base = `/api/v1/projects/${projectId}`;
const formats = ['LINKEDIN_COVER', 'INSTAGRAM_CAROUSEL', 'INSTAGRAM_STORIES'] as const;
type Format = typeof formats[number];
type Composition = {
  schemaVersion: 'visual-v1'; rendererVersion: string; width: 1080; height: 1080 | 1350 | 1920;
  frames: Array<{ id: string; sourceFrameId: string | null; purpose: string; templateId: string; background: string; layers: Array<Record<string, unknown>> }>;
};
type VisualState = {
  format: Format; formatSelected: boolean;
  style: { revision: number; revisionId: string; defaults: { background: string; text: string; accent: string; font: string; logo: null } };
  parent: { kind: 'ADAPTATION' | 'SCRIPT'; id: string; sha256: string; reviewCounter: number; content: unknown; staleReasons: string[]; blockingReasons: string[]; eligible: boolean };
  composition: { id: string; revision: number; draft: { counter: number; content: Composition; sha256: string; parentKind: string; parentRevisionId: string; parentRevisionHash: string; parentReviewCounter: number } | null; revisions: Array<{ id: string; number: number; content: Composition; sha256: string; parentKind: string; parentRevisionId: string; parentRevisionHash: string; parentReviewCounter: number; reviewCounter: number; approvedAt: null; withdrawnAt: null; eligible: boolean; staleReasons: string[]; blockingReasons: string[]; hasUnmapped: boolean; previews: [] }> } | null;
};

const json = (route: Route, value: unknown, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(value) });
const frameId = (index: number) => `00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`;
const layerId = (index: number) => `10000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`;

function makeComposition(format: Format): Composition {
  const height = format === 'INSTAGRAM_STORIES' ? 1920 : 1080;
  const count = format === 'LINKEDIN_COVER' ? 1 : 3;
  return {
    schemaVersion: 'visual-v1', rendererVersion: 'konva-10.7.1-visual-v1', width: 1080, height,
    frames: Array.from({ length: count }, (_, index) => ({
      id: frameId(index), sourceFrameId: frameId(index), purpose: ['Заголовок', 'Контекст', 'Висновок'][index]!,
      templateId: 'editorial', background: '#ffffff', layers: [
        { id: layerId(index), type: 'text', x: 84, y: 110, width: 912, height: height - 220,
          text: ['Міський сервіс стає доступнішим', 'Команда оновила важливу послугу', 'Зміни вже доступні мешканцям'][index]!,
          font: 'onest', fontSize: 56, fontWeight: '600', color: '#20262b', align: 'left', lineHeight: 1.2, mappings: [] },
      ],
    })),
  };
}

function makeState(format: Format, initialized = false): VisualState {
  const composition = makeComposition(format);
  return {
    format, formatSelected: true,
    style: { revision: 1, revisionId: '20000000-0000-4000-8000-000000000001', defaults: { background: '#ffffff', text: '#20262b', accent: '#b86f45', font: 'onest', logo: null } },
    parent: { kind: format === 'LINKEDIN_COVER' ? 'ADAPTATION' : 'SCRIPT', id: '30000000-0000-4000-8000-000000000001', sha256: 'synthetic-approved-parent', reviewCounter: 0, content: {}, staleReasons: [], blockingReasons: [], eligible: true },
    composition: initialized ? { id: '40000000-0000-4000-8000-000000000001', revision: 1,
      draft: { counter: 0, content: composition, sha256: 'synthetic-draft', parentKind: format === 'LINKEDIN_COVER' ? 'ADAPTATION' : 'SCRIPT', parentRevisionId: '30000000-0000-4000-8000-000000000001', parentRevisionHash: 'synthetic-approved-parent', parentReviewCounter: 0 }, revisions: [] } : null,
  };
}

async function fixture(page: Page) {
  const pageErrors: string[] = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  const states = new Map<Format, VisualState>(formats.map(format => [format, makeState(format)]));
  const commands: Array<{ path: string; body: Record<string, unknown> }> = [];
  let conflictNextDraft = false;
  let sessionExpiredOnVisualGet = false;
  let backgroundEnabled=false,backgroundCalls=0,backgroundUnknown=false;
  let loseApplyResponse=false;
  const backgroundApplications=new Set<string>();
  let sessionIsExpired = false;
  const png = Buffer.from(await page.evaluate(async () => {
    const canvas = document.createElement('canvas'); canvas.width = 2; canvas.height = 2;
    const context = canvas.getContext('2d')!; context.fillStyle = '#3280dc'; context.fillRect(0, 0, 2, 2);
    const blob = await new Promise<Blob>(resolve => canvas.toBlob(image => resolve(image!), 'image/png'));
    return [...new Uint8Array(await blob.arrayBuffer())];
  }));
  const imageHash = createHash('sha256').update(png).digest('hex');
  await page.route('**/api/**', async route => {
    const request = route.request(), url = new URL(request.url()), path = url.pathname;
    if (path === '/api/auth/session') return sessionIsExpired ? json(route, { authenticated: false }, 401) : json(route, { authenticated: true, csrfToken: 'csrf', user: { id: 'editor', email: 'test@example.test', displayName: 'Редактор' } });
    if (path === '/api/auth/preferences') return json(route, { preferences: { idleTimeoutMinutes: 60 } });
    if (path === '/api/auth/external-processing') return json(route, { notice: { version: '1', text: 'Тестова згода' }, accepted: true });
    if (path === '/api/auth/activity') return json(route, { authenticated: true });
    if (path === '/api/v1/workspaces') return json(route, { workspaces: [{ id: workspaceId, ownerId: 'editor', name: 'Редакція', archivedAt: null, trashedAt: null, purgeAfter: null, lifecycleRevision: 1, members: [] }], nextCursor: null });
    if (path === `/api/v1/workspaces/${workspaceId}`) return json(route, { workspace: { id: workspaceId, ownerId: 'editor', name: 'Редакція', archivedAt: null, trashedAt: null, purgeAfter: null, lifecycleRevision: 1, members: [] } });
    if (path === '/api/v1/projects') return json(route, { projects: [], nextCursor: null });
    if (path === base) return json(route, { project: { id: projectId, workspaceId, topic: 'Міський сервіс', formats: ['LINKEDIN_COVER', 'INSTAGRAM_CAROUSEL', 'INSTAGRAM_STORIES'], revision: 1, createdAt: '2026-10-12T08:00:00Z', updatedAt: '2026-10-12T08:00:00Z', archivedAt: null } });
    if (path === `${base}/article`) return json(route, { article: null });
    if (path === `${base}/visuals` && request.method() === 'GET') {
      if (sessionExpiredOnVisualGet) { sessionExpiredOnVisualGet = false; sessionIsExpired = true; return json(route, { message: 'expired' }, 401); }
      return json(route, structuredClone(states.get(url.searchParams.get('format') as Format)!));
    }
    if (request.method() === 'POST') expect(request.headers()['x-csrf-token']).toBe('csrf');
    if (path === `${base}/visuals/initialize`) {
      const format = url.searchParams.get('format') as Format;
      commands.push({ path, body: request.postDataJSON() as Record<string, unknown> });
      const next = makeState(format, true); states.set(format, next); return json(route, structuredClone(next));
    }
    if (path === `${base}/visuals/draft`) {
      const format = url.searchParams.get('format') as Format, body = request.postDataJSON() as Record<string, unknown>;
      commands.push({ path, body });
      if (conflictNextDraft) { conflictNextDraft = false; return json(route, { message: 'conflict' }, 409); }
      const next = states.get(format)!;
      next.composition!.draft!.content = structuredClone(body['composition'] as Composition);
      next.composition!.draft!.counter++;
      next.composition!.revision++;
      return json(route, structuredClone(next));
    }
    if (path === `${base}/visuals/backgrounds`) return json(route,{configured:backgroundEnabled,jobs:backgroundCalls?[{id:'70000000-0000-4000-8000-000000000001',frameId:frameId(0),status:backgroundUnknown?'FAILED':'SUCCEEDED',providerOutcome:backgroundUnknown?'UNKNOWN':'KNOWN_SUCCEEDED',errorCategory:backgroundUnknown?'UNKNOWN_OUTCOME':null,retryAllowed:false}]:[],candidates:backgroundCalls&&!backgroundUnknown?[{id:'80000000-0000-4000-8000-000000000001',frameId:frameId(0),asset:{id:'60000000-0000-4000-8000-000000000001',sha256:imageHash},report:{reason:'Clean background'},applyBlockers:[],appliedAt:null}]:[]});
    if (path === `${base}/visuals/backgrounds/generate`) {backgroundCalls++;commands.push({path,body:request.postDataJSON() as Record<string,unknown>});return json(route,{jobId:'70000000-0000-4000-8000-000000000001',status:'QUEUED',replayed:false});}
    if (path.endsWith('/visuals/backgrounds/candidates/80000000-0000-4000-8000-000000000001/apply')) {
      const next=states.get(url.searchParams.get('format') as Format)!,body=request.postDataJSON() as Record<string,unknown>;commands.push({path,body});
      if (backgroundApplications.has(String(body['commandKey']))) return json(route,{state:structuredClone(next),applied:false,replayed:true});
      backgroundApplications.add(String(body['commandKey']));
      next.composition!.draft!.content.frames[0]!.layers.unshift({id:'90000000-0000-4000-8000-000000000001',type:'image',role:'background',x:0,y:0,width:1080,height:next.composition!.draft!.content.height,fit:'cover',resource:{type:'project',id:'60000000-0000-4000-8000-000000000001',sha256:imageHash}});
      next.composition!.revision++;next.composition!.draft!.counter++;
      if(loseApplyResponse){loseApplyResponse=false;return route.abort('failed');}
      return json(route,{state:structuredClone(next),applied:true,replayed:false});
    }
    if (path === `${base}/visuals/checkpoint`) {
      const format = url.searchParams.get('format') as Format, next = states.get(format)!;
      commands.push({ path, body: request.postDataJSON() as Record<string, unknown> });
      next.composition!.revision++;
      const draft = next.composition!.draft!;
      next.composition!.revisions.unshift({ id: `50000000-0000-4000-8000-${String(next.composition!.revision).padStart(12, '0')}`, number: next.composition!.revision,
        content: structuredClone(draft.content), sha256: draft.sha256, parentKind: draft.parentKind, parentRevisionId: draft.parentRevisionId,
        parentRevisionHash: draft.parentRevisionHash, parentReviewCounter: draft.parentReviewCounter,
        reviewCounter: 0, approvedAt: null, withdrawnAt: null, eligible: true, staleReasons: [], blockingReasons: [], hasUnmapped: true, previews: [] });
      next.composition!.draft!.counter++;
      return json(route, structuredClone(next));
    }
    if (path === `${base}/visuals/assets` && request.method() === 'POST') {
      commands.push({ path, body: request.postDataJSON() as Record<string, unknown> });
      return json(route, { ref: { type: 'project', id: '60000000-0000-4000-8000-000000000001', sha256: imageHash } }, 201);
    }
    if (path === `${base}/visuals/assets/60000000-0000-4000-8000-000000000001`) return route.fulfill({ status: 200, contentType: 'image/png', body: png });
    return json(route, {});
  });
  return { states, commands, pageErrors, loseApplyResponse:()=>{loseApplyResponse=true;},enableBackground:(unknown=false)=>{backgroundEnabled=true;backgroundUnknown=unknown;},setConflict: () => { conflictNextDraft = true; }, expireSession: () => { sessionExpiredOnVisualGet = true; } };
}

test('M5.2 generated background applies explicitly while text remains separately editable',async({page})=>{
  const data=await fixture(page);data.enableBackground();
  await openVisuals(page,'LINKEDIN_COVER');await page.getByRole('button',{name:'Створити візуал'}).click();
  await page.getByText('AI-фон для кадру',{exact:true}).click();await page.getByLabel('Опишіть фон без тексту').fill('Спокійний синій фон');
  await page.getByRole('button',{name:'Згенерувати фон',exact:true}).click();
  await expect(page.getByAltText('Кандидат фону вибраного кадру')).toBeVisible();
  await page.getByRole('textbox',{name:'Текст',exact:true}).fill('Ручний текст після генерації');
  await expect.poll(()=>data.commands.filter(row=>row.path.endsWith('/draft')).length).toBeGreaterThan(0);
  await page.getByRole('checkbox',{name:'Переглянув фон:'}).check();data.loseApplyResponse();await page.getByRole('button',{name:'Застосувати фон',exact:true}).click();
  await expect(page.getByText('Failed to fetch',{exact:false})).toBeVisible();await page.getByRole('button',{name:'Застосувати фон',exact:true}).click();
  await expect(page.getByRole('textbox',{name:'Текст',exact:true})).toHaveValue('Ручний текст після генерації');
  expect(data.commands.filter(row=>row.path.endsWith('/backgrounds/generate'))).toHaveLength(1);
  const appliedCommands=data.commands.filter(row=>row.path.includes('/candidates/')&&row.path.endsWith('/apply'));expect(appliedCommands).toHaveLength(2);expect(appliedCommands[0]!.body['commandKey']).toBe(appliedCommands[1]!.body['commandKey']);
  mkdirSync('.local-checks/m52/browser',{recursive:true});for(const width of [1280,768,390]){await page.setViewportSize({width,height:1000});await expect.poll(()=>page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);await page.screenshot({path:`.local-checks/m52/browser/background-${width}.png`,fullPage:true});}
});
test('M5.2 unknown outcome preserves text and offers no automatic retry',async({page})=>{
  const data=await fixture(page);data.enableBackground(true);await openVisuals(page,'LINKEDIN_COVER');await page.getByRole('button',{name:'Створити візуал'}).click();await page.getByText('AI-фон для кадру',{exact:true}).click();await page.getByLabel('Опишіть фон без тексту').fill('Природний фон');await page.getByRole('button',{name:'Згенерувати фон',exact:true}).click();await expect(page.getByText('Результат невідомий.',{exact:false})).toBeVisible();await expect(page.getByRole('button',{name:'Повторити безпечно'})).toHaveCount(0);await expect(page.getByRole('textbox',{name:'Текст',exact:true})).toHaveValue('Міський сервіс стає доступнішим');expect(data.commands.filter(row=>row.path.endsWith('/backgrounds/generate'))).toHaveLength(1);
});

async function openCoordinates(page: Page) {
  const details = page.locator('.visual-coordinate-details');
  if (!(await details.evaluate(node => (node as HTMLDetailsElement).open))) {
    await details.locator('summary').click();
  }
}
async function addLayer(page: Page, type: 'Текст' | 'Форма') {
  await page.locator('.visual-add-layer summary').click();
  await page.locator('.visual-add-layer-menu').getByRole('button', { name: type }).click();
}
async function openVisuals(page: Page, format: Format) {
  await page.goto(`/projects/${projectId}/visuals?format=${format}`);
  await expect(page.getByRole('heading', { name: 'Візуали' })).toBeVisible();
}

async function measureRenderedCanvas(page: Page) {
  return page.locator('.visual-stage canvas').first().evaluate(canvas => {
    const rect = canvas.getBoundingClientRect();
    const wrapper = document.querySelector('.visual-stage-wrap')!.getBoundingClientRect();
    const element = canvas as HTMLCanvasElement;
    const pixels = element.getContext('2d')!.getImageData(0, 0, element.width, element.height).data;
    const left = Math.floor(element.width * .04), right = Math.ceil(element.width * .7);
    const top = Math.floor(element.height * .04), bottom = Math.ceil(element.height * .45);
    let count = 0, minX = right, maxX = left, minY = bottom, maxY = top;
    for (let y = top; y < bottom; y++) for (let x = left; x < right; x++) {
      const offset = (y * element.width + x) * 4;
      if (pixels[offset]! < 225 || pixels[offset + 1]! < 225 || pixels[offset + 2]! < 225) {
        count++; minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y);
      }
    }
    return {
      fits: rect.width <= wrapper.width + 1 && rect.height <= wrapper.height + 1,
      hasTextNearOrigin: count > 30 && minX / element.width < .25 && minY / element.height < .35,
      canvas: `${element.width}×${element.height}`,
      rendered: `${Math.round(rect.width)}×${Math.round(rect.height)}`,
      wrapper: `${Math.round(wrapper.width)}×${Math.round(wrapper.height)}`,
      darkPixelCount: count,
      textPixelOrigin: `${minX},${minY}`,
      textPixelBounds: `${maxX - minX + 1}×${maxY - minY + 1}`,
    };
  });
}

test('direct approved inputs create cover, carousel and stories without an Article, with all three sizes', async ({ page }) => {
  const ctx = await fixture(page);
  for (const format of formats) {
    await openVisuals(page, format);
    await expect(page.getByRole('heading', { name: /Почніть із перевіреного матеріалу/ })).toBeVisible();
    await page.getByRole('button', { name: 'Створити візуал' }).click();
    await expect(page.locator('.visual-stage canvas')).toBeVisible();
    await expect(page.getByRole('status').filter({ hasText: 'Візуальну чернетку створено' })).toBeVisible();
    await expect.poll(() => ctx.commands.filter(command => command.path.endsWith('/initialize')).length).toBe(formats.indexOf(format) + 1);
    expect(ctx.commands.at(-1)?.body['parentRevisionId']).toBe('30000000-0000-4000-8000-000000000001');
    await expect(page.locator('.stage-caption')).toContainText(format === 'INSTAGRAM_STORIES' ? '1080 × 1920' : '1080 × 1080');
    const expectedFrames = format === 'LINKEDIN_COVER' ? 1 : 3;
    await expect(page.getByRole('navigation', { name: 'Кадри' }).getByRole('button')).toHaveCount(expectedFrames);
    if (format === 'LINKEDIN_COVER') {
      mkdirSync('.local-checks/m51/browser', { recursive: true });
      await page.keyboard.press('Tab');
      await expect(page.locator(':focus-visible')).toHaveCount(1);
      for (const width of [1280, 768, 390]) {
        await page.setViewportSize({ width, height: 1000 });
        await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
        await expect.poll(async () => {
          const canvas = await measureRenderedCanvas(page);
          return canvas.fits && canvas.hasTextNearOrigin;
        }).toBe(true);
        expect(await measureRenderedCanvas(page)).toMatchObject({ fits: true, hasTextNearOrigin: true });
        await page.screenshot({ path: `.local-checks/m51/browser/editor-${width}.png`, fullPage: true });
      }
    }
    const size = page.getByLabel('Розмір', { exact: true });
    for (const height of [1080, 1350, 1920] as const) {
      await size.selectOption(String(height));
      await expect(page.locator('.stage-caption')).toContainText(`1080 × ${height}`);
      expect(await page.locator('.visual-stage canvas').count()).toBe(1);
    }
    await expect(page.locator('.visual-stage canvas')).toBeVisible();
    await expect(page.getByRole('heading', { name: /Стаття/ })).toHaveCount(0);
  }
});

test('text, template, typography and position persist through checkpoint and reload; viewport stays usable', async ({ page }) => {
  const ctx = await fixture(page);
  await openVisuals(page, 'INSTAGRAM_CAROUSEL');
  await page.getByRole('button', { name: 'Створити візуал' }).click();
  const text = page.getByRole('textbox', { name: 'Текст', exact: true });
  await text.fill('Український заголовок з новим формулюванням');
  await page.getByLabel('Макет').selectOption('statement');
  await page.getByLabel('Шрифт', { exact: true }).selectOption('source-serif');
  await page.getByLabel('Розмір шрифту').fill('64');
  await page.getByLabel('Колір тексту').fill('#315b70');
  await openCoordinates(page);
  const finalDraftResponse = page.waitForResponse(response => response.url().includes('/visuals/draft')
    && response.request().method() === 'POST'
    && (response.request().postDataJSON() as { composition: Composition }).composition.frames[0]?.layers[0]?.['x'] === 120);
  await page.getByLabel('X', { exact: true }).fill('120');
  expect((await finalDraftResponse).ok()).toBe(true);
  await expect.poll(() => ctx.states.get('INSTAGRAM_CAROUSEL')!.composition!.draft!.content.frames[0]!.layers[0]!['text']).toBe('Український заголовок з новим формулюванням');
  await expect(page.getByRole('status').filter({ hasText: /^Чернетку збережено\.$/ })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Зберегти версію' })).toBeEnabled();
  const checkpointResponse = page.waitForResponse(response => response.url().includes('/visuals/checkpoint')
    && response.request().method() === 'POST', { timeout: 10_000 });
  await page.getByRole('button', { name: 'Зберегти версію' }).click();
  expect((await checkpointResponse).ok()).toBe(true);
  await expect(page.getByRole('status').filter({ hasText: 'Контрольну версію композиції збережено.' })).toBeVisible();
  await page.reload();
  await expect(text).toHaveValue('Український заголовок з новим формулюванням');
  await expect(page.getByLabel('Макет')).toHaveValue('statement');
  await expect(page.getByLabel('Шрифт', { exact: true })).toHaveValue('source-serif');
  await expect(page.getByLabel('Розмір шрифту')).toHaveValue('64');
  await openCoordinates(page);
  await expect(page.getByLabel('X', { exact: true })).toHaveValue('120');
  expect(ctx.pageErrors).toEqual([]);
});

test('a private uploaded image is added as an independent editable layer and renders locally', async ({ page }) => {
  const ctx = await fixture(page);
  await openVisuals(page, 'LINKEDIN_COVER');
  await page.getByRole('button', { name: 'Створити візуал' }).click();
  const png = Buffer.from(await page.evaluate(async () => {
    const canvas = document.createElement('canvas'); canvas.width = 2; canvas.height = 2;
    canvas.getContext('2d')!.fillRect(0, 0, 2, 2);
    const blob = await new Promise<Blob>(resolve => canvas.toBlob(image => resolve(image!), 'image/png'));
    return [...new Uint8Array(await blob.arrayBuffer())];
  }));
  await page.getByLabel('Додати власне фото').setInputFiles({ name: 'synthetic.png', mimeType: 'image/png', buffer: png });
  await expect(page.getByText('Фото додано до поточного кадру.')).toBeVisible();
  await expect(page.locator('.visual-stage canvas')).toBeVisible();
  const upload = ctx.commands.find(command => command.path.endsWith('/assets'));
  expect(upload?.body['filename']).toBe('synthetic.png');
  await expect(page.getByRole('button', { name: /Зображення/ })).toBeVisible();
});

test('409 keeps unsaved Ukrainian text; stale parent blocks creation and 401 returns to sign-in', async ({ page }) => {
  const ctx = await fixture(page);
  await openVisuals(page, 'LINKEDIN_COVER');
  await page.getByRole('button', { name: 'Створити візуал' }).click();
  ctx.setConflict();
  const localText = 'Мої локальні правки залишаються тут';
  const text = page.getByRole('textbox', { name: 'Текст', exact: true });
  await text.fill(localText);
  await expect.poll(() => ctx.commands.some(command => command.path.endsWith('/visuals/draft'))).toBe(true);
  await expect(page.locator('.visual-message.visual-error')).toContainText('Ваші правки залишилися у цьому вікні.');
  await expect(text).toHaveValue(localText);
  expect(ctx.states.get('LINKEDIN_COVER')!.composition!.draft!.content.frames[0]!.layers[0]!['text']).not.toBe(localText);

  const stale = ctx.states.get('LINKEDIN_COVER')!;
  stale.composition = null; stale.parent.eligible = false; stale.parent.staleReasons = ['SCRIPT_STALE'];
  await page.reload();
  await expect(page.getByText('Спочатку погодьте актуальний текст або сценарій у вкладці «Канали».')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Створити візуал' })).toHaveCount(0);
  ctx.expireSession();
  await page.reload();
  await expect(page.getByRole('status').filter({ hasText: 'Сесію завершено. Увійдіть, щоб продовжити роботу.' })).toBeVisible();
});

test('visual editor drag, undo and redo preserve coordinates and template history', async ({ page }) => {
  const ctx = await fixture(page);
  await openVisuals(page, 'LINKEDIN_COVER');
  await page.getByRole('button', { name: 'Створити візуал' }).click();
  await expect(page.locator('.visual-stage canvas')).toBeVisible();
  await openCoordinates(page);
  const x = page.getByLabel('X', { exact: true });
  await expect(x).toHaveValue('84');
  await page.locator('.visual-stage-wrap').scrollIntoViewIfNeeded();
  const bounds = await page.locator('.visual-stage').boundingBox();
  if (!bounds) throw new Error('Visual canvas missing');
  const scale = bounds.width / 1080;
  const startX = bounds.x + (84 + 70) * scale;
  const startY = bounds.y + (110 + 38) * scale;
  await page.mouse.move(startX, startY);
  await page.mouse.down();
  await page.mouse.move(startX + 95 * scale, startY + 25 * scale, { steps: 8 });
  await page.mouse.up();
  await expect.poll(async () => Number(await x.inputValue())).toBeGreaterThan(84);
  const draggedX = Number(await x.inputValue());
  await page.getByRole('button', { name: /Скасувати/ }).click();
  await expect(x).toHaveValue('84');
  await page.getByRole('button', { name: /Повторити/ }).click();
  await expect(x).toHaveValue(String(draggedX));
  await page.getByLabel('Макет').selectOption('split');
  await expect(page.getByLabel('Макет')).toHaveValue('split');
  await page.getByRole('button', { name: /Скасувати/ }).click();
  await expect(page.getByLabel('Макет')).toHaveValue('editorial');
  await page.getByRole('button', { name: /Повторити/ }).click();
  await expect(page.getByLabel('Макет')).toHaveValue('split');
  await page.getByLabel('Макет').selectOption('quote');
  await expect(page.getByLabel('Макет')).toHaveValue('quote');
  await page.getByLabel('Макет').selectOption('minimal');
  await expect(page.getByLabel('Макет')).toHaveValue('minimal');
  expect(ctx.pageErrors).toEqual([]);
});

test('visual gallery, multiple styled texts, grouping and layer controls', async ({ page }) => {
  const ctx = await fixture(page);
  await openVisuals(page, 'LINKEDIN_COVER');
  await page.getByRole('button', { name: 'Створити візуал' }).click();
  await expect(page.locator('.visual-template-card')).toHaveCount(7);
  await page.getByRole('button', { name: 'Шаблон: Цитата' }).click();
  await expect(page.getByLabel('Макет', { exact: true })).toHaveValue('quote');
  await addLayer(page, 'Текст');
  await expect(page.locator('.visual-layer-row')).toHaveCount(3);
  await page.getByLabel('Насиченість').selectOption('700');
  await page.getByLabel('Міжрядковий інтервал').fill('1.5');
  await expect(page.getByLabel('Міжрядковий інтервал')).toHaveValue('1.5');
  await page.getByRole('button', { name: 'Дублювати шар' }).click();
  await expect(page.locator('.visual-layer-row')).toHaveCount(4);
  await page.locator('.visual-layer-row').nth(0).locator('input[type=checkbox]').check();
  await expect(page.getByRole('button', { name: 'Групувати шари', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: 'Групувати шари', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Розгрупувати шари' })).toBeEnabled();
  await page.getByRole('button', { name: 'Приховати шар' }).click();
  await expect(page.getByRole('button', { name: 'Показати шар' })).toBeVisible();
  await page.getByRole('button', { name: 'Показати шар' }).click();
  await page.getByRole('button', { name: 'Заблокувати шар' }).click();
  await expect(page.getByRole('button', { name: 'Розблокувати шар' })).toBeVisible();
  await page.getByRole('button', { name: 'Розблокувати шар' }).click();
  await page.getByRole('button', { name: 'Розгрупувати шари' }).click();
  await expect.poll(() => ctx.states.get('LINKEDIN_COVER')!.composition!.draft!.content.frames[0]!.layers.length).toBe(4);
  expect(ctx.pageErrors).toEqual([]);
});

test('zoom displays original canvas pixels with scroll without changing composition size', async ({ page }) => {
  const ctx = await fixture(page);
  await openVisuals(page, 'LINKEDIN_COVER');
  await page.getByRole('button', { name: 'Створити візуал' }).click();
  const canvas = page.locator('.visual-stage canvas');
  const fitWidth = (await canvas.boundingBox())!.width;
  await page.getByLabel('Масштаб').selectOption('100');
  await expect.poll(async () => Math.round((await canvas.boundingBox())!.width)).toBe(1080);
  await expect.poll(() => page.locator('.visual-stage-wrap').evaluate(node => node.scrollWidth > node.clientWidth)).toBe(true);
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(ctx.states.get('LINKEDIN_COVER')!.composition!.draft!.content.width).toBe(1080);
  await page.getByRole('button', { name: 'Умістити' }).click();
  await expect.poll(async () => (await canvas.boundingBox())!.width).toBeLessThan(1080);
  expect(fitWidth).toBeLessThan(1080);
});

test('carousel frame duplication creates independent frame and retains editability', async ({ page }) => {
  const ctx = await fixture(page);
  await openVisuals(page, 'INSTAGRAM_CAROUSEL');
  await page.getByRole('button', { name: 'Створити візуал' }).click();
  await expect(page.getByRole('navigation', { name: 'Кадри' }).getByRole('button')).toHaveCount(3);
  await page.getByRole('button', { name: 'Дублювати кадр' }).click();
  await expect(page.getByRole('navigation', { name: 'Кадри' }).getByRole('button')).toHaveCount(4);
  await expect.poll(() => ctx.states.get('INSTAGRAM_CAROUSEL')!.composition!.draft!.content.frames.length).toBe(4);
  const frames = ctx.states.get('INSTAGRAM_CAROUSEL')!.composition!.draft!.content.frames;
  expect(new Set(frames.map(row => row.id)).size).toBe(4);
  expect(frames[1]!.sourceFrameId).toBe(frames[0]!.sourceFrameId);
  expect(frames[1]!.layers[0]!.id).not.toBe(frames[0]!.layers[0]!.id);
  expect(ctx.pageErrors).toEqual([]);
});

test('canvas snaps a shape to the centre and a grouped pair moves together', async ({ page }) => {
  const ctx = await fixture(page);
  await openVisuals(page, 'LINKEDIN_COVER');
  await page.getByRole('button', { name: 'Створити візуал' }).click();
  await addLayer(page, 'Форма');
  const wrap = page.locator('.visual-stage-wrap');
  await wrap.scrollIntoViewIfNeeded();
  const bounds = (await page.locator('.visual-stage').boundingBox())!;
  const scale = bounds.width / 1080;
  const drag = async (x: number, y: number, dx: number, dy = 0) => {
    await page.mouse.move(bounds.x + x * scale, bounds.y + y * scale);
    await page.mouse.down();
    await page.mouse.move(bounds.x + (x + dx) * scale, bounds.y + (y + dy) * scale, { steps: 12 });
    await page.mouse.up();
  };
  await drag(124, 104, 313);
  await openCoordinates(page);
  await expect(page.getByLabel('X', { exact: true })).toHaveValue('400');
  await addLayer(page, 'Форма');
  await page.locator('.visual-layer-row').nth(1).locator('input[type=checkbox]').check();
  await page.getByRole('button', { name: 'Групувати шари', exact: true }).click();
  await page.getByLabel('Прив’язка').uncheck();
  await drag(124, 104, 80);
  await expect.poll(() => {
    const xs = ctx.states.get('LINKEDIN_COVER')!.composition!.draft!.content.frames[0]!.layers
      .filter(row => row.type === 'rect').map(row => Number(row.x));
    return xs[0]! - 400 === xs[1]! - 84 && xs[0]! >= 478 && xs[0]! <= 482;
  }).toBe(true);
  expect(ctx.pageErrors).toEqual([]);
});

test('minimal visual controls keep icon actions accessible and hide unavailable frame duplication', async ({ page }) => {
  const ctx = await fixture(page);
  await openVisuals(page, 'LINKEDIN_COVER');
  await page.getByRole('button', { name: 'Створити візуал' }).click();
  await expect(page.getByRole('button', { name: 'Дублювати кадр' })).toHaveCount(0);
  await expect(page.locator('.visual-edit-toolbar')).toHaveCount(0);
  await expect(page.locator('.visual-template-gallery summary')).toHaveText('Галерея макетів');
  await expect(page.locator('.visual-coordinate-details')).not.toHaveAttribute('open', '');
  await expect(page.getByRole('button', { name: 'Скасувати' })).toContainText('');
  await expect(page.getByRole('button', { name: 'Скасувати' }).locator('svg')).toHaveCount(1);
  await expect(page.getByRole('button', { name: 'Повторити' }).locator('svg')).toHaveCount(1);
  await expect(page.getByRole('button', { name: 'Дублювати шар' }).locator('svg')).toHaveCount(1);
  await expect(page.getByRole('button', { name: 'Видалити шар' }).locator('svg')).toHaveCount(1);
  await expect(page.getByRole('button', { name: 'Опустити шар' }).locator('svg')).toHaveCount(1);
  await expect(page.locator('#visual-zoom')).not.toContainText('Вмістити');
  await page.locator('.visual-add-layer summary').click();
  await expect(page.locator('.visual-add-layer-menu')).toBeVisible();
  await page.locator('.visual-add-layer-menu').getByRole('button', { name: 'Форма' }).click();
  await expect(page.locator('.visual-layer-row')).toHaveCount(2);
  await expect(page.locator('.visual-add-layer')).not.toHaveAttribute('open', '');
  await openCoordinates(page);
  await expect(page.getByLabel('X', { exact: true })).toBeVisible();
  await page.locator('.visual-coordinate-details summary').click();
  await expect(page.locator('.visual-coordinate-details')).not.toHaveAttribute('open', '');
  expect(ctx.pageErrors).toEqual([]);
});
