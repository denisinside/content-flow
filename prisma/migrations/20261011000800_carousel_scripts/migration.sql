ALTER TYPE contextflow."ExportFormat" ADD VALUE 'JSON';

BEGIN;
SET LOCAL search_path TO contextflow;

ALTER TABLE "Adaptation" DROP CONSTRAINT "Adaptation_format_check";
ALTER TABLE "Adaptation" ADD CONSTRAINT "Adaptation_format_check" CHECK ("format" IN
 ('TELEGRAM_POST','LINKEDIN_TEXT','LINKEDIN_COVER','INSTAGRAM_COVER','LINKEDIN_CAROUSEL','INSTAGRAM_CAROUSEL','INSTAGRAM_STORIES'));

CREATE OR REPLACE FUNCTION guard_adaptation_format_content() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE selected_format contextflow."ProjectFormat";
DECLARE frame_cover BOOLEAN;
BEGIN
 SELECT "format" INTO selected_format FROM contextflow."Adaptation" WHERE "id"=NEW."adaptationId" AND "projectId"=NEW."projectId";
 IF selected_format IS NULL THEN RAISE EXCEPTION 'adaptation format is missing' USING ERRCODE='23503'; END IF;
 IF jsonb_typeof(NEW."content") IS DISTINCT FROM 'object' OR jsonb_typeof(NEW."content"->'text') IS DISTINCT FROM 'string'
   OR length(btrim(NEW."content"->>'text'))=0 OR length(NEW."content"->>'text')>(CASE WHEN selected_format='TELEGRAM_POST' THEN 4096 ELSE 10000 END)
   OR jsonb_typeof(NEW."content"->'mappings') IS DISTINCT FROM 'array' OR jsonb_array_length(NEW."content"->'mappings')>100 THEN
   RAISE EXCEPTION 'adaptation caption content shape is invalid' USING ERRCODE='23514';
 END IF;
 frame_cover:=selected_format IN ('LINKEDIN_COVER','INSTAGRAM_COVER');
 IF frame_cover<>(NEW."content" ? 'cover') THEN RAISE EXCEPTION 'cover data must match the selected publication format' USING ERRCODE='23514'; END IF;
 IF frame_cover AND (jsonb_typeof(NEW."content"->'cover') IS DISTINCT FROM 'object'
   OR jsonb_typeof(NEW."content"->'cover'->'text') IS DISTINCT FROM 'string' OR length(NEW."content"->'cover'->>'text')>200
   OR jsonb_typeof(NEW."content"->'cover'->'instruction') IS DISTINCT FROM 'string' OR length(NEW."content"->'cover'->>'instruction')>2000) THEN
   RAISE EXCEPTION 'cover copy or instruction is invalid' USING ERRCODE='23514';
 END IF;
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(NEW."content"->'mappings') map
   WHERE COALESCE(map->>'field','text') NOT IN ('text','cover') OR COALESCE(map->>'field','text')='cover' AND NOT frame_cover) THEN
   RAISE EXCEPTION 'adaptation evidence mapping field is invalid' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;

CREATE FUNCTION utf16_length(value TEXT) RETURNS INTEGER LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE i INTEGER; n INTEGER:=0; c TEXT;
BEGIN
 IF value IS NULL THEN RETURN NULL; END IF;
 FOR i IN 1..char_length(value) LOOP c:=substr(value,i,1); n:=n+CASE WHEN ascii(c)>65535 THEN 2 ELSE 1 END; END LOOP;
 RETURN n;
END $$;

CREATE FUNCTION utf16_slice(value TEXT, start_offset INTEGER, end_offset INTEGER) RETURNS TEXT LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE i INTEGER; pos INTEGER:=0; width INTEGER; c TEXT; result TEXT:='';
BEGIN
 IF value IS NULL OR start_offset<0 OR end_offset<=start_offset THEN RETURN NULL; END IF;
 FOR i IN 1..char_length(value) LOOP
  c:=substr(value,i,1); width:=CASE WHEN ascii(c)>65535 THEN 2 ELSE 1 END;
  IF pos<start_offset AND pos+width>start_offset OR pos<end_offset AND pos+width>end_offset THEN RETURN NULL; END IF;
  IF pos>=start_offset AND pos+width<=end_offset THEN result:=result||c; END IF;
  pos:=pos+width;
 END LOOP;
 IF end_offset>pos THEN RETURN NULL; END IF;
 RETURN result;
END $$;

