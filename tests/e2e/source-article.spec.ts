import { expect,test } from '@playwright/test';
import { installM63Fixture,projectId } from './fixtures/m63-editorial.js';

const passageId = '19191919-1919-4919-8919-191919191919',packetId = '29292929-2929-4929-8929-292929292929';
const snapshotId = '39393939-3939-4939-8939-393939393939',materialId = '49494949-4949-4949-8949-494949494949';
const quote = 'Збережене джерело підтверджує атомарність 😀.';
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
