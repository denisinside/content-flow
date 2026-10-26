BEGIN;

ALTER TYPE contextflow."JobOperation" ADD VALUE 'SOURCE_WRITING';

CREATE TABLE contextflow."SourceEvidenceSet" (
  "id" uuid NOT NULL,
  "projectId" uuid NOT NULL,
  "briefRevisionId" uuid NOT NULL,
  "manifestJson" jsonb NOT NULL,
  "sha256" char(64) NOT NULL CHECK ("sha256" ~ '^[a-f0-9]{64}$'),
  "createdBy" uuid NOT NULL,
  "createdAt" timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "sealed" boolean NOT NULL DEFAULT false,
  CONSTRAINT "SourceEvidenceSet_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "SourceEvidenceSet_project_id_key" UNIQUE ("projectId","id"),
  CONSTRAINT "SourceEvidenceSet_project_fkey" FOREIGN KEY ("projectId") REFERENCES contextflow."Project"("id") ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT "SourceEvidenceSet_brief_fkey" FOREIGN KEY ("projectId","briefRevisionId") REFERENCES contextflow."BriefRevision"("projectId","id") ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT "SourceEvidenceSet_creator_fkey" FOREIGN KEY ("createdBy") REFERENCES contextflow."UserProfile"("id") ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT "SourceEvidenceSet_manifest_check" CHECK (jsonb_typeof("manifestJson")='object' AND jsonb_typeof("manifestJson"->'packets')='array' AND jsonb_array_length("manifestJson"->'packets') BETWEEN 1 AND 500)
);
CREATE INDEX "SourceEvidenceSet_projectId_briefRevisionId_createdAt_idx" ON contextflow."SourceEvidenceSet"("projectId","briefRevisionId","createdAt");

CREATE TABLE contextflow."SourceEvidenceSetPacket" (
  "projectId" uuid NOT NULL,
  "setId" uuid NOT NULL,
  "packetId" uuid NOT NULL,
  "packetHash" char(64) NOT NULL CHECK ("packetHash" ~ '^[a-f0-9]{64}$'),
  "ordinal" integer NOT NULL CHECK ("ordinal">=0),
  CONSTRAINT "SourceEvidenceSetPacket_pkey" PRIMARY KEY ("projectId","setId","packetId"),
  CONSTRAINT "SourceEvidenceSetPacket_project_set_ordinal_key" UNIQUE ("projectId","setId","ordinal"),
  CONSTRAINT "SourceEvidenceSetPacket_set_hash_key" UNIQUE ("projectId","setId","packetId","packetHash"),
  CONSTRAINT "SourceEvidenceSetPacket_set_fkey" FOREIGN KEY ("projectId","setId") REFERENCES contextflow."SourceEvidenceSet"("projectId","id") ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT "SourceEvidenceSetPacket_packet_fkey" FOREIGN KEY ("projectId","packetId") REFERENCES contextflow."SourceEvidencePacket"("projectId","id") ON DELETE RESTRICT ON UPDATE NO ACTION
);

ALTER TABLE contextflow."OutlineRevision"
  ADD COLUMN "sourceEvidenceSetId" uuid,
  ADD COLUMN "sourceEvidenceSealed" boolean NOT NULL DEFAULT false;
ALTER TABLE contextflow."ArticleDraft" ADD COLUMN "sourceEvidenceSetId" uuid;
ALTER TABLE contextflow."ArticleVersion"
  ADD COLUMN "sourceEvidenceSetId" uuid,
  ADD COLUMN "sourceEvidenceSealed" boolean NOT NULL DEFAULT false,
  ADD COLUMN "reviewedSourceEvidenceSetId" uuid;
ALTER TABLE contextflow."AdaptationDraft" ADD COLUMN "sourceEvidenceSetId" uuid;
ALTER TABLE contextflow."AdaptationRevision"
  ADD COLUMN "sourceEvidenceSetId" uuid,
  ADD COLUMN "sourceEvidenceSealed" boolean NOT NULL DEFAULT false,
  ADD COLUMN "reviewedSourceEvidenceSetId" uuid;
ALTER TABLE contextflow."ScriptRevision" ADD COLUMN "sourceEvidenceSealed" boolean NOT NULL DEFAULT false;

ALTER TABLE contextflow."OutlineRevision" ADD CONSTRAINT "OutlineRevision_sourceEvidenceSet_fkey" FOREIGN KEY ("projectId","sourceEvidenceSetId") REFERENCES contextflow."SourceEvidenceSet"("projectId","id") ON DELETE RESTRICT ON UPDATE NO ACTION;
ALTER TABLE contextflow."ArticleDraft" ADD CONSTRAINT "ArticleDraft_sourceEvidenceSet_fkey" FOREIGN KEY ("projectId","sourceEvidenceSetId") REFERENCES contextflow."SourceEvidenceSet"("projectId","id") ON DELETE RESTRICT ON UPDATE NO ACTION;
ALTER TABLE contextflow."ArticleVersion"
  ADD CONSTRAINT "ArticleVersion_sourceEvidenceSet_fkey" FOREIGN KEY ("projectId","sourceEvidenceSetId") REFERENCES contextflow."SourceEvidenceSet"("projectId","id") ON DELETE RESTRICT ON UPDATE NO ACTION,
  ADD CONSTRAINT "ArticleVersion_reviewedSourceEvidenceSet_fkey" FOREIGN KEY ("projectId","reviewedSourceEvidenceSetId") REFERENCES contextflow."SourceEvidenceSet"("projectId","id") ON DELETE RESTRICT ON UPDATE NO ACTION;
ALTER TABLE contextflow."AdaptationDraft" ADD CONSTRAINT "AdaptationDraft_sourceEvidenceSet_fkey" FOREIGN KEY ("projectId","sourceEvidenceSetId") REFERENCES contextflow."SourceEvidenceSet"("projectId","id") ON DELETE RESTRICT ON UPDATE NO ACTION;
ALTER TABLE contextflow."AdaptationRevision"
  ADD CONSTRAINT "AdaptationRevision_sourceEvidenceSet_fkey" FOREIGN KEY ("projectId","sourceEvidenceSetId") REFERENCES contextflow."SourceEvidenceSet"("projectId","id") ON DELETE RESTRICT ON UPDATE NO ACTION,
  ADD CONSTRAINT "AdaptationRevision_reviewedSourceEvidenceSet_fkey" FOREIGN KEY ("projectId","reviewedSourceEvidenceSetId") REFERENCES contextflow."SourceEvidenceSet"("projectId","id") ON DELETE RESTRICT ON UPDATE NO ACTION;

