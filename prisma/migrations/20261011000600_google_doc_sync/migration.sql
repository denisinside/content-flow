BEGIN;
SET LOCAL search_path TO contextflow, public;

ALTER TYPE "JobOperation" ADD VALUE 'GOOGLE_DOCS_SYNC';
ALTER TABLE "GoogleDocSnapshot" ADD CONSTRAINT "GoogleDocSnapshot_project_id_unique" UNIQUE ("projectId", "id");

CREATE TABLE "GoogleDocSyncPreview" (
  "id" UUID NOT NULL,
  "projectId" UUID NOT NULL,
  "bindingId" UUID NOT NULL,
  "requestedBy" UUID NOT NULL,
  "connectionId" UUID NOT NULL,
  "sessionId" UUID NOT NULL,
  "noticeAcceptedAt" TIMESTAMPTZ(3) NOT NULL,
  "sourceVersionId" UUID,
  "remoteSnapshotId" UUID NOT NULL,
  "expectedArticleRevision" INTEGER NOT NULL,
  "kind" VARCHAR(32) NOT NULL,
  "frozenJson" JSONB NOT NULL,
  "payloadHash" CHAR(64) NOT NULL,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "expiresAt" TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT "GoogleDocSyncPreview_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "GoogleDocSyncPreview_kind_check" CHECK ("kind" IN ('PUSH','PULL','RECONCILE','COMMENT_CREATE','COMMENT_REPLY','COMMENT_RESOLVE','COMMENT_REOPEN','SUGGESTION_CREATE','SUGGESTION_ACCEPT','SUGGESTION_REJECT')),
  CONSTRAINT "GoogleDocSyncPreview_frozen_object_check" CHECK (jsonb_typeof("frozenJson") = 'object'),
  CONSTRAINT "GoogleDocSyncPreview_hash_check" CHECK ("payloadHash" ~ '^[a-f0-9]{64}$'),
  CONSTRAINT "GoogleDocSyncPreview_article_revision_check" CHECK ("expectedArticleRevision" >= 0),
  CONSTRAINT "GoogleDocSyncPreview_dates_check" CHECK ("expiresAt" > "createdAt" AND "noticeAcceptedAt" <= "createdAt"),
  CONSTRAINT "GoogleDocSyncPreview_project_fk" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT "GoogleDocSyncPreview_binding_project_fk" FOREIGN KEY ("bindingId", "projectId") REFERENCES "GoogleDocBinding"("id", "projectId") ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT "GoogleDocSyncPreview_requester_fk" FOREIGN KEY ("requestedBy") REFERENCES "UserProfile"("id") ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT "GoogleDocSyncPreview_connection_user_fk" FOREIGN KEY ("connectionId", "requestedBy") REFERENCES "GoogleDriveConnection"("id", "userId") ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT "GoogleDocSyncPreview_session_user_fk" FOREIGN KEY ("sessionId", "requestedBy") REFERENCES "AppSession"("id", "userId") ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT "GoogleDocSyncPreview_source_version_project_fk" FOREIGN KEY ("projectId", "sourceVersionId") REFERENCES "ArticleVersion"("projectId", "id") ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT "GoogleDocSyncPreview_remote_snapshot_project_fk" FOREIGN KEY ("projectId", "remoteSnapshotId") REFERENCES "GoogleDocSnapshot"("projectId", "id") ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT "GoogleDocSyncPreview_project_id_unique" UNIQUE ("projectId", "id")
);
CREATE INDEX "GoogleDocSyncPreview_project_binding_created_idx" ON "GoogleDocSyncPreview"("projectId", "bindingId", "createdAt" DESC);

