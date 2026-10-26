BEGIN;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_extension WHERE extname='vector') THEN
    RAISE EXCEPTION 'pgvector must be preinstalled by the database administrator before this migration';
  END IF;
END $$;

ALTER TYPE contextflow."JobOperation" ADD VALUE 'SOURCE_EMBEDDING';
ALTER TYPE contextflow."JobOperation" ADD VALUE 'EVIDENCE_SEARCH';

CREATE TABLE contextflow."SourceSearchIndex" (
  "id" uuid NOT NULL,
  "projectId" uuid NOT NULL,
  "snapshotId" uuid NOT NULL,
  "snapshotSha256" char(64) NOT NULL CHECK ("snapshotSha256" ~ '^[a-f0-9]{64}$'),
  "chunkerVersion" varchar(64) NOT NULL CHECK (length(btrim("chunkerVersion")) BETWEEN 1 AND 64),
  "model" varchar(64) NOT NULL DEFAULT 'gemini-embedding-001' CHECK (length(btrim("model")) BETWEEN 1 AND 64),
  "dimensions" integer NOT NULL DEFAULT 768 CHECK ("dimensions"=768),
  "configDigest" char(64) NOT NULL CHECK ("configDigest" ~ '^[a-f0-9]{64}$'),
  "createdBy" uuid NOT NULL REFERENCES contextflow."UserProfile"("id") ON DELETE RESTRICT ON UPDATE NO ACTION,
  "createdAt" timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "SourceSearchIndex_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "SourceSearchIndex_project_id_key" UNIQUE ("projectId","id"),
  CONSTRAINT "SourceSearchIndex_snapshot_config_key" UNIQUE ("projectId","snapshotId","configDigest"),
  CONSTRAINT "SourceSearchIndex_project_fkey" FOREIGN KEY ("projectId") REFERENCES contextflow."Project"("id") ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT "SourceSearchIndex_snapshot_fkey" FOREIGN KEY ("projectId","snapshotId") REFERENCES contextflow."SourceSnapshot"("projectId","id") ON DELETE RESTRICT ON UPDATE NO ACTION
);

CREATE INDEX "SourceSearchIndex_projectId_snapshotId_createdAt_idx" ON contextflow."SourceSearchIndex" ("projectId","snapshotId","createdAt");

CREATE TABLE contextflow."SourceSearchChunk" (
  "id" uuid NOT NULL,
  "projectId" uuid NOT NULL,
  "indexId" uuid NOT NULL,
  "snapshotId" uuid NOT NULL,
  "snapshotSha256" char(64) NOT NULL CHECK ("snapshotSha256" ~ '^[a-f0-9]{64}$'),
  "ordinal" integer NOT NULL CHECK ("ordinal">=0),
  "startOffset" integer NOT NULL CHECK ("startOffset">=0),
  "endOffset" integer NOT NULL CHECK ("endOffset">"startOffset"),
  "sha256" char(64) NOT NULL CHECK ("sha256" ~ '^[a-f0-9]{64}$'),
  "text" varchar(1536) NOT NULL CHECK (length("text")>0 AND octet_length("text")<=1536),
  "requiresEmbedding" boolean NOT NULL,
  "searchVector" tsvector GENERATED ALWAYS AS (to_tsvector('simple'::regconfig,"text")) STORED,
  CONSTRAINT "SourceSearchChunk_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "SourceSearchChunk_project_id_key" UNIQUE ("projectId","id"),
  CONSTRAINT "SourceSearchChunk_index_ordinal_key" UNIQUE ("projectId","indexId","ordinal"),
  CONSTRAINT "SourceSearchChunk_project_fkey" FOREIGN KEY ("projectId") REFERENCES contextflow."Project"("id") ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT "SourceSearchChunk_index_fkey" FOREIGN KEY ("projectId","indexId") REFERENCES contextflow."SourceSearchIndex"("projectId","id") ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT "SourceSearchChunk_snapshot_fkey" FOREIGN KEY ("projectId","snapshotId") REFERENCES contextflow."SourceSnapshot"("projectId","id") ON DELETE RESTRICT ON UPDATE NO ACTION
);

