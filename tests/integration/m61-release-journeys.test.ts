import { createHash, randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  ArticleService, DependencyHealthService, DurableJobService, EditorialService, ExportService, EXTERNAL_PROCESSING_NOTICE,
  FactualBasisService, PrivateAssetStore, ScriptService, TelegramService, VisualRenderer, VisualService,
  articleWorkflowRelease, createArticleJobHandler, createExportJobHandler, createTelegramJobHandler, importedFragments,
  loadRuntimeConfig, privateStorageConfig, telegramWorkflowRelease,
} from '@contextflow/backend';
import type { JobContext, JobHandler, TelegramProviderInput } from '@contextflow/backend';
import { compositionSchema } from '../../packages/visuals/src/index.js';

const formats = ['LINKEDIN_TEXT', 'LINKEDIN_COVER', 'LINKEDIN_CAROUSEL', 'INSTAGRAM_COVER', 'INSTAGRAM_CAROUSEL', 'INSTAGRAM_STORIES', 'TELEGRAM_POST'] as const;
type Format = typeof formats[number];
const hash = (text: string) => createHash('sha256').update(text).digest('hex');
const claimText = 'Міський сервіс запрацює 15 травня.';

function zipLocalEntries(bytes: Buffer) {
  const entries: Array<{ name: string; bytes: Buffer }> = []; let offset = 0;
  while (offset + 30 <= bytes.length && bytes.readUInt32LE(offset) === 0x04034b50) {
    const size = bytes.readUInt32LE(offset + 18), nameLength = bytes.readUInt16LE(offset + 26), extraLength = bytes.readUInt16LE(offset + 28);
    const name = bytes.subarray(offset + 30, offset + 30 + nameLength).toString('utf8'), start = offset + 30 + nameLength + extraLength;
    entries.push({ name, bytes: bytes.subarray(start, start + size) }); offset = start + size;
  }
  return entries;
}

