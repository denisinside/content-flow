ALTER TYPE contextflow."ExportFormat" ADD VALUE 'PNG';
ALTER TYPE contextflow."ExportFormat" ADD VALUE 'PDF';

BEGIN;
SET LOCAL search_path TO contextflow;

-- Visual approvals are a narrow mutable envelope around otherwise immutable checkpoints.
ALTER TABLE "VisualComposition" ADD COLUMN "currentApprovedRevisionId" uuid;
ALTER TABLE "VisualCompositionRevision"
  ADD COLUMN "approvedBy" uuid,
  ADD COLUMN "approvedAt" timestamptz(3),
  ADD COLUMN "withdrawnBy" uuid,
  ADD COLUMN "withdrawnAt" timestamptz(3),
  ADD COLUMN "reviewCounter" integer NOT NULL DEFAULT 0,
  ADD CONSTRAINT "VisualCompositionRevision_approver_fkey" FOREIGN KEY ("approvedBy") REFERENCES "UserProfile"("id") ON DELETE RESTRICT ON UPDATE NO ACTION,
  ADD CONSTRAINT "VisualCompositionRevision_withdrawer_fkey" FOREIGN KEY ("withdrawnBy") REFERENCES "UserProfile"("id") ON DELETE RESTRICT ON UPDATE NO ACTION,
  ADD CONSTRAINT "VisualCompositionRevision_review_shape_check" CHECK (
    "reviewCounter">=0 AND (("approvedBy" IS NULL AND "approvedAt" IS NULL AND "withdrawnBy" IS NULL AND "withdrawnAt" IS NULL)
      OR ("approvedBy" IS NOT NULL AND "approvedAt" IS NOT NULL AND (("withdrawnBy" IS NULL AND "withdrawnAt" IS NULL) OR ("withdrawnBy" IS NOT NULL AND "withdrawnAt" IS NOT NULL))))
  );
ALTER TABLE "VisualComposition" ADD CONSTRAINT "VisualComposition_approved_revision_fkey"
  FOREIGN KEY ("projectId","workspaceId","id","currentApprovedRevisionId") REFERENCES "VisualCompositionRevision"("projectId","workspaceId","compositionId","id") ON DELETE RESTRICT ON UPDATE NO ACTION;