CREATE INDEX "SourceSearchChunk_projectId_snapshotId_startOffset_idx" ON contextflow."SourceSearchChunk" ("projectId","snapshotId","startOffset");
CREATE INDEX "SourceSearchChunk_searchVector_gin_idx" ON contextflow."SourceSearchChunk" USING gin ("searchVector");

DO $$
DECLARE extension_schema text;
BEGIN
  SELECT n.nspname INTO extension_schema
  FROM pg_catalog.pg_extension e
  JOIN pg_catalog.pg_namespace n ON n.oid=e.extnamespace
  WHERE e.extname='vector';
  IF extension_schema IS NULL THEN
    RAISE EXCEPTION 'pgvector extension is unavailable';
  END IF;

  EXECUTE format($ddl$
    CREATE TABLE contextflow."SourceChunkEmbedding" (
      "projectId" uuid NOT NULL,
      "chunkId" uuid NOT NULL,
      "jobId" uuid NOT NULL,
      "embedding" %1$I.vector(768) NOT NULL,
      "createdAt" timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT "SourceChunkEmbedding_pkey" PRIMARY KEY ("projectId","chunkId"),
      CONSTRAINT "SourceChunkEmbedding_chunk_fkey" FOREIGN KEY ("projectId","chunkId")
        REFERENCES contextflow."SourceSearchChunk"("projectId","id") ON DELETE RESTRICT ON UPDATE NO ACTION,
      CONSTRAINT "SourceChunkEmbedding_job_fkey" FOREIGN KEY ("projectId","jobId")
        REFERENCES contextflow."Job"("projectId","id") ON DELETE RESTRICT ON UPDATE NO ACTION,
      CONSTRAINT "SourceChunkEmbedding_vector_check" CHECK (
        %1$I.vector_dims("embedding")=768
        AND abs(%1$I.vector_norm("embedding")-1.0)<0.00001
      )
    )
  $ddl$, extension_schema);

  EXECUTE format('CREATE INDEX "SourceChunkEmbedding_embedding_hnsw_idx" ON contextflow."SourceChunkEmbedding" USING hnsw ("embedding" %I.vector_cosine_ops) WITH (m=16,ef_construction=64)',extension_schema);

  EXECUTE format($ddl$
    CREATE FUNCTION contextflow.parse_source_vector(input_vector text)
    RETURNS %1$I.vector(768)
    LANGUAGE plpgsql IMMUTABLE STRICT SET search_path=pg_catalog,contextflow
    AS $body$
    DECLARE parsed_vector %1$I.vector(768); magnitude double precision;
    BEGIN
      parsed_vector:=input_vector::%1$I.vector(768);
      IF %1$I.vector_dims(parsed_vector)<>768 THEN RAISE EXCEPTION 'embedding dimension must be 768' USING ERRCODE='23514'; END IF;
      magnitude:=%1$I.vector_norm(parsed_vector);
      IF NOT (magnitude=magnitude AND abs(magnitude-1.0)<0.00001) THEN RAISE EXCEPTION 'embedding must have finite unit norm' USING ERRCODE='23514'; END IF;
      RETURN parsed_vector;
    END
    $body$
  $ddl$,extension_schema);

  EXECUTE format($ddl$
    CREATE FUNCTION contextflow.source_vector_cosine_distance(stored_vector %1$I.vector(768), query_vector text)
    RETURNS double precision
    LANGUAGE SQL IMMUTABLE STRICT SET search_path=pg_catalog,contextflow
    AS $body$ SELECT stored_vector OPERATOR(%1$I.<=>) contextflow.parse_source_vector(query_vector) $body$
  $ddl$,extension_schema);

  EXECUTE format('REVOKE ALL ON FUNCTION contextflow.parse_source_vector(text),contextflow.source_vector_cosine_distance(%I.vector,text) FROM PUBLIC',extension_schema);
  EXECUTE format('GRANT EXECUTE ON FUNCTION contextflow.source_vector_cosine_distance(%I.vector,text) TO cf_runtime',extension_schema);
  IF NOT pg_catalog.has_schema_privilege('cf_runtime',extension_schema,'USAGE') THEN
    RAISE EXCEPTION 'cf_runtime must be provisioned with USAGE on the pgvector schema % before this migration',extension_schema;
  END IF;
