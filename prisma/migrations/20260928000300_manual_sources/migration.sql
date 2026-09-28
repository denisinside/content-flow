BEGIN;

CREATE TYPE contextflow."MaterialKind" AS ENUM ('TEXT', 'FILE');
CREATE TYPE contextflow."MaterialPurpose" AS ENUM ('FACTUAL_SOURCE', 'NOTES', 'BRANDBOOK', 'STYLE_SAMPLE', 'SUPPLIED_ARTICLE');
CREATE TYPE contextflow."SourceOrigin" AS ENUM ('MANUAL_TEXT', 'LOCAL_FILE');

ALTER TABLE contextflow."UserProfile"
  ADD COLUMN "externalProcessingNoticeVersion" VARCHAR(64),
  ADD COLUMN "externalProcessingAcceptedAt" TIMESTAMPTZ(3),
  ADD CONSTRAINT "UserProfile_externalProcessingAcceptance_check"
    CHECK (("externalProcessingNoticeVersion" IS NULL) = ("externalProcessingAcceptedAt" IS NULL));

CREATE TABLE contextflow."Material" (
  "id" UUID PRIMARY KEY,
  "projectId" UUID NOT NULL REFERENCES contextflow."Project"("id") ON DELETE RESTRICT ON UPDATE NO ACTION,
  "kind" contextflow."MaterialKind" NOT NULL,
  "purpose" contextflow."MaterialPurpose" NOT NULL,
  "label" VARCHAR(200) NOT NULL CHECK (length(btrim("label")) BETWEEN 1 AND 200 AND "label" = btrim("label")),
  "included" BOOLEAN NOT NULL DEFAULT TRUE,
  "revision" INTEGER NOT NULL DEFAULT 1 CHECK ("revision" > 0),
  "currentSnapshotId" UUID,
  "createdBy" UUID NOT NULL REFERENCES contextflow."UserProfile"("id") ON DELETE RESTRICT ON UPDATE NO ACTION,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE ("projectId", "id")
);

CREATE TABLE contextflow."SourceSnapshot" (
  "id" UUID PRIMARY KEY,
  "projectId" UUID NOT NULL,
  "materialId" UUID NOT NULL,
  "sequence" INTEGER NOT NULL CHECK ("sequence" > 0),
  "normalizedText" TEXT NOT NULL CHECK (char_length("normalizedText") BETWEEN 1 AND 200000),
  "sha256" CHAR(64) NOT NULL CHECK ("sha256" ~ '^[a-f0-9]{64}$'),
  "bytes" INTEGER NOT NULL CHECK ("bytes" BETWEEN 1 AND 1048576),
  "origin" contextflow."SourceOrigin" NOT NULL,
  "originalAssetId" UUID,
  "originalFilename" VARCHAR(255),
  "previousSnapshotId" UUID,
  "createdBy" UUID NOT NULL REFERENCES contextflow."UserProfile"("id") ON DELETE RESTRICT ON UPDATE NO ACTION,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE ("projectId", "id"),
  UNIQUE ("projectId", "materialId", "id"),
  UNIQUE ("projectId", "materialId", "sequence"),
  UNIQUE ("projectId", "materialId", "previousSnapshotId"),
  CONSTRAINT "SourceSnapshot_material_fkey" FOREIGN KEY ("projectId", "materialId")
    REFERENCES contextflow."Material"("projectId", "id") ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT "SourceSnapshot_originalAsset_fkey" FOREIGN KEY ("projectId", "originalAssetId")
    REFERENCES contextflow."Asset"("projectId", "id") ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT "SourceSnapshot_previousSnapshot_fkey" FOREIGN KEY ("projectId", "materialId", "previousSnapshotId")
    REFERENCES contextflow."SourceSnapshot"("projectId", "materialId", "id") ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT "SourceSnapshot_original_filename_pair_check"
    CHECK (("originalAssetId" IS NULL) = ("originalFilename" IS NULL)
      AND ("originalFilename" IS NULL OR (length(btrim("originalFilename")) BETWEEN 1 AND 255 AND "originalFilename" = btrim("originalFilename")))),
  CONSTRAINT "SourceSnapshot_file_origin_check"
    CHECK ("origin" <> 'LOCAL_FILE' OR ("originalAssetId" IS NOT NULL AND "originalFilename" IS NOT NULL)),
  CONSTRAINT "SourceSnapshot_first_or_previous_check"
    CHECK (("sequence" = 1 AND "previousSnapshotId" IS NULL) OR ("sequence" > 1 AND "previousSnapshotId" IS NOT NULL)),
  CONSTRAINT "SourceSnapshot_text_integrity_check"
    CHECK ("bytes" = octet_length("normalizedText")
      AND "sha256" = encode(sha256(convert_to("normalizedText", 'UTF8')), 'hex'))
);

