import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, describe, expect, it } from 'vitest';
import { loadRuntimeConfig } from '@contextflow/backend';

describe('Telegram and article review receipt database guards', () => {
  const config = loadRuntimeConfig();
  const pool = new Pool({ connectionString: config.directDatabaseUrl, ssl: false });

  afterAll(async () => { await pool.end(); });

  it('allows changed valid review parents while rejecting partial shapes and inactive-version receipt forgery', async () => {
    const db = await pool.connect();
    const userId = randomUUID(), workspaceId = randomUUID(), projectId = randomUUID();
    const briefId = randomUUID(), briefOneId = randomUUID(), briefTwoId = randomUUID();
    const adaptationId = randomUUID(), adaptationRevisionId = randomUUID(), inactiveRevisionId = randomUUID();
    const articleId = randomUUID(), articleVersionId = randomUUID();
    const now = new Date();
    const content = JSON.stringify({ text: 'A short update.', mappings: [] });
    const articleContent = JSON.stringify({ title: 'Update', document: { type: 'doc' } });

    async function rejectWithCheck(query: string, values: unknown[]) {
      await db.query('SAVEPOINT expected_check_failure');
      await expect(db.query(query, values)).rejects.toMatchObject({ code: '23514' });
      await db.query('ROLLBACK TO SAVEPOINT expected_check_failure');
      await db.query('RELEASE SAVEPOINT expected_check_failure');
    }

    try {
      await db.query('BEGIN');
      await db.query('INSERT INTO contextflow."UserProfile" ("id") VALUES ($1)', [userId]);
      await db.query('INSERT INTO contextflow."Workspace" ("id","name","ownerId") VALUES ($1,$2,$3)', [workspaceId, 'Receipt fixture', userId]);
      await db.query('INSERT INTO contextflow."WorkspaceMember" ("workspaceId","userId") VALUES ($1,$2)', [workspaceId, userId]);
      await db.query(`INSERT INTO contextflow."WorkspaceStyleRevision" ("workspaceId","revision","createdBy") VALUES ($1,1,$2),($1,2,$2)`, [workspaceId, userId]);
      await db.query('INSERT INTO contextflow."Project" ("id","workspaceId","topic","formats","createdBy") VALUES ($1,$2,$3,$4,$5)',
        [projectId, workspaceId, 'Receipt fixture', ['TELEGRAM_POST'], userId]);
      await db.query('INSERT INTO contextflow."Brief" ("id","projectId","revision") VALUES ($1,$2,2)', [briefId, projectId]);
      for (const [id, number, styleRevision] of [[briefOneId, 1, 1], [briefTwoId, 2, 2]] as const) {
        await db.query(`INSERT INTO contextflow."BriefRevision" (
          "id","projectId","briefId","number","contentMode","topic","audience","centralMessage","category","tone","targetLength","cta","exclusions","notes","workspaceId","workspaceStyleRevision","sha256","createdBy"
        ) VALUES ($1,$2,$3,$4,'CREATIVE','Topic','','','general','','250','','[]','',$5,$6,repeat('a',64),$7)`,
        [id, projectId, briefId, number, workspaceId, styleRevision, userId]);
      }

      await db.query('INSERT INTO contextflow."Adaptation" ("id","projectId","format") VALUES ($1,$2,\'TELEGRAM_POST\')', [adaptationId, projectId]);
      await db.query(`INSERT INTO contextflow."AdaptationRevision" (
        "id","projectId","adaptationId","number","sourceAdaptationRevision","content","sha256","inputMode","contentMode","origin","briefRevisionId","workspaceId","workspaceStyleRevision","createdBy","claimsSealed"
      ) VALUES ($1,$2,$3,1,0,$4,repeat('b',64),'DIRECT','CREATIVE','MANUAL',$5,$6,1,$7,true)`,
      [adaptationRevisionId, projectId, adaptationId, content, briefOneId, workspaceId, userId]);
      await db.query('UPDATE contextflow."AdaptationRevision" SET "approvedBy"=$2,"approvedAt"=$3 WHERE "id"=$1', [adaptationRevisionId, userId, now]);
      await db.query('UPDATE contextflow."Adaptation" SET "revision"=1,"currentApprovedRevisionId"=$2 WHERE "id"=$1', [adaptationId, adaptationRevisionId]);
      await db.query(`UPDATE contextflow."AdaptationRevision" SET "reviewCounter"=1,"reviewedBriefRevisionId"=$2,"reviewedWorkspaceStyleRevision"=2,"reviewedBy"=$3,"reviewedAt"=$4 WHERE "id"=$1`,
        [adaptationRevisionId, briefTwoId, userId, now]);
      const adaptationReceipt = await db.query(`SELECT "briefRevisionId","reviewedBriefRevisionId","workspaceStyleRevision","reviewedWorkspaceStyleRevision" FROM contextflow."AdaptationRevision" WHERE "id"=$1`, [adaptationRevisionId]);
      expect(adaptationReceipt.rows[0]).toMatchObject({ briefRevisionId: briefOneId, reviewedBriefRevisionId: briefTwoId, workspaceStyleRevision: 1, reviewedWorkspaceStyleRevision: 2 });
      await rejectWithCheck(`UPDATE contextflow."AdaptationRevision" SET "reviewCounter"=2,"reviewedWorkspaceStyleRevision"=NULL WHERE "id"=$1`, [adaptationRevisionId]);

      await db.query(`INSERT INTO contextflow."Article" ("id","projectId") VALUES ($1,$2)`, [articleId, projectId]);
      await db.query(`INSERT INTO contextflow."ArticleVersion" (
        "id","projectId","articleId","number","content","plainText","sha256","contentMode","origin","sourceArticleRevision","briefRevisionId","workspaceId","workspaceStyleRevision","createdBy","claimsSealed"
      ) VALUES ($1,$2,$3,1,$4,'A short update.',repeat('c',64),'CREATIVE','MANUAL',0,$5,$6,1,$7,true)`,
      [articleVersionId, projectId, articleId, articleContent, briefOneId, workspaceId, userId]);
      await db.query('UPDATE contextflow."ArticleVersion" SET "approvedBy"=$2,"approvedAt"=$3 WHERE "id"=$1', [articleVersionId, userId, now]);
      await db.query('UPDATE contextflow."Article" SET "revision"=1,"currentApprovedVersionId"=$2 WHERE "id"=$1', [articleId, articleVersionId]);
      await db.query(`UPDATE contextflow."ArticleVersion" SET "reviewCounter"=1,"reviewedBriefRevisionId"=$2,"reviewedWorkspaceStyleRevision"=2,"reviewedBy"=$3,"reviewedAt"=$4 WHERE "id"=$1`,
        [articleVersionId, briefTwoId, userId, now]);
      const articleReceipt = await db.query(`SELECT "briefRevisionId","reviewedBriefRevisionId","workspaceStyleRevision","reviewedWorkspaceStyleRevision" FROM contextflow."ArticleVersion" WHERE "id"=$1`, [articleVersionId]);
      expect(articleReceipt.rows[0]).toMatchObject({ briefRevisionId: briefOneId, reviewedBriefRevisionId: briefTwoId, workspaceStyleRevision: 1, reviewedWorkspaceStyleRevision: 2 });

      await rejectWithCheck(`UPDATE contextflow."ArticleVersion" SET "reviewCounter"=2,"reviewedBriefRevisionId"=NULL WHERE "id"=$1`, [articleVersionId]);
      await rejectWithCheck(`UPDATE contextflow."ArticleVersion" SET "reviewCounter"=2,"reviewedWorkspaceStyleRevision"=NULL WHERE "id"=$1`, [articleVersionId]);
      await rejectWithCheck(`INSERT INTO contextflow."AdaptationDraft" (
        "adaptationId","projectId","content","sha256","inputMode","contentMode","origin","briefRevisionId","sourceArticleVersionId","workspaceId","workspaceStyleRevision","updatedBy"
      ) VALUES ($1,$2,$3,repeat('d',64),'DIRECT','CREATIVE','MANUAL',$4,$5,$6,1,$7)`,
      [adaptationId, projectId, content, briefOneId, articleVersionId, workspaceId, userId]);

      await db.query(`INSERT INTO contextflow."AdaptationRevision" (
        "id","projectId","adaptationId","number","sourceAdaptationRevision","content","sha256","inputMode","contentMode","origin","briefRevisionId","workspaceId","workspaceStyleRevision","createdBy","claimsSealed","approvedBy","approvedAt"
      ) VALUES ($1,$2,$3,2,1,$4,repeat('e',64),'DIRECT','CREATIVE','MANUAL',$5,$6,1,$7,true,$7,$8)`,
      [inactiveRevisionId, projectId, adaptationId, content, briefOneId, workspaceId, userId, now]);
      await rejectWithCheck(`UPDATE contextflow."AdaptationRevision" SET "reviewCounter"=1,"reviewedBriefRevisionId"=$2,"reviewedWorkspaceStyleRevision"=2,"reviewedBy"=$3,"reviewedAt"=$4 WHERE "id"=$1`,
        [inactiveRevisionId, briefTwoId, userId, now]);
      await db.query('ROLLBACK');
    } catch (error) {
      await db.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      db.release();
    }
  });
});
