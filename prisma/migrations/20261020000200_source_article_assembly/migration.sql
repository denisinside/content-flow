BEGIN;

CREATE TABLE contextflow."SourceArticleAssembly" (
  "articleVersionId" uuid PRIMARY KEY,
  "projectId" uuid NOT NULL REFERENCES contextflow."Project"("id") ON DELETE RESTRICT ON UPDATE NO ACTION,
  "requestId" uuid NOT NULL UNIQUE,
  "manifestJson" jsonb NOT NULL,
  "sha256" char(64) NOT NULL CHECK ("sha256" ~ '^[a-f0-9]{64}$'),
  "createdAt" timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE ("projectId","articleVersionId"),
  UNIQUE ("projectId","requestId"),
  FOREIGN KEY ("projectId","articleVersionId") REFERENCES contextflow."ArticleVersion"("projectId","id") ON DELETE RESTRICT ON UPDATE NO ACTION,
  FOREIGN KEY ("projectId","requestId") REFERENCES contextflow."SourceWritingRequest"("projectId","id") ON DELETE RESTRICT ON UPDATE NO ACTION,
  CHECK ("manifestJson"->>'schemaVersion'='source-article-assembly-v1' AND jsonb_typeof("manifestJson"->'sections')='array'
    AND jsonb_array_length("manifestJson"->'sections') BETWEEN 1 AND 30)
);

CREATE FUNCTION contextflow.guard_source_article_assembly() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,contextflow AS $$
DECLARE request_row contextflow."SourceWritingRequest"%ROWTYPE; version_row contextflow."ArticleVersion"%ROWTYPE;
  entry jsonb; ord bigint; job_row contextflow."Job"%ROWTYPE; execution_row contextflow."AIExecution"%ROWTYPE;
BEGIN
  IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'source article assembly receipts are immutable' USING ERRCODE='23514'; END IF;
  SELECT * INTO request_row FROM contextflow."SourceWritingRequest" WHERE "projectId"=NEW."projectId" AND "id"=NEW."requestId" FOR UPDATE;
  SELECT * INTO version_row FROM contextflow."ArticleVersion" WHERE "projectId"=NEW."projectId" AND "id"=NEW."articleVersionId" FOR UPDATE;
  IF request_row."task" IS DISTINCT FROM 'ARTICLE' OR request_row."stage" IS DISTINCT FROM 'GENERATING'
    OR version_row."id" IS NULL OR version_row."approvedAt" IS NOT NULL OR version_row."sourceEvidenceSetId" IS NULL
    OR NOT version_row."sourceEvidenceSealed" OR version_row."origin"::text IS DISTINCT FROM 'AI'
    OR NEW."manifestJson"->>'requestId' IS DISTINCT FROM request_row."id"::text
    OR NEW."manifestJson"->>'requestHash' IS DISTINCT FROM request_row."inputHash"::text
    OR NEW."manifestJson"->>'articleVersionId' IS DISTINCT FROM version_row."id"::text
    OR NEW."manifestJson"->>'articleHash' IS DISTINCT FROM version_row."sha256"::text
    OR NEW."manifestJson"->>'outlineRevisionId' IS DISTINCT FROM version_row."outlineRevisionId"::text
    OR NEW."manifestJson"->>'sourceEvidenceSetId' IS DISTINCT FROM version_row."sourceEvidenceSetId"::text
    OR jsonb_array_length(NEW."manifestJson"->'sections') IS DISTINCT FROM jsonb_array_length(request_row."inputManifestJson"->'outline'->'sections')
    OR (SELECT count(DISTINCT item->>'jobId') FROM jsonb_array_elements(NEW."manifestJson"->'sections') item) <> jsonb_array_length(NEW."manifestJson"->'sections') THEN
    RAISE EXCEPTION 'source article assembly must describe its exact new candidate and complete request' USING ERRCODE='23514';
  END IF;
  FOR entry,ord IN SELECT value,ordinality FROM jsonb_array_elements(NEW."manifestJson"->'sections') WITH ORDINALITY LOOP
    SELECT * INTO job_row FROM contextflow."Job" WHERE "projectId"=NEW."projectId" AND "id"=(entry->>'jobId')::uuid;
    SELECT * INTO execution_row FROM contextflow."AIExecution" WHERE "projectId"=NEW."projectId" AND "id"=(entry->>'executionId')::uuid;
    IF job_row."status"::text IS DISTINCT FROM 'SUCCEEDED' OR job_row."operation"::text IS DISTINCT FROM 'SOURCE_WRITING'
      OR job_row."contractVersion" IS DISTINCT FROM 'source-writing-v1' OR execution_row."status"::text IS DISTINCT FROM 'SUCCEEDED'
      OR execution_row."jobId" IS DISTINCT FROM job_row."id" OR execution_row."inputHash" IS DISTINCT FROM job_row."inputHash"
      OR job_row."inputManifest"->>'task' IS DISTINCT FROM 'SECTION'
      OR job_row."inputManifest"->>'requestId' IS DISTINCT FROM request_row."id"::text
      OR job_row."inputManifest"->>'sectionIndex' IS DISTINCT FROM (ord-1)::text
      OR entry->>'ordinal' IS DISTINCT FROM (ord-1)::text
      OR entry->>'sectionId' IS DISTINCT FROM request_row."inputManifestJson"->'outline'->'sections'->(ord-1)::integer->>'id'
      OR entry->>'sectionId' IS DISTINCT FROM job_row."inputManifest"->'request'->'section'->>'id'
      OR entry->>'inputHash' IS DISTINCT FROM job_row."inputHash"::text
      OR entry->>'executionId' IS DISTINCT FROM job_row."resultRefs"->>'executionId'
      OR entry->>'outputHash' IS DISTINCT FROM job_row."resultRefs"->>'outputHash' THEN
      RAISE EXCEPTION 'source article assembly section differs from its completed frozen job and execution' USING ERRCODE='23514';
    END IF;
  END LOOP;
  RETURN NEW;
