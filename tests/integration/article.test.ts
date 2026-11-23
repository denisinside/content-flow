import { createHash, randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ArticleService, DependencyHealthService, DurableJobService, EditorialService, FactualBasisService, EXTERNAL_PROCESSING_NOTICE, importedFragments, loadRuntimeConfig, type ArticleContent } from '@contextflow/backend';

describe('article draft checkpoints and exact human approval', () => {
  const config = loadRuntimeConfig(), health = new DependencyHealthService(config), jobs = new DurableJobService(health.prisma, { noticeVersion: EXTERNAL_PROCESSING_NOTICE.version });
  const facts = new FactualBasisService(health.prisma, jobs), articles = new ArticleService(health.prisma, jobs, facts), editorial = new EditorialService(health.prisma, jobs, facts);
  const migration = new Pool({ connectionString: config.directDatabaseUrl, ssl: false });
  const user = randomUUID(), member = randomUUID(), outsider = randomUUID(), workspace = randomUUID(), projects = Array.from({ length: 8 }, () => randomUUID());
  function content(text = 'Редакційний текст без твердження про повну перевірку.'): ArticleContent { return { title: 'Стаття', document: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] } }; }
  beforeAll(async () => {
    await health.prisma.userProfile.createMany({ data: [user, member, outsider].map(id => ({ id })) });
    await health.prisma.workspace.create({ data: { id: workspace, name: 'Article fixture', ownerId: user, members: { create: [{ userId: user }, { userId: member }] }, styles: { create: { revision: 1, createdBy: user } } } });
    await health.prisma.project.createMany({ data: projects.map((id, index) => ({ id, workspaceId: workspace, topic: 'Article domain', createdBy: user, formats: index === 5 ? ['TELEGRAM_POST' as const] : ['ARTICLE' as const] })) });
  });
  afterAll(async () => {
    const db = await migration.connect();
    const tables = ['Article', 'ArticleDraft', 'ArticleVersion', 'ArticleVersionClaim', 'Brief', 'BriefRevision', 'BriefRequiredClaim', 'BriefContextSnapshot', 'Outline', 'OutlineRevision'];
    try {
      await db.query('BEGIN');
      for (const table of tables) await db.query(`ALTER TABLE contextflow."${table}" DISABLE TRIGGER "${table}_no_delete"`);
      await db.query('ALTER TABLE contextflow."Brief" DISABLE TRIGGER "Brief_pointer_guard"');
      for (const project of projects) {
        await db.query('UPDATE contextflow."Article" SET "currentApprovedVersionId"=NULL,"revision"="revision"+1 WHERE "projectId"=$1', [project]);
        for (const table of ['ArticleVersionClaim', 'ArticleDraft', 'ArticleVersion', 'Article']) await db.query(`DELETE FROM contextflow."${table}" WHERE "projectId"=$1`, [project]);
        await db.query('UPDATE contextflow."Outline" SET "currentRevisionId"=NULL,"currentApprovedRevisionId"=NULL,"revision"="revision"+1 WHERE "projectId"=$1', [project]);
        await db.query('UPDATE contextflow."Brief" SET "currentRevisionId"=NULL,"revision"="revision"+1 WHERE "projectId"=$1', [project]);
        for (const table of ['OutlineRevision', 'Outline', 'BriefRequiredClaim', 'BriefContextSnapshot', 'BriefRevision', 'Brief', 'BasisClaimEvidence', 'BasisClaim', 'FactualBasisRevision']) await db.query(`DELETE FROM contextflow."${table}" WHERE "projectId"=$1`, [project]);
        await db.query('DELETE FROM contextflow."AIExecution" WHERE "projectId"=$1', [project]);
        await db.query('DELETE FROM contextflow."JobAttempt" WHERE "jobId" IN (SELECT "id" FROM contextflow."Job" WHERE "projectId"=$1)', [project]);
        await db.query('DELETE FROM contextflow."Job" WHERE "projectId"=$1', [project]);
        await db.query('UPDATE contextflow."Claim" SET "currentRevisionId"=NULL,"revision"="revision"+1,"updatedAt"=CURRENT_TIMESTAMP WHERE "projectId"=$1', [project]);
        for (const table of ['ClaimEvidence', 'ClaimRevision', 'Claim']) await db.query(`DELETE FROM contextflow."${table}" WHERE "projectId"=$1`, [project]);
        await db.query('UPDATE contextflow."Material" SET "currentSnapshotId"=NULL,"revision"="revision"+1,"updatedAt"=CURRENT_TIMESTAMP WHERE "projectId"=$1', [project]);
        for (const table of ['SourceFragment', 'SourceSnapshot', 'Material']) await db.query(`DELETE FROM contextflow."${table}" WHERE "projectId"=$1`, [project]);
        await db.query('DELETE FROM contextflow."Project" WHERE "id"=$1', [project]);
      }
      for (const table of ['WorkspaceStyleRevision', 'WorkspaceMember']) await db.query(`DELETE FROM contextflow."${table}" WHERE "workspaceId"=$1`, [workspace]);
      await db.query('DELETE FROM contextflow."Workspace" WHERE "id"=$1', [workspace]);
      await db.query('DELETE FROM contextflow."UserProfile" WHERE "id"=ANY($1::uuid[])', [[user, member, outsider]]);
      for (const table of tables) await db.query(`ALTER TABLE contextflow."${table}" ENABLE TRIGGER "${table}_no_delete"`);
      await db.query('ALTER TABLE contextflow."Brief" ENABLE TRIGGER "Brief_pointer_guard"'); await db.query('COMMIT');
    } catch (error) { await db.query('ROLLBACK'); throw error; } finally { db.release(); await migration.end(); await health.onModuleDestroy(); }
  });
  it('serializes draft concurrency, preserves approved bytes, deduplicates checkpoints and terminally withdraws', async () => {
    const project = projects[0]!;
    const saved = await articles.saveDraft(member, project, { expectedRevision: 0, contentMode: 'CREATIVE', content: content() });
    expect(saved.article).toMatchObject({ revision: 1, currentApprovedVersionId: null, draft: { origin: 'MANUAL', schemaVersion: 'article-document-v1' } });
    await expect(articles.saveDraft(user, project, { expectedRevision: 0, contentMode: 'CREATIVE', content: content('Конкурентна правка') })).rejects.toMatchObject({ status: 409 });
    const checkpoint = await articles.checkpoint(user, project, { expectedRevision: 1 }, true), version = checkpoint.article!.versions[0]!;
    expect(checkpoint).toMatchObject({ editorOnly: true, article: { revision: 2, draft: { baseVersionId: version.id } } });
    expect((await articles.checkpoint(user, project, { expectedRevision: 2 })).article!.versions).toHaveLength(1);
    await expect(articles.review(user, project, version.id, 'approve', { expectedRevision: 1 })).rejects.toMatchObject({ status: 409 });
    const approved = await articles.review(member, project, version.id, 'approve', { expectedRevision: 2 });
    expect(approved.article!.versions[0]).toMatchObject({ approvedBy: member, acknowledgedUnmapped: false, claimsSealed: true });
    const edited = await articles.saveDraft(user, project, { expectedRevision: 3, contentMode: 'CREATIVE', content: content('Новий текст') });
    expect(edited.article!.versions[0]!.content).toEqual(version.content);
    const withdrawn = await articles.review(user, project, version.id, 'withdraw', { expectedRevision: 4 });
    expect(withdrawn.article!.currentApprovedVersionId).toBeNull();
    await expect(articles.review(user, project, version.id, 'apply', { expectedRevision: 5 })).rejects.toMatchObject({ status: 409 });
  });
  it('imports supplied text without outline, preserves snapshot provenance after repurpose and permits human creative approval', async () => {
    const project = projects[1]!, material = randomUUID(), snapshot = randomUUID(), text = 'Готова стаття.\n\nДругий абзац.';
    await health.prisma.material.create({ data: { id: material, projectId: project, kind: 'TEXT', purpose: 'SUPPLIED_ARTICLE', label: 'Готовий матеріал', createdBy: user } });
    await health.prisma.sourceSnapshot.create({ data: { id: snapshot, projectId: project, materialId: material, sequence: 1, normalizedText: text, sha256: createHash('sha256').update(text).digest('hex'), bytes: Buffer.byteLength(text), origin: 'MANUAL_TEXT', createdBy: user } });
    const imported = await articles.importArticle(user, project, { expectedRevision: 0, contentMode: 'CREATIVE', snapshotId: snapshot });
    expect(imported.article!.draft).toMatchObject({ origin: 'UNVERIFIED_IMPORTED', sourceSnapshotId: snapshot, outlineRevisionId: null, basisRevisionId: null });
    await health.prisma.material.update({ where: { id: material }, data: { purpose: 'NOTES', revision: { increment: 1 }, updatedAt: new Date() } });
    await articles.saveDraft(member, project, { expectedRevision: 1, contentMode: 'CREATIVE', content: content('Відредагований імпорт') });
    const checkpoint = await articles.checkpoint(user, project, { expectedRevision: 2 });
    const approved = await articles.review(user, project, checkpoint.article!.versions[0]!.id, 'approve', { expectedRevision: 3, acknowledgeUnmapped: true });
    expect(approved.article!.versions[0]).toMatchObject({ status: 'APPROVED', origin: 'UNVERIFIED_IMPORTED', sourceSnapshotId: snapshot });
    await expect(articles.importArticle(user, projects[2]!, { expectedRevision: 0, contentMode: 'CREATIVE', snapshotId: snapshot })).rejects.toMatchObject({ status: 400 });
  });
  it('retains stale draft inputs until explicit refresh and rejects channels-only or outsiders', async () => {
    const project = projects[2]!;
    await articles.saveDraft(user, project, { expectedRevision: 0, contentMode: 'CREATIVE', content: content() });
    await editorial.saveBrief(user, project, { expectedRevision: 0, contentMode: 'CREATIVE', topic: 'Нова тема', audience: '', centralMessage: '', category: '', targetLength: 500, cta: '', exclusions: [], notes: '', requiredClaimRevisionIds: [] });
    const stale = await articles.saveDraft(user, project, { expectedRevision: 1, contentMode: 'CREATIVE', content: content('Оновлений текст') });
    expect(stale.staleReasons).toContain('BRIEF_CHANGED'); expect(stale.article!.draft!.briefRevisionId).toBeNull();
    const refreshed = await articles.saveDraft(user, project, { expectedRevision: 2, contentMode: 'CREATIVE', content: content('Оновлений текст'), refreshInputs: true });
    expect(refreshed.staleReasons).toEqual([]); expect(refreshed.article!.draft!.briefRevisionId).not.toBeNull();
    await expect(articles.get(outsider, project)).rejects.toMatchObject({ status: 404 });
    await expect(articles.saveDraft(user, projects[5]!, { expectedRevision: 0, contentMode: 'CREATIVE', content: content() })).rejects.toMatchObject({ status: 409 });
  });
  it('preserves invalid linked wording in draft and blocks approval after edits or evidence invalidation', async () => {
    const project = projects[3]!, material = randomUUID(), snapshot = randomUUID(), text = 'Перевірене твердження.';
    const fragment = importedFragments(text)[0]!;
    await health.prisma.material.create({ data: { id: material, projectId: project, kind: 'TEXT', purpose: 'FACTUAL_SOURCE', label: 'Джерело', createdBy: user } });
    await health.prisma.sourceSnapshot.create({ data: { id: snapshot, projectId: project, materialId: material, sequence: 1, normalizedText: text, sha256: createHash('sha256').update(text).digest('hex'), bytes: Buffer.byteLength(text), origin: 'MANUAL_TEXT', createdBy: user } });
    await health.prisma.sourceFragment.create({ data: { ...fragment, projectId: project, snapshotId: snapshot } });
    const claim = await facts.create(user, project, { wording: text, evidence: [{ snapshotId: snapshot, fragmentId: fragment.id, startOffset: fragment.startOffset, endOffset: fragment.endOffset, quote: text, sha256: fragment.sha256, relation: 'SUPPORTS' }] });
    const revision = claim.claim.currentRevision!;
    const approvedClaim = await facts.review(user, project, claim.claim.id, revision.id, 'approve', { expectedRevision: claim.claim.revision });
    await facts.freezeBasis(user, project, { claimRevisionIds: [revision.id] });
    const evidence = revision.evidence[0]!;
    const mapped = (wording: string): ArticleContent => ({ title: 'Фактична стаття', document: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: wording, marks: [{ type: 'evidence', attrs: { claimRevisionId: revision.id, evidenceId: evidence.id, quote: text } }] }] }] } });
    const drifted = await articles.saveDraft(user, project, { expectedRevision: 0, contentMode: 'FACTUAL', content: mapped('Змінене твердження.') });
    expect(drifted.mappingIssues[0]?.reason).toBe('WORDING_CHANGED');
    const longerDraft = await articles.saveDraft(user, project, { expectedRevision: 1, contentMode: 'FACTUAL', content: mapped('З'.repeat(11000)) });
    expect(longerDraft.article!.draft!.plainText).toHaveLength(11000);
    const checkpoint = await articles.checkpoint(user, project, { expectedRevision: 2 });
    expect(checkpoint.article!.versions[0]!.claims[0]!.linkedText).toHaveLength(11000);
    await expect(articles.review(user, project, checkpoint.article!.versions[0]!.id, 'approve', { expectedRevision: 3, acknowledgeUnmapped: true })).rejects.toMatchObject({ status: 409 });
    await articles.saveDraft(user, project, { expectedRevision: 3, contentMode: 'FACTUAL', content: mapped(text) });
    const valid = await articles.checkpoint(user, project, { expectedRevision: 4 });
    await facts.invalidate(user, project, claim.claim.id, evidence.id, { expectedRevision: approvedClaim.claim.revision, reason: 'Потрібна повторна перевірка' });
    const stillSaved = await articles.saveDraft(user, project, { expectedRevision: 5, contentMode: 'FACTUAL', content: mapped(text) });
    expect(stillSaved.staleReasons).toContain('INVALID_FACTUAL_BASIS');
    await expect(articles.review(user, project, valid.article!.versions[0]!.id, 'approve', { expectedRevision: 6, acknowledgeUnmapped: true })).rejects.toMatchObject({ status: 409 });
    await expect(articles.saveDraft(user, projects[4]!, { expectedRevision: 0, contentMode: 'FACTUAL', content: mapped(text) })).rejects.toMatchObject({ status: 400 });
  });
  it('re-reviews unchanged approved content with one complete tuple and preserves original approval and inputs', async () => {
    const project = projects[6]!;
    const briefInput = { expectedRevision: 0, contentMode: 'CREATIVE' as const, topic: 'Початкова тема', audience: '', centralMessage: '', category: '', targetLength: 250, cta: '', exclusions: [], notes: '', requiredClaimRevisionIds: [] };
    await editorial.saveBrief(user, project, briefInput);
    await articles.saveDraft(user, project, { expectedRevision: 0, contentMode: 'CREATIVE', content: content() });
    const saved = await articles.checkpoint(user, project, { expectedRevision: 1 }), original = saved.article!.versions[0]!;
    const approved = await articles.review(member, project, original.id, 'approve', { expectedRevision: 2, acknowledgeUnmapped: true });
    expect(approved.article!.versions[0]!.eligible).toBe(true);
    await editorial.saveBrief(user, project, { ...briefInput, expectedRevision: 1, topic: 'Друга тема' });
    expect((await articles.get(user, project)).article!.versions[0]!.staleReasons).toContain('BRIEF_CHANGED');
    const currentBrief = (await editorial.get(user, project)).brief!.currentRevision!;
    const optionalOutline = await editorial.manualOutline(user, project, { expectedRevision: 0, briefRevisionId: currentBrief.id,
      content: { title: 'Необов’язкова структура', sections: [{ title: 'Вступ', purpose: 'Окрема робота над планом.', claimRevisionIds: [] }] } });
    await editorial.reviewOutline(user, project, optionalOutline.outline!.currentRevision!.id, 'approve', { expectedRevision: optionalOutline.outline!.revision });
    const reviewed = await articles.rereview(user, project, original.id, { expectedRevision: 3, expectedReviewCounter: 0, acknowledgeUnmapped: true });
    const receipt = reviewed.article!.versions[0]!;
    expect(receipt).toMatchObject({ eligible: true, reviewCounter: 1, approvedBy: member, sha256: original.sha256, briefRevisionId: original.briefRevisionId });
    expect(receipt.content).toEqual(original.content);
    expect(receipt.approvedAt).toEqual(approved.article!.versions[0]!.approvedAt);
    expect(receipt.reviewedBriefRevisionId).not.toBe(original.briefRevisionId);
    expect(receipt.reviewedOutlineRevisionId).toBeNull();
    await expect(articles.rereview(member, project, original.id, { expectedRevision: 4, expectedReviewCounter: 0, acknowledgeUnmapped: true })).rejects.toMatchObject({ status: 409 });
    await editorial.saveBrief(user, project, { ...briefInput, expectedRevision: 2, topic: 'Третя тема' });
    expect((await articles.get(user, project)).article!.versions[0]!.eligible).toBe(false);
    await expect(articles.rereview(outsider, project, original.id, { expectedRevision: 4, expectedReviewCounter: 1, acknowledgeUnmapped: true })).rejects.toMatchObject({ status: 404 });
    const again = await articles.rereview(member, project, original.id, { expectedRevision: 4, expectedReviewCounter: 1, acknowledgeUnmapped: true });
    expect(again.article!.versions[0]!.reviewCounter).toBe(2);
    await articles.review(user, project, original.id, 'withdraw', { expectedRevision: 5 });
    await expect(articles.rereview(member, project, original.id, { expectedRevision: 6, expectedReviewCounter: 2, acknowledgeUnmapped: true })).rejects.toMatchObject({ status: 409 });
  });
  it('cannot re-review approved factual prose after exact used evidence is invalidated', async () => {
    const project = projects[7]!, material = randomUUID(), snapshot = randomUUID(), text = 'Точний перевірений факт.';
    const fragment = importedFragments(text)[0]!;
    await health.prisma.material.create({ data: { id: material, projectId: project, kind: 'TEXT', purpose: 'FACTUAL_SOURCE', label: 'Повторний перегляд', createdBy: user } });
    await health.prisma.sourceSnapshot.create({ data: { id: snapshot, projectId: project, materialId: material, sequence: 1, normalizedText: text, sha256: createHash('sha256').update(text).digest('hex'), bytes: Buffer.byteLength(text), origin: 'MANUAL_TEXT', createdBy: user } });
    await health.prisma.sourceFragment.create({ data: { ...fragment, projectId: project, snapshotId: snapshot } });
    const proposed = await facts.create(user, project, { wording: text, evidence: [{ snapshotId: snapshot, fragmentId: fragment.id, startOffset: 0, endOffset: text.length, quote: text, sha256: fragment.sha256, relation: 'SUPPORTS' }] });
    const claim = proposed.claim.currentRevision!, evidence = claim.evidence[0]!;
    const approvedClaim = await facts.review(user, project, proposed.claim.id, claim.id, 'approve', { expectedRevision: proposed.claim.revision });
    await facts.freezeBasis(user, project, { claimRevisionIds: [claim.id] });
    const mapped: ArticleContent = { title: 'Факт', document: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text, marks: [{ type: 'evidence', attrs: { claimRevisionId: claim.id, evidenceId: evidence.id, quote: text } }] }] }] } };
    await articles.saveDraft(user, project, { expectedRevision: 0, contentMode: 'FACTUAL', content: mapped });
    const checkpoint = await articles.checkpoint(user, project, { expectedRevision: 1 }), version = checkpoint.article!.versions[0]!;
    await articles.review(user, project, version.id, 'approve', { expectedRevision: 2, acknowledgeUnmapped: true });
    await facts.invalidate(user, project, proposed.claim.id, evidence.id, { expectedRevision: approvedClaim.claim.revision, reason: 'Доказ визнано недійсним' });
    const blocked = (await articles.get(user, project)).article!.versions[0]!;
    expect(blocked.eligible).toBe(false);
    expect(blocked.blockingReasons).toContain('INVALID_FACTUAL_BASIS');
    await expect(articles.rereview(user, project, version.id, { expectedRevision: 3, expectedReviewCounter: 0, acknowledgeUnmapped: true })).rejects.toMatchObject({ status: 409 });
    expect((await articles.get(user, project)).article!.versions[0]!.reviewCounter).toBe(0);
  });
});
