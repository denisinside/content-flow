BEGIN;
SET LOCAL search_path TO contextflow;

ALTER TABLE contextflow."PrivateObjectDeletion" ALTER COLUMN "projectId" DROP NOT NULL;

CREATE TABLE contextflow."WorkspaceVisualAsset" (
  "id" uuid NOT NULL DEFAULT gen_random_uuid(),
  "workspaceId" uuid NOT NULL,
  "bucket" varchar(63) NOT NULL,
  "objectKey" varchar(1024) NOT NULL,
  "mediaType" varchar(255) NOT NULL,
  "bytes" bigint NOT NULL,
  "sha256" char(64) NOT NULL,
  "createdBy" uuid NOT NULL,
  "createdAt" timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "WorkspaceVisualAsset_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "WorkspaceVisualAsset_workspace_fkey" FOREIGN KEY ("workspaceId") REFERENCES contextflow."Workspace"("id") ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT "WorkspaceVisualAsset_creator_fkey" FOREIGN KEY ("createdBy") REFERENCES contextflow."UserProfile"("id") ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT "WorkspaceVisualAsset_identity_check" CHECK ("objectKey" = "workspaceId"::text || '/visuals/' || "id"::text AND "bytes" BETWEEN 1 AND 5242880 AND "mediaType" IN ('image/png','image/jpeg')),
  CONSTRAINT "WorkspaceVisualAsset_hash_check" CHECK ("sha256" ~ '^[a-f0-9]{64}$')
);
CREATE UNIQUE INDEX "WorkspaceVisualAsset_workspaceId_id_key" ON contextflow."WorkspaceVisualAsset"("workspaceId","id");
CREATE UNIQUE INDEX "WorkspaceVisualAsset_bucket_objectKey_key" ON contextflow."WorkspaceVisualAsset"("bucket","objectKey");
CREATE INDEX "WorkspaceVisualAsset_workspaceId_createdAt_idx" ON contextflow."WorkspaceVisualAsset"("workspaceId","createdAt");

