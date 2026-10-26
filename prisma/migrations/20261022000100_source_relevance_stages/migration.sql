BEGIN;

-- A v2 search has two durable stages. The parent may finish after freezing a
-- child relevance job; only that RUNNING child may then add the parent's one
-- final packet. Legacy search contracts keep their original lifecycle.
CREATE OR REPLACE FUNCTION contextflow.guard_source_evidence_packet() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,contextflow AS $$
DECLARE parent_job contextflow."Job"%ROWTYPE; child_job contextflow."Job"%ROWTYPE;
        child_manifest jsonb; frozen jsonb;
BEGIN
  SELECT * INTO parent_job FROM contextflow."Job" j
  WHERE j."projectId"=NEW."projectId" AND j."id"=NEW."jobId" AND j."operation"::text='EVIDENCE_SEARCH';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'evidence packet requires an evidence search job' USING ERRCODE='23514';
  END IF;
  IF parent_job."contractVersion"='evidence-relevance-v1' THEN
    RAISE EXCEPTION 'relevance child packets must be owned by their parent search' USING ERRCODE='23514';
  END IF;
  IF parent_job."contractVersion" IS DISTINCT FROM 'evidence-search-v2' THEN RETURN NEW; END IF;

  frozen:=parent_job."inputManifest";
  IF frozen->>'schemaVersion' IS DISTINCT FROM 'evidence-search-job-v2'
    OR frozen->'retrievalPolicy'->>'version' IS DISTINCT FROM 'hybrid-source-v4'
    OR frozen->'retrievalPolicy'->>'rankConstant' IS DISTINCT FROM '60'
    OR frozen->'retrievalPolicy'->>'byteBudget' IS DISTINCT FROM '30000'
    OR frozen->'retrievalPolicy'->>'maxPassages' IS DISTINCT FROM '20'
    OR frozen->'retrievalPolicy'->>'adjacentContextChunks' IS DISTINCT FROM '1'
    OR frozen->'release'->>'releaseId' IS DISTINCT FROM 'source-embedding-2026-10-20.1'
    OR frozen->'relevanceRelease'->>'releaseId' IS DISTINCT FROM 'source-relevance-2026-10-22.1'
    OR frozen->'relevanceRelease'->>'configDigest' IS DISTINCT FROM '239be78994f5b3d2b1e5cfdf119a4b91d6de943d12aebe0c52594fcc55457c9b'
    OR NEW."query" IS DISTINCT FROM frozen->>'query'
    OR NEW."manifestJson"->>'searchJobId' IS DISTINCT FROM NEW."jobId"::text
    OR NEW."manifestJson"->>'selectionMode' IS DISTINCT FROM 'relevance-v1'
    OR NEW."manifestJson"->>'relevanceReleaseId' IS DISTINCT FROM frozen->'relevanceRelease'->>'releaseId'
    OR NEW."manifestJson"->>'relevanceConfigDigest' IS DISTINCT FROM frozen->'relevanceRelease'->>'configDigest'
    OR NEW."manifestJson"->>'configDigest' IS DISTINCT FROM frozen->'indexes'->0->>'configDigest'
    OR NEW."manifestJson"->>'schemaVersion' IS DISTINCT FROM 'source-evidence-packet-v1'
    OR NEW."manifestJson"->'retrievalPolicy' IS DISTINCT FROM frozen->'retrievalPolicy'
    OR NEW."manifestJson"->'snapshots' IS DISTINCT FROM frozen->'snapshots'
    OR NEW."manifestJson"->'indexIds' IS DISTINCT FROM (SELECT coalesce(jsonb_agg(i->>'indexId' ORDER BY ord), '[]'::jsonb)
       FROM jsonb_array_elements(frozen->'indexes') WITH ORDINALITY AS x(i,ord)) THEN
    RAISE EXCEPTION 'v2 evidence packet differs from its frozen search release and scope' USING ERRCODE='23514';
  END IF;

  IF parent_job."status"::text='RUNNING' THEN
    IF NEW."manifestJson"->'relevanceJobId' IS DISTINCT FROM 'null'::jsonb
      OR NEW."manifestJson"->>'candidateCount' IS DISTINCT FROM '0'
      OR NEW."manifestJson"->>'usefulCandidateCount' IS DISTINCT FROM '0'
      OR jsonb_typeof(NEW."manifestJson"->'passages') IS DISTINCT FROM 'array'
      OR jsonb_array_length(NEW."manifestJson"->'passages')<>0
      OR NEW."manifestJson"->'relevanceRequestHash' IS DISTINCT FROM 'null'::jsonb
      OR NEW."manifestJson"->>'candidateIdentityHash' IS DISTINCT FROM '4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945' THEN
      RAISE EXCEPTION 'only an empty no-candidate packet may be inserted while a v2 search is running' USING ERRCODE='23514';
    END IF;
    RETURN NEW;
  END IF;

  IF parent_job."status"::text IS DISTINCT FROM 'SUCCEEDED'
    OR jsonb_typeof(parent_job."resultRefs") IS DISTINCT FROM 'object'
    OR parent_job."resultRefs"->>'relevanceJobId' IS NULL THEN
    RAISE EXCEPTION 'v2 evidence packet requires a running linked relevance job' USING ERRCODE='23514';
  END IF;
  SELECT * INTO child_job FROM contextflow."Job" c
  WHERE c."projectId"=parent_job."projectId" AND c."id"::text=parent_job."resultRefs"->>'relevanceJobId';
  IF NOT FOUND THEN RAISE EXCEPTION 'linked relevance job is missing' USING ERRCODE='23514'; END IF;
  child_manifest:=child_job."inputManifest";
  IF child_job."operation"::text IS DISTINCT FROM 'EVIDENCE_SEARCH'
    OR child_job."contractVersion" IS DISTINCT FROM 'evidence-relevance-v1'
    OR child_job."status"::text IS DISTINCT FROM 'RUNNING'
    OR child_job."requestedBy" IS DISTINCT FROM parent_job."requestedBy"
    OR child_job."commandKey" IS DISTINCT FROM 'relevance-'||parent_job."id"::text
    OR child_manifest->>'schemaVersion' IS DISTINCT FROM 'evidence-relevance-job-v1'
    OR child_manifest->>'commandKey' IS DISTINCT FROM child_job."commandKey"
    OR child_manifest->>'parentJobId' IS DISTINCT FROM parent_job."id"::text
    OR child_manifest->>'parentInputHash' IS DISTINCT FROM parent_job."inputHash"
    OR child_manifest->>'query' IS DISTINCT FROM frozen->>'query'
    OR child_manifest->'snapshots' IS DISTINCT FROM frozen->'snapshots'
    OR child_manifest->'indexes' IS DISTINCT FROM frozen->'indexes'
    OR child_manifest->'retrievalPolicy' IS DISTINCT FROM frozen->'retrievalPolicy'
    OR child_manifest->'embeddingRelease' IS DISTINCT FROM frozen->'release'
    OR child_manifest->'release' IS DISTINCT FROM frozen->'relevanceRelease'
    OR child_manifest->'request'->>'query' IS DISTINCT FROM child_manifest->>'query'
    OR child_manifest->>'noticeVersion' IS DISTINCT FROM frozen->>'noticeVersion'
    OR child_manifest->>'acceptedAt' IS DISTINCT FROM frozen->>'acceptedAt'
    OR NEW."manifestJson"->>'relevanceJobId' IS DISTINCT FROM child_job."id"::text
    OR NEW."manifestJson"->>'relevanceRequestId' IS DISTINCT FROM child_manifest->'request'->>'requestId'
    OR NEW."manifestJson"->>'candidateCount' IS DISTINCT FROM child_manifest->>'candidateCount'
    OR NEW."manifestJson"->>'configDigest' IS DISTINCT FROM child_manifest->'indexes'->0->>'configDigest'
    OR (child_manifest->>'hasMore'='true' AND NEW."manifestJson"->>'hasMore' IS DISTINCT FROM 'true')
    OR coalesce(NEW."manifestJson"->>'relevanceRequestHash','') !~ '^[a-f0-9]{64}$'
    OR coalesce(NEW."manifestJson"->>'candidateIdentityHash','') !~ '^[a-f0-9]{64}$' THEN
    RAISE EXCEPTION 'v2 evidence packet does not match its frozen running relevance job' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION contextflow.guard_source_packet_membership() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,contextflow AS $$
