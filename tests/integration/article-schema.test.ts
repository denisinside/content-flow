import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, describe, expect, it } from 'vitest';
import { databasePoolOptions, loadRuntimeConfig } from '@contextflow/backend';
const pool = new Pool(databasePoolOptions(loadRuntimeConfig()));
afterAll(async () => { await pool.end(); });
describe('article provenance database constraints', () => {
  it('enforces project ancestry, sealed mappings, immutable approved bytes and terminal withdrawal through runtime SQL', async () => {
    const db = await pool.connect(), user = randomUUID(), workspace = randomUUID(), project = randomUUID(), foreign = randomUUID(), article = randomUUID(), foreignArticle = randomUUID(), version = randomUUID();
    const content = JSON.stringify({ title: 'Synthetic article', document: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Synthetic body' }] }] } });
    async function reject(sql: string, values: unknown[], code = '23514') { await db.query('SAVEPOINT rejected_article_write'); try { await expect(db.query(sql, values)).rejects.toMatchObject({ code }); } finally { await db.query('ROLLBACK TO SAVEPOINT rejected_article_write'); await db.query('RELEASE SAVEPOINT rejected_article_write'); } }
    try {
      await db.query('BEGIN');
      await db.query('INSERT INTO contextflow."UserProfile" ("id") VALUES($1)', [user]);
      await db.query('INSERT INTO contextflow."Workspace" ("id","name","ownerId") VALUES($1,\'Article schema\',$2)', [workspace, user]);
      await db.query('INSERT INTO contextflow."WorkspaceStyleRevision" ("workspaceId","revision","createdBy") VALUES($1,1,$2)', [workspace, user]);
      for (const [id, container] of [[project, article], [foreign, foreignArticle]]) {
        await db.query('INSERT INTO contextflow."Project" ("id","workspaceId","topic","formats","createdBy") VALUES($1,$2,\'Article schema\',$3,$4)', [id, workspace, ['ARTICLE'], user]);
        await db.query('INSERT INTO contextflow."Article" ("id","projectId") VALUES($1,$2)', [container, id]);
      }
      const insert = 'INSERT INTO contextflow."ArticleVersion" ("id","projectId","articleId","number","content","plainText","sha256","contentMode","origin","sourceArticleRevision","workspaceId","workspaceStyleRevision","createdBy") VALUES($1,$2,$3,1,$4,\'Synthetic body\',$5,\'CREATIVE\',\'MANUAL\',0,$6,1,$7)';
      await reject(insert, [randomUUID(), project, foreignArticle, content, 'a'.repeat(64), workspace, user], '23503');
      await reject(insert, [randomUUID(), project, article, '{}', 'a'.repeat(64), workspace, user]);
      await db.query(insert, [version, project, article, content, 'a'.repeat(64), workspace, user]);
      await reject('UPDATE contextflow."ArticleVersion" SET "content"=$1 WHERE "id"=$2', [content.replace('Synthetic body', 'Changed'), version]);
      await reject('UPDATE contextflow."ArticleVersion" SET "approvedBy"=$1,"approvedAt"=CURRENT_TIMESTAMP WHERE "id"=$2', [user, version]);
      await db.query('UPDATE contextflow."ArticleVersion" SET "claimsSealed"=true WHERE "id"=$1', [version]);
      await reject('UPDATE contextflow."ArticleVersion" SET "claimsSealed"=false WHERE "id"=$1', [version]);
      await reject('INSERT INTO contextflow."ArticleVersionClaim" ("projectId","articleVersionId","locator","claimRevisionId","evidenceId","quote","linkedText") VALUES($1,$2,\'doc.0.0\',$3,$4,\'Synthetic\',\'Synthetic\')', [project, version, randomUUID(), randomUUID()]);
      await reject('UPDATE contextflow."Article" SET "currentApprovedVersionId"=$1,"revision"=1 WHERE "id"=$2', [version, article]);
      await db.query('UPDATE contextflow."ArticleVersion" SET "approvedBy"=$1,"approvedAt"=CURRENT_TIMESTAMP,"acknowledgedUnmapped"=true WHERE "id"=$2', [user, version]);
      await db.query('UPDATE contextflow."Article" SET "currentApprovedVersionId"=$1,"revision"=1 WHERE "id"=$2', [version, article]);
      await reject('UPDATE contextflow."ArticleVersion" SET "acknowledgedUnmapped"=false WHERE "id"=$1', [version]);
      await reject('UPDATE contextflow."ArticleVersion" SET "approvedAt"="approvedAt"+interval \'1 second\' WHERE "id"=$1', [version]);
      await db.query('UPDATE contextflow."ArticleVersion" SET "withdrawnBy"=$1,"withdrawnAt"=CURRENT_TIMESTAMP WHERE "id"=$2', [user, version]);
      await reject('UPDATE contextflow."ArticleVersion" SET "withdrawnBy"=NULL,"withdrawnAt"=NULL WHERE "id"=$1', [version]);
      await db.query('UPDATE contextflow."Article" SET "currentApprovedVersionId"=NULL,"revision"=2 WHERE "id"=$1', [article]);
      await reject('UPDATE contextflow."Article" SET "revision"=2 WHERE "id"=$1', [article]);
      await reject('DELETE FROM contextflow."ArticleVersion" WHERE "id"=$1', [version], '42501');
    } finally { await db.query('ROLLBACK'); db.release(); }
  });
});