CREATE FUNCTION script_content_valid(content JSONB) RETURNS BOOLEAN LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE frame JSONB; frame_id TEXT; seen TEXT[]:='{}'; total_text INTEGER:=0; total_maps INTEGER:=0;
BEGIN
 IF jsonb_typeof(content) IS DISTINCT FROM 'object' OR jsonb_typeof(content->'frames') IS DISTINCT FROM 'array' OR jsonb_array_length(content->'frames') NOT BETWEEN 1 AND 30 THEN RETURN false; END IF;
 FOR frame IN SELECT value FROM jsonb_array_elements(content->'frames') LOOP
  frame_id:=frame->>'id';
  IF jsonb_typeof(frame) IS DISTINCT FROM 'object' OR frame_id IS NULL OR frame_id !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
   OR frame_id=ANY(seen) OR length(btrim(frame->>'purpose')) NOT BETWEEN 1 AND 200
   OR jsonb_typeof(frame->'purpose') IS DISTINCT FROM 'string'
   OR jsonb_typeof(frame->'text') IS DISTINCT FROM 'string' OR length(btrim(frame->>'text'))=0 OR utf16_length(frame->>'text')>3000
   OR jsonb_typeof(frame->'visualHint') IS DISTINCT FROM 'string' OR utf16_length(frame->>'visualHint')>1000
   OR jsonb_typeof(frame->'transition') IS DISTINCT FROM 'string' OR utf16_length(frame->>'transition')>300
   OR jsonb_typeof(frame->'mappings') IS DISTINCT FROM 'array' OR jsonb_array_length(frame->'mappings')>100 THEN RETURN false; END IF;
  seen:=array_append(seen,frame_id); total_text:=total_text+utf16_length(frame->>'text'); total_maps:=total_maps+jsonb_array_length(frame->'mappings');
 END LOOP;
 RETURN total_text<=30000 AND total_maps<=100;
END $$;

CREATE TABLE "Script" (
 "id" UUID NOT NULL,
 "projectId" UUID NOT NULL,
 "format" "ProjectFormat" NOT NULL,
 "revision" INTEGER NOT NULL DEFAULT 0,
 "currentApprovedRevisionId" UUID,
 CONSTRAINT "Script_pkey" PRIMARY KEY("id"),
 CONSTRAINT "Script_format_check" CHECK("format" IN ('LINKEDIN_CAROUSEL','INSTAGRAM_CAROUSEL','INSTAGRAM_STORIES')),
 CONSTRAINT "Script_revision_check" CHECK("revision">=0),
 CONSTRAINT "Script_project_fk" FOREIGN KEY("projectId") REFERENCES "Project"("id") ON DELETE RESTRICT ON UPDATE NO ACTION,
 CONSTRAINT "Script_project_format_unique" UNIQUE("projectId","format"),
 CONSTRAINT "Script_project_id_unique" UNIQUE("projectId","id")
);

CREATE TABLE "ScriptDraft" (
 "id" UUID NOT NULL,
 "projectId" UUID NOT NULL,
 "scriptId" UUID NOT NULL,
 "counter" INTEGER NOT NULL DEFAULT 0,
 "parentAdaptationRevisionId" UUID NOT NULL,
 "parentAdaptationRevisionHash" CHAR(64) NOT NULL,
 "parentAdaptationReviewCounter" INTEGER NOT NULL,
 "baseRevisionId" UUID,
 "content" JSONB NOT NULL,
 "sha256" CHAR(64) NOT NULL,
 "updatedBy" UUID NOT NULL,
 "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 CONSTRAINT "ScriptDraft_pkey" PRIMARY KEY("id"),
 CONSTRAINT "ScriptDraft_project_id_unique" UNIQUE("projectId","id"),
 CONSTRAINT "ScriptDraft_script_unique" UNIQUE("scriptId"),
 CONSTRAINT "ScriptDraft_script_project_fk" FOREIGN KEY("projectId","scriptId") REFERENCES "Script"("projectId","id") ON DELETE RESTRICT ON UPDATE NO ACTION,
 CONSTRAINT "ScriptDraft_parent_fk" FOREIGN KEY("projectId","parentAdaptationRevisionId") REFERENCES "AdaptationRevision"("projectId","id") ON DELETE RESTRICT ON UPDATE NO ACTION,
 CONSTRAINT "ScriptDraft_editor_fk" FOREIGN KEY("updatedBy") REFERENCES "UserProfile"("id") ON DELETE RESTRICT ON UPDATE NO ACTION,
 CONSTRAINT "ScriptDraft_shape_check" CHECK("counter">=0 AND "parentAdaptationReviewCounter">=0 AND "sha256"~'^[a-f0-9]{64}$' AND "parentAdaptationRevisionHash"~'^[a-f0-9]{64}$'
   AND octet_length("content"::text)<=280000 AND COALESCE(contextflow.script_content_valid("content"),false))
);