DECLARE frozen jsonb; packet_manifest jsonb; job_status text; owner_job contextflow."Job"%ROWTYPE;
        child_job contextflow."Job"%ROWTYPE; child_manifest jsonb; actual contextflow."SourceEvidenceSpan"%ROWTYPE;
BEGIN
  SELECT p."manifestJson",p."manifestJson"->'passages'->NEW."ordinal",j."status"::text
    INTO packet_manifest,frozen,job_status
  FROM contextflow."SourceEvidencePacket" p
  JOIN contextflow."Job" j ON j."projectId"=p."projectId" AND j."id"=p."jobId"
  WHERE p."projectId"=NEW."projectId" AND p."id"=NEW."packetId";
  IF NOT FOUND THEN RAISE EXCEPTION 'source packet owner is missing' USING ERRCODE='23514'; END IF;
  SELECT * INTO owner_job FROM contextflow."Job" j
  WHERE j."projectId"=NEW."projectId" AND j."id"=(SELECT p."jobId" FROM contextflow."SourceEvidencePacket" p WHERE p."projectId"=NEW."projectId" AND p."id"=NEW."packetId");

  IF owner_job."contractVersion"='evidence-search-v2' AND job_status='SUCCEEDED' THEN
    IF packet_manifest->>'searchJobId' IS DISTINCT FROM owner_job."id"::text
      OR packet_manifest->>'relevanceJobId' IS NULL
      OR owner_job."resultRefs"->>'relevanceJobId' IS DISTINCT FROM packet_manifest->>'relevanceJobId' THEN
      RAISE EXCEPTION 'v2 packet membership requires its exact linked relevance job' USING ERRCODE='23514';
    END IF;
    SELECT * INTO child_job FROM contextflow."Job" c
    WHERE c."projectId"=owner_job."projectId" AND c."id"::text=packet_manifest->>'relevanceJobId';
    IF NOT FOUND THEN RAISE EXCEPTION 'packet relevance job is missing' USING ERRCODE='23514'; END IF;
    child_manifest:=child_job."inputManifest";
    IF child_job."operation"::text IS DISTINCT FROM 'EVIDENCE_SEARCH'
      OR child_job."contractVersion" IS DISTINCT FROM 'evidence-relevance-v1'
      OR child_job."status"::text IS DISTINCT FROM 'RUNNING'
      OR child_job."requestedBy" IS DISTINCT FROM owner_job."requestedBy"
      OR child_job."commandKey" IS DISTINCT FROM 'relevance-'||owner_job."id"::text
      OR child_manifest->>'parentJobId' IS DISTINCT FROM owner_job."id"::text
      OR child_manifest->>'parentInputHash' IS DISTINCT FROM owner_job."inputHash"
      OR packet_manifest->>'relevanceRequestId' IS DISTINCT FROM child_manifest->'request'->>'requestId'
      OR packet_manifest->>'relevanceReleaseId' IS DISTINCT FROM child_manifest->'release'->>'releaseId'
      OR packet_manifest->>'relevanceConfigDigest' IS DISTINCT FROM child_manifest->'release'->>'configDigest'
      OR packet_manifest->'retrievalPolicy' IS DISTINCT FROM child_manifest->'retrievalPolicy'
      OR packet_manifest->'snapshots' IS DISTINCT FROM child_manifest->'snapshots'
      OR packet_manifest->>'configDigest' IS DISTINCT FROM child_manifest->'indexes'->0->>'configDigest'
      OR coalesce(packet_manifest->>'relevanceRequestHash','') !~ '^[a-f0-9]{64}$'
      OR coalesce(packet_manifest->>'candidateIdentityHash','') !~ '^[a-f0-9]{64}$'
      OR (child_manifest->>'hasMore'='true' AND packet_manifest->>'hasMore' IS DISTINCT FROM 'true') THEN
      RAISE EXCEPTION 'v2 packet membership is outside its frozen relevance lineage' USING ERRCODE='23514';
    END IF;
  ELSIF job_status IS DISTINCT FROM 'RUNNING' THEN
    RAISE EXCEPTION 'source passage membership can only be inserted while its producing job is running' USING ERRCODE='23514';
  END IF;

  IF frozen IS NULL OR jsonb_typeof(frozen)<>'object'
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