CREATE TABLE "GoogleDocSyncOperation" (
  "id" UUID NOT NULL,
  "projectId" UUID NOT NULL,
  "bindingId" UUID NOT NULL,
  "requestedBy" UUID NOT NULL,
  "connectionId" UUID NOT NULL,
  "sessionId" UUID,
  "noticeAcceptedAt" TIMESTAMPTZ(3) NOT NULL,
  "backgroundGeneration" INTEGER,
  "commandKey" UUID NOT NULL,
  "kind" VARCHAR(32) NOT NULL,
  "state" VARCHAR(32) NOT NULL,
  "manifestJson" JSONB NOT NULL,
  "payloadHash" CHAR(64) NOT NULL,
  "jobId" UUID NOT NULL,
  "sourceVersionId" UUID,
  "previewId" UUID,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "submittedAt" TIMESTAMPTZ(3),
  "outcomeJson" JSONB,
  "readbackSnapshotId" UUID,
  "resultVersionId" UUID,
  CONSTRAINT "GoogleDocSyncOperation_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "GoogleDocSyncOperation_kind_check" CHECK ("kind" IN ('PUSH','PULL','RECONCILE','COMMENT_CREATE','COMMENT_REPLY','COMMENT_RESOLVE','COMMENT_REOPEN','SUGGESTION_CREATE','SUGGESTION_ACCEPT','SUGGESTION_REJECT')),
  CONSTRAINT "GoogleDocSyncOperation_state_check" CHECK ("state" IN ('QUEUED','SUBMITTED','SUCCEEDED','FAILED','UNKNOWN','PARTIAL','CANCELLED')),
  CONSTRAINT "GoogleDocSyncOperation_manifest_object_check" CHECK (jsonb_typeof("manifestJson") = 'object'),
  CONSTRAINT "GoogleDocSyncOperation_outcome_object_check" CHECK ("outcomeJson" IS NULL OR jsonb_typeof("outcomeJson") = 'object'),
  CONSTRAINT "GoogleDocSyncOperation_hash_check" CHECK ("payloadHash" ~ '^[a-f0-9]{64}$'),
  CONSTRAINT "GoogleDocSyncOperation_generation_check" CHECK ("backgroundGeneration" IS NULL OR "backgroundGeneration" > 0),
  CONSTRAINT "GoogleDocSyncOperation_timestamps_check" CHECK ("updatedAt" >= "createdAt" AND ("submittedAt" IS NULL OR "submittedAt" >= "createdAt") AND "noticeAcceptedAt" <= "createdAt"),
  CONSTRAINT "GoogleDocSyncOperation_result_version_state_check" CHECK ("resultVersionId" IS NULL OR "state" = 'SUCCEEDED'),
  CONSTRAINT "GoogleDocSyncOperation_project_fk" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT "GoogleDocSyncOperation_binding_project_fk" FOREIGN KEY ("bindingId", "projectId") REFERENCES "GoogleDocBinding"("id", "projectId") ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT "GoogleDocSyncOperation_requester_fk" FOREIGN KEY ("requestedBy") REFERENCES "UserProfile"("id") ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT "GoogleDocSyncOperation_connection_user_fk" FOREIGN KEY ("connectionId", "requestedBy") REFERENCES "GoogleDriveConnection"("id", "userId") ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT "GoogleDocSyncOperation_session_user_fk" FOREIGN KEY ("sessionId", "requestedBy") REFERENCES "AppSession"("id", "userId") ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT "GoogleDocSyncOperation_job_project_fk" FOREIGN KEY ("projectId", "jobId") REFERENCES "Job"("projectId", "id") ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT "GoogleDocSyncOperation_source_version_project_fk" FOREIGN KEY ("projectId", "sourceVersionId") REFERENCES "ArticleVersion"("projectId", "id") ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT "GoogleDocSyncOperation_preview_project_fk" FOREIGN KEY ("projectId", "previewId") REFERENCES "GoogleDocSyncPreview"("projectId", "id") ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT "GoogleDocSyncOperation_readback_snapshot_project_fk" FOREIGN KEY ("projectId", "readbackSnapshotId") REFERENCES "GoogleDocSnapshot"("projectId", "id") ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT "GoogleDocSyncOperation_result_version_project_fk" FOREIGN KEY ("projectId", "resultVersionId") REFERENCES "ArticleVersion"("projectId", "id") ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT "GoogleDocSyncOperation_job_unique" UNIQUE ("jobId"),
  CONSTRAINT "GoogleDocSyncOperation_project_id_unique" UNIQUE ("projectId", "id"),
  CONSTRAINT "GoogleDocSyncOperation_project_job_unique" UNIQUE ("projectId", "jobId"),
  CONSTRAINT "GoogleDocSyncOperation_project_actor_command_unique" UNIQUE ("projectId", "requestedBy", "commandKey")
);
CREATE INDEX "GoogleDocSyncOperation_project_binding_created_idx" ON "GoogleDocSyncOperation"("projectId", "bindingId", "createdAt" DESC);

