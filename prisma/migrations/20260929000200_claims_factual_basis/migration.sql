BEGIN;
SET LOCAL search_path TO contextflow;
-- CreateEnum
CREATE TYPE "ClaimStatus" AS ENUM ('PROPOSED', 'APPROVED', 'REJECTED');

-- CreateEnum
CREATE TYPE "EvidenceRelation" AS ENUM ('SUPPORTS', 'CONTRADICTS');

-- CreateEnum
CREATE TYPE "ConflictOrigin" AS ENUM ('MANUAL', 'DETECTED');

-- CreateEnum
CREATE TYPE "AIExecutionStatus" AS ENUM ('RUNNING', 'SUCCEEDED', 'FAILED', 'OUTCOME_UNKNOWN');

-- CreateTable
CREATE TABLE "Claim" (
    "id" UUID NOT NULL,
    "projectId" UUID NOT NULL,
    "revision" INTEGER NOT NULL DEFAULT 1,
    "currentRevisionId" UUID,
    "createdBy" UUID NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Claim_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ClaimRevision" (
    "id" UUID NOT NULL,
    "projectId" UUID NOT NULL,
    "claimId" UUID NOT NULL,
    "number" INTEGER NOT NULL,
    "wording" VARCHAR(2000) NOT NULL,
    "sha256" CHAR(64) NOT NULL,
    "status" "ClaimStatus" NOT NULL DEFAULT 'PROPOSED',
    "jobId" UUID,
    "providerClaimKey" VARCHAR(64),
    "createdBy" UUID NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "approvedBy" UUID,
    "approvedAt" TIMESTAMPTZ(3),
    "rejectedBy" UUID,
    "rejectedAt" TIMESTAMPTZ(3),
    "withdrawnBy" UUID,
    "withdrawnAt" TIMESTAMPTZ(3),
    "withdrawalReason" VARCHAR(2000),

    CONSTRAINT "ClaimRevision_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ClaimEvidence" (
    "id" UUID NOT NULL,
    "projectId" UUID NOT NULL,
    "claimRevisionId" UUID NOT NULL,
    "snapshotId" UUID NOT NULL,
    "fragmentId" UUID NOT NULL,
    "startOffset" INTEGER NOT NULL,
    "endOffset" INTEGER NOT NULL,
    "quote" VARCHAR(10000) NOT NULL,
    "sha256" CHAR(64) NOT NULL,
    "relation" "EvidenceRelation" NOT NULL,
    "capturedPurpose" "MaterialPurpose" NOT NULL DEFAULT 'FACTUAL_SOURCE',
    "createdBy" UUID NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "invalidatedBy" UUID,
    "invalidatedAt" TIMESTAMPTZ(3),
    "invalidationReason" VARCHAR(2000),

    CONSTRAINT "ClaimEvidence_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ClaimConflict" (
    "id" UUID NOT NULL,
    "projectId" UUID NOT NULL,
    "revision" INTEGER NOT NULL DEFAULT 1,
    "origin" "ConflictOrigin" NOT NULL,
    "rationale" VARCHAR(2000) NOT NULL,
    "createdBy" UUID NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedBy" UUID,
    "resolvedAt" TIMESTAMPTZ(3),
    "selectedRevisionId" UUID,
    "formulation" VARCHAR(2000),
    "resolutionRationale" VARCHAR(2000),

    CONSTRAINT "ClaimConflict_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ClaimConflictParticipant" (
    "projectId" UUID NOT NULL,
    "conflictId" UUID NOT NULL,
    "claimId" UUID NOT NULL,
    "revisionId" UUID NOT NULL,

    CONSTRAINT "ClaimConflictParticipant_pkey" PRIMARY KEY ("conflictId","revisionId")
);

-- CreateTable
CREATE TABLE "ConflictResolutionEvidence" (
    "projectId" UUID NOT NULL,
    "conflictId" UUID NOT NULL,
    "claimRevisionId" UUID NOT NULL,
    "evidenceId" UUID NOT NULL,

    CONSTRAINT "ConflictResolutionEvidence_pkey" PRIMARY KEY ("conflictId","evidenceId")
);

-- CreateTable
CREATE TABLE "FactualBasisRevision" (
    "id" UUID NOT NULL,
    "projectId" UUID NOT NULL,
    "sequence" INTEGER NOT NULL,
    "manifest" JSONB NOT NULL,
    "sha256" CHAR(64) NOT NULL,
    "createdBy" UUID NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FactualBasisRevision_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BasisClaim" (
    "projectId" UUID NOT NULL,
    "basisId" UUID NOT NULL,
    "claimId" UUID NOT NULL,
    "claimRevisionId" UUID NOT NULL,

    CONSTRAINT "BasisClaim_pkey" PRIMARY KEY ("basisId","claimRevisionId")
);

-- CreateTable
CREATE TABLE "BasisClaimEvidence" (
    "projectId" UUID NOT NULL,
    "basisId" UUID NOT NULL,
    "claimRevisionId" UUID NOT NULL,
    "evidenceId" UUID NOT NULL,

    CONSTRAINT "BasisClaimEvidence_pkey" PRIMARY KEY ("basisId","claimRevisionId","evidenceId")
);

-- CreateTable
CREATE TABLE "AIExecution" (
    "id" UUID NOT NULL,
    "projectId" UUID NOT NULL,
    "jobId" UUID NOT NULL,
    "attemptId" UUID NOT NULL,
    "workflowId" VARCHAR(200) NOT NULL,
    "releaseId" VARCHAR(100) NOT NULL,
    "configDigest" CHAR(64) NOT NULL,
    "contractVersion" VARCHAR(64) NOT NULL,
    "promptTemplateVersion" VARCHAR(64) NOT NULL,
    "inputManifest" JSONB NOT NULL,
    "inputHash" CHAR(64) NOT NULL,
    "providerRunId" VARCHAR(200),
    "model" VARCHAR(200),
    "status" "AIExecutionStatus" NOT NULL DEFAULT 'RUNNING',
    "startedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMPTZ(3),
    "errorCategory" VARCHAR(64),

    CONSTRAINT "AIExecution_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Claim_projectId_createdAt_id_idx" ON "Claim"("projectId", "createdAt", "id");

-- CreateIndex
CREATE UNIQUE INDEX "Claim_projectId_id_key" ON "Claim"("projectId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "ClaimRevision_projectId_id_key" ON "ClaimRevision"("projectId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "ClaimRevision_projectId_claimId_id_key" ON "ClaimRevision"("projectId", "claimId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "ClaimRevision_claimId_number_key" ON "ClaimRevision"("claimId", "number");

-- CreateIndex
CREATE UNIQUE INDEX "ClaimRevision_jobId_providerClaimKey_key" ON "ClaimRevision"("jobId", "providerClaimKey");

-- CreateIndex
CREATE INDEX "ClaimEvidence_projectId_snapshotId_idx" ON "ClaimEvidence"("projectId", "snapshotId");

-- CreateIndex
CREATE UNIQUE INDEX "ClaimEvidence_projectId_id_key" ON "ClaimEvidence"("projectId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "ClaimEvidence_projectId_claimRevisionId_id_key" ON "ClaimEvidence"("projectId", "claimRevisionId", "id");

-- CreateIndex
CREATE INDEX "ClaimConflict_projectId_resolvedAt_idx" ON "ClaimConflict"("projectId", "resolvedAt");

-- CreateIndex
CREATE UNIQUE INDEX "ClaimConflict_projectId_id_key" ON "ClaimConflict"("projectId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "ClaimConflict_projectId_id_selectedRevisionId_key" ON "ClaimConflict"("projectId", "id", "selectedRevisionId");

-- CreateIndex
CREATE INDEX "ClaimConflictParticipant_projectId_claimId_idx" ON "ClaimConflictParticipant"("projectId", "claimId");

-- CreateIndex
CREATE UNIQUE INDEX "ClaimConflictParticipant_conflictId_claimId_key" ON "ClaimConflictParticipant"("conflictId", "claimId");

-- CreateIndex
CREATE UNIQUE INDEX "FactualBasisRevision_projectId_id_key" ON "FactualBasisRevision"("projectId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "FactualBasisRevision_projectId_sequence_key" ON "FactualBasisRevision"("projectId", "sequence");

-- CreateIndex
CREATE UNIQUE INDEX "BasisClaim_basisId_claimId_key" ON "BasisClaim"("basisId", "claimId");

-- CreateIndex
CREATE UNIQUE INDEX "BasisClaim_projectId_basisId_claimRevisionId_key" ON "BasisClaim"("projectId", "basisId", "claimRevisionId");

-- CreateIndex
CREATE INDEX "AIExecution_projectId_jobId_idx" ON "AIExecution"("projectId", "jobId");

-- CreateIndex
CREATE UNIQUE INDEX "AIExecution_attemptId_key" ON "AIExecution"("attemptId");

-- CreateIndex
CREATE UNIQUE INDEX "JobAttempt_jobId_id_key" ON "JobAttempt"("jobId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "SourceFragment_projectId_snapshotId_id_key" ON "SourceFragment"("projectId", "snapshotId", "id");

-- AddForeignKey
ALTER TABLE "Claim" ADD CONSTRAINT "Claim_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "Claim" ADD CONSTRAINT "Claim_projectId_id_currentRevisionId_fkey" FOREIGN KEY ("projectId", "id", "currentRevisionId") REFERENCES "ClaimRevision"("projectId", "claimId", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "Claim" ADD CONSTRAINT "Claim_createdBy_fkey" FOREIGN KEY ("createdBy") REFERENCES "UserProfile"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "ClaimRevision" ADD CONSTRAINT "ClaimRevision_projectId_claimId_fkey" FOREIGN KEY ("projectId", "claimId") REFERENCES "Claim"("projectId", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "ClaimRevision" ADD CONSTRAINT "ClaimRevision_projectId_jobId_fkey" FOREIGN KEY ("projectId", "jobId") REFERENCES "Job"("projectId", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "ClaimRevision" ADD CONSTRAINT "ClaimRevision_createdBy_fkey" FOREIGN KEY ("createdBy") REFERENCES "UserProfile"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "ClaimRevision" ADD CONSTRAINT "ClaimRevision_approvedBy_fkey" FOREIGN KEY ("approvedBy") REFERENCES "UserProfile"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "ClaimRevision" ADD CONSTRAINT "ClaimRevision_rejectedBy_fkey" FOREIGN KEY ("rejectedBy") REFERENCES "UserProfile"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "ClaimRevision" ADD CONSTRAINT "ClaimRevision_withdrawnBy_fkey" FOREIGN KEY ("withdrawnBy") REFERENCES "UserProfile"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "ClaimEvidence" ADD CONSTRAINT "ClaimEvidence_projectId_claimRevisionId_fkey" FOREIGN KEY ("projectId", "claimRevisionId") REFERENCES "ClaimRevision"("projectId", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "ClaimEvidence" ADD CONSTRAINT "ClaimEvidence_projectId_snapshotId_fkey" FOREIGN KEY ("projectId", "snapshotId") REFERENCES "SourceSnapshot"("projectId", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "ClaimEvidence" ADD CONSTRAINT "ClaimEvidence_projectId_snapshotId_fragmentId_fkey" FOREIGN KEY ("projectId", "snapshotId", "fragmentId") REFERENCES "SourceFragment"("projectId", "snapshotId", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "ClaimEvidence" ADD CONSTRAINT "ClaimEvidence_createdBy_fkey" FOREIGN KEY ("createdBy") REFERENCES "UserProfile"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "ClaimEvidence" ADD CONSTRAINT "ClaimEvidence_invalidatedBy_fkey" FOREIGN KEY ("invalidatedBy") REFERENCES "UserProfile"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "ClaimConflict" ADD CONSTRAINT "ClaimConflict_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "ClaimConflict" ADD CONSTRAINT "ClaimConflict_createdBy_fkey" FOREIGN KEY ("createdBy") REFERENCES "UserProfile"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "ClaimConflict" ADD CONSTRAINT "ClaimConflict_resolvedBy_fkey" FOREIGN KEY ("resolvedBy") REFERENCES "UserProfile"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "ClaimConflict" ADD CONSTRAINT "ClaimConflict_projectId_selectedRevisionId_fkey" FOREIGN KEY ("projectId", "selectedRevisionId") REFERENCES "ClaimRevision"("projectId", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "ClaimConflictParticipant" ADD CONSTRAINT "ClaimConflictParticipant_projectId_conflictId_fkey" FOREIGN KEY ("projectId", "conflictId") REFERENCES "ClaimConflict"("projectId", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "ClaimConflictParticipant" ADD CONSTRAINT "ClaimConflictParticipant_projectId_claimId_fkey" FOREIGN KEY ("projectId", "claimId") REFERENCES "Claim"("projectId", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "ClaimConflictParticipant" ADD CONSTRAINT "ClaimConflictParticipant_projectId_claimId_revisionId_fkey" FOREIGN KEY ("projectId", "claimId", "revisionId") REFERENCES "ClaimRevision"("projectId", "claimId", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "ConflictResolutionEvidence" ADD CONSTRAINT "ConflictResolutionEvidence_projectId_conflictId_claimRevis_fkey" FOREIGN KEY ("projectId", "conflictId", "claimRevisionId") REFERENCES "ClaimConflict"("projectId", "id", "selectedRevisionId") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "ConflictResolutionEvidence" ADD CONSTRAINT "ConflictResolutionEvidence_projectId_claimRevisionId_evide_fkey" FOREIGN KEY ("projectId", "claimRevisionId", "evidenceId") REFERENCES "ClaimEvidence"("projectId", "claimRevisionId", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "FactualBasisRevision" ADD CONSTRAINT "FactualBasisRevision_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "FactualBasisRevision" ADD CONSTRAINT "FactualBasisRevision_createdBy_fkey" FOREIGN KEY ("createdBy") REFERENCES "UserProfile"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "BasisClaim" ADD CONSTRAINT "BasisClaim_projectId_basisId_fkey" FOREIGN KEY ("projectId", "basisId") REFERENCES "FactualBasisRevision"("projectId", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "BasisClaim" ADD CONSTRAINT "BasisClaim_projectId_claimId_fkey" FOREIGN KEY ("projectId", "claimId") REFERENCES "Claim"("projectId", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "BasisClaim" ADD CONSTRAINT "BasisClaim_projectId_claimId_claimRevisionId_fkey" FOREIGN KEY ("projectId", "claimId", "claimRevisionId") REFERENCES "ClaimRevision"("projectId", "claimId", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "BasisClaimEvidence" ADD CONSTRAINT "BasisClaimEvidence_projectId_basisId_claimRevisionId_fkey" FOREIGN KEY ("projectId", "basisId", "claimRevisionId") REFERENCES "BasisClaim"("projectId", "basisId", "claimRevisionId") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "BasisClaimEvidence" ADD CONSTRAINT "BasisClaimEvidence_projectId_claimRevisionId_evidenceId_fkey" FOREIGN KEY ("projectId", "claimRevisionId", "evidenceId") REFERENCES "ClaimEvidence"("projectId", "claimRevisionId", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "AIExecution" ADD CONSTRAINT "AIExecution_projectId_jobId_fkey" FOREIGN KEY ("projectId", "jobId") REFERENCES "Job"("projectId", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "AIExecution" ADD CONSTRAINT "AIExecution_jobId_attemptId_fkey" FOREIGN KEY ("jobId", "attemptId") REFERENCES "JobAttempt"("jobId", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

ALTER TABLE "Claim" ADD CHECK ("revision" > 0);
ALTER TABLE "ClaimRevision" ADD CHECK ("number" > 0 AND length(btrim("wording")) BETWEEN 1 AND 2000),
  ADD CHECK ("sha256" = encode(sha256(convert_to("wording", 'UTF8')), 'hex')),
  ADD CHECK (("approvedBy" IS NULL) = ("approvedAt" IS NULL) AND ("rejectedBy" IS NULL) = ("rejectedAt" IS NULL)),
  ADD CHECK (("status" = 'APPROVED') = ("approvedAt" IS NOT NULL) AND ("status" = 'REJECTED') = ("rejectedAt" IS NOT NULL)),
  ADD CHECK (("withdrawnBy" IS NULL) = ("withdrawnAt" IS NULL) AND ("withdrawnAt" IS NULL OR "status" = 'APPROVED')),
  ADD CHECK ("withdrawalReason" IS NULL OR "withdrawnAt" IS NOT NULL),
  ADD CHECK (("jobId" IS NULL) = ("providerClaimKey" IS NULL));
ALTER TABLE "ClaimEvidence" ADD CHECK ("startOffset" >= 0 AND "endOffset" > "startOffset" AND "endOffset" <= 400000),
  ADD CHECK (length("quote") BETWEEN 1 AND 10000 AND "sha256" = encode(sha256(convert_to("quote", 'UTF8')), 'hex')),
  ADD CHECK ("capturedPurpose" = 'FACTUAL_SOURCE'),
  ADD CHECK (("invalidatedBy" IS NULL) = ("invalidatedAt" IS NULL) AND ("invalidationReason" IS NULL) = ("invalidatedAt" IS NULL));
ALTER TABLE "ClaimConflict" ADD CHECK ("revision" > 0 AND length(btrim("rationale")) BETWEEN 1 AND 2000),
  ADD CHECK (("resolvedBy" IS NULL) = ("resolvedAt" IS NULL) AND ("selectedRevisionId" IS NULL) = ("resolvedAt" IS NULL)
    AND ("formulation" IS NULL) = ("resolvedAt" IS NULL) AND ("resolutionRationale" IS NULL) = ("resolvedAt" IS NULL));
ALTER TABLE "FactualBasisRevision" ADD CHECK ("sequence" > 0 AND "sha256" ~ '^[a-f0-9]{64}$' AND jsonb_typeof("manifest") = 'object');
ALTER TABLE "AIExecution" ADD COLUMN "provider" VARCHAR(64) NOT NULL DEFAULT 'dify' CHECK (length(btrim("provider")) BETWEEN 1 AND 64),
  ADD CHECK ("configDigest" ~ '^[a-f0-9]{64}$' AND "inputHash" ~ '^[a-f0-9]{64}$'),
  ADD CHECK (("status" = 'RUNNING') = ("finishedAt" IS NULL)), ADD CHECK ("finishedAt" IS NULL OR "finishedAt" >= "startedAt");
CREATE FUNCTION guard_claim_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF ROW(NEW."id", NEW."projectId", NEW."createdBy", NEW."createdAt") IS DISTINCT FROM ROW(OLD."id", OLD."projectId", OLD."createdBy", OLD."createdAt")
    OR NEW."revision" < OLD."revision" OR NEW."updatedAt" < OLD."updatedAt" THEN
    RAISE EXCEPTION 'claim identity and counters are immutable' USING ERRCODE = '23514';
  END IF;
  IF NEW."currentRevisionId" IS DISTINCT FROM OLD."currentRevisionId" AND NOT (OLD."currentRevisionId" IS NULL AND OLD."revision" = 1 AND NEW."revision" = 1)
    AND NEW."revision" <> OLD."revision" + 1 THEN RAISE EXCEPTION 'claim edit must advance revision' USING ERRCODE = '23514'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "Claim_identity_guard" BEFORE UPDATE ON "Claim" FOR EACH ROW EXECUTE FUNCTION guard_claim_identity();
CREATE FUNCTION guard_claim_revision() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF ROW(NEW."id", NEW."projectId", NEW."claimId", NEW."number", NEW."wording", NEW."sha256", NEW."jobId", NEW."providerClaimKey", NEW."createdBy", NEW."createdAt")
    IS DISTINCT FROM ROW(OLD."id", OLD."projectId", OLD."claimId", OLD."number", OLD."wording", OLD."sha256", OLD."jobId", OLD."providerClaimKey", OLD."createdBy", OLD."createdAt") THEN
    RAISE EXCEPTION 'claim revision content is immutable' USING ERRCODE = '23514';
  END IF;
  IF OLD."status" <> 'PROPOSED' AND NEW."status" <> OLD."status" THEN RAISE EXCEPTION 'claim review is terminal' USING ERRCODE = '23514'; END IF;
  IF OLD."approvedAt" IS NOT NULL AND ROW(NEW."approvedBy", NEW."approvedAt") IS DISTINCT FROM ROW(OLD."approvedBy", OLD."approvedAt")
    OR OLD."rejectedAt" IS NOT NULL AND ROW(NEW."rejectedBy", NEW."rejectedAt") IS DISTINCT FROM ROW(OLD."rejectedBy", OLD."rejectedAt")
    OR OLD."withdrawnAt" IS NOT NULL AND ROW(NEW."withdrawnBy", NEW."withdrawnAt", NEW."withdrawalReason") IS DISTINCT FROM ROW(OLD."withdrawnBy", OLD."withdrawnAt", OLD."withdrawalReason") THEN
    RAISE EXCEPTION 'first review and withdrawal attribution is immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "ClaimRevision_review_guard" BEFORE UPDATE ON "ClaimRevision" FOR EACH ROW EXECUTE FUNCTION guard_claim_revision();
CREATE FUNCTION guard_claim_evidence() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (to_jsonb(NEW) - ARRAY['invalidatedBy','invalidatedAt','invalidationReason']) IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['invalidatedBy','invalidatedAt','invalidationReason'])
    OR OLD."invalidatedAt" IS NOT NULL AND NEW IS DISTINCT FROM OLD THEN RAISE EXCEPTION 'captured evidence and terminal invalidation are immutable' USING ERRCODE = '23514'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "ClaimEvidence_guard" BEFORE UPDATE ON "ClaimEvidence" FOR EACH ROW EXECUTE FUNCTION guard_claim_evidence();
CREATE FUNCTION guard_claim_conflict() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (to_jsonb(NEW) - ARRAY['revision','resolvedBy','resolvedAt','selectedRevisionId','formulation','resolutionRationale'])
    IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['revision','resolvedBy','resolvedAt','selectedRevisionId','formulation','resolutionRationale'])
    OR OLD."resolvedAt" IS NOT NULL AND NEW IS DISTINCT FROM OLD OR NEW."revision" <> OLD."revision" + 1 THEN
    RAISE EXCEPTION 'conflict identity and terminal resolution are immutable' USING ERRCODE = '23514'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "ClaimConflict_guard" BEFORE UPDATE ON "ClaimConflict" FOR EACH ROW EXECUTE FUNCTION guard_claim_conflict();
CREATE FUNCTION guard_ai_execution() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (to_jsonb(NEW) - ARRAY['providerRunId','model','status','finishedAt','errorCategory']) IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['providerRunId','model','status','finishedAt','errorCategory'])
    OR OLD."providerRunId" IS NOT NULL AND NEW."providerRunId" IS DISTINCT FROM OLD."providerRunId"
    OR OLD."model" IS NOT NULL AND NEW."model" IS DISTINCT FROM OLD."model"
    OR OLD."status" <> 'RUNNING' AND NEW IS DISTINCT FROM OLD THEN RAISE EXCEPTION 'AI execution frozen metadata is immutable' USING ERRCODE = '23514'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "AIExecution_guard" BEFORE UPDATE ON "AIExecution" FOR EACH ROW EXECUTE FUNCTION guard_ai_execution();
CREATE TRIGGER "FactualBasis_immutable" BEFORE UPDATE ON "FactualBasisRevision" FOR EACH ROW EXECUTE FUNCTION contextflow.guard_immutable_snapshot();
CREATE TRIGGER "BasisClaim_immutable" BEFORE UPDATE ON "BasisClaim" FOR EACH ROW EXECUTE FUNCTION contextflow.guard_immutable_snapshot();
CREATE TRIGGER "BasisEvidence_immutable" BEFORE UPDATE ON "BasisClaimEvidence" FOR EACH ROW EXECUTE FUNCTION contextflow.guard_immutable_snapshot();
CREATE TRIGGER "ConflictParticipant_immutable" BEFORE UPDATE ON "ClaimConflictParticipant" FOR EACH ROW EXECUTE FUNCTION contextflow.guard_immutable_snapshot();
CREATE TRIGGER "ConflictResolutionEvidence_immutable" BEFORE UPDATE ON "ConflictResolutionEvidence" FOR EACH ROW EXECUTE FUNCTION contextflow.guard_immutable_snapshot();
REVOKE ALL ON "Claim", "ClaimRevision", "ClaimEvidence", "ClaimConflict", "ClaimConflictParticipant", "ConflictResolutionEvidence", "FactualBasisRevision", "BasisClaim", "BasisClaimEvidence", "AIExecution" FROM PUBLIC;
REVOKE ALL ON TYPE "ClaimStatus", "EvidenceRelation", "ConflictOrigin", "AIExecutionStatus" FROM PUBLIC;
DO $$ DECLARE role_name TEXT; BEGIN
  FOREACH role_name IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF to_regrole(role_name) IS NOT NULL THEN
      EXECUTE format('REVOKE ALL ON contextflow."Claim", contextflow."ClaimRevision", contextflow."ClaimEvidence", contextflow."ClaimConflict", contextflow."ClaimConflictParticipant", contextflow."ConflictResolutionEvidence", contextflow."FactualBasisRevision", contextflow."BasisClaim", contextflow."BasisClaimEvidence", contextflow."AIExecution" FROM %I', role_name);
      EXECUTE format('REVOKE ALL ON TYPE contextflow."ClaimStatus", contextflow."EvidenceRelation", contextflow."ConflictOrigin", contextflow."AIExecutionStatus" FROM %I', role_name);
    END IF;
  END LOOP;
END $$;
GRANT USAGE ON TYPE "ClaimStatus", "EvidenceRelation", "ConflictOrigin", "AIExecutionStatus" TO cf_runtime;
GRANT SELECT, INSERT, UPDATE ON "Claim", "ClaimRevision", "ClaimEvidence", "ClaimConflict", "AIExecution" TO cf_runtime;
GRANT SELECT, INSERT ON "ClaimConflictParticipant", "ConflictResolutionEvidence", "FactualBasisRevision", "BasisClaim", "BasisClaimEvidence" TO cf_runtime;
COMMIT;
