import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { beforeAll, afterAll, describe, it, expect } from 'vitest';
import { DependencyHealthService, loadRuntimeConfig, DurableJobService, DurableJobWorker, VisualBackgroundService, createBackgroundJobHandler, FactualBasisService, EditorialService, ArticleService, TelegramService, ScriptService, VisualService, VisualRenderer, PrivateAssetStore, privateStorageConfig, EXTERNAL_PROCESSING_NOTICE } from '@contextflow/backend';
import { Pool } from 'pg';
import { compositionSchema } from '../../packages/visuals/src/index.js';

describe('M5.1 private versioned visual path', () => {
  const config = loadRuntimeConfig(), health = new DependencyHealthService(config);
  const jobs = new DurableJobService(health.prisma, { noticeVersion: EXTERNAL_PROCESSING_NOTICE.version });
  const facts = new FactualBasisService(health.prisma, jobs), editorial = new EditorialService(health.prisma, jobs, facts);
  const articles = new ArticleService(health.prisma, jobs, facts), channels = new TelegramService(health.prisma, jobs, facts, articles);
  const scripts = new ScriptService(health.prisma, channels), renderer = new VisualRenderer();
  const assets = new PrivateAssetStore(privateStorageConfig({ NODE_ENV: 'test' }));
  const visuals = new VisualService(health.prisma, channels, scripts, renderer, assets);
  const migration = new Pool({ connectionString: config.directDatabaseUrl, ssl: false });
  const owner = randomUUID(), outsider = randomUUID(), workspace = randomUUID(), project = randomUUID(), sibling = randomUUID();
  const formats = ['LINKEDIN_COVER', 'INSTAGRAM_COVER', 'LINKEDIN_CAROUSEL', 'INSTAGRAM_CAROUSEL', 'INSTAGRAM_STORIES'] as const;
  const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aD1sAAAAASUVORK5CYII=';
  let captionNumber = 0;
  async function caption(format: typeof formats[number]) {
    captionNumber++;
    let state = await channels.get(owner, project, format);
    state = await channels.saveDraft(owner, project, { format, expectedRevision: state.adaptation?.revision ?? 0, inputMode: 'DIRECT', contentMode: 'CREATIVE', refreshInputs: true, content: {
      text: `Міський простір і нові ідеї ${captionNumber}.`, mappings: [], ...(format.includes('COVER') ? { cover: { text: `Українська обкладинка ${captionNumber}: Ґ, Є, Ї`, instruction: 'Виразний заголовок' } } : {}),
    } });
    state = await channels.checkpoint(owner, project, { format, expectedRevision: state.adaptation!.revision });
    const revision = state.adaptation!.revisions[0]!;
    await channels.review(owner, project, revision.id, 'approve', { format, expectedRevision: state.adaptation!.revision, expectedReviewCounter: revision.reviewCounter, acknowledgeUnmapped: true });
  }
  beforeAll(async () => {
    await health.prisma.userProfile.createMany({ data: [owner, outsider].map(id => ({ id, externalProcessingNoticeVersion: EXTERNAL_PROCESSING_NOTICE.version, externalProcessingAcceptedAt: new Date() })) });
    await health.prisma.workspace.create({ data: { id: workspace, name: 'M5.1 synthetic', ownerId: owner, members: { create: { userId: owner } }, styles: { create: { revision: 1, createdBy: owner } } } });
    await health.prisma.project.createMany({ data: [project,sibling].map(id => ({ id, workspaceId: workspace, createdBy: owner, topic: 'Синтетична перевірка M5.1', formats: [...formats] })) });
    await editorial.saveBrief(owner, project, { expectedRevision: 0, contentMode: 'CREATIVE', topic: 'Місто', audience: 'Мешканці', centralMessage: 'Нові ідеї', category: 'Місто', targetLength: 100, cta: '', exclusions: [], notes: '', requiredClaimRevisionIds: [] });
    for (const format of formats) {
      await caption(format);
      if (format.includes('COVER')) continue;
      let state = await scripts.get(owner, project, format);
      state = await scripts.saveDraft(owner, project, format, { expectedRevision: 0, expectedDraftCounter: 0, parentAdaptationRevisionId: state.parent!.id,
        content: { frames: ['Вступ','Висновок'].map(purpose => ({ id: randomUUID(), purpose, text: `${purpose}: український текст із ґанком.`, visualHint: 'Редакційний макет', transition: 'Наступний кадр', mappings: [] })) } });
      state = await scripts.checkpoint(owner, project, format, { expectedRevision: state.script!.revision, expectedDraftCounter: state.script!.draft!.counter });
      await scripts.review(owner, project, format, state.script!.revisions[0]!.id, 'approve', { expectedRevision: state.script!.revision, expectedReviewCounter: 0, acknowledgeUnmapped: true });
    }
  });
  it('initializes all five formats without Article and preserves immutable checkpoints and CAS', async () => {
    for (const format of formats) {
      const initial = await visuals.get(owner, project, format);
      let state = await visuals.initialize(owner, project, format, { parentRevisionId: initial.parent!.id });
      expect(compositionSchema.parse(state.composition!.draft!.content).frames).toHaveLength(format.includes('COVER') ? 1 : 2);
      const composition = compositionSchema.parse(state.composition!.draft!.content);
      composition.frames[0]!.background = '#f5f0e8';
      const counters = { expectedRevision: state.composition!.revision, expectedDraftCounter: state.composition!.draft!.counter };
      state = await visuals.saveDraft(owner, project, format, { ...counters, composition });
      await expect(visuals.saveDraft(owner, project, format, { ...counters, composition })).rejects.toMatchObject({ status: 409 });
      state = await visuals.checkpoint(owner, project, format, { expectedRevision: state.composition!.revision, expectedDraftCounter: state.composition!.draft!.counter });
      const revision = state.composition!.revisions[0]!;
      expect(compositionSchema.parse(revision.content).frames[0]!.background).toBe('#f5f0e8');
      await expect(health.prisma.visualCompositionRevision.update({ where: { id: revision.id }, data: { sha256: '0'.repeat(64) } })).rejects.toThrow();
    }
    expect(await health.prisma.article.count({ where: { projectId: project } })).toBe(0);
  });
  it('M5.2 worker candidate applies explicitly and preserves text edited after generation', async () => {
    const release=JSON.parse(await readFile('packages/backend/src/visuals/workflows/background-generation/release.json','utf8')) as {configDigest:string};
    const env={DIFY_API_BASE_URL:'https://api.dify.ai/v1',DIFY_VISUAL_BACKGROUND_WORKFLOW_ID:randomUUID(),DIFY_VISUAL_BACKGROUND_CONFIG_SHA256:release.configDigest,DIFY_VISUAL_BACKGROUND_API_KEY:'synthetic-only'};
    const backgrounds=new VisualBackgroundService(health.prisma,visuals,jobs,env);
    let calls=0;
    const provider={async execute(_settings:unknown,_job:string,request:{frameId:string;width:1080;height:1080|1350|1920},_signal:AbortSignal,before:()=>Promise<void>,record:(id:string)=>Promise<void>){calls++;await before();const providerRunId=randomUUID();await record(providerRunId);return{bytes:Buffer.from(png,'base64'),mediaType:'image/png' as const,report:{schemaVersion:'visual-background-report-v1' as const,frameId:request.frameId,width:request.width,height:request.height,model:'gemini-nano-banana-2.1' as const,ready:true,hasText:false,usable:true,reason:'Synthetic clean background'},providerRunId,model:'gemini-nano-banana-2.1' as const};},async resume():Promise<never>{throw new Error('Unexpected resubmission');}};
    const worker=new DurableJobWorker(health.prisma,config.redisUrl,EXTERNAL_PROCESSING_NOTICE.version,[createBackgroundJobHandler({prisma:health.prisma,backgrounds,renderer,assets,provider,env})],{queueName:`cf-m52-${randomUUID()}`});
    try {
      await worker.queue.waitUntilReady();
      let state=await visuals.get(owner,project,'INSTAGRAM_STORIES');
      const source=state.composition!.revisions[0]!,content=compositionSchema.parse(state.composition!.draft!.content),frame=content.frames[0]!;
      const input={expectedRevision:state.composition!.revision,expectedDraftCounter:state.composition!.draft!.counter,compositionRevisionId:source.id,frameId:frame.id,visualBrief:'Спокійний міський фон без написів',commandKey:randomUUID()};
      const frozen=await backgrounds.generate(owner,project,'INSTAGRAM_STORIES',input);
      expect((await backgrounds.generate(owner,project,'INSTAGRAM_STORIES',input)).jobId).toBe(frozen.jobId);
      await worker.process({jobId:frozen.jobId,ordinal:1});
      const candidate=(await backgrounds.list(owner,project,'INSTAGRAM_STORIES')).candidates[0]!;
      expect(candidate).toBeDefined();expect(calls).toBe(1);
      const layer=frame.layers.find(row=>row.type==='text')!;if(layer.type==='text')layer.text='Новий ручний текст після генерації';
      state=await visuals.saveDraft(owner,project,'INSTAGRAM_STORIES',{expectedRevision:state.composition!.revision,expectedDraftCounter:state.composition!.draft!.counter,composition:content});
      const apply={expectedRevision:state.composition!.revision,expectedDraftCounter:state.composition!.draft!.counter,commandKey:randomUUID(),acknowledgeBackgroundReview:true as const};
      const applied=await backgrounds.apply(owner,project,'INSTAGRAM_STORIES',candidate.id,apply);
      const next=compositionSchema.parse(applied.state.composition!.draft!.content);
      expect(next.frames[0]!.layers.some(row=>row.type==='text'&&row.text==='Новий ручний текст після генерації')).toBe(true);
      expect(next.frames[0]!.layers[0]).toMatchObject({type:'image',role:'background'});
      expect((await backgrounds.apply(owner,project,'INSTAGRAM_STORIES',candidate.id,apply)).replayed).toBe(true);
      expect(calls).toBe(1);
      state=await visuals.checkpoint(owner,project,'INSTAGRAM_STORIES',{expectedRevision:applied.state.composition!.revision,expectedDraftCounter:applied.state.composition!.draft!.counter});
      const cancelled=await backgrounds.generate(owner,project,'INSTAGRAM_STORIES',{...input,expectedRevision:state.composition!.revision,expectedDraftCounter:state.composition!.draft!.counter,compositionRevisionId:state.composition!.revisions[0]!.id,commandKey:randomUUID()});
      await jobs.cancel(owner,project,cancelled.jobId);await worker.process({jobId:cancelled.jobId,ordinal:1});
      expect(calls).toBe(1);expect((await jobs.get(owner,project,cancelled.jobId)).status).toBe('CANCELLED');
    } finally {await worker.close();}
  });
  it('normalizes private raster/logo assets, renders once and rejects foreign access and superseded parent', async () => {
    const photo = await visuals.createAsset(owner, project, 'PROJECT', { filename: 'synthetic.png', mediaType: 'image/png', base64: png });
    const logo = await visuals.createAsset(owner, project, 'WORKSPACE', { filename: 'logo.png', mediaType: 'image/png', base64: png });
    expect((await visuals.readAsset(owner, sibling, 'WORKSPACE', logo.id)).mediaType).toBe('image/png');
    await expect(visuals.readAsset(owner, sibling, 'PROJECT', photo.id)).rejects.toMatchObject({ status: 404 });
    await expect(visuals.readAsset(outsider, project, 'PROJECT', photo.id)).rejects.toMatchObject({ status: 404 });
    let state = await visuals.get(owner, project, 'LINKEDIN_COVER');
    const composition = compositionSchema.parse(state.composition!.draft!.content);
    composition.frames[0]!.layers.push({ id: randomUUID(), type: 'image', x: 84, y: 900, width: 120, height: 80, resource: {type:'project',id:photo.id,sha256:photo.ref.sha256}, fit: 'contain' });
    state = await visuals.saveDraft(owner, project, 'LINKEDIN_COVER', { expectedRevision: state.composition!.revision, expectedDraftCounter: state.composition!.draft!.counter, composition });
    state = await visuals.checkpoint(owner, project, 'LINKEDIN_COVER', { expectedRevision: state.composition!.revision, expectedDraftCounter: state.composition!.draft!.counter });
    const revision = state.composition!.revisions[0]!, frameId = compositionSchema.parse(revision.content).frames[0]!.id;
    const preview = await visuals.preview(owner, project, 'LINKEDIN_COVER', revision.id, frameId);
    expect((await visuals.readPreview(owner, project, preview.assetId)).subarray(0,8)).toEqual(Buffer.from([137,80,78,71,13,10,26,10]));
    expect((await visuals.preview(owner, project, 'LINKEDIN_COVER', revision.id, frameId)).assetId).toBe(preview.assetId);
    await expect(visuals.readPreview(outsider, project, preview.assetId)).rejects.toMatchObject({ status: 404 });
    await health.prisma.workspaceStyleRevision.create({ data: { workspaceId: workspace, revision: 2, createdBy: owner, settings: { visualBackground: '#112233', visualFont: 'lora', visualLogoId: logo.id } } });
    await health.prisma.workspace.update({ where: { id: workspace }, data: { styleRevision: 2 } });
    state = await visuals.get(owner, project, 'LINKEDIN_COVER');
    expect(state.composition!.draft!.workspaceStyleRevision).toBe(1);
    expect(state.style.defaults.logo?.id).toBe(logo.id);
    composition.frames[0]!.background = state.style.defaults.background;
    state = await visuals.saveDraft(owner, project, 'LINKEDIN_COVER', { expectedRevision: state.composition!.revision, expectedDraftCounter: state.composition!.draft!.counter, workspaceStyleRevision: 2, composition });
    expect(state.composition!.draft!.workspaceStyleRevision).toBe(2);
    await caption('LINKEDIN_COVER');
    const stale = await visuals.get(owner, project, 'LINKEDIN_COVER');
    expect(stale.composition!.revisions[0]!.staleReasons).toContain('PARENT_CHANGED');
  });
  afterAll(async () => {
    try {
      const old = new Date(Date.now()-31*86400000), purgeAfter = new Date(old.getTime()+30*86400000);
      for (const id of [project,sibling]) {
        const row = await health.prisma.project.findUnique({ where: { id } });
        if (!row) continue;
        await health.prisma.project.update({ where: { id }, data: { trashedAt: old, purgeAfter } });
        await health.prisma.$queryRaw`SELECT contextflow.purge_project_graph(${id}::uuid,${owner}::uuid,${row.revision})`;
      }
      const row = await health.prisma.workspace.findUnique({ where: { id: workspace } });
      if (row) {
        await health.prisma.workspace.update({ where: { id: workspace }, data: { trashedAt: old, purgeAfter } });
        await health.prisma.$queryRaw`SELECT contextflow.purge_workspace_graph(${workspace}::uuid,${owner}::uuid,${row.lifecycleRevision})`;
      }
      const cleanup = await health.prisma.privateObjectDeletion.findMany({ where: { requestedBy: owner } });
      for (const item of cleanup) {
        await assets.remove(item.bucket, item.objectKey);
        await health.prisma.privateObjectDeletion.update({ where: { id: item.id }, data: { state: 'DELETED', deletedAt: new Date() } });
      }
      const db = await migration.connect();
      try {
        await db.query('DELETE FROM contextflow."PrivateObjectDeletion" WHERE "requestedBy"=$1', [owner]);
        await db.query('DELETE FROM contextflow."UserProfile" WHERE "id"=ANY($1::uuid[])', [[owner,outsider]]);
      } finally { db.release(); }
    } finally { await renderer.onModuleDestroy(); await migration.end(); await health.onModuleDestroy(); }
  });
});
