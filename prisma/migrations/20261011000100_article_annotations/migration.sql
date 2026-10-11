BEGIN;
SET LOCAL search_path = contextflow, public;
CREATE TYPE "ArticleAnnotationKind" AS ENUM ('COMMENT','SUGGESTION');
CREATE TYPE "ArticleAnnotationStatus" AS ENUM ('OPEN','RESOLVED','ACCEPTED','REJECTED');
CREATE TABLE "ArticleAnnotation" (
 "id" UUID PRIMARY KEY, "projectId" UUID NOT NULL, "articleVersionId" UUID NOT NULL,
 "resultVersionId" UUID, "kind" "ArticleAnnotationKind" NOT NULL,
 "status" "ArticleAnnotationStatus" NOT NULL DEFAULT 'OPEN', "revision" INTEGER NOT NULL DEFAULT 0,
 "anchorStart" INTEGER NOT NULL, "anchorEnd" INTEGER NOT NULL, "quote" TEXT NOT NULL,
 "prefix" VARCHAR(120) NOT NULL, "suffix" VARCHAR(120) NOT NULL, "body" VARCHAR(2000) NOT NULL,
 "replacementText" TEXT, "commandKey" UUID NOT NULL, "payloadHash" CHAR(64) NOT NULL,
 "createdBy" UUID NOT NULL REFERENCES "UserProfile"("id") ON DELETE RESTRICT ON UPDATE NO ACTION,
 "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 CONSTRAINT "ArticleAnnotation_source_fk" FOREIGN KEY ("projectId","articleVersionId") REFERENCES "ArticleVersion"("projectId","id") ON DELETE RESTRICT ON UPDATE NO ACTION,
 CONSTRAINT "ArticleAnnotation_result_fk" FOREIGN KEY ("projectId","resultVersionId") REFERENCES "ArticleVersion"("projectId","id") ON DELETE RESTRICT ON UPDATE NO ACTION,
 CONSTRAINT "ArticleAnnotation_anchor_check" CHECK ("anchorStart">=0 AND "anchorEnd">"anchorStart" AND length("quote")>0 AND length("body")>0 AND "revision">=0 AND "payloadHash" ~ '^[a-f0-9]{64}$'),
 CONSTRAINT "ArticleAnnotation_kind_check" CHECK (("kind"='COMMENT' AND "replacementText" IS NULL AND "status" IN ('OPEN','RESOLVED')) OR ("kind"='SUGGESTION' AND "replacementText" IS NOT NULL AND "status" IN ('OPEN','ACCEPTED','REJECTED'))),
 CONSTRAINT "ArticleAnnotation_result_check" CHECK (("status"='ACCEPTED')=("resultVersionId" IS NOT NULL))
);
CREATE UNIQUE INDEX "ArticleAnnotation_projectId_id_key" ON "ArticleAnnotation"("projectId","id");
CREATE UNIQUE INDEX "ArticleAnnotation_projectId_createdBy_commandKey_key" ON "ArticleAnnotation"("projectId","createdBy","commandKey");
CREATE INDEX "ArticleAnnotation_projectId_createdAt_idx" ON "ArticleAnnotation"("projectId","createdAt");
CREATE TABLE "ArticleAnnotationPost" (
 "id" UUID PRIMARY KEY, "projectId" UUID NOT NULL, "annotationId" UUID NOT NULL,
 "body" VARCHAR(2000) NOT NULL, "action" VARCHAR(16) NOT NULL,
 "createdBy" UUID NOT NULL REFERENCES "UserProfile"("id") ON DELETE RESTRICT ON UPDATE NO ACTION,
 "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 CONSTRAINT "ArticleAnnotationPost_annotation_fk" FOREIGN KEY ("projectId","annotationId") REFERENCES "ArticleAnnotation"("projectId","id") ON DELETE RESTRICT ON UPDATE NO ACTION,
 CONSTRAINT "ArticleAnnotationPost_action_check" CHECK ("action" IN ('REPLY','RESOLVE','REOPEN','ACCEPT','REJECT'))
);
CREATE INDEX "ArticleAnnotationPost_projectId_annotationId_createdAt_idx" ON "ArticleAnnotationPost"("projectId","annotationId","createdAt");
CREATE FUNCTION guard_article_annotation_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF (to_jsonb(NEW)-ARRAY['status','revision','resultVersionId']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['status','revision','resultVersionId']) OR NEW."revision"<>OLD."revision"+1 THEN
  RAISE EXCEPTION 'annotation origin and anchor are immutable; expected revision transition required' USING ERRCODE='23514';
 END IF;
 IF (OLD."kind"='COMMENT' AND NOT ((OLD."status"='OPEN' AND NEW."status"='RESOLVED') OR (OLD."status"='RESOLVED' AND NEW."status"='OPEN') OR OLD."status"=NEW."status")) OR
    (OLD."kind"='SUGGESTION' AND NOT (OLD."status"='OPEN' AND NEW."status" IN ('OPEN','ACCEPTED','REJECTED'))) THEN
  RAISE EXCEPTION 'invalid annotation status transition' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER "ArticleAnnotation_update_guard" BEFORE UPDATE ON "ArticleAnnotation" FOR EACH ROW EXECUTE FUNCTION guard_article_annotation_update();
CREATE TRIGGER "ArticleAnnotation_no_delete" BEFORE DELETE ON "ArticleAnnotation" FOR EACH ROW EXECUTE FUNCTION guard_editorial_delete();
CREATE TRIGGER "ArticleAnnotationPost_no_delete" BEFORE DELETE ON "ArticleAnnotationPost" FOR EACH ROW EXECUTE FUNCTION guard_editorial_delete();
CREATE TRIGGER "ArticleAnnotationPost_no_update" BEFORE UPDATE ON "ArticleAnnotationPost" FOR EACH ROW EXECUTE FUNCTION guard_editorial_delete();
REVOKE ALL ON "ArticleAnnotation","ArticleAnnotationPost" FROM PUBLIC;
REVOKE ALL ON TYPE "ArticleAnnotationKind","ArticleAnnotationStatus" FROM PUBLIC;
DO $$ DECLARE role_name TEXT; BEGIN
 FOREACH role_name IN ARRAY ARRAY['anon','authenticated'] LOOP
  IF to_regrole(role_name) IS NOT NULL THEN
   EXECUTE format('REVOKE ALL ON contextflow."ArticleAnnotation",contextflow."ArticleAnnotationPost" FROM %I',role_name);
   EXECUTE format('REVOKE ALL ON TYPE contextflow."ArticleAnnotationKind",contextflow."ArticleAnnotationStatus" FROM %I',role_name);
  END IF;
 END LOOP;
END $$;
GRANT USAGE ON TYPE "ArticleAnnotationKind","ArticleAnnotationStatus" TO cf_runtime;
GRANT SELECT,INSERT,UPDATE ON "ArticleAnnotation" TO cf_runtime;
GRANT SELECT,INSERT ON "ArticleAnnotationPost" TO cf_runtime;
COMMIT;
