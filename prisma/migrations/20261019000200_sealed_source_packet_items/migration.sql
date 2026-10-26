BEGIN;

-- Packet membership must agree with its already frozen manifest. Insert-only
-- child rows alone would still permit appending new citations after completion.
CREATE FUNCTION contextflow.guard_source_packet_membership() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,contextflow AS $$
DECLARE frozen jsonb; job_status text; actual contextflow."SourceEvidenceSpan"%ROWTYPE;
BEGIN
  SELECT p."manifestJson"->'passages'->NEW."ordinal",j."status"::text INTO frozen,job_status
  FROM contextflow."SourceEvidencePacket" p
  JOIN contextflow."Job" j ON j."projectId"=p."projectId" AND j."id"=p."jobId"
  WHERE p."projectId"=NEW."projectId" AND p."id"=NEW."packetId";
  IF job_status IS DISTINCT FROM 'RUNNING' OR frozen IS NULL OR jsonb_typeof(frozen)<>'object'
    OR frozen->>'id' IS DISTINCT FROM NEW."spanId"::text
    OR frozen->>'ordinal' IS DISTINCT FROM NEW."ordinal"::text THEN
    RAISE EXCEPTION 'source passage is not a member of the frozen packet manifest' USING ERRCODE='23514';
  END IF;
  SELECT * INTO actual FROM contextflow."SourceEvidenceSpan" s
  WHERE s."projectId"=NEW."projectId" AND s."id"=NEW."spanId";
  IF NOT FOUND OR frozen->>'snapshotId' IS DISTINCT FROM actual."snapshotId"::text
    OR frozen->>'fragmentId' IS DISTINCT FROM actual."fragmentId"::text
    OR frozen->>'startOffset' IS DISTINCT FROM actual."startOffset"::text
    OR frozen->>'endOffset' IS DISTINCT FROM actual."endOffset"::text
    OR frozen->>'sha256' IS DISTINCT FROM actual."sha256"::text THEN
    RAISE EXCEPTION 'source passage differs from its frozen packet entry' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER "SourceEvidencePacketItem_manifest_guard"
BEFORE INSERT ON contextflow."SourceEvidencePacketItem"
FOR EACH ROW EXECUTE FUNCTION contextflow.guard_source_packet_membership();
REVOKE ALL ON FUNCTION contextflow.guard_source_packet_membership() FROM PUBLIC;

CREATE FUNCTION contextflow.guard_source_search_completion() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,contextflow AS $$
DECLARE packet_id uuid; frozen jsonb; actual_count integer;
BEGIN
  IF NEW."operation"::text<>'EVIDENCE_SEARCH' OR NEW."status"::text<>'SUCCEEDED' THEN RETURN NEW; END IF;
  SELECT p."id",p."manifestJson"->'passages' INTO packet_id,frozen
  FROM contextflow."SourceEvidencePacket" p WHERE p."projectId"=NEW."projectId" AND p."jobId"=NEW."id";
  IF NOT FOUND OR jsonb_typeof(frozen) IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'successful evidence search requires a frozen packet' USING ERRCODE='23514';
  END IF;
  SELECT count(*) INTO actual_count FROM contextflow."SourceEvidencePacketItem" i
  WHERE i."projectId"=NEW."projectId" AND i."packetId"=packet_id;
  IF actual_count<>jsonb_array_length(frozen) THEN
    RAISE EXCEPTION 'successful evidence search requires complete packet membership' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER "Job_source_search_completion_guard" BEFORE UPDATE OF "status" ON contextflow."Job"
FOR EACH ROW EXECUTE FUNCTION contextflow.guard_source_search_completion();
REVOKE ALL ON FUNCTION contextflow.guard_source_search_completion() FROM PUBLIC;

-- Existing completed packets must already be complete; do not silently repair
-- any historical membership during an additive integrity upgrade.
DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM contextflow."SourceEvidencePacket" p JOIN contextflow."Job" j
      ON j."projectId"=p."projectId" AND j."id"=p."jobId"
    WHERE jsonb_typeof(p."manifestJson"->'passages') IS DISTINCT FROM 'array'
      OR (j."status"::text='SUCCEEDED' AND jsonb_array_length(p."manifestJson"->'passages')<>
        (SELECT count(*) FROM contextflow."SourceEvidencePacketItem" i WHERE i."projectId"=p."projectId" AND i."packetId"=p."id"))
      OR EXISTS (SELECT 1 FROM contextflow."SourceEvidencePacketItem" i
        JOIN contextflow."SourceEvidenceSpan" s ON s."projectId"=i."projectId" AND s."id"=i."spanId"
        WHERE i."projectId"=p."projectId" AND i."packetId"=p."id" AND (
          p."manifestJson"->'passages'->i."ordinal"->>'id' IS DISTINCT FROM s."id"::text
          OR p."manifestJson"->'passages'->i."ordinal"->>'snapshotId' IS DISTINCT FROM s."snapshotId"::text
          OR p."manifestJson"->'passages'->i."ordinal"->>'fragmentId' IS DISTINCT FROM s."fragmentId"::text
          OR p."manifestJson"->'passages'->i."ordinal"->>'startOffset' IS DISTINCT FROM s."startOffset"::text
          OR p."manifestJson"->'passages'->i."ordinal"->>'endOffset' IS DISTINCT FROM s."endOffset"::text
          OR p."manifestJson"->'passages'->i."ordinal"->>'sha256' IS DISTINCT FROM s."sha256"::text
        ))
  ) THEN RAISE EXCEPTION 'existing source packet membership needs investigation before sealing'; END IF;
END $$;

COMMIT;
