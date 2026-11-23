import { createHash, randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ArticleService, DependencyHealthService, DurableJobService, EditorialService, FactualBasisService, TelegramService,
  EXTERNAL_PROCESSING_NOTICE, importedFragments, loadRuntimeConfig } from '@contextflow/backend';

describe('Telegram adaptation checkpoints and approval', () => {
  const config = loadRuntimeConfig(), health = new DependencyHealthService(config);
  const jobs = new DurableJobService(health.prisma, { noticeVersion: EXTERNAL_PROCESSING_NOTICE.version });
  const facts = new FactualBasisService(health.prisma, jobs), editorial = new EditorialService(health.prisma, jobs, facts);
  const articles = new ArticleService(health.prisma, jobs, facts), telegram = new TelegramService(health.prisma, jobs, facts, articles);
  const migration = new Pool({ connectionString: config.directDatabaseUrl, ssl: false });
  const owner = randomUUID(), member = randomUUID(), outsider = randomUUID(), workspace = randomUUID(), project = randomUUID(), factualProject = randomUUID();
  beforeAll(async () => {
    await health.prisma.userProfile.createMany({ data: [owner, member, outsider].map(id => ({ id })) });
    await health.prisma.workspace.create({ data: { id: workspace, name: 'Telegram fixture', ownerId: owner,
      members: { create: [{ userId: owner }, { userId: member }] }, styles: { create: { revision: 1, createdBy: owner } } } });
    await health.prisma.project.createMany({ data: [project, factualProject].map(id => ({ id, workspaceId: workspace, topic: 'Telegram domain', createdBy: owner, formats: ['TELEGRAM_POST' as const] })) });
  });
  afterAll(async () => {
    const db = await migration.connect();
    try {
      await db.query('BEGIN');
      const immutableTables = ['AdaptationRevisionClaim', 'AdaptationDraft', 'AdaptationRevision', 'Adaptation', 'ArticleVersionClaim', 'ArticleDraft', 'ArticleVersion', 'Article',
        'Brief', 'BriefRevision', 'BriefRequiredClaim', 'BriefContextSnapshot', 'Outline', 'OutlineRevision'];
      for (const table of immutableTables) await db.query(`ALTER TABLE contextflow."${table}" DISABLE TRIGGER "${table}_no_delete"`);
      await db.query('ALTER TABLE contextflow."Brief" DISABLE TRIGGER "Brief_pointer_guard"');
      for (const projectId of [project, factualProject]) {
        await db.query('UPDATE contextflow."Adaptation" SET "currentApprovedRevisionId"=NULL,"revision"="revision"+1 WHERE "projectId"=$1', [projectId]);
        for (const table of ['AdaptationRevisionClaim', 'AdaptationDraft', 'AdaptationRevision', 'Adaptation']) await db.query(`DELETE FROM contextflow."${table}" WHERE "projectId"=$1`, [projectId]);
        await db.query('UPDATE contextflow."Article" SET "currentApprovedVersionId"=NULL,"revision"="revision"+1 WHERE "projectId"=$1', [projectId]);
        for (const table of ['ArticleVersionClaim', 'ArticleDraft', 'ArticleVersion', 'Article']) await db.query(`DELETE FROM contextflow."${table}" WHERE "projectId"=$1`, [projectId]);
        await db.query('UPDATE contextflow."Outline" SET "currentRevisionId"=NULL,"currentApprovedRevisionId"=NULL,"revision"="revision"+1 WHERE "projectId"=$1', [projectId]);
        for (const table of ['OutlineRevision', 'Outline']) await db.query(`DELETE FROM contextflow."${table}" WHERE "projectId"=$1`, [projectId]);
        await db.query('UPDATE contextflow."Brief" SET "currentRevisionId"=NULL,"revision"="revision"+1 WHERE "projectId"=$1', [projectId]);
        for (const table of ['BriefRequiredClaim', 'BriefContextSnapshot', 'BriefRevision', 'Brief']) await db.query(`DELETE FROM contextflow."${table}" WHERE "projectId"=$1`, [projectId]);
        for (const table of ['BasisClaimEvidence', 'BasisClaim', 'FactualBasisRevision']) await db.query(`DELETE FROM contextflow."${table}" WHERE "projectId"=$1`, [projectId]);
        await db.query('UPDATE contextflow."Claim" SET "currentRevisionId"=NULL,"revision"="revision"+1,"updatedAt"=CURRENT_TIMESTAMP WHERE "projectId"=$1', [projectId]);
        for (const table of ['ClaimEvidence', 'ClaimRevision', 'Claim']) await db.query(`DELETE FROM contextflow."${table}" WHERE "projectId"=$1`, [projectId]);
        await db.query('UPDATE contextflow."Material" SET "currentSnapshotId"=NULL,"revision"="revision"+1,"updatedAt"=CURRENT_TIMESTAMP WHERE "projectId"=$1', [projectId]);
        for (const table of ['SourceFragment', 'SourceSnapshot', 'Material']) await db.query(`DELETE FROM contextflow."${table}" WHERE "projectId"=$1`, [projectId]);
        await db.query('DELETE FROM contextflow."Project" WHERE "id"=$1', [projectId]);
      }
      await db.query('DELETE FROM contextflow."WorkspaceStyleRevision" WHERE "workspaceId"=$1', [workspace]);
      await db.query('DELETE FROM contextflow."WorkspaceMember" WHERE "workspaceId"=$1', [workspace]);
      await db.query('DELETE FROM contextflow."Workspace" WHERE "id"=$1', [workspace]);
      await db.query('DELETE FROM contextflow."UserProfile" WHERE "id"=ANY($1::uuid[])', [[owner, member, outsider]]);
      await db.query('ALTER TABLE contextflow."Brief" ENABLE TRIGGER "Brief_pointer_guard"');
      for (const table of immutableTables) await db.query(`ALTER TABLE contextflow."${table}" ENABLE TRIGGER "${table}_no_delete"`);
      await db.query('COMMIT');
    } catch (error) { await db.query('ROLLBACK'); throw error; }
    finally { db.release(); await migration.end(); await health.onModuleDestroy(); }
  });
  it('saves a direct draft against the saved mode-specific Brief, checkpoints exact text and requires the current review counter', async () => {
    await editorial.saveBrief(owner, project, { expectedRevision: 0, contentMode: 'CREATIVE', topic: 'Коротке повідомлення', audience: '', centralMessage: '', category: '', targetLength: 250, cta: '', exclusions: [], notes: '', requiredClaimRevisionIds: [] });
    const content = { text: 'Підготуйтеся до оновлення сервісу о 20:00.', mappings: [] };
    const saved = await telegram.saveDraft(member, project, { expectedRevision: 0, inputMode: 'DIRECT', contentMode: 'CREATIVE', includeLink: false, content });
    expect(saved.adaptation).toMatchObject({ revision: 1, currentApprovedRevisionId: null, draft: { inputMode: 'DIRECT', origin: 'MANUAL', briefRevisionId: expect.any(String) } });
    await expect(telegram.saveDraft(owner, project, { expectedRevision: 0, inputMode: 'DIRECT', contentMode: 'CREATIVE', includeLink: false, content })).rejects.toMatchObject({ status: 409 });
    const checkpointed = await telegram.checkpoint(owner, project, { expectedRevision: 1 });
    const revision = checkpointed.adaptation!.revisions[0]!;
    expect(revision).toMatchObject({ content, claimsSealed: true, reviewCounter: 0, status: 'PROPOSED', hasUnmapped: true });
    expect(revision.mappingDetails).toEqual([]);
    await expect(telegram.review(owner, project, revision.id, 'approve', { expectedRevision: 2, acknowledgeUnmapped: true })).rejects.toMatchObject({ status: 409 });
    const approved = await telegram.review(member, project, revision.id, 'approve', { expectedRevision: 2, expectedReviewCounter: 0 });
    expect(approved.adaptation).toMatchObject({ revision: 3, currentApprovedRevisionId: revision.id });
    expect(approved.adaptation!.revisions[0]).toMatchObject({ reviewCounter: 0, approvedBy: member, acknowledgedUnmapped: false, claimsSealed: true });
    await editorial.saveBrief(owner, project, { expectedRevision: 1, contentMode: 'CREATIVE', topic: 'Нова тема', audience: '', centralMessage: '', category: '', targetLength: 250, cta: '', exclusions: [], notes: '', requiredClaimRevisionIds: [] });
    const retained = await telegram.saveDraft(owner, project, { expectedRevision: 3, inputMode: 'DIRECT', contentMode: 'CREATIVE', includeLink: false, content: { ...content, text: 'Збережене ручне повідомлення після зміни Brief.' } });
    expect(retained.adaptation!.draft).toMatchObject({ briefRevisionId: revision.briefRevisionId, content: { text: 'Збережене ручне повідомлення після зміни Brief.' } });
    expect(retained.staleReasons).toContain('BRIEF_CHANGED');
    const rereviewed = await telegram.rereview(member, project, revision.id, { expectedRevision: 4, expectedReviewCounter: 0 });
    expect(rereviewed.adaptation!.revisions[0]!.reviewCounter).toBe(1);
    expect(rereviewed.adaptation!.revisions[0]!.reviewedBriefRevisionId !== revision.briefRevisionId).toBe(true);
    await editorial.saveBrief(owner, project, { expectedRevision: 2, contentMode: 'CREATIVE', topic: 'Ще новіша тема', audience: '', centralMessage: '', category: '', targetLength: 250, cta: '', exclusions: [], notes: '', requiredClaimRevisionIds: [] });
    expect((await telegram.get(member, project)).adaptation!.revisions[0]!.staleReasons).toContain('INPUTS_CHANGED');
    await expect(telegram.get(outsider, project)).rejects.toMatchObject({ status: 404 });
    await health.prisma.workspaceMember.update({ where: { workspaceId_userId: { workspaceId: workspace, userId: member } }, data: { leftAt: new Date() } });
    await expect(telegram.get(member, project)).rejects.toMatchObject({ status: 404 });
    await health.prisma.workspaceMember.update({ where: { workspaceId_userId: { workspaceId: workspace, userId: member } }, data: { leftAt: null } });
  });
  it('preserves factual Telegram evidence lineage and refuses re-review after its original basis is invalidated', async () => {
    async function makeFact(text: string) {
      const materialId = randomUUID(), snapshotId = randomUUID(), fragment = importedFragments(text)[0]!;
      await health.prisma.material.create({ data: { id: materialId, projectId: factualProject, kind: 'TEXT', purpose: 'FACTUAL_SOURCE', label: 'Джерело', createdBy: owner } });
      await health.prisma.sourceSnapshot.create({ data: { id: snapshotId, projectId: factualProject, materialId, sequence: 1, normalizedText: text,
        sha256: createHash('sha256').update(text).digest('hex'), bytes: Buffer.byteLength(text), origin: 'MANUAL_TEXT', createdBy: owner } });
      await health.prisma.sourceFragment.create({ data: { ...fragment, projectId: factualProject, snapshotId } });
      const created = await facts.create(owner, factualProject, { wording: text, evidence: [{ snapshotId, fragmentId: fragment.id, startOffset: fragment.startOffset,
        endOffset: fragment.endOffset, quote: text, sha256: fragment.sha256, relation: 'SUPPORTS' }] });
      const reviewed = await facts.review(owner, factualProject, created.claim.id, created.claim.currentRevision!.id, 'approve', { expectedRevision: created.claim.revision });
      return { claimId: created.claim.id, revision: created.claim.currentRevision!, claimRevisionNumber: reviewed.claim.revision, evidence: created.claim.currentRevision!.evidence[0]! };
    }
    const original = await makeFact('Оновлення сервісу почнеться о 20:00.');
    const oldBasis = await facts.freezeBasis(owner, factualProject, { claimRevisionIds: [original.revision.id] });
    await editorial.saveBrief(owner, factualProject, { expectedRevision: 0, contentMode: 'FACTUAL', topic: 'Оновлення', audience: '', centralMessage: '', category: '', targetLength: 250, cta: '', exclusions: [], notes: '', requiredClaimRevisionIds: [original.revision.id] });
    const originalText = 'Оновлення сервісу почнеться о 20:00.';
    const content = { text: originalText, mappings: [{ startOffset: 0, endOffset: originalText.length, quote: originalText,
      claimRevisionId: original.revision.id, evidenceId: original.evidence.id }] };
    const saved = await telegram.saveDraft(owner, factualProject, { expectedRevision: 0, inputMode: 'DIRECT', contentMode: 'FACTUAL', includeLink: false, content });
    const checkpoint = await telegram.checkpoint(owner, factualProject, { expectedRevision: 1 }), version = checkpoint.adaptation!.revisions[0]!;
    expect(version.mappingDetails).toMatchObject([{ quote: original.evidence.quote, evidence: { quote: original.evidence.quote, snapshotId: original.evidence.snapshotId, materialTitle: 'Джерело' } }]);
    const approved = await telegram.review(owner, factualProject, version.id, 'approve', { expectedRevision: 2, expectedReviewCounter: 0 });
    expect(approved.adaptation!.revisions[0]).toMatchObject({ approvedAt: expect.anything(), basisRevisionId: oldBasis.basis!.id, reviewCounter: 0 });
    await facts.invalidate(owner, factualProject, original.claimId, original.evidence.id, { expectedRevision: original.claimRevisionNumber, reason: 'Потрібна повторна перевірка' });
    const replacement = await makeFact('Заплановане оновлення почнеться о 21:00.');
    const currentBasis = await facts.freezeBasis(owner, factualProject, { claimRevisionIds: [replacement.revision.id] });
    await editorial.saveBrief(owner, factualProject, { expectedRevision: 1, contentMode: 'FACTUAL', topic: 'Оновлення', audience: '', centralMessage: '', category: '', targetLength: 250, cta: '', exclusions: [], notes: '', requiredClaimRevisionIds: [replacement.revision.id] });
    expect(currentBasis.basis!.id !== oldBasis.basis!.id).toBe(true);
    await expect(telegram.rereview(owner, factualProject, version.id, { expectedRevision: 3, expectedReviewCounter: 0, acknowledgeUnmapped: true })).rejects.toMatchObject({ status: 409 });
    expect(saved.adaptation!.draft!.basisRevisionId).toBe(oldBasis.basis!.id);
  });
  it('keeps direct inputs independent of Article and retains a derived draft after its source approval is withdrawn', async () => {
    await health.prisma.project.update({ where: { id: project }, data: { formats: ['TELEGRAM_POST', 'ARTICLE'] } });
    await editorial.saveBrief(owner, project, { expectedRevision: 3, contentMode: 'CREATIVE', topic: 'Повідомлення', audience: '', centralMessage: '', category: '', targetLength: 250, cta: '', exclusions: [], notes: '', requiredClaimRevisionIds: [] });
    const beforeDirect = (await telegram.get(member, project)).adaptation!;
    const directDraft = await telegram.saveDraft(member, project, { expectedRevision: beforeDirect.revision, inputMode: 'DIRECT', contentMode: 'CREATIVE', includeLink: false, refreshInputs: true,
      content: { text: 'Новий direct допис.', mappings: [] } });
    const directCheckpoint = await telegram.checkpoint(member, project, { expectedRevision: directDraft.adaptation!.revision });
    const directVersion = directCheckpoint.adaptation!.revisions[0]!;
    const directApproved = await telegram.review(member, project, directVersion.id, 'approve', { expectedRevision: directCheckpoint.adaptation!.revision, acknowledgeUnmapped: true, expectedReviewCounter: 0 });
    expect(directApproved.adaptation!.revisions.find(row => row.id === directVersion.id)).toMatchObject({ hasUnmapped: true });
    const brief = (await editorial.get(owner, project)).brief!.currentRevision!;
    const outlineState = await editorial.manualOutline(owner, project, { expectedRevision: 0, briefRevisionId: brief.id,
      content: { title: 'План', sections: [{ title: 'Контекст', purpose: 'Пояснити читачеві тему.', claimRevisionIds: [] }] } });
    const outlineRevision = outlineState.outline!.currentRevision!;
    await editorial.reviewOutline(owner, project, outlineRevision.id, 'approve', { expectedRevision: outlineState.outline!.revision });
    const articleContent = { title: 'Вихідна стаття', document: { type: 'doc' as const, content: [{ type: 'paragraph' as const, content: [{ type: 'text' as const, text: 'Текст для окремого каналу.' }] }] } };
    const articleDraft = await articles.saveDraft(owner, project, { expectedRevision: 0, contentMode: 'CREATIVE', content: articleContent });
    const articleCheckpoint = await articles.checkpoint(owner, project, { expectedRevision: articleDraft.article!.revision });
    const articleVersion = articleCheckpoint.article!.versions[0]!;
    const articleApproved = await articles.review(owner, project, articleVersion.id, 'approve', { expectedRevision: articleCheckpoint.article!.revision, acknowledgeUnmapped: true });
    const current = directApproved.adaptation!;
    const derivedContent = { text: 'Окремий короткий допис.', mappings: [] };
    const derived = await telegram.saveDraft(member, project, { expectedRevision: current.revision, inputMode: 'ARTICLE_DERIVED', contentMode: 'CREATIVE', includeLink: true, content: derivedContent });
    expect(derived.adaptation!.draft).toMatchObject({ inputMode: 'ARTICLE_DERIVED', sourceArticleVersionId: articleVersion.id, includeLink: true });
    const changedOutline = await editorial.manualOutline(owner, project, { expectedRevision: 2, briefRevisionId: brief.id,
      content: { title: 'Оновлений план', sections: [{ title: 'Огляд', purpose: 'Додати новий кут.', claimRevisionIds: [] }] } });
    expect(changedOutline.outline!.revision).toBe(3);
    const afterOutlineChange = await telegram.get(member, project);
    expect(afterOutlineChange.staleReasons).toContain('SOURCE_ARTICLE_NEEDS_REVIEW');
    expect(afterOutlineChange.adaptation!.revisions.find(row => row.id === directVersion.id)?.eligible).toBe(true);
    await articles.review(owner, project, articleVersion.id, 'withdraw', { expectedRevision: articleApproved.article!.revision, reason: 'Приклад відкликаної версії' });
    const retained = await telegram.saveDraft(member, project, { expectedRevision: derived.adaptation!.revision, inputMode: 'ARTICLE_DERIVED', contentMode: 'CREATIVE', includeLink: true,
      content: { ...derivedContent, text: 'Збережений derived текст після відкликання статті.' } });
    expect(retained.adaptation!.draft).toMatchObject({ sourceArticleVersionId: articleVersion.id, content: { text: 'Збережений derived текст після відкликання статті.' } });
    expect(retained.staleReasons).toContain('INVALID_ORIGINAL_SOURCE_ARTICLE');
    expect(retained.adaptation!.revisions.find(row => row.id === directVersion.id)?.eligible).toBe(true);
  });
});