CREATE TABLE "ScriptRevision" (
 "id" UUID NOT NULL,
 "projectId" UUID NOT NULL,
 "scriptId" UUID NOT NULL,
 "number" INTEGER NOT NULL,
 "parentAdaptationRevisionId" UUID NOT NULL,
 "parentAdaptationRevisionHash" CHAR(64) NOT NULL,
 "parentAdaptationReviewCounter" INTEGER NOT NULL,
 "content" JSONB NOT NULL,
 "sha256" CHAR(64) NOT NULL,
 "createdBy" UUID NOT NULL,
 "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 "origin" contextflow."EditorialOrigin" NOT NULL,
 "jobId" UUID,
 "aiExecutionId" UUID,
 "approvedBy" UUID,
 "approvedAt" TIMESTAMPTZ(3),
 "acknowledgedUnmapped" BOOLEAN NOT NULL DEFAULT false,
 "withdrawnBy" UUID,
 "withdrawnAt" TIMESTAMPTZ(3),
 "withdrawalReason" VARCHAR(2000),
 "claimsSealed" BOOLEAN NOT NULL DEFAULT false,
 "reviewCounter" INTEGER NOT NULL DEFAULT 0,
 CONSTRAINT "ScriptRevision_pkey" PRIMARY KEY("id"),
 CONSTRAINT "ScriptRevision_project_id_unique" UNIQUE("projectId","id"),
 CONSTRAINT "ScriptRevision_project_script_id_unique" UNIQUE("projectId","scriptId","id"),
 CONSTRAINT "ScriptRevision_number_unique" UNIQUE("scriptId","number"),
 CONSTRAINT "ScriptRevision_job_unique" UNIQUE("jobId"),
 CONSTRAINT "ScriptRevision_script_project_fk" FOREIGN KEY("projectId","scriptId") REFERENCES "Script"("projectId","id") ON DELETE RESTRICT ON UPDATE NO ACTION,
 CONSTRAINT "ScriptRevision_parent_fk" FOREIGN KEY("projectId","parentAdaptationRevisionId") REFERENCES "AdaptationRevision"("projectId","id") ON DELETE RESTRICT ON UPDATE NO ACTION,
 CONSTRAINT "ScriptRevision_creator_fk" FOREIGN KEY("createdBy") REFERENCES "UserProfile"("id") ON DELETE RESTRICT ON UPDATE NO ACTION,
 CONSTRAINT "ScriptRevision_job_fk" FOREIGN KEY("projectId","jobId") REFERENCES "Job"("projectId","id") ON DELETE RESTRICT ON UPDATE NO ACTION,
 CONSTRAINT "ScriptRevision_execution_fk" FOREIGN KEY("projectId","aiExecutionId") REFERENCES "AIExecution"("projectId","id") ON DELETE RESTRICT ON UPDATE NO ACTION,
 CONSTRAINT "ScriptRevision_approver_fk" FOREIGN KEY("approvedBy") REFERENCES "UserProfile"("id") ON DELETE RESTRICT ON UPDATE NO ACTION,
 CONSTRAINT "ScriptRevision_withdrawer_fk" FOREIGN KEY("withdrawnBy") REFERENCES "UserProfile"("id") ON DELETE RESTRICT ON UPDATE NO ACTION,
 CONSTRAINT "ScriptRevision_shape_check" CHECK("number">0 AND "reviewCounter">=0 AND "parentAdaptationReviewCounter">=0 AND "sha256"~'^[a-f0-9]{64}$'
   AND "parentAdaptationRevisionHash"~'^[a-f0-9]{64}$' AND octet_length("content"::text)<=280000 AND COALESCE(contextflow.script_content_valid("content"),false)
   AND (("approvedAt" IS NULL AND "approvedBy" IS NULL) OR ("approvedAt" IS NOT NULL AND "approvedBy" IS NOT NULL))
   AND (("withdrawnAt" IS NULL AND "withdrawnBy" IS NULL) OR ("withdrawnAt" IS NOT NULL AND "withdrawnBy" IS NOT NULL)))
);

ALTER TABLE "ScriptDraft" ADD CONSTRAINT "ScriptDraft_base_fk" FOREIGN KEY("projectId","scriptId","baseRevisionId")
 REFERENCES "ScriptRevision"("projectId","scriptId","id") ON DELETE RESTRICT ON UPDATE NO ACTION;

ALTER TABLE "Script" ADD CONSTRAINT "Script_current_approved_fk" FOREIGN KEY("projectId","id","currentApprovedRevisionId")
 REFERENCES "ScriptRevision"("projectId","scriptId","id") ON DELETE RESTRICT ON UPDATE NO ACTION;

CREATE TABLE "ScriptRevisionClaim" (
 "projectId" UUID NOT NULL,
 "revisionId" UUID NOT NULL,
 "frameId" UUID NOT NULL,
 "mappingIndex" INTEGER NOT NULL,
 "locator" VARCHAR(240) NOT NULL,
 "startOffset" INTEGER NOT NULL,
 "endOffset" INTEGER NOT NULL,
 "claimRevisionId" UUID NOT NULL,
 "evidenceId" UUID NOT NULL,
 "quote" VARCHAR(10000) NOT NULL,
 "linkedText" TEXT NOT NULL,
 CONSTRAINT "ScriptRevisionClaim_pkey" PRIMARY KEY("revisionId","frameId","mappingIndex"),
 CONSTRAINT "ScriptRevisionClaim_revision_fk" FOREIGN KEY("projectId","revisionId") REFERENCES "ScriptRevision"("projectId","id") ON DELETE RESTRICT ON UPDATE NO ACTION,
 CONSTRAINT "ScriptRevisionClaim_claim_fk" FOREIGN KEY("projectId","claimRevisionId") REFERENCES "ClaimRevision"("projectId","id") ON DELETE RESTRICT ON UPDATE NO ACTION,
 CONSTRAINT "ScriptRevisionClaim_evidence_fk" FOREIGN KEY("projectId","claimRevisionId","evidenceId") REFERENCES "ClaimEvidence"("projectId","claimRevisionId","id") ON DELETE RESTRICT ON UPDATE NO ACTION,
 CONSTRAINT "ScriptRevisionClaim_shape_check" CHECK("mappingIndex">=0 AND "startOffset">=0 AND "endOffset">"startOffset" AND length(btrim("locator"))>0 AND length("quote")>0 AND length("linkedText")>0 AND "quote"="linkedText")
);

