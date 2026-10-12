BEGIN;
SET LOCAL search_path TO contextflow;

ALTER TABLE "Workspace"
  ADD COLUMN "trashedAt" timestamptz(3),
  ADD COLUMN "purgeAfter" timestamptz(3),
  ADD COLUMN "lifecycleRevision" integer NOT NULL DEFAULT 1,
  ADD CONSTRAINT "Workspace_lifecycle_revision_check" CHECK ("lifecycleRevision" > 0),
  ADD CONSTRAINT "Workspace_trash_pair_check" CHECK (("trashedAt" IS NULL) = ("purgeAfter" IS NULL)),
  ADD CONSTRAINT "Workspace_trash_retention_check" CHECK ("trashedAt" IS NULL OR "purgeAfter" >= "trashedAt" + interval '30 days');

ALTER TABLE "Project"
  ADD COLUMN "trashedAt" timestamptz(3),
  ADD COLUMN "purgeAfter" timestamptz(3),
  ADD CONSTRAINT "Project_trash_pair_check" CHECK (("trashedAt" IS NULL) = ("purgeAfter" IS NULL)),
  ADD CONSTRAINT "Project_trash_retention_check" CHECK ("trashedAt" IS NULL OR "purgeAfter" >= "trashedAt" + interval '30 days');
CREATE INDEX "Workspace_purgeAfter_idx" ON "Workspace"("purgeAfter") WHERE "trashedAt" IS NOT NULL;
CREATE INDEX "Project_purgeAfter_idx" ON "Project"("purgeAfter") WHERE "trashedAt" IS NOT NULL;

CREATE TABLE "EditorPresence" (
  "projectId" uuid NOT NULL,
  "sessionId" uuid NOT NULL,
  "userId" uuid NOT NULL,
  "page" varchar(80) NOT NULL,
  "clientId" uuid NOT NULL,
  "expiresAt" timestamptz(3) NOT NULL,
  "updatedAt" timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "EditorPresence_pkey" PRIMARY KEY ("projectId", "sessionId", "page", "clientId"),
  CONSTRAINT "EditorPresence_page_check" CHECK (length(btrim("page")) BETWEEN 1 AND 80),
  CONSTRAINT "EditorPresence_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT "EditorPresence_userId_fkey" FOREIGN KEY ("userId") REFERENCES "UserProfile"("id") ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT "EditorPresence_sessionId_userId_fkey" FOREIGN KEY ("sessionId", "userId") REFERENCES "AppSession"("id", "userId") ON DELETE RESTRICT ON UPDATE NO ACTION
);
CREATE INDEX "EditorPresence_projectId_page_expiresAt_idx" ON "EditorPresence"("projectId", "page", "expiresAt");
CREATE INDEX "EditorPresence_userId_expiresAt_idx" ON "EditorPresence"("userId", "expiresAt");

CREATE TABLE "PrivateObjectDeletion" (
  "id" uuid NOT NULL,
  "projectId" uuid NOT NULL,
  "workspaceId" uuid NOT NULL,
  "requestedBy" uuid NOT NULL,
  "bucket" varchar(63) NOT NULL,
  "objectKey" varchar(1024) NOT NULL,
  "state" varchar(16) NOT NULL DEFAULT 'PENDING',
  "attempts" integer NOT NULL DEFAULT 0,
  "retryAfter" timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "deletedAt" timestamptz(3),
  "errorCategory" varchar(64),
  "createdAt" timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "PrivateObjectDeletion_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "PrivateObjectDeletion_state_check" CHECK ("state" IN ('PENDING','DELETED')),
  CONSTRAINT "PrivateObjectDeletion_attempts_check" CHECK ("attempts" >= 0),
  CONSTRAINT "PrivateObjectDeletion_deleted_at_check" CHECK (("state"='DELETED') = ("deletedAt" IS NOT NULL)),
  CONSTRAINT "PrivateObjectDeletion_requester_fkey" FOREIGN KEY ("requestedBy") REFERENCES "UserProfile"("id") ON DELETE RESTRICT ON UPDATE NO ACTION
);
CREATE UNIQUE INDEX "PrivateObjectDeletion_bucket_objectKey_key" ON "PrivateObjectDeletion"("bucket", "objectKey");
CREATE INDEX "PrivateObjectDeletion_state_retryAfter_createdAt_idx" ON "PrivateObjectDeletion"("state", "retryAfter", "createdAt");
CREATE INDEX "PrivateObjectDeletion_projectId_createdAt_idx" ON "PrivateObjectDeletion"("projectId", "createdAt");