END $$;
CREATE TRIGGER "SourceArticleAssembly_guard" BEFORE INSERT OR UPDATE OR DELETE ON contextflow."SourceArticleAssembly"
  FOR EACH ROW EXECUTE FUNCTION contextflow.guard_source_article_assembly();

CREATE FUNCTION contextflow.guard_source_article_assembly_approval() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,contextflow AS $$
BEGIN
  IF NEW."approvedAt" IS NOT NULL AND NEW."sourceEvidenceSetId" IS NOT NULL AND NEW."origin"::text='AI'
    AND NOT EXISTS (SELECT 1 FROM contextflow."SourceArticleAssembly" WHERE "articleVersionId"=NEW."id" AND "projectId"=NEW."projectId") THEN
    RAISE EXCEPTION 'generated source article approval requires its complete assembly receipt' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "ArticleVersion_source_assembly_approval_guard" BEFORE UPDATE ON contextflow."ArticleVersion"
  FOR EACH ROW EXECUTE FUNCTION contextflow.guard_source_article_assembly_approval();

DO $$ DECLARE fn text; patched text; BEGIN
  fn:=pg_get_functiondef('contextflow.lock_project_purge_tables()'::regprocedure);
  patched:=replace(fn,$old$('SourceWritingRequest')) AS fixed_tables(name)$old$,$new$('SourceWritingRequest'),('SourceArticleAssembly')) AS fixed_tables(name)$new$);
  IF fn=patched THEN RAISE EXCEPTION 'review current purge lock allowlist before adding assembly'; END IF;
  EXECUTE patched;
  fn:=pg_get_functiondef('contextflow.purge_project_graph_scoped(uuid,uuid,integer,boolean)'::regprocedure);
  patched:=replace(fn,$old$('SourceWritingRequest',true)$old$,$new$('SourceWritingRequest',true),('SourceArticleAssembly',true)$new$);
  IF fn=patched THEN RAISE EXCEPTION 'review current purge delete allowlist before adding assembly'; END IF;
  EXECUTE patched;
END $$;

REVOKE ALL ON contextflow."SourceArticleAssembly" FROM PUBLIC;
REVOKE ALL ON FUNCTION contextflow.guard_source_article_assembly(),contextflow.guard_source_article_assembly_approval() FROM PUBLIC;
DO $$ DECLARE role_name text; BEGIN
  FOREACH role_name IN ARRAY ARRAY['anon','authenticated'] LOOP
    IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname=role_name) THEN
      EXECUTE format('REVOKE ALL ON contextflow."SourceArticleAssembly" FROM %I',role_name);
      EXECUTE format('REVOKE ALL ON FUNCTION contextflow.guard_source_article_assembly(),contextflow.guard_source_article_assembly_approval() FROM %I',role_name);
    END IF;
  END LOOP;
END $$;
GRANT SELECT,INSERT ON contextflow."SourceArticleAssembly" TO cf_runtime;
COMMIT;