CREATE OR REPLACE FUNCTION guard_visual_revision_review() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE composition_format contextflow."ProjectFormat";
DECLARE frame_count integer;
DECLARE preview_count integer;
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
    SELECT 1 FROM contextflow."VisualComposition" c JOIN contextflow."Project" p ON p."id"=c."projectId"
    JOIN contextflow."Workspace" w ON w."id"=p."workspaceId" JOIN contextflow."WorkspaceMember" wm ON wm."workspaceId"=p."workspaceId"
    WHERE c."projectId"=OLD."projectId" AND c."id"=OLD."compositionId"
      AND wm."userId"=CASE WHEN OLD."approvedBy" IS NULL THEN NEW."approvedBy" ELSE NEW."withdrawnBy" END
      AND wm."leftAt" IS NULL AND p."trashedAt" IS NULL AND w."trashedAt" IS NULL
  ) THEN RAISE EXCEPTION 'visual reviewer must be an active Workspace member' USING ERRCODE='42501'; END IF;

  IF OLD."approvedBy" IS NULL AND OLD."approvedAt" IS NULL AND OLD."withdrawnBy" IS NULL AND OLD."withdrawnAt" IS NULL
     AND NEW."approvedBy" IS NOT NULL AND NEW."approvedAt" IS NOT NULL AND NEW."withdrawnBy" IS NULL AND NEW."withdrawnAt" IS NULL THEN
    SELECT c."format" INTO composition_format FROM contextflow."VisualComposition" c WHERE c."projectId"=OLD."projectId" AND c."id"=OLD."compositionId" FOR SHARE;
    SELECT * INTO draft FROM contextflow."VisualCompositionDraft" d WHERE d."projectId"=OLD."projectId" AND d."compositionId"=OLD."compositionId" FOR SHARE;
    SELECT max(r."number") INTO latest_number FROM contextflow."VisualCompositionRevision" r WHERE r."projectId"=OLD."projectId" AND r."compositionId"=OLD."compositionId";
    IF draft."id" IS NULL OR draft."content" IS DISTINCT FROM OLD."content" OR draft."sha256"<>OLD."sha256"
      OR draft."parentKind"<>OLD."parentKind" OR draft."parentRevisionId"<>OLD."parentRevisionId" OR draft."parentRevisionHash"<>OLD."parentRevisionHash"
      OR draft."parentReviewCounter"<>OLD."parentReviewCounter" OR OLD."number"<>latest_number THEN
      RAISE EXCEPTION 'only the latest checkpoint matching the current draft can be approved' USING ERRCODE='23514';
    END IF;
    IF composition_format IN ('LINKEDIN_COVER','INSTAGRAM_COVER') THEN
      IF OLD."parentKind"<>'ADAPTATION' OR NOT EXISTS (
        SELECT 1 FROM contextflow."AdaptationRevision" a JOIN contextflow."Adaptation" p ON p."projectId"=a."projectId" AND p."id"=a."adaptationId"
        WHERE a."projectId"=OLD."projectId" AND a."id"=OLD."parentAdaptationRevisionId" AND p."currentApprovedRevisionId"=a."id"
          AND a."sha256"=OLD."parentRevisionHash" AND a."reviewCounter"=OLD."parentReviewCounter" AND a."approvedBy" IS NOT NULL AND a."withdrawnBy" IS NULL AND a."claimsSealed"
      ) THEN RAISE EXCEPTION 'visual cover requires its current approved adaptation' USING ERRCODE='23514'; END IF;
    ELSE
      IF OLD."parentKind"<>'SCRIPT' OR NOT EXISTS (
        SELECT 1 FROM contextflow."ScriptRevision" s JOIN contextflow."Script" p ON p."projectId"=s."projectId" AND p."id"=s."scriptId"
        WHERE s."projectId"=OLD."projectId" AND s."id"=OLD."parentScriptRevisionId" AND p."currentApprovedRevisionId"=s."id"
          AND s."sha256"=OLD."parentRevisionHash" AND s."reviewCounter"=OLD."parentReviewCounter" AND s."approvedBy" IS NOT NULL AND s."withdrawnBy" IS NULL AND s."claimsSealed"
      ) THEN RAISE EXCEPTION 'visual carousel requires its current approved script' USING ERRCODE='23514'; END IF;
    END IF;
    SELECT jsonb_array_length(OLD."content"->'frames') INTO frame_count;
    SELECT count(*)::integer INTO preview_count FROM contextflow."VisualPreview" p
      WHERE p."projectId"=OLD."projectId" AND p."compositionId"=OLD."compositionId" AND p."revisionId"=OLD."id"
        AND p."overflow"='[]'::jsonb AND p."rendererVersion" LIKE OLD."rendererVersion"||';chromium-%'
        AND jsonb_typeof(p."fontHashes")='object';
    IF frame_count IS NULL OR preview_count<>frame_count OR EXISTS (
      SELECT 1 FROM jsonb_array_elements(OLD."content"->'frames') f
      WHERE NOT EXISTS (SELECT 1 FROM contextflow."VisualPreview" p WHERE p."projectId"=OLD."projectId" AND p."compositionId"=OLD."compositionId" AND p."revisionId"=OLD."id" AND p."frameId"=(f->>'id')::uuid AND p."overflow"='[]'::jsonb)
    ) THEN RAISE EXCEPTION 'every frame needs an exact preview without overflow before approval' USING ERRCODE='23514'; END IF;
    RETURN NEW;
  END IF;
  IF OLD."approvedBy" IS NOT NULL AND OLD."approvedAt" IS NOT NULL AND OLD."withdrawnBy" IS NULL AND OLD."withdrawnAt" IS NULL
     AND NEW."approvedBy"=OLD."approvedBy" AND NEW."approvedAt"=OLD."approvedAt" AND NEW."withdrawnBy" IS NOT NULL AND NEW."withdrawnAt" IS NOT NULL THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'visual approval is one-way and withdrawal is terminal' USING ERRCODE='23514';
END $$;
DROP TRIGGER "VisualCompositionRevision_immutable" ON "VisualCompositionRevision";
CREATE TRIGGER "VisualCompositionRevision_review_guard" BEFORE INSERT OR UPDATE OR DELETE ON "VisualCompositionRevision" FOR EACH ROW EXECUTE FUNCTION guard_visual_revision_review();

