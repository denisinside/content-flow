BEGIN;
-- Preserve exact legacy approved claims explicitly required by a source-backed brief.
CREATE OR REPLACE FUNCTION contextflow.guard_script_revision_claim() RETURNS trigger LANGUAGE plpgsql AS $$
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
   OR parent."id" IS NULL OR parent."contentMode"<>'FACTUAL' OR (parent."basisRevisionId" IS NULL AND parent."sourceEvidenceSetId" IS NULL) OR contextflow.utf16_slice(frame_text,NEW."startOffset",NEW."endOffset") IS DISTINCT FROM NEW."quote"
   OR NEW."linkedText"<>NEW."quote"
   OR (parent."sourceEvidenceSetId" IS NULL AND NOT EXISTS(SELECT 1 FROM contextflow."BasisClaimEvidence" b JOIN contextflow."ClaimRevision" c ON c."id"=b."claimRevisionId" AND c."projectId"=b."projectId"
      JOIN contextflow."ClaimEvidence" e ON e."id"=b."evidenceId" AND e."projectId"=b."projectId" AND e."claimRevisionId"=b."claimRevisionId"
      WHERE b."projectId"=NEW."projectId" AND b."basisId"=parent."basisRevisionId" AND b."claimRevisionId"=NEW."claimRevisionId" AND b."evidenceId"=NEW."evidenceId"
        AND c."status"='APPROVED' AND c."approvedAt" IS NOT NULL AND c."withdrawnAt" IS NULL AND c."rejectedAt" IS NULL AND e."invalidatedAt" IS NULL AND e."relation"='SUPPORTS'))
   OR (parent."sourceEvidenceSetId" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM contextflow."BriefRequiredClaim" r
     JOIN contextflow."ClaimRevision" c ON c."projectId"=r."projectId" AND c."id"=r."claimRevisionId"
     JOIN contextflow."ClaimEvidence" e ON e."projectId"=r."projectId" AND e."claimRevisionId"=c."id"
     WHERE r."projectId"=NEW."projectId" AND r."briefRevisionId"=parent."briefRevisionId" AND c."id"=NEW."claimRevisionId" AND e."id"=NEW."evidenceId"
       AND c."status"='APPROVED' AND c."approvedAt" IS NOT NULL AND c."withdrawnAt" IS NULL AND c."rejectedAt" IS NULL
       AND e."invalidatedAt" IS NULL AND e."relation"='SUPPORTS'))
   OR (parent."sourceArticleVersionId" IS NOT NULL AND NOT EXISTS(SELECT 1 FROM contextflow."ArticleVersionClaim" a WHERE a."projectId"=NEW."projectId" AND a."articleVersionId"=parent."sourceArticleVersionId" AND a."claimRevisionId"=NEW."claimRevisionId" AND a."evidenceId"=NEW."evidenceId")) THEN
  RAISE EXCEPTION 'script evidence must match a stable frame locator and exact factual parent inputs' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;

REVOKE ALL ON FUNCTION contextflow.guard_script_revision_claim() FROM PUBLIC;
COMMIT;
