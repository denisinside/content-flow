import { createHash, randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BriefProposalService, createBriefProposalJobHandler, DependencyHealthService, DurableJobService, DurableJobWorker,
  EXTERNAL_PROCESSING_NOTICE, loadRuntimeConfig, canonicalManifestHash, type BriefProposalWorkflowInput } from '@contextflow/backend';

const sha256 = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');
const workflowId = '33cd4655-8de0-4318-8872-af52f7ff1cb1';
const configDigest = '7e3ef0e41259725272df074366d5756fbea890e98895c20ca60ca9ce9d49544f';

describe('source-backed AI brief proposals', () => {
  const config = loadRuntimeConfig(), health = new DependencyHealthService(config);
  const jobs = new DurableJobService(health.prisma, { noticeVersion: EXTERNAL_PROCESSING_NOTICE.version, retryBaseMs: 0 });
  const sql = new Pool({ connectionString: config.directDatabaseUrl, ssl: false });
  const env = { NODE_ENV: 'test', DIFY_API_BASE_URL: 'https://dify.example.test/v1', DIFY_BRIEF_PROPOSAL_PUBLISHED_WORKFLOW_ID: workflowId,
    DIFY_BRIEF_PROPOSAL_CONFIG_SHA256: configDigest, DIFY_BRIEF_PROPOSAL_API_KEY: 'synthetic-brief-proposal-key' };
  const owner = randomUUID(), outsider = randomUUID(), workspace = randomUUID(), project = randomUUID(), otherWorkspace = randomUUID(), otherProject = randomUUID();
  const factMaterial = randomUUID(), factSnapshot = randomUUID(), exactMaterial = randomUUID(), exactSnapshot = randomUUID(),
    noteMaterial = randomUUID(), noteSnapshot = randomUUID(), pendingMaterial = randomUUID();
  const proposals = new BriefProposalService(health.prisma, jobs, env);
  let worker!: DurableJobWorker;
  const providerInputs: BriefProposalWorkflowInput[] = [];
  const provider = {
    async execute(_settings: unknown, _jobId: string, rawInput: unknown, _signal: AbortSignal,
      beforeSubmit: () => Promise<void>, recordRun: (id: string) => Promise<void>) {
      const input = rawInput as BriefProposalWorkflowInput;
      providerInputs.push(input);
      await beforeSubmit();
      const runId = randomUUID(); await recordRun(runId);
      return { workflowRunId: runId, model: 'synthetic-test-model', output: { schemaVersion: 'brief-proposal-output-v1',
        requestId: input.requestId, requestHash: input.requestHash, releaseId: 'brief-proposal-2026-10-24.1', configDigest, status: 'ready',
        brief: { topic: input.currentBrief.topic || input.topic, audience: 'Мешканці міста', centralMessage: 'Пояснити досвід на основі вибраного звіту.', category: 'Міське життя',
          tone: 'Точно й зрозуміло', targetLength: input.currentBrief.targetLength, cta: 'Поділіться досвідом.',
          exclusions: input.currentBrief.exclusions, notes: input.currentBrief.notes }, assumptions: [] } };
    },
    async resume() { throw new Error('Synthetic test should not resume'); },
  };
  const command = (commandKey = randomUUID()) => ({ commandKey, expectedRevision: 0, contentMode: 'FACTUAL' as const,
    currentBrief: { topic: 'Тема про щоденні поїздки', audience: '', centralMessage: '', category: '', tone: '', targetLength: 600, cta: '', exclusions: [], notes: '' } });

  beforeAll(async () => {
    expect((await health.check()).status).toBe('ready');
    await health.prisma.userProfile.createMany({ data: [owner, outsider].map(id => ({ id,
      externalProcessingNoticeVersion: EXTERNAL_PROCESSING_NOTICE.version, externalProcessingAcceptedAt: new Date() })) });
    await health.prisma.workspace.create({ data: { id: workspace, name: 'Brief proposal TEST', ownerId: owner,
      members: { create: [{ userId: owner }] }, styles: { create: { revision: 1, createdBy: owner, tone: 'Спокійний', brandbook: 'Писати зрозуміло' } } } });
    await health.prisma.project.create({ data: { id: project, workspaceId: workspace, createdBy: owner, topic: 'Тема про щоденні поїздки', formats: ['ARTICLE'] } });
    await health.prisma.workspace.create({ data: { id: otherWorkspace, name: 'Other brief TEST', ownerId: outsider,
      members: { create: [{ userId: outsider }] }, styles: { create: { revision: 1, createdBy: outsider } } } });
    await health.prisma.project.create({ data: { id: otherProject, workspaceId: otherWorkspace, createdBy: outsider, topic: 'Other topic', formats: ['ARTICLE'] } });
    const longText = `BEGIN-UNIQUE\n${('У дослідженні описано щоденну поїздку мешканців міста громадським транспортом. ').repeat(1600)}ENDING-UNIQUE`;
    await health.prisma.material.create({ data: { id: factMaterial, projectId: project, kind: 'TEXT', purpose: 'FACTUAL_SOURCE', label: 'Звіт про поїздки', createdBy: owner } });
    await health.prisma.sourceSnapshot.create({ data: { id: factSnapshot, projectId: project, materialId: factMaterial, sequence: 1,
      normalizedText: longText, sha256: sha256(longText), bytes: Buffer.byteLength(longText), origin: 'MANUAL_TEXT', createdBy: owner } });
    await health.prisma.material.update({ where: { id: factMaterial }, data: { currentSnapshotId: factSnapshot, revision: { increment: 1 }, updatedAt: new Date() } });
    const exactText = '\n  Текст джерела з початковим пробілом і фінальним переносом.\r\n';
    await health.prisma.material.create({ data: { id: exactMaterial, projectId: project, kind: 'TEXT', purpose: 'FACTUAL_SOURCE', label: 'Матеріал із пробілами', createdBy: owner } });
    await health.prisma.sourceSnapshot.create({ data: { id: exactSnapshot, projectId: project, materialId: exactMaterial, sequence: 1,
      normalizedText: exactText, sha256: sha256(exactText), bytes: Buffer.byteLength(exactText), origin: 'MANUAL_TEXT', createdBy: owner } });
    await health.prisma.material.update({ where: { id: exactMaterial }, data: { currentSnapshotId: exactSnapshot, revision: { increment: 1 }, updatedAt: new Date() } });
    await health.prisma.material.create({ data: { id: noteMaterial, projectId: project, kind: 'TEXT', purpose: 'NOTES', label: 'Редакційні нотатки', createdBy: owner } });
    const notes = 'Цей матеріал є редакційною нотаткою, а не фактичним джерелом.';
    await health.prisma.sourceSnapshot.create({ data: { id: noteSnapshot, projectId: project, materialId: noteMaterial, sequence: 1,
      normalizedText: notes, sha256: sha256(notes), bytes: Buffer.byteLength(notes), origin: 'MANUAL_TEXT', createdBy: owner } });
    await health.prisma.material.update({ where: { id: noteMaterial }, data: { currentSnapshotId: noteSnapshot, revision: { increment: 1 }, updatedAt: new Date() } });
    worker = new DurableJobWorker(health.prisma, config.redisUrl, EXTERNAL_PROCESSING_NOTICE.version,
      [createBriefProposalJobHandler({ prisma: health.prisma, proposals, provider, env })], { queueName: 'cf-brief-proposal-test-' + randomUUID(), retryBaseMs: 0 });
  });

  afterAll(async () => {
    await worker?.close();
    const client = await sql.connect();
    try {
      await client.query('BEGIN');
      await client.query('DELETE FROM contextflow."AIExecution" WHERE "projectId" = ANY($1::uuid[])', [[project, otherProject]]);
      await client.query('DELETE FROM contextflow."JobAttempt" WHERE "jobId" IN (SELECT "id" FROM contextflow."Job" WHERE "projectId" = ANY($1::uuid[]))', [[project, otherProject]]);
      await client.query('DELETE FROM contextflow."Job" WHERE "projectId" = ANY($1::uuid[])', [[project, otherProject]]);
      for (const projectId of [project, otherProject]) {
        await client.query('UPDATE contextflow."Material" SET "currentSnapshotId" = NULL, "revision" = "revision" + 1, "updatedAt" = CURRENT_TIMESTAMP WHERE "projectId" = $1', [projectId]);
        await client.query('DELETE FROM contextflow."SourceFragment" WHERE "projectId" = $1', [projectId]);
        await client.query('DELETE FROM contextflow."SourceSnapshot" WHERE "projectId" = $1', [projectId]);
        await client.query('DELETE FROM contextflow."Material" WHERE "projectId" = $1', [projectId]);
        await client.query('DELETE FROM contextflow."Project" WHERE "id" = $1', [projectId]);
      }
      await client.query('DELETE FROM contextflow."Material" WHERE "id" = $1', [pendingMaterial]);
      for (const workspaceId of [workspace, otherWorkspace]) {
        await client.query('DELETE FROM contextflow."WorkspaceStyleRevision" WHERE "workspaceId" = $1', [workspaceId]);
        await client.query('DELETE FROM contextflow."WorkspaceMember" WHERE "workspaceId" = $1', [workspaceId]);
        await client.query('DELETE FROM contextflow."Workspace" WHERE "id" = $1', [workspaceId]);
      }
      await client.query('DELETE FROM contextflow."UserProfile" WHERE "id" = ANY($1::uuid[])', [[owner, outsider]]);
      await client.query('COMMIT');
    } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
    await sql.end(); await health.onModuleDestroy();
  });

  it('freezes included factual sources, samples oversized text, supports exact replay, and never creates a brief', async () => {
    const input = command();
    const created = await proposals.prepare(owner, project, input);
    const replay = await proposals.prepare(owner, project, input);
    expect(replay.id).toBe(created.id);
    const manifest = created.inputManifest as { sources: Array<{ snapshotId: string; sampled: boolean; sourceBytes: number; excerptBytes: number }>; request: BriefProposalWorkflowInput };
    expect(manifest.sources.map(source => source.snapshotId).sort()).toEqual([factSnapshot, exactSnapshot].sort());
    const sampled = manifest.request.sources.find(source => source.snapshotId === factSnapshot)!;
    const exact = manifest.request.sources.find(source => source.snapshotId === exactSnapshot)!;
    expect(manifest.sources.find(source => source.snapshotId === factSnapshot)).toMatchObject({ sampled: true, sourceBytes: expect.any(Number), excerptBytes: expect.any(Number) });
    expect(manifest.sources.reduce((sum, source) => sum + source.excerptBytes, 0)).toBeLessThanOrEqual(60_000);
    expect(sampled.excerpt).toContain('ENDING-UNIQUE');
    expect(exact.excerpt).toBe('\n  Текст джерела з початковим пробілом і фінальним переносом.\r\n');
    const { requestHash, ...requestBase } = manifest.request;
    expect(requestHash).toBe(canonicalManifestHash(requestBase));
    expect(await health.prisma.brief.count({ where: { projectId: project } })).toBe(0);
    await expect(proposals.prepare(owner, project, { ...input, currentBrief: { ...input.currentBrief, audience: 'Інший запит' } })).rejects.toMatchObject({ status: 409 });
    await expect(proposals.get(outsider, project, created.id)).rejects.toMatchObject({ status: 404 });
    await expect(proposals.get(owner, otherProject, created.id)).rejects.toMatchObject({ status: 404 });

    await worker.process({ jobId: created.id, ordinal: 1 });
    const result = await proposals.get(owner, project, created.id);
    expect(result).toMatchObject({ stale: false, proposal: { status: 'ready', brief: { audience: 'Мешканці міста' } } });
    expect(result.sources.some(source => source.snapshotId === factSnapshot && source.sampled)).toBe(true);
    expect(providerInputs).toHaveLength(1);
    expect(await health.prisma.brief.count({ where: { projectId: project } })).toBe(0);
  });

  it('marks proposals stale when the selected sources or workspace style change and blocks stale submission', async () => {
    const first = await proposals.prepare(owner, project, command());
    await health.prisma.workspaceStyleRevision.create({ data: { workspaceId: workspace, revision: 2, tone: 'Нова редакція', createdBy: owner } });
    await health.prisma.workspace.update({ where: { id: workspace }, data: { styleRevision: 2, updatedAt: new Date() } });
    expect((await proposals.get(owner, project, first.id)).stale).toBe(true);

    const second = await proposals.prepare(owner, project, command());
    await health.prisma.material.create({ data: { id: pendingMaterial, projectId: project, kind: 'TEXT', purpose: 'FACTUAL_SOURCE', label: 'Щойно додане джерело', createdBy: owner } });
    expect((await proposals.get(owner, project, second.id)).stale).toBe(true);
    const callsBefore = providerInputs.length;
    await worker.process({ jobId: second.id, ordinal: 1 });
    expect(providerInputs).toHaveLength(callsBefore);
    await expect(proposals.prepare(owner, project, command())).rejects.toMatchObject({ status: 409 });
    expect(await health.prisma.brief.count({ where: { projectId: project } })).toBe(0);
  });

  it('accepts a creative proposal with no factual sources, while factual proposals require one', async () => {
    const creative = await proposals.prepare(outsider, otherProject, { ...command(), contentMode: 'CREATIVE' });
    const manifest = creative.inputManifest as { request: BriefProposalWorkflowInput };
    expect(manifest.request.sources).toEqual([]);
    await expect(proposals.prepare(outsider, otherProject, command())).rejects.toMatchObject({ status: 409 });
  });

  it('bounds a factual proposal to twenty included sources', async () => {
    for (let index = 0; index < 19; index++) {
      const materialId = randomUUID(), snapshotId = randomUUID(), text = `Synthetic factual source ${index}.`;
      await health.prisma.material.create({ data: { id: materialId, projectId: project, kind: 'TEXT', purpose: 'FACTUAL_SOURCE',
        label: `Additional source ${index}`, createdBy: owner } });
      await health.prisma.sourceSnapshot.create({ data: { id: snapshotId, projectId: project, materialId, sequence: 1,
        normalizedText: text, sha256: sha256(text), bytes: Buffer.byteLength(text), origin: 'MANUAL_TEXT', createdBy: owner } });
      await health.prisma.material.update({ where: { id: materialId }, data: { currentSnapshotId: snapshotId, revision: { increment: 1 }, updatedAt: new Date() } });
    }
    await expect(proposals.prepare(owner, project, command())).rejects.toMatchObject({ status: 409 });
  });
});
