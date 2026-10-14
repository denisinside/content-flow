import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  ArticleService, DependencyHealthService, DurableJobService, EditorialService, ExportService,
  EXTERNAL_PROCESSING_NOTICE, FactualBasisService, JobFailure, loadRuntimeConfig, PrivateAssetStore,
  PrivateObjectCleanup, privateStorageConfig, ScriptService, TelegramService, VisualRenderer, VisualService, createExportJobHandler,
} from '@contextflow/backend';
import type { JobContext } from '@contextflow/backend';
import { compositionSchema } from '../../packages/visuals/src/index.js';

describe('M6.2 private storage and partial export faults', () => {
  const config = loadRuntimeConfig(), health = new DependencyHealthService(config);
  const jobs = new DurableJobService(health.prisma, { noticeVersion: EXTERNAL_PROCESSING_NOTICE.version });
  const facts = new FactualBasisService(health.prisma, jobs), editorial = new EditorialService(health.prisma, jobs, facts);
  const articles = new ArticleService(health.prisma, jobs, facts), channels = new TelegramService(health.prisma, jobs, facts, articles);
  const scripts = new ScriptService(health.prisma, channels), renderer = new VisualRenderer();
  const assets = new PrivateAssetStore(privateStorageConfig({ NODE_ENV: 'test' }));
  const visuals = new VisualService(health.prisma, channels, scripts, renderer, assets);
  const exports = new ExportService(health.prisma, jobs, articles, channels, assets, visuals);
  const handler = createExportJobHandler(exports);
  const migration = new Pool({ connectionString: config.directDatabaseUrl, ssl: false, max: 2 });
  const owner = randomUUID(), workspace = randomUUID(), project = randomUUID();
  const pngSignature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  let fixtureCreated = false;
  let captionSerial = 0;

  async function approveCaption(format: 'LINKEDIN_COVER' | 'LINKEDIN_CAROUSEL') {
    const current = await channels.get(owner, project, format);
    captionSerial++;
    let state = await channels.saveDraft(owner, project, { format, expectedRevision: current.adaptation?.revision ?? 0,
      inputMode: 'DIRECT', contentMode: 'CREATIVE', content: { text: `Незалежний погоджений текст ${captionSerial}.`, mappings: [],
        ...(format === 'LINKEDIN_COVER' ? { cover: { text: 'Заголовок', instruction: 'Редакційний макет' } } : {}) } });
    state = await channels.checkpoint(owner, project, { format, expectedRevision: state.adaptation!.revision });
    const revision = state.adaptation!.revisions[0]!;
    await channels.review(owner, project, revision.id, 'approve', { format, expectedRevision: state.adaptation!.revision,
      expectedReviewCounter: revision.reviewCounter, acknowledgeUnmapped: true });
    return revision;
  }

  async function runBuild(exportId: string, jobId: string) {
    const claim = await jobs.claim(jobId, 1, `m62-storage-${randomUUID()}`);
    if (!claim) throw new Error('Synthetic export job was not claimable');
    const context: JobContext = { job: claim.job, attempt: claim.attempt, signal: new AbortController().signal,
      recordSubmissionIntent: async () => {}, recordProviderRun: async () => {}, setProgress: async () => {} };
    const stage = await handler.execute(context);
    await jobs.succeed(claim.job, claim.attempt, handler, stage);
    await handler.completed?.(context, stage);
    return exports.download(owner, project, exportId);
  }

  async function failBuild(jobId: string) {
    const claim = await jobs.claim(jobId, 1, `m62-storage-failed-${randomUUID()}`);
    if (!claim) throw new Error('Synthetic export job was not claimable');
    const context: JobContext = { job: claim.job, attempt: claim.attempt, signal: new AbortController().signal,
      recordSubmissionIntent: async () => {}, recordProviderRun: async () => {}, setProgress: async () => {} };
    let failure: unknown;
    try { await handler.execute(context); } catch (error) { failure = error; }
    if (!(failure instanceof JobFailure)) throw new Error('Synthetic export did not fail with a durable job error');
    await jobs.fail(claim.job, claim.attempt, failure);
    await handler.failed?.(context, failure);
    return failure;
  }

  beforeAll(async () => {
    expect((await health.check()).status).toBe('ready');
    await health.prisma.userProfile.create({ data: { id: owner, externalProcessingNoticeVersion: EXTERNAL_PROCESSING_NOTICE.version,
      externalProcessingAcceptedAt: new Date() } });
    await health.prisma.workspace.create({ data: { id: workspace, name: `M6.2 synthetic ${workspace}`, ownerId: owner,
      members: { create: [{ userId: owner }] }, styles: { create: { revision: 1, createdBy: owner } } } });
    await health.prisma.project.create({ data: { id: project, workspaceId: workspace, createdBy: owner, topic: 'Synthetic storage recovery',
      formats: ['LINKEDIN_COVER', 'LINKEDIN_CAROUSEL'] } });
    fixtureCreated = true;
    await editorial.saveBrief(owner, project, { expectedRevision: 0, contentMode: 'CREATIVE', topic: 'Місто', audience: 'Редактор',
      centralMessage: 'Текст і візуал мають незалежну готовність', category: 'Синтетична перевірка', targetLength: 100, cta: '',
      exclusions: [], notes: '', requiredClaimRevisionIds: [] });
    await approveCaption('LINKEDIN_COVER');
    await approveCaption('LINKEDIN_CAROUSEL');
    let script = await scripts.get(owner, project, 'LINKEDIN_CAROUSEL');
    script = await scripts.saveDraft(owner, project, 'LINKEDIN_CAROUSEL', { expectedRevision: 0, expectedDraftCounter: 0,
      parentAdaptationRevisionId: script.parent!.id, content: { frames: ['Вступ', 'Висновок'].map(purpose => ({ id: randomUUID(), purpose,
        text: `${purpose}: погоджений сценарний текст.`, visualHint: 'Редакційний фон', transition: 'Далі', mappings: [] })) } });
    script = await scripts.checkpoint(owner, project, 'LINKEDIN_CAROUSEL', { expectedRevision: script.script!.revision,
      expectedDraftCounter: script.script!.draft!.counter });
    await scripts.review(owner, project, 'LINKEDIN_CAROUSEL', script.script!.revisions[0]!.id, 'approve', {
      expectedRevision: script.script!.revision, expectedReviewCounter: 0, acknowledgeUnmapped: true });
    let visual = await visuals.get(owner, project, 'LINKEDIN_CAROUSEL');
    visual = await visuals.initialize(owner, project, 'LINKEDIN_CAROUSEL', { parentRevisionId: visual.parent!.id });
    visual = await visuals.checkpoint(owner, project, 'LINKEDIN_CAROUSEL', { expectedRevision: visual.composition!.revision,
      expectedDraftCounter: visual.composition!.draft!.counter });
    const revision = visual.composition!.revisions[0]!;
    const frames = compositionSchema.parse(revision.content).frames;
    for (const frame of frames) await visuals.preview(owner, project, 'LINKEDIN_CAROUSEL', revision.id, frame.id);
    visual = await visuals.get(owner, project, 'LINKEDIN_CAROUSEL');
    await visuals.review(owner, project, 'LINKEDIN_CAROUSEL', revision.id, 'approve', { expectedRevision: visual.composition!.revision,
      expectedReviewCounter: revision.reviewCounter, acknowledgeUnmapped: true });
  });

  it('fails closed on corrupt bytes and storage outage while preserving script-only export and accepted bytes through trash/restore', async () => {
    const ready = await exports.readiness(owner, project);
    const scriptRevision = await health.prisma.scriptRevision.findFirstOrThrow({ where: { projectId: project } });
    const visualRevision = await health.prisma.visualCompositionRevision.findFirstOrThrow({ where: { projectId: project } });
    const visualFrames = compositionSchema.parse(visualRevision.content).frames;
    const secondFrame = visualFrames[1];
    if (!secondFrame) throw new Error('Synthetic carousel needs at least two frames');
    const preview = await health.prisma.visualPreview.findFirstOrThrow({ where: { projectId: project, revisionId: visualRevision.id, frameId: secondFrame.id } });
    const previewAsset = await health.prisma.asset.findFirstOrThrow({ where: { projectId: project, id: preview.assetId } });
    const scriptItem = { format: 'LINKEDIN_CAROUSEL_SCRIPT' as const, revisionId: scriptRevision.id, reviewCounter: scriptRevision.reviewCounter };
    const visualItem = { format: 'LINKEDIN_CAROUSEL_VISUAL' as const, revisionId: visualRevision.id, reviewCounter: visualRevision.reviewCounter };
    expect(ready.items.find(item => item.format === scriptItem.format)?.ready).toBe(true);
    expect(ready.items.find(item => item.format === visualItem.format)?.ready).toBe(true);
    expect(assets.config.driver).toBe('filesystem');

    const originalPreview = await assets.read(previewAsset.bucket, previewAsset.objectKey, previewAsset.sha256);
    expect(originalPreview.subarray(0, 8)).toEqual(pngSignature);
    const objectPath = resolve(assets.config.directory, previewAsset.objectKey);
    const exportAssetsBeforeFaults = await health.prisma.asset.count({ where: { projectId: project, purpose: 'EXPORT' } });
    const corruptPackage = await exports.freeze(owner, project, { expectedProjectRevision: ready.projectRevision, commandKey: randomUUID(),
      format: 'ZIP', items: [scriptItem, visualItem] });
    await writeFile(objectPath, Buffer.from('corrupt-preview-bytes'));
    try {
      await expect(assets.read(previewAsset.bucket, previewAsset.objectKey, previewAsset.sha256)).rejects.toMatchObject({ status: 503 });
      expect(await failBuild(corruptPackage.jobId)).toMatchObject({ category: 'EXECUTION_FAILED' });
      expect(await jobs.get(owner, project, corruptPackage.jobId)).toMatchObject({ status: 'FAILED' });
      expect(await health.prisma.exportArtifact.findUnique({ where: { requestId: corruptPackage.exportId } })).toBeNull();
      expect(await health.prisma.asset.count({ where: { projectId: project, purpose: 'EXPORT' } })).toBe(exportAssetsBeforeFaults);
      expect((await exports.readiness(owner, project)).exports.find(row => row.id === corruptPackage.exportId)?.status).toBe('FAILED');

      // A failed visual package does not take the approved, independently selected script out of service.
      const scriptPackage = await exports.freeze(owner, project, { expectedProjectRevision: ready.projectRevision, commandKey: randomUUID(),
        format: 'ZIP', items: [scriptItem] });
      const scriptFile = await runBuild(scriptPackage.exportId, scriptPackage.jobId);
      const scriptEntry = zipLocalEntries(scriptFile.bytes).find(entry => entry.name === 'linkedin-carousel-script.json');
      expect(scriptEntry).toBeDefined();
      expect(JSON.parse(scriptEntry!.bytes.toString('utf8'))).toMatchObject({ frames: expect.arrayContaining([
        expect.objectContaining({ text: expect.stringContaining('погоджений сценарний текст') }),
      ]) });
    } finally {
      await writeFile(objectPath, originalPreview);
      expect(await assets.read(previewAsset.bucket, previewAsset.objectKey, previewAsset.sha256)).toEqual(originalPreview);
    }

    const outagePackage = await exports.freeze(owner, project, { expectedProjectRevision: ready.projectRevision, commandKey: randomUUID(),
      format: 'ZIP', items: [visualItem] });
    const putExport = assets.putExport.bind(assets);
    assets.putExport = async () => { throw new Error('Synthetic private storage outage'); };
    try {
      expect(await failBuild(outagePackage.jobId)).toMatchObject({ category: 'TRANSIENT_TRANSPORT' });
      expect(await health.prisma.exportArtifact.findUnique({ where: { requestId: outagePackage.exportId } })).toBeNull();
      expect(await health.prisma.asset.count({ where: { projectId: project, purpose: 'EXPORT' } })).toBe(exportAssetsBeforeFaults + 1);
    } finally {
      assets.putExport = putExport;
    }

    // Cleanup is reference-aware: an accepted private preview must remain readable and is never journaled for deletion.
    await exports.cleanupStaged({ projectId: project, workspaceId: workspace, requestedBy: owner,
      bucket: previewAsset.bucket, objectKey: previewAsset.objectKey });
    expect(await health.prisma.privateObjectDeletion.findUnique({ where: { bucket_objectKey: {
      bucket: previewAsset.bucket, objectKey: previewAsset.objectKey,
    } } })).toBeNull();
    expect(await assets.read(previewAsset.bucket, previewAsset.objectKey, previewAsset.sha256)).toEqual(originalPreview);

    // Exercise cleanup retries against a stale reference (for example, discovered during restore) and a real storage outage.
    // Narrow only the journal selection to this fixture; all checks/writes still use real PostgreSQL.
    const scopedCleanupPrisma = new Proxy(health.prisma, { get(target, property) {
      if (property !== '$transaction') return Reflect.get(target, property);
      return (action: (tx: unknown) => unknown, options: unknown) => target.$transaction(async tx => action(new Proxy(tx, { get(transaction, key) {
        if (key !== '$queryRaw') return Reflect.get(transaction, key);
        return () => transaction.$queryRaw`SELECT "id", "bucket", "objectKey", "attempts" FROM contextflow."PrivateObjectDeletion"
          WHERE "projectId"=${project}::uuid AND "requestedBy"=${owner}::uuid AND "state"='PENDING' AND "retryAfter"<=CURRENT_TIMESTAMP
          ORDER BY "createdAt","id" LIMIT 1 FOR UPDATE SKIP LOCKED`;
      } })), options as { timeout: number; maxWait: number });
    } });
    const cleanup = new PrivateObjectCleanup(scopedCleanupPrisma, assets);
    const journal = await migration.connect();
    try {
      await journal.query('INSERT INTO contextflow."PrivateObjectDeletion"("id","projectId","workspaceId","requestedBy","bucket","objectKey") VALUES($1,$2,$3,$4,$5,$6)',
        [randomUUID(), project, workspace, owner, previewAsset.bucket, previewAsset.objectKey]);
    } finally { journal.release(); }
    expect(await cleanup.processOne()).toBe(true);
    expect(await health.prisma.privateObjectDeletion.findUnique({ where: { bucket_objectKey: {
      bucket: previewAsset.bucket, objectKey: previewAsset.objectKey,
    } } })).toMatchObject({ state: 'PENDING', attempts: 1, errorCategory: 'REFERENCE_CONFLICT' });
    expect(await assets.read(previewAsset.bucket, previewAsset.objectKey, previewAsset.sha256)).toEqual(originalPreview);

    const orphanId = randomUUID();
    const orphan = await assets.putExport(project, orphanId, Buffer.from('synthetic orphan stage'));
    const journalWithOrphan = await migration.connect();
    try {
      await journalWithOrphan.query('INSERT INTO contextflow."PrivateObjectDeletion"("id","projectId","workspaceId","requestedBy","bucket","objectKey") VALUES($1,$2,$3,$4,$5,$6)',
        [randomUUID(), project, workspace, owner, orphan.bucket, orphan.objectKey]);
    } finally { journalWithOrphan.release(); }
    const unavailableCleanup = new PrivateObjectCleanup(scopedCleanupPrisma, { remove: async () => { throw new Error('Synthetic storage unavailable'); } });
    expect(await unavailableCleanup.processOne()).toBe(true);
    expect(await health.prisma.privateObjectDeletion.findUnique({ where: { bucket_objectKey: {
      bucket: orphan.bucket, objectKey: orphan.objectKey,
    } } })).toMatchObject({ state: 'PENDING', attempts: 1, errorCategory: 'STORAGE_UNAVAILABLE' });
    await assets.remove(orphan.bucket, orphan.objectKey);

    const acceptedScript = await exports.freeze(owner, project, { expectedProjectRevision: ready.projectRevision, commandKey: randomUUID(),
      format: 'ZIP', items: [scriptItem] });
    const accepted = await runBuild(acceptedScript.exportId, acceptedScript.jobId);
    const projectRow = await health.prisma.project.findUniqueOrThrow({ where: { id: project } });
    await health.prisma.project.update({ where: { id: project }, data: { trashedAt: new Date(), purgeAfter: new Date(Date.now() + 30 * 86400000) } });
    await expect(exports.download(owner, project, acceptedScript.exportId)).rejects.toMatchObject({ status: 404 });
    await health.prisma.project.update({ where: { id: project }, data: { trashedAt: null, purgeAfter: null } });
    await health.prisma.project.update({ where: { id: project }, data: { archivedAt: new Date() } });
    await expect(exports.download(owner, project, acceptedScript.exportId)).rejects.toMatchObject({ status: 404 });
    await health.prisma.project.update({ where: { id: project }, data: { archivedAt: projectRow.archivedAt } });
    expect((await exports.download(owner, project, acceptedScript.exportId)).bytes).toEqual(accepted.bytes);
  });

  afterAll(async () => {
    try {
      if (fixtureCreated) {
        const unfinished = await health.prisma.job.findMany({ where: { projectId: project, status: { in: ['QUEUED', 'RETRY_WAIT', 'RUNNING'] } } });
        for (const job of unfinished) await jobs.cancel(owner, project, job.id);
        await migration.query('DELETE FROM contextflow."PrivateObjectDeletion" WHERE "projectId"=$1 AND "requestedBy"=$2', [project, owner]);
        const old = new Date(Date.now() - 31 * 86400000), purgeAfter = new Date(old.getTime() + 30 * 86400000);
        const row = await health.prisma.project.findUnique({ where: { id: project } });
        if (row) {
          await health.prisma.project.update({ where: { id: project }, data: { archivedAt: null, trashedAt: old, purgeAfter } });
          await health.prisma.$queryRaw`SELECT contextflow.purge_project_graph(${project}::uuid, ${owner}::uuid, ${row.revision})`;
        }
        const workspaceRow = await health.prisma.workspace.findUnique({ where: { id: workspace } });
        if (workspaceRow) {
          await health.prisma.workspace.update({ where: { id: workspace }, data: { trashedAt: old, purgeAfter } });
          await health.prisma.$queryRaw`SELECT contextflow.purge_workspace_graph(${workspace}::uuid, ${owner}::uuid, ${workspaceRow.lifecycleRevision})`;
        }
        const cleanup = await health.prisma.privateObjectDeletion.findMany({ where: { requestedBy: owner } });
        for (const item of cleanup) {
          await assets.remove(item.bucket, item.objectKey);
          await health.prisma.privateObjectDeletion.update({ where: { id: item.id }, data: { state: 'DELETED', deletedAt: new Date() } });
        }
        const db = await migration.connect();
        try { await db.query('DELETE FROM contextflow."PrivateObjectDeletion" WHERE "requestedBy"=$1', [owner]);
          await db.query('DELETE FROM contextflow."UserProfile" WHERE "id"=$1', [owner]); }
        finally { db.release(); }
      }
    } finally { await renderer.onModuleDestroy(); await migration.end(); await health.onModuleDestroy(); }
  });
});

function zipLocalEntries(bytes: Buffer): Array<{ name: string; bytes: Buffer }> {
  const entries: Array<{ name: string; bytes: Buffer }> = [];
  let offset = 0;
  while (offset + 30 <= bytes.length && bytes.readUInt32LE(offset) === 0x04034b50) {
    const compressedSize = bytes.readUInt32LE(offset + 18);
    const uncompressedSize = bytes.readUInt32LE(offset + 22);
    const nameLength = bytes.readUInt16LE(offset + 26), extraLength = bytes.readUInt16LE(offset + 28);
    if (compressedSize !== uncompressedSize) throw new Error('Synthetic ZIP entry unexpectedly uses compression');
    const nameStart = offset + 30, bodyStart = nameStart + nameLength + extraLength;
    const name = bytes.subarray(nameStart, nameStart + nameLength).toString('utf8');
    const body = bytes.subarray(bodyStart, bodyStart + compressedSize);
    if (body.length !== compressedSize) throw new Error(`Truncated ZIP entry: ${name}`);
    entries.push({ name, bytes: body });
    offset = bodyStart + compressedSize;
  }
  if (!entries.length) throw new Error('No ZIP local entries found');
  return entries;
}