CREATE TABLE contextflow."VisualComposition" (
  "id" uuid NOT NULL DEFAULT gen_random_uuid(), "projectId" uuid NOT NULL, "workspaceId" uuid NOT NULL,
  "format" contextflow."ProjectFormat" NOT NULL, "revision" integer NOT NULL DEFAULT 0,
  CONSTRAINT "VisualComposition_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "VisualComposition_project_workspace_fkey" FOREIGN KEY ("projectId","workspaceId") REFERENCES contextflow."Project"("id","workspaceId") ON DELETE RESTRICT ON UPDATE NO ACTION
);
CREATE UNIQUE INDEX "VisualComposition_projectId_format_key" ON contextflow."VisualComposition"("projectId","format");
CREATE UNIQUE INDEX "VisualComposition_projectId_id_key" ON contextflow."VisualComposition"("projectId","id");
CREATE UNIQUE INDEX "VisualComposition_project_workspace_id_key" ON contextflow."VisualComposition"("projectId","workspaceId","id");
ALTER TABLE contextflow."VisualComposition" ADD CONSTRAINT "VisualComposition_format_check" CHECK ("format" IN ('LINKEDIN_COVER','INSTAGRAM_COVER','LINKEDIN_CAROUSEL','INSTAGRAM_CAROUSEL','INSTAGRAM_STORIES'));
CREATE TABLE contextflow."VisualCompositionDraft" (
  "id" uuid NOT NULL DEFAULT gen_random_uuid(), "projectId" uuid NOT NULL, "workspaceId" uuid NOT NULL, "compositionId" uuid NOT NULL UNIQUE,
  "counter" integer NOT NULL DEFAULT 0, "parentKind" varchar(16) NOT NULL, "parentRevisionId" uuid NOT NULL,
  "parentAdaptationRevisionId" uuid, "parentScriptRevisionId" uuid,
  "parentRevisionHash" char(64) NOT NULL, "parentReviewCounter" integer NOT NULL, "workspaceStyleRevision" integer NOT NULL, "content" jsonb NOT NULL,
  "sha256" char(64) NOT NULL, "updatedBy" uuid NOT NULL, "updatedAt" timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "VisualCompositionDraft_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "VisualCompositionDraft_composition_fkey" FOREIGN KEY ("projectId","workspaceId","compositionId") REFERENCES contextflow."VisualComposition"("projectId","workspaceId","id") ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT "VisualCompositionDraft_adaptation_parent_fkey" FOREIGN KEY ("projectId","parentAdaptationRevisionId") REFERENCES contextflow."AdaptationRevision"("projectId","id") ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT "VisualCompositionDraft_script_parent_fkey" FOREIGN KEY ("projectId","parentScriptRevisionId") REFERENCES contextflow."ScriptRevision"("projectId","id") ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT "VisualCompositionDraft_style_fkey" FOREIGN KEY ("workspaceId","workspaceStyleRevision") REFERENCES contextflow."WorkspaceStyleRevision"("workspaceId","revision") ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT "VisualCompositionDraft_editor_fkey" FOREIGN KEY ("updatedBy") REFERENCES contextflow."UserProfile"("id") ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT "VisualCompositionDraft_identity_key" UNIQUE ("projectId","id"),
  CONSTRAINT "VisualCompositionDraft_project_composition_key" UNIQUE ("projectId","compositionId"),
  CONSTRAINT "VisualCompositionDraft_project_workspace_composition_key" UNIQUE ("projectId","workspaceId","compositionId"),
  CONSTRAINT "VisualCompositionDraft_parent_kind_check" CHECK (("parentKind"='ADAPTATION' AND "parentAdaptationRevisionId"="parentRevisionId" AND "parentScriptRevisionId" IS NULL) OR ("parentKind"='SCRIPT' AND "parentScriptRevisionId"="parentRevisionId" AND "parentAdaptationRevisionId" IS NULL)),
  CONSTRAINT "VisualCompositionDraft_hash_check" CHECK ("sha256" ~ '^[a-f0-9]{64}$' AND "parentRevisionHash" ~ '^[a-f0-9]{64}$')
);
CREATE TABLE contextflow."VisualCompositionRevision" (
  "id" uuid NOT NULL DEFAULT gen_random_uuid(), "projectId" uuid NOT NULL, "workspaceId" uuid NOT NULL, "compositionId" uuid NOT NULL,
  "number" integer NOT NULL, "parentKind" varchar(16) NOT NULL, "parentRevisionId" uuid NOT NULL,
  "parentAdaptationRevisionId" uuid, "parentScriptRevisionId" uuid,
  "parentRevisionHash" char(64) NOT NULL, "parentReviewCounter" integer NOT NULL, "workspaceStyleRevision" integer NOT NULL, "content" jsonb NOT NULL,
  "sha256" char(64) NOT NULL, "resourceManifest" jsonb NOT NULL, "rendererVersion" varchar(64) NOT NULL,
  "createdBy" uuid NOT NULL, "createdAt" timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "VisualCompositionRevision_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "VisualCompositionRevision_composition_fkey" FOREIGN KEY ("projectId","workspaceId","compositionId") REFERENCES contextflow."VisualComposition"("projectId","workspaceId","id") ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT "VisualCompositionRevision_adaptation_parent_fkey" FOREIGN KEY ("projectId","parentAdaptationRevisionId") REFERENCES contextflow."AdaptationRevision"("projectId","id") ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT "VisualCompositionRevision_script_parent_fkey" FOREIGN KEY ("projectId","parentScriptRevisionId") REFERENCES contextflow."ScriptRevision"("projectId","id") ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT "VisualCompositionRevision_style_fkey" FOREIGN KEY ("workspaceId","workspaceStyleRevision") REFERENCES contextflow."WorkspaceStyleRevision"("workspaceId","revision") ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT "VisualCompositionRevision_creator_fkey" FOREIGN KEY ("createdBy") REFERENCES contextflow."UserProfile"("id") ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT "VisualCompositionRevision_project_id_key" UNIQUE ("projectId","id"),
  CONSTRAINT "VisualCompositionRevision_project_comp_id_key" UNIQUE ("projectId","workspaceId","compositionId","id"),
  CONSTRAINT "VisualCompositionRevision_number_key" UNIQUE ("compositionId","number"),
  CONSTRAINT "VisualCompositionRevision_parent_kind_check" CHECK (("parentKind"='ADAPTATION' AND "parentAdaptationRevisionId"="parentRevisionId" AND "parentScriptRevisionId" IS NULL) OR ("parentKind"='SCRIPT' AND "parentScriptRevisionId"="parentRevisionId" AND "parentAdaptationRevisionId" IS NULL)),
  CONSTRAINT "VisualCompositionRevision_hash_check" CHECK ("sha256" ~ '^[a-f0-9]{64}$' AND "parentRevisionHash" ~ '^[a-f0-9]{64}$')
);
CREATE TABLE contextflow."VisualPreview" (
  "id" uuid NOT NULL DEFAULT gen_random_uuid(), "projectId" uuid NOT NULL, "workspaceId" uuid NOT NULL, "compositionId" uuid NOT NULL,
  "revisionId" uuid NOT NULL, "assetId" uuid NOT NULL, "frameId" uuid NOT NULL,
  "rendererVersion" varchar(128) NOT NULL, "fontHashes" jsonb NOT NULL, "overflow" jsonb NOT NULL,
  "createdAt" timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "VisualPreview_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "VisualPreview_revision_fkey" FOREIGN KEY ("projectId","workspaceId","compositionId","revisionId") REFERENCES contextflow."VisualCompositionRevision"("projectId","workspaceId","compositionId","id") ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT "VisualPreview_asset_fkey" FOREIGN KEY ("projectId","assetId") REFERENCES contextflow."Asset"("projectId","id") ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT "VisualPreview_project_id_key" UNIQUE ("projectId","id"),
  CONSTRAINT "VisualPreview_frame_key" UNIQUE ("projectId","revisionId","frameId")
);

