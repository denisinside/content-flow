BEGIN;
SET LOCAL search_path TO contextflow;
-- CreateEnum
CREATE TYPE "ArticleOrigin" AS ENUM ('MANUAL', 'AI', 'UNVERIFIED_IMPORTED');

-- AlterEnum
ALTER TYPE "JobOperation" ADD VALUE 'ARTICLE_GENERATION';

-- CreateTable
CREATE TABLE "Article" (
    "id" UUID NOT NULL,
    "projectId" UUID NOT NULL,
    "revision" INTEGER NOT NULL DEFAULT 0,
    "currentApprovedVersionId" UUID,

    CONSTRAINT "Article_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ArticleDraft" (
    "articleId" UUID NOT NULL,
    "projectId" UUID NOT NULL,
    "content" JSONB NOT NULL,
    "plainText" TEXT NOT NULL,
    "sha256" CHAR(64) NOT NULL,
    "schemaVersion" VARCHAR(64) NOT NULL DEFAULT 'article-document-v1',
    "contentMode" "ContentMode" NOT NULL,
    "origin" "ArticleOrigin" NOT NULL,
    "baseVersionId" UUID,
    "briefRevisionId" UUID,
    "basisRevisionId" UUID,
    "outlineRevisionId" UUID,
    "workspaceId" UUID NOT NULL,
    "workspaceStyleRevision" INTEGER NOT NULL,
    "sourceSnapshotId" UUID,
    "updatedBy" UUID NOT NULL,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ArticleDraft_pkey" PRIMARY KEY ("articleId")
);

-- CreateTable
CREATE TABLE "ArticleVersion" (
    "id" UUID NOT NULL,
    "projectId" UUID NOT NULL,
    "articleId" UUID NOT NULL,
    "number" INTEGER NOT NULL,
    "content" JSONB NOT NULL,
    "plainText" TEXT NOT NULL,
    "sha256" CHAR(64) NOT NULL,
    "schemaVersion" VARCHAR(64) NOT NULL DEFAULT 'article-document-v1',
    "contentMode" "ContentMode" NOT NULL,
    "origin" "ArticleOrigin" NOT NULL,
    "sourceArticleRevision" INTEGER NOT NULL,
    "briefRevisionId" UUID,
    "basisRevisionId" UUID,
    "outlineRevisionId" UUID,
    "workspaceId" UUID NOT NULL,
    "workspaceStyleRevision" INTEGER NOT NULL,
    "sourceSnapshotId" UUID,
    "createdBy" UUID NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "jobId" UUID,
    "aiExecutionId" UUID,
    "approvedBy" UUID,
    "approvedAt" TIMESTAMPTZ(3),
    "claimsSealed" BOOLEAN NOT NULL DEFAULT false,
    "acknowledgedUnmapped" BOOLEAN NOT NULL DEFAULT false,
    "withdrawnBy" UUID,
    "withdrawnAt" TIMESTAMPTZ(3),
    "withdrawalReason" VARCHAR(2000),

    CONSTRAINT "ArticleVersion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ArticleVersionClaim" (
    "projectId" UUID NOT NULL,
    "articleVersionId" UUID NOT NULL,
    "locator" VARCHAR(200) NOT NULL,
    "claimRevisionId" UUID NOT NULL,
    "evidenceId" UUID NOT NULL,
    "quote" VARCHAR(10000) NOT NULL,
    "linkedText" VARCHAR(10000) NOT NULL,

    CONSTRAINT "ArticleVersionClaim_pkey" PRIMARY KEY ("articleVersionId","locator")
);

-- CreateIndex
CREATE UNIQUE INDEX "Article_projectId_key" ON "Article"("projectId");

-- CreateIndex
CREATE UNIQUE INDEX "Article_projectId_id_key" ON "Article"("projectId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "ArticleDraft_projectId_articleId_key" ON "ArticleDraft"("projectId", "articleId");

-- CreateIndex
CREATE UNIQUE INDEX "ArticleVersion_jobId_key" ON "ArticleVersion"("jobId");

-- CreateIndex
CREATE UNIQUE INDEX "ArticleVersion_projectId_id_key" ON "ArticleVersion"("projectId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "ArticleVersion_projectId_articleId_id_key" ON "ArticleVersion"("projectId", "articleId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "ArticleVersion_articleId_number_key" ON "ArticleVersion"("articleId", "number");

-- AddForeignKey
ALTER TABLE "Article" ADD CONSTRAINT "Article_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "Article" ADD CONSTRAINT "Article_projectId_id_currentApprovedVersionId_fkey" FOREIGN KEY ("projectId", "id", "currentApprovedVersionId") REFERENCES "ArticleVersion"("projectId", "articleId", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "ArticleDraft" ADD CONSTRAINT "ArticleDraft_projectId_articleId_fkey" FOREIGN KEY ("projectId", "articleId") REFERENCES "Article"("projectId", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "ArticleDraft" ADD CONSTRAINT "ArticleDraft_projectId_articleId_baseVersionId_fkey" FOREIGN KEY ("projectId", "articleId", "baseVersionId") REFERENCES "ArticleVersion"("projectId", "articleId", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "ArticleDraft" ADD CONSTRAINT "ArticleDraft_projectId_briefRevisionId_fkey" FOREIGN KEY ("projectId", "briefRevisionId") REFERENCES "BriefRevision"("projectId", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "ArticleDraft" ADD CONSTRAINT "ArticleDraft_projectId_basisRevisionId_fkey" FOREIGN KEY ("projectId", "basisRevisionId") REFERENCES "FactualBasisRevision"("projectId", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "ArticleDraft" ADD CONSTRAINT "ArticleDraft_projectId_outlineRevisionId_fkey" FOREIGN KEY ("projectId", "outlineRevisionId") REFERENCES "OutlineRevision"("projectId", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "ArticleDraft" ADD CONSTRAINT "ArticleDraft_projectId_workspaceId_fkey" FOREIGN KEY ("projectId", "workspaceId") REFERENCES "Project"("id", "workspaceId") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "ArticleDraft" ADD CONSTRAINT "ArticleDraft_workspaceId_workspaceStyleRevision_fkey" FOREIGN KEY ("workspaceId", "workspaceStyleRevision") REFERENCES "WorkspaceStyleRevision"("workspaceId", "revision") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "ArticleDraft" ADD CONSTRAINT "ArticleDraft_projectId_sourceSnapshotId_fkey" FOREIGN KEY ("projectId", "sourceSnapshotId") REFERENCES "SourceSnapshot"("projectId", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "ArticleDraft" ADD CONSTRAINT "ArticleDraft_updatedBy_fkey" FOREIGN KEY ("updatedBy") REFERENCES "UserProfile"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "ArticleVersion" ADD CONSTRAINT "ArticleVersion_projectId_articleId_fkey" FOREIGN KEY ("projectId", "articleId") REFERENCES "Article"("projectId", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "ArticleVersion" ADD CONSTRAINT "ArticleVersion_projectId_briefRevisionId_fkey" FOREIGN KEY ("projectId", "briefRevisionId") REFERENCES "BriefRevision"("projectId", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "ArticleVersion" ADD CONSTRAINT "ArticleVersion_projectId_basisRevisionId_fkey" FOREIGN KEY ("projectId", "basisRevisionId") REFERENCES "FactualBasisRevision"("projectId", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "ArticleVersion" ADD CONSTRAINT "ArticleVersion_projectId_outlineRevisionId_fkey" FOREIGN KEY ("projectId", "outlineRevisionId") REFERENCES "OutlineRevision"("projectId", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "ArticleVersion" ADD CONSTRAINT "ArticleVersion_projectId_workspaceId_fkey" FOREIGN KEY ("projectId", "workspaceId") REFERENCES "Project"("id", "workspaceId") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "ArticleVersion" ADD CONSTRAINT "ArticleVersion_workspaceId_workspaceStyleRevision_fkey" FOREIGN KEY ("workspaceId", "workspaceStyleRevision") REFERENCES "WorkspaceStyleRevision"("workspaceId", "revision") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "ArticleVersion" ADD CONSTRAINT "ArticleVersion_projectId_sourceSnapshotId_fkey" FOREIGN KEY ("projectId", "sourceSnapshotId") REFERENCES "SourceSnapshot"("projectId", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "ArticleVersion" ADD CONSTRAINT "ArticleVersion_createdBy_fkey" FOREIGN KEY ("createdBy") REFERENCES "UserProfile"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "ArticleVersion" ADD CONSTRAINT "ArticleVersion_projectId_jobId_fkey" FOREIGN KEY ("projectId", "jobId") REFERENCES "Job"("projectId", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "ArticleVersion" ADD CONSTRAINT "ArticleVersion_projectId_aiExecutionId_fkey" FOREIGN KEY ("projectId", "aiExecutionId") REFERENCES "AIExecution"("projectId", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "ArticleVersion" ADD CONSTRAINT "ArticleVersion_approvedBy_fkey" FOREIGN KEY ("approvedBy") REFERENCES "UserProfile"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "ArticleVersion" ADD CONSTRAINT "ArticleVersion_withdrawnBy_fkey" FOREIGN KEY ("withdrawnBy") REFERENCES "UserProfile"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "ArticleVersionClaim" ADD CONSTRAINT "ArticleVersionClaim_projectId_articleVersionId_fkey" FOREIGN KEY ("projectId", "articleVersionId") REFERENCES "ArticleVersion"("projectId", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "ArticleVersionClaim" ADD CONSTRAINT "ArticleVersionClaim_projectId_claimRevisionId_fkey" FOREIGN KEY ("projectId", "claimRevisionId") REFERENCES "ClaimRevision"("projectId", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "ArticleVersionClaim" ADD CONSTRAINT "ArticleVersionClaim_projectId_claimRevisionId_evidenceId_fkey" FOREIGN KEY ("projectId", "claimRevisionId", "evidenceId") REFERENCES "ClaimEvidence"("projectId", "claimRevisionId", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

ALTER TABLE "Article" ADD CONSTRAINT "Article_revision_check" CHECK ("revision" >= 0);
ALTER TABLE "ArticleDraft" ADD CONSTRAINT "ArticleDraft_shape_check" CHECK (
 "schemaVersion"='article-document-v1' AND "sha256" ~ '^[a-f0-9]{64}$' AND octet_length("content"::text)<=550000 AND jsonb_typeof("content")='object' AND "content" ? 'title' AND "content" ? 'document' AND jsonb_typeof("content"->'document')='object'
 AND jsonb_typeof("content"->'title')='string' AND length("content"->>'title') BETWEEN 1 AND 500 AND "content"->'document'->>'type'='doc'
 AND "workspaceStyleRevision">0 AND ("contentMode"<>'CREATIVE' OR "basisRevisionId" IS NULL)
 AND ("sourceSnapshotId" IS NULL OR "origin"='UNVERIFIED_IMPORTED'));
ALTER TABLE "ArticleVersion" ADD CONSTRAINT "ArticleVersion_shape_check" CHECK (
 "number">0 AND "sourceArticleRevision">=0 AND "schemaVersion"='article-document-v1' AND "sha256" ~ '^[a-f0-9]{64}$'
 AND octet_length("content"::text)<=550000 AND jsonb_typeof("content")='object' AND "content" ? 'title' AND "content" ? 'document' AND jsonb_typeof("content"->'document')='object' AND jsonb_typeof("content"->'title')='string'
 AND length("content"->>'title') BETWEEN 1 AND 500 AND "content"->'document'->>'type'='doc' AND "workspaceStyleRevision">0
 AND ("contentMode"<>'CREATIVE' OR "basisRevisionId" IS NULL)
 AND (("origin"='AI') = ("jobId" IS NOT NULL AND "aiExecutionId" IS NOT NULL))
 AND ("origin"='AI' OR ("jobId" IS NULL AND "aiExecutionId" IS NULL))
 AND ("sourceSnapshotId" IS NULL OR "origin"='UNVERIFIED_IMPORTED')
 AND (("approvedBy" IS NULL)=("approvedAt" IS NULL)) AND (("withdrawnBy" IS NULL)=("withdrawnAt" IS NULL))
 AND ("approvedAt" IS NULL OR "claimsSealed") AND ("withdrawnAt" IS NULL OR "approvedAt" IS NOT NULL)
 AND ("approvedAt" IS NOT NULL OR NOT "acknowledgedUnmapped") AND ("withdrawnAt" IS NOT NULL OR "withdrawalReason" IS NULL));
ALTER TABLE "ArticleVersionClaim" ADD CONSTRAINT "ArticleVersionClaim_shape_check" CHECK (length("locator") BETWEEN 1 AND 200 AND length("quote") BETWEEN 1 AND 10000 AND length("linkedText") BETWEEN 1 AND 10000);
CREATE FUNCTION guard_article_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF ROW(NEW."id",NEW."projectId") IS DISTINCT FROM ROW(OLD."id",OLD."projectId") OR NEW."revision"<>OLD."revision"+1 THEN
  RAISE EXCEPTION 'article identity is immutable and commands advance one revision' USING ERRCODE='23514';
 END IF;
 IF NEW."currentApprovedVersionId" IS NOT NULL AND NOT EXISTS(SELECT 1 FROM contextflow."ArticleVersion" v WHERE v."id"=NEW."currentApprovedVersionId" AND v."projectId"=NEW."projectId" AND v."articleId"=NEW."id" AND v."approvedAt" IS NOT NULL AND v."withdrawnAt" IS NULL AND v."claimsSealed") THEN
  RAISE EXCEPTION 'article approved pointer requires exact active approved version' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER "Article_identity_guard" BEFORE UPDATE ON "Article" FOR EACH ROW EXECUTE FUNCTION guard_article_identity();
CREATE FUNCTION guard_article_version() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF (to_jsonb(NEW)-ARRAY['approvedBy','approvedAt','acknowledgedUnmapped','withdrawnBy','withdrawnAt','withdrawalReason','claimsSealed']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['approvedBy','approvedAt','acknowledgedUnmapped','withdrawnBy','withdrawnAt','withdrawalReason','claimsSealed']) THEN
  RAISE EXCEPTION 'article version content and inputs are immutable' USING ERRCODE='23514';
 END IF;
 IF OLD."claimsSealed" AND NOT NEW."claimsSealed" OR OLD."approvedAt" IS NOT NULL AND ROW(NEW."approvedBy",NEW."approvedAt",NEW."acknowledgedUnmapped") IS DISTINCT FROM ROW(OLD."approvedBy",OLD."approvedAt",OLD."acknowledgedUnmapped") OR OLD."withdrawnAt" IS NOT NULL AND NEW IS DISTINCT FROM OLD THEN
  RAISE EXCEPTION 'article sealed mappings, first approval and terminal withdrawal are immutable' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER "ArticleVersion_review_guard" BEFORE UPDATE ON "ArticleVersion" FOR EACH ROW EXECUTE FUNCTION guard_article_version();
CREATE FUNCTION guard_article_inputs() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_TABLE_NAME='ArticleVersion' THEN
  IF NEW."aiExecutionId" IS NOT NULL AND NOT EXISTS(SELECT 1 FROM contextflow."AIExecution" e WHERE e."id"=NEW."aiExecutionId" AND e."projectId"=NEW."projectId" AND e."jobId"=NEW."jobId") THEN
   RAISE EXCEPTION 'article execution must belong to frozen job' USING ERRCODE='23514';
  END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER "ArticleDraft_inputs_guard" BEFORE INSERT OR UPDATE ON "ArticleDraft" FOR EACH ROW EXECUTE FUNCTION guard_article_inputs();
CREATE TRIGGER "ArticleVersion_inputs_guard" BEFORE INSERT ON "ArticleVersion" FOR EACH ROW EXECUTE FUNCTION guard_article_inputs();
CREATE FUNCTION guard_article_mapping_insert() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE sealed BOOLEAN;
BEGIN
 SELECT "claimsSealed" INTO sealed FROM contextflow."ArticleVersion" WHERE "id"=NEW."articleVersionId" AND "projectId"=NEW."projectId" FOR UPDATE;
 IF sealed THEN RAISE EXCEPTION 'article version mappings are sealed' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER "ArticleVersionClaim_insert_guard" BEFORE INSERT ON "ArticleVersionClaim" FOR EACH ROW EXECUTE FUNCTION guard_article_mapping_insert();
CREATE TRIGGER "ArticleVersionClaim_immutable" BEFORE UPDATE ON "ArticleVersionClaim" FOR EACH ROW EXECUTE FUNCTION contextflow.guard_immutable_snapshot();
CREATE TRIGGER "Article_no_delete" BEFORE DELETE ON "Article" FOR EACH ROW EXECUTE FUNCTION guard_editorial_delete();
CREATE TRIGGER "ArticleDraft_no_delete" BEFORE DELETE ON "ArticleDraft" FOR EACH ROW EXECUTE FUNCTION guard_editorial_delete();
CREATE TRIGGER "ArticleVersion_no_delete" BEFORE DELETE ON "ArticleVersion" FOR EACH ROW EXECUTE FUNCTION guard_editorial_delete();
CREATE TRIGGER "ArticleVersionClaim_no_delete" BEFORE DELETE ON "ArticleVersionClaim" FOR EACH ROW EXECUTE FUNCTION guard_editorial_delete();
REVOKE ALL ON "Article","ArticleDraft","ArticleVersion","ArticleVersionClaim" FROM PUBLIC;
REVOKE ALL ON TYPE "ArticleOrigin" FROM PUBLIC;
DO $$ DECLARE role_name TEXT; BEGIN
 FOREACH role_name IN ARRAY ARRAY['anon','authenticated'] LOOP
  IF to_regrole(role_name) IS NOT NULL THEN
   EXECUTE format('REVOKE ALL ON contextflow."Article",contextflow."ArticleDraft",contextflow."ArticleVersion",contextflow."ArticleVersionClaim" FROM %I',role_name);
   EXECUTE format('REVOKE ALL ON TYPE contextflow."ArticleOrigin" FROM %I',role_name);
  END IF;
 END LOOP;
END $$;
GRANT USAGE ON TYPE "ArticleOrigin" TO cf_runtime;
GRANT SELECT,INSERT,UPDATE ON "Article","ArticleDraft","ArticleVersion" TO cf_runtime;
GRANT SELECT,INSERT ON "ArticleVersionClaim" TO cf_runtime;
COMMIT;