CREATE FUNCTION guard_script_draft() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE parent contextflow."AdaptationRevision"%ROWTYPE;
DECLARE selected_format contextflow."ProjectFormat";
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'script drafts are retained' USING ERRCODE='23514'; END IF;
 IF TG_OP='UPDATE' AND (NEW."id"<>OLD."id" OR NEW."projectId"<>OLD."projectId" OR NEW."scriptId"<>OLD."scriptId" OR NEW."counter"<>OLD."counter"+1) THEN
   RAISE EXCEPTION 'script draft identity is fixed and counter advances once' USING ERRCODE='23514';
 END IF;
 SELECT s."format" INTO selected_format FROM contextflow."Script" s WHERE s."id"=NEW."scriptId" AND s."projectId"=NEW."projectId";
 SELECT r.* INTO parent FROM contextflow."AdaptationRevision" r JOIN contextflow."Adaptation" a ON a."id"=r."adaptationId" AND a."projectId"=r."projectId"
  WHERE r."id"=NEW."parentAdaptationRevisionId" AND r."projectId"=NEW."projectId" AND a."format"=selected_format;
 IF parent."id" IS NULL OR parent."sha256"<>NEW."parentAdaptationRevisionHash" OR parent."approvedAt" IS NULL OR parent."withdrawnAt" IS NOT NULL
   OR parent."reviewCounter"<>NEW."parentAdaptationReviewCounter"
   OR NOT EXISTS(SELECT 1 FROM contextflow."Adaptation" a WHERE a."projectId"=NEW."projectId" AND a."format"=selected_format AND a."currentApprovedRevisionId"=parent."id") THEN
   RAISE EXCEPTION 'script draft requires current approved exact caption parent' USING ERRCODE='23514';
 END IF;
 IF NEW."baseRevisionId" IS NOT NULL AND NOT EXISTS(SELECT 1 FROM contextflow."ScriptRevision" r WHERE r."id"=NEW."baseRevisionId" AND r."scriptId"=NEW."scriptId" AND r."projectId"=NEW."projectId") THEN
   RAISE EXCEPTION 'script draft base revision must belong to its script' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER "ScriptDraft_parent_guard" BEFORE INSERT OR UPDATE ON "ScriptDraft" FOR EACH ROW EXECUTE FUNCTION guard_script_draft();

