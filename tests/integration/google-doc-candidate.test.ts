import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ArticleService, DependencyHealthService, DurableJobService, EditorialService, EXTERNAL_PROCESSING_NOTICE, FactualBasisService, loadRuntimeConfig, type ArticleContent } from '@contextflow/backend';

describe('Google Docs imported article candidates', () => {
  const config = loadRuntimeConfig(), health = new DependencyHealthService(config), jobs = new DurableJobService(health.prisma, { noticeVersion: EXTERNAL_PROCESSING_NOTICE.version });
  const facts = new FactualBasisService(health.prisma, jobs), articles = new ArticleService(health.prisma, jobs, facts), editorial = new EditorialService(health.prisma, jobs, facts);
  const migration = new Pool({ connectionString: config.directDatabaseUrl, ssl: false });
  const user = randomUUID(), workspace = randomUUID(), projects = Array.from({ length: 3 }, () => randomUUID());
  const content = (text: string, withEvidence = false): ArticleContent => ({ title: 'Google candidate', document: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text, ...(withEvidence ? { marks: [{ type: 'evidence', attrs: { claimRevisionId: randomUUID(), evidenceId: randomUUID(), quote: text } }] } : {}) }] }] } });
  const brief = (expectedRevision: number, topic: string) => ({ expectedRevision, contentMode: 'CREATIVE' as const, topic, audience: '', centralMessage: '', category: '', targetLength: 250, cta: '', exclusions: [], notes: '', requiredClaimRevisionIds: [] });

  beforeAll(async () => {
    await health.prisma.userProfile.create({ data: { id: user, externalProcessingNoticeVersion: EXTERNAL_PROCESSING_NOTICE.version, externalProcessingAcceptedAt: new Date() } });
    await health.prisma.workspace.create({ data: { id: workspace, name: 'Google candidate fixture', ownerId: user, members: { create: [{ userId: user }] }, styles: { create: { revision: 1, createdBy: user } } } });
    await health.prisma.project.createMany({ data: projects.map(id => ({ id, workspaceId: workspace, topic: 'Google candidate test', createdBy: user, formats: ['ARTICLE'] })) });
  });
  afterAll(async () => {
    const db = await migration.connect();
    const tables = ['Article', 'ArticleDraft', 'ArticleVersion', 'ArticleVersionClaim', 'Brief', 'BriefRevision'];
    try {
      await db.query('BEGIN');
      for (const table of tables) await db.query(`ALTER TABLE contextflow."${table}" DISABLE TRIGGER "${table}_no_delete"`).catch(() => undefined);
      await db.query('ALTER TABLE contextflow."Brief" DISABLE TRIGGER "Brief_pointer_guard"').catch(() => undefined);
      for (const project of projects) {
        await db.query('UPDATE contextflow."Article" SET "currentApprovedVersionId"=NULL,"revision"="revision"+1 WHERE "projectId"=$1 AND "currentApprovedVersionId" IS NOT NULL', [project]);
        for (const table of ['ArticleVersionClaim', 'ArticleDraft', 'ArticleVersion', 'Article']) await db.query(`DELETE FROM contextflow."${table}" WHERE "projectId"=$1`, [project]);
        await db.query('UPDATE contextflow."Brief" SET "currentRevisionId"=NULL,"revision"="revision"+1 WHERE "projectId"=$1', [project]);
        for (const table of ['BriefRequiredClaim', 'BriefContextSnapshot', 'BriefRevision', 'Brief']) await db.query(`DELETE FROM contextflow."${table}" WHERE "projectId"=$1`, [project]);
        await db.query('DELETE FROM contextflow."JobAttempt" WHERE "jobId" IN (SELECT "id" FROM contextflow."Job" WHERE "projectId"=$1)', [project]);
        await db.query('DELETE FROM contextflow."Job" WHERE "projectId"=$1', [project]);
        await db.query('DELETE FROM contextflow."Project" WHERE "id"=$1', [project]);
      }
      await db.query('DELETE FROM contextflow."WorkspaceStyleRevision" WHERE "workspaceId"=$1', [workspace]);
      await db.query('DELETE FROM contextflow."WorkspaceMember" WHERE "workspaceId"=$1', [workspace]);
      await db.query('DELETE FROM contextflow."Workspace" WHERE "id"=$1', [workspace]);
      await db.query('DELETE FROM contextflow."UserProfile" WHERE "id"=$1', [user]);
      for (const table of tables) await db.query(`ALTER TABLE contextflow."${table}" ENABLE TRIGGER "${table}_no_delete"`).catch(() => undefined);
      await db.query('ALTER TABLE contextflow."Brief" ENABLE TRIGGER "Brief_pointer_guard"').catch(() => undefined);
      await db.query('COMMIT');
    } catch (error) { await db.query('ROLLBACK'); throw error; }
    finally { db.release(); await migration.end(); await health.onModuleDestroy(); }
  });

  it('freezes the selected version inputs even after the current brief changes', async () => {
    const project = projects[0]!;
    await editorial.saveBrief(user, project, brief(0, 'Original brief'));
    await articles.importArticle(user, project, { expectedRevision: 0, contentMode: 'CREATIVE', content: content('Saved source') });
    const checkpoint = await articles.checkpoint(user, project, { expectedRevision: 1 }), source = checkpoint.article!.versions[0]!;
    const frozen = await health.prisma.$transaction(tx => articles.freezeGoogleInputs(tx, user, project, source.id, checkpoint.article!.revision));
    await editorial.saveBrief(user, project, brief(1, 'Changed current brief'));
    const candidateId = await health.prisma.$transaction(tx => articles.appendGoogleCandidate(tx, user, project, content('Remote edit'), frozen));
    const candidate = await health.prisma.articleVersion.findUniqueOrThrow({ where: { id: candidateId } });
    expect(candidate).toMatchObject({ origin: 'UNVERIFIED_IMPORTED', contentMode: source.contentMode, briefRevisionId: source.briefRevisionId, basisRevisionId: source.basisRevisionId, outlineRevisionId: source.outlineRevisionId, sourceArticleRevision: frozen.expectedArticleRevision });
    expect(candidate.briefRevisionId).not.toBe((await editorial.get(user, project)).brief!.currentRevision!.id);
  });

  it('appends an unverified candidate without changing the saved draft or active approval and strips imported evidence marks', async () => {
    const project = projects[1]!;
    await articles.importArticle(user, project, { expectedRevision: 0, contentMode: 'CREATIVE', content: content('Original text') });
    const checkpoint = await articles.checkpoint(user, project, { expectedRevision: 1 }), source = checkpoint.article!.versions[0]!;
    await articles.review(user, project, source.id, 'approve', { expectedRevision: checkpoint.article!.revision, acknowledgeUnmapped: true });
    const before = await articles.get(user, project), frozen = await health.prisma.$transaction(tx => articles.freezeGoogleInputs(tx, user, project, source.id, before.article!.revision));
    const candidateId = await health.prisma.$transaction(tx => articles.appendGoogleCandidate(tx, user, project, content('Remote wording', true), frozen));
    const after = await articles.get(user, project), candidate = after.article!.versions.find(row => row.id === candidateId)!;
    expect(after.article!.draft).toEqual(before.article!.draft);
    expect(after.article!.currentApprovedVersionId).toBe(source.id);
    expect(candidate).toMatchObject({ origin: 'UNVERIFIED_IMPORTED', approvedAt: null, acknowledgedUnmapped: false, sourceArticleRevision: frozen.expectedArticleRevision });
    expect(JSON.stringify(candidate.content)).not.toContain('evidence');
    expect(candidate.claims).toEqual([]);
    expect(after.article!.revision).toBe(before.article!.revision);
  });

  it('rejects a foreign or hash-corrupt source and keeps imported candidates separate from AI job provenance', async () => {
    const project = projects[2]!;
    await articles.importArticle(user, project, { expectedRevision: 0, contentMode: 'CREATIVE', content: content('Local source') });
    const checkpoint = await articles.checkpoint(user, project, { expectedRevision: 1 }), source = checkpoint.article!.versions[0]!;
    await expect(health.prisma.$transaction(tx => articles.freezeGoogleInputs(tx, user, project, source.id, checkpoint.article!.revision))).resolves.toMatchObject({ sourceVersionId: source.id });
    await expect(health.prisma.$transaction(tx => articles.freezeGoogleInputs(tx, user, projects[0]!, source.id, 0))).rejects.toMatchObject({ status: 409 });
    const db = await migration.connect();
    try {
      await db.query('ALTER TABLE contextflow."ArticleVersion" DISABLE TRIGGER "ArticleVersion_review_guard"');
      await db.query('UPDATE contextflow."ArticleVersion" SET "sha256"=repeat(\'0\',64) WHERE "id"=$1', [source.id]);
      await db.query('ALTER TABLE contextflow."ArticleVersion" ENABLE TRIGGER "ArticleVersion_review_guard"');
      await expect(health.prisma.$transaction(tx => articles.freezeGoogleInputs(tx, user, project, source.id, checkpoint.article!.revision))).rejects.toMatchObject({ status: 409 });
    } finally {
      await db.query('ALTER TABLE contextflow."ArticleVersion" DISABLE TRIGGER "ArticleVersion_review_guard"');
      await db.query('UPDATE contextflow."ArticleVersion" SET "sha256"=$2 WHERE "id"=$1', [source.id, source.sha256]);
      await db.query('ALTER TABLE contextflow."ArticleVersion" ENABLE TRIGGER "ArticleVersion_review_guard"');
      db.release();
    }
    const frozen = await health.prisma.$transaction(tx => articles.freezeGoogleInputs(tx, user, project, source.id, checkpoint.article!.revision));
    const candidateId = await health.prisma.$transaction(tx => articles.appendGoogleCandidate(tx, user, project, content('Remote candidate'), frozen));
    expect(await health.prisma.articleVersion.findUniqueOrThrow({ where: { id: candidateId } })).toMatchObject({ origin: 'UNVERIFIED_IMPORTED', jobId: null, aiExecutionId: null });
  });
});