END $$;

CREATE TABLE contextflow."SourceEvidenceSpan" (
  "id" uuid NOT NULL,
  "projectId" uuid NOT NULL,
  "snapshotId" uuid NOT NULL,
  "fragmentId" uuid NOT NULL,
  "startOffset" integer NOT NULL CHECK ("startOffset">=0),
  "endOffset" integer NOT NULL CHECK ("endOffset">"startOffset"),
  "quote" text NOT NULL CHECK (length("quote")>0),
  "sha256" char(64) NOT NULL CHECK ("sha256" ~ '^[a-f0-9]{64}$'),
  "snapshotSha256" char(64) NOT NULL CHECK ("snapshotSha256" ~ '^[a-f0-9]{64}$'),
  "createdBy" uuid NOT NULL REFERENCES contextflow."UserProfile"("id") ON DELETE RESTRICT ON UPDATE NO ACTION,
  "createdAt" timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "SourceEvidenceSpan_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "SourceEvidenceSpan_project_id_key" UNIQUE ("projectId","id"),
  CONSTRAINT "SourceEvidenceSpan_snapshot_id_key" UNIQUE ("projectId","snapshotId","id"),
  CONSTRAINT "SourceEvidenceSpan_project_fkey" FOREIGN KEY ("projectId") REFERENCES contextflow."Project"("id") ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT "SourceEvidenceSpan_snapshot_fkey" FOREIGN KEY ("projectId","snapshotId") REFERENCES contextflow."SourceSnapshot"("projectId","id") ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT "SourceEvidenceSpan_fragment_fkey" FOREIGN KEY ("projectId","snapshotId","fragmentId") REFERENCES contextflow."SourceFragment"("projectId","snapshotId","id") ON DELETE RESTRICT ON UPDATE NO ACTION
);

CREATE INDEX "SourceEvidenceSpan_projectId_snapshotId_startOffset_idx" ON contextflow."SourceEvidenceSpan" ("projectId","snapshotId","startOffset");

CREATE TABLE contextflow."SourceEvidencePacket" (
  "id" uuid NOT NULL,
  "projectId" uuid NOT NULL,
  "jobId" uuid NOT NULL,
  "query" text NOT NULL CHECK (length(btrim("query")) BETWEEN 1 AND 4000),
  "manifestJson" jsonb NOT NULL CHECK (jsonb_typeof("manifestJson")='object'),
  "sha256" char(64) NOT NULL CHECK ("sha256" ~ '^[a-f0-9]{64}$'),
  "createdBy" uuid NOT NULL REFERENCES contextflow."UserProfile"("id") ON DELETE RESTRICT ON UPDATE NO ACTION,
  "createdAt" timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "SourceEvidencePacket_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "SourceEvidencePacket_project_id_key" UNIQUE ("projectId","id"),
  CONSTRAINT "SourceEvidencePacket_job_key" UNIQUE ("jobId"),
  CONSTRAINT "SourceEvidencePacket_project_job_key" UNIQUE ("projectId","jobId"),
  CONSTRAINT "SourceEvidencePacket_project_fkey" FOREIGN KEY ("projectId") REFERENCES contextflow."Project"("id") ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT "SourceEvidencePacket_job_fkey" FOREIGN KEY ("projectId","jobId") REFERENCES contextflow."Job"("projectId","id") ON DELETE RESTRICT ON UPDATE NO ACTION
);

CREATE TABLE contextflow."SourceEvidencePacketItem" (
  "projectId" uuid NOT NULL,
  "packetId" uuid NOT NULL,
  "spanId" uuid NOT NULL,
  "ordinal" integer NOT NULL CHECK ("ordinal">=0),
  CONSTRAINT "SourceEvidencePacketItem_pkey" PRIMARY KEY ("projectId","packetId","ordinal"),
  CONSTRAINT "SourceEvidencePacketItem_packet_span_key" UNIQUE ("projectId","packetId","spanId"),
  CONSTRAINT "SourceEvidencePacketItem_packet_fkey" FOREIGN KEY ("projectId","packetId") REFERENCES contextflow."SourceEvidencePacket"("projectId","id") ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT "SourceEvidencePacketItem_span_fkey" FOREIGN KEY ("projectId","spanId") REFERENCES contextflow."SourceEvidenceSpan"("projectId","id") ON DELETE RESTRICT ON UPDATE NO ACTION
);