CREATE FUNCTION guard_script_revision() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE parent contextflow."AdaptationRevision"%ROWTYPE;
DECLARE selected_format contextflow."ProjectFormat";
DECLARE draft contextflow."ScriptDraft"%ROWTYPE;
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'script revisions are immutable' USING ERRCODE='23514'; END IF;
 SELECT s."format" INTO selected_format FROM contextflow."Script" s WHERE s."id"=NEW."scriptId" AND s."projectId"=NEW."projectId";
 SELECT r.* INTO parent FROM contextflow."AdaptationRevision" r JOIN contextflow."Adaptation" a ON a."id"=r."adaptationId" AND a."projectId"=r."projectId"
  WHERE r."id"=NEW."parentAdaptationRevisionId" AND r."projectId"=NEW."projectId" AND a."format"=selected_format;
 IF TG_OP='INSERT' THEN
   IF NEW."approvedAt" IS NOT NULL OR NEW."withdrawnAt" IS NOT NULL OR NEW."claimsSealed" OR parent."id" IS NULL
    OR parent."sha256"<>NEW."parentAdaptationRevisionHash" OR parent."withdrawnAt" IS NOT NULL
    OR NEW."parentAdaptationReviewCounter"<>parent."reviewCounter"
    OR (NEW."origin"='MANUAL' AND (parent."approvedAt" IS NULL OR NOT EXISTS(SELECT 1 FROM contextflow."Adaptation" a WHERE a."projectId"=NEW."projectId" AND a."format"=selected_format AND a."currentApprovedRevisionId"=parent."id")))
    OR (NEW."origin"='AI' AND (NEW."jobId" IS NULL OR parent."jobId" IS DISTINCT FROM NEW."jobId" OR parent."aiExecutionId" IS DISTINCT FROM NEW."aiExecutionId")) THEN
     RAISE EXCEPTION 'script revision must begin against approved caption or exact generated caption candidate' USING ERRCODE='23514';
   END IF;
   RETURN NEW;
 END IF;
 IF (to_jsonb(NEW)-ARRAY['approvedBy','approvedAt','acknowledgedUnmapped','withdrawnBy','withdrawnAt','withdrawalReason','claimsSealed'])
     IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['approvedBy','approvedAt','acknowledgedUnmapped','withdrawnBy','withdrawnAt','withdrawalReason','claimsSealed'])
    OR NEW."reviewCounter"<>0 OR OLD."reviewCounter"<>0 THEN
   RAISE EXCEPTION 'script revision content and provenance are immutable' USING ERRCODE='23514';
 END IF;
 IF NOT OLD."claimsSealed" AND NEW."claimsSealed" THEN
   IF (SELECT count(*) FROM contextflow."ScriptRevisionClaim" c WHERE c."revisionId"=NEW."id" AND c."projectId"=NEW."projectId") <>
      (SELECT sum(jsonb_array_length(f->'mappings')) FROM jsonb_array_elements(NEW."content"->'frames') f)
     OR EXISTS(SELECT 1 FROM contextflow."ScriptRevisionClaim" c WHERE c."revisionId"=NEW."id" AND c."projectId"=NEW."projectId"
       AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(NEW."content"->'frames') f, jsonb_array_elements(f->'mappings') WITH ORDINALITY m(value,ordinality)
         WHERE f->>'id'=c."frameId"::text AND m.ordinality-1=c."mappingIndex" AND m.value->>'claimRevisionId'=c."claimRevisionId"::text
           AND m.value->>'evidenceId'=c."evidenceId"::text AND m.value->>'quote'=c."quote"
           AND (m.value->>'startOffset')::integer=c."startOffset" AND (m.value->>'endOffset')::integer=c."endOffset")) THEN
     RAISE EXCEPTION 'script content and sealed evidence edges differ' USING ERRCODE='23514';
   END IF;
 ELSIF OLD."claimsSealed" AND NOT NEW."claimsSealed" THEN RAISE EXCEPTION 'script evidence seal is irreversible' USING ERRCODE='23514';
 END IF;
 IF OLD."approvedAt" IS NULL AND NEW."approvedAt" IS NOT NULL THEN
   SELECT * INTO draft FROM contextflow."ScriptDraft" d WHERE d."scriptId"=NEW."scriptId" AND d."projectId"=NEW."projectId";
   IF NOT NEW."claimsSealed" OR NEW."withdrawnAt" IS NOT NULL OR draft."id" IS NULL OR draft."baseRevisionId" IS DISTINCT FROM NEW."id" OR draft."sha256" IS DISTINCT FROM NEW."sha256"
      OR draft."parentAdaptationRevisionId" IS DISTINCT FROM NEW."parentAdaptationRevisionId" OR draft."parentAdaptationRevisionHash" IS DISTINCT FROM NEW."parentAdaptationRevisionHash"
      OR draft."parentAdaptationReviewCounter" IS DISTINCT FROM NEW."parentAdaptationReviewCounter"
      OR parent."reviewCounter"<>NEW."parentAdaptationReviewCounter" OR NOT EXISTS(SELECT 1 FROM contextflow."Adaptation" a WHERE a."projectId"=NEW."projectId" AND a."format"=selected_format AND a."currentApprovedRevisionId"=parent."id")
      OR (to_jsonb(NEW)-ARRAY['approvedBy','approvedAt','acknowledgedUnmapped']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['approvedBy','approvedAt','acknowledgedUnmapped']) THEN
     RAISE EXCEPTION 'only exact current sealed script checkpoint may be approved' USING ERRCODE='23514'; END IF;
 ELSIF OLD."approvedAt" IS NOT NULL THEN
   IF (to_jsonb(NEW)-ARRAY['withdrawnBy','withdrawnAt','withdrawalReason']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['withdrawnBy','withdrawnAt','withdrawalReason']) THEN
     RAISE EXCEPTION 'approved script metadata is immutable' USING ERRCODE='23514';
   END IF;
   IF NEW."withdrawnAt" IS NOT NULL AND (OLD."withdrawnAt" IS NOT NULL OR NEW."withdrawnBy" IS NULL OR NEW."withdrawnAt" IS NULL) THEN
     RAISE EXCEPTION 'script withdrawal is terminal' USING ERRCODE='23514';
   END IF;
 ELSIF NEW."approvedAt" IS NOT NULL OR NEW."approvedBy" IS NOT NULL OR NEW."acknowledgedUnmapped" OR NEW."withdrawnAt" IS NOT NULL OR NEW."withdrawnBy" IS NOT NULL THEN
   RAISE EXCEPTION 'script approval transition is invalid' USING ERRCODE='23514';
 END IF;
 IF OLD."withdrawnAt" IS NOT NULL AND (NEW."withdrawnAt" IS DISTINCT FROM OLD."withdrawnAt" OR NEW."withdrawnBy" IS DISTINCT FROM OLD."withdrawnBy" OR NEW."withdrawalReason" IS DISTINCT FROM OLD."withdrawalReason") THEN
   RAISE EXCEPTION 'script withdrawal is terminal' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER "ScriptRevision_guard" BEFORE INSERT OR UPDATE OR DELETE ON "ScriptRevision" FOR EACH ROW EXECUTE FUNCTION guard_script_revision();

