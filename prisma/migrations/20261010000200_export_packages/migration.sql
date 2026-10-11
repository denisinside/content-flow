BEGIN;
SET LOCAL search_path TO contextflow;

CREATE TYPE "ExportFormat" AS ENUM ('TXT', 'MARKDOWN', 'ZIP');
ALTER TYPE "JobOperation" ADD VALUE 'EXPORT_BUILD';

CREATE TABLE "ExportRequest" (
  "id" UUID NOT NULL,
  "projectId" UUID NOT NULL,
  "requestedBy" UUID NOT NULL,
  "jobId" UUID NOT NULL,
  "format" "ExportFormat" NOT NULL,
  "manifest" JSONB NOT NULL,
  "manifestHash" CHAR(64) NOT NULL,
  "itemsSealed" BOOLEAN NOT NULL DEFAULT false,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ExportRequest_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ExportRequest_manifest_hash_check" CHECK ("manifestHash" ~ '^[a-f0-9]{64}$'),
  CONSTRAINT "ExportRequest_manifest_object_check" CHECK (jsonb_typeof("manifest") = 'object'),
  CONSTRAINT "ExportRequest_project_fk" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT "ExportRequest_requester_fk" FOREIGN KEY ("requestedBy") REFERENCES "UserProfile"("id") ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT "ExportRequest_job_project_fk" FOREIGN KEY ("projectId", "jobId") REFERENCES "Job"("projectId", "id") ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT "ExportRequest_job_unique" UNIQUE ("jobId"),
  CONSTRAINT "ExportRequest_project_id_unique" UNIQUE ("projectId", "id"),
  CONSTRAINT "ExportRequest_project_job_unique" UNIQUE ("projectId", "jobId")
);

CREATE TABLE "ExportItem" (
  "id" UUID NOT NULL,
  "projectId" UUID NOT NULL,
  "requestId" UUID NOT NULL,
  "ordinal" INTEGER NOT NULL,
  "articleVersionId" UUID,
  "adaptationRevisionId" UUID,
  CONSTRAINT "ExportItem_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ExportItem_ordinal_check" CHECK ("ordinal" >= 0),
  CONSTRAINT "ExportItem_target_xor_check" CHECK (("articleVersionId" IS NOT NULL) <> ("adaptationRevisionId" IS NOT NULL)),
  CONSTRAINT "ExportItem_project_fk" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT "ExportItem_request_project_fk" FOREIGN KEY ("projectId", "requestId") REFERENCES "ExportRequest"("projectId", "id") ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT "ExportItem_article_project_fk" FOREIGN KEY ("projectId", "articleVersionId") REFERENCES "ArticleVersion"("projectId", "id") ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT "ExportItem_adaptation_project_fk" FOREIGN KEY ("projectId", "adaptationRevisionId") REFERENCES "AdaptationRevision"("projectId", "id") ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT "ExportItem_project_id_unique" UNIQUE ("projectId", "id"),
  CONSTRAINT "ExportItem_request_ordinal_unique" UNIQUE ("requestId", "ordinal"),
  CONSTRAINT "ExportItem_request_article_unique" UNIQUE ("requestId", "articleVersionId"),
  CONSTRAINT "ExportItem_request_adaptation_unique" UNIQUE ("requestId", "adaptationRevisionId")
);

