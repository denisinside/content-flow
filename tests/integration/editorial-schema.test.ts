import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, describe, expect, it } from 'vitest';
import { databasePoolOptions, loadRuntimeConfig } from '@contextflow/backend';

const pool = new Pool(databasePoolOptions(loadRuntimeConfig()));
afterAll(async () => { await pool.end(); });

describe('editorial database provenance constraints through the runtime role', () => {
  it('retains immutable inputs, project ancestry and terminal review attribution', async () => {
    // Every fixture and review is rolled back, including append-only records.
    const db = await pool.connect();
    const user = randomUUID(), workspace = randomUUID(), foreignWorkspace = randomUUID();
    const project = randomUUID(), foreignProject = randomUUID();
    const brief = randomUUID(), foreignBrief = randomUUID(), revision = randomUUID(), foreignRevision = randomUUID();
    const outline = randomUUID(), foreignOutline = randomUUID(), candidate = randomUUID(), foreignCandidate = randomUUID();
    const hash = 'a'.repeat(64);
    async function rejected(sql: string, values: unknown[] = [], code = '23514') {
      await db.query('SAVEPOINT rejected_editorial_write');
      try { await expect(db.query(sql, values)).rejects.toMatchObject({ code }); }
      finally { await db.query('ROLLBACK TO SAVEPOINT rejected_editorial_write'); await db.query('RELEASE SAVEPOINT rejected_editorial_write'); }
    }
    try {
      await db.query('BEGIN');
      await db.query('INSERT INTO contextflow."UserProfile" ("id") VALUES ($1)', [user]);
      for (const id of [workspace, foreignWorkspace]) {
        await db.query('INSERT INTO contextflow."Workspace" ("id","name","ownerId") VALUES ($1,$2,$3)', [id, 'Synthetic editorial constraints', user]);
        await db.query('INSERT INTO contextflow."WorkspaceStyleRevision" ("workspaceId","revision","createdBy") VALUES ($1,1,$2)', [id, user]);
      }
      for (const [id, workspaceId] of [[project, workspace], [foreignProject, foreignWorkspace]]) {
        await db.query('INSERT INTO contextflow."Project" ("id","workspaceId","topic","formats","createdBy") VALUES ($1,$2,$3,$4,$5)',
          [id, workspaceId, 'Synthetic editorial project', ['ARTICLE'], user]);
      }
      const insertBriefRevision = 'INSERT INTO contextflow."BriefRevision" ("id","projectId","briefId","number","contentMode","topic","audience","centralMessage","category","tone","targetLength","cta","exclusions","notes","workspaceId","workspaceStyleRevision","sha256","createdBy") VALUES ($1,$2,$3,1,\'CREATIVE\',\'Topic\',\'Audience\',\'Message\',\'Category\',\'Tone\',500,\'CTA\',\'[]\',\'Notes\',$4,1,$5,$6)';
      for (const [briefId, projectId, revisionId, workspaceId] of [[brief, project, revision, workspace], [foreignBrief, foreignProject, foreignRevision, foreignWorkspace]]) {
        await db.query('INSERT INTO contextflow."Brief" ("id","projectId") VALUES ($1,$2)', [briefId, projectId]);
        await db.query(insertBriefRevision, [revisionId, projectId, briefId, workspaceId, hash, user]);
        await db.query('UPDATE contextflow."Brief" SET "currentRevisionId"=$1 WHERE "id"=$2', [revisionId, briefId]);
      }
      await rejected('UPDATE contextflow."BriefRevision" SET "topic"=\'Changed\' WHERE "id"=$1', [revision], '42501');
      await rejected('INSERT INTO contextflow."BriefRequiredClaim" ("projectId","briefRevisionId","claimRevisionId") VALUES ($1,$2,$3)', [project, revision, randomUUID()]);
      await rejected('UPDATE contextflow."Brief" SET "currentRevisionId"=$1,"revision"=2 WHERE "id"=$2', [foreignRevision, brief], '23503');
      // A fresh brief container avoids the revision-number uniqueness check when testing style ancestry.
      const styleProject = randomUUID(), styleBrief = randomUUID();
      await db.query('INSERT INTO contextflow."Project" ("id","workspaceId","topic","formats","createdBy") VALUES ($1,$2,\'Style ancestry\',$3,$4)', [styleProject, workspace, ['ARTICLE'], user]);
      await db.query('INSERT INTO contextflow."Brief" ("id","projectId") VALUES ($1,$2)', [styleBrief, styleProject]);
      await rejected(insertBriefRevision, [randomUUID(), styleProject, styleBrief, foreignWorkspace, hash, user], '23503');

      const content = JSON.stringify({ title: 'Title', sections: [{ title: 'Section', purpose: 'Purpose', claimRevisionIds: [] }] });
      for (const [outlineId, projectId, candidateId, briefRevisionId] of [[outline, project, candidate, revision], [foreignOutline, foreignProject, foreignCandidate, foreignRevision]]) {
        await db.query('INSERT INTO contextflow."Outline" ("id","projectId") VALUES ($1,$2)', [outlineId, projectId]);
        await db.query('INSERT INTO contextflow."OutlineRevision" ("id","projectId","outlineId","number","briefRevisionId","contentMode","content","sha256","origin","createdBy") VALUES ($1,$2,$3,1,$4,\'CREATIVE\',$5,$6,\'MANUAL\',$7)',
          [candidateId, projectId, outlineId, briefRevisionId, content, hash, user]);
      }
      expect((await db.query('SELECT "currentRevisionId" FROM contextflow."Outline" WHERE "id"=$1', [outline])).rows[0]).toEqual({ currentRevisionId: null });
      await rejected('UPDATE contextflow."Outline" SET "currentRevisionId"=$1 WHERE "id"=$2', [foreignCandidate, outline], '23503');
      await rejected('UPDATE contextflow."Outline" SET "currentApprovedRevisionId"=$1 WHERE "id"=$2', [foreignCandidate, outline], '23503');
      await rejected('UPDATE contextflow."OutlineRevision" SET "content"=$1 WHERE "id"=$2', [JSON.stringify({ title: 'Overwrite', sections: [] }), candidate]);
      await rejected('UPDATE contextflow."OutlineRevision" SET "withdrawnBy"=$1,"withdrawnAt"=CURRENT_TIMESTAMP,"withdrawalReason"=\'Premature\' WHERE "id"=$2', [user, candidate]);
      await db.query('UPDATE contextflow."OutlineRevision" SET "approvedBy"=$1,"approvedAt"=CURRENT_TIMESTAMP WHERE "id"=$2', [user, candidate]);
      await rejected('UPDATE contextflow."OutlineRevision" SET "approvedAt"="approvedAt"+interval \'1 second\' WHERE "id"=$1', [candidate]);
      await db.query('UPDATE contextflow."OutlineRevision" SET "withdrawnBy"=$1,"withdrawnAt"=CURRENT_TIMESTAMP,"withdrawalReason"=\'Synthetic withdrawal\' WHERE "id"=$2', [user, candidate]);
      await rejected('UPDATE contextflow."OutlineRevision" SET "withdrawnBy"=NULL,"withdrawnAt"=NULL,"withdrawalReason"=NULL WHERE "id"=$1', [candidate]);
      await db.query('UPDATE contextflow."OutlineRevision" SET "approvedBy"=$1,"approvedAt"=CURRENT_TIMESTAMP WHERE "id"=$2', [user, foreignCandidate]);
      await db.query('UPDATE contextflow."OutlineRevision" SET "withdrawnBy"=$1,"withdrawnAt"=CURRENT_TIMESTAMP WHERE "id"=$2', [user, foreignCandidate]);
      expect((await db.query('SELECT "withdrawalReason" FROM contextflow."OutlineRevision" WHERE "id"=$1', [foreignCandidate])).rows[0]).toEqual({ withdrawalReason: null });
      await rejected('DELETE FROM contextflow."OutlineRevision" WHERE "id"=$1', [candidate], '42501');
      await rejected('DELETE FROM contextflow."BriefRevision" WHERE "id"=$1', [revision], '42501');
    } finally { await db.query('ROLLBACK'); db.release(); }
  });
});
