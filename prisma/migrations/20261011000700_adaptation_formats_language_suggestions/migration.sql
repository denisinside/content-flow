BEGIN;
SET LOCAL search_path TO contextflow;

DO $$
BEGIN
 IF EXISTS (SELECT 1 FROM contextflow."Job" WHERE "operation"='TELEGRAM_GENERATION' AND "contractVersion"='telegram-v1'
   AND "status" IN ('QUEUED','RUNNING','RETRY_WAIT')) THEN
   RAISE EXCEPTION 'Drain nonterminal telegram-v1 jobs before deploying the shared adaptation workflow' USING ERRCODE='55000';
 END IF;
END $$;

CREATE TYPE "LanguageSuggestionTargetType" AS ENUM ('ARTICLE', 'ADAPTATION');
CREATE TYPE "LanguageSuggestionStatus" AS ENUM ('OPEN', 'ACCEPTED', 'REJECTED');
CREATE TYPE "LanguageSuggestionLocator" AS ENUM ('TITLE', 'BODY', 'COVER_TEXT');
CREATE TYPE "LanguageSuggestionProvenance" AS ENUM ('LOCAL_TYPOGRAPHY');

ALTER TABLE "Adaptation" DROP CONSTRAINT "Adaptation_format_check";
ALTER TABLE "Adaptation" ADD CONSTRAINT "Adaptation_format_check"
  CHECK ("format" IN ('TELEGRAM_POST', 'LINKEDIN_TEXT', 'LINKEDIN_COVER', 'INSTAGRAM_COVER'));
ALTER TABLE "AdaptationDraft" DROP CONSTRAINT "AdaptationDraft_shape_check";
ALTER TABLE "AdaptationDraft" ADD CONSTRAINT "AdaptationDraft_shape_check" CHECK (
 "sha256" ~ '^[a-f0-9]{64}$' AND octet_length("content"::text)<=120000
 AND jsonb_typeof("content")='object' AND jsonb_typeof("content"->'text')='string'
 AND length("content"->>'text') BETWEEN 1 AND 10000 AND jsonb_typeof("content"->'mappings')='array'
 AND jsonb_array_length("content"->'mappings')<=100 AND "workspaceStyleRevision">0
 AND (NOT ("content" ? 'cover') OR (jsonb_typeof("content"->'cover')='object'
   AND jsonb_typeof("content"->'cover'->'text')='string' AND length("content"->'cover'->>'text')<=200
   AND jsonb_typeof("content"->'cover'->'instruction')='string' AND length("content"->'cover'->>'instruction')<=2000))
 AND ("inputMode"='DIRECT' AND "sourceArticleVersionId" IS NULL OR "inputMode"='ARTICLE_DERIVED' AND "sourceArticleVersionId" IS NOT NULL)
 AND ("contentMode"='FACTUAL' AND "basisRevisionId" IS NOT NULL OR "contentMode"='CREATIVE' AND "basisRevisionId" IS NULL)
 AND "origin" IN ('MANUAL','AI'));
ALTER TABLE "AdaptationRevision" DROP CONSTRAINT "AdaptationRevision_shape_check";
ALTER TABLE "AdaptationRevision" ADD CONSTRAINT "AdaptationRevision_shape_check" CHECK (
 "number">0 AND "sourceAdaptationRevision">=0 AND "sha256" ~ '^[a-f0-9]{64}$'
 AND octet_length("content"::text)<=120000 AND jsonb_typeof("content")='object'
 AND jsonb_typeof("content"->'text')='string' AND length("content"->>'text') BETWEEN 1 AND 10000
 AND jsonb_typeof("content"->'mappings')='array' AND jsonb_array_length("content"->'mappings')<=100
 AND (NOT ("content" ? 'cover') OR (jsonb_typeof("content"->'cover')='object'
   AND jsonb_typeof("content"->'cover'->'text')='string' AND length("content"->'cover'->>'text')<=200
   AND jsonb_typeof("content"->'cover'->'instruction')='string' AND length("content"->'cover'->>'instruction')<=2000))
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

CREATE FUNCTION guard_adaptation_format_content() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE selected_format contextflow."ProjectFormat";
BEGIN
  SELECT "format" INTO selected_format FROM contextflow."Adaptation" WHERE "id"=NEW."adaptationId" AND "projectId"=NEW."projectId";
  IF selected_format IS NULL THEN RAISE EXCEPTION 'adaptation format is missing' USING ERRCODE='23503'; END IF;
  IF selected_format='TELEGRAM_POST' AND (length(NEW."content"->>'text')>4096 OR NEW."content" ? 'cover') THEN
    RAISE EXCEPTION 'Telegram content shape does not match its format' USING ERRCODE='23514';
  END IF;
  IF selected_format='LINKEDIN_TEXT' AND NEW."content" ? 'cover' THEN
    RAISE EXCEPTION 'LinkedIn text content cannot contain cover fields' USING ERRCODE='23514';
  END IF;
  IF selected_format IN ('LINKEDIN_COVER','INSTAGRAM_COVER') AND NOT (NEW."content" ? 'cover') THEN
    RAISE EXCEPTION 'Cover content is required for the selected format' USING ERRCODE='23514';
  END IF;
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(NEW."content"->'mappings') map
    WHERE COALESCE(map->>'field','text') NOT IN ('text','cover')
      OR COALESCE(map->>'field','text')='cover' AND NOT (NEW."content" ? 'cover')) THEN
    RAISE EXCEPTION 'Adaptation evidence mapping field is invalid' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "AdaptationDraft_format_guard" BEFORE INSERT OR UPDATE OF "content" ON "AdaptationDraft"
  FOR EACH ROW EXECUTE FUNCTION guard_adaptation_format_content();
