import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { ArticleService, DependencyHealthService, DurableJobService, DurableJobWorker, EditorialService, EXTERNAL_PROCESSING_NOTICE,
  FactualBasisService, TelegramService, createTelegramJobHandler, loadRuntimeConfig, telegramWorkflowRelease,
  type TelegramProviderInput } from '@contextflow/backend';

const releaseDescriptor = JSON.parse(readFileSync(new URL('../../packages/backend/src/editorial/workflows/telegram-generation/release.json', import.meta.url), 'utf8')) as { configDigest: string };
describe('Telegram frozen generation through the durable worker', () => {
  const config = loadRuntimeConfig(), health = new DependencyHealthService(config);
  const jobs = new DurableJobService(health.prisma, { noticeVersion: EXTERNAL_PROCESSING_NOTICE.version });
  const facts = new FactualBasisService(health.prisma, jobs), editorial = new EditorialService(health.prisma, jobs, facts);
  const articles = new ArticleService(health.prisma, jobs, facts), telegram = new TelegramService(health.prisma, jobs, facts, articles);
  const sql = new Pool({ connectionString: config.directDatabaseUrl, ssl: false, max: 2 });
  const owner = randomUUID(), workspaceId = randomUUID(), directProject = randomUUID(), derivedProject = randomUUID();
  const projects = [directProject, derivedProject];
  let worker!: DurableJobWorker;
  let setupCompleted = false;
  const sent: TelegramProviderInput[] = [], calls: string[] = [];
  let holdDerived = false;
  let derivedStarted = () => {};
  let derivedRelease: Promise<void> = Promise.resolve();
  const provider = {
    async execute(_settings: unknown, _jobId: string, input: TelegramProviderInput, _signal: AbortSignal,
      beforeSubmit: () => Promise<void>, recordRun: (id: string) => Promise<void>) {
      await beforeSubmit(); const id = randomUUID(); await recordRun(id); calls.push(id); sent.push(structuredClone(input));
      if (input.inputMode === 'ARTICLE_DERIVED' && holdDerived) { derivedStarted(); await derivedRelease; }
      return { output: { schemaVersion: 'telegram-v1' as const, content: { text: 'Короткий допис для каналу.', mappings: [] } }, workflowRunId: id, model: 'synthetic' };
    },
    async resume(_settings: unknown, runId: string) {
      return { output: { schemaVersion: 'telegram-v1' as const, content: { text: 'Короткий допис для каналу.', mappings: [] } }, workflowRunId: runId, model: 'synthetic' };
    },
  };
  beforeAll(async () => {
    vi.stubEnv('DIFY_API_BASE_URL', 'https://dify.example.test/v1');
    vi.stubEnv('DIFY_TELEGRAM_WORKFLOW_ID', randomUUID());
    vi.stubEnv('DIFY_TELEGRAM_CONFIG_SHA256', releaseDescriptor.configDigest);
    vi.stubEnv('DIFY_TELEGRAM_API_KEY', 'synthetic-telegram-key');
    expect((await health.check()).status).toBe('ready');
    await health.prisma.userProfile.create({ data: { id: owner, externalProcessingNoticeVersion: EXTERNAL_PROCESSING_NOTICE.version,
      externalProcessingAcceptedAt: new Date() } });
    await health.prisma.workspace.create({ data: { id: workspaceId, name: `Telegram generation TEST ${workspaceId}`, ownerId: owner,
      members: { create: [{ userId: owner }] }, styles: { create: { revision: 1, createdBy: owner, tone: 'Стриманий', brandbook: 'Точний' } } } });
    await health.prisma.project.createMany({ data: [
      { id: directProject, workspaceId, createdBy: owner, topic: 'Channels only', formats: ['TELEGRAM_POST'] },
      { id: derivedProject, workspaceId, createdBy: owner, topic: 'Article and channel', formats: ['ARTICLE', 'TELEGRAM_POST'] },
    ] });
    for (const project of projects) await editorial.saveBrief(owner, project, { expectedRevision: 0, contentMode: 'CREATIVE',
      topic: 'Коротке повідомлення', audience: 'Підписники', centralMessage: 'Одна корисна думка', category: 'Освіта',
      targetLength: 120, cta: '', exclusions: [], notes: '', requiredClaimRevisionIds: [] });
    const imported = await articles.importArticle(owner, derivedProject, { expectedRevision: 0, contentMode: 'CREATIVE', content: {
      title: 'Початковий матеріал', document: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Затверджений вихідний текст.' }] }] } } });
    if (!imported.article) throw new Error('Imported article draft was not created');
    const checkpoint = await articles.checkpoint(owner, derivedProject, { expectedRevision: imported.article.revision });
    if (!checkpoint.article) throw new Error('Article checkpoint was not created');
    const version = checkpoint.article.versions[0]!;
    await articles.review(owner, derivedProject, version.id, 'approve', { expectedRevision: checkpoint.article.revision, acknowledgeUnmapped: true });
    worker = new DurableJobWorker(health.prisma, config.redisUrl, EXTERNAL_PROCESSING_NOTICE.version,
      [createTelegramJobHandler({ prisma: health.prisma, telegram, factualBasis: facts, articles, provider,
        env: { NODE_ENV: 'test', DIFY_API_BASE_URL: 'https://dify.example.test/v1', DIFY_TELEGRAM_WORKFLOW_ID: process.env['DIFY_TELEGRAM_WORKFLOW_ID'],
          DIFY_TELEGRAM_CONFIG_SHA256: process.env['DIFY_TELEGRAM_CONFIG_SHA256'], DIFY_TELEGRAM_API_KEY: 'synthetic-telegram-key' } })],
      { queueName: 'cf-telegram-generation-test-' + randomUUID() });
    await worker.queue.waitUntilReady();
    setupCompleted = true;
  });
  afterAll(async () => {
    await worker?.close();
    if (!setupCompleted) { await sql.end(); await health.onModuleDestroy(); vi.unstubAllEnvs(); return; }
    const client = await sql.connect();
    try {
      await client.query('BEGIN');
      const cleanupProjects = projects, cleanupWorkspaces = [workspaceId], cleanupOwners = [owner];
      for (const table of ['AdaptationRevisionClaim', 'AdaptationDraft', 'AdaptationRevision', 'Adaptation']) {
        await client.query(`ALTER TABLE contextflow."${table}" DISABLE TRIGGER USER`);
      }
      for (const table of ['ArticleVersionClaim', 'ArticleDraft', 'ArticleVersion', 'Article']) await client.query(`ALTER TABLE contextflow."${table}" DISABLE TRIGGER USER`);
      const editorialTables = ['Brief', 'BriefRevision', 'BriefRequiredClaim', 'BriefContextSnapshot'];
      for (const table of editorialTables) await client.query(`ALTER TABLE contextflow."${table}" DISABLE TRIGGER "${table}_no_delete"`);
      await client.query('ALTER TABLE contextflow."Brief" DISABLE TRIGGER "Brief_pointer_guard"');
      await client.query('UPDATE contextflow."Adaptation" SET "currentApprovedRevisionId"=NULL,"revision"="revision"+1 WHERE "projectId"=ANY($1::uuid[])', [cleanupProjects]);
      await client.query('UPDATE contextflow."Article" SET "currentApprovedVersionId"=NULL,"revision"="revision"+1 WHERE "projectId"=ANY($1::uuid[])', [cleanupProjects]);
      await client.query('UPDATE contextflow."Brief" SET "currentRevisionId"=NULL,"revision"="revision"+1 WHERE "projectId"=ANY($1::uuid[])', [cleanupProjects]);
      for (const table of ['AdaptationRevisionClaim', 'AdaptationDraft', 'AdaptationRevision', 'Adaptation', 'ArticleVersionClaim', 'ArticleDraft', 'ArticleVersion', 'Article',
        'BriefRequiredClaim', 'BriefContextSnapshot', 'BriefRevision', 'Brief', 'AIExecution']) {
        await client.query(`DELETE FROM contextflow."${table}" WHERE "projectId"=ANY($1::uuid[])`, [cleanupProjects]);
      }
      await client.query('DELETE FROM contextflow."JobAttempt" WHERE "jobId" IN (SELECT "id" FROM contextflow."Job" WHERE "projectId"=ANY($1::uuid[]))', [cleanupProjects]);
      await client.query('DELETE FROM contextflow."Job" WHERE "projectId"=ANY($1::uuid[])', [cleanupProjects]);
      await client.query('DELETE FROM contextflow."Project" WHERE "id"=ANY($1::uuid[])', [cleanupProjects]);
      await client.query('DELETE FROM contextflow."WorkspaceStyleRevision" WHERE "workspaceId"=ANY($1::uuid[])', [cleanupWorkspaces]);
      await client.query('DELETE FROM contextflow."WorkspaceMember" WHERE "workspaceId"=ANY($1::uuid[])', [cleanupWorkspaces]);
      await client.query('DELETE FROM contextflow."Workspace" WHERE "id"=ANY($1::uuid[])', [cleanupWorkspaces]);
      await client.query('DELETE FROM contextflow."UserProfile" WHERE "id"=ANY($1::uuid[])', [cleanupOwners]);
      for (const table of ['AdaptationRevisionClaim', 'AdaptationDraft', 'AdaptationRevision', 'Adaptation']) await client.query(`ALTER TABLE contextflow."${table}" ENABLE TRIGGER USER`);
      for (const table of ['ArticleVersionClaim', 'ArticleDraft', 'ArticleVersion', 'Article']) await client.query(`ALTER TABLE contextflow."${table}" ENABLE TRIGGER USER`);
      for (const table of editorialTables) await client.query(`ALTER TABLE contextflow."${table}" ENABLE TRIGGER "${table}_no_delete"`);
      await client.query('ALTER TABLE contextflow."Brief" ENABLE TRIGGER "Brief_pointer_guard"');
      await client.query('COMMIT');
    } catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }
    await sql.end(); await health.onModuleDestroy(); vi.unstubAllEnvs();
  });
  it('generates both modes from frozen inputs and preserves a derived candidate after a dependency changes in flight', async () => {
    const release = telegramWorkflowRelease({ NODE_ENV: 'test', DIFY_API_BASE_URL: 'https://dify.example.test/v1',
      DIFY_TELEGRAM_WORKFLOW_ID: process.env['DIFY_TELEGRAM_WORKFLOW_ID'], DIFY_TELEGRAM_CONFIG_SHA256: process.env['DIFY_TELEGRAM_CONFIG_SHA256'] });
    for (const [project, inputMode] of [[directProject, 'DIRECT'], [derivedProject, 'ARTICLE_DERIVED']] as const) {
      await telegram.saveDraft(owner, project, { expectedRevision: 0, contentMode: 'CREATIVE', inputMode, includeLink: true,
        content: { text: 'Чернетка перед генерацією.', mappings: [] } });
    }
    // Freeze the derived route under style 1, then advance the Workspace style
    // without changing either captured Brief. The direct route must capture
    // and send style 2 while preserving Brief revision 1.
    const derivedState = await telegram.get(owner, derivedProject);
    const derivedJob = await telegram.freezeTelegram(owner, derivedProject, { expectedRevision: derivedState.adaptation!.revision,
      commandKey: randomUUID(), inputMode: 'ARTICLE_DERIVED', contentMode: 'CREATIVE', includeLink: true }, release);
    await health.prisma.$transaction(async tx => {
      await tx.workspaceStyleRevision.create({ data: { workspaceId, revision: 2, createdBy: owner,
        tone: 'Енергійний', brandbook: 'Новий стиль', settings: { accent: 'blue' } } });
      await tx.workspace.update({ where: { id: workspaceId }, data: { styleRevision: 2 } });
    });
    const directState = await telegram.get(owner, directProject);
    const directJob = await telegram.freezeTelegram(owner, directProject, { expectedRevision: directState.adaptation!.revision,
      commandKey: randomUUID(), inputMode: 'DIRECT', contentMode: 'CREATIVE', includeLink: true }, release);
    const jobIds = [directJob.id, derivedJob.id];
    await worker.process({ jobId: directJob.id, ordinal: 1 });
    let signalStarted!: () => void;
    let releaseProvider!: () => void;
    const started = new Promise<void>(resolve => { signalStarted = resolve; });
    derivedStarted = signalStarted;
    derivedRelease = new Promise<void>(resolve => { releaseProvider = resolve; });
    holdDerived = true;
    const processing = worker.process({ jobId: derivedJob.id, ordinal: 1 });
    await started;
    await editorial.saveBrief(owner, derivedProject, { expectedRevision: 1, contentMode: 'CREATIVE',
      topic: 'Тема після замороження', audience: 'Підписники', centralMessage: 'Інша думка', category: 'Освіта',
      targetLength: 120, cta: '', exclusions: [], notes: '', requiredClaimRevisionIds: [] });
    releaseProvider();
    await processing;
    holdDerived = false;
    expect(sent[0]).toMatchObject({ inputMode: 'DIRECT', contentMode: 'CREATIVE', includeLink: true, article: null });
    expect(sent[0]!.style).toMatchObject({ brandbook: 'Новий стиль', tone: 'Енергійний', settings: { accent: 'blue' } });
    expect(sent[1]).toMatchObject({ inputMode: 'ARTICLE_DERIVED', contentMode: 'CREATIVE', article: {
      sha256: expect.any(String), text: 'Затверджений вихідний текст.' } });
    for (const id of jobIds) expect(await health.prisma.job.findUniqueOrThrow({ where: { id } })).toMatchObject({ status: 'SUCCEEDED' });
    const derived = await telegram.get(owner, derivedProject);
    const generated = derived.adaptation!.revisions.find(revision => revision.origin === 'AI');
    expect(generated).toBeDefined();
    expect(generated!.staleReasons).toContain('BRIEF_CHANGED');
    await expect(telegram.review(owner, derivedProject, generated!.id, 'apply', { expectedRevision: derived.adaptation!.revision }))
      .rejects.toThrow(/inputs need review/i);
    const direct = await telegram.get(owner, directProject);
    const directGenerated = direct.adaptation!.revisions.find(revision => revision.origin === 'AI');
    expect(directGenerated).toMatchObject({ workspaceStyleRevision: 2 });
    const directJobRecord = await health.prisma.job.findUniqueOrThrow({ where: { id: directJob.id } });
    expect(directJobRecord.inputManifest).toMatchObject({ workspaceStyleRevision: 2 });
    const directBrief = await health.prisma.briefRevision.findFirstOrThrow({ where: { projectId: directProject } });
    expect(directBrief.workspaceStyleRevision).toBe(1);
    expect(await health.prisma.aIExecution.count({ where: { projectId: directProject, status: 'SUCCEEDED' } })).toBe(1);
    expect(await health.prisma.outline.count({ where: { projectId: directProject } })).toBe(0);
    expect(await health.prisma.article.count({ where: { projectId: directProject } })).toBe(0);
    expect(calls).toHaveLength(2);
  });
});