CREATE FUNCTION guard_private_object_deletion_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF ROW(NEW."id", NEW."projectId", NEW."workspaceId", NEW."requestedBy", NEW."bucket", NEW."objectKey", NEW."createdAt")
     IS DISTINCT FROM ROW(OLD."id", OLD."projectId", OLD."workspaceId", OLD."requestedBy", OLD."bucket", OLD."objectKey", OLD."createdAt") THEN
    RAISE EXCEPTION 'private object deletion identity is immutable' USING ERRCODE='23514';
  END IF;
  IF NEW."attempts" < OLD."attempts" OR NEW."attempts" > OLD."attempts" + 1
     OR OLD."state"='DELETED' AND NEW."state"<>'DELETED'
     OR (NEW."state"='DELETED') <> (NEW."deletedAt" IS NOT NULL) THEN
    RAISE EXCEPTION 'private object deletion transition is invalid' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "PrivateObjectDeletion_update_guard" BEFORE UPDATE ON "PrivateObjectDeletion"
FOR EACH ROW EXECUTE FUNCTION guard_private_object_deletion_update();

CREATE FUNCTION lock_project_purge_tables() RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,contextflow AS $$
DECLARE selected_table text;
BEGIN
  LOCK TABLE contextflow."Project" IN SHARE ROW EXCLUSIVE MODE;
  FOR selected_table IN SELECT name FROM (VALUES
   ('Adaptation'),('AdaptationDraft'),('AdaptationRevision'),('AdaptationRevisionClaim'),('AIExecution'),('Article'),('ArticleAnnotation'),
   ('ArticleAnnotationPost'),('ArticleDraft'),('ArticleVersion'),('ArticleVersionClaim'),('Asset'),('BasisClaim'),('BasisClaimEvidence'),('Brief'),
   ('BriefContextSnapshot'),('BriefRequiredClaim'),('BriefRevision'),('Claim'),('ClaimConflict'),('ClaimConflictParticipant'),('ClaimEvidence'),
   ('ClaimRevision'),('ConflictResolutionEvidence'),('EditorPresence'),('ExportArtifact'),('ExportItem'),('ExportRequest'),('FactualBasisRevision'),
   ('GoogleDocAnnotationEvent'),('GoogleDocBindCommand'),('GoogleDocBinding'),('GoogleDocCreateCommand'),('GoogleDocRemoteThread'),('GoogleDocSnapshot'),
   ('GoogleDocSnapshotCandidate'),('GoogleDocSyncOperation'),('GoogleDocSyncPreview'),('GoogleDocSyncState'),('Job'),('JobAttempt'),('LanguageSuggestion'),
   ('Material'),('Outline'),('OutlineRevision'),('ProjectMember'),('Script'),('ScriptDraft'),('ScriptLanguageSuggestion'),('ScriptRevision'),
   ('ScriptRevisionClaim'),('SourceFragment'),('SourceSnapshot')) AS fixed_tables(name) ORDER BY name
  LOOP
    EXECUTE format('LOCK TABLE contextflow.%I IN SHARE ROW EXCLUSIVE MODE',selected_table);
  END LOOP;
END $$;