CREATE TRIGGER "AdaptationRevision_format_guard" BEFORE INSERT OR UPDATE OF "content" ON "AdaptationRevision"
  FOR EACH ROW EXECUTE FUNCTION guard_adaptation_format_content();

CREATE TABLE "LanguageSuggestion" (
 "id" UUID PRIMARY KEY,
 "projectId" UUID NOT NULL,
 "targetType" contextflow."LanguageSuggestionTargetType" NOT NULL,
 "targetId" UUID NOT NULL,
 "contentHash" CHAR(64) NOT NULL,
 "locator" contextflow."LanguageSuggestionLocator" NOT NULL,
 "locatorStart" INTEGER NOT NULL,
 "locatorEnd" INTEGER NOT NULL,
 "originalText" VARCHAR(1000) NOT NULL,
 "replacementText" VARCHAR(1000) NOT NULL,
 "finding" VARCHAR(200) NOT NULL,
 "provenance" contextflow."LanguageSuggestionProvenance" NOT NULL,
 "status" contextflow."LanguageSuggestionStatus" NOT NULL DEFAULT 'OPEN',
 "resultVersionId" UUID,
 "createdBy" UUID NOT NULL,
 "decidedBy" UUID,
 "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 "decidedAt" TIMESTAMPTZ(3),
 CONSTRAINT "LanguageSuggestion_project_fk" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE RESTRICT ON UPDATE NO ACTION,
 CONSTRAINT "LanguageSuggestion_creator_fk" FOREIGN KEY ("createdBy") REFERENCES "UserProfile"("id") ON DELETE RESTRICT ON UPDATE NO ACTION,
 CONSTRAINT "LanguageSuggestion_decider_fk" FOREIGN KEY ("decidedBy") REFERENCES "UserProfile"("id") ON DELETE RESTRICT ON UPDATE NO ACTION,
 CONSTRAINT "LanguageSuggestion_shape_check" CHECK (
   "contentHash" ~ '^[a-f0-9]{64}$' AND "locatorStart">=0 AND "locatorEnd">"locatorStart"
   AND length("originalText")>0 AND length("replacementText")>0 AND length("finding")>0
   AND (("targetType"='ARTICLE' AND "locator" IN ('TITLE','BODY')) OR ("targetType"='ADAPTATION' AND "locator" IN ('BODY','COVER_TEXT')))
   AND (("status"='OPEN' AND "decidedBy" IS NULL AND "decidedAt" IS NULL)
     OR ("status" IN ('ACCEPTED','REJECTED') AND "decidedBy" IS NOT NULL AND "decidedAt" IS NOT NULL)))
);
REVOKE ALL ON TABLE "LanguageSuggestion" FROM PUBLIC;
REVOKE USAGE ON TYPE "LanguageSuggestionTargetType","LanguageSuggestionStatus","LanguageSuggestionLocator","LanguageSuggestionProvenance" FROM PUBLIC;
CREATE UNIQUE INDEX "LanguageSuggestion_projectId_id_key" ON "LanguageSuggestion"("projectId","id");
CREATE INDEX "LanguageSuggestion_target_status_idx" ON "LanguageSuggestion"("projectId","targetType","targetId","status");
CREATE INDEX "LanguageSuggestion_target_hash_idx" ON "LanguageSuggestion"("projectId","targetType","targetId","contentHash");