CREATE TABLE contextflow."OutlineRevisionSourceCitation" (
 "projectId" uuid NOT NULL, "revisionId" uuid NOT NULL, "sourceEvidenceSetId" uuid NOT NULL,
 "packetId" uuid NOT NULL, "spanId" uuid NOT NULL, "sectionIndex" integer NOT NULL CHECK ("sectionIndex">=0),
 "locator" varchar(240) NOT NULL CHECK (length(btrim("locator")) BETWEEN 1 AND 240), "text" text NOT NULL, "quote" text NOT NULL,
 CONSTRAINT "OutlineRevisionSourceCitation_pkey" PRIMARY KEY ("revisionId","sectionIndex","packetId","spanId"),
 CONSTRAINT "OutlineRevisionSourceCitation_revision_fkey" FOREIGN KEY ("projectId","revisionId") REFERENCES contextflow."OutlineRevision"("projectId","id") ON DELETE RESTRICT ON UPDATE NO ACTION,
 CONSTRAINT "OutlineRevisionSourceCitation_set_fkey" FOREIGN KEY ("projectId","sourceEvidenceSetId") REFERENCES contextflow."SourceEvidenceSet"("projectId","id") ON DELETE RESTRICT ON UPDATE NO ACTION,
 CONSTRAINT "OutlineRevisionSourceCitation_packet_item_fkey" FOREIGN KEY ("projectId","packetId","spanId") REFERENCES contextflow."SourceEvidencePacketItem"("projectId","packetId","spanId") ON DELETE RESTRICT ON UPDATE NO ACTION,
 CONSTRAINT "OutlineRevisionSourceCitation_set_packet_fkey" FOREIGN KEY ("projectId","sourceEvidenceSetId","packetId") REFERENCES contextflow."SourceEvidenceSetPacket"("projectId","setId","packetId") ON DELETE RESTRICT ON UPDATE NO ACTION
);

CREATE TABLE contextflow."ArticleVersionSourceCitation" (
 "projectId" uuid NOT NULL, "articleVersionId" uuid NOT NULL, "sourceEvidenceSetId" uuid NOT NULL,
 "packetId" uuid NOT NULL, "spanId" uuid NOT NULL, "locator" varchar(240) NOT NULL CHECK (length(btrim("locator")) BETWEEN 1 AND 240),
 "text" text NOT NULL, "quote" text NOT NULL,
 CONSTRAINT "ArticleVersionSourceCitation_pkey" PRIMARY KEY ("articleVersionId","locator"),
 CONSTRAINT "ArticleVersionSourceCitation_version_fkey" FOREIGN KEY ("projectId","articleVersionId") REFERENCES contextflow."ArticleVersion"("projectId","id") ON DELETE RESTRICT ON UPDATE NO ACTION,
 CONSTRAINT "ArticleVersionSourceCitation_set_fkey" FOREIGN KEY ("projectId","sourceEvidenceSetId") REFERENCES contextflow."SourceEvidenceSet"("projectId","id") ON DELETE RESTRICT ON UPDATE NO ACTION,
 CONSTRAINT "ArticleVersionSourceCitation_packet_item_fkey" FOREIGN KEY ("projectId","packetId","spanId") REFERENCES contextflow."SourceEvidencePacketItem"("projectId","packetId","spanId") ON DELETE RESTRICT ON UPDATE NO ACTION,
 CONSTRAINT "ArticleVersionSourceCitation_set_packet_fkey" FOREIGN KEY ("projectId","sourceEvidenceSetId","packetId") REFERENCES contextflow."SourceEvidenceSetPacket"("projectId","setId","packetId") ON DELETE RESTRICT ON UPDATE NO ACTION
);

CREATE TABLE contextflow."AdaptationRevisionSourceCitation" (
 "projectId" uuid NOT NULL, "revisionId" uuid NOT NULL, "sourceEvidenceSetId" uuid NOT NULL,
 "packetId" uuid NOT NULL, "spanId" uuid NOT NULL, "locator" varchar(240) NOT NULL CHECK (length(btrim("locator")) BETWEEN 1 AND 240),
 "text" text NOT NULL, "quote" text NOT NULL,
 CONSTRAINT "AdaptationRevisionSourceCitation_pkey" PRIMARY KEY ("revisionId","locator"),
 CONSTRAINT "AdaptationRevisionSourceCitation_revision_fkey" FOREIGN KEY ("projectId","revisionId") REFERENCES contextflow."AdaptationRevision"("projectId","id") ON DELETE RESTRICT ON UPDATE NO ACTION,
 CONSTRAINT "AdaptationRevisionSourceCitation_set_fkey" FOREIGN KEY ("projectId","sourceEvidenceSetId") REFERENCES contextflow."SourceEvidenceSet"("projectId","id") ON DELETE RESTRICT ON UPDATE NO ACTION,
 CONSTRAINT "AdaptationRevisionSourceCitation_packet_item_fkey" FOREIGN KEY ("projectId","packetId","spanId") REFERENCES contextflow."SourceEvidencePacketItem"("projectId","packetId","spanId") ON DELETE RESTRICT ON UPDATE NO ACTION,
 CONSTRAINT "AdaptationRevisionSourceCitation_set_packet_fkey" FOREIGN KEY ("projectId","sourceEvidenceSetId","packetId") REFERENCES contextflow."SourceEvidenceSetPacket"("projectId","setId","packetId") ON DELETE RESTRICT ON UPDATE NO ACTION
);

CREATE TABLE contextflow."ScriptRevisionSourceCitation" (
 "projectId" uuid NOT NULL, "revisionId" uuid NOT NULL, "sourceEvidenceSetId" uuid NOT NULL,
 "packetId" uuid NOT NULL, "spanId" uuid NOT NULL, "frameId" uuid NOT NULL,
 "locator" varchar(240) NOT NULL CHECK (length(btrim("locator")) BETWEEN 1 AND 240), "text" text NOT NULL, "quote" text NOT NULL,
 CONSTRAINT "ScriptRevisionSourceCitation_pkey" PRIMARY KEY ("revisionId","frameId","locator"),
 CONSTRAINT "ScriptRevisionSourceCitation_revision_fkey" FOREIGN KEY ("projectId","revisionId") REFERENCES contextflow."ScriptRevision"("projectId","id") ON DELETE RESTRICT ON UPDATE NO ACTION,
 CONSTRAINT "ScriptRevisionSourceCitation_set_fkey" FOREIGN KEY ("projectId","sourceEvidenceSetId") REFERENCES contextflow."SourceEvidenceSet"("projectId","id") ON DELETE RESTRICT ON UPDATE NO ACTION,
 CONSTRAINT "ScriptRevisionSourceCitation_packet_item_fkey" FOREIGN KEY ("projectId","packetId","spanId") REFERENCES contextflow."SourceEvidencePacketItem"("projectId","packetId","spanId") ON DELETE RESTRICT ON UPDATE NO ACTION,
 CONSTRAINT "ScriptRevisionSourceCitation_set_packet_fkey" FOREIGN KEY ("projectId","sourceEvidenceSetId","packetId") REFERENCES contextflow."SourceEvidenceSetPacket"("projectId","setId","packetId") ON DELETE RESTRICT ON UPDATE NO ACTION
);
CREATE INDEX "OutlineRevisionSourceCitation_set_idx" ON contextflow."OutlineRevisionSourceCitation"("projectId","sourceEvidenceSetId","packetId","spanId");
CREATE INDEX "ArticleVersionSourceCitation_set_idx" ON contextflow."ArticleVersionSourceCitation"("projectId","sourceEvidenceSetId","packetId","spanId");
CREATE INDEX "AdaptationRevisionSourceCitation_set_idx" ON contextflow."AdaptationRevisionSourceCitation"("projectId","sourceEvidenceSetId","packetId","spanId");
CREATE INDEX "ScriptRevisionSourceCitation_set_idx" ON contextflow."ScriptRevisionSourceCitation"("projectId","sourceEvidenceSetId","packetId","spanId");

