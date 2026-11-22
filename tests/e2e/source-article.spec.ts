import { expect,test } from '@playwright/test';
import { installM63Fixture,projectId } from './fixtures/m63-editorial.js';

const passageId = '19191919-1919-4919-8919-191919191919',packetId = '29292929-2929-4929-8929-292929292929';
const snapshotId = '39393939-3939-4939-8939-393939393939',materialId = '49494949-4949-4949-8949-494949494949';
const quote = 'Збережене джерело підтверджує атомарність 😀.';
test('a partially reviewed article remains available after reload without replacing the draft', async ({ page }) => {
  await installM63Fixture(page);
  const base = `/api/v1/projects/${projectId}`;
  await page.route(`**${base}/article`, route => route.fulfill({ json: {
    article: null, articleSelected: true, mappingIssues: [], staleReasons: [], hasUnmapped: false,
    editorial: { brief: { currentRevision: { contentMode: 'FACTUAL' } }, outline: { currentApprovedRevisionId: packetId } },
  } }));
  await page.route(`**${base}/article/source-prepare`, route => route.fulfill({ json: {
    request: { id: 'partial-run', stage: 'GENERATING', errorCategory: null },
  } }));
  await page.route(`**${base}/source-writing/partial-run`, route => route.fulfill({ json: {
    request: { id: 'partial-run', stage: 'FAILED', errorCategory: 'PARTIAL_ARTICLE', partialArticle: {
      missingSections: ['Обмеження'], reviewedSectionCount: 1, content: { title: 'Тестова стаття', document: { type: 'doc', content: [
        { type: 'paragraph', content: [{ type: 'text', text: 'Перевірений текст.' }] },
        { type: 'paragraph', content: [{ type: 'text', text: 'Цей розділ потрібно дописати й перевірити.' }] },
      ] } },
    } },
  } }));
  await page.goto(`/projects/${projectId}/article`);
  await page.getByRole('button', { name: 'Запропонувати статтю', exact: true }).click();
  await page.getByText('Переглянути частковий результат', { exact: true }).click();
  await expect(page.getByText('Перевірений текст.', { exact: true })).toBeVisible();
  await expect(page.getByRole('textbox', { name: 'Текст статті' })).toBeEmpty();
  await page.reload();
  await page.getByText('Переглянути частковий результат', { exact: true }).click();
  await expect(page.getByText('Цей розділ потрібно дописати й перевірити.')).toBeVisible();
  await expect(page.getByRole('textbox', { name: 'Текст статті' })).toBeEmpty();
});

for (const staleOnOpen of [true, false]) {
  test(`an outdated factual outline gives a path back to the plan (known on open: ${staleOnOpen})`, async ({ page }) => {
    await installM63Fixture(page);
    const api = `/api/v1/projects/${projectId}/article`;
    const draft = 'Моя збережена чернетка.';
    let starts = 0;
    let planBrief = staleOnOpen ? 'brief-previous' : 'brief-current';
    await page.route(`**${api}`, route => route.fulfill({ json: {
      article: { id: 'article', revision: 1, versions: [], draft: { contentMode: 'FACTUAL',
        content: { title: 'Стаття', document: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: draft }] }] } } } },
      articleSelected: true, mappingIssues: [], staleReasons: [], hasUnmapped: false,
      editorial: { brief: { currentRevision: { id: 'brief-current', contentMode: 'FACTUAL' } },
        outline: { currentApprovedRevisionId: 'plan', currentRevision: { id: 'plan', briefRevisionId: planBrief } } },
    } }));
    await page.route(`**${api}/source-prepare`, route => {
      starts++;
      return route.fulfill({ status: 409, json: { message: 'Approve the current factual outline before preparing a source article' } });
    });
    await page.goto(`/projects/${projectId}/article`);
    const generate = page.getByRole('button', { name: 'Запропонувати статтю', exact: true });
    if (!staleOnOpen) await generate.click();
    await expect(page.getByText(staleOnOpen ? 'Бриф змінився. Оновіть і схваліть план для поточного брифу.' : 'Схваліть поточний план статті, щоб створити пропозицію.', { exact: false }).first()).toBeVisible();
    await expect(generate).toBeDisabled();
    await expect(page.getByRole('textbox', { name: 'Текст статті' })).toHaveText(draft);
    await expect(page.getByRole('button', { name: 'Зберегти мій текст як нову чернетку' })).toHaveCount(0);
    await page.getByRole('button', { name: 'Відкрити бриф і план' }).click();
    await expect(page).toHaveURL(`/projects/${projectId}/brief`);
    planBrief = 'brief-current';
    await page.getByRole('link', { name: 'Стаття', exact: true }).click();
    await expect(generate).toBeEnabled();
    await expect(page.getByRole('textbox', { name: 'Текст статті' })).toHaveText(draft);
    expect(starts).toBe(staleOnOpen ? 0 : 1);
  });
}

