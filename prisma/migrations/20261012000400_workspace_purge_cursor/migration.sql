BEGIN;
SET LOCAL search_path TO contextflow;

-- PostgreSQL cannot ALTER the Project table while a cursor on Project is
-- active. Materialize the locked project list before invoking scoped purges.
DO $$
DECLARE
  function_source text;
  previous_block text;
  replacement_block text;
BEGIN
  function_source := pg_get_functiondef('contextflow.purge_workspace_graph(uuid,uuid,integer)'::regprocedure);
  previous_block := $previous$DECLARE current_owner uuid; current_revision integer; trashed_at timestamptz; purge_after timestamptz; selected_project record; cleanup_count integer:=0; deleted_projects integer:=0;$previous$;
  replacement_block := $replacement$DECLARE current_owner uuid; current_revision integer; trashed_at timestamptz; purge_after timestamptz; project_ids uuid[]; project_revisions integer[]; project_index integer; cleanup_count integer:=0; deleted_projects integer:=0;$replacement$;
  IF position(previous_block IN function_source)=0 THEN RAISE EXCEPTION 'Workspace purge declarations changed; refusing repair'; END IF;
  function_source:=replace(function_source,previous_block,replacement_block);

  previous_block := $previous$
  FOR selected_project IN SELECT p."id",p."revision" FROM contextflow."Project" p WHERE p."workspaceId"=target_workspace ORDER BY p."id" LOOP
    PERFORM contextflow.purge_project_graph_scoped(selected_project."id",actor,selected_project."revision",true);
    deleted_projects:=deleted_projects+1;
  END LOOP;
$previous$;
  replacement_block := $replacement$
  SELECT array_agg(p."id" ORDER BY p."id"),array_agg(p."revision" ORDER BY p."id")
    INTO project_ids,project_revisions FROM contextflow."Project" p WHERE p."workspaceId"=target_workspace;
  IF coalesce(array_length(project_ids,1),0)>0 THEN
    FOR project_index IN 1..array_length(project_ids,1) LOOP
      PERFORM contextflow.purge_project_graph_scoped(project_ids[project_index],actor,project_revisions[project_index],true);
      deleted_projects:=deleted_projects+1;
    END LOOP;
  END IF;
$replacement$;
  IF position(previous_block IN function_source)=0 THEN RAISE EXCEPTION 'Workspace purge Project cursor changed; refusing repair'; END IF;
  function_source:=replace(function_source,previous_block,replacement_block);
  EXECUTE function_source;
END $$;

COMMIT;
