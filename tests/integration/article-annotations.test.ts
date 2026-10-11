import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ArticleAnnotationService, ArticleService, DependencyHealthService, DurableJobService, EXTERNAL_PROCESSING_NOTICE, FactualBasisService, loadRuntimeConfig, type ArticleContent } from '@contextflow/backend';

describe('article annotation history and suggestion candidates', () => {
  const config = loadRuntimeConfig(), health = new DependencyHealthService(config), jobs = new DurableJobService(health.prisma, { noticeVersion: EXTERNAL_PROCESSING_NOTICE.version });
  const facts = new FactualBasisService(health.prisma, jobs), articles = new ArticleService(health.prisma, jobs, facts), annotations = new ArticleAnnotationService(health.prisma, articles);
  const migration = new Pool({ connectionString: config.directDatabaseUrl, ssl: false });
  const user = randomUUID(), member = randomUUID(), outsider = randomUUID(), workspace = randomUUID(), project = randomUUID(), foreignProject = randomUUID();
  const text = 'Before selected words after.';
  const content: ArticleContent = { title: 'Synthetic article', document: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] } };
  beforeAll(async () => {
    await health.prisma.userProfile.createMany({ data: [user, member, outsider].map(id => ({ id })) });
    await health.prisma.workspace.create({ data: { id: workspace, name: 'Annotation fixture', ownerId: user, members: { create: [{ userId: user }, { userId: member }] }, styles: { create: { revision: 1, createdBy: user } } } });
    await health.prisma.project.createMany({ data: [project, foreignProject].map(id => ({ id, workspaceId: workspace, topic: 'Annotation test', createdBy: user, formats: ['ARTICLE'] })) });
  });
  afterAll(async () => {
    const db = await migration.connect();
    try {
      await db.query('BEGIN');
      for (const table of ['Article', 'ArticleDraft', 'ArticleVersion', 'ArticleAnnotation', 'ArticleAnnotationPost']) await db.query(`ALTER TABLE contextflow."${table}" DISABLE TRIGGER "${table}_no_delete"`);
      await db.query('DELETE FROM contextflow."ArticleAnnotationPost" WHERE "projectId"=ANY($1::uuid[])', [[project, foreignProject]]);
      await db.query('DELETE FROM contextflow."ArticleAnnotation" WHERE "projectId"=ANY($1::uuid[])', [[project, foreignProject]]);
      for (const id of [project, foreignProject]) {
        await db.query('UPDATE contextflow."Article" SET "currentApprovedVersionId"=NULL,"revision"="revision"+1 WHERE "projectId"=$1 AND "currentApprovedVersionId" IS NOT NULL', [id]);
        for (const table of ['ArticleVersionClaim', 'ArticleDraft', 'ArticleVersion', 'Article']) await db.query(`DELETE FROM contextflow."${table}" WHERE "projectId"=$1`, [id]);
      }
      await db.query('DELETE FROM contextflow."Project" WHERE "id"=ANY($1::uuid[])', [[project, foreignProject]]);
      await db.query('DELETE FROM contextflow."WorkspaceStyleRevision" WHERE "workspaceId"=$1', [workspace]);
      await db.query('DELETE FROM contextflow."WorkspaceMember" WHERE "workspaceId"=$1', [workspace]);
      await db.query('DELETE FROM contextflow."Workspace" WHERE "id"=$1', [workspace]);
      await db.query('DELETE FROM contextflow."UserProfile" WHERE "id"=ANY($1::uuid[])', [[user, member, outsider]]);
      for (const table of ['Article', 'ArticleDraft', 'ArticleVersion', 'ArticleAnnotation', 'ArticleAnnotationPost']) await db.query(`ALTER TABLE contextflow."${table}" ENABLE TRIGGER "${table}_no_delete"`);
      await db.query('COMMIT');
    } catch (error) { await db.query('ROLLBACK'); throw error; }
    finally { db.release(); await migration.end(); await health.onModuleDestroy(); }
  });
  it('keeps immutable comment history, replays create exactly, isolates projects, and accepts into an unapproved candidate', async () => {
    await articles.importArticle(user, project, { expectedRevision: 0, contentMode: 'CREATIVE', content });
    const checkpoint = await articles.checkpoint(user, project, { expectedRevision: 1 }), source = checkpoint.article!.versions[0]!;
    expect(source.origin).toBe('UNVERIFIED_IMPORTED');
    const start = text.indexOf('selected'), end = start + 'selected words'.length;
    const input = { articleVersionId: source.id, contentHash: source.sha256, anchorStart: start, anchorEnd: end, body: 'Could we revise this?', kind: 'COMMENT' as const, commandKey: randomUUID() };
    const created = await annotations.create(member, project, input), thread = created.threads[0]!;
    expect(thread).toMatchObject({ kind: 'COMMENT', status: 'OPEN', revision: 0, anchor: { status: 'EXACT', start, end } });
    const db = await migration.connect();
    await db.query('BEGIN');
    async function reject(sql: string, values: unknown[]) {
      await db.query('SAVEPOINT annotation_guard');
      try { await expect(db.query(sql, values)).rejects.toMatchObject({ code: '23514' }); }
      finally { await db.query('ROLLBACK TO SAVEPOINT annotation_guard'); await db.query('RELEASE SAVEPOINT annotation_guard'); }
    }
    await reject('UPDATE contextflow."ArticleAnnotation" SET "anchorStart"="anchorStart"+1,"revision"="revision"+1 WHERE "id"=$1', [thread.id]);
    await reject('UPDATE contextflow."ArticleAnnotation" SET "status"=\'ACCEPTED\',"revision"="revision"+1 WHERE "id"=$1', [thread.id]);
    expect((await annotations.create(member, project, input)).replayed).toBe(true);
    await expect(annotations.create(outsider, project, input)).rejects.toMatchObject({ status: 404 });
    const replied = await annotations.reply(user, project, thread.id, 0, 'I agree; update the wording.');
    await reject('UPDATE contextflow."ArticleAnnotationPost" SET "body"=\'Changed history\' WHERE "id"=$1', [replied.threads[0]!.posts[0]!.id]);
    await db.query('COMMIT');
    db.release();
    await expect(annotations.reply(user, project, thread.id, 0, 'A stale reply')).rejects.toMatchObject({ status: 409 });
    const resolved = await annotations.act(user, project, thread.id, { expectedRevision: 1, action: 'RESOLVE' });
    expect(resolved.threads[0]!.posts).toHaveLength(2);
    await annotations.act(user, project, thread.id, { expectedRevision: 2, action: 'REOPEN' });
    const suggestion = await annotations.create(member, project, { ...input, kind: 'SUGGESTION', body: 'Replace this phrase', replacementText: 'revised words', commandKey: randomUUID() });
    const result = await annotations.act(user, project, suggestion.threads[0]!.id, { expectedRevision: 0, action: 'ACCEPT', expectedArticleRevision: checkpoint.article!.revision });
    expect(result).toMatchObject({ candidateVersionId: expect.any(String), threads: [{ status: 'ACCEPTED', resultVersionId: expect.any(String) }] });
    const state = await articles.get(user, project);
    expect(state.article!.versions).toHaveLength(2);
    expect(state.article!.versions[0]!.plainText).toBe('Before revised words after.');
    expect(state.article!.versions[0]!.origin).toBe('UNVERIFIED_IMPORTED');
    expect(state.article!.versions[0]!.approvedAt).toBeNull();
    expect(state.article!.versions[1]!.content).toEqual(source.content);
    expect(state.article!.currentApprovedVersionId).toBeNull();
    expect((await annotations.list(member, project, state.article!.versions[0]!.id)).threads.find(row => row.id === thread.id)?.anchor.status).toBe('UNRESOLVED');
    expect((await annotations.list(member, foreignProject)).threads).toEqual([]);
  });
});