CREATE FUNCTION purge_project_graph_scoped(target_project uuid, actor uuid, expected_revision integer, workspace_scope boolean)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,contextflow AS $$
DECLARE parent_workspace uuid; workspace_owner uuid; project_revision integer; trashed_at timestamptz; purge_after timestamptz;
DECLARE workspace_trashed timestamptz; workspace_purge_after timestamptz; selected_table text; selected_child text; selected_column text;
DECLARE nullable_columns text; disabled_trigger record; pending_count integer; total_deleted integer:=0; changed integer; iteration integer:=0; ignored_fk_ids oid[]:='{}'; selected_fk oid;
BEGIN
  -- Workers and lifecycle transitions take Job → Project → Workspace locks.
  PERFORM j."id" FROM contextflow."Job" j WHERE j."projectId"=target_project AND j."status" IN ('QUEUED','RETRY_WAIT','RUNNING') ORDER BY j."id" FOR UPDATE;
  SELECT p."workspaceId",w."ownerId",p."revision",p."trashedAt",p."purgeAfter",w."trashedAt",w."purgeAfter"
    INTO parent_workspace,workspace_owner,project_revision,trashed_at,purge_after,workspace_trashed,workspace_purge_after
    FROM contextflow."Project" p JOIN contextflow."Workspace" w ON w."id"=p."workspaceId"
    WHERE p."id"=target_project FOR UPDATE OF p;
  IF NOT FOUND THEN RAISE EXCEPTION 'project not found' USING ERRCODE='P0002'; END IF;
  IF project_revision<>expected_revision THEN RAISE EXCEPTION 'project revision changed' USING ERRCODE='40001'; END IF;
  PERFORM w."id" FROM contextflow."Workspace" w WHERE w."id"=parent_workspace FOR SHARE;
  SELECT w."ownerId",w."trashedAt",w."purgeAfter" INTO workspace_owner,workspace_trashed,workspace_purge_after
    FROM contextflow."Workspace" w WHERE w."id"=parent_workspace;
  IF workspace_owner<>actor OR NOT EXISTS(SELECT 1 FROM contextflow."WorkspaceMember" m WHERE m."workspaceId"=parent_workspace AND m."userId"=actor AND m."leftAt" IS NULL) THEN
    RAISE EXCEPTION 'only the active Workspace owner may purge a Project' USING ERRCODE='42501';
  END IF;
  IF workspace_scope THEN
    IF workspace_trashed IS NULL OR workspace_purge_after IS NULL OR workspace_purge_after>clock_timestamp()
       OR (SELECT count(*) FROM contextflow."WorkspaceMember" m WHERE m."workspaceId"=parent_workspace AND m."leftAt" IS NULL)<>1 THEN
      RAISE EXCEPTION 'Workspace trash retention has not elapsed or recovery custody changed' USING ERRCODE='55000';
    END IF;
  ELSE
    IF workspace_trashed IS NOT NULL THEN RAISE EXCEPTION 'purge the trashed Workspace as a whole' USING ERRCODE='55000'; END IF;
    IF trashed_at IS NULL OR purge_after IS NULL OR purge_after>clock_timestamp() THEN
      RAISE EXCEPTION 'Project trash retention has not elapsed' USING ERRCODE='55000';
    END IF;
  END IF;
  IF EXISTS(SELECT 1 FROM contextflow."GoogleDocCreateCommand" c WHERE c."projectId"=target_project AND c."state"::text IN ('SUBMITTED','UNKNOWN'))
     OR EXISTS(SELECT 1 FROM contextflow."GoogleDocSyncOperation" o WHERE o."projectId"=target_project AND upper(o."state") IN ('SUBMITTED','UNKNOWN','OUTCOME_UNKNOWN','PARTIAL')) THEN
    RAISE EXCEPTION 'Google Docs write outcome requires reconciliation before purge' USING ERRCODE='55000';
  END IF;
  IF EXISTS(SELECT 1 FROM contextflow."Job" j WHERE j."projectId"=target_project AND j."status" IN ('QUEUED','RETRY_WAIT','RUNNING')) THEN
    RAISE EXCEPTION 'nonterminal work must be reconciled before purge' USING ERRCODE='55000';
  END IF;

  INSERT INTO contextflow."PrivateObjectDeletion"("id","projectId","workspaceId","requestedBy","bucket","objectKey")
    SELECT gen_random_uuid(),a."projectId",parent_workspace,actor,a."bucket",a."objectKey"
    FROM contextflow."Asset" a WHERE a."projectId"=target_project;
  SELECT count(*) INTO pending_count FROM contextflow."PrivateObjectDeletion" d WHERE d."projectId"=target_project AND d."state"='PENDING';

  CREATE TEMP TABLE pg_temp.m43_purge_targets(name text PRIMARY KEY, has_project_id boolean NOT NULL) ON COMMIT DROP;
  INSERT INTO pg_temp.m43_purge_targets(name,has_project_id) VALUES
   ('Adaptation',true),('AdaptationDraft',true),('AdaptationRevision',true),('AdaptationRevisionClaim',true),('AIExecution',true),
   ('Article',true),('ArticleAnnotation',true),('ArticleAnnotationPost',true),('ArticleDraft',true),('ArticleVersion',true),('ArticleVersionClaim',true),
   ('Asset',true),('BasisClaim',true),('BasisClaimEvidence',true),('Brief',true),('BriefContextSnapshot',true),('BriefRequiredClaim',true),('BriefRevision',true),
   ('Claim',true),('ClaimConflict',true),('ClaimConflictParticipant',true),('ClaimEvidence',true),('ClaimRevision',true),('ConflictResolutionEvidence',true),
   ('EditorPresence',true),('ExportArtifact',true),('ExportItem',true),('ExportRequest',true),('FactualBasisRevision',true),('GoogleDocAnnotationEvent',true),
   ('GoogleDocBindCommand',true),('GoogleDocBinding',true),('GoogleDocCreateCommand',true),('GoogleDocRemoteThread',true),('GoogleDocSnapshot',true),
   ('GoogleDocSnapshotCandidate',true),('GoogleDocSyncOperation',true),('GoogleDocSyncPreview',true),('GoogleDocSyncState',true),('Job',true),('JobAttempt',false),
   ('LanguageSuggestion',true),('Material',true),('Outline',true),('OutlineRevision',true),('ProjectMember',true),('Script',true),('ScriptDraft',true),
   ('ScriptLanguageSuggestion',true),('ScriptRevision',true),('ScriptRevisionClaim',true),('SourceFragment',true),('SourceSnapshot',true);

  CREATE TEMP TABLE pg_temp.m43_purge_trigger_state(name text, trigger_name text, mode "char", PRIMARY KEY(name,trigger_name)) ON COMMIT DROP;
  PERFORM contextflow.lock_project_purge_tables();
  INSERT INTO pg_temp.m43_purge_trigger_state(name,trigger_name,mode)
    SELECT cl.relname,tg.tgname,tg.tgenabled FROM pg_trigger tg JOIN pg_class cl ON cl.oid=tg.tgrelid JOIN pg_namespace ns ON ns.oid=cl.relnamespace
    JOIN pg_temp.m43_purge_targets pt ON pt.name=cl.relname WHERE ns.nspname='contextflow' AND NOT tg.tgisinternal AND tg.tgenabled<>'D';
  INSERT INTO pg_temp.m43_purge_trigger_state(name,trigger_name,mode)
    SELECT cl.relname,tg.tgname,tg.tgenabled FROM pg_trigger tg JOIN pg_class cl ON cl.oid=tg.tgrelid JOIN pg_namespace ns ON ns.oid=cl.relnamespace
    WHERE ns.nspname='contextflow' AND cl.relname='Project' AND NOT tg.tgisinternal AND tg.tgenabled<>'D';
  ALTER TABLE contextflow."Project" DISABLE TRIGGER USER;
  FOR selected_table IN SELECT name FROM pg_temp.m43_purge_targets ORDER BY name LOOP
    EXECUTE format('ALTER TABLE contextflow.%I DISABLE TRIGGER USER',selected_table);
  END LOOP;

  -- Clear optional project-local pointer columns, leaving every unrelated Project, Workspace, session, credential and Google document untouched.
  UPDATE contextflow."Material" SET "currentSnapshotId"=NULL WHERE "projectId"=target_project;
  UPDATE contextflow."Claim" SET "currentRevisionId"=NULL WHERE "projectId"=target_project;
  UPDATE contextflow."Brief" SET "currentRevisionId"=NULL WHERE "projectId"=target_project;
  UPDATE contextflow."Outline" SET "currentRevisionId"=NULL WHERE "projectId"=target_project;
  UPDATE contextflow."Article" SET "currentApprovedVersionId"=NULL WHERE "projectId"=target_project;
  UPDATE contextflow."Adaptation" SET "currentApprovedRevisionId"=NULL WHERE "projectId"=target_project;
  UPDATE contextflow."Script" SET "currentApprovedRevisionId"=NULL WHERE "projectId"=target_project;

  -- Null optional self-references such as snapshot/thread/comment history links before child-first deletion.
  FOR selected_child,nullable_columns IN
    SELECT child.name,string_agg(format('%I=NULL',a.attname),', ' ORDER BY ck.ord)
    FROM pg_constraint fk JOIN pg_class rel ON rel.oid=fk.conrelid JOIN pg_namespace ns ON ns.oid=rel.relnamespace
    JOIN pg_temp.m43_purge_targets child ON child.name=rel.relname
    JOIN LATERAL unnest(fk.conkey) WITH ORDINALITY ck(attnum,ord) ON true
    JOIN pg_attribute a ON a.attrelid=fk.conrelid AND a.attnum=ck.attnum
    WHERE fk.contype='f' AND fk.conrelid=fk.confrelid AND ns.nspname='contextflow' AND NOT a.attnotnull AND a.attname<>'projectId'
    GROUP BY child.name,fk.oid ORDER BY child.name
  LOOP
    IF (SELECT has_project_id FROM pg_temp.m43_purge_targets WHERE name=selected_child) THEN
      EXECUTE format('UPDATE contextflow.%I SET %s WHERE "projectId"=$1',selected_child,nullable_columns) USING target_project;
    ELSE
      EXECUTE format('UPDATE contextflow.%I x SET %s FROM contextflow."Job" j WHERE x."jobId"=j."id" AND j."projectId"=$1',selected_child,nullable_columns) USING target_project;
    END IF;
  END LOOP;

  LOOP
    iteration:=iteration+1;
    IF iteration>500 THEN RAISE EXCEPTION 'purge dependency walk did not converge' USING ERRCODE='55000'; END IF;
    IF NOT EXISTS(SELECT 1 FROM pg_temp.m43_purge_targets) THEN EXIT; END IF;
    selected_table:=NULL;
    SELECT parent.name INTO selected_table FROM pg_temp.m43_purge_targets parent
    WHERE NOT EXISTS (
      SELECT 1 FROM pg_constraint fk JOIN pg_class child_rel ON child_rel.oid=fk.conrelid JOIN pg_namespace child_ns ON child_ns.oid=child_rel.relnamespace
      JOIN pg_temp.m43_purge_targets child ON child.name=child_rel.relname
      WHERE fk.contype='f' AND fk.confrelid=to_regclass(format('contextflow.%I',parent.name))
        AND child_ns.nspname='contextflow' AND child.name<>parent.name AND NOT fk.oid=ANY(ignored_fk_ids)
    ) ORDER BY parent.name LIMIT 1;
    IF selected_table IS NULL THEN
      -- Break only nullable references between tables inside the fixed allowlist; mandatory or external dependencies fail closed.
      SELECT child.name,string_agg(format('%I=NULL',a.attname),', ' ORDER BY ck.ord),fk.oid
        INTO selected_child,nullable_columns,selected_fk
      FROM pg_constraint fk
      JOIN pg_class child_rel ON child_rel.oid=fk.conrelid JOIN pg_namespace ns ON ns.oid=child_rel.relnamespace
      JOIN pg_temp.m43_purge_targets child ON child.name=child_rel.relname
      JOIN pg_class parent_rel ON parent_rel.oid=fk.confrelid
      JOIN pg_temp.m43_purge_targets parent ON parent.name=parent_rel.relname
      JOIN LATERAL unnest(fk.conkey) WITH ORDINALITY ck(attnum,ord) ON true
      JOIN pg_attribute a ON a.attrelid=fk.conrelid AND a.attnum=ck.attnum
      WHERE fk.contype='f' AND ns.nspname='contextflow' AND child.name<>parent.name AND NOT a.attnotnull AND a.attname<>'projectId'
        AND NOT fk.oid=ANY(ignored_fk_ids)
      GROUP BY child.name,fk.oid ORDER BY child.name LIMIT 1;
      IF selected_child IS NULL THEN RAISE EXCEPTION 'purge graph has an unbreakable dependency' USING ERRCODE='55000'; END IF;
      IF (SELECT has_project_id FROM pg_temp.m43_purge_targets WHERE name=selected_child) THEN
        EXECUTE format('UPDATE contextflow.%I SET %s WHERE "projectId"=$1',selected_child,nullable_columns) USING target_project;
      ELSE
        EXECUTE format('UPDATE contextflow.%I x SET %s FROM contextflow."Job" j WHERE x."jobId"=j."id" AND j."projectId"=$1',selected_child,nullable_columns) USING target_project;
      END IF;
      ignored_fk_ids:=array_append(ignored_fk_ids,selected_fk);
      CONTINUE;
    END IF;
    IF (SELECT has_project_id FROM pg_temp.m43_purge_targets WHERE name=selected_table) THEN
      EXECUTE format('DELETE FROM contextflow.%I WHERE "projectId"=$1',selected_table) USING target_project;
    ELSE
      EXECUTE format('DELETE FROM contextflow.%I x USING contextflow."Job" j WHERE x."jobId"=j."id" AND j."projectId"=$1',selected_table) USING target_project;
    END IF;
    GET DIAGNOSTICS changed=ROW_COUNT; total_deleted:=total_deleted+changed;
    DELETE FROM pg_temp.m43_purge_targets WHERE name=selected_table;
  END LOOP;
  DELETE FROM contextflow."Project" WHERE "id"=target_project;
  GET DIAGNOSTICS changed=ROW_COUNT;
  IF changed<>1 THEN RAISE EXCEPTION 'project disappeared during purge' USING ERRCODE='40001'; END IF;
  FOR disabled_trigger IN SELECT name,trigger_name,mode FROM pg_temp.m43_purge_trigger_state ORDER BY name,trigger_name LOOP
    IF disabled_trigger.mode='A' THEN EXECUTE format('ALTER TABLE contextflow.%I ENABLE ALWAYS TRIGGER %I',disabled_trigger.name,disabled_trigger.trigger_name);
    ELSIF disabled_trigger.mode='R' THEN EXECUTE format('ALTER TABLE contextflow.%I ENABLE REPLICA TRIGGER %I',disabled_trigger.name,disabled_trigger.trigger_name);
    ELSE EXECUTE format('ALTER TABLE contextflow.%I ENABLE TRIGGER %I',disabled_trigger.name,disabled_trigger.trigger_name); END IF;
  END LOOP;
  DROP TABLE pg_temp.m43_purge_trigger_state;
  DROP TABLE pg_temp.m43_purge_targets;
  RETURN jsonb_build_object('projectId',target_project,'deletedRows',total_deleted+1,'cleanupPending',pending_count);