CREATE FUNCTION guard_visual_approved_pointer() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE selected_number integer;
BEGIN
  IF TG_OP='UPDATE' AND (NEW."id",NEW."projectId",NEW."workspaceId",NEW."format") IS DISTINCT FROM (OLD."id",OLD."projectId",OLD."workspaceId",OLD."format") THEN
    RAISE EXCEPTION 'visual composition identity is immutable' USING ERRCODE='23514';
  END IF;
  IF TG_OP='UPDATE' AND (NEW."revision"<OLD."revision" OR NEW."revision">OLD."revision"+1) THEN
    RAISE EXCEPTION 'visual composition revision must advance at most once' USING ERRCODE='23514';
  END IF;
  IF TG_OP='UPDATE' AND NEW."currentApprovedRevisionId" IS NOT DISTINCT FROM OLD."currentApprovedRevisionId" THEN RETURN NEW; END IF;
  IF NEW."currentApprovedRevisionId" IS NULL THEN
    IF TG_OP='UPDATE' AND OLD."currentApprovedRevisionId" IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM contextflow."VisualCompositionRevision" r JOIN contextflow."Project" p ON p."id"=r."projectId"
      WHERE r."projectId"=OLD."projectId" AND r."id"=OLD."currentApprovedRevisionId" AND (r."withdrawnBy" IS NOT NULL OR p."trashedAt" IS NOT NULL)
    ) THEN RAISE EXCEPTION 'active visual approval can only be cleared after withdrawal' USING ERRCODE='23514'; END IF;
    RETURN NEW;
  END IF;
  SELECT r."number" INTO selected_number FROM contextflow."VisualCompositionRevision" r
    WHERE r."projectId"=NEW."projectId" AND r."compositionId"=NEW."id" AND r."id"=NEW."currentApprovedRevisionId"
      AND r."approvedBy" IS NOT NULL AND r."approvedAt" IS NOT NULL AND r."withdrawnBy" IS NULL AND r."withdrawnAt" IS NULL;
  IF selected_number IS NULL OR selected_number<>(SELECT max(r."number") FROM contextflow."VisualCompositionRevision" r WHERE r."projectId"=NEW."projectId" AND r."compositionId"=NEW."id") THEN
    RAISE EXCEPTION 'current visual pointer must reference the latest approved, active checkpoint' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "VisualComposition_approved_pointer_guard" BEFORE INSERT OR UPDATE OF "currentApprovedRevisionId" ON "VisualComposition" FOR EACH ROW EXECUTE FUNCTION guard_visual_approved_pointer();

-- A project purge clears this new cyclic pointer before the existing child-first graph deletion.
DO $$ DECLARE source text; old text; replacement text; BEGIN
  source:=pg_get_functiondef('contextflow.purge_project_graph_scoped(uuid,uuid,integer,boolean)'::regprocedure);
  old:=$old$  UPDATE contextflow."Script" SET "currentApprovedRevisionId"=NULL WHERE "projectId"=target_project;$old$;
  replacement:=$new$  UPDATE contextflow."Script" SET "currentApprovedRevisionId"=NULL WHERE "projectId"=target_project;
  UPDATE contextflow."VisualComposition" SET "currentApprovedRevisionId"=NULL WHERE "projectId"=target_project;$new$;
  IF position(old IN source)=0 THEN RAISE EXCEPTION 'Project purge pointer cleanup changed; refusing visual approval migration'; END IF;
  EXECUTE replace(source,old,replacement);
END $$;

ALTER TABLE "ExportItem" ADD COLUMN "visualRevisionId" uuid;
ALTER TABLE "ExportItem" ADD CONSTRAINT "ExportItem_visual_project_fk" FOREIGN KEY ("projectId","visualRevisionId") REFERENCES "VisualCompositionRevision"("projectId","id") ON DELETE RESTRICT ON UPDATE NO ACTION;
ALTER TABLE "ExportItem" DROP CONSTRAINT "ExportItem_target_xor_check";
ALTER TABLE "ExportItem" ADD CONSTRAINT "ExportItem_target_xor_check" CHECK (num_nonnulls("articleVersionId","adaptationRevisionId","scriptRevisionId","visualRevisionId")=1);
CREATE UNIQUE INDEX "ExportItem_request_visual_unique" ON "ExportItem"("requestId","visualRevisionId");