CREATE INDEX "SourceChunkEmbedding_projectId_jobId_idx" ON contextflow."SourceChunkEmbedding" ("projectId","jobId");

CREATE FUNCTION contextflow.source_evidence_utf16_slice(source_text text, start_units integer, end_units integer)
RETURNS text LANGUAGE plpgsql IMMUTABLE STRICT SET search_path=pg_catalog,contextflow AS $$
DECLARE unit_offset integer:=0; width integer; current_char text; result_text text:=''; start_seen boolean:=false;
BEGIN
  IF start_units<0 OR end_units<=start_units THEN RAISE EXCEPTION 'invalid UTF-16 text range' USING ERRCODE='23514'; END IF;

  -- JavaScript offsets match PostgreSQL character offsets when the source has
  -- only BMP code points, so take this linear slice path for the common case.
  IF source_text !~ U&'[\+010000-\+10FFFF]' THEN
    IF end_units>char_length(source_text) THEN RAISE EXCEPTION 'UTF-16 range exceeds source text' USING ERRCODE='23514'; END IF;
    RETURN substr(source_text,start_units+1,end_units-start_units);
  END IF;

  -- Split once as a streaming set; calling substr(source_text, position, 1)
  -- for every position rescans the growing prefix and becomes quadratic.
  FOR current_char IN
    SELECT character FROM regexp_split_to_table(source_text,'') AS split(character)
  LOOP
    width:=CASE WHEN ascii(current_char)>65535 THEN 2 ELSE 1 END;
    IF unit_offset=start_units THEN start_seen:=true; END IF;
    IF unit_offset<start_units AND unit_offset+width>start_units THEN RAISE EXCEPTION 'UTF-16 range splits a Unicode code point' USING ERRCODE='23514'; END IF;
    IF unit_offset>=start_units AND unit_offset+width<=end_units THEN result_text:=result_text||current_char; END IF;
    IF unit_offset<end_units AND unit_offset+width>end_units THEN RAISE EXCEPTION 'UTF-16 range splits a Unicode code point' USING ERRCODE='23514'; END IF;
    unit_offset:=unit_offset+width;
    IF unit_offset>=end_units THEN EXIT; END IF;
  END LOOP;
  IF unit_offset<end_units OR start_units>unit_offset OR NOT start_seen THEN RAISE EXCEPTION 'UTF-16 range exceeds source text' USING ERRCODE='23514'; END IF;
  RETURN result_text;
END $$;

CREATE FUNCTION contextflow.guard_source_search_chunk() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,contextflow AS $$
DECLARE source_text text; actual_sha char(64); actual_snapshot_sha char(64); index_snapshot uuid; index_snapshot_sha char(64);
BEGIN
  SELECT s."normalizedText",s."sha256",i."snapshotId",i."snapshotSha256"
    INTO source_text,actual_snapshot_sha,index_snapshot,index_snapshot_sha
  FROM contextflow."SourceSnapshot" s
  JOIN contextflow."SourceSearchIndex" i ON i."projectId"=NEW."projectId" AND i."snapshotId"=s."id"
  WHERE s."projectId"=NEW."projectId" AND s."id"=NEW."snapshotId" AND i."id"=NEW."indexId";
  IF NOT FOUND OR index_snapshot<>NEW."snapshotId" OR index_snapshot_sha<>actual_snapshot_sha OR NEW."snapshotSha256"<>actual_snapshot_sha THEN
    RAISE EXCEPTION 'search chunk snapshot/index identity mismatch' USING ERRCODE='23514';
  END IF;
  IF contextflow.source_evidence_utf16_slice(source_text,NEW."startOffset",NEW."endOffset") IS DISTINCT FROM NEW."text" THEN
    RAISE EXCEPTION 'search chunk text does not match its immutable source range' USING ERRCODE='23514';
  END IF;
  IF NEW."requiresEmbedding" IS DISTINCT FROM (length(btrim(NEW."text", U&'\0009\000A\000B\000C\000D\0020\00A0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200A\2028\2029\202F\205F\3000\FEFF'))>0) THEN
    RAISE EXCEPTION 'source chunk embedding flag does not match its content' USING ERRCODE='23514';
  END IF;
  actual_sha:=encode(sha256(convert_to(NEW."text",'UTF8')),'hex');
  IF actual_sha<>NEW."sha256" THEN RAISE EXCEPTION 'search chunk hash mismatch' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END $$;