END $$;

CREATE FUNCTION purge_project_graph(target_project uuid, actor uuid, expected_revision integer)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,contextflow AS $$
BEGIN
  RETURN contextflow.purge_project_graph_scoped(target_project,actor,expected_revision,false);
END $$;

CREATE FUNCTION purge_workspace_graph(target_workspace uuid, actor uuid, expected_revision integer)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,contextflow AS $$
DECLARE current_owner uuid; current_revision integer; trashed_at timestamptz; purge_after timestamptz; selected_project record; cleanup_count integer:=0; deleted_projects integer:=0;
DECLARE trigger_state record; selected_table text;
BEGIN
  -- Workspace trash fences new work. Acquire locks in the same Job → Project → Workspace order used by workers.
  PERFORM j."id" FROM contextflow."Job" j JOIN contextflow."Project" p ON p."id"=j."projectId"
    WHERE p."workspaceId"=target_workspace AND j."status" IN ('QUEUED','RETRY_WAIT','RUNNING') ORDER BY j."id" FOR UPDATE OF j;
  PERFORM p."id" FROM contextflow."Project" p WHERE p."workspaceId"=target_workspace ORDER BY p."id" FOR UPDATE;
  -- Acquire the deterministic graph table-lock set before Workspace UPDATE lock to avoid Project→Workspace inversions.
  PERFORM contextflow.lock_project_purge_tables();
  SELECT w."ownerId",w."lifecycleRevision",w."trashedAt",w."purgeAfter" INTO current_owner,current_revision,trashed_at,purge_after
    FROM contextflow."Workspace" w WHERE w."id"=target_workspace FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Workspace not found' USING ERRCODE='P0002'; END IF;
  IF current_owner<>actor OR NOT EXISTS(SELECT 1 FROM contextflow."WorkspaceMember" m WHERE m."workspaceId"=target_workspace AND m."userId"=actor AND m."leftAt" IS NULL)
     OR (SELECT count(*) FROM contextflow."WorkspaceMember" m WHERE m."workspaceId"=target_workspace AND m."leftAt" IS NULL)<>1 THEN
    RAISE EXCEPTION 'only the sole active Workspace owner may purge it' USING ERRCODE='42501';
  END IF;
  IF current_revision<>expected_revision THEN RAISE EXCEPTION 'Workspace revision changed' USING ERRCODE='40001'; END IF;
  IF trashed_at IS NULL OR purge_after IS NULL OR purge_after>clock_timestamp() THEN RAISE EXCEPTION 'Workspace trash retention has not elapsed' USING ERRCODE='55000'; END IF;
  FOR selected_project IN SELECT p."id",p."revision" FROM contextflow."Project" p WHERE p."workspaceId"=target_workspace ORDER BY p."id" LOOP
    PERFORM contextflow.purge_project_graph_scoped(selected_project."id",actor,selected_project."revision",true);
    deleted_projects:=deleted_projects+1;
  END LOOP;
  -- Workspace-local style and membership history is removed only after every project graph is gone.
  LOCK TABLE contextflow."WorkspaceInvite" IN SHARE ROW EXCLUSIVE MODE;
  LOCK TABLE contextflow."WorkspaceMember" IN SHARE ROW EXCLUSIVE MODE;
  LOCK TABLE contextflow."WorkspaceStyleRevision" IN SHARE ROW EXCLUSIVE MODE;
  LOCK TABLE contextflow."Workspace" IN SHARE ROW EXCLUSIVE MODE;
  CREATE TEMP TABLE pg_temp.m43_workspace_trigger_state(name text, trigger_name text, mode "char", PRIMARY KEY(name,trigger_name)) ON COMMIT DROP;
  INSERT INTO pg_temp.m43_workspace_trigger_state(name,trigger_name,mode)
   SELECT cl.relname,tg.tgname,tg.tgenabled FROM pg_trigger tg JOIN pg_class cl ON cl.oid=tg.tgrelid JOIN pg_namespace ns ON ns.oid=cl.relnamespace
   WHERE ns.nspname='contextflow' AND cl.relname IN ('WorkspaceInvite','WorkspaceMember','WorkspaceStyleRevision','Workspace') AND NOT tg.tgisinternal AND tg.tgenabled<>'D';
  ALTER TABLE contextflow."WorkspaceInvite" DISABLE TRIGGER USER;
  ALTER TABLE contextflow."WorkspaceMember" DISABLE TRIGGER USER;
  ALTER TABLE contextflow."WorkspaceStyleRevision" DISABLE TRIGGER USER;
  ALTER TABLE contextflow."Workspace" DISABLE TRIGGER USER;
  DELETE FROM contextflow."WorkspaceInvite" WHERE "workspaceId"=target_workspace;
  DELETE FROM contextflow."WorkspaceMember" WHERE "workspaceId"=target_workspace;
  DELETE FROM contextflow."WorkspaceStyleRevision" WHERE "workspaceId"=target_workspace;
  DELETE FROM contextflow."Workspace" WHERE "id"=target_workspace;
  FOR trigger_state IN SELECT name,trigger_name,mode FROM pg_temp.m43_workspace_trigger_state ORDER BY name,trigger_name LOOP
    IF trigger_state.mode='A' THEN EXECUTE format('ALTER TABLE contextflow.%I ENABLE ALWAYS TRIGGER %I',trigger_state.name,trigger_state.trigger_name);
    ELSIF trigger_state.mode='R' THEN EXECUTE format('ALTER TABLE contextflow.%I ENABLE REPLICA TRIGGER %I',trigger_state.name,trigger_state.trigger_name);
    ELSE EXECUTE format('ALTER TABLE contextflow.%I ENABLE TRIGGER %I',trigger_state.name,trigger_state.trigger_name); END IF;
  END LOOP;
  DROP TABLE pg_temp.m43_workspace_trigger_state;
  SELECT count(*) INTO cleanup_count FROM contextflow."PrivateObjectDeletion" d WHERE d."workspaceId"=target_workspace AND d."state"='PENDING';
  RETURN jsonb_build_object('workspaceId',target_workspace,'deletedProjects',deleted_projects,'cleanupPending',cleanup_count);