CREATE TABLE contextflow."SourceWritingRequest" (
 "id" uuid NOT NULL, "projectId" uuid NOT NULL, "requestedBy" uuid NOT NULL, "commandKey" varchar(128) NOT NULL,
 "task" varchar(16) NOT NULL, "stage" varchar(16) NOT NULL, "inputManifestJson" jsonb NOT NULL, "inputHash" char(64) NOT NULL,
 "stageDataJson" jsonb NOT NULL DEFAULT '{}'::jsonb, "revision" integer NOT NULL DEFAULT 1,
 "errorCategory" varchar(64), "createdAt" timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 "updatedAt" timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "nextCheckAt" timestamptz(3),
 CONSTRAINT "SourceWritingRequest_pkey" PRIMARY KEY ("id"),
 CONSTRAINT "SourceWritingRequest_project_id_key" UNIQUE ("projectId","id"),
 CONSTRAINT "SourceWritingRequest_project_commandKey_key" UNIQUE ("projectId","commandKey"),
 CONSTRAINT "SourceWritingRequest_project_fkey" FOREIGN KEY ("projectId") REFERENCES contextflow."Project"("id") ON DELETE RESTRICT ON UPDATE NO ACTION,
 CONSTRAINT "SourceWritingRequest_requester_fkey" FOREIGN KEY ("requestedBy") REFERENCES contextflow."UserProfile"("id") ON DELETE RESTRICT ON UPDATE NO ACTION,
 CONSTRAINT "SourceWritingRequest_task_check" CHECK ("task" IN ('OUTLINE','ARTICLE','ADAPTATION')),
 CONSTRAINT "SourceWritingRequest_stage_check" CHECK ("stage" IN ('INDEXING','SEARCHING','READY','GENERATING','SUCCEEDED','FAILED','CANCELLED')),
 CONSTRAINT "SourceWritingRequest_input_check" CHECK (length(btrim("commandKey")) BETWEEN 1 AND 128 AND "inputHash" ~ '^[a-f0-9]{64}$' AND jsonb_typeof("inputManifestJson")='object' AND jsonb_typeof("stageDataJson")='object' AND "revision">0)
);
CREATE INDEX "SourceWritingRequest_stage_nextCheckAt_projectId_idx" ON contextflow."SourceWritingRequest"("stage","nextCheckAt","projectId");

-- Keep the existing factual-basis rules exactly for NULL-set rows. A new source
-- set is an alternative evidence parent only for FACTUAL work and no old row is
-- backfilled or reinterpreted.
DO $$
DECLARE check_name text;
BEGIN
  SELECT c.conname INTO check_name FROM pg_catalog.pg_constraint c
  WHERE c.conrelid='contextflow."OutlineRevision"'::regclass AND c.contype='c'
    AND pg_get_constraintdef(c.oid) LIKE '%approvedAt%' AND pg_get_constraintdef(c.oid) LIKE '%basisRevisionId%';
  IF check_name IS NULL THEN RAISE EXCEPTION 'could not find the existing outline factual approval check'; END IF;
  EXECUTE format('ALTER TABLE contextflow."OutlineRevision" DROP CONSTRAINT %I',check_name);
END $$;
ALTER TABLE contextflow."OutlineRevision" ADD CONSTRAINT "OutlineRevision_factual_approval_check" CHECK (
 "contentMode"<>'FACTUAL' OR "approvedAt" IS NULL OR "basisRevisionId" IS NOT NULL OR ("sourceEvidenceSetId" IS NOT NULL AND "sourceEvidenceSealed"));
ALTER TABLE contextflow."OutlineRevision" ADD CONSTRAINT "OutlineRevision_source_evidence_mode_check" CHECK (
 "sourceEvidenceSetId" IS NULL OR ("contentMode"='FACTUAL' AND "basisRevisionId" IS NULL));
ALTER TABLE contextflow."ArticleDraft" ADD CONSTRAINT "ArticleDraft_source_evidence_mode_check" CHECK (
 "sourceEvidenceSetId" IS NULL OR ("contentMode"='FACTUAL' AND "basisRevisionId" IS NULL));
ALTER TABLE contextflow."ArticleVersion" ADD CONSTRAINT "ArticleVersion_source_evidence_mode_check" CHECK (
 "sourceEvidenceSetId" IS NULL OR ("contentMode"='FACTUAL' AND "basisRevisionId" IS NULL));
ALTER TABLE contextflow."ArticleVersion" ADD CONSTRAINT "ArticleVersion_source_evidence_approval_check" CHECK (
 "approvedAt" IS NULL OR "sourceEvidenceSetId" IS NULL OR "sourceEvidenceSealed");

ALTER TABLE contextflow."AdaptationDraft" DROP CONSTRAINT "AdaptationDraft_shape_check";
ALTER TABLE contextflow."AdaptationDraft" ADD CONSTRAINT "AdaptationDraft_shape_check" CHECK (
 "sha256" ~ '^[a-f0-9]{64}$' AND octet_length("content"::text)<=100000
 AND jsonb_typeof("content")='object' AND jsonb_typeof("content"->'text')='string'
 AND length("content"->>'text') BETWEEN 1 AND 4096 AND jsonb_typeof("content"->'mappings')='array'
 AND jsonb_array_length("content"->'mappings')<=100 AND "workspaceStyleRevision">0
 AND (("inputMode"='DIRECT' AND "sourceArticleVersionId" IS NULL) OR ("inputMode"='ARTICLE_DERIVED' AND "sourceArticleVersionId" IS NOT NULL))
 AND (("contentMode"='FACTUAL' AND (("sourceEvidenceSetId" IS NULL AND "basisRevisionId" IS NOT NULL) OR ("sourceEvidenceSetId" IS NOT NULL AND "basisRevisionId" IS NULL)))
   OR ("contentMode"='CREATIVE' AND "basisRevisionId" IS NULL AND "sourceEvidenceSetId" IS NULL))
 AND "origin" IN ('MANUAL','AI'));

