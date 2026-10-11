BEGIN;
SET LOCAL search_path TO contextflow, public;

CREATE TABLE "GoogleDocBinding" (
  "id" UUID NOT NULL,
  "projectId" UUID NOT NULL,
  "connectionId" UUID NOT NULL,
  "connectionUserId" UUID NOT NULL,
  "documentId" VARCHAR(128) NOT NULL,
  "tabId" VARCHAR(128) NOT NULL,
  "createdBy" UUID NOT NULL,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "endedAt" TIMESTAMPTZ(3),
  CONSTRAINT "GoogleDocBinding_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "GoogleDocBinding_document_id_check" CHECK (length(btrim("documentId")) BETWEEN 1 AND 128),
  CONSTRAINT "GoogleDocBinding_tab_id_check" CHECK (length(btrim("tabId")) BETWEEN 1 AND 128),
  CONSTRAINT "GoogleDocBinding_end_date_check" CHECK ("endedAt" IS NULL OR "endedAt" > "createdAt"),
  CONSTRAINT "GoogleDocBinding_project_fk" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT "GoogleDocBinding_connection_user_fk" FOREIGN KEY ("connectionId", "connectionUserId") REFERENCES "GoogleDriveConnection"("id", "userId") ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT "GoogleDocBinding_creator_fk" FOREIGN KEY ("createdBy") REFERENCES "UserProfile"("id") ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT "GoogleDocBinding_project_id_unique" UNIQUE ("id", "projectId")
);
CREATE UNIQUE INDEX "GoogleDocBinding_one_active_project" ON "GoogleDocBinding"("projectId") WHERE "endedAt" IS NULL;
CREATE UNIQUE INDEX "GoogleDocBinding_one_active_remote_tab" ON "GoogleDocBinding"("documentId", "tabId") WHERE "endedAt" IS NULL;
CREATE INDEX "GoogleDocBinding_project_created_idx" ON "GoogleDocBinding"("projectId", "createdAt" DESC, "id" DESC);

CREATE TABLE "GoogleDocSnapshot" (
  "id" UUID NOT NULL,
  "projectId" UUID NOT NULL,
  "bindingId" UUID NOT NULL,
  "remoteRevision" VARCHAR(256) NOT NULL,
  "payload" JSONB NOT NULL,
  "converted" JSONB NOT NULL,
  "contentHash" CHAR(64) NOT NULL,
  "capturedBy" UUID NOT NULL,
  "capturedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "GoogleDocSnapshot_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "GoogleDocSnapshot_remote_revision_check" CHECK (length(btrim("remoteRevision")) BETWEEN 1 AND 256),
  CONSTRAINT "GoogleDocSnapshot_payload_object_check" CHECK (jsonb_typeof("payload") = 'object'),
  CONSTRAINT "GoogleDocSnapshot_converted_object_check" CHECK (jsonb_typeof("converted") = 'object'),
  CONSTRAINT "GoogleDocSnapshot_hash_check" CHECK ("contentHash" ~ '^[a-f0-9]{64}$'),
  CONSTRAINT "GoogleDocSnapshot_binding_project_fk" FOREIGN KEY ("bindingId", "projectId") REFERENCES "GoogleDocBinding"("id", "projectId") ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT "GoogleDocSnapshot_capturer_fk" FOREIGN KEY ("capturedBy") REFERENCES "UserProfile"("id") ON DELETE RESTRICT ON UPDATE NO ACTION
);
CREATE INDEX "GoogleDocSnapshot_project_binding_captured_idx" ON "GoogleDocSnapshot"("projectId", "bindingId", "capturedAt" DESC, "id" DESC);

