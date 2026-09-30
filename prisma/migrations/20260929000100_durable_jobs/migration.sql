BEGIN;
ALTER TYPE contextflow."MaterialKind" ADD VALUE 'URL';
ALTER TYPE contextflow."SourceOrigin" ADD VALUE 'WEB_IMPORT';
ALTER TYPE contextflow."SourceOrigin" ADD VALUE 'DOCUMENT_IMPORT';
CREATE TYPE contextflow."JobOperation" AS ENUM ('WEB_IMPORT', 'DOCUMENT_IMPORT', 'CLAIM_EXTRACTION');
CREATE TYPE contextflow."JobStatus" AS ENUM ('QUEUED', 'RUNNING', 'RETRY_WAIT', 'SUCCEEDED', 'FAILED', 'CANCELLED', 'OUTCOME_UNKNOWN');
CREATE TYPE contextflow."ProviderOutcome" AS ENUM ('NOT_SUBMITTED', 'KNOWN_FAILED', 'KNOWN_SUCCEEDED', 'MAY_STILL_RUN', 'UNKNOWN');
CREATE TABLE contextflow."Job" (
  "id" UUID PRIMARY KEY,
  "projectId" UUID NOT NULL REFERENCES contextflow."Project"("id") ON DELETE RESTRICT ON UPDATE NO ACTION,
  "requestedBy" UUID NOT NULL REFERENCES contextflow."UserProfile"("id") ON DELETE RESTRICT ON UPDATE NO ACTION,
  "operation" contextflow."JobOperation" NOT NULL,
  "contractVersion" VARCHAR(64) NOT NULL CHECK (length("contractVersion") > 0),
  "commandKey" VARCHAR(128) NOT NULL CHECK (length(btrim("commandKey")) BETWEEN 1 AND 128 AND "commandKey" = btrim("commandKey")),
  "inputManifest" JSONB NOT NULL CHECK (jsonb_typeof("inputManifest") = 'object'),
  "inputHash" CHAR(64) NOT NULL CHECK ("inputHash" ~ '^[a-f0-9]{64}$'),
  "status" contextflow."JobStatus" NOT NULL DEFAULT 'QUEUED',
  "attemptCount" INTEGER NOT NULL DEFAULT 0 CHECK ("attemptCount" BETWEEN 0 AND 3),
  "fencingToken" INTEGER NOT NULL DEFAULT 0 CHECK ("fencingToken" >= "attemptCount"),
  "nextAttemptAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "deadlineAt" TIMESTAMPTZ(3) NOT NULL,
  "cancelRequestedAt" TIMESTAMPTZ(3),
  "publishedAt" TIMESTAMPTZ(3),
  "progressStage" VARCHAR(64) NOT NULL DEFAULT 'WAITING',
  "resultRefs" JSONB,
  "errorCategory" VARCHAR(64),
  "providerOutcome" contextflow."ProviderOutcome" NOT NULL DEFAULT 'NOT_SUBMITTED',
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE ("projectId", "id"), UNIQUE ("projectId", "operation", "commandKey"),
  CHECK ("deadlineAt" > "createdAt"),
  CHECK (("status" = 'SUCCEEDED') = ("resultRefs" IS NOT NULL)),
  CHECK ("status" <> 'CANCELLED' OR "cancelRequestedAt" IS NOT NULL)
);
CREATE TABLE contextflow."JobAttempt" (
  "id" UUID PRIMARY KEY,
  "jobId" UUID NOT NULL REFERENCES contextflow."Job"("id") ON DELETE RESTRICT ON UPDATE NO ACTION,
  "ordinal" INTEGER NOT NULL CHECK ("ordinal" BETWEEN 1 AND 3),
  "fencingToken" INTEGER NOT NULL CHECK ("fencingToken" >= "ordinal"),
  "leaseOwner" VARCHAR(128) NOT NULL,
  "leaseExpiresAt" TIMESTAMPTZ(3) NOT NULL,
  "heartbeatAt" TIMESTAMPTZ(3) NOT NULL,
  "providerSubmittedAt" TIMESTAMPTZ(3), "providerRunId" VARCHAR(200),
  "providerOutcome" contextflow."ProviderOutcome" NOT NULL DEFAULT 'NOT_SUBMITTED',
  "errorCategory" VARCHAR(64),
  "startedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "finishedAt" TIMESTAMPTZ(3),
  UNIQUE ("jobId", "ordinal"), UNIQUE ("jobId", "fencingToken"),
  CHECK ("providerRunId" IS NULL OR "providerSubmittedAt" IS NOT NULL)
);
CREATE INDEX "Job_status_nextAttemptAt_idx" ON contextflow."Job" ("status", "nextAttemptAt");
CREATE INDEX "Job_projectId_createdAt_id_idx" ON contextflow."Job" ("projectId", "createdAt", "id");
CREATE INDEX "JobAttempt_leaseExpiresAt_finishedAt_idx" ON contextflow."JobAttempt" ("leaseExpiresAt", "finishedAt");
ALTER TABLE contextflow."Material" ADD COLUMN "sourceUrl" VARCHAR(2048), ADD COLUMN "originalAssetId" UUID, ADD COLUMN "originalFilename" VARCHAR(255),
  ADD CONSTRAINT "Material_originalAsset_fkey" FOREIGN KEY ("projectId", "originalAssetId") REFERENCES contextflow."Asset"("projectId", "id") ON DELETE RESTRICT ON UPDATE NO ACTION,
  ADD CONSTRAINT "Material_original_pair_check" CHECK (("originalAssetId" IS NULL) = ("originalFilename" IS NULL));
