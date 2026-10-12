BEGIN;
SET LOCAL search_path TO contextflow;

-- Tighten the M5.3 approval gate without changing the already applied approval schema.
CREATE OR REPLACE FUNCTION contextflow.guard_visual_revision_review() RETURNS trigger
LANGUAGE plpgsql
SET search_path=pg_catalog,contextflow,pg_temp
AS $$
DECLARE composition_format contextflow."ProjectFormat";
DECLARE frame_count integer;
DECLARE preview_count integer;
DECLARE renderer_count integer;
DECLARE font_receipt_count integer;
DECLARE latest_number integer;
DECLARE draft contextflow."VisualCompositionDraft"%ROWTYPE;
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'visual composition revisions are retained' USING ERRCODE='55000'; END IF;
  IF TG_OP='INSERT' THEN
    IF NEW."approvedBy" IS NOT NULL OR NEW."approvedAt" IS NOT NULL OR NEW."withdrawnBy" IS NOT NULL OR NEW."withdrawnAt" IS NOT NULL OR NEW."reviewCounter"<>0 THEN
      RAISE EXCEPTION 'visual revision must start unapproved' USING ERRCODE='23514';
    END IF;
    RETURN NEW;
  END IF;
  IF (to_jsonb(NEW)-ARRAY['approvedBy','approvedAt','withdrawnBy','withdrawnAt','reviewCounter']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['approvedBy','approvedAt','withdrawnBy','withdrawnAt','reviewCounter']) THEN
    RAISE EXCEPTION 'visual checkpoint content and provenance are immutable' USING ERRCODE='23514';
  END IF;
  IF OLD."reviewCounter"<>NEW."reviewCounter"-1 OR NEW."reviewCounter"<>OLD."reviewCounter"+1 THEN
    RAISE EXCEPTION 'visual review counter must advance exactly once' USING ERRCODE='23514';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM contextflow."VisualComposition" c
    JOIN contextflow."Project" p ON p."id"=c."projectId"
    JOIN contextflow."Workspace" w ON w."id"=p."workspaceId"
    JOIN contextflow."WorkspaceMember" wm ON wm."workspaceId"=p."workspaceId"
    WHERE c."projectId"=OLD."projectId" AND c."id"=OLD."compositionId"
      AND wm."userId"=CASE WHEN OLD."approvedBy" IS NULL THEN NEW."approvedBy" ELSE NEW."withdrawnBy" END
      AND wm."leftAt" IS NULL AND p."archivedAt" IS NULL AND p."trashedAt" IS NULL
      AND w."archivedAt" IS NULL AND w."trashedAt" IS NULL
  ) THEN RAISE EXCEPTION 'visual reviewer must be an active Workspace member on an active Project' USING ERRCODE='42501'; END IF;

  IF OLD."approvedBy" IS NULL AND OLD."approvedAt" IS NULL AND OLD."withdrawnBy" IS NULL AND OLD."withdrawnAt" IS NULL
     AND NEW."approvedBy" IS NOT NULL AND NEW."approvedAt" IS NOT NULL AND NEW."withdrawnBy" IS NULL AND NEW."withdrawnAt" IS NULL THEN
    SELECT c."format" INTO composition_format FROM contextflow."VisualComposition" c
      WHERE c."projectId"=OLD."projectId" AND c."id"=OLD."compositionId" FOR SHARE;
    SELECT * INTO draft FROM contextflow."VisualCompositionDraft" d
      WHERE d."projectId"=OLD."projectId" AND d."compositionId"=OLD."compositionId" FOR SHARE;
    SELECT max(r."number") INTO latest_number FROM contextflow."VisualCompositionRevision" r
      WHERE r."projectId"=OLD."projectId" AND r."compositionId"=OLD."compositionId";
    IF draft."id" IS NULL OR draft."content" IS DISTINCT FROM OLD."content" OR draft."sha256"<>OLD."sha256"
      OR draft."parentKind"<>OLD."parentKind" OR draft."parentRevisionId"<>OLD."parentRevisionId" OR draft."parentRevisionHash"<>OLD."parentRevisionHash"
      OR draft."parentReviewCounter"<>OLD."parentReviewCounter" OR OLD."number"<>latest_number THEN
      RAISE EXCEPTION 'only the latest checkpoint matching the current draft can be approved' USING ERRCODE='23514';
    END IF;
    IF composition_format IN ('LINKEDIN_COVER','INSTAGRAM_COVER') THEN
      IF OLD."parentKind"<>'ADAPTATION' OR NOT EXISTS (
        SELECT 1 FROM contextflow."AdaptationRevision" a
        JOIN contextflow."Adaptation" p ON p."projectId"=a."projectId" AND p."id"=a."adaptationId"
        WHERE a."projectId"=OLD."projectId" AND a."id"=OLD."parentAdaptationRevisionId" AND p."currentApprovedRevisionId"=a."id"
          AND a."sha256"=OLD."parentRevisionHash" AND a."reviewCounter"=OLD."parentReviewCounter"
          AND a."approvedBy" IS NOT NULL AND a."withdrawnBy" IS NULL AND a."claimsSealed"
      ) THEN RAISE EXCEPTION 'visual cover requires its current approved adaptation' USING ERRCODE='23514'; END IF;
    ELSE
      IF OLD."parentKind"<>'SCRIPT' OR NOT EXISTS (
        SELECT 1 FROM contextflow."ScriptRevision" s
        JOIN contextflow."Script" p ON p."projectId"=s."projectId" AND p."id"=s."scriptId"
        WHERE s."projectId"=OLD."projectId" AND s."id"=OLD."parentScriptRevisionId" AND p."currentApprovedRevisionId"=s."id"
          AND s."sha256"=OLD."parentRevisionHash" AND s."reviewCounter"=OLD."parentReviewCounter"
          AND s."approvedBy" IS NOT NULL AND s."withdrawnBy" IS NULL AND s."claimsSealed"
      ) THEN RAISE EXCEPTION 'visual carousel requires its current approved script' USING ERRCODE='23514'; END IF;
    END IF;
    SELECT jsonb_array_length(OLD."content"->'frames') INTO frame_count;
    SELECT count(*)::integer,count(DISTINCT p."rendererVersion")::integer,count(DISTINCT p."fontHashes")::integer
      INTO preview_count,renderer_count,font_receipt_count
      FROM contextflow."VisualPreview" p
      JOIN contextflow."Asset" a ON a."projectId"=p."projectId" AND a."id"=p."assetId"
      WHERE p."projectId"=OLD."projectId" AND p."compositionId"=OLD."compositionId" AND p."revisionId"=OLD."id"
        AND p."overflow"='[]'::jsonb AND p."rendererVersion" LIKE OLD."rendererVersion"||';chromium-%'
        AND jsonb_typeof(p."fontHashes")='object' AND a."state"='AVAILABLE' AND a."mediaType"='image/png';
    IF frame_count IS NULL OR preview_count<>frame_count OR renderer_count<>1 OR font_receipt_count<>1 OR EXISTS (
      SELECT 1 FROM jsonb_array_elements(OLD."content"->'frames') f
      WHERE NOT EXISTS (
        SELECT 1 FROM contextflow."VisualPreview" p
        JOIN contextflow."Asset" a ON a."projectId"=p."projectId" AND a."id"=p."assetId"
        WHERE p."projectId"=OLD."projectId" AND p."compositionId"=OLD."compositionId" AND p."revisionId"=OLD."id"
          AND p."frameId"=(f->>'id')::uuid AND p."overflow"='[]'::jsonb
          AND p."rendererVersion" LIKE OLD."rendererVersion"||';chromium-%' AND jsonb_typeof(p."fontHashes")='object'
          AND a."state"='AVAILABLE' AND a."mediaType"='image/png'
      )
    ) THEN RAISE EXCEPTION 'every frame needs a complete preview with identical renderer/font receipts and available PNG bytes' USING ERRCODE='23514'; END IF;
    RETURN NEW;
  END IF;
  IF OLD."approvedBy" IS NOT NULL AND OLD."approvedAt" IS NOT NULL AND OLD."withdrawnBy" IS NULL AND OLD."withdrawnAt" IS NULL
     AND NEW."approvedBy"=OLD."approvedBy" AND NEW."approvedAt"=OLD."approvedAt"
     AND NEW."withdrawnBy" IS NOT NULL AND NEW."withdrawnAt" IS NOT NULL THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'visual approval is one-way and withdrawal is terminal' USING ERRCODE='23514';
END $$;

COMMIT;