END $$;

REVOKE ALL ON FUNCTION lock_project_purge_tables() FROM PUBLIC;
REVOKE ALL ON FUNCTION purge_project_graph_scoped(uuid,uuid,integer,boolean) FROM PUBLIC;
REVOKE ALL ON FUNCTION purge_project_graph(uuid,uuid,integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION purge_workspace_graph(uuid,uuid,integer) FROM PUBLIC;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='cf_runtime') THEN
    GRANT EXECUTE ON FUNCTION purge_project_graph(uuid,uuid,integer) TO cf_runtime;
    GRANT EXECUTE ON FUNCTION purge_workspace_graph(uuid,uuid,integer) TO cf_runtime;
  END IF;
END $$;

REVOKE ALL ON "EditorPresence", "PrivateObjectDeletion" FROM PUBLIC;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='cf_runtime') THEN
    REVOKE ALL ON "PrivateObjectDeletion" FROM cf_runtime;
    GRANT SELECT, INSERT, UPDATE, DELETE ON "EditorPresence" TO cf_runtime;
    GRANT SELECT ON "PrivateObjectDeletion" TO cf_runtime;
    GRANT UPDATE ("state", "attempts", "retryAfter", "deletedAt", "errorCategory") ON "PrivateObjectDeletion" TO cf_runtime;
  END IF;
END $$;

COMMIT;