CREATE FUNCTION guard_script_aggregate() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'scripts are retained' USING ERRCODE='23514'; END IF;
 IF TG_OP='INSERT' THEN
  IF NEW."revision"<>0 OR NEW."currentApprovedRevisionId" IS NOT NULL THEN RAISE EXCEPTION 'script aggregate must start empty' USING ERRCODE='23514'; END IF;
  IF NOT EXISTS(SELECT 1 FROM contextflow."Project" p WHERE p."id"=NEW."projectId" AND NEW."format"=ANY(p."formats")) THEN RAISE EXCEPTION 'select script format on project' USING ERRCODE='23514'; END IF;
  RETURN NEW;
 END IF;
 IF NEW."projectId"<>OLD."projectId" OR NEW."format"<>OLD."format" OR NEW."revision"<>OLD."revision"+1
  OR (OLD."currentApprovedRevisionId" IS NOT NULL AND NEW."currentApprovedRevisionId" IS NULL
    AND NOT EXISTS(SELECT 1 FROM contextflow."ScriptRevision" r WHERE r."id"=OLD."currentApprovedRevisionId" AND r."scriptId"=OLD."id" AND r."withdrawnAt" IS NOT NULL))
  OR (NEW."currentApprovedRevisionId" IS NOT NULL AND NOT EXISTS(SELECT 1 FROM contextflow."ScriptRevision" r WHERE r."id"=NEW."currentApprovedRevisionId" AND r."scriptId"=NEW."id" AND r."approvedAt" IS NOT NULL AND r."withdrawnAt" IS NULL)) THEN
   RAISE EXCEPTION 'script aggregate pointer or identity is invalid' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER "Script_guard" BEFORE INSERT OR UPDATE OR DELETE ON "Script" FOR EACH ROW EXECUTE FUNCTION guard_script_aggregate();

CREATE FUNCTION guard_script_revision_claim() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE parent contextflow."AdaptationRevision"%ROWTYPE;
DECLARE frame_text TEXT;
DECLARE mapping JSONB;
BEGIN
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'script revision evidence is immutable' USING ERRCODE='23514'; END IF;
 IF EXISTS(SELECT 1 FROM contextflow."ScriptRevision" r WHERE r."id"=NEW."revisionId" AND r."projectId"=NEW."projectId" AND r."claimsSealed") THEN
  RAISE EXCEPTION 'script evidence is already sealed' USING ERRCODE='23514';
 END IF;
 SELECT p.* INTO parent FROM contextflow."ScriptRevision" s JOIN contextflow."AdaptationRevision" p ON p."id"=s."parentAdaptationRevisionId" AND p."projectId"=s."projectId" WHERE s."id"=NEW."revisionId" AND s."projectId"=NEW."projectId";
 SELECT f->>'text' INTO frame_text FROM contextflow."ScriptRevision" s, LATERAL jsonb_array_elements(s."content"->'frames') f WHERE s."id"=NEW."revisionId" AND f->>'id'=NEW."frameId"::text;
 SELECT m.value INTO mapping FROM contextflow."ScriptRevision" s, LATERAL jsonb_array_elements(s."content"->'frames') f,
   LATERAL jsonb_array_elements(f->'mappings') WITH ORDINALITY m(value,ordinality)
   WHERE s."id"=NEW."revisionId" AND f->>'id'=NEW."frameId"::text AND m.ordinality-1=NEW."mappingIndex";
 IF mapping IS NULL OR (mapping->>'startOffset')::integer<>NEW."startOffset" OR (mapping->>'endOffset')::integer<>NEW."endOffset"
   OR mapping->>'claimRevisionId'<>NEW."claimRevisionId"::text OR mapping->>'evidenceId'<>NEW."evidenceId"::text OR mapping->>'quote'<>NEW."quote"
   OR parent."id" IS NULL OR parent."contentMode"<>'FACTUAL' OR parent."basisRevisionId" IS NULL OR contextflow.utf16_slice(frame_text,NEW."startOffset",NEW."endOffset") IS DISTINCT FROM NEW."quote"
   OR NEW."linkedText"<>NEW."quote"
   OR NOT EXISTS(SELECT 1 FROM contextflow."BasisClaimEvidence" b JOIN contextflow."ClaimRevision" c ON c."id"=b."claimRevisionId" AND c."projectId"=b."projectId"
      JOIN contextflow."ClaimEvidence" e ON e."id"=b."evidenceId" AND e."projectId"=b."projectId" AND e."claimRevisionId"=b."claimRevisionId"
      WHERE b."projectId"=NEW."projectId" AND b."basisId"=parent."basisRevisionId" AND b."claimRevisionId"=NEW."claimRevisionId" AND b."evidenceId"=NEW."evidenceId"
        AND c."status"='APPROVED' AND c."approvedAt" IS NOT NULL AND c."withdrawnAt" IS NULL AND c."rejectedAt" IS NULL AND e."invalidatedAt" IS NULL AND e."relation"='SUPPORTS')
   OR (parent."sourceArticleVersionId" IS NOT NULL AND NOT EXISTS(SELECT 1 FROM contextflow."ArticleVersionClaim" a WHERE a."projectId"=NEW."projectId" AND a."articleVersionId"=parent."sourceArticleVersionId" AND a."claimRevisionId"=NEW."claimRevisionId" AND a."evidenceId"=NEW."evidenceId")) THEN
  RAISE EXCEPTION 'script evidence must match a stable frame locator and exact factual parent inputs' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER "ScriptRevisionClaim_guard" BEFORE INSERT OR UPDATE OR DELETE ON "ScriptRevisionClaim" FOR EACH ROW EXECUTE FUNCTION guard_script_revision_claim();

