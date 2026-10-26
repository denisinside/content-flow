import { createHash, randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DependencyHealthService, DurableJobService, EditorialService, FactualBasisService, EXTERNAL_PROCESSING_NOTICE,
  loadRuntimeConfig, canonicalBriefHash, type SaveBriefInput, type JobHandler } from '@contextflow/backend';

describe('versioned briefs and explicit outline review', () => {
  const config = loadRuntimeConfig(), health = new DependencyHealthService(config);
  const jobs = new DurableJobService(health.prisma, { noticeVersion: EXTERNAL_PROCESSING_NOTICE.version });
  const facts = new FactualBasisService(health.prisma, jobs), editorial = new EditorialService(health.prisma, jobs, facts);
  const migration = new Pool({ connectionString: config.directDatabaseUrl, ssl: false });
  const owner = randomUUID(), member = randomUUID(), outsider = randomUUID(), workspace = randomUUID(), article = randomUUID(), direct = randomUUID();
  const notesMaterial = randomUUID(), notesSnapshot = randomUUID();
  const brief = (mode: 'FACTUAL' | 'CREATIVE', expectedRevision = 0): SaveBriefInput => ({ expectedRevision, contentMode: mode,
    topic: 'Тема', audience: 'Читачі', centralMessage: 'Головна думка', category: 'Освіта', targetLength: 1000,
    cta: 'Обговоріть', exclusions: ['Без реклами'], notes: 'Авторські нотатки', requiredClaimRevisionIds: [] });
  const content = { title: 'Структура', sections: [{ title: 'Вступ', purpose: 'Пояснити контекст', claimRevisionIds: [] as string[] }] };
  beforeAll(async () => {
    expect((await health.check()).status).toBe('ready');
    await health.prisma.userProfile.createMany({ data: [owner, member, outsider].map(id => ({ id })) });
    await health.prisma.workspace.create({ data: { id: workspace, name: 'Editorial fixture', ownerId: owner,
      members: { create: [{ userId: owner }, { userId: member }] }, styles: { create: { revision: 1, createdBy: owner, tone: 'Спокійний' } } } });
    await health.prisma.project.createMany({ data: [{ id: article, workspaceId: workspace, createdBy: owner, topic: 'Стаття', formats: ['ARTICLE'] },
      { id: direct, workspaceId: workspace, createdBy: owner, topic: 'Telegram', formats: ['TELEGRAM_POST'] }] });
    const text = 'Нотатки для стилю, а не перевірені факти.';
    await health.prisma.material.create({ data: { id: notesMaterial, projectId: article, kind: 'TEXT', purpose: 'NOTES', label: 'Нотатки', createdBy: owner } });
    await health.prisma.sourceSnapshot.create({ data: { id: notesSnapshot, projectId: article, materialId: notesMaterial, sequence: 1, normalizedText: text,
      sha256: createHash('sha256').update(text).digest('hex'), bytes: Buffer.byteLength(text), origin: 'MANUAL_TEXT', createdBy: owner } });
    await health.prisma.material.update({ where: { id: notesMaterial }, data: { currentSnapshotId: notesSnapshot, revision: { increment: 1 }, updatedAt: new Date() } });
  });
  afterAll(async () => {
    const client = await migration.connect();
    try {
      await client.query('BEGIN');
      for (const table of ['Brief', 'BriefRevision', 'BriefRequiredClaim', 'BriefContextSnapshot', 'Outline', 'OutlineRevision']) await client.query(`ALTER TABLE contextflow."${table}" DISABLE TRIGGER "${table}_no_delete"`);
      await client.query('ALTER TABLE contextflow."Brief" DISABLE TRIGGER "Brief_pointer_guard"');
      for (const projectId of [article, direct]) {
        await client.query('UPDATE contextflow."Outline" SET "currentRevisionId"=NULL,"currentApprovedRevisionId"=NULL,"revision"="revision"+1 WHERE "projectId"=$1', [projectId]);
        await client.query('UPDATE contextflow."Brief" SET "currentRevisionId"=NULL,"revision"="revision"+1 WHERE "projectId"=$1', [projectId]);
        for (const table of ['OutlineRevision', 'Outline', 'BriefRequiredClaim', 'BriefContextSnapshot', 'BriefRevision', 'Brief', 'BasisClaimEvidence', 'BasisClaim', 'FactualBasisRevision']) await client.query(`DELETE FROM contextflow."${table}" WHERE "projectId"=$1`, [projectId]);
        await client.query('DELETE FROM contextflow."AIExecution" WHERE "projectId"=$1', [projectId]);
        await client.query('DELETE FROM contextflow."JobAttempt" WHERE "jobId" IN (SELECT "id" FROM contextflow."Job" WHERE "projectId"=$1)', [projectId]);
        await client.query('DELETE FROM contextflow."Job" WHERE "projectId"=$1', [projectId]);
        await client.query('UPDATE contextflow."Claim" SET "currentRevisionId"=NULL,"revision"="revision"+1,"updatedAt"=CURRENT_TIMESTAMP WHERE "projectId"=$1', [projectId]);
        for (const table of ['ClaimEvidence', 'ClaimRevision', 'Claim']) await client.query(`DELETE FROM contextflow."${table}" WHERE "projectId"=$1`, [projectId]);
        await client.query('UPDATE contextflow."Material" SET "currentSnapshotId"=NULL,"revision"="revision"+1,"updatedAt"=CURRENT_TIMESTAMP WHERE "projectId"=$1', [projectId]);
        for (const table of ['SourceFragment', 'SourceSnapshot', 'Material']) await client.query(`DELETE FROM contextflow."${table}" WHERE "projectId"=$1`, [projectId]);
        await client.query('DELETE FROM contextflow."Project" WHERE "id"=$1', [projectId]);
      }
      await client.query('DELETE FROM contextflow."WorkspaceStyleRevision" WHERE "workspaceId"=$1', [workspace]);
      await client.query('DELETE FROM contextflow."WorkspaceMember" WHERE "workspaceId"=$1', [workspace]);
      await client.query('DELETE FROM contextflow."Workspace" WHERE "id"=$1', [workspace]);
      await client.query('DELETE FROM contextflow."UserProfile" WHERE "id"=ANY($1::uuid[])', [[owner, member, outsider]]);
      for (const table of ['Brief', 'BriefRevision', 'BriefRequiredClaim', 'BriefContextSnapshot', 'Outline', 'OutlineRevision']) await client.query(`ALTER TABLE contextflow."${table}" ENABLE TRIGGER "${table}_no_delete"`);
      await client.query('ALTER TABLE contextflow."Brief" ENABLE TRIGGER "Brief_pointer_guard"');
      await client.query('COMMIT');
    } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
    await migration.end(); await health.onModuleDestroy();
  });
  it('saves factual briefs before facts exist and restricts outlines to Article', async () => {
    const saved = await editorial.saveBrief(member, direct, brief('FACTUAL'));
    expect(saved).toMatchObject({ articleSelected: false, outline: null, sourceEvidenceRequired: true, brief: { revision: 1, currentRevision: { tone: 'Спокійний', workspaceStyleRevision: 1 } } });
    await expect(editorial.manualOutline(owner, direct, { expectedRevision: 0, briefRevisionId: saved.brief!.currentRevision!.id, content })).rejects.toMatchObject({ status: 409 });
    expect(await health.prisma.outline.count({ where: { projectId: direct } })).toBe(0);
    await expect(editorial.get(outsider, direct)).rejects.toMatchObject({ status: 404 });
    await expect(editorial.freezeOutline(owner, direct, randomUUID(), { endpoint: 'https://api.dify.ai/v1', workflowId: randomUUID(), releaseId: 'test', configDigest: 'a'.repeat(64), contractVersion: 'outline-v1', promptTemplateVersion: 'test' })).rejects.toMatchObject({ status: 403 });
  });
  it('retains historical approvals and local save conflicts, and terminally withdraws an exact creative outline', async () => {
    const saved = await editorial.saveBrief(owner, article, brief('CREATIVE'));
    expect(saved.sourceEvidenceRequired).toBe(false);
    expect(saved.brief!.currentRevision!.contextSnapshots).toMatchObject([{ snapshotId: notesSnapshot, capturedPurpose: 'NOTES' }]);
    expect(canonicalBriefHash(saved.brief!.currentRevision!)).toBe(saved.brief!.currentRevision!.sha256);
    await health.prisma.material.update({ where: { id: notesMaterial }, data: { purpose: 'STYLE_SAMPLE', revision: { increment: 1 }, updatedAt: new Date() } });
    expect((await editorial.get(member, article)).brief!.currentRevision!.contextSnapshots[0]!.capturedPurpose).toBe('NOTES');
    const first = await editorial.manualOutline(member, article, { expectedRevision: 0, briefRevisionId: saved.brief!.currentRevision!.id, content });
    const revisionId = first.outline!.currentRevision!.id;
    const approved = await editorial.reviewOutline(owner, article, revisionId, 'approve', { expectedRevision: first.outline!.revision });
    expect(approved.outline!.currentRevision).toMatchObject({ status: 'APPROVED', approvedBy: owner });
    await expect(editorial.manualOutline(member, article, { expectedRevision: first.outline!.revision, briefRevisionId: saved.brief!.currentRevision!.id, content })).rejects.toMatchObject({ status: 409 });
    const edited = await editorial.manualOutline(member, article, { expectedRevision: approved.outline!.revision, briefRevisionId: saved.brief!.currentRevision!.id, content: { ...content, title: 'Нова редакція' } });
    expect(edited.outline!.currentApprovedRevisionId).toBe(revisionId);
    expect(edited.outline!.revisions.find(row => row.id === revisionId)?.status).toBe('APPROVED');
    const withdrawn = await editorial.reviewOutline(owner, article, revisionId, 'withdraw', { expectedRevision: edited.outline!.revision, reason: 'Потребує змін' });
    expect(withdrawn.outline!.currentApprovedRevisionId).toBeNull();
    await expect(editorial.reviewOutline(owner, article, revisionId, 'apply', { expectedRevision: withdrawn.outline!.revision })).rejects.toMatchObject({ status: 409 });
    const updated = await editorial.saveBrief(owner, article, brief('CREATIVE', saved.brief!.revision));
    expect(updated.brief!.history).toHaveLength(2);
    await expect(editorial.reviewOutline(owner, article, edited.outline!.currentRevision!.id, 'approve', { expectedRevision: withdrawn.outline!.revision })).rejects.toMatchObject({ status: 409 });
  });
  it('rejects retired required claims without creating a brief revision', async () => {
    const before = await editorial.get(owner, direct);
    await expect(editorial.saveBrief(owner, direct, { ...brief('FACTUAL', before.brief!.revision), requiredClaimRevisionIds: [randomUUID()] }))
      .rejects.toThrow('REQUIRED_CLAIMS_RETIRED');
    const after = await editorial.get(owner, direct);
    expect(after.brief!.revision).toBe(before.brief!.revision);
    expect(after.brief!.currentRevision!.id).toBe(before.brief!.currentRevision!.id);
    expect(await health.prisma.claim.count({ where: { projectId: direct } })).toBe(0);
  });
  it('stores generated output as a candidate without replacing manual text, and fences duplicate completion', async () => {
    await health.prisma.userProfile.update({ where: { id: owner }, data: { externalProcessingNoticeVersion: EXTERNAL_PROCESSING_NOTICE.version, externalProcessingAcceptedAt: new Date() } });
    const state = await editorial.get(owner, article);
    const saved = await editorial.manualOutline(owner, article, { expectedRevision: state.outline!.revision, briefRevisionId: state.brief!.currentRevision!.id, content });
    const release = { endpoint: 'https://api.dify.ai/v1', workflowId: randomUUID(), releaseId: 'synthetic', configDigest: 'a'.repeat(64), contractVersion: 'outline-v1' as const, promptTemplateVersion: 'synthetic' };
    const job = await editorial.freezeOutline(owner, article, randomUUID(), release), active = await jobs.claim(job.id, 1, 'outline-fixture-worker');
    expect(active).not.toBeNull();
    const execution = await health.prisma.aIExecution.create({ data: { id: randomUUID(), projectId: article, jobId: job.id, attemptId: active!.attempt.id,
      workflowId: release.workflowId, releaseId: release.releaseId, configDigest: release.configDigest, contractVersion: release.contractVersion,
      promptTemplateVersion: release.promptTemplateVersion, inputManifest: job.inputManifest!, inputHash: job.inputHash } });
    const candidate = { ...content, title: 'Пропозиція AI' };
    const handler: JobHandler = { operation: 'OUTLINE_GENERATION', execute: async () => candidate,
      commit: (tx, result, current) => editorial.commitGenerated(tx, current, result, execution.id) };
    await jobs.succeed(active!.job, active!.attempt, handler, candidate);
    const after = await editorial.get(member, article);
    expect(after.outline!.currentRevision!.id).toBe(saved.outline!.currentRevision!.id);
    expect(after.outline!.revisions[0]).toMatchObject({ origin: 'AI', status: 'PROPOSED', content: { title: 'Пропозиція AI' } });
    await expect(jobs.succeed(active!.job, active!.attempt, handler, candidate)).rejects.toThrow('fenced');
    expect(await health.prisma.outlineRevision.count({ where: { jobId: job.id } })).toBe(1);
  });
  it('requires a new brief after Workspace style changes and preserves its full valid default tone', async () => {
    const state = await editorial.get(owner, article), tone = 'т'.repeat(10000);
    await health.prisma.$transaction(async tx => {
      await tx.workspaceStyleRevision.create({ data: { workspaceId: workspace, revision: 2, tone, brandbook: 'Новий брендбук', createdBy: owner } });
      await tx.workspace.update({ where: { id: workspace }, data: { styleRevision: 2, updatedAt: new Date() } });
    });
    await expect(editorial.reviewOutline(owner, article, state.outline!.currentRevision!.id, 'approve', { expectedRevision: state.outline!.revision })).rejects.toMatchObject({ status: 409 });
    const saved = await editorial.saveBrief(owner, article, brief('CREATIVE', state.brief!.revision));
    expect(saved.brief!.currentRevision).toMatchObject({ tone, workspaceStyleRevision: 2 });
    expect(saved.brief!.history.find(row => row.workspaceStyleRevision === 1)?.tone).toBe('Спокійний');
    expect(canonicalBriefHash(saved.brief!.currentRevision!)).toBe(saved.brief!.currentRevision!.sha256);
  });
});