CREATE FUNCTION contextflow.guard_source_search_index() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,contextflow AS $$
DECLARE snapshot_sha char(64);
BEGIN
  SELECT s."sha256" INTO snapshot_sha FROM contextflow."SourceSnapshot" s
  WHERE s."projectId"=NEW."projectId" AND s."id"=NEW."snapshotId";
  IF NOT FOUND OR snapshot_sha<>NEW."snapshotSha256" THEN
    RAISE EXCEPTION 'search index does not match its immutable source snapshot' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;

CREATE FUNCTION contextflow.guard_source_evidence_span() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,contextflow AS $$
DECLARE source_text text; source_sha char(64); fragment_start integer; fragment_end integer;
BEGIN
  SELECT s."normalizedText",s."sha256",f."startOffset",f."endOffset"
    INTO source_text,source_sha,fragment_start,fragment_end
  FROM contextflow."SourceSnapshot" s
  JOIN contextflow."SourceFragment" f ON f."projectId"=s."projectId" AND f."snapshotId"=s."id"
  WHERE s."projectId"=NEW."projectId" AND s."id"=NEW."snapshotId" AND f."id"=NEW."fragmentId";
  IF NOT FOUND OR NEW."snapshotSha256"<>source_sha OR NEW."startOffset"<fragment_start OR NEW."endOffset">fragment_end THEN
    RAISE EXCEPTION 'evidence span is outside its captured source fragment' USING ERRCODE='23514';
  END IF;
  IF contextflow.source_evidence_utf16_slice(source_text,NEW."startOffset",NEW."endOffset") IS DISTINCT FROM NEW."quote" THEN
    RAISE EXCEPTION 'evidence quote does not match its immutable source range' USING ERRCODE='23514';
  END IF;
  IF encode(sha256(convert_to(NEW."quote",'UTF8')),'hex')<>NEW."sha256" THEN
    RAISE EXCEPTION 'evidence quote hash mismatch' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;

CREATE FUNCTION contextflow.guard_source_evidence_packet() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,contextflow AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM contextflow."Job" j WHERE j."projectId"=NEW."projectId" AND j."id"=NEW."jobId" AND j."operation"::text='EVIDENCE_SEARCH') THEN
    RAISE EXCEPTION 'evidence packet requires an evidence search job' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;

CREATE FUNCTION contextflow.guard_source_embedding_job() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,contextflow AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM contextflow."SourceSearchChunk" c WHERE c."projectId"=NEW."projectId" AND c."id"=NEW."chunkId" AND c."requiresEmbedding") THEN
    RAISE EXCEPTION 'only non-whitespace source chunks may be embedded' USING ERRCODE='23514';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM contextflow."Job" j WHERE j."projectId"=NEW."projectId" AND j."id"=NEW."jobId" AND j."operation"::text='SOURCE_EMBEDDING') THEN
    RAISE EXCEPTION 'chunk embedding requires a source embedding job' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;

CREATE FUNCTION contextflow.guard_source_evidence_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'source search/evidence records are immutable' USING ERRCODE='55000'; END $$;