CREATE FUNCTION contextflow.guard_visual_revision_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'visual composition revisions are immutable' USING ERRCODE='55000'; END $$;
CREATE TRIGGER "VisualCompositionRevision_immutable" BEFORE UPDATE OR DELETE ON contextflow."VisualCompositionRevision" FOR EACH ROW EXECUTE FUNCTION contextflow.guard_visual_revision_immutable();
CREATE TRIGGER "VisualPreview_immutable" BEFORE UPDATE OR DELETE ON contextflow."VisualPreview" FOR EACH ROW EXECUTE FUNCTION contextflow.guard_visual_revision_immutable();
CREATE TRIGGER "WorkspaceVisualAsset_immutable" BEFORE UPDATE OR DELETE ON contextflow."WorkspaceVisualAsset" FOR EACH ROW EXECUTE FUNCTION contextflow.guard_visual_revision_immutable();

CREATE FUNCTION contextflow.guard_visual_parent_format() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE selected_format contextflow."ProjectFormat";
BEGIN
  SELECT "format" INTO selected_format FROM contextflow."VisualComposition"
    WHERE "id"=NEW."compositionId" AND "projectId"=NEW."projectId" AND "workspaceId"=NEW."workspaceId";
  IF selected_format IS NULL OR (selected_format IN ('LINKEDIN_COVER','INSTAGRAM_COVER')) <> (NEW."parentKind"='ADAPTATION') THEN
    RAISE EXCEPTION 'visual parent kind does not match composition format' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "VisualCompositionDraft_parent_format" BEFORE INSERT OR UPDATE ON contextflow."VisualCompositionDraft" FOR EACH ROW EXECUTE FUNCTION contextflow.guard_visual_parent_format();
CREATE TRIGGER "VisualCompositionRevision_parent_format" BEFORE INSERT ON contextflow."VisualCompositionRevision" FOR EACH ROW EXECUTE FUNCTION contextflow.guard_visual_parent_format();