CREATE TABLE "GoogleDocBindCommand" (
  "projectId" UUID NOT NULL,
  "createdBy" UUID NOT NULL,
  "commandKey" UUID NOT NULL,
  "payloadHash" CHAR(64) NOT NULL,
  "bindingId" UUID NOT NULL,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "GoogleDocBindCommand_pkey" PRIMARY KEY ("projectId", "createdBy", "commandKey"),
  CONSTRAINT "GoogleDocBindCommand_hash_check" CHECK ("payloadHash" ~ '^[a-f0-9]{64}$'),
  CONSTRAINT "GoogleDocBindCommand_project_fk" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT "GoogleDocBindCommand_creator_fk" FOREIGN KEY ("createdBy") REFERENCES "UserProfile"("id") ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT "GoogleDocBindCommand_binding_project_fk" FOREIGN KEY ("bindingId", "projectId") REFERENCES "GoogleDocBinding"("id", "projectId") ON DELETE RESTRICT ON UPDATE NO ACTION
);
CREATE INDEX "GoogleDocBindCommand_project_binding_idx" ON "GoogleDocBindCommand"("projectId", "bindingId");

CREATE FUNCTION guard_google_doc_binding_update() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
  IF (to_jsonb(NEW) - 'endedAt') IS DISTINCT FROM (to_jsonb(OLD) - 'endedAt')
    OR OLD."endedAt" IS NOT NULL OR NEW."endedAt" IS NULL THEN
    RAISE EXCEPTION 'Google Doc binding identity is immutable and may end once' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE FUNCTION guard_google_doc_binding_delete() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
  RAISE EXCEPTION 'Google Doc binding history cannot be deleted' USING ERRCODE = '23514';
END $$;
CREATE FUNCTION guard_google_doc_snapshot_immutable() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
  RAISE EXCEPTION 'Google Doc snapshots are immutable' USING ERRCODE = '23514';
END $$;
CREATE FUNCTION guard_google_doc_bind_command_immutable() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
  RAISE EXCEPTION 'Google Doc bind command history is immutable' USING ERRCODE = '23514';
END $$;

CREATE TRIGGER "GoogleDocBinding_update_guard" BEFORE UPDATE ON "GoogleDocBinding" FOR EACH ROW EXECUTE FUNCTION guard_google_doc_binding_update();
CREATE TRIGGER "GoogleDocBinding_no_delete" BEFORE DELETE ON "GoogleDocBinding" FOR EACH ROW EXECUTE FUNCTION guard_google_doc_binding_delete();
CREATE TRIGGER "GoogleDocSnapshot_no_update" BEFORE UPDATE ON "GoogleDocSnapshot" FOR EACH ROW EXECUTE FUNCTION guard_google_doc_snapshot_immutable();
CREATE TRIGGER "GoogleDocSnapshot_no_delete" BEFORE DELETE ON "GoogleDocSnapshot" FOR EACH ROW EXECUTE FUNCTION guard_google_doc_snapshot_immutable();
CREATE TRIGGER "GoogleDocBindCommand_no_update" BEFORE UPDATE ON "GoogleDocBindCommand" FOR EACH ROW EXECUTE FUNCTION guard_google_doc_bind_command_immutable();
CREATE TRIGGER "GoogleDocBindCommand_no_delete" BEFORE DELETE ON "GoogleDocBindCommand" FOR EACH ROW EXECUTE FUNCTION guard_google_doc_bind_command_immutable();

REVOKE ALL ON "GoogleDocBinding", "GoogleDocSnapshot", "GoogleDocBindCommand" FROM PUBLIC;
REVOKE ALL ON FUNCTION guard_google_doc_binding_update(), guard_google_doc_binding_delete(), guard_google_doc_snapshot_immutable(), guard_google_doc_bind_command_immutable() FROM PUBLIC;
DO $$ DECLARE role_name TEXT; BEGIN
  FOREACH role_name IN ARRAY ARRAY['anon','authenticated'] LOOP
    IF to_regrole(role_name) IS NOT NULL THEN
      EXECUTE format('REVOKE ALL ON contextflow."GoogleDocBinding",contextflow."GoogleDocSnapshot",contextflow."GoogleDocBindCommand" FROM %I', role_name);
    END IF;
  END LOOP;
END $$;
GRANT SELECT, INSERT, UPDATE ON "GoogleDocBinding" TO cf_runtime;
GRANT SELECT, INSERT ON "GoogleDocSnapshot", "GoogleDocBindCommand" TO cf_runtime;

COMMIT;