CREATE TRIGGER "SourceSearchIndex_immutable" BEFORE UPDATE OR DELETE ON contextflow."SourceSearchIndex" FOR EACH ROW EXECUTE FUNCTION contextflow.guard_source_evidence_immutable();
CREATE TRIGGER "SourceSearchIndex_source_guard" BEFORE INSERT ON contextflow."SourceSearchIndex" FOR EACH ROW EXECUTE FUNCTION contextflow.guard_source_search_index();
CREATE TRIGGER "SourceSearchChunk_source_guard" BEFORE INSERT ON contextflow."SourceSearchChunk" FOR EACH ROW EXECUTE FUNCTION contextflow.guard_source_search_chunk();
CREATE TRIGGER "SourceSearchChunk_immutable" BEFORE UPDATE OR DELETE ON contextflow."SourceSearchChunk" FOR EACH ROW EXECUTE FUNCTION contextflow.guard_source_evidence_immutable();
CREATE TRIGGER "SourceChunkEmbedding_job_guard" BEFORE INSERT ON contextflow."SourceChunkEmbedding" FOR EACH ROW EXECUTE FUNCTION contextflow.guard_source_embedding_job();
CREATE TRIGGER "SourceChunkEmbedding_immutable" BEFORE UPDATE OR DELETE ON contextflow."SourceChunkEmbedding" FOR EACH ROW EXECUTE FUNCTION contextflow.guard_source_evidence_immutable();
CREATE TRIGGER "SourceEvidenceSpan_source_guard" BEFORE INSERT ON contextflow."SourceEvidenceSpan" FOR EACH ROW EXECUTE FUNCTION contextflow.guard_source_evidence_span();
CREATE TRIGGER "SourceEvidenceSpan_immutable" BEFORE UPDATE OR DELETE ON contextflow."SourceEvidenceSpan" FOR EACH ROW EXECUTE FUNCTION contextflow.guard_source_evidence_immutable();
CREATE TRIGGER "SourceEvidencePacket_job_guard" BEFORE INSERT ON contextflow."SourceEvidencePacket" FOR EACH ROW EXECUTE FUNCTION contextflow.guard_source_evidence_packet();
CREATE TRIGGER "SourceEvidencePacket_immutable" BEFORE UPDATE OR DELETE ON contextflow."SourceEvidencePacket" FOR EACH ROW EXECUTE FUNCTION contextflow.guard_source_evidence_immutable();
CREATE TRIGGER "SourceEvidencePacketItem_immutable" BEFORE UPDATE OR DELETE ON contextflow."SourceEvidencePacketItem" FOR EACH ROW EXECUTE FUNCTION contextflow.guard_source_evidence_immutable();

REVOKE ALL ON contextflow."SourceSearchIndex",contextflow."SourceSearchChunk",contextflow."SourceChunkEmbedding",contextflow."SourceEvidenceSpan",contextflow."SourceEvidencePacket",contextflow."SourceEvidencePacketItem" FROM PUBLIC;
REVOKE ALL ON FUNCTION contextflow.source_evidence_utf16_slice(text,integer,integer),contextflow.guard_source_search_chunk(),contextflow.guard_source_search_index(),contextflow.guard_source_evidence_span(),contextflow.guard_source_evidence_packet(),contextflow.guard_source_embedding_job(),contextflow.guard_source_evidence_immutable() FROM PUBLIC;
DO $$ DECLARE provider_role text; BEGIN
  FOREACH provider_role IN ARRAY ARRAY['anon','authenticated'] LOOP
    IF to_regrole(provider_role) IS NOT NULL THEN
      EXECUTE format('REVOKE ALL ON contextflow."SourceSearchIndex",contextflow."SourceSearchChunk",contextflow."SourceChunkEmbedding",contextflow."SourceEvidenceSpan",contextflow."SourceEvidencePacket",contextflow."SourceEvidencePacketItem" FROM %I',provider_role);
      EXECUTE format('REVOKE ALL ON TYPE contextflow."JobOperation" FROM %I',provider_role);
      EXECUTE format('REVOKE ALL ON FUNCTION contextflow.parse_source_vector(text) FROM %I',provider_role);
    END IF;
  END LOOP;
END $$;
GRANT SELECT,INSERT ON contextflow."SourceSearchIndex",contextflow."SourceSearchChunk",contextflow."SourceChunkEmbedding",contextflow."SourceEvidenceSpan",contextflow."SourceEvidencePacket",contextflow."SourceEvidencePacketItem" TO cf_runtime;
GRANT EXECUTE ON FUNCTION contextflow.source_evidence_utf16_slice(text,integer,integer) TO cf_runtime;
GRANT EXECUTE ON FUNCTION contextflow.parse_source_vector(text) TO cf_runtime;