ALTER TABLE contextflow."Material"
  ADD CONSTRAINT "Material_currentSnapshot_fkey" FOREIGN KEY ("projectId", "id", "currentSnapshotId")
    REFERENCES contextflow."SourceSnapshot"("projectId", "materialId", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

CREATE TABLE contextflow."SourceFragment" (
  "id" UUID PRIMARY KEY,
  "projectId" UUID NOT NULL,
  "snapshotId" UUID NOT NULL,
  "ordinal" INTEGER NOT NULL CHECK ("ordinal" > 0),
  "startOffset" INTEGER NOT NULL CHECK ("startOffset" >= 0),
  "endOffset" INTEGER NOT NULL CHECK ("endOffset" > "startOffset" AND "endOffset" <= 400000),
  "sha256" CHAR(64) NOT NULL CHECK ("sha256" ~ '^[a-f0-9]{64}$'),
  UNIQUE ("projectId", "id"),
  UNIQUE ("projectId", "snapshotId", "ordinal"),
  CONSTRAINT "SourceFragment_snapshot_fkey" FOREIGN KEY ("projectId", "snapshotId")
    REFERENCES contextflow."SourceSnapshot"("projectId", "id") ON DELETE RESTRICT ON UPDATE NO ACTION
);

CREATE INDEX "Material_projectId_included_createdAt_id_idx" ON contextflow."Material" ("projectId", "included", "createdAt", "id");
CREATE INDEX "Material_projectId_currentSnapshotId_idx" ON contextflow."Material" ("projectId", "currentSnapshotId");
CREATE INDEX "SourceSnapshot_projectId_materialId_createdAt_id_idx" ON contextflow."SourceSnapshot" ("projectId", "materialId", "createdAt", "id");
CREATE INDEX "SourceSnapshot_projectId_originalAssetId_idx" ON contextflow."SourceSnapshot" ("projectId", "originalAssetId");
CREATE INDEX "SourceFragment_projectId_snapshotId_startOffset_idx" ON contextflow."SourceFragment" ("projectId", "snapshotId", "startOffset");

CREATE FUNCTION contextflow.guard_snapshot_sequence() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE previous_sequence INTEGER;
BEGIN
  IF NEW."sequence" = 1 THEN RETURN NEW; END IF;
  SELECT s."sequence" INTO previous_sequence FROM contextflow."SourceSnapshot" s
    WHERE s."projectId" = NEW."projectId" AND s."materialId" = NEW."materialId" AND s."id" = NEW."previousSnapshotId";
  IF previous_sequence IS NULL OR NEW."sequence" <> previous_sequence + 1 THEN
    RAISE EXCEPTION 'snapshot sequence must immediately follow its previous snapshot' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "SourceSnapshot_sequence_guard" BEFORE INSERT ON contextflow."SourceSnapshot"
  FOR EACH ROW EXECUTE FUNCTION contextflow.guard_snapshot_sequence();

CREATE FUNCTION contextflow.guard_material_revision() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."id" IS DISTINCT FROM OLD."id"
    OR NEW."projectId" IS DISTINCT FROM OLD."projectId"
    OR NEW."createdBy" IS DISTINCT FROM OLD."createdBy"
    OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt" THEN
    RAISE EXCEPTION 'material identity and attribution are immutable' USING ERRCODE = '23514';
  END IF;
  IF ROW(NEW."kind", NEW."purpose", NEW."label", NEW."included", NEW."currentSnapshotId")
      IS DISTINCT FROM ROW(OLD."kind", OLD."purpose", OLD."label", OLD."included", OLD."currentSnapshotId")
    AND NEW."revision" <> OLD."revision" + 1 THEN
    RAISE EXCEPTION 'material edits must advance revision by one' USING ERRCODE = '23514';
  END IF;
  IF NEW."revision" < OLD."revision" OR NEW."updatedAt" < OLD."updatedAt" THEN
    RAISE EXCEPTION 'material revision and update time cannot move backwards' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "Material_revision_guard" BEFORE UPDATE ON contextflow."Material"
  FOR EACH ROW EXECUTE FUNCTION contextflow.guard_material_revision();

CREATE FUNCTION contextflow.guard_immutable_snapshot() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'source snapshots are immutable' USING ERRCODE = '23514';
END $$;
CREATE TRIGGER "SourceSnapshot_immutable_update" BEFORE UPDATE ON contextflow."SourceSnapshot"
  FOR EACH ROW EXECUTE FUNCTION contextflow.guard_immutable_snapshot();
CREATE TRIGGER "SourceFragment_immutable_update" BEFORE UPDATE ON contextflow."SourceFragment"
  FOR EACH ROW EXECUTE FUNCTION contextflow.guard_immutable_snapshot();

CREATE FUNCTION contextflow.guard_referenced_asset_metadata() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM contextflow."SourceSnapshot" s
      WHERE s."projectId" = OLD."projectId" AND s."originalAssetId" = OLD."id")
    AND ROW(NEW."id", NEW."projectId", NEW."bucket", NEW."objectKey", NEW."mediaType", NEW."bytes", NEW."sha256", NEW."purpose", NEW."createdBy", NEW."createdAt")
      IS DISTINCT FROM ROW(OLD."id", OLD."projectId", OLD."bucket", OLD."objectKey", OLD."mediaType", OLD."bytes", OLD."sha256", OLD."purpose", OLD."createdBy", OLD."createdAt") THEN
    RAISE EXCEPTION 'referenced source original asset metadata is immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "Asset_referenced_source_metadata_guard" BEFORE UPDATE ON contextflow."Asset"
  FOR EACH ROW EXECUTE FUNCTION contextflow.guard_referenced_asset_metadata();

REVOKE ALL ON contextflow."Material", contextflow."SourceSnapshot", contextflow."SourceFragment" FROM PUBLIC;
REVOKE ALL ON TYPE contextflow."MaterialKind", contextflow."MaterialPurpose", contextflow."SourceOrigin" FROM PUBLIC;
DO $$
DECLARE provider_role TEXT;
BEGIN
  FOREACH provider_role IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF to_regrole(provider_role) IS NOT NULL THEN
      EXECUTE format('REVOKE ALL ON contextflow."Material", contextflow."SourceSnapshot", contextflow."SourceFragment" FROM %I', provider_role);
      EXECUTE format('REVOKE ALL ON TYPE contextflow."MaterialKind", contextflow."MaterialPurpose", contextflow."SourceOrigin" FROM %I', provider_role);
    END IF;
  END LOOP;
END $$;
GRANT USAGE ON TYPE contextflow."MaterialKind", contextflow."MaterialPurpose", contextflow."SourceOrigin" TO cf_runtime;
GRANT SELECT, INSERT, UPDATE ON contextflow."Material" TO cf_runtime;
GRANT SELECT, INSERT ON contextflow."SourceSnapshot", contextflow."SourceFragment" TO cf_runtime;

COMMIT;