CREATE TABLE "ScriptLanguageSuggestion" (
 "id" UUID NOT NULL,
 "projectId" UUID NOT NULL,
 "sourceRevisionId" UUID NOT NULL,
 "frameId" UUID NOT NULL,
 "contentHash" CHAR(64) NOT NULL,
 "startOffset" INTEGER NOT NULL,
 "endOffset" INTEGER NOT NULL,
 "originalText" VARCHAR(1000) NOT NULL,
 "replacementText" VARCHAR(1000) NOT NULL,
 "finding" VARCHAR(200) NOT NULL,
 "status" "LanguageSuggestionStatus" NOT NULL DEFAULT 'OPEN',
 "createdBy" UUID NOT NULL,
 "decidedBy" UUID,
 "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 "decidedAt" TIMESTAMPTZ(3),
 CONSTRAINT "ScriptLanguageSuggestion_pkey" PRIMARY KEY("id"),
 CONSTRAINT "ScriptLanguageSuggestion_project_id_unique" UNIQUE("projectId","id"),
 CONSTRAINT "ScriptLanguageSuggestion_source_fk" FOREIGN KEY("projectId","sourceRevisionId") REFERENCES "ScriptRevision"("projectId","id") ON DELETE RESTRICT ON UPDATE NO ACTION,
 CONSTRAINT "ScriptLanguageSuggestion_project_fk" FOREIGN KEY("projectId") REFERENCES "Project"("id") ON DELETE RESTRICT ON UPDATE NO ACTION,
 CONSTRAINT "ScriptLanguageSuggestion_creator_fk" FOREIGN KEY("createdBy") REFERENCES "UserProfile"("id") ON DELETE RESTRICT ON UPDATE NO ACTION,
 CONSTRAINT "ScriptLanguageSuggestion_decider_fk" FOREIGN KEY("decidedBy") REFERENCES "UserProfile"("id") ON DELETE RESTRICT ON UPDATE NO ACTION,
 CONSTRAINT "ScriptLanguageSuggestion_shape_check" CHECK("contentHash"~'^[a-f0-9]{64}$' AND "startOffset">=0 AND "endOffset">"startOffset"
  AND length("originalText")>0 AND length("replacementText")>0 AND length("finding")>0
  AND (("status"='OPEN' AND "decidedBy" IS NULL AND "decidedAt" IS NULL) OR ("status" IN ('ACCEPTED','REJECTED') AND "decidedBy" IS NOT NULL AND "decidedAt" IS NOT NULL)))
);
CREATE INDEX "ScriptLanguageSuggestion_source_hash_idx" ON "ScriptLanguageSuggestion"("projectId","sourceRevisionId","contentHash");
CREATE FUNCTION guard_script_language_suggestion() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE revision_hash CHAR(64);
DECLARE frame_text TEXT;
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'script language findings are retained' USING ERRCODE='23514'; END IF;
 IF TG_OP='INSERT' THEN
  IF NEW."status"<>'OPEN' OR NEW."decidedBy" IS NOT NULL OR NEW."decidedAt" IS NOT NULL THEN RAISE EXCEPTION 'script language findings start open' USING ERRCODE='23514'; END IF;
  SELECT r."sha256",f->>'text' INTO revision_hash,frame_text FROM contextflow."ScriptRevision" r, LATERAL jsonb_array_elements(r."content"->'frames') f
   WHERE r."id"=NEW."sourceRevisionId" AND r."projectId"=NEW."projectId" AND f->>'id'=NEW."frameId"::text;
  IF revision_hash IS NULL OR revision_hash<>NEW."contentHash" OR contextflow.utf16_slice(frame_text,NEW."startOffset",NEW."endOffset") IS DISTINCT FROM NEW."originalText" THEN
   RAISE EXCEPTION 'script finding must point to exact frame text and revision' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
 END IF;
 IF (to_jsonb(NEW)-ARRAY['status','decidedBy','decidedAt']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['status','decidedBy','decidedAt'])
    OR OLD."status"<>'OPEN' OR NEW."status" NOT IN ('ACCEPTED','REJECTED') OR NEW."decidedBy" IS NULL OR NEW."decidedAt" IS NULL THEN
   RAISE EXCEPTION 'script language finding allows one terminal decision' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER "ScriptLanguageSuggestion_guard" BEFORE INSERT OR UPDATE OR DELETE ON "ScriptLanguageSuggestion" FOR EACH ROW EXECUTE FUNCTION guard_script_language_suggestion();

ALTER TABLE "ExportItem" ADD COLUMN "scriptRevisionId" UUID;
ALTER TABLE "ExportItem" ADD CONSTRAINT "ExportItem_script_project_fk" FOREIGN KEY("projectId","scriptRevisionId") REFERENCES "ScriptRevision"("projectId","id") ON DELETE RESTRICT ON UPDATE NO ACTION;
ALTER TABLE "ExportItem" DROP CONSTRAINT "ExportItem_target_xor_check";
ALTER TABLE "ExportItem" ADD CONSTRAINT "ExportItem_target_xor_check" CHECK (num_nonnulls("articleVersionId","adaptationRevisionId","scriptRevisionId")=1);
CREATE UNIQUE INDEX "ExportItem_request_script_unique" ON "ExportItem"("requestId","scriptRevisionId");