CREATE OR REPLACE FUNCTION contextflow.guard_source_search_completion() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,contextflow AS $$
DECLARE packet_id uuid; frozen jsonb; packet_manifest jsonb; actual_count integer;
        parent_job contextflow."Job"%ROWTYPE; parent_manifest jsonb; child_manifest jsonb;
BEGIN
  IF NEW."status"::text<>'SUCCEEDED' THEN RETURN NEW; END IF;
  IF NEW."operation"::text<>'EVIDENCE_SEARCH' THEN RETURN NEW; END IF;

  IF NEW."contractVersion"='evidence-search-v2' THEN
    parent_manifest:=NEW."inputManifest";
    IF parent_manifest->>'schemaVersion' IS DISTINCT FROM 'evidence-search-job-v2'
      OR parent_manifest->'retrievalPolicy'->>'version' IS DISTINCT FROM 'hybrid-source-v4'
      OR parent_manifest->'retrievalPolicy'->>'rankConstant' IS DISTINCT FROM '60'
      OR parent_manifest->'retrievalPolicy'->>'byteBudget' IS DISTINCT FROM '30000'
      OR parent_manifest->'retrievalPolicy'->>'maxPassages' IS DISTINCT FROM '20'
      OR parent_manifest->'retrievalPolicy'->>'adjacentContextChunks' IS DISTINCT FROM '1'
      OR parent_manifest->'release'->>'releaseId' IS DISTINCT FROM 'source-embedding-2026-10-20.1'
      OR parent_manifest->'relevanceRelease'->>'releaseId' IS DISTINCT FROM 'source-relevance-2026-10-22.1'
      OR parent_manifest->'relevanceRelease'->>'configDigest' IS DISTINCT FROM '239be78994f5b3d2b1e5cfdf119a4b91d6de943d12aebe0c52594fcc55457c9b' THEN
      RAISE EXCEPTION 'successful v2 search must preserve its pinned retrieval and provider releases' USING ERRCODE='23514';
    END IF;
    IF NEW."resultRefs"->>'relevanceJobId' IS NOT NULL THEN
      SELECT * INTO parent_job FROM contextflow."Job" c
      WHERE c."projectId"=NEW."projectId" AND c."id"::text=NEW."resultRefs"->>'relevanceJobId';
      IF NOT FOUND OR parent_job."operation"::text IS DISTINCT FROM 'EVIDENCE_SEARCH'
        OR parent_job."contractVersion" IS DISTINCT FROM 'evidence-relevance-v1'
        OR parent_job."status"::text NOT IN ('QUEUED','RETRY_WAIT','RUNNING','OUTCOME_UNKNOWN')
        OR parent_job."requestedBy" IS DISTINCT FROM NEW."requestedBy"
        OR parent_job."commandKey" IS DISTINCT FROM 'relevance-'||NEW."id"::text
        OR parent_job."inputManifest"->>'schemaVersion' IS DISTINCT FROM 'evidence-relevance-job-v1'
        OR parent_job."inputManifest"->>'commandKey' IS DISTINCT FROM parent_job."commandKey"
        OR parent_job."inputManifest"->>'parentJobId' IS DISTINCT FROM NEW."id"::text
        OR parent_job."inputManifest"->>'parentInputHash' IS DISTINCT FROM NEW."inputHash"
        OR parent_job."inputManifest"->>'query' IS DISTINCT FROM parent_manifest->>'query'
        OR parent_job."inputManifest"->'snapshots' IS DISTINCT FROM parent_manifest->'snapshots'
        OR parent_job."inputManifest"->'indexes' IS DISTINCT FROM parent_manifest->'indexes'
        OR parent_job."inputManifest"->'retrievalPolicy' IS DISTINCT FROM parent_manifest->'retrievalPolicy'
        OR parent_job."inputManifest"->'embeddingRelease' IS DISTINCT FROM parent_manifest->'release'
        OR parent_job."inputManifest"->'release' IS DISTINCT FROM parent_manifest->'relevanceRelease'
        OR parent_job."inputManifest"->>'noticeVersion' IS DISTINCT FROM parent_manifest->>'noticeVersion'
        OR parent_job."inputManifest"->>'acceptedAt' IS DISTINCT FROM parent_manifest->>'acceptedAt'
        OR NEW."resultRefs"->>'candidateCount' IS DISTINCT FROM parent_job."inputManifest"->>'candidateCount'
        OR NEW."resultRefs"->>'hasMore' IS DISTINCT FROM parent_job."inputManifest"->>'hasMore' THEN
        RAISE EXCEPTION 'successful v2 search requires its exact frozen relevance child' USING ERRCODE='23514';
      END IF;
      IF EXISTS (SELECT 1 FROM contextflow."SourceEvidencePacket" p WHERE p."projectId"=NEW."projectId" AND p."jobId"=NEW."id") THEN
        RAISE EXCEPTION 'v2 search with relevance candidates cannot own a packet' USING ERRCODE='23514';
      END IF;
      RETURN NEW;
    END IF;
    -- No child means the bounded candidate set was empty. This path seals an
    -- explicit empty packet and still requires complete packet membership.
  ELSIF NEW."contractVersion"='evidence-relevance-v1' THEN
    child_manifest:=NEW."inputManifest";
    SELECT * INTO parent_job FROM contextflow."Job" p
    WHERE p."projectId"=NEW."projectId" AND p."id"::text=child_manifest->>'parentJobId';
    IF NOT FOUND OR parent_job."operation"::text IS DISTINCT FROM 'EVIDENCE_SEARCH'
      OR parent_job."contractVersion" IS DISTINCT FROM 'evidence-search-v2'
      OR parent_job."status"::text IS DISTINCT FROM 'SUCCEEDED'
      OR parent_job."requestedBy" IS DISTINCT FROM NEW."requestedBy"
      OR parent_job."inputHash" IS DISTINCT FROM child_manifest->>'parentInputHash'
      OR parent_job."resultRefs"->>'relevanceJobId' IS DISTINCT FROM NEW."id"::text
      OR NEW."commandKey" IS DISTINCT FROM 'relevance-'||parent_job."id"::text
      OR child_manifest->>'schemaVersion' IS DISTINCT FROM 'evidence-relevance-job-v1'
      OR child_manifest->>'commandKey' IS DISTINCT FROM NEW."commandKey"
      OR child_manifest->'release'->>'releaseId' IS DISTINCT FROM 'source-relevance-2026-10-22.1'
      OR child_manifest->'release'->>'configDigest' IS DISTINCT FROM '239be78994f5b3d2b1e5cfdf119a4b91d6de943d12aebe0c52594fcc55457c9b'
      OR child_manifest->'embeddingRelease'->>'releaseId' IS DISTINCT FROM 'source-embedding-2026-10-20.1'
      OR child_manifest->'retrievalPolicy'->>'version' IS DISTINCT FROM 'hybrid-source-v4'
      OR child_manifest->>'candidateCount' IS NULL THEN
      RAISE EXCEPTION 'successful relevance job requires its exact succeeded v2 parent' USING ERRCODE='23514';
    END IF;
    SELECT p."id",p."manifestJson",p."manifestJson"->'passages' INTO packet_id,packet_manifest,frozen
    FROM contextflow."SourceEvidencePacket" p WHERE p."projectId"=NEW."projectId" AND p."jobId"=parent_job."id";
    IF NOT FOUND OR packet_manifest->>'relevanceJobId' IS DISTINCT FROM NEW."id"::text
      OR packet_manifest->>'searchJobId' IS DISTINCT FROM parent_job."id"::text
      OR packet_manifest->>'relevanceRequestId' IS DISTINCT FROM child_manifest->'request'->>'requestId'
      OR packet_manifest->>'relevanceReleaseId' IS DISTINCT FROM child_manifest->'release'->>'releaseId'
      OR packet_manifest->>'relevanceConfigDigest' IS DISTINCT FROM child_manifest->'release'->>'configDigest'
      OR coalesce(packet_manifest->>'relevanceRequestHash','') !~ '^[a-f0-9]{64}$'
      OR coalesce(packet_manifest->>'candidateIdentityHash','') !~ '^[a-f0-9]{64}$'
      OR (child_manifest->>'hasMore'='true' AND packet_manifest->>'hasMore' IS DISTINCT FROM 'true')
      OR packet_manifest->>'candidateCount' IS DISTINCT FROM child_manifest->>'candidateCount'
      OR packet_manifest->>'configDigest' IS DISTINCT FROM child_manifest->'indexes'->0->>'configDigest'
      OR packet_manifest->'retrievalPolicy' IS DISTINCT FROM child_manifest->'retrievalPolicy'
      OR packet_manifest->'snapshots' IS DISTINCT FROM child_manifest->'snapshots'
      OR NEW."resultRefs"->>'packetId' IS DISTINCT FROM packet_id::text
      OR NEW."resultRefs"->>'parentJobId' IS DISTINCT FROM parent_job."id"::text
      OR NEW."resultRefs"->>'packetHash' IS DISTINCT FROM (SELECT p."sha256" FROM contextflow."SourceEvidencePacket" p WHERE p."id"=packet_id)
      OR jsonb_typeof(frozen) IS DISTINCT FROM 'array' THEN
      RAISE EXCEPTION 'successful relevance job requires the complete parent-owned final packet' USING ERRCODE='23514';
    END IF;
    IF EXISTS (
      SELECT 1 FROM jsonb_array_elements(frozen) AS passages(value)
      WHERE NOT EXISTS (
        SELECT 1 FROM jsonb_array_elements(child_manifest->'request'->'candidates') AS candidates(value)
        WHERE candidates.value->>'id' IS NOT DISTINCT FROM passages.value->>'relevanceId'
          AND candidates.value->>'snapshotId' IS NOT DISTINCT FROM passages.value->>'snapshotId'
          AND candidates.value->>'fragmentId' IS NOT DISTINCT FROM passages.value->>'fragmentId'
          AND candidates.value->>'startOffset' IS NOT DISTINCT FROM passages.value->>'startOffset'
          AND candidates.value->>'endOffset' IS NOT DISTINCT FROM passages.value->>'endOffset'
          AND candidates.value->>'sha256' IS NOT DISTINCT FROM passages.value->>'sha256'
      )
    ) THEN
      RAISE EXCEPTION 'final packet contains a passage outside the frozen relevance candidates' USING ERRCODE='23514';
    END IF;
    SELECT count(*) INTO actual_count FROM contextflow."SourceEvidencePacketItem" i
    WHERE i."projectId"=NEW."projectId" AND i."packetId"=packet_id;
    IF actual_count<>jsonb_array_length(frozen) THEN
      RAISE EXCEPTION 'successful relevance job requires complete packet membership' USING ERRCODE='23514';
    END IF;
    RETURN NEW;
  END IF;

  SELECT p."id",p."manifestJson",p."manifestJson"->'passages' INTO packet_id,packet_manifest,frozen
  FROM contextflow."SourceEvidencePacket" p WHERE p."projectId"=NEW."projectId" AND p."jobId"=NEW."id";
  IF NOT FOUND OR jsonb_typeof(frozen) IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'successful evidence search requires a frozen packet' USING ERRCODE='23514';
  END IF;
  IF NEW."contractVersion"='evidence-search-v2'
    AND (packet_manifest->>'selectionMode' IS DISTINCT FROM 'relevance-v1'
      OR packet_manifest->'relevanceJobId' IS DISTINCT FROM 'null'::jsonb
      OR packet_manifest->>'candidateCount' IS DISTINCT FROM '0'
      OR jsonb_array_length(frozen)<>0) THEN
    RAISE EXCEPTION 'v2 search without a relevance child must complete only with its empty packet' USING ERRCODE='23514';
  END IF;
  SELECT count(*) INTO actual_count FROM contextflow."SourceEvidencePacketItem" i
  WHERE i."projectId"=NEW."projectId" AND i."packetId"=packet_id;
  IF actual_count<>jsonb_array_length(frozen) THEN
    RAISE EXCEPTION 'successful evidence search requires complete packet membership' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;