DO $$
DECLARE source text; old text; replacement text;
BEGIN
  source := pg_get_functiondef('contextflow.purge_project_graph_scoped(uuid,uuid,integer,boolean)'::regprocedure);
  old := $old$('ScriptLanguageSuggestion',true),('ScriptRevision',true),('ScriptRevisionClaim',true),('SourceFragment',true)$old$;
  replacement := $new$('ScriptLanguageSuggestion',true),('ScriptRevision',true),('ScriptRevisionClaim',true),('VisualComposition',true),('VisualCompositionDraft',true),('VisualCompositionRevision',true),('VisualPreview',true),('SourceFragment',true)$new$;
  IF position(old IN source)=0 THEN RAISE EXCEPTION 'Project purge target list changed; refusing visual graph migration'; END IF;
  EXECUTE replace(source,old,replacement);

  source := pg_get_functiondef('contextflow.purge_workspace_graph(uuid,uuid,integer)'::regprocedure);
  old := $old$  LOCK TABLE contextflow."WorkspaceStyleRevision" IN SHARE ROW EXCLUSIVE MODE;
  LOCK TABLE contextflow."Workspace" IN SHARE ROW EXCLUSIVE MODE;$old$;
  replacement := $new$  LOCK TABLE contextflow."WorkspaceStyleRevision" IN SHARE ROW EXCLUSIVE MODE;
  LOCK TABLE contextflow."WorkspaceVisualAsset" IN SHARE ROW EXCLUSIVE MODE;
  LOCK TABLE contextflow."Workspace" IN SHARE ROW EXCLUSIVE MODE;
  INSERT INTO contextflow."PrivateObjectDeletion"("id","projectId","workspaceId","requestedBy","bucket","objectKey")
    SELECT gen_random_uuid(),NULL,target_workspace,actor,a."bucket",a."objectKey" FROM contextflow."WorkspaceVisualAsset" a WHERE a."workspaceId"=target_workspace;$new$;
  IF position(old IN source)=0 THEN RAISE EXCEPTION 'Workspace purge lock block changed; refusing visual asset migration'; END IF;
  source := replace(source,old,replacement);
  old := $old$('WorkspaceInvite','WorkspaceMember','WorkspaceStyleRevision','Workspace')$old$;
  replacement := $new$('WorkspaceInvite','WorkspaceMember','WorkspaceStyleRevision','WorkspaceVisualAsset','Workspace')$new$;
  IF position(old IN source)=0 THEN RAISE EXCEPTION 'Workspace purge trigger list changed; refusing visual asset migration'; END IF;
  source := replace(source,old,replacement);
  old := $old$  ALTER TABLE contextflow."WorkspaceStyleRevision" DISABLE TRIGGER USER;
  ALTER TABLE contextflow."Workspace" DISABLE TRIGGER USER;$old$;
  replacement := $new$  ALTER TABLE contextflow."WorkspaceStyleRevision" DISABLE TRIGGER USER;
  ALTER TABLE contextflow."WorkspaceVisualAsset" DISABLE TRIGGER USER;
  ALTER TABLE contextflow."Workspace" DISABLE TRIGGER USER;$new$;
  IF position(old IN source)=0 THEN RAISE EXCEPTION 'Workspace purge trigger disables changed; refusing visual asset migration'; END IF;
  source := replace(source,old,replacement);
  old := $old$  DELETE FROM contextflow."WorkspaceStyleRevision" WHERE "workspaceId"=target_workspace;
  DELETE FROM contextflow."Workspace" WHERE "id"=target_workspace;$old$;
  replacement := $new$  DELETE FROM contextflow."WorkspaceStyleRevision" WHERE "workspaceId"=target_workspace;
  DELETE FROM contextflow."WorkspaceVisualAsset" WHERE "workspaceId"=target_workspace;
  DELETE FROM contextflow."Workspace" WHERE "id"=target_workspace;$new$;
  IF position(old IN source)=0 THEN RAISE EXCEPTION 'Workspace purge deletes changed; refusing visual asset migration'; END IF;
  EXECUTE replace(source,old,replacement);
END $$;

REVOKE ALL ON contextflow."WorkspaceVisualAsset",contextflow."VisualComposition",contextflow."VisualCompositionDraft",contextflow."VisualCompositionRevision",contextflow."VisualPreview" FROM PUBLIC;
DO $$ DECLARE role_name text; BEGIN
 FOREACH role_name IN ARRAY ARRAY['anon','authenticated'] LOOP
  IF to_regrole(role_name) IS NOT NULL THEN
   EXECUTE format('REVOKE ALL ON contextflow."WorkspaceVisualAsset",contextflow."VisualComposition",contextflow."VisualCompositionDraft",contextflow."VisualCompositionRevision",contextflow."VisualPreview" FROM %I',role_name);
  END IF;
 END LOOP;
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='cf_runtime') THEN
  GRANT SELECT,INSERT ON contextflow."WorkspaceVisualAsset" TO cf_runtime;
  GRANT SELECT,INSERT,UPDATE ON contextflow."VisualComposition",contextflow."VisualCompositionDraft" TO cf_runtime;
  GRANT SELECT,INSERT ON contextflow."VisualCompositionRevision",contextflow."VisualPreview" TO cf_runtime;
 END IF;
END $$;

COMMIT;
