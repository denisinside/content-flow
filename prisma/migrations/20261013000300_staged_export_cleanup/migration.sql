BEGIN;
SET LOCAL search_path TO contextflow;

CREATE OR REPLACE FUNCTION contextflow.guard_private_object_deletion_insert() RETURNS trigger
LANGUAGE plpgsql
SET search_path=pg_catalog,contextflow,pg_temp
AS $$
BEGIN
  -- SECURITY DEFINER purge functions execute as their owner and keep their existing full-graph journal path.
  IF current_user<>'cf_runtime' THEN RETURN NEW; END IF;
  IF NEW."projectId" IS NULL OR NEW."state"<>'PENDING' OR NEW."attempts"<>0 OR NEW."deletedAt" IS NOT NULL
    OR NEW."errorCategory" IS NOT NULL OR NEW."createdAt" < clock_timestamp()-interval '1 day'
    OR NEW."createdAt" > clock_timestamp()+interval '5 minutes'
    OR NEW."retryAfter" < NEW."createdAt"-interval '5 minutes'
    OR NEW."retryAfter" > NEW."createdAt"+interval '5 minutes'
    OR NEW."objectKey" !~* ('^'||NEW."projectId"::text||'/(exports|visuals)/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$') THEN
    RAISE EXCEPTION 'invalid staged private object cleanup journal entry' USING ERRCODE='23514';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM contextflow."Project" p WHERE p."id"=NEW."projectId" AND p."workspaceId"=NEW."workspaceId"
  ) THEN RAISE EXCEPTION 'staged cleanup must belong to an existing Project and Workspace' USING ERRCODE='23503'; END IF;
  IF NOT EXISTS (
    SELECT 1 FROM contextflow."WorkspaceMember" wm
    WHERE wm."workspaceId"=NEW."workspaceId" AND wm."userId"=NEW."requestedBy" AND wm."leftAt" IS NULL
  ) AND NOT EXISTS (
    SELECT 1 FROM contextflow."Job" j
    WHERE j."projectId"=NEW."projectId" AND j."requestedBy"=NEW."requestedBy" AND j."operation"::text='EXPORT_BUILD'
  ) THEN
    RAISE EXCEPTION 'staged cleanup requester must be an active Workspace member or owner of an export job' USING ERRCODE='42501';
  END IF;
  IF EXISTS (
    SELECT 1 FROM contextflow."Asset" a WHERE a."bucket"=NEW."bucket" AND a."objectKey"=NEW."objectKey"
  ) OR EXISTS (
    SELECT 1 FROM contextflow."WorkspaceVisualAsset" a WHERE a."bucket"=NEW."bucket" AND a."objectKey"=NEW."objectKey"
  ) THEN
    RAISE EXCEPTION 'accepted private assets cannot be entered into the cleanup journal' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER "PrivateObjectDeletion_insert_guard" BEFORE INSERT ON contextflow."PrivateObjectDeletion"
FOR EACH ROW EXECUTE FUNCTION contextflow.guard_private_object_deletion_insert();

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname='cf_runtime') THEN
    GRANT INSERT ON contextflow."PrivateObjectDeletion" TO cf_runtime;
  END IF;
END $$;

COMMIT;