ALTER TABLE contextflow."AdaptationRevision" DROP CONSTRAINT "AdaptationRevision_shape_check";
ALTER TABLE contextflow."AdaptationRevision" ADD CONSTRAINT "AdaptationRevision_shape_check" CHECK (
 "number">0 AND "sourceAdaptationRevision">=0 AND "sha256" ~ '^[a-f0-9]{64}$'
 AND octet_length("content"::text)<=100000 AND jsonb_typeof("content")='object'
 AND jsonb_typeof("content"->'text')='string' AND length("content"->>'text') BETWEEN 1 AND 4096
 AND jsonb_typeof("content"->'mappings')='array' AND jsonb_array_length("content"->'mappings')<=100
 AND "workspaceStyleRevision">0
 AND (("inputMode"='DIRECT' AND "sourceArticleVersionId" IS NULL) OR ("inputMode"='ARTICLE_DERIVED' AND "sourceArticleVersionId" IS NOT NULL))
 AND (("contentMode"='FACTUAL' AND (("sourceEvidenceSetId" IS NULL AND "basisRevisionId" IS NOT NULL) OR ("sourceEvidenceSetId" IS NOT NULL AND "basisRevisionId" IS NULL)))
   OR ("contentMode"='CREATIVE' AND "basisRevisionId" IS NULL AND "sourceEvidenceSetId" IS NULL))
 AND (("origin"='AI') = ("jobId" IS NOT NULL AND "aiExecutionId" IS NOT NULL))
 AND ("origin"='AI' OR ("jobId" IS NULL AND "aiExecutionId" IS NULL)) AND ("jobId" IS NULL OR "origin"='AI')
 AND (("approvedBy" IS NULL)=("approvedAt" IS NULL)) AND (("withdrawnBy" IS NULL)=("withdrawnAt" IS NULL))
 AND ("approvedAt" IS NULL OR "claimsSealed") AND ("approvedAt" IS NULL OR "sourceEvidenceSetId" IS NULL OR "sourceEvidenceSealed")
 AND ("withdrawnAt" IS NULL OR "approvedAt" IS NOT NULL) AND ("approvedAt" IS NOT NULL OR NOT "acknowledgedUnmapped")
 AND ("withdrawnAt" IS NOT NULL OR "withdrawalReason" IS NULL)
 AND (("reviewCounter"=0 AND "reviewedBriefRevisionId" IS NULL AND "reviewedBasisRevisionId" IS NULL AND "reviewedSourceEvidenceSetId" IS NULL AND "reviewedSourceArticleVersionId" IS NULL AND "reviewedWorkspaceStyleRevision" IS NULL AND "reviewedBy" IS NULL AND "reviewedAt" IS NULL)
   OR ("reviewCounter">0 AND "approvedAt" IS NOT NULL AND "reviewedBriefRevisionId" IS NOT NULL AND "reviewedWorkspaceStyleRevision" IS NOT NULL AND "reviewedWorkspaceStyleRevision">0 AND "reviewedBy" IS NOT NULL AND "reviewedAt" IS NOT NULL
     AND (("inputMode"='DIRECT' AND "reviewedSourceArticleVersionId" IS NULL) OR ("inputMode"='ARTICLE_DERIVED' AND "reviewedSourceArticleVersionId" IS NOT NULL))
     AND (("contentMode"='FACTUAL' AND (("sourceEvidenceSetId" IS NULL AND "reviewedBasisRevisionId" IS NOT NULL AND "reviewedSourceEvidenceSetId" IS NULL)
          OR ("sourceEvidenceSetId" IS NOT NULL AND "reviewedBasisRevisionId" IS NULL AND "reviewedSourceEvidenceSetId"="sourceEvidenceSetId")))
       OR ("contentMode"='CREATIVE' AND "reviewedBasisRevisionId" IS NULL AND "reviewedSourceEvidenceSetId" IS NULL)))));

ALTER TABLE contextflow."AdaptationRevision" ADD CONSTRAINT "AdaptationRevision_source_evidence_mode_check" CHECK (
 "sourceEvidenceSetId" IS NULL OR ("contentMode"='FACTUAL' AND "basisRevisionId" IS NULL));

ALTER TABLE contextflow."ArticleVersion" DROP CONSTRAINT "ArticleVersion_review_receipt_check";
ALTER TABLE contextflow."ArticleVersion" ADD CONSTRAINT "ArticleVersion_review_receipt_check" CHECK (
 "reviewCounter">=0 AND
 (("reviewCounter"=0 AND "reviewedBriefRevisionId" IS NULL AND "reviewedBasisRevisionId" IS NULL AND "reviewedSourceEvidenceSetId" IS NULL AND "reviewedOutlineRevisionId" IS NULL AND "reviewedWorkspaceStyleRevision" IS NULL AND "reviewedBy" IS NULL AND "reviewedAt" IS NULL)
  OR ("reviewCounter">0 AND "approvedAt" IS NOT NULL
    AND (("briefRevisionId" IS NULL AND "reviewedBriefRevisionId" IS NULL) OR ("briefRevisionId" IS NOT NULL AND "reviewedBriefRevisionId" IS NOT NULL))
    AND (("outlineRevisionId" IS NULL AND "reviewedOutlineRevisionId" IS NULL) OR ("outlineRevisionId" IS NOT NULL AND "reviewedOutlineRevisionId" IS NOT NULL))
    AND "reviewedWorkspaceStyleRevision" IS NOT NULL AND "reviewedWorkspaceStyleRevision">0 AND "reviewedBy" IS NOT NULL AND "reviewedAt" IS NOT NULL
    AND (("contentMode"='FACTUAL' AND (("sourceEvidenceSetId" IS NULL AND "reviewedBasisRevisionId" IS NOT NULL AND "reviewedSourceEvidenceSetId" IS NULL)
         OR ("sourceEvidenceSetId" IS NOT NULL AND "reviewedBasisRevisionId" IS NULL AND "reviewedSourceEvidenceSetId"="sourceEvidenceSetId")))
      OR ("contentMode"='CREATIVE' AND "reviewedBasisRevisionId" IS NULL AND "reviewedSourceEvidenceSetId" IS NULL)))));

