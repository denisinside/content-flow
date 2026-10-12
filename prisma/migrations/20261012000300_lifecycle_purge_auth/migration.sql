BEGIN;
SET LOCAL search_path TO contextflow;

-- Migration 002 is applied. Keep purge authorization and revision checks in
-- additive repairs so direct SECURITY DEFINER calls fail closed as well.
DO $$
DECLARE
  function_source text;
  previous_block text;
  replacement_block text;
BEGIN
  function_source := pg_get_functiondef('contextflow.purge_project_graph_scoped(uuid,uuid,integer,boolean)'::regprocedure);
  previous_block := $previous$
  IF project_revision<>expected_revision THEN RAISE EXCEPTION 'project revision changed' USING ERRCODE='40001'; END IF;
  PERFORM w."id" FROM contextflow."Workspace" w WHERE w."id"=parent_workspace FOR SHARE;
  SELECT w."ownerId",w."trashedAt",w."purgeAfter" INTO workspace_owner,workspace_trashed,workspace_purge_after
    FROM contextflow."Workspace" w WHERE w."id"=parent_workspace;
  IF workspace_owner<>actor OR NOT EXISTS(SELECT 1 FROM contextflow."WorkspaceMember" m WHERE m."workspaceId"=parent_workspace AND m."userId"=actor AND m."leftAt" IS NULL) THEN
    RAISE EXCEPTION 'only the active Workspace owner may purge a Project' USING ERRCODE='42501';
  END IF;
$previous$;
  replacement_block := $replacement$
  PERFORM w."id" FROM contextflow."Workspace" w WHERE w."id"=parent_workspace FOR SHARE;
  SELECT w."ownerId",w."trashedAt",w."purgeAfter" INTO workspace_owner,workspace_trashed,workspace_purge_after
    FROM contextflow."Workspace" w WHERE w."id"=parent_workspace;
  IF NOT EXISTS(SELECT 1 FROM contextflow."WorkspaceMember" m WHERE m."workspaceId"=parent_workspace AND m."userId"=actor AND m."leftAt" IS NULL) THEN
    RAISE EXCEPTION 'Project not found' USING ERRCODE='P0002';
  END IF;
  IF workspace_owner<>actor THEN RAISE EXCEPTION 'only the active Workspace owner may purge a Project' USING ERRCODE='42501'; END IF;
  IF project_revision IS DISTINCT FROM expected_revision THEN RAISE EXCEPTION 'project revision changed' USING ERRCODE='40001'; END IF;
$replacement$;
  IF position(previous_block IN function_source)=0 THEN
    RAISE EXCEPTION 'Project purge authorization block changed; refusing repair';
  END IF;
  function_source := replace(function_source,previous_block,replacement_block);
  EXECUTE function_source;

  function_source := pg_get_functiondef('contextflow.purge_workspace_graph(uuid,uuid,integer)'::regprocedure);
  previous_block := $previous$
  IF current_owner<>actor OR NOT EXISTS(SELECT 1 FROM contextflow."WorkspaceMember" m WHERE m."workspaceId"=target_workspace AND m."userId"=actor AND m."leftAt" IS NULL)
     OR (SELECT count(*) FROM contextflow."WorkspaceMember" m WHERE m."workspaceId"=target_workspace AND m."leftAt" IS NULL)<>1 THEN
    RAISE EXCEPTION 'only the sole active Workspace owner may purge it' USING ERRCODE='42501';
  END IF;
  IF current_revision<>expected_revision THEN RAISE EXCEPTION 'Workspace revision changed' USING ERRCODE='40001'; END IF;
$previous$;
  replacement_block := $replacement$
  IF NOT EXISTS(SELECT 1 FROM contextflow."WorkspaceMember" m WHERE m."workspaceId"=target_workspace AND m."userId"=actor AND m."leftAt" IS NULL) THEN
    RAISE EXCEPTION 'Workspace not found' USING ERRCODE='P0002';
  END IF;
  IF current_owner<>actor OR (SELECT count(*) FROM contextflow."WorkspaceMember" m WHERE m."workspaceId"=target_workspace AND m."leftAt" IS NULL)<>1 THEN
    RAISE EXCEPTION 'only the sole active Workspace owner may purge it' USING ERRCODE='42501';
  END IF;
  IF current_revision IS DISTINCT FROM expected_revision THEN RAISE EXCEPTION 'Workspace revision changed' USING ERRCODE='40001'; END IF;
$replacement$;
  IF position(previous_block IN function_source)=0 THEN
    RAISE EXCEPTION 'Workspace purge authorization block changed; refusing repair';
  END IF;
  function_source := replace(function_source,previous_block,replacement_block);
  EXECUTE function_source;
END $$;

COMMIT;