CREATE TABLE "ExportArtifact" (
  "id" UUID NOT NULL,
  "projectId" UUID NOT NULL,
  "requestId" UUID NOT NULL,
  "assetId" UUID NOT NULL,
  "sha256" CHAR(64) NOT NULL,
  "byteSize" INTEGER NOT NULL,
  "contentType" VARCHAR(100) NOT NULL,
  "filename" VARCHAR(200) NOT NULL,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ExportArtifact_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ExportArtifact_hash_check" CHECK ("sha256" ~ '^[a-f0-9]{64}$'),
  CONSTRAINT "ExportArtifact_size_check" CHECK ("byteSize" BETWEEN 1 AND 10485760),
  CONSTRAINT "ExportArtifact_content_type_check" CHECK (length(btrim("contentType")) BETWEEN 1 AND 100),
  CONSTRAINT "ExportArtifact_filename_check" CHECK (length(btrim("filename")) BETWEEN 1 AND 200 AND strpos("filename", '/') = 0 AND strpos("filename", chr(92)) = 0),
  CONSTRAINT "ExportArtifact_project_fk" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT "ExportArtifact_request_project_fk" FOREIGN KEY ("projectId", "requestId") REFERENCES "ExportRequest"("projectId", "id") ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT "ExportArtifact_asset_project_fk" FOREIGN KEY ("projectId", "assetId") REFERENCES "Asset"("projectId", "id") ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT "ExportArtifact_request_unique" UNIQUE ("requestId"),
  CONSTRAINT "ExportArtifact_asset_unique" UNIQUE ("assetId"),
  CONSTRAINT "ExportArtifact_project_id_unique" UNIQUE ("projectId", "id"),
  CONSTRAINT "ExportArtifact_project_request_unique" UNIQUE ("projectId", "requestId")
);

CREATE INDEX "ExportRequest_project_created_idx" ON "ExportRequest" ("projectId", "createdAt" DESC, "id" DESC);
CREATE INDEX "ExportArtifact_project_created_idx" ON "ExportArtifact" ("projectId", "createdAt" DESC, "id" DESC);

CREATE FUNCTION guard_export_request_insert() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."itemsSealed" THEN
    RAISE EXCEPTION 'export items must be inserted before sealing' USING ERRCODE = '23514';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM contextflow."Job" j
    WHERE j."id" = NEW."jobId" AND j."projectId" = NEW."projectId"
      AND j."requestedBy" = NEW."requestedBy" AND j."operation"::text = 'EXPORT_BUILD'
  ) THEN
    RAISE EXCEPTION 'export request requires its project job and requester' USING ERRCODE = '23514';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM contextflow."Project" p
    JOIN contextflow."WorkspaceMember" wm ON wm."workspaceId" = p."workspaceId"
    WHERE p."id" = NEW."projectId" AND wm."userId" = NEW."requestedBy" AND wm."leftAt" IS NULL
  ) THEN
    RAISE EXCEPTION 'export requester must be an active Workspace member' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "ExportRequest_insert_guard" BEFORE INSERT ON "ExportRequest" FOR EACH ROW EXECUTE FUNCTION guard_export_request_insert();

CREATE FUNCTION guard_export_request_update() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE item_count INTEGER;
DECLARE min_ordinal INTEGER;
DECLARE max_ordinal INTEGER;
BEGIN
  IF (to_jsonb(NEW) - 'itemsSealed') IS DISTINCT FROM (to_jsonb(OLD) - 'itemsSealed')
    OR OLD."itemsSealed" OR NOT NEW."itemsSealed" THEN
    RAISE EXCEPTION 'export request is immutable except for one-way item sealing' USING ERRCODE = '23514';
  END IF;
  SELECT count(*)::integer, min("ordinal"), max("ordinal") INTO item_count, min_ordinal, max_ordinal
    FROM contextflow."ExportItem" WHERE "requestId" = OLD."id" AND "projectId" = OLD."projectId";
  IF item_count < 1 OR (OLD."format" IN ('TXT', 'MARKDOWN') AND item_count <> 1)
    OR (OLD."format" = 'ZIP' AND item_count > 2)
    OR min_ordinal <> 0 OR max_ordinal <> item_count - 1 THEN
    RAISE EXCEPTION 'export item count or order does not match package format' USING ERRCODE = '23514';
  END IF;
  IF EXISTS (
    SELECT 1 FROM contextflow."ExportItem" i
    JOIN contextflow."Project" p ON p."id" = i."projectId"
    WHERE i."requestId" = OLD."id" AND i."projectId" = OLD."projectId"
      AND ((i."articleVersionId" IS NOT NULL AND NOT ('ARTICLE'::contextflow."ProjectFormat" = ANY(p."formats")))
        OR (i."adaptationRevisionId" IS NOT NULL AND NOT ('TELEGRAM_POST'::contextflow."ProjectFormat" = ANY(p."formats"))))
  ) THEN
    RAISE EXCEPTION 'export item is not among the Project selected outputs' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "ExportRequest_seal_guard" BEFORE UPDATE ON "ExportRequest" FOR EACH ROW EXECUTE FUNCTION guard_export_request_update();