-- Extend the existing row guards by changing only their immutable-field lists.
-- The old predicates remain byte-for-byte intact; the exact expected clauses
-- are asserted so a future canonical guard change fails this migration closed.
DO $$
DECLARE fn text; patched text;
BEGIN
  fn := pg_get_functiondef('contextflow.guard_outline_revision()'::regprocedure);
  patched := replace(fn, $old$ARRAY['approvedBy','approvedAt','withdrawnBy','withdrawnAt','withdrawalReason']$old$,
                           $new$ARRAY['approvedBy','approvedAt','withdrawnBy','withdrawnAt','withdrawalReason','sourceEvidenceSealed']$new$);
  IF length(fn)-length(replace(fn,$old$ARRAY['approvedBy','approvedAt','withdrawnBy','withdrawnAt','withdrawalReason']$old$,'')) <> 2*length($old$ARRAY['approvedBy','approvedAt','withdrawnBy','withdrawnAt','withdrawalReason']$old$) THEN RAISE EXCEPTION 'outline revision guard definition changed; review before extending source evidence seal'; END IF;
  EXECUTE patched;

  fn := pg_get_functiondef('contextflow.guard_article_version()'::regprocedure);
  patched := replace(fn,
    $old$'withdrawalReason','claimsSealed','reviewCounter','reviewedBriefRevisionId','reviewedBasisRevisionId','reviewedOutlineRevisionId','reviewedWorkspaceStyleRevision','reviewedBy','reviewedAt'$old$,
    $new$'withdrawalReason','claimsSealed','sourceEvidenceSealed','reviewCounter','reviewedBriefRevisionId','reviewedBasisRevisionId','reviewedSourceEvidenceSetId','reviewedOutlineRevisionId','reviewedWorkspaceStyleRevision','reviewedBy','reviewedAt'$new$);
  IF length(fn)-length(replace(fn,$old$'withdrawalReason','claimsSealed','reviewCounter','reviewedBriefRevisionId','reviewedBasisRevisionId','reviewedOutlineRevisionId','reviewedWorkspaceStyleRevision','reviewedBy','reviewedAt'$old$,'')) <> 2*length($old$'withdrawalReason','claimsSealed','reviewCounter','reviewedBriefRevisionId','reviewedBasisRevisionId','reviewedOutlineRevisionId','reviewedWorkspaceStyleRevision','reviewedBy','reviewedAt'$old$) THEN RAISE EXCEPTION 'article version guard definition changed; review before extending source evidence seal'; END IF;
  EXECUTE patched;

  fn := pg_get_functiondef('contextflow.guard_adaptation_revision()'::regprocedure);
  patched := replace(fn,
    $old$'withdrawalReason','claimsSealed','reviewCounter','reviewedBriefRevisionId','reviewedBasisRevisionId','reviewedSourceArticleVersionId','reviewedWorkspaceStyleRevision','reviewedBy','reviewedAt'$old$,
    $new$'withdrawalReason','claimsSealed','sourceEvidenceSealed','reviewCounter','reviewedBriefRevisionId','reviewedBasisRevisionId','reviewedSourceEvidenceSetId','reviewedSourceArticleVersionId','reviewedWorkspaceStyleRevision','reviewedBy','reviewedAt'$new$);
  IF length(fn)-length(replace(fn,$old$'withdrawalReason','claimsSealed','reviewCounter','reviewedBriefRevisionId','reviewedBasisRevisionId','reviewedSourceArticleVersionId','reviewedWorkspaceStyleRevision','reviewedBy','reviewedAt'$old$,'')) <> 2*length($old$'withdrawalReason','claimsSealed','reviewCounter','reviewedBriefRevisionId','reviewedBasisRevisionId','reviewedSourceArticleVersionId','reviewedWorkspaceStyleRevision','reviewedBy','reviewedAt'$old$) THEN RAISE EXCEPTION 'adaptation revision guard definition changed; review before extending source evidence seal'; END IF;
  EXECUTE patched;

  fn := pg_get_functiondef('contextflow.guard_script_revision()'::regprocedure);
  patched := replace(fn,$old$ARRAY['approvedBy','approvedAt','acknowledgedUnmapped','withdrawnBy','withdrawnAt','withdrawalReason','claimsSealed']$old$,
    $new$ARRAY['approvedBy','approvedAt','acknowledgedUnmapped','withdrawnBy','withdrawnAt','withdrawalReason','claimsSealed','sourceEvidenceSealed']$new$);
  IF length(fn)-length(replace(fn,$old$ARRAY['approvedBy','approvedAt','acknowledgedUnmapped','withdrawnBy','withdrawnAt','withdrawalReason','claimsSealed']$old$,'')) <> 2*length($old$ARRAY['approvedBy','approvedAt','acknowledgedUnmapped','withdrawnBy','withdrawnAt','withdrawalReason','claimsSealed']$old$) THEN RAISE EXCEPTION 'script revision guard definition changed; review before extending source evidence seal'; END IF;
  EXECUTE patched;
END $$;

CREATE FUNCTION contextflow.guard_source_evidence_set() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,contextflow AS $$
DECLARE entry jsonb; actual_count integer; expected_count integer;
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'source evidence sets are immutable retained provenance' USING ERRCODE='23514'; END IF;
  IF TG_OP='INSERT' THEN
    IF NEW."sealed" OR jsonb_typeof(NEW."manifestJson"->'packets') IS DISTINCT FROM 'array' THEN
      RAISE EXCEPTION 'source evidence set starts unsealed with a packet manifest' USING ERRCODE='23514';
    END IF;
    RETURN NEW;
  END IF;
  IF (to_jsonb(NEW)-'sealed') IS DISTINCT FROM (to_jsonb(OLD)-'sealed') OR OLD."sealed" OR NOT NEW."sealed" THEN
    RAISE EXCEPTION 'source evidence set is immutable and may only be sealed once' USING ERRCODE='23514';
  END IF;
  expected_count := jsonb_array_length(NEW."manifestJson"->'packets');
  SELECT count(*) INTO actual_count FROM contextflow."SourceEvidenceSetPacket" p WHERE p."projectId"=NEW."projectId" AND p."setId"=NEW."id";
  IF expected_count<1 OR actual_count<>expected_count OR EXISTS (
    SELECT 1 FROM jsonb_array_elements(NEW."manifestJson"->'packets') WITH ORDINALITY m(entry,ord)
    LEFT JOIN contextflow."SourceEvidenceSetPacket" p ON p."projectId"=NEW."projectId" AND p."setId"=NEW."id" AND p."ordinal"=m.ord-1
    LEFT JOIN contextflow."SourceEvidencePacket" packet ON packet."projectId"=p."projectId" AND packet."id"=p."packetId"
    LEFT JOIN contextflow."Job" j ON j."projectId"=packet."projectId" AND j."id"=packet."jobId"
    WHERE p."packetId" IS NULL OR m.entry->>'ordinal' IS DISTINCT FROM (m.ord-1)::text
      OR m.entry->>'packetId' IS DISTINCT FROM p."packetId"::text
      OR m.entry->>'sha256' IS DISTINCT FROM p."packetHash"::text
      OR p."packetHash" IS DISTINCT FROM packet."sha256"::text
      OR j."operation"::text IS DISTINCT FROM 'EVIDENCE_SEARCH' OR j."status"::text IS DISTINCT FROM 'SUCCEEDED'
  ) THEN RAISE EXCEPTION 'sealed evidence set must exactly match completed packet IDs and hashes' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "SourceEvidenceSet_guard" BEFORE INSERT OR UPDATE OR DELETE ON contextflow."SourceEvidenceSet" FOR EACH ROW EXECUTE FUNCTION contextflow.guard_source_evidence_set();

CREATE FUNCTION contextflow.guard_source_evidence_set_packet() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,contextflow AS $$
DECLARE parent contextflow."SourceEvidenceSet"%ROWTYPE; packet contextflow."SourceEvidencePacket"%ROWTYPE; job_status text; job_operation text;
BEGIN
  IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'source evidence set packet membership is immutable' USING ERRCODE='23514'; END IF;
  SELECT * INTO parent FROM contextflow."SourceEvidenceSet" s WHERE s."projectId"=NEW."projectId" AND s."id"=NEW."setId" FOR UPDATE;
  SELECT p.* INTO packet FROM contextflow."SourceEvidencePacket" p
    WHERE p."projectId"=NEW."projectId" AND p."id"=NEW."packetId";
  SELECT j."status"::text,j."operation"::text INTO job_status,job_operation
    FROM contextflow."Job" j WHERE j."projectId"=NEW."projectId" AND j."id"=packet."jobId";
  IF parent."id" IS NULL OR parent."sealed" OR packet."id" IS NULL OR packet."sha256" IS DISTINCT FROM NEW."packetHash"
    OR job_status IS DISTINCT FROM 'SUCCEEDED' OR job_operation IS DISTINCT FROM 'EVIDENCE_SEARCH'
    OR NEW."ordinal"<0 OR parent."manifestJson"->'packets'->NEW."ordinal"->>'packetId' IS DISTINCT FROM NEW."packetId"::text
    OR parent."manifestJson"->'packets'->NEW."ordinal"->>'sha256' IS DISTINCT FROM NEW."packetHash"::text THEN
    RAISE EXCEPTION 'set packet must match an unsealed set manifest and completed evidence search' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "SourceEvidenceSetPacket_insert_guard" BEFORE INSERT OR UPDATE OR DELETE ON contextflow."SourceEvidenceSetPacket" FOR EACH ROW EXECUTE FUNCTION contextflow.guard_source_evidence_set_packet();