CREATE TABLE "GoogleDocSyncState" (
  "bindingId" UUID NOT NULL,
  "projectId" UUID NOT NULL,
  "baselineSnapshotId" UUID,
  "baselineVersionId" UUID,
  "latestSnapshotId" UUID,
  "latestCandidateId" UUID,
  "status" VARCHAR(32) NOT NULL,
  "lastReadAt" TIMESTAMPTZ(3),
  "lastSuccessAt" TIMESTAMPTZ(3),
  "errorCategory" VARCHAR(64),
  "backgroundConnectionId" UUID,
  "backgroundUserId" UUID,
  "backgroundGrantedAt" TIMESTAMPTZ(3),
  "backgroundNoticeAcceptedAt" TIMESTAMPTZ(3),
  "backgroundGeneration" INTEGER NOT NULL DEFAULT 0,
  "nextPollAt" TIMESTAMPTZ(3),
  "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "GoogleDocSyncState_pkey" PRIMARY KEY ("bindingId"),
  CONSTRAINT "GoogleDocSyncState_status_check" CHECK (length(btrim("status")) BETWEEN 1 AND 32),
  CONSTRAINT "GoogleDocSyncState_error_category_check" CHECK ("errorCategory" IS NULL OR length(btrim("errorCategory")) BETWEEN 1 AND 64),
  CONSTRAINT "GoogleDocSyncState_background_generation_check" CHECK ("backgroundGeneration" >= 0),
  CONSTRAINT "GoogleDocSyncState_background_consent_check" CHECK (("backgroundConnectionId" IS NULL) = ("backgroundUserId" IS NULL)
    AND ("backgroundUserId" IS NULL) = ("backgroundGrantedAt" IS NULL)
    AND ("backgroundUserId" IS NULL) = ("backgroundNoticeAcceptedAt" IS NULL)
    AND ("backgroundUserId" IS NOT NULL OR "nextPollAt" IS NULL)),
  CONSTRAINT "GoogleDocSyncState_project_fk" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT "GoogleDocSyncState_binding_project_fk" FOREIGN KEY ("bindingId", "projectId") REFERENCES "GoogleDocBinding"("id", "projectId") ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT "GoogleDocSyncState_baseline_snapshot_project_fk" FOREIGN KEY ("projectId", "baselineSnapshotId") REFERENCES "GoogleDocSnapshot"("projectId", "id") ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT "GoogleDocSyncState_baseline_version_project_fk" FOREIGN KEY ("projectId", "baselineVersionId") REFERENCES "ArticleVersion"("projectId", "id") ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT "GoogleDocSyncState_latest_snapshot_project_fk" FOREIGN KEY ("projectId", "latestSnapshotId") REFERENCES "GoogleDocSnapshot"("projectId", "id") ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT "GoogleDocSyncState_latest_candidate_project_fk" FOREIGN KEY ("projectId", "latestCandidateId") REFERENCES "ArticleVersion"("projectId", "id") ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT "GoogleDocSyncState_background_connection_user_fk" FOREIGN KEY ("backgroundConnectionId", "backgroundUserId") REFERENCES "GoogleDriveConnection"("id", "userId") ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT "GoogleDocSyncState_background_user_fk" FOREIGN KEY ("backgroundUserId") REFERENCES "UserProfile"("id") ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT "GoogleDocSyncState_project_binding_unique" UNIQUE ("projectId", "bindingId")
);