CREATE OR REPLACE FUNCTION guard_export_request_update() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE item_count integer; min_ordinal integer; max_ordinal integer;
BEGIN
  IF (to_jsonb(NEW)-'itemsSealed') IS DISTINCT FROM (to_jsonb(OLD)-'itemsSealed') OR OLD."itemsSealed" OR NOT NEW."itemsSealed" THEN
    RAISE EXCEPTION 'export request is immutable except for one-way item sealing' USING ERRCODE='23514';
  END IF;
  SELECT count(*)::integer,min("ordinal"),max("ordinal") INTO item_count,min_ordinal,max_ordinal FROM contextflow."ExportItem" WHERE "requestId"=OLD."id" AND "projectId"=OLD."projectId";
  IF item_count<1 OR (OLD."format" IN ('TXT','MARKDOWN','JSON','PNG','PDF') AND item_count<>1)
    OR (OLD."format"='ZIP' AND item_count>16) OR min_ordinal<>0 OR max_ordinal<>item_count-1 THEN
    RAISE EXCEPTION 'export item count or order does not match package format' USING ERRCODE='23514';
  END IF;
  IF EXISTS(SELECT 1 FROM contextflow."ExportItem" i WHERE i."requestId"=OLD."id" AND i."projectId"=OLD."projectId"
    AND ((OLD."format"='JSON' AND i."scriptRevisionId" IS NULL)
      OR (i."scriptRevisionId" IS NOT NULL AND OLD."format" NOT IN ('JSON','MARKDOWN','ZIP'))
      OR (i."visualRevisionId" IS NOT NULL AND OLD."format" NOT IN ('PNG','PDF','ZIP'))
      OR (OLD."format" IN ('PNG','PDF') AND i."visualRevisionId" IS NULL))) THEN
    RAISE EXCEPTION 'export format does not match the selected output target' USING ERRCODE='23514';
  END IF;
  IF EXISTS(
    SELECT 1 FROM contextflow."ExportItem" i JOIN contextflow."Project" p ON p."id"=i."projectId"
    WHERE i."requestId"=OLD."id" AND i."projectId"=OLD."projectId" AND (
      (i."articleVersionId" IS NOT NULL AND NOT ('ARTICLE'::contextflow."ProjectFormat"=ANY(p."formats")))
      OR (i."adaptationRevisionId" IS NOT NULL AND NOT EXISTS(SELECT 1 FROM contextflow."AdaptationRevision" r JOIN contextflow."Adaptation" a ON a."id"=r."adaptationId" AND a."projectId"=r."projectId" WHERE r."id"=i."adaptationRevisionId" AND r."projectId"=i."projectId" AND a."format"=ANY(p."formats")))
      OR (i."scriptRevisionId" IS NOT NULL AND NOT EXISTS(SELECT 1 FROM contextflow."ScriptRevision" r JOIN contextflow."Script" s ON s."id"=r."scriptId" AND s."projectId"=r."projectId" WHERE r."id"=i."scriptRevisionId" AND r."projectId"=i."projectId" AND s."format"=ANY(p."formats")))
      OR (i."visualRevisionId" IS NOT NULL AND NOT EXISTS(SELECT 1 FROM contextflow."VisualCompositionRevision" r JOIN contextflow."VisualComposition" c ON c."id"=r."compositionId" AND c."projectId"=r."projectId" WHERE r."id"=i."visualRevisionId" AND r."projectId"=i."projectId" AND r."approvedBy" IS NOT NULL AND r."withdrawnBy" IS NULL AND c."currentApprovedRevisionId"=r."id" AND c."format"=ANY(p."formats") AND ((OLD."format"='PNG' AND c."format" IN ('LINKEDIN_COVER','INSTAGRAM_COVER')) OR (OLD."format"='PDF' AND c."format" IN ('LINKEDIN_CAROUSEL','INSTAGRAM_CAROUSEL')) OR OLD."format"='ZIP')))
    )
  ) THEN RAISE EXCEPTION 'export item is not a current approved Project output' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END $$;

REVOKE UPDATE ON "VisualComposition" FROM cf_runtime;
GRANT UPDATE ("revision","currentApprovedRevisionId") ON "VisualComposition" TO cf_runtime;
GRANT UPDATE ("approvedBy","approvedAt","withdrawnBy","withdrawnAt","reviewCounter") ON "VisualCompositionRevision" TO cf_runtime;

COMMIT;
