BEGIN;

-- Explicit pg_temp placement prevents caller-created temporary catalog names
-- from shadowing the trusted catalogs inside SECURITY DEFINER purge functions.
ALTER FUNCTION contextflow.lock_project_purge_tables() SET search_path = pg_catalog, contextflow, pg_temp;
ALTER FUNCTION contextflow.purge_project_graph_scoped(uuid, uuid, integer, boolean) SET search_path = pg_catalog, contextflow, pg_temp;
ALTER FUNCTION contextflow.purge_project_graph(uuid, uuid, integer) SET search_path = pg_catalog, contextflow, pg_temp;
ALTER FUNCTION contextflow.purge_workspace_graph(uuid, uuid, integer) SET search_path = pg_catalog, contextflow, pg_temp;

-- Internal helpers remain inaccessible even if a deployment supplied broader
-- function default privileges to the runtime role before these migrations.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'cf_runtime') THEN
    REVOKE ALL ON FUNCTION contextflow.lock_project_purge_tables() FROM cf_runtime;
    REVOKE ALL ON FUNCTION contextflow.purge_project_graph_scoped(uuid, uuid, integer, boolean) FROM cf_runtime;
  END IF;
END $$;

COMMIT;
