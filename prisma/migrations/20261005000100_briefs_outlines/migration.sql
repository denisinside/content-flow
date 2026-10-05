BEGIN;
SET LOCAL search_path TO contextflow;
ALTER TYPE "JobOperation" ADD VALUE 'OUTLINE_GENERATION';
CREATE TYPE "ContentMode" AS ENUM ('FACTUAL', 'CREATIVE');
CREATE TYPE "EditorialOrigin" AS ENUM ('MANUAL', 'AI');
CREATE FUNCTION valid_brief_exclusions(value JSONB) RETURNS BOOLEAN LANGUAGE sql IMMUTABLE STRICT AS $$
  SELECT CASE WHEN jsonb_typeof(value) <> 'array' THEN false ELSE
    jsonb_array_length(value) <= 50 AND NOT EXISTS (
      SELECT 1 FROM jsonb_array_elements(value) item
      WHERE jsonb_typeof(item) <> 'string' OR length(item #>> '{}') NOT BETWEEN 1 AND 500
    ) END
$$;

CREATE UNIQUE INDEX "Project_id_workspaceId_key" ON "Project"("id", "workspaceId");
CREATE UNIQUE INDEX "AIExecution_projectId_id_key" ON "AIExecution"("projectId", "id");

CREATE TABLE "Brief" (
  "id" UUID PRIMARY KEY,
  "projectId" UUID NOT NULL UNIQUE REFERENCES "Project"("id") ON DELETE RESTRICT ON UPDATE NO ACTION,
  "revision" INTEGER NOT NULL DEFAULT 1 CHECK ("revision" > 0),
  "currentRevisionId" UUID,
  UNIQUE ("projectId", "id")
);
CREATE TABLE "BriefRevision" (
  "id" UUID PRIMARY KEY,
  "projectId" UUID NOT NULL,
  "briefId" UUID NOT NULL,
  "number" INTEGER NOT NULL CHECK ("number" > 0),
  "contentMode" "ContentMode" NOT NULL,
  "topic" VARCHAR(500) NOT NULL CHECK (length(btrim("topic")) > 0),
  "audience" VARCHAR(2000) NOT NULL,
  "centralMessage" VARCHAR(4000) NOT NULL,
  "category" VARCHAR(120) NOT NULL,
  "tone" VARCHAR(10000) NOT NULL,
  "targetLength" INTEGER NOT NULL CHECK ("targetLength" BETWEEN 50 AND 20000),
  "cta" VARCHAR(2000) NOT NULL,
  "exclusions" JSONB NOT NULL CHECK (contextflow.valid_brief_exclusions("exclusions")),
  "notes" TEXT NOT NULL CHECK (length("notes") <= 10000),
  "workspaceId" UUID NOT NULL,
  "workspaceStyleRevision" INTEGER NOT NULL CHECK ("workspaceStyleRevision" > 0),
  "sha256" CHAR(64) NOT NULL CHECK ("sha256" ~ '^[a-f0-9]{64}$'),
  "createdBy" UUID NOT NULL REFERENCES "UserProfile"("id") ON DELETE RESTRICT ON UPDATE NO ACTION,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE ("projectId", "id"),
  UNIQUE ("projectId", "briefId", "id"),
  UNIQUE ("briefId", "number"),
  FOREIGN KEY ("projectId", "briefId") REFERENCES "Brief"("projectId", "id") ON DELETE RESTRICT ON UPDATE NO ACTION,
  FOREIGN KEY ("projectId", "workspaceId") REFERENCES "Project"("id", "workspaceId") ON DELETE RESTRICT ON UPDATE NO ACTION,
  FOREIGN KEY ("workspaceId", "workspaceStyleRevision") REFERENCES "WorkspaceStyleRevision"("workspaceId", "revision") ON DELETE RESTRICT ON UPDATE NO ACTION
);
ALTER TABLE "Brief" ADD CONSTRAINT "Brief_projectId_id_currentRevisionId_fkey" FOREIGN KEY ("projectId", "id", "currentRevisionId") REFERENCES "BriefRevision"("projectId", "briefId", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;
CREATE TABLE "BriefRequiredClaim" (
  "projectId" UUID NOT NULL,
  "briefRevisionId" UUID NOT NULL,
  "claimRevisionId" UUID NOT NULL,
  PRIMARY KEY ("briefRevisionId", "claimRevisionId"),
  FOREIGN KEY ("projectId", "briefRevisionId") REFERENCES "BriefRevision"("projectId", "id") ON DELETE RESTRICT ON UPDATE NO ACTION,
  FOREIGN KEY ("projectId", "claimRevisionId") REFERENCES "ClaimRevision"("projectId", "id") ON DELETE RESTRICT ON UPDATE NO ACTION
);
CREATE TABLE "BriefContextSnapshot" (
  "projectId" UUID NOT NULL,
  "briefRevisionId" UUID NOT NULL,
  "snapshotId" UUID NOT NULL,
  "capturedPurpose" "MaterialPurpose" NOT NULL CHECK ("capturedPurpose" IN ('NOTES', 'BRANDBOOK', 'STYLE_SAMPLE')),
  PRIMARY KEY ("briefRevisionId", "snapshotId"),
  FOREIGN KEY ("projectId", "briefRevisionId") REFERENCES "BriefRevision"("projectId", "id") ON DELETE RESTRICT ON UPDATE NO ACTION,
  FOREIGN KEY ("projectId", "snapshotId") REFERENCES "SourceSnapshot"("projectId", "id") ON DELETE RESTRICT ON UPDATE NO ACTION
);
CREATE TABLE "Outline" (
  "id" UUID PRIMARY KEY,
  "projectId" UUID NOT NULL UNIQUE REFERENCES "Project"("id") ON DELETE RESTRICT ON UPDATE NO ACTION,
  "revision" INTEGER NOT NULL DEFAULT 1 CHECK ("revision" > 0),
  "currentRevisionId" UUID,
  "currentApprovedRevisionId" UUID,
  UNIQUE ("projectId", "id")
);
CREATE TABLE "OutlineRevision" (
  "id" UUID PRIMARY KEY,
  "projectId" UUID NOT NULL,
  "outlineId" UUID NOT NULL,
  "number" INTEGER NOT NULL CHECK ("number" > 0),
  "briefRevisionId" UUID NOT NULL,
  "basisRevisionId" UUID,
  "contentMode" "ContentMode" NOT NULL,
  "content" JSONB NOT NULL CHECK (jsonb_typeof("content") = 'object' AND "content" ? 'sections' AND jsonb_typeof("content"->'sections') = 'array' AND jsonb_array_length("content"->'sections') BETWEEN 1 AND 30),
  "sha256" CHAR(64) NOT NULL CHECK ("sha256" ~ '^[a-f0-9]{64}$'),
  "origin" "EditorialOrigin" NOT NULL,
  "createdBy" UUID NOT NULL REFERENCES "UserProfile"("id") ON DELETE RESTRICT ON UPDATE NO ACTION,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "jobId" UUID UNIQUE,
  "aiExecutionId" UUID,
  "approvedBy" UUID REFERENCES "UserProfile"("id") ON DELETE RESTRICT ON UPDATE NO ACTION,
  "approvedAt" TIMESTAMPTZ(3),
  "withdrawnBy" UUID REFERENCES "UserProfile"("id") ON DELETE RESTRICT ON UPDATE NO ACTION,
  "withdrawnAt" TIMESTAMPTZ(3),
  "withdrawalReason" VARCHAR(2000),
  UNIQUE ("projectId", "id"),
  UNIQUE ("projectId", "outlineId", "id"),
  UNIQUE ("outlineId", "number"),
  FOREIGN KEY ("projectId", "outlineId") REFERENCES "Outline"("projectId", "id") ON DELETE RESTRICT ON UPDATE NO ACTION,
  FOREIGN KEY ("projectId", "briefRevisionId") REFERENCES "BriefRevision"("projectId", "id") ON DELETE RESTRICT ON UPDATE NO ACTION,
  FOREIGN KEY ("projectId", "basisRevisionId") REFERENCES "FactualBasisRevision"("projectId", "id") ON DELETE RESTRICT ON UPDATE NO ACTION,
  FOREIGN KEY ("projectId", "jobId") REFERENCES "Job"("projectId", "id") ON DELETE RESTRICT ON UPDATE NO ACTION,
  FOREIGN KEY ("projectId", "aiExecutionId") REFERENCES "AIExecution"("projectId", "id") ON DELETE RESTRICT ON UPDATE NO ACTION,
  CHECK ("contentMode" <> 'CREATIVE' OR "basisRevisionId" IS NULL),
  CHECK ("contentMode" <> 'FACTUAL' OR "approvedAt" IS NULL OR "basisRevisionId" IS NOT NULL),
  CHECK (("approvedBy" IS NULL) = ("approvedAt" IS NULL)),
  CHECK (("withdrawnBy" IS NULL) = ("withdrawnAt" IS NULL)),
  CHECK ("withdrawnAt" IS NULL OR "approvedAt" IS NOT NULL AND "withdrawnAt" >= "approvedAt"),
  CHECK ("withdrawalReason" IS NULL OR "withdrawnAt" IS NOT NULL),
  CHECK ("approvedAt" IS NULL OR "approvedAt" >= "createdAt"),
  CHECK (("origin" = 'AI') = ("jobId" IS NOT NULL AND "aiExecutionId" IS NOT NULL)),
  CHECK ("origin" <> 'MANUAL' OR "jobId" IS NULL AND "aiExecutionId" IS NULL)
);
ALTER TABLE "Outline" ADD CONSTRAINT "Outline_projectId_id_currentRevisionId_fkey" FOREIGN KEY ("projectId", "id", "currentRevisionId") REFERENCES "OutlineRevision"("projectId", "outlineId", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;
ALTER TABLE "Outline" ADD CONSTRAINT "Outline_projectId_id_currentApprovedRevisionId_fkey" FOREIGN KEY ("projectId", "id", "currentApprovedRevisionId") REFERENCES "OutlineRevision"("projectId", "outlineId", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- Revisions and their captured input edges are append-only provenance.
CREATE TRIGGER "BriefRevision_immutable" BEFORE UPDATE ON "BriefRevision" FOR EACH ROW EXECUTE FUNCTION contextflow.guard_immutable_snapshot();
CREATE TRIGGER "BriefRequiredClaim_immutable" BEFORE UPDATE ON "BriefRequiredClaim" FOR EACH ROW EXECUTE FUNCTION contextflow.guard_immutable_snapshot();
CREATE TRIGGER "BriefContextSnapshot_immutable" BEFORE UPDATE ON "BriefContextSnapshot" FOR EACH ROW EXECUTE FUNCTION contextflow.guard_immutable_snapshot();

-- Edges are assembled before publishing a new brief pointer. Once published,
-- current and older revision graphs remain sealed, even after a later save.
CREATE FUNCTION guard_brief_edge_insert() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  -- Serialize edge assembly with publication of the stable container pointer.
  PERFORM 1 FROM contextflow."Brief" b JOIN contextflow."BriefRevision" r ON r."briefId" = b."id"
    WHERE r."id" = NEW."briefRevisionId" FOR UPDATE OF b;
  IF EXISTS (
    SELECT 1 FROM contextflow."BriefRevision" captured
    JOIN contextflow."Brief" b ON b."id" = captured."briefId" AND b."projectId" = captured."projectId"
    JOIN contextflow."BriefRevision" current_revision ON current_revision."id" = b."currentRevisionId"
    WHERE captured."id" = NEW."briefRevisionId" AND current_revision."number" >= captured."number"
  ) OR EXISTS (SELECT 1 FROM contextflow."OutlineRevision" o WHERE o."briefRevisionId" = NEW."briefRevisionId") THEN
    RAISE EXCEPTION 'published brief input graph is immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "BriefRequiredClaim_insert_guard" BEFORE INSERT ON "BriefRequiredClaim" FOR EACH ROW EXECUTE FUNCTION guard_brief_edge_insert();
CREATE TRIGGER "BriefContextSnapshot_insert_guard" BEFORE INSERT ON "BriefContextSnapshot" FOR EACH ROW EXECUTE FUNCTION guard_brief_edge_insert();

CREATE FUNCTION guard_brief_context_capture() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM contextflow."SourceSnapshot" s JOIN contextflow."Material" m ON m."id" = s."materialId" AND m."projectId" = s."projectId"
    WHERE s."id" = NEW."snapshotId" AND s."projectId" = NEW."projectId" AND m."included"
      AND m."currentSnapshotId" = s."id" AND m."purpose" = NEW."capturedPurpose"
  ) THEN
    RAISE EXCEPTION 'brief context must capture an included current snapshot with its original purpose' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "BriefContextSnapshot_capture_guard" BEFORE INSERT ON "BriefContextSnapshot" FOR EACH ROW EXECUTE FUNCTION guard_brief_context_capture();

CREATE FUNCTION guard_brief_pointer() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD."currentRevisionId" IS NOT NULL AND NEW."currentRevisionId" IS DISTINCT FROM OLD."currentRevisionId" AND (
    NEW."currentRevisionId" IS NULL OR EXISTS (
      SELECT 1 FROM contextflow."BriefRevision" old_revision, contextflow."BriefRevision" new_revision
      WHERE old_revision."id" = OLD."currentRevisionId" AND new_revision."id" = NEW."currentRevisionId"
        AND new_revision."briefId" = OLD."id" AND new_revision."projectId" = OLD."projectId"
        AND new_revision."number" <= old_revision."number"
    )
  ) THEN
    RAISE EXCEPTION 'published brief pointer must advance to a newer revision' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "Brief_pointer_guard" BEFORE UPDATE ON "Brief" FOR EACH ROW EXECUTE FUNCTION guard_brief_pointer();

CREATE FUNCTION guard_editorial_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF ROW(NEW."id", NEW."projectId") IS DISTINCT FROM ROW(OLD."id", OLD."projectId")
    OR NEW."revision" < OLD."revision" THEN
    RAISE EXCEPTION 'editorial identity and counters are immutable' USING ERRCODE = '23514';
  END IF;
  IF (to_jsonb(NEW) - 'revision') IS DISTINCT FROM (to_jsonb(OLD) - 'revision')
    AND NOT (OLD."currentRevisionId" IS NULL AND OLD."revision" = 1 AND NEW."revision" = 1)
    AND NEW."revision" <> OLD."revision" + 1 THEN
    RAISE EXCEPTION 'editorial pointer changes must advance revision' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "Brief_identity_guard" BEFORE UPDATE ON "Brief" FOR EACH ROW EXECUTE FUNCTION guard_editorial_identity();
CREATE TRIGGER "Outline_identity_guard" BEFORE UPDATE ON "Outline" FOR EACH ROW EXECUTE FUNCTION guard_editorial_identity();

CREATE FUNCTION guard_outline_revision() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (to_jsonb(NEW) - ARRAY['approvedBy','approvedAt','withdrawnBy','withdrawnAt','withdrawalReason'])
    IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['approvedBy','approvedAt','withdrawnBy','withdrawnAt','withdrawalReason']) THEN
    RAISE EXCEPTION 'outline content and original inputs are immutable' USING ERRCODE = '23514';
  END IF;
  IF OLD."approvedAt" IS NOT NULL AND ROW(NEW."approvedBy", NEW."approvedAt") IS DISTINCT FROM ROW(OLD."approvedBy", OLD."approvedAt")
    OR OLD."withdrawnAt" IS NOT NULL AND NEW IS DISTINCT FROM OLD THEN
    RAISE EXCEPTION 'first approval and terminal withdrawal are immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "OutlineRevision_review_guard" BEFORE UPDATE ON "OutlineRevision" FOR EACH ROW EXECUTE FUNCTION guard_outline_revision();

CREATE FUNCTION guard_outline_inputs() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM contextflow."BriefRevision" b WHERE b."id" = NEW."briefRevisionId" AND b."projectId" = NEW."projectId" AND b."contentMode" = NEW."contentMode") THEN
    RAISE EXCEPTION 'outline mode must match frozen brief' USING ERRCODE = '23514';
  END IF;
  IF NEW."aiExecutionId" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM contextflow."AIExecution" a WHERE a."id" = NEW."aiExecutionId" AND a."projectId" = NEW."projectId" AND a."jobId" = NEW."jobId") THEN
    RAISE EXCEPTION 'outline execution must belong to original job' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "OutlineRevision_inputs_guard" BEFORE INSERT ON "OutlineRevision" FOR EACH ROW EXECUTE FUNCTION guard_outline_inputs();

