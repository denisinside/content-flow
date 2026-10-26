import { expect, type Page } from '@playwright/test';
import { installM63Fixture, projectId, topic } from './m63-editorial.js';

const base = `/api/v1/projects/${projectId}`;
const jobId = '4ac483bc-8d2e-45b7-91a3-8abc8c2f3f40';

export async function installBriefProposalFixture(page: Page, mode: 'ready' | 'stale' | 'needs-human' | 'unconfigured' | 'pending' = 'ready') {
  const baseFixture = await installM63Fixture(page, false, false, true);
  const proposals: unknown[] = [];
  const briefSaves: unknown[] = [];
  let proposalReads = 0;
  let savedBrief: Record<string, unknown> | null = null;
  const emptyEditorial = () => ({ brief: savedBrief ? { revision: 1, currentRevision: savedBrief, history: [savedBrief] } : null,
    outline: { revision: 0, currentRevision: null, currentApprovedRevisionId: null, revisions: [] },
    style: { revision: 3, tone: 'Спокійний', brandbook: '', settings: {} }, articleSelected: true });
  const proposal = {
    schemaVersion: 'brief-proposal-output-v1', requestId: '6c998e65-ecee-4a34-9d8e-fb88e9bbbcd4',
    requestHash: 'a'.repeat(64), releaseId: 'brief-proposal-2026-10-24.1', configDigest: '7e3ef0e41259725272df074366d5756fbea890e98895c20ca60ca9ce9d49544f', status: 'ready',
    brief: { topic, audience: 'Мешканці, які щодня їздять містом',
      centralMessage: 'Пояснити щоденний досвід поїздок на прикладі учасників дослідження.', category: 'Міське життя',
      tone: 'Зрозуміло й точно', targetLength: 600, cta: 'Поділіться своїм досвідом.', exclusions: ['Уникаємо неперевірених обіцянок'],
      notes: 'Почніть із короткої сцени ранкової поїздки.' }, assumptions: ['Достатньо одного основного матеріалу.'],
  };
  if (mode === 'unconfigured') await page.route(`**${base}/editorial`, async route => {
    if (route.request().method() === 'GET') return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(emptyEditorial()) });
    return route.fallback();
  });
  await page.route(`**${base}/brief/proposals/config`, async route => {
    if (route.request().method() !== 'GET') return route.fallback();
    if (mode === 'unconfigured') return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ configured: false }) });
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ configured: true }) });
  });
  await page.route(`**${base}/brief/proposals`, async route => {
    if (route.request().method() !== 'POST') return route.fallback();
    const body = route.request().postDataJSON() as Record<string, unknown>;
    expect(body.commandKey).toMatch(/^[0-9a-f-]{36}$/iu);
    proposals.push(body);
    if (mode === 'unconfigured') return route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ message: 'Workflow unavailable' }) });
    return route.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify({ job: {
      id: jobId, operation: 'BRIEF_PROPOSAL', status: 'QUEUED', retryAllowed: false, progressStage: 'QUEUED',
    } }) });
  });
  await page.route(`**${base}/brief/proposals/${jobId}`, async route => {
    if (route.request().method() !== 'GET') return route.fallback();
    proposalReads++;
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({
      job: { id: jobId, operation: 'BRIEF_PROPOSAL', status: mode === 'pending' ? 'QUEUED' : 'SUCCEEDED',
        retryAllowed: false, progressStage: mode === 'pending' ? 'QUEUED' : 'COMPLETE' },
      proposal: mode === 'pending' ? null : mode === 'needs-human' ? { ...proposal, status: 'needs_human', brief: null } : proposal,
      stale: mode === 'stale', sources: [{ snapshotId: 'snapshot-1', label: 'Звіт про щоденні поїздки', sampled: false,
        sourceBytes: 200, excerptBytes: 200 }],
    }) });
  });
  await page.route(`**${base}/brief`, async route => {
    if (route.request().method() !== 'POST') return route.fallback();
    const body = route.request().postDataJSON() as Record<string, unknown>;
    briefSaves.push(body);
    if (mode === 'unconfigured') {
      savedBrief = { ...body, id: 'brief-manual-1', number: 1, workspaceStyleRevision: 3, requiredClaimRevisionIds: [] };
      return route.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify(emptyEditorial()) });
    }
    return route.fallback();
  });
  return { ...baseFixture, proposals, briefSaves, get proposalReads() { return proposalReads; }, jobId, proposal };
}
