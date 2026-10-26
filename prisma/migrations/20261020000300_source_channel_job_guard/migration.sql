BEGIN;
-- Keep historical channel jobs valid and explicitly bind the new operation to
-- its frozen source set, brief and selected channel. Drafts have no job link.
CREATE OR REPLACE FUNCTION contextflow.guard_telegram_inputs() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,contextflow AS $$
BEGIN
 IF TG_TABLE_NAME='AdaptationRevision' THEN
  IF NEW."aiExecutionId" IS NOT NULL AND NOT EXISTS(SELECT 1 FROM contextflow."AIExecution" e
    WHERE e."id"=NEW."aiExecutionId" AND e."projectId"=NEW."projectId" AND e."jobId"=NEW."jobId") THEN
   RAISE EXCEPTION 'adaptation execution must belong to frozen job' USING ERRCODE='23514';
  END IF;
  IF NEW."jobId" IS NOT NULL AND NOT EXISTS(SELECT 1 FROM contextflow."Job" j
    JOIN contextflow."Adaptation" a ON a."projectId"=NEW."projectId" AND a."id"=NEW."adaptationId"
    WHERE j."id"=NEW."jobId" AND j."projectId"=NEW."projectId" AND
      (j."operation"::text='TELEGRAM_GENERATION' OR
       (j."operation"::text='SOURCE_WRITING' AND j."contractVersion"='source-writing-v1'
        AND j."inputManifest"->>'task'='ADAPTATION' AND j."inputManifest"->>'format'=a."format"::text
        AND NEW."sourceEvidenceSetId" IS NOT NULL AND NEW."basisRevisionId" IS NULL AND NEW."contentMode"::text='FACTUAL'
        AND j."inputManifest"->>'briefRevisionId'=NEW."briefRevisionId"::text
        AND j."inputManifest"->>'sourceEvidenceSetId'=NEW."sourceEvidenceSetId"::text))) THEN
   RAISE EXCEPTION 'adaptation job must match its generation contract and frozen inputs' USING ERRCODE='23514';
  END IF;
 END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION contextflow.guard_telegram_inputs() FROM PUBLIC;
COMMIT;
