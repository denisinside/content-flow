BEGIN;

DO $$
DECLARE function_source text;
DECLARE old_condition text;
DECLARE new_condition text;
BEGIN
  function_source:=pg_get_functiondef('contextflow.guard_private_object_deletion_insert()'::regprocedure);
  old_condition:=$old$OR NEW."objectKey" !~* ('^'||NEW."projectId"::text||'/(exports|visuals)/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$') THEN$old$;
  new_condition:=$new$OR NOT (
      NEW."objectKey" ~* ('^'||NEW."projectId"::text||'/(exports|visuals)/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')
      OR NEW."objectKey" ~* ('^'||NEW."workspaceId"::text||'/visuals/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')
    ) THEN$new$;
  IF position(old_condition IN function_source)=0 THEN
    RAISE EXCEPTION 'Staged cleanup key guard changed; refusing workspace cleanup migration';
  END IF;
  EXECUTE replace(function_source,old_condition,new_condition);
END $$;

COMMIT;
