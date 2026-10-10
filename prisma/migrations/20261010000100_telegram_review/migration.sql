BEGIN;
SET LOCAL search_path TO contextflow;
-- CreateEnum
CREATE TYPE "AdaptationInputMode" AS ENUM ('DIRECT', 'ARTICLE_DERIVED');

-- AlterEnum
ALTER TYPE "JobOperation" ADD VALUE 'TELEGRAM_GENERATION';

-- AlterTable
ALTER TABLE "ArticleVersion" ADD COLUMN     "reviewCounter" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "reviewedAt" TIMESTAMPTZ(3),
ADD COLUMN     "reviewedBasisRevisionId" UUID,
ADD COLUMN     "reviewedBriefRevisionId" UUID,
ADD COLUMN     "reviewedBy" UUID,
ADD COLUMN     "reviewedOutlineRevisionId" UUID,
ADD COLUMN     "reviewedWorkspaceStyleRevision" INTEGER;

-- CreateTable
CREATE TABLE "Adaptation" (
    "id" UUID NOT NULL,
    "projectId" UUID NOT NULL,
    "format" "ProjectFormat" NOT NULL,
    "revision" INTEGER NOT NULL DEFAULT 0,
    "currentApprovedRevisionId" UUID,

    CONSTRAINT "Adaptation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AdaptationDraft" (
    "adaptationId" UUID NOT NULL,
    "projectId" UUID NOT NULL,
    "content" JSONB NOT NULL,
    "sha256" CHAR(64) NOT NULL,
    "baseRevisionId" UUID,
    "inputMode" "AdaptationInputMode" NOT NULL,
    "contentMode" "ContentMode" NOT NULL,
    "origin" "EditorialOrigin" NOT NULL,
    "briefRevisionId" UUID NOT NULL,
    "basisRevisionId" UUID,
    "sourceArticleVersionId" UUID,
    "workspaceId" UUID NOT NULL,
    "workspaceStyleRevision" INTEGER NOT NULL,
    "includeLink" BOOLEAN NOT NULL DEFAULT false,
    "updatedBy" UUID NOT NULL,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AdaptationDraft_pkey" PRIMARY KEY ("adaptationId")
);

-- CreateTable
CREATE TABLE "AdaptationRevision" (
    "id" UUID NOT NULL,
    "projectId" UUID NOT NULL,
    "adaptationId" UUID NOT NULL,
    "number" INTEGER NOT NULL,
    "sourceAdaptationRevision" INTEGER NOT NULL,
    "content" JSONB NOT NULL,
    "sha256" CHAR(64) NOT NULL,
    "inputMode" "AdaptationInputMode" NOT NULL,
    "contentMode" "ContentMode" NOT NULL,
    "origin" "EditorialOrigin" NOT NULL,
    "briefRevisionId" UUID NOT NULL,
    "basisRevisionId" UUID,
    "sourceArticleVersionId" UUID,
    "reviewedSourceArticleVersionId" UUID,
    "workspaceId" UUID NOT NULL,
    "workspaceStyleRevision" INTEGER NOT NULL,
    "includeLink" BOOLEAN NOT NULL DEFAULT false,
    "createdBy" UUID NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "jobId" UUID,
    "aiExecutionId" UUID,
    "claimsSealed" BOOLEAN NOT NULL DEFAULT false,
    "approvedBy" UUID,
    "approvedAt" TIMESTAMPTZ(3),
    "acknowledgedUnmapped" BOOLEAN NOT NULL DEFAULT false,
    "withdrawnBy" UUID,
    "withdrawnAt" TIMESTAMPTZ(3),
    "withdrawalReason" VARCHAR(2000),
    "reviewCounter" INTEGER NOT NULL DEFAULT 0,
    "reviewedBriefRevisionId" UUID,
    "reviewedBasisRevisionId" UUID,
    "reviewedWorkspaceStyleRevision" INTEGER,
    "reviewedBy" UUID,
    "reviewedAt" TIMESTAMPTZ(3),

    CONSTRAINT "AdaptationRevision_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AdaptationRevisionClaim" (
    "projectId" UUID NOT NULL,
    "revisionId" UUID NOT NULL,
    "locator" VARCHAR(200) NOT NULL,
    "claimRevisionId" UUID NOT NULL,
    "evidenceId" UUID NOT NULL,
    "quote" VARCHAR(10000) NOT NULL,
    "linkedText" TEXT NOT NULL,

    CONSTRAINT "AdaptationRevisionClaim_pkey" PRIMARY KEY ("revisionId","locator")
);

-- CreateIndex
CREATE UNIQUE INDEX "Adaptation_projectId_format_key" ON "Adaptation"("projectId", "format");

-- CreateIndex
CREATE UNIQUE INDEX "Adaptation_projectId_id_key" ON "Adaptation"("projectId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "AdaptationDraft_projectId_adaptationId_key" ON "AdaptationDraft"("projectId", "adaptationId");

-- CreateIndex
CREATE UNIQUE INDEX "AdaptationRevision_jobId_key" ON "AdaptationRevision"("jobId");

-- CreateIndex
CREATE UNIQUE INDEX "AdaptationRevision_projectId_id_key" ON "AdaptationRevision"("projectId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "AdaptationRevision_projectId_adaptationId_id_key" ON "AdaptationRevision"("projectId", "adaptationId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "AdaptationRevision_adaptationId_number_key" ON "AdaptationRevision"("adaptationId", "number");

-- AddForeignKey
ALTER TABLE "ArticleVersion" ADD CONSTRAINT "ArticleVersion_projectId_reviewedBriefRevisionId_fkey" FOREIGN KEY ("projectId", "reviewedBriefRevisionId") REFERENCES "BriefRevision"("projectId", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "ArticleVersion" ADD CONSTRAINT "ArticleVersion_projectId_reviewedBasisRevisionId_fkey" FOREIGN KEY ("projectId", "reviewedBasisRevisionId") REFERENCES "FactualBasisRevision"("projectId", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "ArticleVersion" ADD CONSTRAINT "ArticleVersion_projectId_reviewedOutlineRevisionId_fkey" FOREIGN KEY ("projectId", "reviewedOutlineRevisionId") REFERENCES "OutlineRevision"("projectId", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "ArticleVersion" ADD CONSTRAINT "ArticleVersion_workspaceId_reviewedWorkspaceStyleRevision_fkey" FOREIGN KEY ("workspaceId", "reviewedWorkspaceStyleRevision") REFERENCES "WorkspaceStyleRevision"("workspaceId", "revision") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "ArticleVersion" ADD CONSTRAINT "ArticleVersion_reviewedBy_fkey" FOREIGN KEY ("reviewedBy") REFERENCES "UserProfile"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "Adaptation" ADD CONSTRAINT "Adaptation_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "Adaptation" ADD CONSTRAINT "Adaptation_projectId_id_currentApprovedRevisionId_fkey" FOREIGN KEY ("projectId", "id", "currentApprovedRevisionId") REFERENCES "AdaptationRevision"("projectId", "adaptationId", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "AdaptationDraft" ADD CONSTRAINT "AdaptationDraft_projectId_adaptationId_fkey" FOREIGN KEY ("projectId", "adaptationId") REFERENCES "Adaptation"("projectId", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "AdaptationDraft" ADD CONSTRAINT "AdaptationDraft_projectId_adaptationId_baseRevisionId_fkey" FOREIGN KEY ("projectId", "adaptationId", "baseRevisionId") REFERENCES "AdaptationRevision"("projectId", "adaptationId", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "AdaptationDraft" ADD CONSTRAINT "AdaptationDraft_projectId_briefRevisionId_fkey" FOREIGN KEY ("projectId", "briefRevisionId") REFERENCES "BriefRevision"("projectId", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "AdaptationDraft" ADD CONSTRAINT "AdaptationDraft_projectId_basisRevisionId_fkey" FOREIGN KEY ("projectId", "basisRevisionId") REFERENCES "FactualBasisRevision"("projectId", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "AdaptationDraft" ADD CONSTRAINT "AdaptationDraft_projectId_sourceArticleVersionId_fkey" FOREIGN KEY ("projectId", "sourceArticleVersionId") REFERENCES "ArticleVersion"("projectId", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "AdaptationDraft" ADD CONSTRAINT "AdaptationDraft_projectId_workspaceId_fkey" FOREIGN KEY ("projectId", "workspaceId") REFERENCES "Project"("id", "workspaceId") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "AdaptationDraft" ADD CONSTRAINT "AdaptationDraft_workspaceId_workspaceStyleRevision_fkey" FOREIGN KEY ("workspaceId", "workspaceStyleRevision") REFERENCES "WorkspaceStyleRevision"("workspaceId", "revision") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "AdaptationDraft" ADD CONSTRAINT "AdaptationDraft_updatedBy_fkey" FOREIGN KEY ("updatedBy") REFERENCES "UserProfile"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "AdaptationRevision" ADD CONSTRAINT "AdaptationRevision_projectId_adaptationId_fkey" FOREIGN KEY ("projectId", "adaptationId") REFERENCES "Adaptation"("projectId", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "AdaptationRevision" ADD CONSTRAINT "AdaptationRevision_projectId_briefRevisionId_fkey" FOREIGN KEY ("projectId", "briefRevisionId") REFERENCES "BriefRevision"("projectId", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "AdaptationRevision" ADD CONSTRAINT "AdaptationRevision_projectId_basisRevisionId_fkey" FOREIGN KEY ("projectId", "basisRevisionId") REFERENCES "FactualBasisRevision"("projectId", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "AdaptationRevision" ADD CONSTRAINT "AdaptationRevision_projectId_sourceArticleVersionId_fkey" FOREIGN KEY ("projectId", "sourceArticleVersionId") REFERENCES "ArticleVersion"("projectId", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "AdaptationRevision" ADD CONSTRAINT "AdaptationRevision_projectId_reviewedSourceArticleVersionI_fkey" FOREIGN KEY ("projectId", "reviewedSourceArticleVersionId") REFERENCES "ArticleVersion"("projectId", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "AdaptationRevision" ADD CONSTRAINT "AdaptationRevision_projectId_workspaceId_fkey" FOREIGN KEY ("projectId", "workspaceId") REFERENCES "Project"("id", "workspaceId") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "AdaptationRevision" ADD CONSTRAINT "AdaptationRevision_workspaceId_workspaceStyleRevision_fkey" FOREIGN KEY ("workspaceId", "workspaceStyleRevision") REFERENCES "WorkspaceStyleRevision"("workspaceId", "revision") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "AdaptationRevision" ADD CONSTRAINT "AdaptationRevision_createdBy_fkey" FOREIGN KEY ("createdBy") REFERENCES "UserProfile"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "AdaptationRevision" ADD CONSTRAINT "AdaptationRevision_projectId_jobId_fkey" FOREIGN KEY ("projectId", "jobId") REFERENCES "Job"("projectId", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "AdaptationRevision" ADD CONSTRAINT "AdaptationRevision_projectId_aiExecutionId_fkey" FOREIGN KEY ("projectId", "aiExecutionId") REFERENCES "AIExecution"("projectId", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "AdaptationRevision" ADD CONSTRAINT "AdaptationRevision_approvedBy_fkey" FOREIGN KEY ("approvedBy") REFERENCES "UserProfile"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "AdaptationRevision" ADD CONSTRAINT "AdaptationRevision_withdrawnBy_fkey" FOREIGN KEY ("withdrawnBy") REFERENCES "UserProfile"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "AdaptationRevision" ADD CONSTRAINT "AdaptationRevision_projectId_reviewedBriefRevisionId_fkey" FOREIGN KEY ("projectId", "reviewedBriefRevisionId") REFERENCES "BriefRevision"("projectId", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "AdaptationRevision" ADD CONSTRAINT "AdaptationRevision_projectId_reviewedBasisRevisionId_fkey" FOREIGN KEY ("projectId", "reviewedBasisRevisionId") REFERENCES "FactualBasisRevision"("projectId", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "AdaptationRevision" ADD CONSTRAINT "AdaptationRevision_workspaceId_reviewedWorkspaceStyleRevis_fkey" FOREIGN KEY ("workspaceId", "reviewedWorkspaceStyleRevision") REFERENCES "WorkspaceStyleRevision"("workspaceId", "revision") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "AdaptationRevision" ADD CONSTRAINT "AdaptationRevision_reviewedBy_fkey" FOREIGN KEY ("reviewedBy") REFERENCES "UserProfile"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "AdaptationRevisionClaim" ADD CONSTRAINT "AdaptationRevisionClaim_projectId_revisionId_fkey" FOREIGN KEY ("projectId", "revisionId") REFERENCES "AdaptationRevision"("projectId", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "AdaptationRevisionClaim" ADD CONSTRAINT "AdaptationRevisionClaim_projectId_claimRevisionId_fkey" FOREIGN KEY ("projectId", "claimRevisionId") REFERENCES "ClaimRevision"("projectId", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "AdaptationRevisionClaim" ADD CONSTRAINT "AdaptationRevisionClaim_projectId_claimRevisionId_evidence_fkey" FOREIGN KEY ("projectId", "claimRevisionId", "evidenceId") REFERENCES "ClaimEvidence"("projectId", "claimRevisionId", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

ALTER TABLE "Adaptation" ADD CONSTRAINT "Adaptation_format_check" CHECK ("format"='TELEGRAM_POST');
ALTER TABLE "Adaptation" ADD CONSTRAINT "Adaptation_revision_check" CHECK ("revision">=0);
ALTER TABLE "AdaptationDraft" ADD CONSTRAINT "AdaptationDraft_shape_check" CHECK (
 "sha256" ~ '^[a-f0-9]{64}$' AND octet_length("content"::text)<=100000
 AND jsonb_typeof("content")='object' AND jsonb_typeof("content"->'text')='string'
 AND length("content"->>'text') BETWEEN 1 AND 4096 AND jsonb_typeof("content"->'mappings')='array'
 AND jsonb_array_length("content"->'mappings')<=100 AND "workspaceStyleRevision">0
 AND (("inputMode"='DIRECT' AND "sourceArticleVersionId" IS NULL) OR ("inputMode"='ARTICLE_DERIVED' AND "sourceArticleVersionId" IS NOT NULL))
 AND (("contentMode"='FACTUAL' AND "basisRevisionId" IS NOT NULL) OR ("contentMode"='CREATIVE' AND "basisRevisionId" IS NULL))
 AND "origin" IN ('MANUAL','AI'));
ALTER TABLE "AdaptationRevision" ADD CONSTRAINT "AdaptationRevision_shape_check" CHECK (
 "number">0 AND "sourceAdaptationRevision">=0 AND "sha256" ~ '^[a-f0-9]{64}$'
 AND octet_length("content"::text)<=100000 AND jsonb_typeof("content")='object'
 AND jsonb_typeof("content"->'text')='string' AND length("content"->>'text') BETWEEN 1 AND 4096
 AND jsonb_typeof("content"->'mappings')='array' AND jsonb_array_length("content"->'mappings')<=100
 AND "workspaceStyleRevision">0
 AND (("inputMode"='DIRECT' AND "sourceArticleVersionId" IS NULL) OR ("inputMode"='ARTICLE_DERIVED' AND "sourceArticleVersionId" IS NOT NULL))
 AND (("contentMode"='FACTUAL' AND "basisRevisionId" IS NOT NULL) OR ("contentMode"='CREATIVE' AND "basisRevisionId" IS NULL))
 AND (("origin"='AI') = ("jobId" IS NOT NULL AND "aiExecutionId" IS NOT NULL))
 AND ("origin"='AI' OR ("jobId" IS NULL AND "aiExecutionId" IS NULL))
 AND ("jobId" IS NULL OR "origin"='AI')
 AND (("approvedBy" IS NULL)=("approvedAt" IS NULL)) AND (("withdrawnBy" IS NULL)=("withdrawnAt" IS NULL))
 AND ("approvedAt" IS NULL OR "claimsSealed") AND ("withdrawnAt" IS NULL OR "approvedAt" IS NOT NULL)
 AND ("approvedAt" IS NOT NULL OR NOT "acknowledgedUnmapped")
 AND ("withdrawnAt" IS NOT NULL OR "withdrawalReason" IS NULL)
 AND (("reviewCounter"=0 AND "reviewedBriefRevisionId" IS NULL AND "reviewedBasisRevisionId" IS NULL AND "reviewedSourceArticleVersionId" IS NULL AND "reviewedWorkspaceStyleRevision" IS NULL AND "reviewedBy" IS NULL AND "reviewedAt" IS NULL)
   OR ("reviewCounter">0 AND "approvedAt" IS NOT NULL AND "reviewedBriefRevisionId" IS NOT NULL
     AND "reviewedWorkspaceStyleRevision" IS NOT NULL AND "reviewedWorkspaceStyleRevision">0 AND "reviewedBy" IS NOT NULL AND "reviewedAt" IS NOT NULL
     AND (("inputMode"='DIRECT' AND "reviewedSourceArticleVersionId" IS NULL) OR ("inputMode"='ARTICLE_DERIVED' AND "reviewedSourceArticleVersionId" IS NOT NULL))
     AND (("contentMode"='FACTUAL' AND "reviewedBasisRevisionId" IS NOT NULL) OR ("contentMode"='CREATIVE' AND "reviewedBasisRevisionId" IS NULL)))));
ALTER TABLE "AdaptationRevisionClaim" ADD CONSTRAINT "AdaptationRevisionClaim_shape_check" CHECK (
 length("locator") BETWEEN 1 AND 200 AND length("quote") BETWEEN 1 AND 10000 AND length("linkedText") BETWEEN 1 AND 500000);
ALTER TABLE "ArticleVersion" ADD CONSTRAINT "ArticleVersion_review_receipt_check" CHECK (
 "reviewCounter">=0 AND
 (("reviewCounter"=0 AND "reviewedBriefRevisionId" IS NULL AND "reviewedBasisRevisionId" IS NULL AND "reviewedOutlineRevisionId" IS NULL AND "reviewedWorkspaceStyleRevision" IS NULL AND "reviewedBy" IS NULL AND "reviewedAt" IS NULL)
  OR ("reviewCounter">0 AND "approvedAt" IS NOT NULL
    AND (("briefRevisionId" IS NULL AND "reviewedBriefRevisionId" IS NULL) OR ("briefRevisionId" IS NOT NULL AND "reviewedBriefRevisionId" IS NOT NULL))
    AND (("outlineRevisionId" IS NULL AND "reviewedOutlineRevisionId" IS NULL) OR ("outlineRevisionId" IS NOT NULL AND "reviewedOutlineRevisionId" IS NOT NULL))
    AND "reviewedWorkspaceStyleRevision" IS NOT NULL AND "reviewedWorkspaceStyleRevision">0 AND "reviewedBy" IS NOT NULL AND "reviewedAt" IS NOT NULL
    AND (("contentMode"='FACTUAL' AND "reviewedBasisRevisionId" IS NOT NULL)
      OR ("contentMode"='CREATIVE' AND "reviewedBasisRevisionId" IS NULL)))));

CREATE FUNCTION guard_adaptation_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF ROW(NEW."id",NEW."projectId",NEW."format") IS DISTINCT FROM ROW(OLD."id",OLD."projectId",OLD."format") OR NEW."revision"<>OLD."revision"+1 THEN
  RAISE EXCEPTION 'adaptation identity is immutable and commands advance one revision' USING ERRCODE='23514';
 END IF;
 IF NEW."currentApprovedRevisionId" IS NOT NULL AND NOT EXISTS(
  SELECT 1 FROM contextflow."AdaptationRevision" v WHERE v."id"=NEW."currentApprovedRevisionId" AND v."projectId"=NEW."projectId" AND v."adaptationId"=NEW."id" AND v."approvedAt" IS NOT NULL AND v."withdrawnAt" IS NULL AND v."claimsSealed") THEN
  RAISE EXCEPTION 'adaptation approved pointer requires exact active approved revision' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER "Adaptation_identity_guard" BEFORE UPDATE ON "Adaptation" FOR EACH ROW EXECUTE FUNCTION guard_adaptation_identity();

CREATE FUNCTION guard_adaptation_draft_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF ROW(NEW."adaptationId",NEW."projectId") IS DISTINCT FROM ROW(OLD."adaptationId",OLD."projectId") THEN
  RAISE EXCEPTION 'adaptation draft identity is immutable' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER "AdaptationDraft_identity_guard" BEFORE UPDATE ON "AdaptationDraft" FOR EACH ROW EXECUTE FUNCTION guard_adaptation_draft_identity();

CREATE FUNCTION guard_adaptation_revision() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF (to_jsonb(NEW)-ARRAY['approvedBy','approvedAt','acknowledgedUnmapped','withdrawnBy','withdrawnAt','withdrawalReason','claimsSealed','reviewCounter','reviewedBriefRevisionId','reviewedBasisRevisionId','reviewedSourceArticleVersionId','reviewedWorkspaceStyleRevision','reviewedBy','reviewedAt']) IS DISTINCT FROM
    (to_jsonb(OLD)-ARRAY['approvedBy','approvedAt','acknowledgedUnmapped','withdrawnBy','withdrawnAt','withdrawalReason','claimsSealed','reviewCounter','reviewedBriefRevisionId','reviewedBasisRevisionId','reviewedSourceArticleVersionId','reviewedWorkspaceStyleRevision','reviewedBy','reviewedAt']) THEN
  RAISE EXCEPTION 'adaptation revision content and inputs are immutable' USING ERRCODE='23514';
 END IF;
 IF OLD."claimsSealed" AND NOT NEW."claimsSealed"
  OR OLD."approvedAt" IS NOT NULL AND ROW(NEW."approvedBy",NEW."approvedAt",NEW."acknowledgedUnmapped") IS DISTINCT FROM ROW(OLD."approvedBy",OLD."approvedAt",OLD."acknowledgedUnmapped")
  OR OLD."withdrawnAt" IS NOT NULL AND NEW IS DISTINCT FROM OLD THEN
  RAISE EXCEPTION 'adaptation sealed mappings, first approval and terminal withdrawal are immutable' USING ERRCODE='23514';
 END IF;
 IF NEW."reviewCounter"<>OLD."reviewCounter" OR ROW(NEW."reviewedBriefRevisionId",NEW."reviewedBasisRevisionId",NEW."reviewedSourceArticleVersionId",NEW."reviewedWorkspaceStyleRevision",NEW."reviewedBy",NEW."reviewedAt") IS DISTINCT FROM ROW(OLD."reviewedBriefRevisionId",OLD."reviewedBasisRevisionId",OLD."reviewedSourceArticleVersionId",OLD."reviewedWorkspaceStyleRevision",OLD."reviewedBy",OLD."reviewedAt") THEN
  IF NEW."reviewCounter"<>OLD."reviewCounter"+1 OR OLD."approvedAt" IS NULL OR OLD."withdrawnAt" IS NOT NULL OR NOT OLD."claimsSealed"
   OR NOT EXISTS(SELECT 1 FROM contextflow."Adaptation" a WHERE a."id"=OLD."adaptationId" AND a."projectId"=OLD."projectId" AND a."currentApprovedRevisionId"=OLD."id") THEN
   RAISE EXCEPTION 'review receipt requires the current approved active revision and counter plus one' USING ERRCODE='23514';
  END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER "AdaptationRevision_review_guard" BEFORE UPDATE ON "AdaptationRevision" FOR EACH ROW EXECUTE FUNCTION guard_adaptation_revision();

CREATE OR REPLACE FUNCTION guard_article_version() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF (to_jsonb(NEW)-ARRAY['approvedBy','approvedAt','acknowledgedUnmapped','withdrawnBy','withdrawnAt','withdrawalReason','claimsSealed','reviewCounter','reviewedBriefRevisionId','reviewedBasisRevisionId','reviewedOutlineRevisionId','reviewedWorkspaceStyleRevision','reviewedBy','reviewedAt']) IS DISTINCT FROM
    (to_jsonb(OLD)-ARRAY['approvedBy','approvedAt','acknowledgedUnmapped','withdrawnBy','withdrawnAt','withdrawalReason','claimsSealed','reviewCounter','reviewedBriefRevisionId','reviewedBasisRevisionId','reviewedOutlineRevisionId','reviewedWorkspaceStyleRevision','reviewedBy','reviewedAt']) THEN
  RAISE EXCEPTION 'article version content and inputs are immutable' USING ERRCODE='23514';
 END IF;
 IF OLD."claimsSealed" AND NOT NEW."claimsSealed" OR OLD."approvedAt" IS NOT NULL AND ROW(NEW."approvedBy",NEW."approvedAt",NEW."acknowledgedUnmapped") IS DISTINCT FROM ROW(OLD."approvedBy",OLD."approvedAt",OLD."acknowledgedUnmapped") OR OLD."withdrawnAt" IS NOT NULL AND NEW IS DISTINCT FROM OLD THEN
  RAISE EXCEPTION 'article sealed mappings, first approval and terminal withdrawal are immutable' USING ERRCODE='23514';
 END IF;
 IF NEW."reviewCounter"<>OLD."reviewCounter" OR ROW(NEW."reviewedBriefRevisionId",NEW."reviewedBasisRevisionId",NEW."reviewedOutlineRevisionId",NEW."reviewedWorkspaceStyleRevision",NEW."reviewedBy",NEW."reviewedAt") IS DISTINCT FROM ROW(OLD."reviewedBriefRevisionId",OLD."reviewedBasisRevisionId",OLD."reviewedOutlineRevisionId",OLD."reviewedWorkspaceStyleRevision",OLD."reviewedBy",OLD."reviewedAt") THEN
  IF NEW."reviewCounter"<>OLD."reviewCounter"+1 OR OLD."approvedAt" IS NULL OR OLD."withdrawnAt" IS NOT NULL OR NOT OLD."claimsSealed"
   OR NOT EXISTS(SELECT 1 FROM contextflow."Article" a WHERE a."id"=OLD."articleId" AND a."projectId"=OLD."projectId" AND a."currentApprovedVersionId"=OLD."id") THEN
   RAISE EXCEPTION 'review receipt requires the current approved active version and counter plus one' USING ERRCODE='23514';
  END IF;
 END IF;
 RETURN NEW;
END $$;

CREATE FUNCTION guard_telegram_inputs() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_TABLE_NAME='AdaptationRevision' THEN
  IF NEW."aiExecutionId" IS NOT NULL AND NOT EXISTS(SELECT 1 FROM contextflow."AIExecution" e WHERE e."id"=NEW."aiExecutionId" AND e."projectId"=NEW."projectId" AND e."jobId"=NEW."jobId") THEN
   RAISE EXCEPTION 'adaptation execution must belong to frozen job' USING ERRCODE='23514';
  END IF;
  IF NEW."jobId" IS NOT NULL AND NOT EXISTS(SELECT 1 FROM contextflow."Job" j WHERE j."id"=NEW."jobId" AND j."projectId"=NEW."projectId" AND j."operation"::text='TELEGRAM_GENERATION') THEN
   RAISE EXCEPTION 'adaptation job must use Telegram generation operation' USING ERRCODE='23514';
  END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER "AdaptationDraft_inputs_guard" BEFORE INSERT OR UPDATE ON "AdaptationDraft" FOR EACH ROW EXECUTE FUNCTION guard_telegram_inputs();
CREATE TRIGGER "AdaptationRevision_inputs_guard" BEFORE INSERT ON "AdaptationRevision" FOR EACH ROW EXECUTE FUNCTION guard_telegram_inputs();

CREATE FUNCTION guard_adaptation_claim_insert() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE sealed BOOLEAN;
BEGIN
 SELECT "claimsSealed" INTO sealed FROM contextflow."AdaptationRevision" WHERE "id"=NEW."revisionId" AND "projectId"=NEW."projectId" FOR UPDATE;
 IF sealed THEN RAISE EXCEPTION 'adaptation revision mappings are sealed' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER "AdaptationRevisionClaim_insert_guard" BEFORE INSERT ON "AdaptationRevisionClaim" FOR EACH ROW EXECUTE FUNCTION guard_adaptation_claim_insert();
CREATE TRIGGER "AdaptationRevisionClaim_immutable" BEFORE UPDATE ON "AdaptationRevisionClaim" FOR EACH ROW EXECUTE FUNCTION contextflow.guard_immutable_snapshot();

CREATE FUNCTION guard_review_receipt_insert() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW."reviewCounter"<>0 OR NEW."reviewedBy" IS NOT NULL OR NEW."reviewedAt" IS NOT NULL THEN
  RAISE EXCEPTION 'review receipt can only be added to an existing current approved revision' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER "ArticleVersion_receipt_insert_guard" BEFORE INSERT ON "ArticleVersion" FOR EACH ROW EXECUTE FUNCTION guard_review_receipt_insert();
CREATE TRIGGER "AdaptationRevision_receipt_insert_guard" BEFORE INSERT ON "AdaptationRevision" FOR EACH ROW EXECUTE FUNCTION guard_review_receipt_insert();

CREATE TRIGGER "Adaptation_no_delete" BEFORE DELETE ON "Adaptation" FOR EACH ROW EXECUTE FUNCTION guard_editorial_delete();
CREATE TRIGGER "AdaptationDraft_no_delete" BEFORE DELETE ON "AdaptationDraft" FOR EACH ROW EXECUTE FUNCTION guard_editorial_delete();
CREATE TRIGGER "AdaptationRevision_no_delete" BEFORE DELETE ON "AdaptationRevision" FOR EACH ROW EXECUTE FUNCTION guard_editorial_delete();
CREATE TRIGGER "AdaptationRevisionClaim_no_delete" BEFORE DELETE ON "AdaptationRevisionClaim" FOR EACH ROW EXECUTE FUNCTION guard_editorial_delete();

REVOKE ALL ON "Adaptation","AdaptationDraft","AdaptationRevision","AdaptationRevisionClaim" FROM PUBLIC;
REVOKE ALL ON TYPE "AdaptationInputMode" FROM PUBLIC;
DO $$ DECLARE role_name TEXT; BEGIN
 FOREACH role_name IN ARRAY ARRAY['anon','authenticated'] LOOP
  IF to_regrole(role_name) IS NOT NULL THEN
   EXECUTE format('REVOKE ALL ON contextflow."Adaptation",contextflow."AdaptationDraft",contextflow."AdaptationRevision",contextflow."AdaptationRevisionClaim" FROM %I',role_name);
   EXECUTE format('REVOKE ALL ON TYPE contextflow."AdaptationInputMode" FROM %I',role_name);
  END IF;
 END LOOP;
END $$;
GRANT USAGE ON TYPE "AdaptationInputMode" TO cf_runtime;
GRANT SELECT,INSERT,UPDATE ON "Adaptation","AdaptationDraft","AdaptationRevision" TO cf_runtime;
GRANT SELECT,INSERT ON "AdaptationRevisionClaim" TO cf_runtime;
COMMIT;