describe('M6.1 integrated release journeys', () => {
  const config = loadRuntimeConfig(), health = new DependencyHealthService(config);
  const jobs = new DurableJobService(health.prisma, { noticeVersion: EXTERNAL_PROCESSING_NOTICE.version, retryBaseMs: 0 });
  const facts = new FactualBasisService(health.prisma, jobs), editorial = new EditorialService(health.prisma, jobs, facts);
  const articles = new ArticleService(health.prisma, jobs, facts), channels = new TelegramService(health.prisma, jobs, facts, articles);
  const scripts = new ScriptService(health.prisma, channels), renderer = new VisualRenderer();
  const assets = new PrivateAssetStore(privateStorageConfig({ NODE_ENV: 'test' }));
  const visuals = new VisualService(health.prisma, channels, scripts, renderer, assets);
  const exports = new ExportService(health.prisma, jobs, articles, channels, assets, visuals);
  const migration = new Pool({ connectionString: config.directDatabaseUrl, ssl: false, max: 2 });
  const owner = randomUUID(), otherMember = randomUUID(), outsider = randomUUID(), workspace = randomUUID();
  const factualMixed = randomUUID(), factualDirect = randomUUID(), creativeArticle = randomUUID(), suppliedMixed = randomUUID();
  const projectIds = [factualMixed, factualDirect, creativeArticle, suppliedMixed];
  const articleEnv = { NODE_ENV: 'test', DIFY_API_BASE_URL: 'https://dify.example.test/v1', DIFY_ARTICLE_GENERATION_PUBLISHED_WORKFLOW_ID: randomUUID(),
    DIFY_ARTICLE_GENERATION_CONFIG_SHA256: 'ffb4847aa44ed06600e209ce7cee171fafd965d062ebe3003ec4c74c7d2d36ab', DIFY_ARTICLE_GENERATION_API_KEY: 'synthetic-only' };
  const telegramEnv = { NODE_ENV: 'test', DIFY_API_BASE_URL: 'https://dify.example.test/v1', DIFY_ADAPTATION_WORKFLOW_ID: randomUUID(),
    DIFY_ADAPTATION_CONFIG_SHA256: 'cdbf1b551e583edccf21865081ffedef6f018a12231f44dec538f7a2f1b81603', DIFY_ADAPTATION_API_KEY: 'synthetic-only' };
  let providerCalls = 0;
  let joinedJourneyCompleted = false, historyJourneyCompleted = false, joinedJourneyStartedAt = 0;
  let factualPackageId = '', directPackageId = '', factualDerivedCarouselRevisionId = '';
  let claimRevisionId = '', sourceSnapshotId = '', directClaimRevisionId = '';
  function journeyPhase(name: string) { console.info(`[m61-stage] ${name} +${Date.now() - joinedJourneyStartedAt}ms`); }
  const articleHandler = createArticleJobHandler({ prisma: health.prisma, editorial: articles, factualBasis: facts, env: articleEnv,
    provider: { async execute(_settings, _jobId, input, _signal, beforeSubmit, recordRun) {
      providerCalls++; await beforeSubmit(); const workflowRunId = randomUUID(); await recordRun(workflowRunId);
      const evidence = input.claims[0]?.evidence[0];
      if (input.contentMode === 'FACTUAL' && !evidence) throw new Error('Synthetic factual fixture needs the approved evidence');
      const text = input.contentMode === 'FACTUAL' ? evidence!.quote : 'Авторський погляд на міські зміни.';
      return { output: { schemaVersion: 'article-v1', content: { title: 'Міський сервіс: що зміниться', document: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text,
        ...(evidence ? { marks: [{ type: 'evidence', attrs: { claimRevisionId: input.claims[0]!.claimRevisionId, evidenceId: evidence.evidenceId, quote: evidence.quote } }] } : {}) }] }] } } }, workflowRunId, model: 'synthetic' };
    }, async resume() { throw new Error('Synthetic article provider must not resume'); } } });
  const telegramHandler = createTelegramJobHandler({ prisma: health.prisma, telegram: channels, scripts, factualBasis: facts, articles, env: telegramEnv,
    provider: { async execute(_settings, _jobId, input: TelegramProviderInput, _signal, beforeSubmit, recordRun) {
      providerCalls++; await beforeSubmit(); const workflowRunId = randomUUID(); await recordRun(workflowRunId);
      const claim = input.claims[0], text = claim ? claim.evidence[0]!.quote : 'Авторський каналовий текст.';
      const content = { text, mappings: claim ? [{ startOffset: 0, endOffset: text.length, quote: text, claimRevisionId: claim.claimRevisionId,
        evidenceId: claim.evidence[0]!.evidenceId }] : [], ...(input.format.includes('COVER') ? { cover: { text: 'Що змінюється', instruction: 'Стримана редакційна обкладинка' } } : {}) };
      const script = ['LINKEDIN_CAROUSEL', 'INSTAGRAM_CAROUSEL', 'INSTAGRAM_STORIES'].includes(input.format)
        ? { frames: [{ id: randomUUID(), purpose: 'Головна думка', text: 'Пояснення зміни', visualHint: 'Чіткий заголовок', transition: 'Далі', mappings: [] },
          { id: randomUUID(), purpose: 'Наступний крок', text: 'Перевірте оновлення', visualHint: 'Спокійний фінал', transition: 'Завершення', mappings: [] }] } : undefined;
      return { output: { schemaVersion: 'adaptation-v1', format: input.format, content, ...(script ? { script } : {}) }, workflowRunId, model: 'synthetic' };
    }, async resume() { throw new Error('Synthetic adaptation provider must not resume'); } } });
  const exportHandler = createExportJobHandler(exports);

  function jobContext(job: NonNullable<Awaited<ReturnType<typeof jobs.claim>>>['job'], attempt: NonNullable<Awaited<ReturnType<typeof jobs.claim>>>['attempt']): JobContext {
    return { job, attempt, signal: new AbortController().signal, recordSubmissionIntent: async () => {}, recordProviderRun: async () => {}, setProgress: async () => {} };
  }
  async function execute(handler: JobHandler, jobId: string) {
    const claimed = await jobs.claim(jobId, 1, `m61-${randomUUID()}`);
    if (!claimed) throw new Error(`M6.1 fixture job was not claimable: ${jobId}`);
    const context = jobContext(claimed.job, claimed.attempt), stage = await handler.execute(context);
    await jobs.succeed(claimed.job, claimed.attempt, handler, stage); await handler.completed?.(context, stage);
    return health.prisma.job.findUniqueOrThrow({ where: { id: jobId } });
  }
  async function approveGeneratedChannel(project: string, format: Format, inputMode: 'DIRECT' | 'ARTICLE_DERIVED', contentMode: 'FACTUAL' | 'CREATIVE') {
    const before = await channels.get(owner, project, format);
    const commandKey = randomUUID();
    const command = { format, expectedRevision: before.adaptation?.revision ?? 0, commandKey, inputMode, contentMode } as const;
    const frozen = await channels.freezeTelegram(owner, project, command, telegramWorkflowRelease(telegramEnv));
    expect(await channels.freezeTelegram(owner, project, command, telegramWorkflowRelease(telegramEnv))).toEqual(frozen);
    await execute(telegramHandler, frozen.id);
    let state = await channels.get(owner, project, format);
    const candidate = state.adaptation!.revisions.find(row => row.jobId === frozen.id)!;
    state = await channels.review(owner, project, candidate.id, 'apply', { format, expectedRevision: state.adaptation!.revision });
    state = await channels.review(owner, project, candidate.id, 'approve', { format, expectedRevision: state.adaptation!.revision,
      expectedReviewCounter: candidate.reviewCounter, acknowledgeUnmapped: true });
    return { revisionId: candidate.id, reviewCounter: candidate.reviewCounter, state };
  }
  async function approveVisual(project: string, format: 'LINKEDIN_COVER' | 'LINKEDIN_CAROUSEL' | 'INSTAGRAM_COVER' | 'INSTAGRAM_CAROUSEL' | 'INSTAGRAM_STORIES') {
    journeyPhase(`visual.${format}.start`);
    const parent = await visuals.get(owner, project, format);
    let state = await visuals.initialize(owner, project, format, { parentRevisionId: parent.parent!.id });
    state = await visuals.checkpoint(owner, project, format, { expectedRevision: state.composition!.revision, expectedDraftCounter: state.composition!.draft!.counter });
    const revision = state.composition!.revisions[0]!, frames = compositionSchema.parse(revision.content).frames;
    for (const frame of frames) await visuals.preview(owner, project, format, revision.id, frame.id);
    journeyPhase(`visual.${format}.previews-complete`);
    state = await visuals.get(owner, project, format);
    state = await visuals.review(owner, project, format, revision.id, 'approve', { expectedRevision: state.composition!.revision,
      expectedReviewCounter: revision.reviewCounter, acknowledgeUnmapped: true });
    journeyPhase(`visual.${format}.approved`);
    return { format: `${format}_VISUAL` as const, revisionId: revision.id, reviewCounter: revision.reviewCounter + 1 };
  }
  async function exportAndRead(project: string, items: Array<{ format: string; revisionId: string; reviewCounter: number }>, format: 'ZIP' | 'PNG' | 'PDF' = 'ZIP', key = randomUUID()) {
    const ready = await exports.readiness(owner, project);
    const frozen = await exports.freeze(owner, project, { expectedProjectRevision: ready.projectRevision, commandKey: key, format, items } as unknown as Parameters<typeof exports.freeze>[2]);
    await execute(exportHandler, frozen.jobId);
    return { frozen, file: await exports.download(owner, project, frozen.exportId) };
  }
  function brief(contentMode: 'FACTUAL' | 'CREATIVE', requiredClaimRevisionIds: string[] = []) {
    return { expectedRevision: 0, contentMode, topic: 'Оновлення міського сервісу', audience: 'Мешканці', centralMessage: 'Пояснити зміну', category: 'Місто',
      targetLength: 120, cta: '', exclusions: [], notes: '', requiredClaimRevisionIds };
  }

  beforeAll(async () => {
    await mkdir('.local-checks/m61/journeys', { recursive: true });
    vi.stubEnv('DIFY_API_BASE_URL', articleEnv.DIFY_API_BASE_URL!);
    vi.stubEnv('DIFY_ARTICLE_GENERATION_PUBLISHED_WORKFLOW_ID', articleEnv.DIFY_ARTICLE_GENERATION_PUBLISHED_WORKFLOW_ID!);
    vi.stubEnv('DIFY_ARTICLE_GENERATION_CONFIG_SHA256', articleEnv.DIFY_ARTICLE_GENERATION_CONFIG_SHA256!);
    vi.stubEnv('DIFY_ARTICLE_GENERATION_API_KEY', articleEnv.DIFY_ARTICLE_GENERATION_API_KEY!);
    vi.stubEnv('DIFY_ADAPTATION_WORKFLOW_ID', telegramEnv.DIFY_ADAPTATION_WORKFLOW_ID!);
    vi.stubEnv('DIFY_ADAPTATION_CONFIG_SHA256', telegramEnv.DIFY_ADAPTATION_CONFIG_SHA256!);
    vi.stubEnv('DIFY_ADAPTATION_API_KEY', telegramEnv.DIFY_ADAPTATION_API_KEY!);
    expect((await health.check()).status).toBe('ready');
    await health.prisma.userProfile.createMany({ data: [owner, otherMember, outsider].map(id => ({ id,
      externalProcessingNoticeVersion: EXTERNAL_PROCESSING_NOTICE.version, externalProcessingAcceptedAt: new Date() })) });
    await health.prisma.workspace.create({ data: { id: workspace, name: `M6.1 synthetic ${workspace}`, ownerId: owner,
      members: { create: [{ userId: owner }, { userId: otherMember }] }, styles: { create: { revision: 1, createdBy: owner, tone: 'Стриманий' } } } });
    await health.prisma.project.createMany({ data: [
      { id: factualMixed, workspaceId: workspace, createdBy: owner, topic: 'Factual mixed route', formats: ['ARTICLE', ...formats] },
      { id: factualDirect, workspaceId: workspace, createdBy: owner, topic: 'Factual direct route', formats: [...formats] },
      { id: creativeArticle, workspaceId: workspace, createdBy: owner, topic: 'Creative article route', formats: ['ARTICLE'] },
      { id: suppliedMixed, workspaceId: workspace, createdBy: owner, topic: 'Supplied article route', formats: ['ARTICLE', ...formats] },
    ] });
    const materialId = randomUUID(), snapshotId = randomUUID(), fragment = importedFragments(claimText)[0]!;
    await health.prisma.material.create({ data: { id: materialId, projectId: factualMixed, kind: 'TEXT', purpose: 'FACTUAL_SOURCE', label: 'Синтетичний імпорт факту', createdBy: owner } });
    await health.prisma.sourceSnapshot.create({ data: { id: snapshotId, projectId: factualMixed, materialId, sequence: 1, normalizedText: claimText,
      sha256: hash(claimText), bytes: Buffer.byteLength(claimText), origin: 'MANUAL_TEXT', createdBy: owner } });
    await health.prisma.sourceFragment.create({ data: { ...fragment, projectId: factualMixed, snapshotId } }); sourceSnapshotId = snapshotId;
    const claim = await facts.create(owner, factualMixed, { wording: claimText, evidence: [{ snapshotId, fragmentId: fragment.id, startOffset: 0, endOffset: claimText.length,
      quote: claimText, sha256: fragment.sha256, relation: 'SUPPORTS' }] });
    claimRevisionId = claim.claim.currentRevision!.id;
    await facts.review(owner, factualMixed, claim.claim.id, claimRevisionId, 'approve', { expectedRevision: claim.claim.revision });
    await facts.freezeBasis(owner, factualMixed, { claimRevisionIds: [claimRevisionId] });
    await editorial.saveBrief(owner, factualMixed, brief('FACTUAL', [claimRevisionId]));
    const state = await editorial.get(owner, factualMixed);
    const outline = await editorial.manualOutline(owner, factualMixed, { expectedRevision: 0, briefRevisionId: state.brief!.currentRevision!.id,
      content: { title: 'Погоджений план', sections: [{ title: 'Зміна', purpose: 'Пояснити оголошений строк', claimRevisionIds: [claimRevisionId] }] } });
    await editorial.reviewOutline(owner, factualMixed, outline.outline!.currentRevision!.id, 'approve', { expectedRevision: outline.outline!.revision });
    const directText = 'У тестовому місті є сім каналових форматів.';
    const directMaterial = randomUUID(), directSnapshot = randomUUID(), directFragment = importedFragments(directText)[0]!;
    await health.prisma.material.create({ data: { id: directMaterial, projectId: factualDirect, kind: 'TEXT', purpose: 'FACTUAL_SOURCE', label: 'Прямий синтетичний факт', createdBy: owner } });
    await health.prisma.sourceSnapshot.create({ data: { id: directSnapshot, projectId: factualDirect, materialId: directMaterial, sequence: 1, normalizedText: directText,
      sha256: hash(directText), bytes: Buffer.byteLength(directText), origin: 'MANUAL_TEXT', createdBy: owner } });
    await health.prisma.sourceFragment.create({ data: { ...directFragment, projectId: factualDirect, snapshotId: directSnapshot } });
    const directClaim = await facts.create(owner, factualDirect, { wording: directText, evidence: [{ snapshotId: directSnapshot, fragmentId: directFragment.id, startOffset: 0,
      endOffset: directText.length, quote: directText, sha256: directFragment.sha256, relation: 'SUPPORTS' }] });
    directClaimRevisionId = directClaim.claim.currentRevision!.id;
    await facts.review(owner, factualDirect, directClaim.claim.id, directClaimRevisionId, 'approve', { expectedRevision: directClaim.claim.revision });
    await facts.freezeBasis(owner, factualDirect, { claimRevisionIds: [directClaimRevisionId] });
    await editorial.saveBrief(owner, factualDirect, brief('FACTUAL', [directClaimRevisionId]));
    await editorial.saveBrief(owner, creativeArticle, brief('CREATIVE'));
    const creativeState = await editorial.get(owner, creativeArticle);
    const creativeOutline = await editorial.manualOutline(owner, creativeArticle, { expectedRevision: 0, briefRevisionId: creativeState.brief!.currentRevision!.id,
      content: { title: 'Авторський план', sections: [{ title: 'Погляд', purpose: 'Пояснити зміни', claimRevisionIds: [] }] } });
    await editorial.reviewOutline(owner, creativeArticle, creativeOutline.outline!.currentRevision!.id, 'approve', { expectedRevision: creativeOutline.outline!.revision });
    await editorial.saveBrief(owner, suppliedMixed, brief('CREATIVE'));
  });

  afterAll(async () => {
    try {
      const old = new Date(Date.now() - 31 * 86_400_000), purgeAfter = new Date(old.getTime() + 30 * 86_400_000);
      for (const projectId of projectIds) {
        const row = await health.prisma.project.findUnique({ where: { id: projectId } });
        if (!row) continue;
        await health.prisma.project.update({ where: { id: projectId }, data: { trashedAt: old, purgeAfter } });
        await health.prisma.$queryRaw`SELECT contextflow.purge_project_graph(${projectId}::uuid,${owner}::uuid,${row.revision})`;
      }
      const memberRows = await health.prisma.workspaceMember.findMany({ where: { workspaceId: workspace, userId: { not: owner }, leftAt: null } });
      for (const member of memberRows) await health.prisma.workspaceMember.update({ where: { workspaceId_userId: { workspaceId: workspace, userId: member.userId } }, data: { leftAt: new Date() } });
      const workspaceRow = await health.prisma.workspace.findUnique({ where: { id: workspace } });
      if (workspaceRow) {
        await health.prisma.workspace.update({ where: { id: workspace }, data: { trashedAt: old, purgeAfter } });
        await health.prisma.$queryRaw`SELECT contextflow.purge_workspace_graph(${workspace}::uuid,${owner}::uuid,${workspaceRow.lifecycleRevision})`;
      }
      const pending = await health.prisma.privateObjectDeletion.findMany({ where: { workspaceId: workspace, state: 'PENDING' } });
      for (const item of pending) {
        await assets.remove(item.bucket, item.objectKey);
        await health.prisma.privateObjectDeletion.update({ where: { id: item.id }, data: { state: 'DELETED', deletedAt: new Date() } });
      }
      const db = await migration.connect();
      try {
        await db.query('DELETE FROM contextflow."PrivateObjectDeletion" WHERE "workspaceId"=$1', [workspace]);
        await db.query('DELETE FROM contextflow."UserProfile" WHERE "id"=ANY($1::uuid[])', [[owner, otherMember, outsider]]);
      } finally { db.release(); }
    } finally {
      await renderer.onModuleDestroy(); await migration.end(); await health.onModuleDestroy(); vi.unstubAllEnvs();
    }
  });

  it('joins factual source, immutable approval, article-derived generation, all seven direct formats and selected-only delivery', async () => {
    joinedJourneyStartedAt = Date.now();
    journeyPhase('joined.start');
    const beforeCalls = providerCalls;
    const absentConsent = randomUUID();
    await health.prisma.userProfile.create({ data: { id: absentConsent } });
    await health.prisma.workspaceMember.create({ data: { workspaceId: workspace, userId: absentConsent } });
    try {
      await expect(channels.freezeTelegram(absentConsent, factualDirect, { format: 'TELEGRAM_POST', expectedRevision: 0, commandKey: randomUUID(),
        inputMode: 'DIRECT', contentMode: 'FACTUAL' }, telegramWorkflowRelease(telegramEnv))).rejects.toMatchObject({ status: 403 });
      expect(providerCalls).toBe(beforeCalls);
    } finally {
      await health.prisma.workspaceMember.delete({ where: { workspaceId_userId: { workspaceId: workspace, userId: absentConsent } } });
      await health.prisma.userProfile.delete({ where: { id: absentConsent } });
    }

    await expect(channels.get(outsider, factualMixed, 'TELEGRAM_POST')).rejects.toMatchObject({ status: 404 });
    await expect(facts.create(owner, factualDirect, { wording: claimText, evidence: [{ snapshotId: sourceSnapshotId, fragmentId: randomUUID(), startOffset: 0,
      endOffset: claimText.length, quote: claimText, sha256: hash(claimText), relation: 'SUPPORTS' }] })).rejects.toThrow();

    const callsBeforeMissingOutline = providerCalls;
    await expect(articles.freezeArticle(owner, suppliedMixed, randomUUID(), 0, articleWorkflowRelease(articleEnv))).rejects.toMatchObject({ status: 409 });
    expect(providerCalls).toBe(callsBeforeMissingOutline);
    const articleCommandKey = randomUUID();
    const articleJob = await articles.freezeArticle(owner, factualMixed, articleCommandKey, 0, articleWorkflowRelease(articleEnv));
    expect(await articles.freezeArticle(owner, factualMixed, articleCommandKey, 0, articleWorkflowRelease(articleEnv))).toEqual(articleJob);
    await execute(articleHandler, articleJob.id);
    let articleState = await articles.get(owner, factualMixed);
    const candidate = articleState.article!.versions.find(version => version.jobId === articleJob.id)!;
    expect(candidate).toMatchObject({ origin: 'AI', approvedAt: null, eligible: false });
    articleState = await articles.review(owner, factualMixed, candidate.id, 'apply', { expectedRevision: articleState.article!.revision });
    articleState = await articles.review(owner, factualMixed, candidate.id, 'approve', { expectedRevision: articleState.article!.revision, acknowledgeUnmapped: true });
    expect(articleState.article!.currentApprovedVersionId).toBe(candidate.id);
    journeyPhase('joined.article-approved');

    const articleDerived = await approveGeneratedChannel(factualMixed, 'LINKEDIN_TEXT', 'ARTICLE_DERIVED', 'FACTUAL');
    expect(articleDerived.state.adaptation!.revisions.find(row => row.id === articleDerived.revisionId)).toMatchObject({ inputMode: 'ARTICLE_DERIVED', sourceArticleVersionId: candidate.id, eligible: true });
    const derivedCarousel = await approveGeneratedChannel(factualMixed, 'LINKEDIN_CAROUSEL', 'ARTICLE_DERIVED', 'FACTUAL');
    let derivedScript = await scripts.get(owner, factualMixed, 'LINKEDIN_CAROUSEL');
    const derivedScriptCandidate = derivedScript.script!.revisions.find(row => row.jobId)!;
    factualDerivedCarouselRevisionId = derivedCarousel.revisionId;
    derivedScript = await scripts.review(owner, factualMixed, 'LINKEDIN_CAROUSEL', derivedScriptCandidate.id, 'apply', { expectedRevision: derivedScript.script!.revision });
    derivedScript = await scripts.get(owner, factualMixed, 'LINKEDIN_CAROUSEL');
    derivedScript = await scripts.review(owner, factualMixed, 'LINKEDIN_CAROUSEL', derivedScriptCandidate.id, 'approve', { expectedRevision: derivedScript.script!.revision,
      expectedReviewCounter: derivedScriptCandidate.reviewCounter, acknowledgeUnmapped: true });
    const derivedVisual = await approveVisual(factualMixed, 'LINKEDIN_CAROUSEL');
    journeyPhase('joined.article-derived-approved');
    const directApprovals: Array<{ format: Format; revisionId: string; reviewCounter: number }> = [];
    for (const format of formats) {
      const approved = await approveGeneratedChannel(factualDirect, format, 'DIRECT', 'FACTUAL');
      directApprovals.push({ format, revisionId: approved.revisionId, reviewCounter: approved.reviewCounter });
      journeyPhase(`joined.direct.${format}.approved`);
    }
    journeyPhase('joined.direct-seven-formats');
    expect(await health.prisma.article.count({ where: { projectId: factualDirect } })).toBe(0);
    expect(await health.prisma.outline.count({ where: { projectId: factualDirect } })).toBe(0);
    expect(directApprovals.map(row => row.format).sort()).toEqual([...formats].sort());

    const scriptApprovals: Array<{ format: 'LINKEDIN_CAROUSEL_SCRIPT' | 'INSTAGRAM_CAROUSEL_SCRIPT' | 'INSTAGRAM_STORIES_SCRIPT'; revisionId: string; reviewCounter: number }> = [];
    for (const format of ['LINKEDIN_CAROUSEL', 'INSTAGRAM_CAROUSEL', 'INSTAGRAM_STORIES'] as const) {
      let state = await scripts.get(owner, factualDirect, format);
      const revision = state.script!.revisions.find(row => row.jobId);
      expect(revision).toBeDefined();
      const caption = await channels.get(owner, factualDirect, format);
      expect(state.parent!.id).toBe(caption.adaptation!.currentApprovedRevisionId);
      state = await scripts.review(owner, factualDirect, format, revision!.id, 'apply', { expectedRevision: state.script!.revision });
      state = await scripts.get(owner, factualDirect, format);
      state = await scripts.review(owner, factualDirect, format, revision!.id, 'approve', { expectedRevision: state.script!.revision,
        expectedReviewCounter: revision!.reviewCounter, acknowledgeUnmapped: true });
      scriptApprovals.push({ format: `${format}_SCRIPT`, revisionId: revision!.id, reviewCounter: revision!.reviewCounter });
      expect(state.script!.currentApprovedRevisionId).toBe(revision!.id);
      journeyPhase(`joined.direct.${format}.script-approved`);
    }
    journeyPhase('joined.direct-three-scripts');
    const visualApprovals: Array<{ format: 'LINKEDIN_COVER_VISUAL' | 'LINKEDIN_CAROUSEL_VISUAL' | 'INSTAGRAM_COVER_VISUAL' | 'INSTAGRAM_CAROUSEL_VISUAL' | 'INSTAGRAM_STORIES_VISUAL'; revisionId: string; reviewCounter: number }> = [];
    for (const format of ['LINKEDIN_COVER','LINKEDIN_CAROUSEL','INSTAGRAM_COVER','INSTAGRAM_CAROUSEL','INSTAGRAM_STORIES'] as const) {
      visualApprovals.push(await approveVisual(factualDirect, format));
    }
    journeyPhase('joined.direct-five-visuals');
    expect(visualApprovals).toHaveLength(5);
    const pngExport = await exportAndRead(factualDirect, [visualApprovals[0]!], 'PNG');
    const pdfExport = await exportAndRead(factualDirect, [visualApprovals[1]!], 'PDF');
    expect(pngExport.file.contentType).toBe('image/png');
    expect(pngExport.file.bytes.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    expect(pdfExport.file.contentType).toBe('application/pdf');
    expect(pdfExport.file.bytes.subarray(0, 5).toString('ascii')).toBe('%PDF-');
    journeyPhase('joined.raster-and-pdf-exports');

    const articleItem = { format: 'ARTICLE' as const, revisionId: candidate.id, reviewCounter: candidate.reviewCounter };
    const articlePackage = await exportAndRead(factualMixed, [articleItem,
      { format: 'LINKEDIN_TEXT', revisionId: articleDerived.revisionId, reviewCounter: articleDerived.reviewCounter },
      { format: 'LINKEDIN_CAROUSEL', revisionId: derivedCarousel.revisionId, reviewCounter: derivedCarousel.reviewCounter },
      { format: 'LINKEDIN_CAROUSEL_SCRIPT', revisionId: derivedScriptCandidate.id, reviewCounter: derivedScriptCandidate.reviewCounter }, derivedVisual]);
    factualPackageId = articlePackage.frozen.exportId;
    const directPackage = await exportAndRead(factualDirect, [directApprovals[0]!, directApprovals[6]!, scriptApprovals[0]!, visualApprovals[0]!]);
    directPackageId = directPackage.frozen.exportId;
    expect(articlePackage.file.contentType).toBe('application/zip');
    expect(directPackage.file.contentType).toBe('application/zip');
    const frozen = await health.prisma.exportRequest.findUniqueOrThrow({ where: { id: directPackage.frozen.exportId } });
    const frozenItems = (frozen.manifest as { items: Array<{ format: string; revisionId: string }> }).items;
    expect(frozenItems.map(item => item.format).sort()).toEqual(['LINKEDIN_TEXT', 'TELEGRAM_POST', 'LINKEDIN_CAROUSEL_SCRIPT', 'LINKEDIN_COVER_VISUAL'].sort());
    expect(frozenItems.some(item => item.revisionId === directApprovals[1]!.revisionId)).toBe(false);
    const sourceFile = zipLocalEntries(directPackage.file.bytes).find(entry => entry.name === 'sources.json');
    expect(sourceFile).toBeDefined();
    const sourceList = JSON.parse(sourceFile!.bytes.toString('utf8')) as Array<{ materialLabel: string; snapshotId: string }>;
    expect(sourceList).toHaveLength(1);
    expect(sourceList[0]).toMatchObject({ materialLabel: 'Прямий синтетичний факт' });
    await expect(exports.download(outsider, factualDirect, directPackage.frozen.exportId)).rejects.toMatchObject({ status: 404 });
    const artifactDir = '.local-checks/m61/journeys';
    await mkdir(artifactDir, { recursive: true });
    await Promise.all([
      writeFile(`${artifactDir}/factual-derived-selected.zip`, articlePackage.file.bytes),
      writeFile(`${artifactDir}/direct-selected.zip`, directPackage.file.bytes),
      writeFile(`${artifactDir}/canonical-cover.png`, pngExport.file.bytes),
      writeFile(`${artifactDir}/canonical-carousel.pdf`, pdfExport.file.bytes),
    ]);
    journeyPhase('joined.selected-zips-complete');
    joinedJourneyCompleted = true;
  }, 300_000);

  it('preserves creative and supplied unverified article history, blocks invalidated factual dependencies and replays jobs safely', async () => {
    if (!joinedJourneyCompleted) throw new Error('Joined M6.1 journey did not complete; refusing to run dependent history checks against partial fixture state');
    const creativeState = await articles.get(owner, creativeArticle);
    const creativeJob = await articles.freezeArticle(owner, creativeArticle, randomUUID(), creativeState.article?.revision ?? 0, articleWorkflowRelease(articleEnv));
    await execute(articleHandler, creativeJob.id);
    let creative = await articles.get(owner, creativeArticle);
    const creativeCandidate = creative.article!.versions.find(row => row.jobId === creativeJob.id)!;
    expect(creativeCandidate).toMatchObject({ contentMode: 'CREATIVE', basisRevisionId: null, approvedAt: null });
    creative = await articles.review(owner, creativeArticle, creativeCandidate.id, 'apply', { expectedRevision: creative.article!.revision });
    creative = await articles.review(owner, creativeArticle, creativeCandidate.id, 'approve', { expectedRevision: creative.article!.revision, acknowledgeUnmapped: true });
    const creativeReady = await exports.readiness(owner, creativeArticle);
    expect(creativeReady.items.find(item => item.format === 'ARTICLE')).toMatchObject({ ready: true });
    const creativePackage = await exportAndRead(creativeArticle, [{ format: 'ARTICLE', revisionId: creativeCandidate.id, reviewCounter: creativeCandidate.reviewCounter }]);
    const creativeEntries = zipLocalEntries(creativePackage.file.bytes);
    const creativeManifest = JSON.parse(creativeEntries.find(entry => entry.name === 'manifest.json')!.bytes.toString('utf8')) as { items: Array<{ format: string; contentMode?: string }> };
    expect(creativeManifest.items).toMatchObject([{ format: 'ARTICLE', contentMode: 'CREATIVE' }]);
    expect(creativeEntries.find(entry => entry.name === 'article.txt')?.bytes.toString('utf8')).toContain('без перевіреної фактичної основи');
    await writeFile('.local-checks/m61/journeys/creative-article-only.zip', creativePackage.file.bytes);

    const suppliedText = 'Редакційний матеріал, наданий автором без перевірених джерел.';
    const suppliedMaterial = randomUUID(), suppliedSnapshot = randomUUID(), fragment = importedFragments(suppliedText)[0]!;
    await health.prisma.material.create({ data: { id: suppliedMaterial, projectId: suppliedMixed, kind: 'TEXT', purpose: 'SUPPLIED_ARTICLE', label: 'Надана стаття', createdBy: owner } });
    await health.prisma.sourceSnapshot.create({ data: { id: suppliedSnapshot, projectId: suppliedMixed, materialId: suppliedMaterial, sequence: 1, normalizedText: suppliedText,
      sha256: hash(suppliedText), bytes: Buffer.byteLength(suppliedText), origin: 'MANUAL_TEXT', createdBy: owner } });
    await health.prisma.sourceFragment.create({ data: { ...fragment, projectId: suppliedMixed, snapshotId: suppliedSnapshot } });
    let supplied = await articles.importArticle(owner, suppliedMixed, { expectedRevision: 0, contentMode: 'CREATIVE', snapshotId: suppliedSnapshot });
    expect(supplied.article!.draft).toMatchObject({ origin: 'UNVERIFIED_IMPORTED', contentMode: 'CREATIVE' });
    await expect(channels.freezeTelegram(owner, suppliedMixed, { format: 'TELEGRAM_POST', expectedRevision: 0, commandKey: randomUUID(), inputMode: 'ARTICLE_DERIVED',
      contentMode: 'CREATIVE' }, telegramWorkflowRelease(telegramEnv))).rejects.toMatchObject({ status: 409 });
    supplied = await articles.checkpoint(owner, suppliedMixed, { expectedRevision: supplied.article!.revision });
    const suppliedVersion = supplied.article!.versions[0]!;
    supplied = await articles.review(owner, suppliedMixed, suppliedVersion.id, 'approve', { expectedRevision: supplied.article!.revision, acknowledgeUnmapped: true });
    expect(supplied.article!.currentApprovedVersionId).toBe(suppliedVersion.id);
    const suppliedDerived = await approveGeneratedChannel(suppliedMixed, 'TELEGRAM_POST', 'ARTICLE_DERIVED', 'CREATIVE');
    expect(suppliedDerived.state.adaptation!.revisions.find(row => row.id === suppliedDerived.revisionId)).toMatchObject({ eligible: true, contentMode: 'CREATIVE' });
    const suppliedReady = await exports.readiness(owner, suppliedMixed);
    expect(suppliedReady.items.find(item => item.format === 'TELEGRAM_POST')).toMatchObject({ ready: true });
    const selectedOnly = await exportAndRead(suppliedMixed, [{ format: 'TELEGRAM_POST', revisionId: suppliedDerived.revisionId, reviewCounter: suppliedDerived.reviewCounter }]);
    await writeFile('.local-checks/m61/journeys/supplied-article-selected-channel.zip', selectedOnly.file.bytes);
    const selectedRequest = await health.prisma.exportRequest.findUniqueOrThrow({ where: { id: selectedOnly.frozen.exportId } });
    const suppliedManifest = (selectedRequest.manifest as { items: Array<{ format: string; contentMode?: string }> }).items;
    expect(suppliedManifest.map(item => item.format)).toEqual(['TELEGRAM_POST']);
    expect(suppliedManifest[0]).toMatchObject({ contentMode: 'CREATIVE' });

    const approvedVersion = await health.prisma.articleVersion.findUniqueOrThrow({ where: { id: (await articles.get(owner, factualMixed)).article!.currentApprovedVersionId! } });
    const priorText = approvedVersion.plainText, priorHash = approvedVersion.sha256, approvedAt = approvedVersion.approvedAt;
    const articleState = await articles.get(owner, factualMixed);
    await articles.review(owner, factualMixed, approvedVersion.id, 'withdraw', { expectedRevision: articleState.article!.revision, reason: 'Synthetic M6.1 source withdrawal' });
    expect((await articles.get(owner, factualMixed)).article!.versions.find(row => row.id === approvedVersion.id)).toMatchObject({
      plainText: priorText, sha256: priorHash, approvedAt: approvedAt!.toISOString(),
    });
    const derivedAfterWithdrawal = await channels.get(owner, factualMixed, 'LINKEDIN_CAROUSEL');
    expect(derivedAfterWithdrawal.adaptation!.revisions.find(row => row.id === factualDerivedCarouselRevisionId)!.eligible).toBe(false);
    await expect(exports.download(owner, factualMixed, factualPackageId)).rejects.toMatchObject({ status: 409 });

    const claim = await health.prisma.claim.findFirstOrThrow({ where: { projectId: factualDirect, currentRevisionId: directClaimRevisionId }, include: { currentRevision: { include: { evidence: true } } } });
    const directChannelState = await channels.get(owner, factualDirect, 'LINKEDIN_TEXT');
    const approvedChannel = await health.prisma.adaptationRevision.findUniqueOrThrow({ where: { id: directChannelState.adaptation!.currentApprovedRevisionId! } });
    const evidence = claim.currentRevision!.evidence[0]!;
    await facts.invalidate(owner, factualDirect, claim.id, evidence.id, { expectedRevision: claim.revision, reason: 'Synthetic M6.1 invalidation' });
    expect((await channels.get(owner, factualDirect, 'LINKEDIN_TEXT')).adaptation!.revisions.find(row => row.id === approvedChannel.id)!.eligible).toBe(false);
    await expect(exports.download(owner, factualDirect, directPackageId)).rejects.toMatchObject({ status: 409 });

    const replayBefore = await health.prisma.articleVersion.count({ where: { projectId: creativeArticle, jobId: creativeJob.id } });
    const replayJob = await health.prisma.job.findUniqueOrThrow({ where: { id: creativeJob.id } });
    expect(replayJob.status).toBe('SUCCEEDED');
    const callsBeforeReplay = providerCalls;
    await expect(execute(articleHandler, creativeJob.id)).rejects.toThrow('M6.1 fixture job was not claimable');
    expect(await health.prisma.articleVersion.count({ where: { projectId: creativeArticle, jobId: creativeJob.id } })).toBe(replayBefore);
    expect(await health.prisma.aIExecution.count({ where: { projectId: creativeArticle, jobId: creativeJob.id } })).toBe(1);
    expect(providerCalls).toBe(callsBeforeReplay);
    historyJourneyCompleted = true;
  }, 120_000);

  it('purges one joined factual project through the production lifecycle while preserving its neighbors', async () => {
    if (!joinedJourneyCompleted || !historyJourneyCompleted) throw new Error('M6.1 journey history is incomplete; refusing to purge a partial fixture');
    const targetBefore = await health.prisma.project.findUniqueOrThrow({ where: { id: factualMixed } });
    const targetArticleVersions = await health.prisma.articleVersion.count({ where: { projectId: factualMixed } });
    const targetAdaptationRevisions = await health.prisma.adaptationRevision.count({ where: { projectId: factualMixed } });
    const targetScriptRevisions = await health.prisma.scriptRevision.count({ where: { projectId: factualMixed } });
    const targetAssets = await health.prisma.asset.findMany({ where: { projectId: factualMixed }, select: { id: true } });
    expect(targetArticleVersions).toBeGreaterThan(0);
    expect(targetAdaptationRevisions).toBeGreaterThan(0);
    expect(targetScriptRevisions).toBeGreaterThan(0);
    expect(targetAssets.length).toBeGreaterThan(0);

    const directChannelState = await channels.get(owner, factualDirect, 'LINKEDIN_TEXT');
    const directApproved = await health.prisma.adaptationRevision.findUniqueOrThrow({ where: { id: directChannelState.adaptation!.currentApprovedRevisionId! } });
    const directEvidence = (await health.prisma.claimEvidence.findMany({ where: { projectId: factualDirect }, orderBy: { id: 'asc' }, select: { id: true, sha256: true, invalidatedAt: true } }))
      .map(row => ({ id: row.id, sha256: row.sha256, invalidatedAt: row.invalidatedAt }));
    const directAssets = (await health.prisma.asset.findMany({ where: { projectId: factualDirect }, orderBy: { id: 'asc' }, select: { id: true } })).map(row => row.id);
    const retainedProject = await health.prisma.project.findUniqueOrThrow({ where: { id: suppliedMixed }, select: { id: true } });
    const retainedMembers = await health.prisma.workspaceMember.findMany({ where: { workspaceId: workspace, userId: { in: [owner, otherMember] } }, orderBy: { userId: 'asc' }, select: { userId: true, leftAt: true } });
    const retainedProfiles = await health.prisma.userProfile.count({ where: { id: { in: [owner, otherMember] } } });

    await expect(health.prisma.$queryRaw`SELECT contextflow.purge_project_graph(${factualMixed}::uuid,${otherMember}::uuid,${targetBefore.revision})`)
      .rejects.toThrow('only the active Workspace owner may purge a Project');
    const old = new Date(Date.now() - 31 * 86_400_000);
    const purgeAfter = new Date(old.getTime() + 30 * 86_400_000);
    await health.prisma.project.update({ where: { id: factualMixed }, data: { trashedAt: old, purgeAfter } });
    const trashed = await health.prisma.project.findUniqueOrThrow({ where: { id: factualMixed } });
    const purgeRows = await health.prisma.$queryRaw<Array<{ purge_project_graph: { cleanupPending: number; deletedRows: number } }>>
      `SELECT contextflow.purge_project_graph(${factualMixed}::uuid,${owner}::uuid,${trashed.revision})`;
    expect(purgeRows[0]!.purge_project_graph.cleanupPending).toBe(targetAssets.length);
    expect(purgeRows[0]!.purge_project_graph.deletedRows).toBeGreaterThan(0);

    expect(await health.prisma.project.findUnique({ where: { id: factualMixed } })).toBeNull();
    expect(await health.prisma.articleVersion.count({ where: { projectId: factualMixed } })).toBe(0);
    expect(await health.prisma.adaptationRevision.count({ where: { projectId: factualMixed } })).toBe(0);
    expect(await health.prisma.scriptRevision.count({ where: { projectId: factualMixed } })).toBe(0);
    expect(await health.prisma.asset.count({ where: { projectId: factualMixed } })).toBe(0);
    const targetDeletionJournal = await health.prisma.privateObjectDeletion.findMany({ where: { projectId: factualMixed, state: 'PENDING' }, select: { id: true } });
    expect(targetDeletionJournal).toHaveLength(targetAssets.length);

    const directAfter = await health.prisma.adaptationRevision.findUniqueOrThrow({ where: { id: directApproved.id } });
    expect(directAfter.sha256).toBe(directApproved.sha256);
    expect((await health.prisma.claimEvidence.findMany({ where: { projectId: factualDirect }, orderBy: { id: 'asc' }, select: { id: true, sha256: true, invalidatedAt: true } }))
      .map(row => ({ id: row.id, sha256: row.sha256, invalidatedAt: row.invalidatedAt }))).toEqual(directEvidence);
    expect((await health.prisma.asset.findMany({ where: { projectId: factualDirect }, orderBy: { id: 'asc' }, select: { id: true } })).map(row => row.id)).toEqual(directAssets);
    expect(await health.prisma.project.findUnique({ where: retainedProject })).not.toBeNull();
    expect(await health.prisma.userProfile.count({ where: { id: { in: [owner, otherMember] } } })).toBe(retainedProfiles);
    expect(await health.prisma.workspaceMember.findMany({ where: { workspaceId: workspace, userId: { in: [owner, otherMember] } }, orderBy: { userId: 'asc' }, select: { userId: true, leftAt: true } }))
      .toEqual(retainedMembers);
  });
});