CREATE TABLE "GoogleDocRemoteThread" (
  "id" UUID NOT NULL,
  "projectId" UUID NOT NULL,
  "bindingId" UUID NOT NULL,
  "remoteId" VARCHAR(1000) NOT NULL,
  "kind" VARCHAR(16) NOT NULL,
  "status" VARCHAR(32) NOT NULL,
  "payloadJson" JSONB NOT NULL,
  "quoteText" TEXT NOT NULL,
  "rangesJson" JSONB NOT NULL,
  "authorJson" JSONB NOT NULL,
  "localAnnotationId" UUID,
  "latestSnapshotId" UUID NOT NULL,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "GoogleDocRemoteThread_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "GoogleDocRemoteThread_remote_id_check" CHECK (length(btrim("remoteId")) BETWEEN 1 AND 1000 AND octet_length("remoteId") <= 2000),
  CONSTRAINT "GoogleDocRemoteThread_kind_check" CHECK ("kind" IN ('COMMENT','SUGGESTION')),
  CONSTRAINT "GoogleDocRemoteThread_status_check" CHECK (length(btrim("status")) BETWEEN 1 AND 32),
  CONSTRAINT "GoogleDocRemoteThread_payload_object_check" CHECK (jsonb_typeof("payloadJson") = 'object'),
  CONSTRAINT "GoogleDocRemoteThread_ranges_array_check" CHECK (jsonb_typeof("rangesJson") = 'array'),
  CONSTRAINT "GoogleDocRemoteThread_author_object_check" CHECK (jsonb_typeof("authorJson") = 'object'),
  CONSTRAINT "GoogleDocRemoteThread_project_fk" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT "GoogleDocRemoteThread_binding_project_fk" FOREIGN KEY ("bindingId", "projectId") REFERENCES "GoogleDocBinding"("id", "projectId") ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT "GoogleDocRemoteThread_local_annotation_project_fk" FOREIGN KEY ("projectId", "localAnnotationId") REFERENCES "ArticleAnnotation"("projectId", "id") ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT "GoogleDocRemoteThread_latest_snapshot_project_fk" FOREIGN KEY ("projectId", "latestSnapshotId") REFERENCES "GoogleDocSnapshot"("projectId", "id") ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT "GoogleDocRemoteThread_binding_kind_remote_unique" UNIQUE ("bindingId", "kind", "remoteId"),
  CONSTRAINT "GoogleDocRemoteThread_project_id_unique" UNIQUE ("projectId", "id"),
  CONSTRAINT "GoogleDocRemoteThread_binding_project_id_unique" UNIQUE ("bindingId", "projectId", "id")
);
CREATE INDEX "GoogleDocRemoteThread_binding_annotation_idx" ON "GoogleDocRemoteThread"("bindingId", "localAnnotationId");

CREATE TABLE "GoogleDocAnnotationEvent" (
  "id" UUID NOT NULL,
  "projectId" UUID NOT NULL,
  "bindingId" UUID NOT NULL,
  "threadId" UUID,
  "snapshotId" UUID NOT NULL,
  "eventHash" CHAR(64) NOT NULL,
  "payloadJson" JSONB NOT NULL,
  "capturedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "GoogleDocAnnotationEvent_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "GoogleDocAnnotationEvent_hash_check" CHECK ("eventHash" ~ '^[a-f0-9]{64}$'),
  CONSTRAINT "GoogleDocAnnotationEvent_payload_object_check" CHECK (jsonb_typeof("payloadJson") = 'object'),
  CONSTRAINT "GoogleDocAnnotationEvent_project_fk" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT "GoogleDocAnnotationEvent_binding_project_fk" FOREIGN KEY ("bindingId", "projectId") REFERENCES "GoogleDocBinding"("id", "projectId") ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT "GoogleDocAnnotationEvent_thread_binding_fk" FOREIGN KEY ("bindingId", "projectId", "threadId") REFERENCES "GoogleDocRemoteThread"("bindingId", "projectId", "id") ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT "GoogleDocAnnotationEvent_snapshot_project_fk" FOREIGN KEY ("projectId", "snapshotId") REFERENCES "GoogleDocSnapshot"("projectId", "id") ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT "GoogleDocAnnotationEvent_binding_hash_unique" UNIQUE ("bindingId", "eventHash")
);
CREATE INDEX "GoogleDocAnnotationEvent_project_binding_captured_idx" ON "GoogleDocAnnotationEvent"("projectId", "bindingId", "capturedAt" DESC);

CREATE TABLE "GoogleDocSnapshotCandidate" (
  "id" UUID NOT NULL,
  "projectId" UUID NOT NULL,
  "bindingId" UUID NOT NULL,
  "snapshotId" UUID NOT NULL,
  "sourceVersionId" UUID,
  "articleVersionId" UUID NOT NULL,
  "dedupeHash" CHAR(64) NOT NULL,
  "frozenInputsJson" JSONB NOT NULL,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "GoogleDocSnapshotCandidate_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "GoogleDocSnapshotCandidate_dedupe_hash_check" CHECK ("dedupeHash" ~ '^[a-f0-9]{64}$'),
  CONSTRAINT "GoogleDocSnapshotCandidate_inputs_object_check" CHECK (jsonb_typeof("frozenInputsJson") = 'object'),
  CONSTRAINT "GoogleDocSnapshotCandidate_project_fk" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT "GoogleDocSnapshotCandidate_binding_project_fk" FOREIGN KEY ("bindingId", "projectId") REFERENCES "GoogleDocBinding"("id", "projectId") ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT "GoogleDocSnapshotCandidate_snapshot_project_fk" FOREIGN KEY ("projectId", "snapshotId") REFERENCES "GoogleDocSnapshot"("projectId", "id") ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT "GoogleDocSnapshotCandidate_source_version_project_fk" FOREIGN KEY ("projectId", "sourceVersionId") REFERENCES "ArticleVersion"("projectId", "id") ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT "GoogleDocSnapshotCandidate_article_version_project_fk" FOREIGN KEY ("projectId", "articleVersionId") REFERENCES "ArticleVersion"("projectId", "id") ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT "GoogleDocSnapshotCandidate_binding_dedupe_unique" UNIQUE ("bindingId", "dedupeHash")
);
CREATE INDEX "GoogleDocSnapshotCandidate_project_article_version_idx" ON "GoogleDocSnapshotCandidate"("projectId", "articleVersionId");