test('an article revision conflict during autosave keeps local text and offers recovery', async ({ page }) => {
  await installM63Fixture(page);
  await page.route(`**/api/v1/projects/${projectId}/article/draft`, route => route.fulfill({
    status: 409, json: { message: 'Article changed; retain local text and reload before saving' },
  }));
  await page.goto(`/projects/${projectId}/article`);
  const editor = page.getByRole('textbox', { name: 'Текст статті' });
  await editor.fill('Незбережені правки до статті.');
  await expect(page.getByRole('button', { name: 'Зберегти мій текст як нову чернетку' })).toBeVisible();
  await expect(editor).toHaveText('Незбережені правки до статті.');
});

test('an empty factual article can retry a rejected section and preview the next candidate', async ({ page }) => {
  await installM63Fixture(page);
  const base = `/api/v1/projects/${projectId}`;
  const proposalText = 'Атомарність захищає дані.';
  const content = { title: 'Атомарність транзакцій', document: { type: 'doc', content: [{ type: 'paragraph', content: [
    { type: 'text', text: proposalText, marks: [{ type: 'source_evidence', attrs: { passageId, packetId, quote } }] },
  ] }, { type: 'paragraph', content: [{ type: 'text', text: 'Інший фрагмент із того самого джерела.', marks: [{ type: 'source_evidence', attrs: { passageId, packetId, quote } }] }] }] } };
  const version = { id: 'source-candidate', number: 1, origin: 'AI', status: 'PROPOSED', contentMode: 'FACTUAL', sourceArticleRevision: 0, content };
  let starts = 0, stage = 'SEARCHING', articleReads = 0;
  await page.route(`**${base}/article**`, async route => {
    const path = new URL(route.request().url()).pathname;
    if (path === `${base}/article` && route.request().method() === 'GET') {
      articleReads++;
      return route.fulfill({ json: { article: stage === 'SUCCEEDED' ? { id: 'source-article', revision: 0, draft: null, versions: [version] } : null,
        articleSelected: true, eligibleEvidence: [], mappingIssues: [], staleReasons: [], hasUnmapped: false,
        editorial: { brief: { currentRevision: { contentMode: 'FACTUAL' } }, outline: { currentApprovedRevisionId: packetId } } } });
    }
    if (path === `${base}/article/${version.id}/apply`) {
      expect(route.request().postDataJSON()).toEqual({ expectedRevision: 0 });
      return route.fulfill({ json: { article: { id: 'source-article', revision: 1, draft: { content, contentMode: 'FACTUAL', baseVersionId: version.id }, versions: [version] },
        articleSelected: true, eligibleEvidence: [], eligibleSourcePassages: [], mappingIssues: [], staleReasons: [], hasUnmapped: false,
        editorial: { brief: { currentRevision: { contentMode: 'FACTUAL' } }, outline: { currentApprovedRevisionId: packetId } } } });
    }
    if (path === `${base}/article/source-prepare`) {
      expect(route.request().postDataJSON()).toMatchObject({ expectedRevision: 0 });
      starts++;
      stage = 'SEARCHING';
      return route.fulfill({ json: { request: { id: `source-run-${starts}`, stage, errorCategory: null } } });
    }
    if (path === `${base}/article/${version.id}/source-passages`) {
      return route.fulfill({ json: { passages: [{ passageId, packetId, snapshotId, materialId, startOffset: 0, endOffset: quote.length,
        quote, materialTitle: 'Вимоги до сховища' }] } });
    }
    return route.fallback();
  });
  await page.route(`**${base}/source-writing/*`, route => {
    stage = starts === 1 ? 'FAILED' : 'SUCCEEDED';
    return route.fulfill({ json: { request: { id: `source-run-${starts}`, stage,
      errorCategory: stage === 'FAILED' ? 'SECTION_DRAFT_INVALID' : null } } });
  });
  await page.route(`**${base}/materials/${materialId}/snapshots/${snapshotId}`, route =>
    route.fulfill({ json: { snapshot: { normalizedText: quote } } }));
  await page.clock.install();
  await page.goto(`/projects/${projectId}/article`);
  const generate = page.getByRole('button', { name: 'Запропонувати статтю', exact: true });
  await generate.click();
  await expect(page.getByText('Один із розділів не пройшов перевірку тексту й посилань. Попередній текст збережено.')).toBeVisible();
  await generate.click();
  await expect(page.getByText('Пропозиція статті готова до перегляду.')).toBeVisible();
  await page.getByRole('button', { name: 'Переглянути пропозицію AI · Не застосовано' }).click();
  await expect(page.getByText(proposalText, { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Застосувати до чернетки' })).toBeEnabled();
  await expect(page.locator('.article-writing .tiptap')).toHaveText('');
  await page.getByRole('button', { name: 'Поточна чернетка' }).click();
  await expect(page.getByText(proposalText, { exact: true })).toBeHidden();
  await page.getByRole('button', { name: 'Пропозиція', exact: true }).click();
  await page.getByText(proposalText, { exact: true }).click();
  const firstCitation = page.getByText(proposalText, { exact: true });
  const secondCitation = page.getByText('Інший фрагмент із того самого джерела.', { exact: true });
  await expect(firstCitation).toHaveAttribute('aria-pressed', 'true');
  await expect(secondCitation).toHaveAttribute('aria-pressed', 'false');
  await secondCitation.click();
  await expect(firstCitation).toHaveAttribute('aria-pressed', 'false');
  await expect(secondCitation).toHaveAttribute('aria-pressed', 'true');
  const sourcePanel = page.locator('.proposal-evidence');
  await expect(sourcePanel.getByRole('heading', { name: 'Джерело цього тексту' })).toBeVisible();
  await expect(page.getByText(proposalText, { exact: true })).toBeVisible();
  await expect(sourcePanel.getByRole('button', { name: /Прив’язати/ })).toHaveCount(0);
  await sourcePanel.getByText('Точне місце в джерелі', { exact: true }).click();
  await expect(sourcePanel.locator('mark')).toHaveText(quote);
  await page.screenshot({ path: test.info().outputPath('proposal-source-desktop.png') });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(sourcePanel).toBeVisible();
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: test.info().outputPath('proposal-source-mobile.png') });
  await sourcePanel.getByRole('button', { name: 'Закрити джерело' }).click();
  await expect(secondCitation).toHaveAttribute('aria-pressed', 'false');
  await expect(page.getByText(proposalText, { exact: true })).toBeVisible();
  await expect(page.locator('.article-writing .tiptap')).toHaveText('');
  await page.getByRole('button', { name: 'Застосувати до чернетки' }).click();
  await expect(page.getByRole('textbox', { name: 'Текст статті' })).toContainText(proposalText);
  await expect(page.getByText('Пропозиція AI · Не застосовано')).toBeHidden();
  const readsAfterApply = articleReads;
  const statusPoll = page.waitForResponse(response => new URL(response.url()).pathname === `${base}/jobs`);
  await page.clock.fastForward(61_000);
  await statusPoll;
  expect(articleReads).toBe(readsAfterApply);
  expect(starts).toBe(2);
});

test('article source marks survive editing and open their exact saved source',async ({ page }) => {
  await installM63Fixture(page);
  const base = `/api/v1/projects/${projectId}`;
  const content = { title: 'Атомарність транзакцій',document: { type: 'doc',content: [{ type: 'paragraph',content: [
    { type: 'text',text: 'Атомарність захищає дані 😀.',marks: [{ type: 'source_evidence',attrs: { passageId,packetId,quote } }] },
    { type: 'text',text: ' Авторський коментар.' }] }] } };
  const article = { id: 'article-source',revision: 1,draft: { content,contentMode: 'FACTUAL',origin: 'AI',sourceEvidenceSetId: packetId,baseVersionId: null },currentApprovedVersionId: null,versions: [] };
  const state = () => ({ article,articleSelected: true,eligibleEvidence: [],eligibleSourcePassages: [{ passageId,packetId,snapshotId,materialId,
    fragmentId: snapshotId,startOffset: 0,endOffset: quote.length,quote,materialTitle: 'Вимоги до сховища' }],mappingIssues: [],staleReasons: [],hasUnmapped: true,
    editorial: { brief: { currentRevision: { contentMode: 'FACTUAL' } },outline: { currentApprovedRevisionId: packetId,currentRevision: { sourceEvidenceSetId: packetId } } } });
  const saved: unknown[] = [];
  await page.route(`**${base}/article**`,async route => {
    const path = new URL(route.request().url()).pathname;
    if (path === `${base}/article` && route.request().method() === 'GET') return route.fulfill({ json: state() });
    if (path === `${base}/article/draft`) {
      const body = route.request().postDataJSON(); saved.push(body); article.draft.content = body.content; article.revision++;
      return route.fulfill({ json: state() });
    }
    return route.fallback();
  });
  await page.route(`**${base}/materials/${materialId}/snapshots/${snapshotId}`,route => route.fulfill({ json: { snapshot: { normalizedText: quote+'\n\nДодатковий контекст.' } } }));
  await page.goto(`/projects/${projectId}/article`);
  const source = page.locator('.tiptap [data-passage-id]');
  await expect(source).toHaveText('Атомарність захищає дані 😀.');
  await source.click();
  await expect(page.getByRole('region',{ name: 'Уривок джерела' })).toBeVisible();
  await page.getByText('Точне місце в джерелі',{ exact: true }).click();
  await expect(page.locator('mark')).toHaveText(quote);
  await page.getByRole('button',{ name: 'Закрити контекст' }).click();
  const editor = page.getByRole('textbox',{ name: 'Текст статті' });
  await editor.click(); await page.keyboard.press('Control+End'); await page.keyboard.type(' Додана думка.');
  await expect.poll(() => saved.length).toBeGreaterThan(0);
  const last = saved.at(-1) as { content: typeof content };
  const nodes = last.content.document.content.flatMap(node => node.content);
  expect(nodes.find(node => node.marks?.some(mark => mark.type === 'source_evidence'))?.marks).toEqual([{ type: 'source_evidence',attrs: { passageId,packetId,quote } }]);
  expect(nodes.map(node => node.text).join('')).toContain('Додана думка.');
  await page.screenshot({ path: test.info().outputPath('article-source-1280.png'),fullPage: true });
  await page.setViewportSize({ width: 390,height: 844 });
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: test.info().outputPath('article-source-390.png'),fullPage: true });
});
test('returning to Article shows the manuscript while refreshing and loads review on demand', async ({ page }) => {
  await installM63Fixture(page);
  let editorReads = 0;
  let reviewReads = 0;
  let releaseRefresh!: () => void;
  const refresh = new Promise<void>(resolve => { releaseRefresh = resolve; });
  await page.route(`**/api/v1/projects/${projectId}/article`, async route => {
    if (route.request().headers()['x-contextflow-view'] === 'editor') {
      if (++editorReads === 2) await refresh;
    } else reviewReads++;
    await route.fallback();
  });
  await page.goto(`/projects/${projectId}/article`);
  const editor = page.getByRole('textbox', { name: 'Текст статті' });
  await expect(editor).toContainText('Ранкова поїздка починається на зупинці.');
  expect(reviewReads).toBe(0);
  await page.getByRole('link', { name: 'Бриф', exact: true }).click();
  await expect(editor).toHaveCount(0);
  await page.getByRole('link', { name: 'Стаття', exact: true }).click();
  await expect.poll(() => editorReads).toBe(2);
  try {
    await expect(editor).toContainText('Ранкова поїздка починається на зупинці.');
    expect(reviewReads).toBe(0);
  } finally { releaseRefresh(); }
  await page.getByRole('button', { name: 'Історія версій', exact: true }).click();
  await expect.poll(() => reviewReads).toBe(1);
});