CREATE FUNCTION guard_language_suggestion() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE version_hash CHAR(64);
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'language suggestions are retained' USING ERRCODE='23514'; END IF;
  IF TG_OP='INSERT' THEN
    IF NEW."status"<>'OPEN' OR NEW."decidedBy" IS NOT NULL OR NEW."decidedAt" IS NOT NULL OR NEW."resultVersionId" IS NOT NULL THEN
      RAISE EXCEPTION 'language suggestions must begin open and undecided' USING ERRCODE='23514';
    END IF;
    IF NEW."targetType"='ARTICLE' THEN
      SELECT "sha256" INTO version_hash FROM contextflow."ArticleVersion" WHERE "id"=NEW."targetId" AND "projectId"=NEW."projectId";
    ELSE
      SELECT "sha256" INTO version_hash FROM contextflow."AdaptationRevision" WHERE "id"=NEW."targetId" AND "projectId"=NEW."projectId";
    END IF;
    IF version_hash IS NULL OR version_hash<>NEW."contentHash" THEN RAISE EXCEPTION 'language suggestion target is not the exact project revision' USING ERRCODE='23514'; END IF;
    RETURN NEW;
  END IF;
  IF (to_jsonb(NEW)-ARRAY['status','resultVersionId','decidedBy','decidedAt']) IS DISTINCT FROM
     (to_jsonb(OLD)-ARRAY['status','resultVersionId','decidedBy','decidedAt'])
     OR OLD."status"<>'OPEN' OR NEW."status" NOT IN ('ACCEPTED','REJECTED') OR NEW."decidedBy" IS NULL OR NEW."decidedAt" IS NULL THEN
    RAISE EXCEPTION 'language suggestion allows one terminal decision only' USING ERRCODE='23514';
  END IF;
  IF (NEW."status"='ACCEPTED' AND NEW."targetType"='ARTICLE' AND (NEW."resultVersionId" IS NULL OR NOT EXISTS(
       SELECT 1 FROM contextflow."ArticleVersion" v WHERE v."id"=NEW."resultVersionId" AND v."projectId"=NEW."projectId")))
    OR ((NEW."status"<>'ACCEPTED' OR NEW."targetType"<>'ARTICLE') AND NEW."resultVersionId" IS NOT NULL) THEN
    RAISE EXCEPTION 'language suggestion result version must be an accepted same-project Article version' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "LanguageSuggestion_guard" BEFORE INSERT OR UPDATE OR DELETE ON "LanguageSuggestion"
  FOR EACH ROW EXECUTE FUNCTION guard_language_suggestion();

DO $$
DECLARE role_name TEXT;
BEGIN
 FOREACH role_name IN ARRAY ARRAY['anon','authenticated'] LOOP
  IF to_regrole(role_name) IS NOT NULL THEN
   EXECUTE format('REVOKE ALL ON contextflow."LanguageSuggestion" FROM %I',role_name);
   EXECUTE format('REVOKE ALL ON TYPE contextflow."LanguageSuggestionTargetType",contextflow."LanguageSuggestionStatus",contextflow."LanguageSuggestionLocator",contextflow."LanguageSuggestionProvenance" FROM %I',role_name);
  END IF;
 END LOOP;
END $$;
GRANT USAGE ON TYPE "LanguageSuggestionTargetType","LanguageSuggestionStatus","LanguageSuggestionLocator","LanguageSuggestionProvenance" TO cf_runtime;
GRANT SELECT,INSERT ON "LanguageSuggestion" TO cf_runtime;
GRANT UPDATE ("status","resultVersionId","decidedBy","decidedAt") ON "LanguageSuggestion" TO cf_runtime;

CREATE OR REPLACE FUNCTION guard_export_request_update() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE item_count INTEGER;
DECLARE min_ordinal INTEGER;
DECLARE max_ordinal INTEGER;
BEGIN
  IF (to_jsonb(NEW) - 'itemsSealed') IS DISTINCT FROM (to_jsonb(OLD) - 'itemsSealed') OR OLD."itemsSealed" OR NOT NEW."itemsSealed" THEN
    RAISE EXCEPTION 'export request is immutable except for one-way item sealing' USING ERRCODE = '23514';
  END IF;
  SELECT count(*)::integer, min("ordinal"), max("ordinal") INTO item_count, min_ordinal, max_ordinal
    FROM contextflow."ExportItem" WHERE "requestId" = OLD."id" AND "projectId" = OLD."projectId";
  IF item_count < 1 OR (OLD."format" IN ('TXT', 'MARKDOWN') AND item_count <> 1) OR (OLD."format" = 'ZIP' AND item_count > 5)
    OR min_ordinal <> 0 OR max_ordinal <> item_count - 1 THEN
    RAISE EXCEPTION 'export item count or order does not match package format' USING ERRCODE = '23514';
  END IF;
  IF EXISTS (
    SELECT 1 FROM contextflow."ExportItem" i JOIN contextflow."Project" p ON p."id" = i."projectId"
    WHERE i."requestId" = OLD."id" AND i."projectId" = OLD."projectId"
      AND ((i."articleVersionId" IS NOT NULL AND NOT ('ARTICLE'::contextflow."ProjectFormat" = ANY(p."formats")))
        OR (i."adaptationRevisionId" IS NOT NULL AND NOT EXISTS (
          SELECT 1 FROM contextflow."AdaptationRevision" r JOIN contextflow."Adaptation" a ON a."id"=r."adaptationId" AND a."projectId"=r."projectId"
          WHERE r."id"=i."adaptationRevisionId" AND r."projectId"=i."projectId" AND a."format"=ANY(p."formats"))))
  ) THEN RAISE EXCEPTION 'export item is not among the Project selected outputs' USING ERRCODE = '23514'; END IF;
  RETURN NEW;
END $$;
COMMIT;