CREATE FUNCTION guard_google_doc_sync_preview_immutable() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
  RAISE EXCEPTION 'Google Docs sync previews are immutable' USING ERRCODE = '23514';
END $$;
CREATE FUNCTION guard_google_doc_sync_operation_update() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
  IF NEW."id" IS DISTINCT FROM OLD."id" OR NEW."projectId" IS DISTINCT FROM OLD."projectId"
    OR NEW."bindingId" IS DISTINCT FROM OLD."bindingId" OR NEW."requestedBy" IS DISTINCT FROM OLD."requestedBy"
    OR NEW."connectionId" IS DISTINCT FROM OLD."connectionId" OR NEW."sessionId" IS DISTINCT FROM OLD."sessionId"
    OR NEW."noticeAcceptedAt" IS DISTINCT FROM OLD."noticeAcceptedAt" OR NEW."backgroundGeneration" IS DISTINCT FROM OLD."backgroundGeneration"
    OR NEW."commandKey" IS DISTINCT FROM OLD."commandKey" OR NEW."kind" IS DISTINCT FROM OLD."kind"
    OR NEW."manifestJson" IS DISTINCT FROM OLD."manifestJson" OR NEW."payloadHash" IS DISTINCT FROM OLD."payloadHash"
    OR NEW."jobId" IS DISTINCT FROM OLD."jobId" OR NEW."sourceVersionId" IS DISTINCT FROM OLD."sourceVersionId"
    OR NEW."previewId" IS DISTINCT FROM OLD."previewId" OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt"
    OR NEW."updatedAt" <= OLD."updatedAt" THEN
    RAISE EXCEPTION 'Google Docs sync operation request is immutable' USING ERRCODE = '23514';
  END IF;
  IF NOT ((OLD."state" = 'QUEUED' AND NEW."state" IN ('SUBMITTED','FAILED','CANCELLED'))
    OR (OLD."state" = 'SUBMITTED' AND NEW."state" IN ('SUCCEEDED','FAILED','UNKNOWN','PARTIAL','CANCELLED'))
    OR (OLD."state" IN ('UNKNOWN','PARTIAL') AND NEW."state" IN ('SUCCEEDED','FAILED','UNKNOWN','PARTIAL'))) THEN
    RAISE EXCEPTION 'invalid Google Docs sync operation transition' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE FUNCTION guard_google_doc_sync_state_update() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
  IF NEW."bindingId" IS DISTINCT FROM OLD."bindingId" OR NEW."projectId" IS DISTINCT FROM OLD."projectId" THEN
    RAISE EXCEPTION 'Google Docs sync state identity is immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE FUNCTION guard_google_doc_sync_state_delete() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
  RAISE EXCEPTION 'Google Docs sync state cannot be deleted' USING ERRCODE = '23514';
END $$;
CREATE FUNCTION guard_google_doc_remote_thread_update() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
  IF NEW."id" IS DISTINCT FROM OLD."id" OR NEW."projectId" IS DISTINCT FROM OLD."projectId"
    OR NEW."bindingId" IS DISTINCT FROM OLD."bindingId" OR NEW."remoteId" IS DISTINCT FROM OLD."remoteId"
    OR NEW."kind" IS DISTINCT FROM OLD."kind" OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt"
    OR (OLD."localAnnotationId" IS NOT NULL AND NEW."localAnnotationId" IS DISTINCT FROM OLD."localAnnotationId")
    OR NEW."updatedAt" <= OLD."updatedAt" THEN
    RAISE EXCEPTION 'Google Docs remote thread identity is immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE FUNCTION guard_google_doc_sync_immutable() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
  RAISE EXCEPTION 'Google Docs sync history is immutable' USING ERRCODE = '23514';
