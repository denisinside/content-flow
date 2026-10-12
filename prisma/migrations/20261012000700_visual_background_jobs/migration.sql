ALTER TYPE contextflow."JobOperation" ADD VALUE 'VISUAL_BACKGROUND_GENERATION';

BEGIN;
CREATE TABLE contextflow."VisualBackgroundCandidate" (
 "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(), "projectId" uuid NOT NULL, "compositionRevisionId" uuid NOT NULL,
 "frameId" uuid NOT NULL, "jobId" uuid NOT NULL UNIQUE, "aiExecutionId" uuid NOT NULL, "assetId" uuid NOT NULL UNIQUE,
 "report" jsonb NOT NULL, "createdAt" timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 UNIQUE("projectId","id"),
 FOREIGN KEY("projectId","compositionRevisionId") REFERENCES contextflow."VisualCompositionRevision"("projectId","id") ON DELETE RESTRICT,
 FOREIGN KEY("projectId","jobId") REFERENCES contextflow."Job"("projectId","id") ON DELETE RESTRICT,
 FOREIGN KEY("projectId","aiExecutionId") REFERENCES contextflow."AIExecution"("projectId","id") ON DELETE RESTRICT,
 FOREIGN KEY("projectId","assetId") REFERENCES contextflow."Asset"("projectId","id") ON DELETE RESTRICT
);
CREATE TABLE contextflow."VisualBackgroundApplication" (
 "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(), "projectId" uuid NOT NULL, "candidateId" uuid NOT NULL,
 "commandKey" varchar(128) NOT NULL, "inputHash" char(64) NOT NULL, "appliedBy" uuid NOT NULL,
 "draftCounter" integer NOT NULL, "createdAt" timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 UNIQUE("projectId","commandKey"),
 FOREIGN KEY("projectId","candidateId") REFERENCES contextflow."VisualBackgroundCandidate"("projectId","id") ON DELETE RESTRICT,
 FOREIGN KEY("appliedBy") REFERENCES contextflow."UserProfile"("id") ON DELETE RESTRICT,
 CHECK("inputHash" ~ '^[a-f0-9]{64}$')
);
CREATE TRIGGER "VisualBackgroundCandidate_immutable" BEFORE UPDATE OR DELETE ON contextflow."VisualBackgroundCandidate" FOR EACH ROW EXECUTE FUNCTION contextflow.guard_visual_revision_immutable();
CREATE TRIGGER "VisualBackgroundApplication_immutable" BEFORE UPDATE OR DELETE ON contextflow."VisualBackgroundApplication" FOR EACH ROW EXECUTE FUNCTION contextflow.guard_visual_revision_immutable();
DO $$ DECLARE source text; old text; replacement text; BEGIN
 source := pg_get_functiondef('contextflow.purge_project_graph_scoped(uuid,uuid,integer,boolean)'::regprocedure);
 old := '(''VisualComposition'',true)';
 replacement := '(''VisualBackgroundCandidate'',true),(''VisualBackgroundApplication'',true),(''VisualComposition'',true)';
 IF position(old IN source)=0 THEN RAISE EXCEPTION 'Visual purge boundary changed'; END IF;
 EXECUTE replace(source,old,replacement);
END $$;
REVOKE ALL ON contextflow."VisualBackgroundCandidate",contextflow."VisualBackgroundApplication" FROM PUBLIC;
DO $$ BEGIN IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='cf_runtime') THEN
 GRANT SELECT,INSERT ON contextflow."VisualBackgroundCandidate",contextflow."VisualBackgroundApplication" TO cf_runtime;
END IF; END $$;
COMMIT;
