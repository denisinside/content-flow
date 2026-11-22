import { expect, type Page } from '@playwright/test';
import { installM63Fixture, projectId, topic } from './m63-editorial.js';

const base = `/api/v1/projects/${projectId}`;
const requestId = 'a0ad3c38-10bc-4d06-8f89-7c24d6448994';
const outlineId = 'fbcce323-69d8-4c08-b3b0-636bdddb20c7';
const sourceEvidenceSetId = 'a93c4674-b653-4992-a3e0-910f6a3487d3';
const passageId = '36646e4f-e76a-4f2f-8318-7bd8fb692ba9';

export async function installSourceOutlineFixture(page: Page, mode: 'succeed' | 'cancel' | 'fail' | 'irrelevant' | 'unconfigured' = 'succeed', outdated = false) {
  const baseFixture = await installM63Fixture(page, false, false, true);
  const violations: string[] = [];
  const prepareBodies: unknown[] = [];
  const calls: string[] = [];
  let pollCount = 0;
  const candidate = { id: outlineId, number: 1, briefRevisionId: 'brief-1', origin: 'AI', status: 'PROPOSED',
    sourceEvidenceSetId, sourceEvidenceSealed: true, content: { title: 'План на основі джерел', sections: [
      { title: 'Щоденний досвід', purpose: 'Почати з досвіду мешканців, описаного у звіті.', claimRevisionIds: [], sourcePassageIds: [passageId] },
    ] } };
  const json = (route: import('@playwright/test').Route, body: unknown, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
  const editorial = () => ({ brief: { revision: 1, currentRevision: { id: 'brief-1', number: 1, contentMode: 'FACTUAL', topic,
    audience: 'Мешканці міста', centralMessage: 'Пояснити щоденний досвід поїздок.', category: '', tone: '', targetLength: 600,
    cta: '', exclusions: [], notes: '', requiredClaimRevisionIds: [], workspaceStyleRevision: 3 }, history: [] },
  outline: { revision: pollCount >= 2 && mode === 'succeed' ? 1 : 0,
    currentRevision: outdated ? { ...candidate, id: 'previous-plan', briefRevisionId: 'previous-brief', status: 'APPROVED' } : null,
    currentApprovedRevisionId: outdated ? 'previous-plan' : null,
    revisions: pollCount >= 2 && mode === 'succeed' ? [candidate] : [] },
  style: { revision: 3, tone: '', brandbook: '', settings: {} }, articleSelected: true,
  });

  await page.route(`**${base}/editorial`, async route => {
    if (route.request().method() !== 'GET') return route.fallback();
    return json(route, editorial());
  });
  await page.route(`**${base}/outline/source-prepare`, async route => {
    if (route.request().method() !== 'POST') return route.fallback();
    calls.push('prepare');
    const body = route.request().postDataJSON() as { commandKey: string };
    expect(body.commandKey).toMatch(/^[0-9a-f-]{36}$/iu);
    prepareBodies.push(body);
    if (mode === 'unconfigured') return json(route, { message: 'NOT_CONFIGURED' }, 503);
    return json(route, { request: { id: requestId, stage: 'INDEXING', errorCategory: null, revision: 1 } }, 202);
  });
  await page.route(`**${base}/source-writing/${requestId}`, async route => {
    if (route.request().method() !== 'GET') return route.fallback();
    pollCount++;
    calls.push('poll');
    if (mode === 'fail') return json(route, { request: { id: requestId, stage: 'FAILED', errorCategory: 'SEARCH_FAILED', revision: pollCount + 1 } });
    if (mode === 'irrelevant') return json(route, { request: { id: requestId, stage: 'FAILED', errorCategory: 'NO_RELEVANT_SOURCE_EVIDENCE', revision: pollCount + 1 } });
    if (mode === 'cancel') return json(route, { request: { id: requestId, stage: 'INDEXING', errorCategory: null, revision: pollCount + 1 } });
    if (pollCount === 1) return json(route, { request: { id: requestId, stage: 'SEARCHING', errorCategory: null, revision: 2 } });
    return json(route, { request: { id: requestId, stage: 'SUCCEEDED', errorCategory: null,
      resultRefs: { outlineRevisionId: outlineId, sourceEvidenceSetId }, revision: 3 } });
  });
  await page.route(`**${base}/source-writing/${requestId}/cancel`, async route => {
    if (route.request().method() !== 'POST') return route.fallback();
    calls.push('cancel');
    return json(route, { request: { id: requestId, stage: 'CANCELLED', errorCategory: 'CANCELLED', revision: 2 } });
  });
  await page.route(`**${base}/outline/generate`, async route => {
    if (route.request().method() === 'POST') violations.push('Legacy factual outline generation was called');
    return route.fallback();
  });
  return { ...baseFixture, violations, prepareBodies, calls };
}