CREATE FUNCTION contextflow.guard_source_evidence_reference() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,contextflow AS $$
DECLARE set_brief uuid; row_brief uuid; set_id uuid; basis_id uuid; mode text;
BEGIN
  IF TG_TABLE_NAME='OutlineRevision' THEN row_brief:=NEW."briefRevisionId"; set_id:=NEW."sourceEvidenceSetId"; basis_id:=NEW."basisRevisionId"; mode:=NEW."contentMode"::text;
  ELSIF TG_TABLE_NAME='ArticleDraft' THEN row_brief:=NEW."briefRevisionId"; set_id:=NEW."sourceEvidenceSetId"; basis_id:=NEW."basisRevisionId"; mode:=NEW."contentMode"::text;
  ELSIF TG_TABLE_NAME='ArticleVersion' THEN row_brief:=NEW."briefRevisionId"; set_id:=NEW."sourceEvidenceSetId"; basis_id:=NEW."basisRevisionId"; mode:=NEW."contentMode"::text;
  ELSIF TG_TABLE_NAME='AdaptationDraft' THEN row_brief:=NEW."briefRevisionId"; set_id:=NEW."sourceEvidenceSetId"; basis_id:=NEW."basisRevisionId"; mode:=NEW."contentMode"::text;
  ELSIF TG_TABLE_NAME='AdaptationRevision' THEN row_brief:=NEW."briefRevisionId"; set_id:=NEW."sourceEvidenceSetId"; basis_id:=NEW."basisRevisionId"; mode:=NEW."contentMode"::text;
  ELSE RAISE EXCEPTION 'unsupported source evidence reference target' USING ERRCODE='23514'; END IF;
  IF set_id IS NULL THEN RETURN NEW; END IF;
  SELECT s."briefRevisionId" INTO set_brief FROM contextflow."SourceEvidenceSet" s
    WHERE s."projectId"=NEW."projectId" AND s."id"=set_id AND s."sealed";
  IF NOT FOUND OR row_brief IS NULL OR row_brief IS DISTINCT FROM set_brief OR mode IS DISTINCT FROM 'FACTUAL' OR basis_id IS NOT NULL THEN
    RAISE EXCEPTION 'source evidence reference must use a sealed set for this brief and factual work without a claim basis' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "OutlineRevision_source_evidence_guard" BEFORE INSERT ON contextflow."OutlineRevision" FOR EACH ROW EXECUTE FUNCTION contextflow.guard_source_evidence_reference();
CREATE TRIGGER "ArticleDraft_source_evidence_guard" BEFORE INSERT OR UPDATE ON contextflow."ArticleDraft" FOR EACH ROW EXECUTE FUNCTION contextflow.guard_source_evidence_reference();
CREATE TRIGGER "ArticleVersion_source_evidence_guard" BEFORE INSERT ON contextflow."ArticleVersion" FOR EACH ROW EXECUTE FUNCTION contextflow.guard_source_evidence_reference();
CREATE TRIGGER "AdaptationDraft_source_evidence_guard" BEFORE INSERT OR UPDATE ON contextflow."AdaptationDraft" FOR EACH ROW EXECUTE FUNCTION contextflow.guard_source_evidence_reference();
CREATE TRIGGER "AdaptationRevision_source_evidence_guard" BEFORE INSERT ON contextflow."AdaptationRevision" FOR EACH ROW EXECUTE FUNCTION contextflow.guard_source_evidence_reference();

CREATE FUNCTION contextflow.guard_source_evidence_unsealed_insert() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,contextflow AS $$
BEGIN
  IF NEW."sourceEvidenceSealed" THEN RAISE EXCEPTION 'source evidence rows start unsealed' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "OutlineRevision_source_evidence_initial_guard" BEFORE INSERT ON contextflow."OutlineRevision" FOR EACH ROW EXECUTE FUNCTION contextflow.guard_source_evidence_unsealed_insert();
CREATE TRIGGER "ArticleVersion_source_evidence_initial_guard" BEFORE INSERT ON contextflow."ArticleVersion" FOR EACH ROW EXECUTE FUNCTION contextflow.guard_source_evidence_unsealed_insert();
CREATE TRIGGER "AdaptationRevision_source_evidence_initial_guard" BEFORE INSERT ON contextflow."AdaptationRevision" FOR EACH ROW EXECUTE FUNCTION contextflow.guard_source_evidence_unsealed_insert();
CREATE TRIGGER "ScriptRevision_source_evidence_initial_guard" BEFORE INSERT ON contextflow."ScriptRevision" FOR EACH ROW EXECUTE FUNCTION contextflow.guard_source_evidence_unsealed_insert();

CREATE FUNCTION contextflow.guard_source_citation_insert() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,contextflow AS $$
DECLARE expected_set uuid; sealed boolean; source_set contextflow."SourceEvidenceSet"%ROWTYPE; span_quote text;
BEGIN
  IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'source citations are immutable' USING ERRCODE='23514'; END IF;
  IF TG_TABLE_NAME='OutlineRevisionSourceCitation' THEN
    SELECT r."sourceEvidenceSetId",r."sourceEvidenceSealed" INTO expected_set,sealed FROM contextflow."OutlineRevision" r WHERE r."projectId"=NEW."projectId" AND r."id"=NEW."revisionId" FOR UPDATE;
  ELSIF TG_TABLE_NAME='ArticleVersionSourceCitation' THEN
    SELECT r."sourceEvidenceSetId",r."sourceEvidenceSealed" INTO expected_set,sealed FROM contextflow."ArticleVersion" r WHERE r."projectId"=NEW."projectId" AND r."id"=NEW."articleVersionId" FOR UPDATE;
  ELSIF TG_TABLE_NAME='AdaptationRevisionSourceCitation' THEN
    SELECT r."sourceEvidenceSetId",r."sourceEvidenceSealed" INTO expected_set,sealed FROM contextflow."AdaptationRevision" r WHERE r."projectId"=NEW."projectId" AND r."id"=NEW."revisionId" FOR UPDATE;
  ELSIF TG_TABLE_NAME='ScriptRevisionSourceCitation' THEN
    SELECT a."sourceEvidenceSetId",r."sourceEvidenceSealed" INTO expected_set,sealed FROM contextflow."ScriptRevision" r
      JOIN contextflow."AdaptationRevision" a ON a."projectId"=r."projectId" AND a."id"=r."parentAdaptationRevisionId"
      WHERE r."projectId"=NEW."projectId" AND r."id"=NEW."revisionId" FOR UPDATE OF r;
  ELSE RAISE EXCEPTION 'unsupported source citation target' USING ERRCODE='23514'; END IF;
  SELECT * INTO source_set FROM contextflow."SourceEvidenceSet" s WHERE s."projectId"=NEW."projectId" AND s."id"=NEW."sourceEvidenceSetId" AND s."sealed";
  SELECT span."quote" INTO span_quote
    FROM contextflow."SourceEvidencePacketItem" item
    JOIN contextflow."SourceEvidenceSpan" span ON span."projectId"=item."projectId" AND span."id"=item."spanId"
    WHERE item."projectId"=NEW."projectId" AND item."packetId"=NEW."packetId" AND item."spanId"=NEW."spanId";
  IF expected_set IS DISTINCT FROM NEW."sourceEvidenceSetId" OR sealed OR source_set."id" IS NULL
    OR length(NEW."locator")=0 OR length(NEW."text")=0 OR length(NEW."quote")=0
    OR span_quote IS NULL OR position(NEW."quote" in span_quote)=0 THEN
    RAISE EXCEPTION 'citation must reference the parent sealed evidence set before its citation seal' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;

