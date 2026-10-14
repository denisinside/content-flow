import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { ArticleService, DependencyHealthService, DurableJobService, DurableJobWorker, EditorialService, ExportService,
  EXTERNAL_PROCESSING_NOTICE, FactualBasisService, LanguageSuggestionService, PrivateAssetStore, ScriptService, TelegramService, createExportJobHandler,
  createTelegramJobHandler, loadRuntimeConfig, privateStorageConfig, telegramWorkflowRelease, type TelegramProviderInput } from '@contextflow/backend';

describe('M4.1 LinkedIn text and Instagram cover', () => {
  const config = loadRuntimeConfig(), health = new DependencyHealthService(config);
  const jobs = new DurableJobService(health.prisma, { noticeVersion: EXTERNAL_PROCESSING_NOTICE.version, retryBaseMs: 0 });
  const facts = new FactualBasisService(health.prisma, jobs), editorial = new EditorialService(health.prisma, jobs, facts);
  const articles = new ArticleService(health.prisma, jobs, facts), channels = new TelegramService(health.prisma, jobs, facts, articles);
  const language = new LanguageSuggestionService(health.prisma, articles);
  const assets = new PrivateAssetStore(privateStorageConfig({ NODE_ENV: 'test' }));
  const exports = new ExportService(health.prisma, jobs, articles, channels, assets);
  const migration = new Pool({ connectionString: config.directDatabaseUrl, ssl: false, max: 2 });
  const owner = randomUUID(), workspaceId = randomUUID(), projectId = randomUUID(), articleProjectId = randomUUID();
  const projectIds = [projectId, articleProjectId];
  const formats = ['LINKEDIN_TEXT', 'INSTAGRAM_COVER'] as const;
  const generatedInputs: TelegramProviderInput[] = [];
  let worker: DurableJobWorker | undefined;
  let setupCompleted = false;

  const provider = {
    async execute(_settings: unknown, _jobId: string, input: TelegramProviderInput, _signal: AbortSignal,
      beforeSubmit: () => Promise<void>, recordRun: (id: string) => Promise<void>) {
      await beforeSubmit();
      const workflowRunId = randomUUID(); await recordRun(workflowRunId); generatedInputs.push(structuredClone(input));
      const content = input.format === 'INSTAGRAM_COVER'
        ? { text: 'Невеликий текст допису.', mappings: [], cover: { text: 'Місто  змінюється щодня', instruction: 'Світле фото вулиці на обкладинці' } }
        : { text: 'Оновлення  міського сервісу вже близько.', mappings: [] };
      return { output: { schemaVersion: 'adaptation-v1' as const, format: input.format, content }, workflowRunId, model: 'synthetic' };
    },
    async resume(_settings: unknown, workflowRunId: string) {
      throw new Error(`Unexpected resume for synthetic run ${workflowRunId}`);
    },
  };

  beforeAll(async () => {
    vi.stubEnv('DIFY_API_BASE_URL', 'https://dify.example.test/v1');
    vi.stubEnv('DIFY_ADAPTATION_WORKFLOW_ID', randomUUID());
    vi.stubEnv('DIFY_ADAPTATION_CONFIG_SHA256', 'cdbf1b551e583edccf21865081ffedef6f018a12231f44dec538f7a2f1b81603');
    vi.stubEnv('DIFY_ADAPTATION_API_KEY', 'synthetic-adaptation-key');
    expect((await health.check()).status).toBe('ready');
    await health.prisma.userProfile.create({ data: { id: owner, externalProcessingNoticeVersion: EXTERNAL_PROCESSING_NOTICE.version,
      externalProcessingAcceptedAt: new Date() } });
    await health.prisma.workspace.create({ data: { id: workspaceId, name: `M4.1 TEST ${workspaceId}`, ownerId: owner,
      members: { create: [{ userId: owner }] }, styles: { create: { revision: 1, createdBy: owner, tone: 'Стриманий', brandbook: 'Тестові матеріали' } } } });
    await health.prisma.project.createMany({ data: [
      { id: projectId, workspaceId, createdBy: owner, topic: 'Міський сервіс', formats: [...formats] },
      { id: articleProjectId, workspaceId, createdBy: owner, topic: 'Стаття для мовної перевірки', formats: ['ARTICLE'] },
    ] });
    await editorial.saveBrief(owner, projectId, { expectedRevision: 0, contentMode: 'CREATIVE', topic: 'Зміни міського сервісу',
      audience: 'Мешканці міста', centralMessage: 'Коротко повідомити про оновлення', category: 'Місто', targetLength: 100,
      cta: '', exclusions: [], notes: '', requiredClaimRevisionIds: [] });
    worker = new DurableJobWorker(health.prisma, config.redisUrl, EXTERNAL_PROCESSING_NOTICE.version,
      [createTelegramJobHandler({ prisma: health.prisma, telegram: channels, scripts: new ScriptService(health.prisma, channels), factualBasis: facts, articles, provider,
        env: { NODE_ENV: 'test', DIFY_API_BASE_URL: process.env['DIFY_API_BASE_URL'], DIFY_ADAPTATION_WORKFLOW_ID: process.env['DIFY_ADAPTATION_WORKFLOW_ID'],
          DIFY_ADAPTATION_CONFIG_SHA256: process.env['DIFY_ADAPTATION_CONFIG_SHA256'], DIFY_ADAPTATION_API_KEY: 'synthetic-adaptation-key' } }), createExportJobHandler(exports)],
      { queueName: `cf-m41-test-${randomUUID()}` });
    await worker.queue.waitUntilReady();
    setupCompleted = true;
  });

  afterAll(async () => {
    await worker?.close();
    if (!setupCompleted) { await migration.end(); await health.onModuleDestroy(); vi.unstubAllEnvs(); return; }
    const stored = await health.prisma.asset.findMany({ where: { projectId, purpose: 'EXPORT' }, select: { bucket: true, objectKey: true } });
    await Promise.all(stored.map(row => assets.remove(row.bucket, row.objectKey).catch(() => undefined)));
    const db = await migration.connect();
    try {
      await db.query('BEGIN');
      for (const table of ['ExportArtifact', 'ExportItem', 'ExportRequest', 'Asset', 'LanguageSuggestion', 'AdaptationRevisionClaim', 'AdaptationDraft', 'AdaptationRevision', 'Adaptation']) {
        await db.query(`ALTER TABLE contextflow."${table}" DISABLE TRIGGER USER`);
      }
      const editorialTables = ['Brief', 'BriefRevision', 'BriefRequiredClaim', 'BriefContextSnapshot'];
      for (const table of editorialTables) await db.query(`ALTER TABLE contextflow."${table}" DISABLE TRIGGER "${table}_no_delete"`);
      const articleTables = ['ArticleVersionClaim', 'ArticleDraft', 'ArticleVersion', 'Article'];
      for (const table of articleTables) await db.query(`ALTER TABLE contextflow."${table}" DISABLE TRIGGER "${table}_no_delete"`);
      await db.query('ALTER TABLE contextflow."Brief" DISABLE TRIGGER "Brief_pointer_guard"');
      await db.query('UPDATE contextflow."Adaptation" SET "currentApprovedRevisionId"=NULL,"revision"="revision"+1 WHERE "projectId"=ANY($1::uuid[])', [projectIds]);
      await db.query('UPDATE contextflow."Article" SET "currentApprovedVersionId"=NULL,"revision"="revision"+1 WHERE "projectId"=ANY($1::uuid[])', [projectIds]);
      for (const table of ['ExportArtifact', 'ExportItem', 'ExportRequest', 'Asset', 'LanguageSuggestion', 'AdaptationRevisionClaim', 'AdaptationDraft', 'AdaptationRevision', 'Adaptation',
        'ArticleVersionClaim', 'ArticleDraft', 'ArticleVersion', 'Article']) {
        await db.query(`DELETE FROM contextflow."${table}" WHERE "projectId"=ANY($1::uuid[])`, [projectIds]);
      }
      await db.query('DELETE FROM contextflow."AIExecution" WHERE "projectId"=ANY($1::uuid[])', [projectIds]);
      await db.query('DELETE FROM contextflow."JobAttempt" WHERE "jobId" IN (SELECT "id" FROM contextflow."Job" WHERE "projectId"=ANY($1::uuid[]))', [projectIds]);
      await db.query('DELETE FROM contextflow."Job" WHERE "projectId"=ANY($1::uuid[])', [projectIds]);
      await db.query('UPDATE contextflow."Brief" SET "currentRevisionId"=NULL,"revision"="revision"+1 WHERE "projectId"=ANY($1::uuid[])', [projectIds]);
      for (const table of ['BriefRequiredClaim', 'BriefContextSnapshot', 'BriefRevision', 'Brief']) {
        await db.query(`DELETE FROM contextflow."${table}" WHERE "projectId"=ANY($1::uuid[])`, [projectIds]);
      }
      await db.query('DELETE FROM contextflow."Project" WHERE "id"=ANY($1::uuid[])', [projectIds]);
      await db.query('DELETE FROM contextflow."WorkspaceStyleRevision" WHERE "workspaceId"=$1', [workspaceId]);
      await db.query('DELETE FROM contextflow."WorkspaceMember" WHERE "workspaceId"=$1', [workspaceId]);
      await db.query('DELETE FROM contextflow."Workspace" WHERE "id"=$1', [workspaceId]);
      await db.query('DELETE FROM contextflow."UserProfile" WHERE "id"=$1', [owner]);
      await db.query('ALTER TABLE contextflow."Brief" ENABLE TRIGGER "Brief_pointer_guard"');
      for (const table of editorialTables) await db.query(`ALTER TABLE contextflow."${table}" ENABLE TRIGGER "${table}_no_delete"`);
      for (const table of articleTables) await db.query(`ALTER TABLE contextflow."${table}" ENABLE TRIGGER "${table}_no_delete"`);
      for (const table of ['ExportArtifact', 'ExportItem', 'ExportRequest', 'Asset', 'LanguageSuggestion', 'AdaptationRevisionClaim', 'AdaptationDraft', 'AdaptationRevision', 'Adaptation']) {
        await db.query(`ALTER TABLE contextflow."${table}" ENABLE TRIGGER USER`);
      }
      await db.query('COMMIT');
    } catch (error) { await db.query('ROLLBACK'); throw error; }
    finally {
      db.release();
      for (const table of ['ExportArtifact', 'ExportItem', 'ExportRequest', 'Asset', 'LanguageSuggestion', 'AdaptationRevisionClaim', 'AdaptationDraft', 'AdaptationRevision', 'Adaptation']) {
        await migration.query(`ALTER TABLE contextflow."${table}" ENABLE TRIGGER USER`).catch(() => undefined);
      }
      await migration.end(); await health.onModuleDestroy(); vi.unstubAllEnvs();
    }
  });

  it('generates both selected formats on the shared route, preserves manual drafts, and exports approved provenance as UTF-8 ZIP', async () => {
    const contentByFormat = {
      LINKEDIN_TEXT: { text: 'Мій ручний текст LinkedIn.', mappings: [] },
      INSTAGRAM_COVER: { text: 'Мій ручний підпис.', mappings: [], cover: { text: 'Моя ручна обкладинка', instruction: 'Залишити композицію редактора' } },
    };
    const jobsToRun: string[] = [];
    for (const format of formats) {
      const initial = await channels.get(owner, projectId, format);
      expect(initial.formatSelected).toBe(true);
      const saved = await channels.saveDraft(owner, projectId, { format, expectedRevision: 0, inputMode: 'DIRECT', contentMode: 'CREATIVE', includeLink: false,
        content: contentByFormat[format] });
      const frozen = await channels.freezeTelegram(owner, projectId, { format, expectedRevision: saved.adaptation!.revision, commandKey: randomUUID(),
        inputMode: 'DIRECT', contentMode: 'CREATIVE', includeLink: false }, telegramWorkflowRelease());
      jobsToRun.push(frozen.id);
    }
    for (const jobId of jobsToRun) await worker!.process({ jobId, ordinal: 1 });
    expect(generatedInputs.map(input => input.format).sort()).toEqual([...formats].sort());
    expect(generatedInputs.every(input => input.inputMode === 'DIRECT' && input.article === null)).toBe(true);

    const approved: Array<{ format: typeof formats[number]; revisionId: string; reviewCounter: number }> = [];
    for (const format of formats) {
      let current = await channels.get(owner, projectId, format);
      expect(current.adaptation!.draft!.content).toEqual(contentByFormat[format]);
      const candidate = current.adaptation!.revisions.find(row => row.origin === 'AI')!;
      current = await channels.review(owner, projectId, candidate.id, 'apply', { format, expectedRevision: current.adaptation!.revision });
      current = await channels.review(owner, projectId, candidate.id, 'approve', { format, expectedRevision: current.adaptation!.revision,
        expectedReviewCounter: candidate.reviewCounter, acknowledgeUnmapped: true });
      expect(current.adaptation!.currentApprovedRevisionId).toBe(candidate.id);
      approved.push({ format, revisionId: candidate.id, reviewCounter: candidate.reviewCounter });
    }
    const ready = await exports.readiness(owner, projectId);
    expect(ready.ready).toBe(false);
    expect(ready.items.find(item => item.format === 'INSTAGRAM_COVER_VISUAL')).toMatchObject({ ready: false, reasons: ['APPROVAL_REQUIRED'] });
    const selectedItems = ready.items.filter(item => formats.includes(item.format as typeof formats[number]));
    expect(selectedItems).toHaveLength(formats.length);
    expect(selectedItems.every(item => item.ready)).toBe(true);
    const frozenExport = await exports.freeze(owner, projectId, { expectedProjectRevision: ready.projectRevision, commandKey: randomUUID(), format: 'ZIP',
      items: approved });
    await worker!.process({ jobId: frozenExport.jobId, ordinal: 1 });
    const request = await health.prisma.exportRequest.findUniqueOrThrow({ where: { id: frozenExport.exportId } });
    const manifest = request.manifest as { formats: string[]; items: Array<{ format: string; revisionId: string }> };
    expect(manifest.formats).toEqual(expect.arrayContaining([...formats]));
    expect(manifest.items.map(item => item.revisionId).sort()).toEqual(approved.map(item => item.revisionId).sort());
    const download = await exports.download(owner, projectId, frozenExport.exportId);
    expect(download.contentType).toBe('application/zip');
    expect(download.bytes.readUInt32LE(0)).toBe(0x04034b50);
    const entries = zipLocalEntries(download.bytes);
    expect(entries.map(entry => entry.name)).toContain('instagram-cover.txt');
    expect(entries.find(entry => entry.name === 'instagram-cover.txt')?.bytes.toString('utf8')).toContain('Місто  змінюється щодня');
    expect(entries.find(entry => entry.name === 'linkedin-text.txt')?.bytes.toString('utf8')).toContain('Оновлення  міського сервісу вже близько.');
    expect(entries.find(entry => entry.name === 'manifest.json')?.bytes.toString('utf8')).toContain('INSTAGRAM_COVER');
    expect(await health.prisma.article.count({ where: { projectId } })).toBe(0);
    expect(await health.prisma.outline.count({ where: { projectId } })).toBe(0);
  });

  it('keeps accepted language edits in the working draft and rejects stale proposals', async () => {
    const linkedin = await channels.get(owner, projectId, 'LINKEDIN_TEXT');
    const linkedinRevision = linkedin.adaptation!.revisions.find(row => row.id === linkedin.adaptation!.currentApprovedRevisionId)!;
    const linkedinReview = await language.review(owner, projectId, { targetType: 'ADAPTATION', sourceRevisionId: linkedinRevision.id,
      expectedRevision: linkedin.adaptation!.revision });
    const staleSuggestion = linkedinReview.suggestions[0]!;
    expect(staleSuggestion.originalText).toBe('  ');
    const editedLinkedin = await channels.saveDraft(owner, projectId, { format: 'LINKEDIN_TEXT', expectedRevision: linkedin.adaptation!.revision,
      inputMode: 'DIRECT', contentMode: 'CREATIVE', includeLink: false,
      content: { text: 'Ручний текст після мовної пропозиції.', mappings: [] } });
    expect((await language.list(owner, projectId, 'ADAPTATION', linkedinRevision.id)).suggestions[0]).toMatchObject({ stale: true, status: 'OPEN' });
    await expect(language.accept(owner, projectId, { targetType: 'ADAPTATION', sourceRevisionId: linkedinRevision.id,
      expectedRevision: editedLinkedin.adaptation!.revision, suggestionIds: [staleSuggestion.id] })).rejects.toMatchObject({ status: 409 });

    const instagram = await channels.get(owner, projectId, 'INSTAGRAM_COVER');
    const instagramRevision = instagram.adaptation!.revisions.find(row => row.id === instagram.adaptation!.currentApprovedRevisionId)!;
    const instagramReview = await language.review(owner, projectId, { targetType: 'ADAPTATION', sourceRevisionId: instagramRevision.id,
      expectedRevision: instagram.adaptation!.revision });
    const coverSuggestion = instagramReview.suggestions.find(row => row.locator.field === 'COVER_TEXT')!;
    const result = await language.accept(owner, projectId, { targetType: 'ADAPTATION', sourceRevisionId: instagramRevision.id,
      expectedRevision: instagram.adaptation!.revision, suggestionIds: [coverSuggestion.id] });
    expect(result.suggestions[0]).toMatchObject({ status: 'ACCEPTED', sourceRevisionId: instagramRevision.id });
    const current = await channels.get(owner, projectId, 'INSTAGRAM_COVER');
    expect((current.adaptation!.draft!.content as { cover: { text: string } }).cover.text).toBe('Місто змінюється щодня');
    expect((current.adaptation!.revisions.find(row => row.id === instagramRevision.id)!.content as { cover: { text: string } }).cover.text).toBe('Місто  змінюється щодня');
    expect(current.adaptation!.currentApprovedRevisionId).toBe(instagramRevision.id);
  });

  it('accepts an Article language suggestion as a new unapproved candidate', async () => {
    const draft = await articles.saveDraft(owner, articleProjectId, { expectedRevision: 0, contentMode: 'CREATIVE', content: {
      title: 'Міський сервіс', document: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Оновлення  міського сервісу.' }] }] },
    } });
    const checkpoint = await articles.checkpoint(owner, articleProjectId, { expectedRevision: draft.article!.revision });
    const source = checkpoint.article!.versions[0]!;
    const review = await language.review(owner, articleProjectId, { targetType: 'ARTICLE', sourceRevisionId: source.id,
      expectedRevision: checkpoint.article!.revision });
    expect(review.suggestions[0]).toMatchObject({ sourceRevisionId: source.id, locator: { field: 'BODY' }, originalText: '  ', replacementText: ' ' });
    const accepted = await language.accept(owner, articleProjectId, { targetType: 'ARTICLE', sourceRevisionId: source.id,
      expectedRevision: checkpoint.article!.revision, suggestionIds: [review.suggestions[0]!.id] });
    const current = await articles.get(owner, articleProjectId);
    expect(current.article!.currentApprovedVersionId).toBeNull();
    expect(JSON.stringify(current.article!.versions.find(row => row.id === source.id)!.content)).toContain('Оновлення  міського сервісу.');
    const candidate = current.article!.versions.find(row => row.id === accepted.candidateVersionId)!.content as { document: { content: Array<{ content: Array<{ text?: string }> }> } };
    expect(candidate.document.content.flatMap(block => block.content.map(node => node.text ?? '')).join('')).toBe('Оновлення міського сервісу.');
  });

  it('isolates each output and blocks missing ARTICLE_DERIVED and factual inputs', async () => {
    const linkedin = await channels.get(owner, projectId, 'LINKEDIN_TEXT');
    const instagram = await channels.get(owner, projectId, 'INSTAGRAM_COVER');
    expect(linkedin.format).toBe('LINKEDIN_TEXT');
    expect(instagram.format).toBe('INSTAGRAM_COVER');
    expect(linkedin.adaptation?.currentApprovedRevisionId).toBeTruthy();
    expect(instagram.adaptation?.currentApprovedRevisionId).toBeTruthy();
    expect((await channels.get(owner, projectId, 'LINKEDIN_COVER')).formatSelected).toBe(false);
    await expect(channels.saveDraft(owner, projectId, { format: 'LINKEDIN_COVER', expectedRevision: 0, inputMode: 'DIRECT', contentMode: 'CREATIVE', includeLink: false,
      content: { text: 'Текст', mappings: [], cover: { text: 'Обкладинка', instruction: 'Синтетичний задум' } } })).rejects.toMatchObject({ status: 409 });
    await expect(channels.freezeTelegram(owner, projectId, { format: 'LINKEDIN_TEXT', expectedRevision: linkedin.adaptation!.revision,
      commandKey: randomUUID(), inputMode: 'ARTICLE_DERIVED', contentMode: 'CREATIVE', includeLink: false }, telegramWorkflowRelease()))
      .rejects.toMatchObject({ status: 409 });
    await expect(channels.freezeTelegram(owner, projectId, { format: 'LINKEDIN_TEXT', expectedRevision: linkedin.adaptation!.revision,
      commandKey: randomUUID(), inputMode: 'DIRECT', contentMode: 'FACTUAL', includeLink: false }, telegramWorkflowRelease()))
      .rejects.toMatchObject({ status: 409 });
    await editorial.saveBrief(owner, projectId, { expectedRevision: 1, contentMode: 'CREATIVE', topic: 'Оновлений контекст',
      audience: 'Мешканці міста', centralMessage: 'Додаткова редакційна думка', category: 'Місто', targetLength: 100,
      cta: '', exclusions: [], notes: '', requiredClaimRevisionIds: [] });
    for (const format of formats) expect((await channels.get(owner, projectId, format)).staleReasons).toContain('BRIEF_CHANGED');
  });
});

function zipLocalEntries(bytes: Buffer): Array<{ name: string; bytes: Buffer }> {
  const entries: Array<{ name: string; bytes: Buffer }> = [];
  let offset = 0;
  while (offset + 30 <= bytes.length && bytes.readUInt32LE(offset) === 0x04034b50) {
    const bodySize = bytes.readUInt32LE(offset + 18), nameLength = bytes.readUInt16LE(offset + 26), extraLength = bytes.readUInt16LE(offset + 28);
    const nameStart = offset + 30, bodyStart = nameStart + nameLength + extraLength;
    entries.push({ name: bytes.subarray(nameStart, nameStart + nameLength).toString('utf8'), bytes: bytes.subarray(bodyStart, bodyStart + bodySize) });
    offset = bodyStart + bodySize;
  }
  return entries;
}