ALTER TABLE contextflow."SourceSnapshot" ADD COLUMN "providerMetadata" JSONB, ADD COLUMN "jobId" UUID,
  ADD CONSTRAINT "SourceSnapshot_job_fkey" FOREIGN KEY ("projectId", "jobId") REFERENCES contextflow."Job"("projectId", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;
CREATE UNIQUE INDEX "SourceSnapshot_projectId_jobId_key" ON contextflow."SourceSnapshot" ("projectId", "jobId");
CREATE FUNCTION contextflow.guard_job_input() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF ROW(NEW."id", NEW."projectId", NEW."requestedBy", NEW."operation", NEW."contractVersion", NEW."commandKey", NEW."inputManifest", NEW."inputHash", NEW."deadlineAt", NEW."createdAt") IS DISTINCT FROM
     ROW(OLD."id", OLD."projectId", OLD."requestedBy", OLD."operation", OLD."contractVersion", OLD."commandKey", OLD."inputManifest", OLD."inputHash", OLD."deadlineAt", OLD."createdAt") THEN
    RAISE EXCEPTION 'job frozen identity and inputs are immutable' USING ERRCODE = '23514';
  END IF;
  IF NEW."fencingToken" < OLD."fencingToken" OR NEW."attemptCount" < OLD."attemptCount" THEN
    RAISE EXCEPTION 'job execution counters cannot move backwards' USING ERRCODE = '23514';
  END IF;
  IF OLD."status" IN ('SUCCEEDED', 'CANCELLED') AND NEW IS DISTINCT FROM OLD THEN
    RAISE EXCEPTION 'terminal job is immutable' USING ERRCODE = '23514';
  END IF;
  IF OLD."status" = 'OUTCOME_UNKNOWN' AND ROW(NEW."status", NEW."resultRefs", NEW."attemptCount", NEW."fencingToken", NEW."cancelRequestedAt")
    IS DISTINCT FROM ROW(OLD."status", OLD."resultRefs", OLD."attemptCount", OLD."fencingToken", OLD."cancelRequestedAt") THEN
    RAISE EXCEPTION 'unknown job cannot commit late results or resume' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "Job_input_guard" BEFORE UPDATE ON contextflow."Job" FOR EACH ROW EXECUTE FUNCTION contextflow.guard_job_input();
CREATE FUNCTION contextflow.guard_attempt_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF ROW(NEW."id", NEW."jobId", NEW."ordinal", NEW."fencingToken", NEW."leaseOwner", NEW."startedAt") IS DISTINCT FROM
    ROW(OLD."id", OLD."jobId", OLD."ordinal", OLD."fencingToken", OLD."leaseOwner", OLD."startedAt") THEN
    RAISE EXCEPTION 'job attempt identity is immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "JobAttempt_identity_guard" BEFORE UPDATE ON contextflow."JobAttempt" FOR EACH ROW EXECUTE FUNCTION contextflow.guard_attempt_identity();
CREATE OR REPLACE FUNCTION contextflow.guard_material_revision() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF ROW(NEW."id", NEW."projectId", NEW."createdBy", NEW."createdAt", NEW."sourceUrl", NEW."originalAssetId", NEW."originalFilename")
    IS DISTINCT FROM ROW(OLD."id", OLD."projectId", OLD."createdBy", OLD."createdAt", OLD."sourceUrl", OLD."originalAssetId", OLD."originalFilename") THEN
    RAISE EXCEPTION 'material identity and original source are immutable' USING ERRCODE = '23514';
  END IF;
  IF ROW(NEW."kind", NEW."purpose", NEW."label", NEW."included", NEW."currentSnapshotId")
    IS DISTINCT FROM ROW(OLD."kind", OLD."purpose", OLD."label", OLD."included", OLD."currentSnapshotId") AND NEW."revision" <> OLD."revision" + 1 THEN
    RAISE EXCEPTION 'material edits must advance revision by one' USING ERRCODE = '23514';
  END IF;
  IF NEW."revision" < OLD."revision" OR NEW."updatedAt" < OLD."updatedAt" THEN
    RAISE EXCEPTION 'material revision and update time cannot move backwards' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE OR REPLACE FUNCTION contextflow.guard_referenced_asset_metadata() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (EXISTS (SELECT 1 FROM contextflow."SourceSnapshot" s WHERE s."projectId" = OLD."projectId" AND s."originalAssetId" = OLD."id")
      OR EXISTS (SELECT 1 FROM contextflow."Material" m WHERE m."projectId" = OLD."projectId" AND m."originalAssetId" = OLD."id"))
    AND ROW(NEW."id", NEW."projectId", NEW."bucket", NEW."objectKey", NEW."mediaType", NEW."bytes", NEW."sha256", NEW."purpose", NEW."createdBy", NEW."createdAt")
      IS DISTINCT FROM ROW(OLD."id", OLD."projectId", OLD."bucket", OLD."objectKey", OLD."mediaType", OLD."bytes", OLD."sha256", OLD."purpose", OLD."createdBy", OLD."createdAt") THEN
    RAISE EXCEPTION 'referenced source original asset metadata is immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
ALTER TABLE contextflow."SourceSnapshot" ADD CONSTRAINT "SourceSnapshot_import_origin_check"
  CHECK (("origin"::text NOT IN ('WEB_IMPORT', 'DOCUMENT_IMPORT') OR "jobId" IS NOT NULL)
    AND ("origin"::text <> 'DOCUMENT_IMPORT' OR "originalAssetId" IS NOT NULL));
REVOKE ALL ON contextflow."Job", contextflow."JobAttempt" FROM PUBLIC;
REVOKE ALL ON TYPE contextflow."JobOperation", contextflow."JobStatus", contextflow."ProviderOutcome" FROM PUBLIC;
DO $$ DECLARE provider_role TEXT; BEGIN
  FOREACH provider_role IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF to_regrole(provider_role) IS NOT NULL THEN
      EXECUTE format('REVOKE ALL ON contextflow."Job", contextflow."JobAttempt" FROM %I', provider_role);
      EXECUTE format('REVOKE ALL ON TYPE contextflow."JobOperation", contextflow."JobStatus", contextflow."ProviderOutcome" FROM %I', provider_role);
    END IF;
  END LOOP;
END $$;
GRANT USAGE ON TYPE contextflow."JobOperation", contextflow."JobStatus", contextflow."ProviderOutcome" TO cf_runtime;
GRANT SELECT, INSERT, UPDATE ON contextflow."Job", contextflow."JobAttempt" TO cf_runtime;
COMMIT;