CREATE FUNCTION contextflow.guard_source_evidence_content_seal() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,contextflow AS $$
DECLARE set_id uuid; citations integer; parent_set uuid;
BEGIN
  IF TG_OP<>'UPDATE' THEN RETURN NEW; END IF;
  IF TG_TABLE_NAME='ScriptRevision' THEN
    SELECT a."sourceEvidenceSetId" INTO parent_set FROM contextflow."AdaptationRevision" a WHERE a."projectId"=NEW."projectId" AND a."id"=NEW."parentAdaptationRevisionId";
    set_id:=parent_set;
  ELSE
    set_id:=NEW."sourceEvidenceSetId";
  END IF;
  IF OLD."sourceEvidenceSealed" AND NOT NEW."sourceEvidenceSealed" THEN RAISE EXCEPTION 'source evidence seal is irreversible' USING ERRCODE='23514'; END IF;
  IF NOT OLD."sourceEvidenceSealed" AND NEW."sourceEvidenceSealed" THEN
    IF TG_TABLE_NAME='OutlineRevision' THEN
      set_id:=NEW."sourceEvidenceSetId";
      SELECT count(*) INTO citations FROM contextflow."OutlineRevisionSourceCitation" c WHERE c."projectId"=NEW."projectId" AND c."revisionId"=NEW."id" AND c."sourceEvidenceSetId"=set_id;
    ELSIF TG_TABLE_NAME='ArticleVersion' THEN
      set_id:=NEW."sourceEvidenceSetId";
      SELECT count(*) INTO citations FROM contextflow."ArticleVersionSourceCitation" c WHERE c."projectId"=NEW."projectId" AND c."articleVersionId"=NEW."id" AND c."sourceEvidenceSetId"=set_id;
    ELSIF TG_TABLE_NAME='AdaptationRevision' THEN
      set_id:=NEW."sourceEvidenceSetId";
      SELECT count(*) INTO citations FROM contextflow."AdaptationRevisionSourceCitation" c WHERE c."projectId"=NEW."projectId" AND c."revisionId"=NEW."id" AND c."sourceEvidenceSetId"=set_id;
    ELSIF TG_TABLE_NAME='ScriptRevision' THEN
      set_id:=parent_set;
      SELECT count(*) INTO citations FROM contextflow."ScriptRevisionSourceCitation" c WHERE c."projectId"=NEW."projectId" AND c."revisionId"=NEW."id" AND c."sourceEvidenceSetId"=set_id;
    END IF;
    IF set_id IS NULL THEN RAISE EXCEPTION 'source evidence cannot be sealed without a source set' USING ERRCODE='23514'; END IF;
    IF set_id IS NOT NULL AND (citations=0 OR NOT EXISTS(SELECT 1 FROM contextflow."SourceEvidenceSet" s WHERE s."projectId"=NEW."projectId" AND s."id"=set_id AND s."sealed")) THEN
      RAISE EXCEPTION 'source evidence seal requires citations from its sealed set' USING ERRCODE='23514';
    END IF;
  END IF;
  IF NEW."approvedAt" IS NOT NULL AND set_id IS NOT NULL AND NOT NEW."sourceEvidenceSealed" THEN
    RAISE EXCEPTION 'approval requires the source evidence set to be sealed' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER "OutlineRevision_source_citation_insert_guard" BEFORE INSERT OR UPDATE OR DELETE ON contextflow."OutlineRevisionSourceCitation" FOR EACH ROW EXECUTE FUNCTION contextflow.guard_source_citation_insert();
CREATE TRIGGER "ArticleVersion_source_citation_insert_guard" BEFORE INSERT OR UPDATE OR DELETE ON contextflow."ArticleVersionSourceCitation" FOR EACH ROW EXECUTE FUNCTION contextflow.guard_source_citation_insert();
CREATE TRIGGER "AdaptationRevision_source_citation_insert_guard" BEFORE INSERT OR UPDATE OR DELETE ON contextflow."AdaptationRevisionSourceCitation" FOR EACH ROW EXECUTE FUNCTION contextflow.guard_source_citation_insert();
CREATE TRIGGER "ScriptRevision_source_citation_insert_guard" BEFORE INSERT OR UPDATE OR DELETE ON contextflow."ScriptRevisionSourceCitation" FOR EACH ROW EXECUTE FUNCTION contextflow.guard_source_citation_insert();
CREATE TRIGGER "OutlineRevision_source_evidence_seal_guard" BEFORE UPDATE ON contextflow."OutlineRevision" FOR EACH ROW EXECUTE FUNCTION contextflow.guard_source_evidence_content_seal();
CREATE TRIGGER "ArticleVersion_source_evidence_seal_guard" BEFORE UPDATE ON contextflow."ArticleVersion" FOR EACH ROW EXECUTE FUNCTION contextflow.guard_source_evidence_content_seal();
CREATE TRIGGER "AdaptationRevision_source_evidence_seal_guard" BEFORE UPDATE ON contextflow."AdaptationRevision" FOR EACH ROW EXECUTE FUNCTION contextflow.guard_source_evidence_content_seal();
CREATE TRIGGER "ScriptRevision_source_evidence_seal_guard" BEFORE UPDATE ON contextflow."ScriptRevision" FOR EACH ROW EXECUTE FUNCTION contextflow.guard_source_evidence_content_seal();