CREATE FUNCTION guard_editorial_delete() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'editorial provenance must be retained' USING ERRCODE = '23514';
END $$;
CREATE TRIGGER "Brief_no_delete" BEFORE DELETE ON "Brief" FOR EACH ROW EXECUTE FUNCTION guard_editorial_delete();
CREATE TRIGGER "BriefRevision_no_delete" BEFORE DELETE ON "BriefRevision" FOR EACH ROW EXECUTE FUNCTION guard_editorial_delete();
CREATE TRIGGER "BriefRequiredClaim_no_delete" BEFORE DELETE ON "BriefRequiredClaim" FOR EACH ROW EXECUTE FUNCTION guard_editorial_delete();
CREATE TRIGGER "BriefContextSnapshot_no_delete" BEFORE DELETE ON "BriefContextSnapshot" FOR EACH ROW EXECUTE FUNCTION guard_editorial_delete();
CREATE TRIGGER "Outline_no_delete" BEFORE DELETE ON "Outline" FOR EACH ROW EXECUTE FUNCTION guard_editorial_delete();
CREATE TRIGGER "OutlineRevision_no_delete" BEFORE DELETE ON "OutlineRevision" FOR EACH ROW EXECUTE FUNCTION guard_editorial_delete();

REVOKE ALL ON "Brief", "BriefRevision", "BriefRequiredClaim", "BriefContextSnapshot", "Outline", "OutlineRevision" FROM PUBLIC;
REVOKE ALL ON TYPE "ContentMode", "EditorialOrigin" FROM PUBLIC;
DO $$ DECLARE role_name TEXT; BEGIN
  FOREACH role_name IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF to_regrole(role_name) IS NOT NULL THEN
      EXECUTE format('REVOKE ALL ON contextflow."Brief", contextflow."BriefRevision", contextflow."BriefRequiredClaim", contextflow."BriefContextSnapshot", contextflow."Outline", contextflow."OutlineRevision" FROM %I', role_name);
      EXECUTE format('REVOKE ALL ON TYPE contextflow."ContentMode", contextflow."EditorialOrigin" FROM %I', role_name);
    END IF;
  END LOOP;
END $$;
GRANT USAGE ON TYPE "ContentMode", "EditorialOrigin" TO cf_runtime;
GRANT SELECT, INSERT, UPDATE ON "Brief", "Outline", "OutlineRevision" TO cf_runtime;
GRANT SELECT, INSERT ON "BriefRevision", "BriefRequiredClaim", "BriefContextSnapshot" TO cf_runtime;
COMMIT;