END $$;

CREATE TRIGGER "GoogleDocSyncPreview_no_update" BEFORE UPDATE ON "GoogleDocSyncPreview" FOR EACH ROW EXECUTE FUNCTION guard_google_doc_sync_preview_immutable();
CREATE TRIGGER "GoogleDocSyncPreview_no_delete" BEFORE DELETE ON "GoogleDocSyncPreview" FOR EACH ROW EXECUTE FUNCTION guard_google_doc_sync_preview_immutable();
CREATE TRIGGER "GoogleDocSyncOperation_update_guard" BEFORE UPDATE ON "GoogleDocSyncOperation" FOR EACH ROW EXECUTE FUNCTION guard_google_doc_sync_operation_update();
CREATE TRIGGER "GoogleDocSyncOperation_no_delete" BEFORE DELETE ON "GoogleDocSyncOperation" FOR EACH ROW EXECUTE FUNCTION guard_google_doc_sync_immutable();
CREATE TRIGGER "GoogleDocSyncState_update_guard" BEFORE UPDATE ON "GoogleDocSyncState" FOR EACH ROW EXECUTE FUNCTION guard_google_doc_sync_state_update();
CREATE TRIGGER "GoogleDocSyncState_no_delete" BEFORE DELETE ON "GoogleDocSyncState" FOR EACH ROW EXECUTE FUNCTION guard_google_doc_sync_state_delete();
CREATE TRIGGER "GoogleDocRemoteThread_update_guard" BEFORE UPDATE ON "GoogleDocRemoteThread" FOR EACH ROW EXECUTE FUNCTION guard_google_doc_remote_thread_update();
CREATE TRIGGER "GoogleDocRemoteThread_no_delete" BEFORE DELETE ON "GoogleDocRemoteThread" FOR EACH ROW EXECUTE FUNCTION guard_google_doc_sync_immutable();
CREATE TRIGGER "GoogleDocAnnotationEvent_no_update" BEFORE UPDATE ON "GoogleDocAnnotationEvent" FOR EACH ROW EXECUTE FUNCTION guard_google_doc_sync_immutable();
CREATE TRIGGER "GoogleDocAnnotationEvent_no_delete" BEFORE DELETE ON "GoogleDocAnnotationEvent" FOR EACH ROW EXECUTE FUNCTION guard_google_doc_sync_immutable();
CREATE TRIGGER "GoogleDocSnapshotCandidate_no_update" BEFORE UPDATE ON "GoogleDocSnapshotCandidate" FOR EACH ROW EXECUTE FUNCTION guard_google_doc_sync_immutable();
CREATE TRIGGER "GoogleDocSnapshotCandidate_no_delete" BEFORE DELETE ON "GoogleDocSnapshotCandidate" FOR EACH ROW EXECUTE FUNCTION guard_google_doc_sync_immutable();

REVOKE ALL ON "GoogleDocSyncPreview", "GoogleDocSyncOperation", "GoogleDocSyncState", "GoogleDocRemoteThread", "GoogleDocAnnotationEvent", "GoogleDocSnapshotCandidate" FROM PUBLIC;
REVOKE ALL ON FUNCTION guard_google_doc_sync_preview_immutable(), guard_google_doc_sync_operation_update(), guard_google_doc_sync_state_update(), guard_google_doc_sync_state_delete(), guard_google_doc_remote_thread_update(), guard_google_doc_sync_immutable() FROM PUBLIC;
DO $$ DECLARE role_name TEXT; BEGIN
  FOREACH role_name IN ARRAY ARRAY['anon','authenticated'] LOOP
    IF to_regrole(role_name) IS NOT NULL THEN
      EXECUTE format('REVOKE ALL ON contextflow."GoogleDocSyncPreview",contextflow."GoogleDocSyncOperation",contextflow."GoogleDocSyncState",contextflow."GoogleDocRemoteThread",contextflow."GoogleDocAnnotationEvent",contextflow."GoogleDocSnapshotCandidate" FROM %I', role_name);
    END IF;
  END LOOP;
END $$;
GRANT SELECT, INSERT ON "GoogleDocSyncPreview", "GoogleDocAnnotationEvent", "GoogleDocSnapshotCandidate" TO cf_runtime;
GRANT SELECT, INSERT, UPDATE ON "GoogleDocSyncOperation", "GoogleDocSyncState", "GoogleDocRemoteThread" TO cf_runtime;

COMMIT;