CREATE FUNCTION guard_export_item_insert() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE sealed BOOLEAN;
BEGIN
  SELECT "itemsSealed" INTO sealed FROM contextflow."ExportRequest"
    WHERE "id" = NEW."requestId" AND "projectId" = NEW."projectId" FOR UPDATE;
  IF sealed IS DISTINCT FROM false THEN
    RAISE EXCEPTION 'export items can only be added to an unsealed request' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "ExportItem_insert_guard" BEFORE INSERT ON "ExportItem" FOR EACH ROW EXECUTE FUNCTION guard_export_item_insert();

CREATE FUNCTION guard_export_artifact_insert() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM contextflow."ExportRequest" r
    JOIN contextflow."Asset" a ON a."id" = NEW."assetId" AND a."projectId" = NEW."projectId"
    WHERE r."id" = NEW."requestId" AND r."projectId" = NEW."projectId" AND r."itemsSealed"
      AND a."purpose" = 'EXPORT' AND a."state" = 'AVAILABLE'
      AND a."sha256" = NEW."sha256" AND a."bytes" = NEW."byteSize"
  ) THEN
    RAISE EXCEPTION 'export artifact must reference matching available private export bytes' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "ExportArtifact_insert_guard" BEFORE INSERT ON "ExportArtifact" FOR EACH ROW EXECUTE FUNCTION guard_export_artifact_insert();

CREATE TRIGGER "ExportItem_immutable" BEFORE UPDATE ON "ExportItem" FOR EACH ROW EXECUTE FUNCTION contextflow.guard_immutable_snapshot();
CREATE TRIGGER "ExportArtifact_immutable" BEFORE UPDATE ON "ExportArtifact" FOR EACH ROW EXECUTE FUNCTION contextflow.guard_immutable_snapshot();
CREATE TRIGGER "ExportRequest_no_delete" BEFORE DELETE ON "ExportRequest" FOR EACH ROW EXECUTE FUNCTION contextflow.guard_editorial_delete();
CREATE TRIGGER "ExportItem_no_delete" BEFORE DELETE ON "ExportItem" FOR EACH ROW EXECUTE FUNCTION contextflow.guard_editorial_delete();
CREATE TRIGGER "ExportArtifact_no_delete" BEFORE DELETE ON "ExportArtifact" FOR EACH ROW EXECUTE FUNCTION contextflow.guard_editorial_delete();

REVOKE ALL ON "ExportRequest", "ExportItem", "ExportArtifact" FROM PUBLIC;
REVOKE ALL ON TYPE "ExportFormat" FROM PUBLIC;
DO $$ DECLARE role_name TEXT; BEGIN
  FOREACH role_name IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF to_regrole(role_name) IS NOT NULL THEN
      EXECUTE format('REVOKE ALL ON contextflow."ExportRequest", contextflow."ExportItem", contextflow."ExportArtifact" FROM %I', role_name);
      EXECUTE format('REVOKE ALL ON TYPE contextflow."ExportFormat" FROM %I', role_name);
    END IF;
  END LOOP;
END $$;
GRANT USAGE ON TYPE "ExportFormat" TO cf_runtime;
GRANT SELECT, INSERT ON "ExportRequest" TO cf_runtime;
GRANT UPDATE ("itemsSealed") ON "ExportRequest" TO cf_runtime;
GRANT SELECT, INSERT ON "ExportItem", "ExportArtifact" TO cf_runtime;
COMMIT;
