BEGIN;
SET LOCAL search_path TO contextflow, public;

CREATE TYPE "GoogleDocCreateState" AS ENUM ('SUBMITTED', 'UNKNOWN', 'CREATED', 'FAILED');

CREATE TABLE "GoogleDocCreateCommand" (
  "id" UUID NOT NULL,
  "projectId" UUID NOT NULL,
  "userId" UUID NOT NULL,
  "connectionId" UUID NOT NULL,
  "commandKey" UUID NOT NULL,
  "payloadHash" CHAR(64) NOT NULL,
  "title" VARCHAR(200) NOT NULL,
  "state" "GoogleDocCreateState" NOT NULL DEFAULT 'SUBMITTED',
  "documentId" VARCHAR(128),
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "GoogleDocCreateCommand_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "GoogleDocCreateCommand_hash_check" CHECK ("payloadHash" ~ '^[a-f0-9]{64}$'),
  CONSTRAINT "GoogleDocCreateCommand_title_check" CHECK (length(btrim("title")) BETWEEN 1 AND 200),
  CONSTRAINT "GoogleDocCreateCommand_document_id_check" CHECK ("documentId" IS NULL OR length(btrim("documentId")) BETWEEN 1 AND 128),
  CONSTRAINT "GoogleDocCreateCommand_outcome_check" CHECK (("state" = 'CREATED' AND "documentId" IS NOT NULL) OR ("state" <> 'CREATED' AND "documentId" IS NULL)),
  CONSTRAINT "GoogleDocCreateCommand_timestamps_check" CHECK ("updatedAt" >= "createdAt"),
  CONSTRAINT "GoogleDocCreateCommand_project_fk" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT "GoogleDocCreateCommand_user_fk" FOREIGN KEY ("userId") REFERENCES "UserProfile"("id") ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT "GoogleDocCreateCommand_connection_user_fk" FOREIGN KEY ("connectionId", "userId") REFERENCES "GoogleDriveConnection"("id", "userId") ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT "GoogleDocCreateCommand_project_user_key_unique" UNIQUE ("projectId", "userId", "commandKey")
);

CREATE INDEX "GoogleDocCreateCommand_project_user_created_idx" ON "GoogleDocCreateCommand"("projectId", "userId", "createdAt" DESC);
CREATE UNIQUE INDEX "GoogleDocCreateCommand_one_unresolved_per_project" ON "GoogleDocCreateCommand"("projectId") WHERE "state" IN ('SUBMITTED', 'UNKNOWN');

CREATE FUNCTION guard_google_doc_create_command_update() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
  IF NEW."id" IS DISTINCT FROM OLD."id"
    OR NEW."projectId" IS DISTINCT FROM OLD."projectId"
    OR NEW."userId" IS DISTINCT FROM OLD."userId"
    OR NEW."connectionId" IS DISTINCT FROM OLD."connectionId"
    OR NEW."commandKey" IS DISTINCT FROM OLD."commandKey"
    OR NEW."payloadHash" IS DISTINCT FROM OLD."payloadHash"
    OR NEW."title" IS DISTINCT FROM OLD."title"
    OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt"
    OR NEW."updatedAt" <= OLD."updatedAt" THEN
    RAISE EXCEPTION 'Google Docs create command payload and identity are immutable' USING ERRCODE = '23514';
  END IF;
  IF NOT ((OLD."state" = 'SUBMITTED' AND NEW."state" IN ('UNKNOWN', 'CREATED', 'FAILED'))
    OR (OLD."state" = 'UNKNOWN' AND NEW."state" IN ('UNKNOWN', 'CREATED'))) THEN
    RAISE EXCEPTION 'invalid Google Docs create command transition' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;

CREATE FUNCTION guard_google_doc_create_command_delete() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
  RAISE EXCEPTION 'Google Docs create command history cannot be deleted' USING ERRCODE = '23514';
END $$;

CREATE TRIGGER "GoogleDocCreateCommand_update_guard" BEFORE UPDATE ON "GoogleDocCreateCommand" FOR EACH ROW EXECUTE FUNCTION guard_google_doc_create_command_update();
CREATE TRIGGER "GoogleDocCreateCommand_no_delete" BEFORE DELETE ON "GoogleDocCreateCommand" FOR EACH ROW EXECUTE FUNCTION guard_google_doc_create_command_delete();

REVOKE ALL ON "GoogleDocCreateCommand" FROM PUBLIC;
REVOKE ALL ON TYPE "GoogleDocCreateState" FROM PUBLIC;
REVOKE ALL ON FUNCTION guard_google_doc_create_command_update(), guard_google_doc_create_command_delete() FROM PUBLIC;
DO $$ DECLARE role_name TEXT; BEGIN
  FOREACH role_name IN ARRAY ARRAY['anon','authenticated'] LOOP
    IF to_regrole(role_name) IS NOT NULL THEN
      EXECUTE format('REVOKE ALL ON contextflow."GoogleDocCreateCommand" FROM %I', role_name);
      EXECUTE format('REVOKE ALL ON TYPE contextflow."GoogleDocCreateState" FROM %I', role_name);
    END IF;
  END LOOP;
END $$;
GRANT USAGE ON TYPE "GoogleDocCreateState" TO cf_runtime;
GRANT SELECT, INSERT, UPDATE ON "GoogleDocCreateCommand" TO cf_runtime;

COMMIT;
