import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ArticleService, DependencyHealthService, DurableJobService, EditorialService, ExportService,
  EXTERNAL_PROCESSING_NOTICE, FactualBasisService, JobFailure, loadRuntimeConfig, PrivateAssetStore, privateStorageConfig,
  TelegramService, ScriptService, VisualService, VisualRenderer, createExportJobHandler } from '@contextflow/backend';
import type { JobContext } from '@contextflow/backend';
import { compositionSchema } from '../../packages/visuals/src/index.js';

const backendRequire = createRequire(new URL('../../packages/backend/package.json', import.meta.url));
const PDFDocument = (backendRequire('pdf-lib') as { PDFDocument: { load(bytes: Uint8Array): Promise<{ getPages(): Array<{ getSize(): { width: number; height: number } }> }> } }).PDFDocument;
const pngSignature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

describe('M5.3 approved visual export path', () => {
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
  const owner = randomUUID(), outsider = randomUUID(), workspace = randomUUID(), project = randomUUID();
  let fixtureCreated = false;
  let adaptationSerial = 0;

  async function approveAdaptation(format: 'LINKEDIN_COVER' | 'LINKEDIN_CAROUSEL') {
    const existing = await channels.get(owner, project, format);
    adaptationSerial++;
    let state = await channels.saveDraft(owner, project, { format, expectedRevision: existing.adaptation?.revision ?? 0, inputMode: 'DIRECT', contentMode: 'CREATIVE',
      content: { text: `Текст ${format} для синтетичного експорту, версія ${adaptationSerial}.`, mappings: [], ...(format === 'LINKEDIN_COVER'
        ? { cover: { text: 'Заголовок окремим шаром', instruction: 'Спокійний редакційний макет' } } : {}) } });
    state = await channels.checkpoint(owner, project, { format, expectedRevision: state.adaptation!.revision });
    const revision = state.adaptation!.revisions[0]!;
    await channels.review(owner, project, revision.id, 'approve', { format, expectedRevision: state.adaptation!.revision,
      expectedReviewCounter: revision.reviewCounter, acknowledgeUnmapped: true });
    return revision;
  }

  async function buildAndDownload(exportId: string, jobId: string) {
    const claim = await jobs.claim(jobId, 1, `m53-export-${randomUUID()}`);
    if (!claim) throw new Error('Synthetic export job was not claimable');
    const context: JobContext = { job: claim.job, attempt: claim.attempt, signal: new AbortController().signal,
      recordSubmissionIntent: async () => {}, recordProviderRun: async () => {}, setProgress: async () => {} };
    const stage = await handler.execute(context);
    await jobs.succeed(claim.job, claim.attempt, handler, stage);
    await handler.completed?.(context, stage);
    return exports.download(owner, project, exportId);
  }

  async function failBuild(jobId: string) {
    const claim = await jobs.claim(jobId, 1, `m53-failed-export-${randomUUID()}`);
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
    await health.prisma.userProfile.createMany({ data: [owner, outsider].map(id => ({ id,
      externalProcessingNoticeVersion: EXTERNAL_PROCESSING_NOTICE.version, externalProcessingAcceptedAt: new Date() })) });
    await health.prisma.workspace.create({ data: { id: workspace, name: `M5.3 synthetic ${workspace}`, ownerId: owner,
      members: { create: [{ userId: owner }] }, styles: { create: { revision: 1, createdBy: owner } } } });
    await health.prisma.project.create({ data: { id: project, workspaceId: workspace, createdBy: owner, topic: 'Synthetic visual export',
      formats: ['LINKEDIN_COVER', 'LINKEDIN_CAROUSEL'] } });
    fixtureCreated = true;
    await editorial.saveBrief(owner, project, { expectedRevision: 0, contentMode: 'CREATIVE', topic: 'Синтетична графіка', audience: 'Редактор',
      centralMessage: 'Текст залишається окремим від фону', category: 'Синтетичний тест', targetLength: 100, cta: '', exclusions: [], notes: '', requiredClaimRevisionIds: [] });
    await approveAdaptation('LINKEDIN_COVER');
    await approveAdaptation('LINKEDIN_CAROUSEL');
    let script = await scripts.get(owner, project, 'LINKEDIN_CAROUSEL');
    script = await scripts.saveDraft(owner, project, 'LINKEDIN_CAROUSEL', { expectedRevision: 0, expectedDraftCounter: 0,
      parentAdaptationRevisionId: script.parent!.id, content: { frames: ['Вступ', 'Висновок'].map(purpose => ({ id: randomUUID(), purpose,
        text: `${purpose}: текст для перевірки PDF.`, visualHint: 'Редакційний фон', transition: 'Далі', mappings: [] })) } });
    script = await scripts.checkpoint(owner, project, 'LINKEDIN_CAROUSEL', { expectedRevision: script.script!.revision,
      expectedDraftCounter: script.script!.draft!.counter });
    await scripts.review(owner, project, 'LINKEDIN_CAROUSEL', script.script!.revisions[0]!.id, 'approve', {
      expectedRevision: script.script!.revision, expectedReviewCounter: 0, acknowledgeUnmapped: true });
  });

  it('approves only previewed checkpoints and builds exact PNG, ordered PDF, and a replayable mixed ZIP', async () => {
    const cover = await visuals.get(owner, project, 'LINKEDIN_COVER');
    let coverState = await visuals.initialize(owner, project, 'LINKEDIN_COVER', { parentRevisionId: cover.parent!.id });
    coverState = await visuals.checkpoint(owner, project, 'LINKEDIN_COVER', { expectedRevision: coverState.composition!.revision,
      expectedDraftCounter: coverState.composition!.draft!.counter });
    const coverRevision = coverState.composition!.revisions[0]!;
    const coverFrame = compositionSchema.parse(coverRevision.content).frames[0]!;
    await expect(visuals.review(owner, project, 'LINKEDIN_COVER', coverRevision.id, 'approve', {
      expectedRevision: coverState.composition!.revision, expectedReviewCounter: 0, acknowledgeUnmapped: true })).rejects.toMatchObject({ status: 409 });
    const coverPreview = await visuals.preview(owner, project, 'LINKEDIN_COVER', coverRevision.id, coverFrame.id);
    const coverBytes = (await visuals.readPreview(owner, project, coverPreview.assetId));
    expect(coverBytes.subarray(0, 8)).toEqual(pngSignature);
    coverState = await visuals.get(owner, project, 'LINKEDIN_COVER');
    coverState = await visuals.review(owner, project, 'LINKEDIN_COVER', coverRevision.id, 'approve', {
      expectedRevision: coverState.composition!.revision, expectedReviewCounter: coverRevision.reviewCounter });

    const carousel = await visuals.get(owner, project, 'LINKEDIN_CAROUSEL');
    let carouselState = await visuals.initialize(owner, project, 'LINKEDIN_CAROUSEL', { parentRevisionId: carousel.parent!.id });
    carouselState = await visuals.checkpoint(owner, project, 'LINKEDIN_CAROUSEL', { expectedRevision: carouselState.composition!.revision,
      expectedDraftCounter: carouselState.composition!.draft!.counter });
    const carouselRevision = carouselState.composition!.revisions[0]!;
    const carouselFrames = compositionSchema.parse(carouselRevision.content).frames;
    const carouselPreviews: Array<Awaited<ReturnType<VisualService['preview']>>> = [];
    for (const frame of carouselFrames) carouselPreviews.push(await visuals.preview(owner, project, 'LINKEDIN_CAROUSEL', carouselRevision.id, frame.id));
    carouselState = await visuals.get(owner, project, 'LINKEDIN_CAROUSEL');
    carouselState = await visuals.review(owner, project, 'LINKEDIN_CAROUSEL', carouselRevision.id, 'approve', {
      expectedRevision: carouselState.composition!.revision, expectedReviewCounter: carouselRevision.reviewCounter, acknowledgeUnmapped: true });
    await expect(health.prisma.visualCompositionRevision.update({ where: { id: carouselRevision.id }, data: { approvedBy: outsider } })).rejects.toThrow();

    expect(await health.prisma.article.count({ where: { projectId: project } })).toBe(0);
    const ready = await exports.readiness(owner, project);
    expect(ready.items).toEqual(expect.arrayContaining([
      expect.objectContaining({ format: 'LINKEDIN_COVER_VISUAL', revisionId: coverRevision.id, ready: true }),
      expect.objectContaining({ format: 'LINKEDIN_CAROUSEL_SCRIPT', ready: true }),
      expect.objectContaining({ format: 'LINKEDIN_CAROUSEL_VISUAL', revisionId: carouselRevision.id, ready: true }),
    ]));
    const coverItem = { format: 'LINKEDIN_COVER_VISUAL' as const, revisionId: coverRevision.id, reviewCounter: coverRevision.reviewCounter + 1 };
    const carouselItem = { format: 'LINKEDIN_CAROUSEL_VISUAL' as const, revisionId: carouselRevision.id, reviewCounter: carouselRevision.reviewCounter + 1 };
    const scriptRow = await health.prisma.scriptRevision.findFirstOrThrow({ where: { projectId: project } });
    const scriptItem = { format: 'LINKEDIN_CAROUSEL_SCRIPT' as const, revisionId: scriptRow.id, reviewCounter: scriptRow.reviewCounter };
    const projectRevision = ready.projectRevision;
    const pngInput = { expectedProjectRevision: projectRevision, commandKey: randomUUID(), format: 'PNG' as const, items: [coverItem] };
    const pdfInput = { expectedProjectRevision: projectRevision, commandKey: randomUUID(), format: 'PDF' as const, items: [carouselItem] };
    const zipInput = { expectedProjectRevision: projectRevision, commandKey: randomUUID(), format: 'ZIP' as const, items: [coverItem, scriptItem, carouselItem] };
    const pngExport = await exports.freeze(owner, project, pngInput);
    expect(await exports.freeze(owner, project, pngInput)).toEqual(pngExport);
    const pdfExport = await exports.freeze(owner, project, pdfInput);
    const zipExport = await exports.freeze(owner, project, zipInput);
    expect((await exports.readiness(owner, project)).items.find(item => item.format === 'ARTICLE')).toBeUndefined();

    const pngFile = await buildAndDownload(pngExport.exportId, pngExport.jobId);
    expect(pngFile.filename).toBe('linkedin-cover.png');
    expect(pngFile.bytes).toEqual(coverBytes);
    await expect(exports.download(outsider, project, pngExport.exportId)).rejects.toMatchObject({ status: 404 });

    const pdfFile = await buildAndDownload(pdfExport.exportId, pdfExport.jobId);
    expect(pdfFile.contentType).toBe('application/pdf');
    const pdf = await PDFDocument.load(pdfFile.bytes);
    const pages = pdf.getPages();
    expect(pages).toHaveLength(2);
    expect(pages.map(page => page.getSize())).toEqual([{ width: 1080, height: 1350 }, { width: 1080, height: 1350 }]);
    const approvedPngs = await Promise.all(carouselPreviews.map(preview => visuals.readPreview(owner, project, preview.assetId)));
    expect(approvedPngs.every(bytes => bytes.subarray(0, 8).equals(pngSignature))).toBe(true);

    const zipFile = await buildAndDownload(zipExport.exportId, zipExport.jobId);
    expect(zipFile.contentType).toBe('application/zip');
    const artifactDir = '.local-checks/m53/files';
    await mkdir(artifactDir, { recursive: true });
    await Promise.all([
      writeFile(`${artifactDir}/cover.png`, pngFile.bytes),
      writeFile(`${artifactDir}/carousel.pdf`, pdfFile.bytes),
      writeFile(`${artifactDir}/package.zip`, zipFile.bytes),
    ]);
    const entries = zipLocalEntries(zipFile.bytes);
    expect(entries.map(entry => entry.name)).toEqual(expect.arrayContaining([
      'linkedin-cover-01.png', 'linkedin-carousel-01.png', 'linkedin-carousel-02.png', 'linkedin-carousel.pdf',
      'linkedin-carousel-script.json', 'linkedin-carousel-script.md', 'manifest.json', 'sources.json',
    ]));
    expect(entries.find(entry => entry.name === 'linkedin-cover-01.png')?.bytes).toEqual(coverBytes);
    expect(entries.find(entry => entry.name === 'linkedin-carousel-01.png')?.bytes).toEqual(approvedPngs[0]);
    expect(entries.find(entry => entry.name === 'linkedin-carousel-02.png')?.bytes).toEqual(approvedPngs[1]);
    const manifest = JSON.parse(entries.find(entry => entry.name === 'manifest.json')!.bytes.toString('utf8')) as { items: Array<{ format: string }> };
    expect(manifest.items.map(item => item.format)).toEqual(['LINKEDIN_CAROUSEL_SCRIPT', 'LINKEDIN_COVER_VISUAL', 'LINKEDIN_CAROUSEL_VISUAL']);
    expect(manifest.items.some(item => item.format === 'ARTICLE')).toBe(false);

    // A later local draft does not replace or invalidate the already approved immutable bytes.
    const approvedPngAgain = await exports.download(owner, project, pngExport.exportId);
    const editable = await visuals.get(owner, project, 'LINKEDIN_COVER');
    await visuals.saveDraft(owner, project, 'LINKEDIN_COVER', { expectedRevision: editable.composition!.revision,
      expectedDraftCounter: editable.composition!.draft!.counter, composition: compositionSchema.parse(editable.composition!.draft!.content) });
    expect((await exports.download(owner, project, pngExport.exportId)).bytes).toEqual(approvedPngAgain.bytes);

    // A missing private preview blob fails the whole package before any export asset is staged.
    const missingBlobExport = await exports.freeze(owner, project, { ...pdfInput, commandKey: randomUUID() });
    const previewRecord = await health.prisma.visualPreview.findFirstOrThrow({ where: { projectId: project, revisionId: carouselRevision.id,
      frameId: carouselFrames[0]!.id }, include: { asset: true } });
    expect(assets.config.driver).toBe('filesystem');
    expect(previewRecord.asset.objectKey).toBe(`${project}/exports/${previewRecord.assetId}`);
    const previewBytes = await assets.read(previewRecord.asset.bucket, previewRecord.asset.objectKey, previewRecord.asset.sha256);
    const exportAssetCount = await health.prisma.asset.count({ where: { projectId: project, purpose: 'EXPORT' } });
    await assets.remove(previewRecord.asset.bucket, previewRecord.asset.objectKey);
    try {
      const failure = await failBuild(missingBlobExport.jobId);
      expect(failure).toMatchObject({ category: 'EXECUTION_FAILED' });
      expect(await jobs.get(owner, project, missingBlobExport.jobId)).toMatchObject({ status: 'FAILED' });
      expect(await health.prisma.exportArtifact.findUnique({ where: { requestId: missingBlobExport.exportId } })).toBeNull();
      expect(await health.prisma.asset.count({ where: { projectId: project, purpose: 'EXPORT' } })).toBe(exportAssetCount);
      expect((await exports.readiness(owner, project)).exports.find(item => item.id === missingBlobExport.exportId)?.status).toBe('FAILED');
    } finally {
      const restored = await assets.putExport(project, previewRecord.assetId, previewBytes);
      expect(restored).toEqual({ bucket: previewRecord.asset.bucket, objectKey: previewRecord.asset.objectKey });
      expect(await assets.read(restored.bucket, restored.objectKey, previewRecord.asset.sha256)).toEqual(previewBytes);
    }

    const afterDraft = await visuals.get(owner, project, 'LINKEDIN_COVER');
    const revokeBeforeBuild = await exports.freeze(owner, project, { ...pngInput, commandKey: randomUUID() });
    const assetsBeforeRevocationFailure = await health.prisma.asset.count({ where: { projectId: project, purpose: 'EXPORT' } });
    await visuals.review(owner, project, 'LINKEDIN_COVER', coverRevision.id, 'withdraw', { expectedRevision: afterDraft.composition!.revision,
      expectedReviewCounter: coverRevision.reviewCounter + 1, acknowledgeUnmapped: true });
    const revocationFailure = await failBuild(revokeBeforeBuild.jobId);
    expect(revocationFailure).toMatchObject({ category: 'INPUTS_CHANGED' });
    expect(await jobs.get(owner, project, revokeBeforeBuild.jobId)).toMatchObject({ status: 'FAILED' });
    expect(await health.prisma.exportArtifact.findUnique({ where: { requestId: revokeBeforeBuild.exportId } })).toBeNull();
    expect(await health.prisma.asset.count({ where: { projectId: project, purpose: 'EXPORT' } })).toBe(assetsBeforeRevocationFailure);
    expect((await exports.readiness(owner, project)).exports.find(item => item.id === revokeBeforeBuild.exportId)?.status).toBe('FAILED');
    await expect(exports.download(owner, project, pngExport.exportId)).rejects.toMatchObject({ status: 409 });
    expect((await exports.download(owner, project, pdfExport.exportId)).bytes).toEqual(pdfFile.bytes);
    await expect(exports.freeze(owner, project, { ...pngInput, commandKey: randomUUID(), expectedProjectRevision: projectRevision }))
      .rejects.toMatchObject({ status: 409 });

    await approveAdaptation('LINKEDIN_CAROUSEL');
    await expect(exports.download(owner, project, pdfExport.exportId)).rejects.toMatchObject({ status: 409 });
  });

  afterAll(async () => {
    try {
      if (fixtureCreated) {
        const old = new Date(Date.now() - 31 * 86400000), purgeAfter = new Date(old.getTime() + 30 * 86400000);
        const row = await health.prisma.project.findUnique({ where: { id: project } });
        if (row) {
          await health.prisma.project.update({ where: { id: project }, data: { trashedAt: old, purgeAfter } });
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
        try {
          await db.query('DELETE FROM contextflow."PrivateObjectDeletion" WHERE "requestedBy"=$1', [owner]);
          await db.query('DELETE FROM contextflow."UserProfile" WHERE "id"=ANY($1::uuid[])', [[owner, outsider]]);
        } finally { db.release(); }
      }
    } finally { await renderer.onModuleDestroy(); await migration.end(); await health.onModuleDestroy(); }
  });
});

function zipLocalEntries(bytes: Buffer): Array<{ name: string; bytes: Buffer }> {
  const entries: Array<{ name: string; bytes: Buffer }> = [];
  let offset = 0;
  while (offset + 30 <= bytes.length && bytes.readUInt32LE(offset) === 0x04034b50) {
    const size = bytes.readUInt32LE(offset + 18), nameLength = bytes.readUInt16LE(offset + 26), extraLength = bytes.readUInt16LE(offset + 28);
    const nameStart = offset + 30, bodyStart = nameStart + nameLength + extraLength;
    entries.push({ name: bytes.subarray(nameStart, nameStart + nameLength).toString('utf8'), bytes: bytes.subarray(bodyStart, bodyStart + size) });
    offset = bodyStart + size;
  }
  return entries;
}