CREATE OR REPLACE FUNCTION guard_export_request_update() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE item_count INTEGER;
DECLARE min_ordinal INTEGER;
DECLARE max_ordinal INTEGER;
BEGIN
  IF (to_jsonb(NEW) - 'itemsSealed') IS DISTINCT FROM (to_jsonb(OLD) - 'itemsSealed') OR OLD."itemsSealed" OR NOT NEW."itemsSealed" THEN
    RAISE EXCEPTION 'export request is immutable except for one-way item sealing' USING ERRCODE = '23514';
  END IF;
  SELECT count(*)::integer, min("ordinal"), max("ordinal") INTO item_count, min_ordinal, max_ordinal
    FROM contextflow."ExportItem" WHERE "requestId" = OLD."id" AND "projectId" = OLD."projectId";
  IF item_count < 1 OR (OLD."format" IN ('TXT', 'MARKDOWN', 'JSON') AND item_count <> 1)
    OR (OLD."format" = 'ZIP' AND item_count > 11) OR min_ordinal <> 0 OR max_ordinal <> item_count - 1 THEN
    RAISE EXCEPTION 'export item count or order does not match package format' USING ERRCODE = '23514';
  END IF;
  IF (OLD."format"='JSON' AND EXISTS(SELECT 1 FROM contextflow."ExportItem" i WHERE i."requestId"=OLD."id" AND i."scriptRevisionId" IS NULL))
    OR EXISTS(SELECT 1 FROM contextflow."ExportItem" i WHERE i."requestId"=OLD."id" AND i."scriptRevisionId" IS NOT NULL AND OLD."format" NOT IN ('JSON','MARKDOWN','ZIP')) THEN
    RAISE EXCEPTION 'export format does not match the selected script target' USING ERRCODE='23514';
  END IF;
  IF EXISTS (
    SELECT 1 FROM contextflow."ExportItem" i JOIN contextflow."Project" p ON p."id" = i."projectId"
    WHERE i."requestId" = OLD."id" AND i."projectId" = OLD."projectId"
      AND ((i."articleVersionId" IS NOT NULL AND NOT ('ARTICLE'::contextflow."ProjectFormat" = ANY(p."formats")))
        OR (i."adaptationRevisionId" IS NOT NULL AND NOT EXISTS (
          SELECT 1 FROM contextflow."AdaptationRevision" r JOIN contextflow."Adaptation" a ON a."id"=r."adaptationId" AND a."projectId"=r."projectId"
          WHERE r."id"=i."adaptationRevisionId" AND r."projectId"=i."projectId" AND a."format"=ANY(p."formats")))
        OR (i."scriptRevisionId" IS NOT NULL AND NOT EXISTS (
          SELECT 1 FROM contextflow."ScriptRevision" r JOIN contextflow."Script" s ON s."id"=r."scriptId" AND s."projectId"=r."projectId"
          WHERE r."id"=i."scriptRevisionId" AND r."projectId"=i."projectId" AND s."format"=ANY(p."formats"))))
  ) THEN RAISE EXCEPTION 'export item is not among the Project selected outputs' USING ERRCODE = '23514'; END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER "Script_no_delete" BEFORE DELETE ON "Script" FOR EACH ROW EXECUTE FUNCTION contextflow.guard_editorial_delete();
CREATE TRIGGER "ScriptDraft_no_delete" BEFORE DELETE ON "ScriptDraft" FOR EACH ROW EXECUTE FUNCTION contextflow.guard_editorial_delete();
CREATE TRIGGER "ScriptLanguageSuggestion_no_delete" BEFORE DELETE ON "ScriptLanguageSuggestion" FOR EACH ROW EXECUTE FUNCTION contextflow.guard_editorial_delete();

REVOKE ALL ON "Script","ScriptDraft","ScriptRevision","ScriptRevisionClaim","ScriptLanguageSuggestion" FROM PUBLIC;
REVOKE ALL ON TYPE "ExportFormat" FROM PUBLIC;
DO $$ DECLARE role_name TEXT; BEGIN
 FOREACH role_name IN ARRAY ARRAY['anon','authenticated'] LOOP
  IF to_regrole(role_name) IS NOT NULL THEN
   EXECUTE format('REVOKE ALL ON contextflow."Script",contextflow."ScriptDraft",contextflow."ScriptRevision",contextflow."ScriptRevisionClaim",contextflow."ScriptLanguageSuggestion" FROM %I',role_name);
   EXECUTE format('REVOKE ALL ON TYPE contextflow."ExportFormat" FROM %I',role_name);
  END IF;
 END LOOP;
END $$;
GRANT SELECT,INSERT,UPDATE ON "Script","ScriptDraft","ScriptRevision","ScriptRevisionClaim" TO cf_runtime;
GRANT SELECT,INSERT ON "ScriptLanguageSuggestion" TO cf_runtime;
GRANT UPDATE ("status","decidedBy","decidedAt") ON "ScriptLanguageSuggestion" TO cf_runtime;
GRANT USAGE ON TYPE "ExportFormat" TO cf_runtime;

COMMIT;
