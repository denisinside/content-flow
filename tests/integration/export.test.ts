import { createHash, randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ArticleService, DependencyHealthService, DurableJobService, EditorialService, ExportService,
  EXTERNAL_PROCESSING_NOTICE, FactualBasisService, importedFragments, JobFailure, loadRuntimeConfig, PrivateAssetStore,
  privateStorageConfig, TelegramService, createExportJobHandler } from '@contextflow/backend';
import type { JobContext, JobHandler } from '@contextflow/backend';

const LOCAL_EXPORT_NOTICE = EXTERNAL_PROCESSING_NOTICE.version;

describe('reviewed export packages and private delivery', () => {
  const config = loadRuntimeConfig();
  const health = new DependencyHealthService(config);
  const jobs = new DurableJobService(health.prisma, { noticeVersion: LOCAL_EXPORT_NOTICE, retryBaseMs: 0 });
  const facts = new FactualBasisService(health.prisma, jobs);
  const editorial = new EditorialService(health.prisma, jobs, facts);
  const articles = new ArticleService(health.prisma, jobs, facts);
  const telegram = new TelegramService(health.prisma, jobs, facts, articles);
  const assets = new PrivateAssetStore(privateStorageConfig({ NODE_ENV: 'test' }));
  const exports = new ExportService(health.prisma, jobs, articles, telegram, assets);
  const handler = createExportJobHandler(exports);
  const migration = new Pool({ connectionString: config.directDatabaseUrl, ssl: false, max: 2 });
  const owner = randomUUID(), outsider = randomUUID(), workspaceId = randomUUID();
  const mixedProject = randomUUID(), factualProject = randomUUID(), rollbackProject = randomUUID(), cancelProject = randomUUID(), articleOnlyProject = randomUUID();
  const projectIds = [mixedProject, factualProject, rollbackProject, cancelProject, articleOnlyProject];
  type JobClaim = NonNullable<Awaited<ReturnType<DurableJobService['claim']>>>;
  let setupCompleted = false;

  beforeAll(async () => {
    expect((await health.check()).status).toBe('ready');
    await health.prisma.userProfile.createMany({ data: [owner, outsider].map(id => ({ id,
      externalProcessingNoticeVersion: LOCAL_EXPORT_NOTICE, externalProcessingAcceptedAt: new Date() })) });
    await health.prisma.workspace.create({ data: { id: workspaceId, name: `Export TEST ${workspaceId}`, ownerId: owner,
      members: { create: [{ userId: owner }] }, styles: { create: { revision: 1, createdBy: owner, tone: 'Стриманий', brandbook: 'Лише синтетичні матеріали' } } } });
    await health.prisma.project.createMany({ data: [
      { id: mixedProject, workspaceId, createdBy: owner, topic: 'Partial selected export', formats: ['ARTICLE', 'TELEGRAM_POST'] },
      { id: factualProject, workspaceId, createdBy: owner, topic: 'Factual source export', formats: ['TELEGRAM_POST'] },
      { id: rollbackProject, workspaceId, createdBy: owner, topic: 'Failed database commit', formats: ['TELEGRAM_POST'] },
      { id: cancelProject, workspaceId, createdBy: owner, topic: 'Cancelled export', formats: ['TELEGRAM_POST'] },
      { id: articleOnlyProject, workspaceId, createdBy: owner, topic: 'Manual Article without Brief', formats: ['ARTICLE'] },
    ] });
    await editorial.saveBrief(owner, mixedProject, { expectedRevision: 0, contentMode: 'CREATIVE', topic: 'Синтетичне повідомлення',
      audience: 'Тестова аудиторія', centralMessage: 'Одна редакційна думка', category: 'Освіта', targetLength: 120,
      cta: '', exclusions: [], notes: '', requiredClaimRevisionIds: [] });
    await editorial.saveBrief(owner, cancelProject, { expectedRevision: 0, contentMode: 'CREATIVE', topic: 'Скасування',
      audience: 'Тестова аудиторія', centralMessage: 'Зупинити staged write', category: 'Освіта', targetLength: 120,
      cta: '', exclusions: [], notes: '', requiredClaimRevisionIds: [] });
    await editorial.saveBrief(owner, rollbackProject, { expectedRevision: 0, contentMode: 'CREATIVE', topic: 'Помилка транзакції',
      audience: 'Тестова аудиторія', centralMessage: 'Відкотити файл і метадані', category: 'Освіта', targetLength: 120,
      cta: '', exclusions: [], notes: '', requiredClaimRevisionIds: [] });
    setupCompleted = true;
  });

  async function makeTelegram(projectId: string, contentMode: 'FACTUAL' | 'CREATIVE', content: { text: string; mappings: Array<{
    startOffset: number; endOffset: number; quote: string; claimRevisionId: string; evidenceId: string;
  }> }) {
    const saved = await telegram.saveDraft(owner, projectId, { expectedRevision: 0, inputMode: 'DIRECT', contentMode, includeLink: false, content });
    if (!saved.adaptation) throw new Error('Telegram adaptation was not created');
    const checkpointed = await telegram.checkpoint(owner, projectId, { expectedRevision: saved.adaptation.revision });
    const revision = checkpointed.adaptation?.revisions[0];
    if (!revision || !checkpointed.adaptation) throw new Error('Telegram checkpoint was not created');
    await telegram.review(owner, projectId, revision.id, 'approve', { expectedRevision: checkpointed.adaptation.revision,
      expectedReviewCounter: 0, acknowledgeUnmapped: contentMode === 'CREATIVE' });
    return revision;
  }

  function articleContent(text: string): { title: string; document: { type: 'doc'; content: Array<{ type: 'paragraph'; content: Array<{ type: 'text'; text: string }> }> } } {
    return { title: 'Синтетична стаття', document: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] } };
  }

  async function approveArticle(projectId: string, text: string) {
    const saved = await articles.saveDraft(owner, projectId, { expectedRevision: 0, contentMode: 'CREATIVE', content: articleContent(text) });
    if (!saved.article) throw new Error('Article draft was not created');
    const checkpointed = await articles.checkpoint(owner, projectId, { expectedRevision: saved.article.revision });
    const version = checkpointed.article?.versions[0];
    if (!version || !checkpointed.article) throw new Error('Article checkpoint was not created');
    const approved = await articles.review(owner, projectId, version.id, 'approve', { expectedRevision: checkpointed.article.revision, acknowledgeUnmapped: true });
    return { version, article: approved.article! };
  }

  async function executeClaimed(jobId: string) {
    const claim = await jobs.claim(jobId, 1, `export-test-${randomUUID()}`);
    if (!claim) throw new Error('Export job was not claimable');
    const context: JobContext = { job: claim.job, attempt: claim.attempt, signal: new AbortController().signal,
      recordSubmissionIntent: async () => {}, recordProviderRun: async () => {}, setProgress: async () => {} };
    const stage = await handler.execute(context);
    return { claim, context, stage };
  }

  function contextFor(claim: Pick<JobClaim, 'job' | 'attempt'>, signal = new AbortController().signal): JobContext {
    return { job: claim.job, attempt: claim.attempt, signal,
      recordSubmissionIntent: async () => {}, recordProviderRun: async () => {}, setProgress: async () => {} };
  }

  async function commitClaimed(claim: Pick<JobClaim, 'job' | 'attempt'>, stage: unknown) {
    await jobs.succeed(claim.job, claim.attempt, handler, stage);
    await handler.completed?.(contextFor(claim), stage);
  }

  async function cleanupFixture() {
    const stored = await health.prisma.asset.findMany({ where: { projectId: { in: projectIds }, purpose: 'EXPORT' }, select: { bucket: true, objectKey: true } });
    await Promise.all(stored.map(row => assets.remove(row.bucket, row.objectKey).catch(() => undefined)));
    const db = await migration.connect();
    const ownTables = ['ExportArtifact', 'ExportItem', 'ExportRequest', 'Asset', 'AdaptationRevisionClaim', 'AdaptationDraft',
      'AdaptationRevision', 'Adaptation', 'ArticleVersionClaim', 'ArticleDraft', 'ArticleVersion', 'Article', 'BriefRequiredClaim', 'BriefContextSnapshot', 'BriefRevision', 'Brief', 'BasisClaimEvidence',
      'BasisClaim', 'FactualBasisRevision', 'ClaimEvidence', 'ClaimRevision', 'Claim', 'SourceFragment', 'SourceSnapshot', 'Material'];
    try {
      await db.query('BEGIN');
      for (const table of ownTables) await db.query(`ALTER TABLE contextflow."${table}" DISABLE TRIGGER USER`);
      await db.query('ALTER TABLE contextflow."Brief" DISABLE TRIGGER "Brief_pointer_guard"');
      await db.query('UPDATE contextflow."ExportArtifact" SET "id"="id" WHERE false');
      for (const projectId of projectIds) {
        await db.query('UPDATE contextflow."Article" SET "currentApprovedVersionId"=NULL,"revision"="revision"+1 WHERE "projectId"=$1', [projectId]);
        await db.query('UPDATE contextflow."Adaptation" SET "currentApprovedRevisionId"=NULL,"revision"="revision"+1 WHERE "projectId"=$1', [projectId]);
        await db.query('UPDATE contextflow."Brief" SET "currentRevisionId"=NULL,"revision"="revision"+1 WHERE "projectId"=$1', [projectId]);
        await db.query('UPDATE contextflow."Claim" SET "currentRevisionId"=NULL,"revision"="revision"+1 WHERE "projectId"=$1', [projectId]);
        await db.query('UPDATE contextflow."Material" SET "currentSnapshotId"=NULL,"revision"="revision"+1 WHERE "projectId"=$1', [projectId]);
      }
      for (const table of ['ExportArtifact', 'ExportItem', 'ExportRequest', 'Asset']) await db.query(`DELETE FROM contextflow."${table}" WHERE "projectId"=ANY($1::uuid[])`, [projectIds]);
      await db.query('DELETE FROM contextflow."JobAttempt" WHERE "jobId" IN (SELECT "id" FROM contextflow."Job" WHERE "projectId"=ANY($1::uuid[]))', [projectIds]);
      await db.query('DELETE FROM contextflow."Job" WHERE "projectId"=ANY($1::uuid[])', [projectIds]);
      for (const table of ['AdaptationRevisionClaim', 'AdaptationDraft', 'AdaptationRevision', 'Adaptation', 'ArticleVersionClaim', 'ArticleDraft', 'ArticleVersion', 'Article', 'BriefRequiredClaim',
        'BriefContextSnapshot', 'BriefRevision', 'Brief', 'BasisClaimEvidence', 'BasisClaim', 'FactualBasisRevision', 'ClaimEvidence',
        'ClaimRevision', 'Claim', 'SourceFragment', 'SourceSnapshot', 'Material']) {
        await db.query(`DELETE FROM contextflow."${table}" WHERE "projectId"=ANY($1::uuid[])`, [projectIds]);
      }
      await db.query('DELETE FROM contextflow."Project" WHERE "id"=ANY($1::uuid[])', [projectIds]);
      await db.query('DELETE FROM contextflow."WorkspaceStyleRevision" WHERE "workspaceId"=$1', [workspaceId]);
      await db.query('DELETE FROM contextflow."WorkspaceMember" WHERE "workspaceId"=$1', [workspaceId]);
      await db.query('DELETE FROM contextflow."Workspace" WHERE "id"=$1', [workspaceId]);
      await db.query('DELETE FROM contextflow."PrivateObjectDeletion" WHERE "requestedBy"=ANY($1::uuid[]) AND "state"=\'DELETED\'', [[owner, outsider]]);
      await db.query('DELETE FROM contextflow."UserProfile" WHERE "id"=ANY($1::uuid[])', [[owner, outsider]]);
      await db.query('ALTER TABLE contextflow."Brief" ENABLE TRIGGER "Brief_pointer_guard"');
      for (const table of ownTables) await db.query(`ALTER TABLE contextflow."${table}" ENABLE TRIGGER USER`);
      await db.query('COMMIT');
    } catch (error) { await db.query('ROLLBACK'); throw error; }
    finally { db.release(); }
  }

  afterAll(async () => {
    if (setupCompleted) await cleanupFixture();
    await migration.end();
    await health.onModuleDestroy();
  });

  it('exports a manually approved Article with a null Brief parent and records no unrelated Brief provenance', async () => {
    const content = 'Абзац без залежності від редакційного брифу.';
    const { version } = await approveArticle(articleOnlyProject, content);
    await health.prisma.userProfile.update({ where: { id: owner }, data: { externalProcessingNoticeVersion: null, externalProcessingAcceptedAt: null } });
    try {
      const ready = await exports.readiness(owner, articleOnlyProject);
      expect(ready).toMatchObject({ ready: true, items: [expect.objectContaining({ format: 'ARTICLE', revisionId: version.id, ready: true })] });
      const frozen = await exports.freeze(owner, articleOnlyProject, { expectedProjectRevision: ready.projectRevision, commandKey: randomUUID(), format: 'TXT',
        items: [{ format: 'ARTICLE', revisionId: version.id, reviewCounter: 0 }] });
      const request = await health.prisma.exportRequest.findUniqueOrThrow({ where: { id: frozen.exportId } });
      const manifest = request.manifest as { items: Array<{ provenance: { originalInputs: Record<string, unknown>; reviewedTuple: Record<string, unknown> | null; effectiveDependencies: { brief: { id: string } | null } } }> };
      expect(manifest.items[0]?.provenance.originalInputs).toMatchObject({ briefRevisionId: null, briefSha256: null, basisRevisionId: null, outlineRevisionId: null });
      expect(manifest.items[0]?.provenance).toMatchObject({ reviewedTuple: null, effectiveDependencies: { brief: null } });
      const claimed = await executeClaimed(frozen.jobId);
      await commitClaimed(claimed.claim, claimed.stage);
      const downloaded = await exports.download(owner, articleOnlyProject, frozen.exportId);
      expect(downloaded.filename).toBe('article.txt');
      expect(downloaded.bytes.toString('utf8')).toContain(content);
      expect(downloaded.bytes.toString('utf8')).toContain('без перевіреної фактичної основи');
    } finally {
      await health.prisma.userProfile.update({ where: { id: owner }, data: { externalProcessingNoticeVersion: LOCAL_EXPORT_NOTICE, externalProcessingAcceptedAt: new Date() } });
    }
  });

  it('exports a selected Telegram revision without an unselected Article, freezes provenance, replays idempotently, and denies nonmembers', async () => {
    const text = 'Зустрінемося о 18:30 біля бібліотеки.';
    const revision = await makeTelegram(mixedProject, 'CREATIVE', { text, mappings: [] });
    const ready = await exports.readiness(owner, mixedProject);
    expect(ready.ready).toBe(false);
    expect(ready.items).toEqual(expect.arrayContaining([
      expect.objectContaining({ format: 'ARTICLE', ready: false, reasons: expect.arrayContaining(['APPROVAL_REQUIRED']) }),
      expect.objectContaining({ format: 'TELEGRAM_POST', revisionId: revision.id, ready: true, reasons: [] }),
    ]));

    const commandKey = randomUUID();
    const input = { expectedProjectRevision: ready.projectRevision, commandKey, format: 'ZIP' as const,
      items: [{ format: 'TELEGRAM_POST' as const, revisionId: revision.id, reviewCounter: 0 }] };
    const first = await exports.freeze(owner, mixedProject, input);
    expect(await exports.freeze(owner, mixedProject, input)).toEqual(first);
    await expect(exports.freeze(owner, mixedProject, { ...input, format: 'TXT' })).rejects.toMatchObject({ status: 409 });

    const manifestRow = await health.prisma.exportRequest.findUniqueOrThrow({ where: { id: first.exportId } });
    const manifest = manifestRow.manifest as { items: unknown[]; projectRevision: number; format: string; sources: unknown[] };
    expect(manifest).toMatchObject({ projectRevision: ready.projectRevision, format: 'ZIP', sources: [] });
    expect(manifest.items).toHaveLength(1);
    expect(JSON.stringify(manifest.items)).toContain(revision.id);

    // The export is tied to selected immutable outputs. A later draft and unrelated Project edit do not stale it.
    const current = await telegram.get(owner, mixedProject);
    await telegram.saveDraft(owner, mixedProject, { expectedRevision: current.adaptation!.revision, inputMode: 'DIRECT', contentMode: 'CREATIVE',
      includeLink: false, content: { text: 'Пізніша чернетка не замінює погоджену версію.', mappings: [] } });
    const latestProject = await health.prisma.project.findUniqueOrThrow({ where: { id: mixedProject }, select: { revision: true } });
    await health.prisma.project.update({ where: { id: mixedProject }, data: { topic: 'Окрема зміна проєкту', revision: latestProject.revision + 1 } });
    // Replaying the original command returns its immutable request despite that unrelated Project revision change.
    expect(await exports.freeze(owner, mixedProject, input)).toEqual(first);

    const claimed = await executeClaimed(first.jobId);
    await commitClaimed(claimed.claim, claimed.stage);
    const downloaded = await exports.download(owner, mixedProject, first.exportId);
    expect(downloaded.filename).toBe('contextflow-export.zip');
    expect(downloaded.contentType).toBe('application/zip');
    expect(downloaded.bytes.readUInt32LE(0)).toBe(0x04034b50);
    const entries = zipLocalEntries(downloaded.bytes);
    expect(entries.map(entry => entry.name)).toEqual(['telegram.txt', 'telegram.md', 'manifest.json', 'sources.json']);
    expect(entries.find(entry => entry.name === 'telegram.txt')?.bytes.toString('utf8')).toContain(text);
    expect(entries.find(entry => entry.name === 'telegram.txt')?.bytes.toString('utf8')).toContain('без перевіреної фактичної основи');
    expect(entries.find(entry => entry.name === 'manifest.json')?.bytes.toString('utf8')).toContain(revision.id);
    expect(entries.find(entry => entry.name === 'sources.json')?.bytes.toString('utf8')).toBe('[]\n');
    const sealedItem = await health.prisma.exportItem.findFirstOrThrow({ where: { requestId: first.exportId } });
    await expect(migration.query('UPDATE contextflow."ExportItem" SET "ordinal"="ordinal"+1 WHERE "id"=$1', [sealedItem.id]))
      .rejects.toMatchObject({ code: '23514' });
    const artifact = await health.prisma.exportArtifact.findUniqueOrThrow({ where: { requestId: first.exportId } });
    await expect(migration.query('UPDATE contextflow."ExportArtifact" SET "filename"=\'changed.zip\' WHERE "id"=$1', [artifact.id]))
      .rejects.toMatchObject({ code: '23514' });
    await expect(migration.query(`INSERT INTO contextflow."ExportItem" ("id","projectId","requestId","ordinal","adaptationRevisionId")
      VALUES ($1,$2,$3,1,$4)`, [randomUUID(), mixedProject, first.exportId, randomUUID()])).rejects.toMatchObject({ code: '23514' });
    await expect(exports.download(outsider, mixedProject, first.exportId)).rejects.toMatchObject({ status: 404 });
    await expect(exports.assertDownloadReadable(owner, randomUUID(), first.exportId)).rejects.toMatchObject({ status: 404 });

    // Recheck Workspace membership after bytes are read, so a session revoked during storage I/O cannot receive them.
    const revocationStore = new class extends PrivateAssetStore {
      override async read(bucket: string, objectKey: string, expectedSha256: string) {
        const bytes = await super.read(bucket, objectKey, expectedSha256);
        await health.prisma.workspaceMember.update({ where: { workspaceId_userId: { workspaceId, userId: owner } }, data: { leftAt: new Date() } });
        return bytes;
      }
    }(privateStorageConfig({ NODE_ENV: 'test' }));
    const revocationExports = new ExportService(health.prisma, jobs, articles, telegram, revocationStore);
    await expect(revocationExports.download(owner, mixedProject, first.exportId)).rejects.toMatchObject({ status: 404 });
    await health.prisma.workspaceMember.update({ where: { workspaceId_userId: { workspaceId, userId: owner } }, data: { leftAt: null } });
    const finalState = await exports.readiness(owner, mixedProject);
    expect(finalState.exports).toEqual(expect.arrayContaining([expect.objectContaining({ id: first.exportId, status: 'READY' })]));
  });

  it('captures only the selected factual evidence edge and stops delivery after that evidence is invalidated', async () => {
    const sourceText = 'У бібліотеці працюють до 18:30.';
    const materialId = randomUUID(), snapshotId = randomUUID(), fragment = importedFragments(sourceText)[0]!;
    await health.prisma.material.create({ data: { id: materialId, projectId: factualProject, kind: 'TEXT', purpose: 'FACTUAL_SOURCE',
      label: 'Синтетичне джерело', createdBy: owner } });
    await health.prisma.sourceSnapshot.create({ data: { id: snapshotId, projectId: factualProject, materialId, sequence: 1,
      normalizedText: sourceText, sha256: createHash('sha256').update(sourceText).digest('hex'), bytes: Buffer.byteLength(sourceText),
      origin: 'MANUAL_TEXT', createdBy: owner } });
    await health.prisma.sourceFragment.create({ data: { ...fragment, projectId: factualProject, snapshotId } });
    const created = await facts.create(owner, factualProject, { wording: sourceText, evidence: [{ snapshotId, fragmentId: fragment.id,
      startOffset: 0, endOffset: sourceText.length, quote: sourceText, sha256: fragment.sha256, relation: 'SUPPORTS' }] });
    const claim = created.claim.currentRevision!, evidence = claim.evidence[0]!;
    const approved = await facts.review(owner, factualProject, created.claim.id, claim.id, 'approve', { expectedRevision: created.claim.revision });
    await facts.freezeBasis(owner, factualProject, { claimRevisionIds: [claim.id] });
    await editorial.saveBrief(owner, factualProject, { expectedRevision: 0, contentMode: 'FACTUAL', topic: 'Години роботи', audience: 'Читачі',
      centralMessage: 'Точний час закриття', category: 'Освіта', targetLength: 100, cta: '', exclusions: [], notes: '', requiredClaimRevisionIds: [claim.id] });
    const revision = await makeTelegram(factualProject, 'FACTUAL', { text: sourceText, mappings: [{ startOffset: 0, endOffset: sourceText.length,
      quote: sourceText, claimRevisionId: claim.id, evidenceId: evidence.id }] });
    const ready = await exports.readiness(owner, factualProject);
    expect(ready).toMatchObject({ ready: true, items: [expect.objectContaining({ format: 'TELEGRAM_POST', revisionId: revision.id, ready: true })] });
    const frozen = await exports.freeze(owner, factualProject, { expectedProjectRevision: ready.projectRevision, commandKey: randomUUID(), format: 'ZIP',
      items: [{ format: 'TELEGRAM_POST', revisionId: revision.id, reviewCounter: 0 }] });
    const request = await health.prisma.exportRequest.findUniqueOrThrow({ where: { id: frozen.exportId } });
    const manifest = request.manifest as { sources: Array<{ evidenceId: string; snapshotId: string; claimRevisionId: string }> };
    expect(manifest.sources).toEqual([expect.objectContaining({ evidenceId: evidence.id, snapshotId, claimRevisionId: claim.id })]);
    const claimed = await executeClaimed(frozen.jobId);
    await commitClaimed(claimed.claim, claimed.stage);
    await health.prisma.material.update({ where: { id: materialId }, data: { label: 'Перейменоване синтетичне джерело', revision: { increment: 1 } } });
    expect((await exports.readiness(owner, factualProject)).exports).toEqual(expect.arrayContaining([expect.objectContaining({ id: frozen.exportId, status: 'READY' })]));
    expect((await exports.download(owner, factualProject, frozen.exportId)).filename).toBe('contextflow-export.zip');
    await facts.invalidate(owner, factualProject, created.claim.id, evidence.id, { expectedRevision: approved.claim.revision, reason: 'Синтетичне відкликання доказу' });
    await expect(exports.download(owner, factualProject, frozen.exportId)).rejects.toMatchObject({ status: 409 });
    expect((await exports.readiness(owner, factualProject)).exports).toEqual(expect.arrayContaining([expect.objectContaining({ id: frozen.exportId, status: 'OBSOLETE' })]));
  });

  it('cleans staged bytes and commits no artifact when a selected required Brief changes during the build', async () => {
    const revision = (await telegram.get(owner, mixedProject)).adaptation!.revisions[0]!;
    const briefState = await editorial.get(owner, mixedProject);
    await editorial.saveBrief(owner, mixedProject, { expectedRevision: briefState.brief!.revision, contentMode: 'CREATIVE', topic: 'Перша зміна для re-review',
      audience: 'Тестова аудиторія', centralMessage: 'Одна редакційна думка', category: 'Освіта', targetLength: 120,
      cta: '', exclusions: [], notes: '', requiredClaimRevisionIds: [] });
    const adaptationState = await telegram.get(owner, mixedProject);
    await telegram.rereview(owner, mixedProject, revision.id, { expectedRevision: adaptationState.adaptation!.revision,
      expectedReviewCounter: revision.reviewCounter, acknowledgeUnmapped: true });
    const rereviewed = (await telegram.get(owner, mixedProject)).adaptation!.revisions.find(row => row.id === revision.id)!;
    const ready = await exports.readiness(owner, mixedProject);
    const frozen = await exports.freeze(owner, mixedProject, { expectedProjectRevision: ready.projectRevision, commandKey: randomUUID(), format: 'TXT',
      items: [{ format: 'TELEGRAM_POST', revisionId: revision.id, reviewCounter: rereviewed.reviewCounter }] });
    const staged = await executeClaimed(frozen.jobId);
    const before = await health.prisma.exportArtifact.count({ where: { requestId: frozen.exportId } });
    expect(before).toBe(0);
    const latestBrief = await editorial.get(owner, mixedProject);
    await editorial.saveBrief(owner, mixedProject, { expectedRevision: latestBrief.brief!.revision, contentMode: 'CREATIVE', topic: 'Brief змінився після побудови',
      audience: 'Тестова аудиторія', centralMessage: 'Одна редакційна думка', category: 'Освіта', targetLength: 120,
      cta: '', exclusions: [], notes: '', requiredClaimRevisionIds: [] });
    await expect(commitClaimed(staged.claim, staged.stage)).rejects.toMatchObject({ name: 'JobFailure', category: 'INPUTS_CHANGED' });
    const error = new JobFailure('INPUTS_CHANGED', 'KNOWN_FAILED');
    await jobs.fail(staged.claim.job, staged.claim.attempt, error);
    await handler.failed?.(staged.context, error);
    expect(await health.prisma.exportArtifact.count({ where: { requestId: frozen.exportId } })).toBe(0);
    expect((await jobs.get(owner, mixedProject, frozen.jobId)).status).toBe('FAILED');
    const output = staged.stage as { bucket: string; objectKey: string; sha256: string };
    await expect(assets.read(output.bucket, output.objectKey, output.sha256)).rejects.toThrow();
  });

  it('rolls back the Asset and Artifact if the outer job transaction fails after handler commit', async () => {
    const revision = await makeTelegram(rollbackProject, 'CREATIVE', { text: 'Синтетичний текст для перевірки rollback.', mappings: [] });
    const ready = await exports.readiness(owner, rollbackProject);
    const frozen = await exports.freeze(owner, rollbackProject, { expectedProjectRevision: ready.projectRevision, commandKey: randomUUID(), format: 'TXT',
      items: [{ format: 'TELEGRAM_POST', revisionId: revision.id, reviewCounter: 0 }] });
    const staged = await executeClaimed(frozen.jobId);
    const failingHandler: JobHandler = {
      operation: 'EXPORT_BUILD',
      execute: context => handler.execute(context),
      async commit(tx, result, job) {
        await handler.commit(tx, result, job);
        throw new Error('Synthetic outer transaction failure after artifact insert');
      },
      async failed(context, error) { await handler.failed?.(context, error); },
    };
    await expect(jobs.succeed(staged.claim.job, staged.claim.attempt, failingHandler, staged.stage)).rejects.toThrow('Synthetic outer transaction failure');
    await jobs.fail(staged.claim.job, staged.claim.attempt, new Error('Synthetic outer transaction failure'));
    await failingHandler.failed?.(staged.context, new Error('Synthetic outer transaction failure'));
    expect(await health.prisma.exportArtifact.count({ where: { requestId: frozen.exportId } })).toBe(0);
    expect(await health.prisma.asset.count({ where: { projectId: rollbackProject, purpose: 'EXPORT' } })).toBe(0);
    expect((await jobs.get(owner, rollbackProject, frozen.jobId)).status).toBe('FAILED');
    const output = staged.stage as { bucket: string; objectKey: string; sha256: string };
    await expect(assets.read(output.bucket, output.objectKey, output.sha256)).rejects.toThrow();
  });

  it('removes a private object when cancellation arrives during the storage write', async () => {
    const text = 'Запис, який буде скасовано під час збереження.';
    const revision = await makeTelegram(cancelProject, 'CREATIVE', { text, mappings: [] });
    const ready = await exports.readiness(owner, cancelProject);
    const frozen = await exports.freeze(owner, cancelProject, { expectedProjectRevision: ready.projectRevision, commandKey: randomUUID(), format: 'TXT',
      items: [{ format: 'TELEGRAM_POST', revisionId: revision.id, reviewCounter: 0 }] });
    let markStarted!: () => void, releaseWrite!: () => void;
    const started = new Promise<void>(resolve => { markStarted = resolve; });
    const writeGate = new Promise<void>(resolve => { releaseWrite = resolve; });
    const delayedStore = new class extends PrivateAssetStore {
      readonly stagedAssetIds: string[] = [];
      stagedSha256 = '';
      override async putExport(projectId: string, assetId: string, bytes: Buffer) {
        this.stagedAssetIds.push(assetId);
        this.stagedSha256 = createHash('sha256').update(bytes).digest('hex');
        markStarted();
        await writeGate;
        return super.putExport(projectId, assetId, bytes);
      }
    }(privateStorageConfig({ NODE_ENV: 'test' }));
    const delayedExports = new ExportService(health.prisma, jobs, articles, telegram, delayedStore);
    const delayedHandler = createExportJobHandler(delayedExports);
    const claim = await jobs.claim(frozen.jobId, 1, `export-cancel-${randomUUID()}`);
    if (!claim) throw new Error('Export job was not claimable for cancellation test');
    const controller = new AbortController();
    const context = contextFor(claim, controller.signal);
    const pending = delayedHandler.execute(context);
    await started;
    await jobs.cancel(owner, cancelProject, frozen.jobId);
    controller.abort();
    releaseWrite();
    await expect(pending).rejects.toMatchObject({ name: 'JobFailure', category: 'CANCELLED' });
    await delayedHandler.failed?.(context, new JobFailure('CANCELLED', 'NOT_SUBMITTED'));
    const assetId = delayedStore.stagedAssetIds[0];
    expect(assetId).toBeDefined();
    await expect(assets.read(delayedStore.config.bucket, `${cancelProject}/exports/${assetId}`, delayedStore.stagedSha256)).rejects.toThrow();
    expect(await health.prisma.asset.count({ where: { projectId: cancelProject, purpose: 'EXPORT' } })).toBe(0);
    expect(await health.prisma.exportArtifact.count({ where: { requestId: frozen.exportId } })).toBe(0);
    expect((await jobs.get(owner, cancelProject, frozen.jobId)).status).toBe('CANCELLED');
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