CREATE FUNCTION contextflow.guard_source_writing_request() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,contextflow AS $$
DECLARE allowed boolean:=false;
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'source writing requests are retained' USING ERRCODE='23514'; END IF;
  IF TG_OP='INSERT' THEN
    IF NEW."revision"<>1 OR NEW."stage"<>'INDEXING' THEN RAISE EXCEPTION 'source writing request must start at revision one in INDEXING' USING ERRCODE='23514'; END IF;
    RETURN NEW;
  END IF;
  IF (to_jsonb(NEW)-ARRAY['stage','stageDataJson','revision','errorCategory','updatedAt','nextCheckAt']) IS DISTINCT FROM
     (to_jsonb(OLD)-ARRAY['stage','stageDataJson','revision','errorCategory','updatedAt','nextCheckAt']) THEN
    RAISE EXCEPTION 'source writing request identity and frozen inputs are immutable' USING ERRCODE='23514';
  END IF;
  IF NEW."revision"<>OLD."revision"+1 OR OLD."stage" IN ('SUCCEEDED','FAILED','CANCELLED') THEN
    RAISE EXCEPTION 'source writing request terminal state or revision is immutable' USING ERRCODE='23514';
  END IF;
  allowed := (OLD."stage" IN ('INDEXING','SEARCHING','READY','GENERATING') AND NEW."stage"=OLD."stage")
    OR (OLD."stage"='INDEXING' AND NEW."stage" IN ('SEARCHING','FAILED','CANCELLED'))
    OR (OLD."stage"='SEARCHING' AND NEW."stage" IN ('READY','FAILED','CANCELLED'))
    OR (OLD."stage"='READY' AND NEW."stage" IN ('GENERATING','FAILED','CANCELLED'))
    OR (OLD."stage"='GENERATING' AND NEW."stage" IN ('SUCCEEDED','FAILED','CANCELLED'));
  IF NOT allowed THEN RAISE EXCEPTION 'invalid source writing stage transition' USING ERRCODE='23514'; END IF;
  NEW."updatedAt":=GREATEST(clock_timestamp(),OLD."updatedAt"+interval '1 millisecond');
  RETURN NEW;
END $$;
CREATE TRIGGER "SourceWritingRequest_guard" BEFORE INSERT OR UPDATE OR DELETE ON contextflow."SourceWritingRequest" FOR EACH ROW EXECUTE FUNCTION contextflow.guard_source_writing_request();

-- Project/workspace retention is an explicit fixed allowlist. Extend both the
-- table-lock and deletion-target lists with every new project-owned table.
DO $$
DECLARE fn text; patched text; old_clause text; new_clause text;
BEGIN
  old_clause := $old$('ScriptRevisionClaim'),('SourceChunkEmbedding'),('SourceEvidencePacket'),('SourceEvidencePacketItem'),('SourceEvidenceSpan'),('SourceFragment'),('SourceSearchChunk'),('SourceSearchIndex'),('SourceSnapshot')) AS fixed_tables(name) ORDER BY name$old$;
  new_clause := $new$('ScriptRevisionClaim'),('ScriptRevisionSourceCitation'),('SourceChunkEmbedding'),('SourceEvidencePacket'),('SourceEvidencePacketItem'),('SourceEvidenceSet'),('SourceEvidenceSetPacket'),('SourceEvidenceSpan'),('SourceFragment'),('SourceSearchChunk'),('SourceSearchIndex'),('SourceSnapshot'),('OutlineRevisionSourceCitation'),('ArticleVersionSourceCitation'),('AdaptationRevisionSourceCitation'),('SourceWritingRequest')) AS fixed_tables(name) ORDER BY name$new$;
  fn := pg_get_functiondef('contextflow.lock_project_purge_tables()'::regprocedure);
  IF length(fn)-length(replace(fn,old_clause,''))<>length(old_clause) THEN RAISE EXCEPTION 'project purge lock allowlist changed; review source writing tables before replacement'; END IF;
  patched := replace(fn,old_clause,new_clause);
  EXECUTE patched;

  old_clause := $old$('ScriptRevisionClaim',true),('SourceChunkEmbedding',true),('SourceEvidencePacket',true),('SourceEvidencePacketItem',true),('SourceEvidenceSpan',true),('SourceSearchChunk',true),('SourceSearchIndex',true),('VisualBackgroundCandidate',true)$old$;
  new_clause := $new$('ScriptRevisionClaim',true),('ScriptRevisionSourceCitation',true),('SourceChunkEmbedding',true),('SourceEvidencePacket',true),('SourceEvidencePacketItem',true),('SourceEvidenceSet',true),('SourceEvidenceSetPacket',true),('SourceEvidenceSpan',true),('SourceSearchChunk',true),('SourceSearchIndex',true),('OutlineRevisionSourceCitation',true),('ArticleVersionSourceCitation',true),('AdaptationRevisionSourceCitation',true),('SourceWritingRequest',true),('VisualBackgroundCandidate',true)$new$;
  fn := pg_get_functiondef('contextflow.purge_project_graph_scoped(uuid,uuid,integer,boolean)'::regprocedure);
  IF length(fn)-length(replace(fn,old_clause,''))<>length(old_clause) THEN RAISE EXCEPTION 'project purge target allowlist changed; review source writing tables before replacement'; END IF;
  patched := replace(fn,old_clause,new_clause);
  EXECUTE patched;
END $$;

REVOKE ALL ON contextflow."SourceEvidenceSet",contextflow."SourceEvidenceSetPacket",contextflow."SourceWritingRequest",
  contextflow."OutlineRevisionSourceCitation",contextflow."ArticleVersionSourceCitation",contextflow."AdaptationRevisionSourceCitation",contextflow."ScriptRevisionSourceCitation" FROM PUBLIC;
REVOKE ALL ON FUNCTION contextflow.guard_source_evidence_set(),contextflow.guard_source_evidence_set_packet(),contextflow.guard_source_evidence_reference(),
  contextflow.guard_source_evidence_unsealed_insert(),contextflow.guard_source_citation_insert(),contextflow.guard_source_evidence_content_seal(),contextflow.guard_source_writing_request() FROM PUBLIC;
DO $$ DECLARE role_name text; BEGIN
  FOREACH role_name IN ARRAY ARRAY['anon','authenticated'] LOOP
    IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname=role_name) THEN
      EXECUTE format('REVOKE ALL ON contextflow."SourceEvidenceSet",contextflow."SourceEvidenceSetPacket",contextflow."SourceWritingRequest",contextflow."OutlineRevisionSourceCitation",contextflow."ArticleVersionSourceCitation",contextflow."AdaptationRevisionSourceCitation",contextflow."ScriptRevisionSourceCitation" FROM %I',role_name);
      EXECUTE format('REVOKE ALL ON FUNCTION contextflow.guard_source_evidence_set(),contextflow.guard_source_evidence_set_packet(),contextflow.guard_source_evidence_reference(),contextflow.guard_source_evidence_unsealed_insert(),contextflow.guard_source_citation_insert(),contextflow.guard_source_evidence_content_seal(),contextflow.guard_source_writing_request() FROM %I',role_name);
    END IF;
  END LOOP;
END $$;
GRANT SELECT,INSERT,UPDATE ON contextflow."SourceEvidenceSet" TO cf_runtime;
GRANT SELECT,INSERT ON contextflow."SourceEvidenceSetPacket",contextflow."OutlineRevisionSourceCitation",contextflow."ArticleVersionSourceCitation",
  contextflow."AdaptationRevisionSourceCitation",contextflow."ScriptRevisionSourceCitation" TO cf_runtime;
GRANT SELECT,INSERT,UPDATE ON contextflow."SourceWritingRequest" TO cf_runtime;
GRANT USAGE ON TYPE contextflow."JobOperation" TO cf_runtime;

COMMIT;



