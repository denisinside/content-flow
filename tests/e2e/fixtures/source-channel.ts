import { expect, type Page, type Route } from '@playwright/test';
import { installM63Fixture, projectId } from './m63-editorial.js';

const base = `/api/v1/projects/${projectId}`;
export const sourceSetId = 'a93c4674-b653-4992-a3e0-910f6a3487d3';
export const passageId = '36646e4f-e76a-4f2f-8318-7bd8fb692ba9';
export const quote = 'Дослідження охопило три райони міста.';
const sourceText = `Контекст перед уривком. ${quote} Далі описано методику опитування.`;
const startOffset = sourceText.indexOf(quote);
const requestId = 'a0ad3c38-10bc-4d06-8f89-7c24d6448994';

const json = (route: Route, value: unknown, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(value) });

export async function installSourceChannelFixture(page: Page, options: { invalidQuote?: boolean; linkedCitation?: boolean; pending?: boolean } = {}) {
  const baseFixture = await installM63Fixture(page, false, false, true);
  const calls: { path: string; body?: Record<string, unknown> }[] = [];
  let polls = 0;
  let complete = options.pending !== true;
  const passage = { passageId, packetId: '9f9f0f69-9d80-4da4-88bb-8ba6ed3fcf28', snapshotId: 'snapshot-1', quote,
    materialId: 'source-1', materialTitle: 'Звіт про мобільність', startOffset, endOffset: startOffset + quote.length };
  let revision = 1;
  let savedContent: unknown = { text: options.linkedCitation ? quote : 'Мій допис має залишитися.',mappings: [],sourceMappings: options.linkedCitation ? [{ startOffset: 0,endOffset: quote.length,quote,passageId,packetId: passage.packetId }] : [] };
  let savedInputMode = 'ARTICLE_DERIVED',savedIncludeLink = false;
  const state = () => ({ format: 'TELEGRAM_POST',formatSelected: true,telegramSelected: true,
    adaptation: { id: 'adaptation-1',revision,draft: { content: savedContent,inputMode: savedInputMode,contentMode: 'FACTUAL',includeLink: savedIncludeLink,sourceEvidenceSetId: sourceSetId,baseRevisionId: null },currentApprovedRevisionId: null,revisions: [] },
    brief: { id: 'brief-1',revision: 1,currentRevision: { id: 'brief-1',contentMode: 'FACTUAL' },history: [] },style: { revision: 3 },
    prerequisites: { blockingReasons: ['MISSING_BASIS'],missingBasis: true,unverified: false },
    approvedArticle: { id: 'article-version-1',number: 1,sourceEvidenceSetId: sourceSetId,contentMode: 'FACTUAL',title: 'Погоджена стаття',inspection: { eligible: true,staleReasons: [],blockingReasons: [] } },
    eligibleEvidence: [],eligibleSourcePassages: [passage],staleReasons: [],mappingIssues: [],hasUnmapped: true,blockingReasons: [] });
  await page.route(`**${base}/telegram**`, async route => {
    const request = route.request(); const path = new URL(request.url()).pathname;
    if (path === `${base}/telegram` && request.method() === 'GET') {
      return json(route,state());
    }
    if (path === `${base}/telegram/draft` && request.method() === 'POST') {
      const body = request.postDataJSON() as Record<string,unknown>; calls.push({ path,body });
      savedContent = body.content; savedInputMode = String(body.inputMode); savedIncludeLink = body.includeLink === true; revision++;
      return json(route,state());
    }
    if (path === `${base}/telegram/source-prepare` && request.method() === 'POST') {
      const body = request.postDataJSON() as Record<string, unknown>;
      calls.push({ path, body });
      expect(request.headers()['x-csrf-token']).toBe('fixture-csrf');
      return json(route, { request: { id: requestId, stage: 'INDEXING', errorCategory: null } }, 202);
    }
    return route.fallback();
  });
  await page.route(`**${base}/source-writing/${requestId}`, async route => {
    if (route.request().method() !== 'GET') return route.fallback();
    polls++; calls.push({ path: 'poll' });
    return json(route, { request: { id: requestId, stage: !complete || polls === 1 ? 'SEARCHING' : 'SUCCEEDED', errorCategory: null } });
  });
  await page.route(`**${base}/materials/source-1/snapshots/snapshot-1`, async route => {
    if (route.request().method() !== 'GET') return route.fallback();
    calls.push({ path: 'snapshot' });
    return json(route, { snapshot: { normalizedText: options.invalidQuote ? sourceText.replace(quote, 'Підмінений фрагмент.') : sourceText } });
  });
  await page.goto(`/projects/${projectId}/telegram`);
  await expect(page.getByRole('heading', { name: 'Допис у Telegram' })).toBeVisible();
  return { ...baseFixture, calls, passage,completeRequest: () => { complete = true; } };
}