DO $$
DECLARE function_source text; original_acl pg_catalog.aclitem[]; updated_acl pg_catalog.aclitem[]; original_security_definer boolean; updated_security_definer boolean; original_config text[]; updated_config text[]; old text; replacement text;
BEGIN
  function_source:=pg_catalog.pg_get_functiondef('contextflow.lock_project_purge_tables()'::pg_catalog.regprocedure);
  SELECT p.proacl,p.prosecdef,p.proconfig INTO original_acl,original_security_definer,original_config FROM pg_catalog.pg_proc p WHERE p.oid='contextflow.lock_project_purge_tables()'::pg_catalog.regprocedure;
  old:=$old$('ScriptRevisionClaim'),('SourceFragment'),('SourceSnapshot')) AS fixed_tables(name) ORDER BY name$old$;
  replacement:=$new$('ScriptRevisionClaim'),('SourceChunkEmbedding'),('SourceEvidencePacket'),('SourceEvidencePacketItem'),('SourceEvidenceSpan'),('SourceFragment'),('SourceSearchChunk'),('SourceSearchIndex'),('SourceSnapshot')) AS fixed_tables(name) ORDER BY name$new$;
  IF pg_catalog.strpos(function_source,old)=0 OR pg_catalog.strpos(pg_catalog.substr(function_source,pg_catalog.strpos(function_source,old)+pg_catalog.length(old)),old)>0 THEN RAISE EXCEPTION 'Project purge lock allowlist changed; refusing source evidence migration'; END IF;
  EXECUTE pg_catalog.replace(function_source,old,replacement);
  SELECT p.proacl,p.prosecdef,p.proconfig INTO updated_acl,updated_security_definer,updated_config FROM pg_catalog.pg_proc p WHERE p.oid='contextflow.lock_project_purge_tables()'::pg_catalog.regprocedure;
  IF updated_acl IS DISTINCT FROM original_acl OR updated_security_definer IS DISTINCT FROM original_security_definer OR updated_config IS DISTINCT FROM original_config THEN RAISE EXCEPTION 'Project purge lock function security changed'; END IF;

  function_source:=pg_catalog.pg_get_functiondef('contextflow.purge_project_graph_scoped(uuid,uuid,integer,boolean)'::pg_catalog.regprocedure);
  SELECT p.proacl,p.prosecdef,p.proconfig INTO original_acl,original_security_definer,original_config FROM pg_catalog.pg_proc p WHERE p.oid='contextflow.purge_project_graph_scoped(uuid,uuid,integer,boolean)'::pg_catalog.regprocedure;
  old:=$old$('ScriptRevisionClaim',true),('VisualBackgroundCandidate',true)$old$;
  replacement:=$new$('ScriptRevisionClaim',true),('SourceChunkEmbedding',true),('SourceEvidencePacket',true),('SourceEvidencePacketItem',true),('SourceEvidenceSpan',true),('SourceSearchChunk',true),('SourceSearchIndex',true),('VisualBackgroundCandidate',true)$new$;
  IF pg_catalog.strpos(function_source,old)=0 OR pg_catalog.strpos(pg_catalog.substr(function_source,pg_catalog.strpos(function_source,old)+pg_catalog.length(old)),old)>0 THEN RAISE EXCEPTION 'Project purge target allowlist changed; refusing source evidence migration'; END IF;
  EXECUTE pg_catalog.replace(function_source,old,replacement);
  SELECT p.proacl,p.prosecdef,p.proconfig INTO updated_acl,updated_security_definer,updated_config FROM pg_catalog.pg_proc p WHERE p.oid='contextflow.purge_project_graph_scoped(uuid,uuid,integer,boolean)'::pg_catalog.regprocedure;
  IF updated_acl IS DISTINCT FROM original_acl OR updated_security_definer IS DISTINCT FROM original_security_definer OR updated_config IS DISTINCT FROM original_config THEN RAISE EXCEPTION 'Project purge function security changed'; END IF;
END $$;

COMMIT;