-- Sealing a writing evidence set is permitted only after the relevance child
-- and its parent-owned packet are both complete. Empty v2 searches remain a
-- separate valid case and seal only their explicit empty packet.
CREATE OR REPLACE FUNCTION contextflow.guard_source_evidence_set_packet() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,contextflow AS $$
DECLARE source_set contextflow."SourceEvidenceSet"%ROWTYPE; packet contextflow."SourceEvidencePacket"%ROWTYPE;
        root_job contextflow."Job"%ROWTYPE; child_job contextflow."Job"%ROWTYPE;
BEGIN
  IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'source evidence set packet membership is immutable' USING ERRCODE='23514'; END IF;
  SELECT * INTO source_set FROM contextflow."SourceEvidenceSet" s
  WHERE s."projectId"=NEW."projectId" AND s."id"=NEW."setId" FOR UPDATE;
  SELECT * INTO packet FROM contextflow."SourceEvidencePacket" p
  WHERE p."projectId"=NEW."projectId" AND p."id"=NEW."packetId";
  SELECT * INTO root_job FROM contextflow."Job" j
  WHERE j."projectId"=packet."projectId" AND j."id"=packet."jobId";
  IF source_set."id" IS NULL OR source_set."sealed" OR packet."id" IS NULL
    OR packet."sha256" IS DISTINCT FROM NEW."packetHash"
    OR root_job."status"::text IS DISTINCT FROM 'SUCCEEDED'
    OR root_job."operation"::text IS DISTINCT FROM 'EVIDENCE_SEARCH'
    OR NEW."ordinal"<0
    OR source_set."manifestJson"->'packets'->NEW."ordinal"->>'packetId' IS DISTINCT FROM NEW."packetId"::text
    OR source_set."manifestJson"->'packets'->NEW."ordinal"->>'sha256' IS DISTINCT FROM NEW."packetHash"::text THEN
    RAISE EXCEPTION 'set packet must match an unsealed set manifest and completed evidence search' USING ERRCODE='23514';
  END IF;
  IF root_job."contractVersion"='evidence-search-v2' THEN
    IF packet."manifestJson"->>'searchJobId' IS DISTINCT FROM root_job."id"::text
      OR packet."manifestJson"->>'selectionMode' IS DISTINCT FROM 'relevance-v1' THEN
      RAISE EXCEPTION 'v2 evidence set packet must reference its completed root packet' USING ERRCODE='23514';
    END IF;
    IF packet."manifestJson"->'relevanceJobId' IS NULL OR packet."manifestJson"->'relevanceJobId'='null'::jsonb THEN
      IF root_job."resultRefs"->>'relevanceJobId' IS NOT NULL
        OR root_job."resultRefs"->>'packetId' IS DISTINCT FROM packet."id"::text
        OR root_job."resultRefs"->>'packetHash' IS DISTINCT FROM packet."sha256"::text
        OR packet."manifestJson"->>'candidateCount' IS DISTINCT FROM '0'
        OR jsonb_array_length(packet."manifestJson"->'passages')<>0 THEN
        RAISE EXCEPTION 'empty v2 evidence sets require an explicit no-candidate packet' USING ERRCODE='23514';
      END IF;
    ELSE
      SELECT * INTO child_job FROM contextflow."Job" c
      WHERE c."projectId"=root_job."projectId" AND c."id"::text=packet."manifestJson"->>'relevanceJobId';
      IF NOT FOUND OR child_job."status"::text IS DISTINCT FROM 'SUCCEEDED'
        OR child_job."contractVersion" IS DISTINCT FROM 'evidence-relevance-v1'
        OR child_job."operation"::text IS DISTINCT FROM 'EVIDENCE_SEARCH'
        OR child_job."requestedBy" IS DISTINCT FROM root_job."requestedBy"
        OR child_job."commandKey" IS DISTINCT FROM 'relevance-'||root_job."id"::text
        OR child_job."inputManifest"->>'parentJobId' IS DISTINCT FROM root_job."id"::text
        OR child_job."inputManifest"->>'parentInputHash' IS DISTINCT FROM root_job."inputHash"
        OR root_job."resultRefs"->>'relevanceJobId' IS DISTINCT FROM child_job."id"::text
        OR child_job."resultRefs"->>'packetId' IS DISTINCT FROM packet."id"::text
        OR child_job."resultRefs"->>'parentJobId' IS DISTINCT FROM root_job."id"::text
        OR child_job."resultRefs"->>'packetHash' IS DISTINCT FROM packet."sha256"::text
        OR packet."manifestJson"->>'relevanceJobId' IS DISTINCT FROM child_job."id"::text THEN
        RAISE EXCEPTION 'v2 evidence set requires the exact completed relevance child and parent packet' USING ERRCODE='23514';
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END $$;

REVOKE ALL ON FUNCTION contextflow.guard_source_evidence_packet(),contextflow.guard_source_packet_membership(),contextflow.guard_source_search_completion() FROM PUBLIC;
REVOKE ALL ON FUNCTION contextflow.guard_source_evidence_set_packet() FROM PUBLIC;

COMMIT;
