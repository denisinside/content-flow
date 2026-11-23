import { createHash, randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { ArticleService, DependencyHealthService, DurableJobService, DurableJobWorker, EditorialService, ExportService,
  EXTERNAL_PROCESSING_NOTICE, FactualBasisService, PrivateAssetStore, ScriptService, ScriptLanguageService, TelegramService,
  createExportJobHandler, createTelegramJobHandler, importedFragments, loadRuntimeConfig, privateStorageConfig, telegramWorkflowRelease,
  type ScriptContent, type TelegramProviderInput } from '@contextflow/backend';

describe('M4.2 independent scripts and designer packages', () => {
  const config = loadRuntimeConfig(), health = new DependencyHealthService(config);
  const jobs = new DurableJobService(health.prisma, { noticeVersion: EXTERNAL_PROCESSING_NOTICE.version, retryBaseMs: 0 });
  const facts = new FactualBasisService(health.prisma, jobs), editorial = new EditorialService(health.prisma, jobs, facts);
  const articles = new ArticleService(health.prisma, jobs, facts), channels = new TelegramService(health.prisma, jobs, facts, articles);
  const scripts = new ScriptService(health.prisma, channels), language = new ScriptLanguageService(health.prisma, scripts);
  const assets = new PrivateAssetStore(privateStorageConfig({ NODE_ENV: 'test' }));
  const exports = new ExportService(health.prisma, jobs, articles, channels, assets);
  const migration = new Pool({ connectionString: config.directDatabaseUrl, ssl: false });
  const owner = randomUUID(), outsider = randomUUID(), workspace = randomUUID(), project = randomUUID(), factual = randomUUID();
  const projects = [project, factual];
  const formats = ['LINKEDIN_CAROUSEL', 'INSTAGRAM_CAROUSEL', 'INSTAGRAM_STORIES'] as const;
  type Format = typeof formats[number];
  let worker: DurableJobWorker;
  const provider = {
    async execute(_settings: unknown, _job: string, input: TelegramProviderInput, _signal: AbortSignal,
      before: () => Promise<void>, record: (id: string) => Promise<void>) {
      await before(); const workflowRunId = randomUUID(); await record(workflowRunId);
      return { workflowRunId, model: 'synthetic', output: { schemaVersion: 'adaptation-v1' as const, format: input.format,
        content: { text: 'Новий підпис до каруселі.', mappings: [] }, script: frames('AI кадр') } };
    },
    async resume() { throw new Error('Synthetic provider must not resume'); },
  };
  function frames(text: string): ScriptContent {
    return { frames: [{ id: randomUUID(), purpose: 'Вступ', text, visualHint: 'Великий заголовок', transition: 'Наступний кадр', mappings: [] },
      { id: randomUUID(), purpose: 'Висновок', text: 'Збережіть цю думку.', visualHint: 'Короткий висновок', transition: 'Завершення', mappings: [] }] };
  }
  async function brief(id: string, revision = 0, mode: 'CREATIVE' | 'FACTUAL' = 'CREATIVE', required: string[] = []) {
    return editorial.saveBrief(owner, id, { expectedRevision: revision, contentMode: mode, topic: 'Місто і простір',
      audience: 'Мешканці', centralMessage: 'Пояснити зміни', category: 'Місто', targetLength: 100, cta: '', exclusions: [], notes: '', requiredClaimRevisionIds: required });
  }
  async function caption(id: string, format: Format, mode: 'CREATIVE' | 'FACTUAL' = 'CREATIVE', content = { text: 'Ручний підпис.', mappings: [] as Array<{ startOffset: number; endOffset: number; quote: string; claimRevisionId: string; evidenceId: string }> }) {
    let state = await channels.get(owner, id, format);
    state = await channels.saveDraft(owner, id, { format, expectedRevision: state.adaptation?.revision ?? 0, inputMode: 'DIRECT', contentMode: mode, content });
    state = await channels.checkpoint(owner, id, { format, expectedRevision: state.adaptation!.revision });
    const row = state.adaptation!.revisions[0]!;
    return channels.review(owner, id, row.id, 'approve', { format, expectedRevision: state.adaptation!.revision,
      expectedReviewCounter: row.reviewCounter, acknowledgeUnmapped: true });
  }
  async function saveAndApprove(id: string, format: Format, content: ScriptContent) {
    let state = await scripts.get(owner, id, format);
    state = await scripts.saveDraft(owner, id, format, { expectedRevision: state.script?.revision ?? 0,
      expectedDraftCounter: state.script?.draft?.counter ?? 0, parentAdaptationRevisionId: state.parent!.id, content });
    state = await scripts.checkpoint(owner, id, format, { expectedRevision: state.script!.revision, expectedDraftCounter: state.script!.draft!.counter });
    const row = state.script!.revisions[0]!;
    return scripts.review(owner, id, format, row.id, 'approve', { expectedRevision: state.script!.revision, expectedReviewCounter: 0 });
  }
  async function packageFor(id: string, format: 'JSON' | 'MARKDOWN' | 'ZIP', targets: Array<{ format: 'LINKEDIN_CAROUSEL_SCRIPT' | 'INSTAGRAM_CAROUSEL_SCRIPT' | 'INSTAGRAM_STORIES_SCRIPT'; revisionId: string; reviewCounter: number }>) {
    const ready = await exports.readiness(owner, id);
    const frozen = await exports.freeze(owner, id, { expectedProjectRevision: ready.projectRevision, commandKey: randomUUID(), format, items: targets });
    await worker.process({ jobId: frozen.jobId, ordinal: 1 });
    return { id: frozen.exportId, download: await exports.download(owner, id, frozen.exportId) };
  }

  beforeAll(async () => {
    vi.stubEnv('DIFY_API_BASE_URL', 'https://dify.example.test/v1'); vi.stubEnv('DIFY_ADAPTATION_WORKFLOW_ID', randomUUID());
    vi.stubEnv('DIFY_ADAPTATION_CONFIG_SHA256', 'cdbf1b551e583edccf21865081ffedef6f018a12231f44dec538f7a2f1b81603');
    vi.stubEnv('DIFY_ADAPTATION_API_KEY', 'synthetic-key');
    await health.prisma.userProfile.createMany({ data: [owner, outsider].map(id => ({ id,
      externalProcessingNoticeVersion: EXTERNAL_PROCESSING_NOTICE.version, externalProcessingAcceptedAt: new Date() })) });
    await health.prisma.workspace.create({ data: { id: workspace, name: 'M4.2 synthetic', ownerId: owner,
      members: { create: { userId: owner } }, styles: { create: { revision: 1, createdBy: owner } } } });
    await health.prisma.project.createMany({ data: projects.map(id => ({ id, workspaceId: workspace, createdBy: owner, topic: 'M4.2', formats: [...formats] })) });
    await brief(project);
    worker = new DurableJobWorker(health.prisma, config.redisUrl, EXTERNAL_PROCESSING_NOTICE.version,
      [createTelegramJobHandler({ prisma: health.prisma, telegram: channels, scripts, factualBasis: facts, articles, provider,
        env: { NODE_ENV: 'test', DIFY_API_BASE_URL: process.env['DIFY_API_BASE_URL'], DIFY_ADAPTATION_WORKFLOW_ID: process.env['DIFY_ADAPTATION_WORKFLOW_ID'],
          DIFY_ADAPTATION_CONFIG_SHA256: process.env['DIFY_ADAPTATION_CONFIG_SHA256'], DIFY_ADAPTATION_API_KEY: 'synthetic-key' } }), createExportJobHandler(exports)],
      { queueName: `cf-m42-${randomUUID()}` });
    await worker.queue.waitUntilReady();
  });
  afterAll(async () => {
    await worker?.close();
    for (const row of await health.prisma.asset.findMany({ where: { projectId: { in: projects }, purpose: 'EXPORT' } })) await assets.remove(row.bucket, row.objectKey);
    const db = await migration.connect();
    const tables = ['ExportArtifact', 'ExportItem', 'ExportRequest', 'Asset', 'ScriptLanguageSuggestion', 'ScriptRevisionClaim', 'ScriptDraft', 'ScriptRevision', 'Script',
      'LanguageSuggestion', 'AdaptationRevisionClaim', 'AdaptationDraft', 'AdaptationRevision', 'Adaptation', 'ArticleVersionClaim', 'ArticleDraft', 'ArticleVersion', 'Article',
      'BriefRequiredClaim', 'BriefContextSnapshot', 'BriefRevision', 'Brief', 'BasisClaimEvidence', 'BasisClaim', 'FactualBasisRevision', 'ClaimEvidence', 'ClaimRevision', 'Claim',
      'SourceFragment', 'SourceSnapshot', 'Material'];
    try {
      await db.query('BEGIN');
      for (const table of tables) await db.query(`ALTER TABLE contextflow."${table}" DISABLE TRIGGER USER`);
      await db.query('UPDATE contextflow."Script" SET "currentApprovedRevisionId"=NULL WHERE "projectId"=ANY($1::uuid[])', [projects]);
      await db.query('UPDATE contextflow."Adaptation" SET "currentApprovedRevisionId"=NULL WHERE "projectId"=ANY($1::uuid[])', [projects]);
      await db.query('UPDATE contextflow."Brief" SET "currentRevisionId"=NULL WHERE "projectId"=ANY($1::uuid[])', [projects]);
      await db.query('UPDATE contextflow."Claim" SET "currentRevisionId"=NULL WHERE "projectId"=ANY($1::uuid[])', [projects]);
      await db.query('UPDATE contextflow."Material" SET "currentSnapshotId"=NULL WHERE "projectId"=ANY($1::uuid[])', [projects]);
      for (const table of tables) await db.query(`DELETE FROM contextflow."${table}" WHERE "projectId"=ANY($1::uuid[])`, [projects]);
      await db.query('DELETE FROM contextflow."AIExecution" WHERE "projectId"=ANY($1::uuid[])', [projects]);
      await db.query('DELETE FROM contextflow."JobAttempt" WHERE "jobId" IN (SELECT "id" FROM contextflow."Job" WHERE "projectId"=ANY($1::uuid[]))', [projects]);
      await db.query('DELETE FROM contextflow."Job" WHERE "projectId"=ANY($1::uuid[])', [projects]);
      await db.query('DELETE FROM contextflow."Project" WHERE "id"=ANY($1::uuid[])', [projects]);
      for (const table of ['WorkspaceStyleRevision', 'WorkspaceMember']) await db.query(`DELETE FROM contextflow."${table}" WHERE "workspaceId"=$1`, [workspace]);
      await db.query('DELETE FROM contextflow."Workspace" WHERE "id"=$1', [workspace]);
      await db.query('DELETE FROM contextflow."UserProfile" WHERE "id"=ANY($1::uuid[])', [[owner, outsider]]);
      for (const table of tables) await db.query(`ALTER TABLE contextflow."${table}" ENABLE TRIGGER USER`);
      await db.query('COMMIT');
    } catch (error) { await db.query('ROLLBACK'); throw error; }
    finally { db.release(); await migration.end(); await health.onModuleDestroy(); vi.unstubAllEnvs(); }
  });

  it('orders and independently approves all three scripts, exports JSON/Markdown/ZIP without Article or images', async () => {
    const targets = [];
    for (const format of formats) {
      await caption(project, format);
      const content = frames('Місто  змінюється.'); content.frames.reverse();
      const state = await saveAndApprove(project, format, content);
      const row = state.script!.revisions[0]!;
      expect(row.content).toEqual(content); expect(row.eligible).toBe(true);
      targets.push({ format: `${format}_SCRIPT` as 'LINKEDIN_CAROUSEL_SCRIPT' | 'INSTAGRAM_CAROUSEL_SCRIPT' | 'INSTAGRAM_STORIES_SCRIPT', revisionId: row.id, reviewCounter: 0 });
    }
    // Once the approved parent was inspected for this response, historical script
    // verification must reuse it instead of issuing the same expensive inspection again.
    const inspectParent = vi.spyOn(channels, 'inspectRevision');
    try {
      const state = await scripts.get(owner, project, formats[0]);
      expect(state.script?.revisions.length).toBeGreaterThan(0);
      expect(inspectParent).toHaveBeenCalledTimes(1);
    } finally { inspectParent.mockRestore(); }
    const json = await packageFor(project, 'JSON', [targets[0]!]);
    expect(JSON.parse(json.download.bytes.toString('utf8'))).toMatchObject({ frames: [{ purpose: 'Висновок' }, { purpose: 'Вступ' }] });
    const markdown = await packageFor(project, 'MARKDOWN', [targets[1]!]);
    expect(markdown.download.bytes.toString('utf8')).toContain('Кадр 2');
    expect(markdown.download.bytes.toString('utf8')).toContain('без перевіреної фактичної основи');
    const zip = await packageFor(project, 'ZIP', targets);
    expect(zipEntries(zip.download.bytes)).toEqual(['linkedin-carousel-script.json', 'linkedin-carousel-script.md', 'instagram-carousel-script.json',
      'instagram-carousel-script.md', 'instagram-stories-script.json', 'instagram-stories-script.md', 'manifest.json', 'sources.json']);
    expect(await health.prisma.article.count({ where: { projectId: project } })).toBe(0);
    expect(await health.prisma.outline.count({ where: { projectId: project } })).toBe(0);
    await expect(scripts.get(outsider, project, formats[0])).rejects.toMatchObject({ status: 404 });
    const selected = await scripts.get(owner, project, formats[2]);
    await health.prisma.project.update({ where: { id: project }, data: { formats: [formats[0], formats[1]] } });
    await expect(scripts.checkpoint(owner, project, formats[2], { expectedRevision: selected.script!.revision,
      expectedDraftCounter: selected.script!.draft!.counter })).rejects.toMatchObject({ status: 409 });
    await health.prisma.project.update({ where: { id: project }, data: { formats: [...formats] } });
  });

  it('applies exact frame typography with emoji, preserves approved bytes, rejects stale findings and counters', async () => {
    const format = formats[1]; let state = await scripts.get(owner, project, format);
    const original = state.script!.revisions[0]!;
    const content = frames('🙂 Місто  змінюється.');
    state = await scripts.saveDraft(owner, project, format, { expectedRevision: state.script!.revision, expectedDraftCounter: state.script!.draft!.counter,
      parentAdaptationRevisionId: state.parent!.id, content });
    state = await scripts.checkpoint(owner, project, format, { expectedRevision: state.script!.revision, expectedDraftCounter: state.script!.draft!.counter });
    const source = state.script!.revisions[0]!;
    const scan = await language.review(owner, project, { sourceRevisionId: source.id, expectedRevision: state.script!.revision });
    expect(scan.suggestions[0]).toMatchObject({ frameId: content.frames[0]!.id, startOffset: 8, originalText: '  ' });
    await language.accept(owner, project, { sourceRevisionId: source.id, expectedRevision: state.script!.revision, suggestionIds: [scan.suggestions[0]!.id] });
    await expect(language.accept(owner, project, { sourceRevisionId: source.id, expectedRevision: state.script!.revision, suggestionIds: [scan.suggestions[0]!.id] })).rejects.toMatchObject({ status: 409 });
    state = await scripts.get(owner, project, format);
    expect((state.script!.draft!.content as ScriptContent).frames[0]!.text).toBe('🙂 Місто змінюється.');
    expect(state.script!.revisions.find(row => row.id === original.id)!.content).toEqual(original.content);
    await expect(scripts.saveDraft(owner, project, format, { expectedRevision: state.script!.revision - 1, expectedDraftCounter: state.script!.draft!.counter,
      parentAdaptationRevisionId: state.parent!.id, content })).rejects.toMatchObject({ status: 409 });
  });

  it('atomically creates AI caption/script candidates without overwriting manual frames, then selectively applies with exact lineage', async () => {
    const format = formats[0], before = await scripts.get(owner, project, format), captionState = await channels.get(owner, project, format);
    const job = await channels.freezeTelegram(owner, project, { format, expectedRevision: captionState.adaptation!.revision,
      commandKey: randomUUID(), inputMode: 'DIRECT', contentMode: 'CREATIVE' }, telegramWorkflowRelease());
    await worker.process({ jobId: job.id, ordinal: 1 }); await worker.process({ jobId: job.id, ordinal: 1 });
    expect(await health.prisma.job.findUniqueOrThrow({ where: { id: job.id }, select: { status: true, errorCategory: true } })).toEqual({ status: 'SUCCEEDED', errorCategory: null });
    let state = await scripts.get(owner, project, format);
    expect(state.script!.draft!.content).toEqual(before.script!.draft!.content);
    const candidate = state.script!.revisions.find(row => row.jobId === job.id)!;
    expect(candidate).toMatchObject({ origin: 'AI', approvedAt: null, claimsSealed: true });
    expect(state.script!.revisions.filter(row => row.jobId === job.id)).toHaveLength(1);
    let channel = await channels.get(owner, project, format);
    const captionCandidate = channel.adaptation!.revisions.find(row => row.jobId === job.id)!;
    expect(candidate.parentAdaptationRevisionId).toBe(captionCandidate.id);
    channel = await channels.review(owner, project, captionCandidate.id, 'apply', { format, expectedRevision: channel.adaptation!.revision });
    await channels.review(owner, project, captionCandidate.id, 'approve', { format, expectedRevision: channel.adaptation!.revision, expectedReviewCounter: 0, acknowledgeUnmapped: true });
    await expect(scripts.review(owner, project, format, candidate.id, 'apply', { expectedRevision: state.script!.revision, frameIds: [(candidate.content as ScriptContent).frames[0]!.id] })).rejects.toMatchObject({ status: 409 });
    state = await scripts.saveDraft(owner, project, format, { expectedRevision: state.script!.revision, expectedDraftCounter: state.script!.draft!.counter,
      parentAdaptationRevisionId: captionCandidate.id, content: state.script!.draft!.content });
    const retained = (state.script!.draft!.content as ScriptContent).frames.map(frame => frame.id);
    state = await scripts.review(owner, project, format, candidate.id, 'apply', { expectedRevision: state.script!.revision,
      frameIds: [(candidate.content as ScriptContent).frames[0]!.id] });
    expect((state.script!.draft!.content as ScriptContent).frames.map(frame => frame.id).slice(0, retained.length)).toEqual(retained);
    expect((state.script!.draft!.content as ScriptContent).frames).toHaveLength(retained.length + 1);
    state = await scripts.review(owner, project, format, candidate.id, 'apply', { expectedRevision: state.script!.revision });
    expect(state.script!.draft!.content).toEqual(candidate.content);
    expect(state.script!.draft!.baseRevisionId).toBe(candidate.id);
  });

  it('requires review after caption receipt changes and preserves first approval through new checkpoints and stale withdrawal', async () => {
    const format = formats[2]; let state = await scripts.get(owner, project, format);
    const old = state.script!.revisions.find(row => row.id === state.script!.currentApprovedRevisionId)!;
    const bundle = await packageFor(project, 'JSON', [{ format: 'INSTAGRAM_STORIES_SCRIPT', revisionId: old.id, reviewCounter: 0 }]);
    await brief(project, 1);
    const channel = await channels.get(owner, project, format), parent = channel.adaptation!.revisions.find(row => row.id === channel.adaptation!.currentApprovedRevisionId)!;
    await channels.rereview(owner, project, parent.id, { format, expectedRevision: channel.adaptation!.revision, expectedReviewCounter: parent.reviewCounter, acknowledgeUnmapped: true });
    state = await scripts.get(owner, project, format);
    expect(state.script!.revisions.find(row => row.id === old.id)!.staleReasons).toContain('PARENT_REVIEW_CHANGED');
    await expect(exports.download(owner, project, bundle.id)).rejects.toMatchObject({ status: 409 });
    const refreshed = await saveAndApprove(project, format, old.content as ScriptContent);
    expect(refreshed.script!.currentApprovedRevisionId).not.toBe(old.id);
    expect(refreshed.script!.revisions.find(row => row.id === old.id)!.approvedAt).toEqual(old.approvedAt);
    await expect(health.prisma.$executeRaw`UPDATE contextflow."ScriptRevision" SET "approvedBy"=${outsider}::uuid WHERE "id"=${old.id}::uuid`).rejects.toBeTruthy();
    const withdrawn = await scripts.review(owner, project, format, old.id, 'withdraw', { expectedRevision: refreshed.script!.revision, reason: 'Заміна сценарію' });
    expect(withdrawn.script!.revisions.find(row => row.id === old.id)!.withdrawnAt).not.toBeNull();
  });

  it('exports real frame evidence with UTF-16 locators and blocks invalid evidence while keeping history inspectable', async () => {
    const text = 'Оновлення почнеться о 20:00.', materialId = randomUUID(), snapshotId = randomUUID(), fragment = importedFragments(text)[0]!;
    await health.prisma.material.create({ data: { id: materialId, projectId: factual, kind: 'TEXT', purpose: 'FACTUAL_SOURCE', label: 'Синтетичне джерело', createdBy: owner } });
    await health.prisma.sourceSnapshot.create({ data: { id: snapshotId, projectId: factual, materialId, sequence: 1, normalizedText: text,
      sha256: createHash('sha256').update(text).digest('hex'), bytes: Buffer.byteLength(text), origin: 'MANUAL_TEXT', createdBy: owner } });
    await health.prisma.sourceFragment.create({ data: { ...fragment, projectId: factual, snapshotId } });
    const claim = await facts.create(owner, factual, { wording: text, evidence: [{ snapshotId, fragmentId: fragment.id, startOffset: 0,
      endOffset: text.length, quote: text, sha256: fragment.sha256, relation: 'SUPPORTS' }] });
    await facts.review(owner, factual, claim.claim.id, claim.claim.currentRevision!.id, 'approve', { expectedRevision: claim.claim.revision });
    const evidence = claim.claim.currentRevision!.evidence[0]!, claimRevisionId = claim.claim.currentRevision!.id;
    const frameText = 'Сервіс працюватиме онлайн.', frameMaterial = randomUUID(), frameSnapshot = randomUUID(), frameFragment = importedFragments(frameText)[0]!;
    await health.prisma.material.create({ data: { id: frameMaterial, projectId: factual, kind: 'TEXT', purpose: 'FACTUAL_SOURCE', label: 'Джерело кадру', createdBy: owner } });
    await health.prisma.sourceSnapshot.create({ data: { id: frameSnapshot, projectId: factual, materialId: frameMaterial, sequence: 1, normalizedText: frameText,
      sha256: createHash('sha256').update(frameText).digest('hex'), bytes: Buffer.byteLength(frameText), origin: 'MANUAL_TEXT', createdBy: owner } });
    await health.prisma.sourceFragment.create({ data: { ...frameFragment, projectId: factual, snapshotId: frameSnapshot } });
    const frameClaim = await facts.create(owner, factual, { wording: frameText, evidence: [{ snapshotId: frameSnapshot, fragmentId: frameFragment.id,
      startOffset: 0, endOffset: frameText.length, quote: frameText, sha256: frameFragment.sha256, relation: 'SUPPORTS' }] });
    const frameReviewed = await facts.review(owner, factual, frameClaim.claim.id, frameClaim.claim.currentRevision!.id, 'approve', { expectedRevision: frameClaim.claim.revision });
    const frameRevisionId = frameClaim.claim.currentRevision!.id, frameEvidence = frameClaim.claim.currentRevision!.evidence[0]!;
    await facts.freezeBasis(owner, factual, { claimRevisionIds: [claimRevisionId, frameRevisionId] }); await brief(factual, 0, 'FACTUAL', [claimRevisionId]);
    const mapping = { startOffset: 0, endOffset: text.length, quote: text, claimRevisionId, evidenceId: evidence.id };
    await caption(factual, formats[0], 'FACTUAL', { text, mappings: [mapping] });
    const content = frames('🙂 ' + frameText); content.frames[0]!.mappings = [{ startOffset: 3, endOffset: 3 + frameText.length,
      quote: frameText, claimRevisionId: frameRevisionId, evidenceId: frameEvidence.id }];
    const state = await saveAndApprove(factual, formats[0], content), row = state.script!.revisions[0]!;
    const bundle = await packageFor(factual, 'JSON', [{ format: 'LINKEDIN_CAROUSEL_SCRIPT', revisionId: row.id, reviewCounter: 0 }]);
    const parsed = JSON.parse(bundle.download.bytes.toString('utf8')) as { sources: Array<{ materialLabel: string }>; frames: ScriptContent['frames'] };
    expect(parsed.sources.some(source => source.materialLabel === 'Синтетичне джерело')).toBe(true);
    expect(parsed.sources).toHaveLength(2);
    expect(parsed.frames[0]!.mappings[0]!.startOffset).toBe(3);
    await facts.freezeBasis(owner, factual, { claimRevisionIds: [claimRevisionId] }); await brief(factual, 1, 'FACTUAL', [claimRevisionId]);
    const currentCaption = await channels.get(owner, factual, formats[0]);
    await channels.rereview(owner, factual, currentCaption.adaptation!.currentApprovedRevisionId!, { format: formats[0],
      expectedRevision: currentCaption.adaptation!.revision, expectedReviewCounter: 0, acknowledgeUnmapped: true });
    await expect(scripts.saveDraft(owner, factual, formats[0], { expectedRevision: state.script!.revision, expectedDraftCounter: state.script!.draft!.counter,
      parentAdaptationRevisionId: row.parentAdaptationRevisionId, content })).rejects.toMatchObject({ status: 409 });
    await facts.invalidate(owner, factual, frameClaim.claim.id, frameEvidence.id, { expectedRevision: frameReviewed.claim.revision, reason: 'Нове рев’ю' });
    expect((await scripts.get(owner, factual, formats[0])).script!.revisions[0]!.eligible).toBe(false);
    expect((await exports.readiness(owner, factual)).items.find(item => item.format === 'LINKEDIN_CAROUSEL_SCRIPT')!.ready).toBe(false);
    await expect(exports.download(owner, factual, bundle.id)).rejects.toMatchObject({ status: 409 });
  });
});

function zipEntries(bytes: Buffer): string[] {
  const entries: string[] = []; let offset = 0;
  while (offset + 30 <= bytes.length && bytes.readUInt32LE(offset) === 0x04034b50) {
    const size = bytes.readUInt32LE(offset + 18), nameLength = bytes.readUInt16LE(offset + 26), extraLength = bytes.readUInt16LE(offset + 28);
    entries.push(bytes.subarray(offset + 30, offset + 30 + nameLength).toString('utf8')); offset += 30 + nameLength + extraLength + size;
  }
  return entries;
}
