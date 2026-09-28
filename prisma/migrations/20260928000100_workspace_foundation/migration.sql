-- Expand first. Each existing Project receives its own Workspace, preserving the
-- precise former active membership set even when projects have overlapping users.
CREATE TABLE contextflow."Workspace" (
  "id" UUID PRIMARY KEY,
  "name" VARCHAR(120) NOT NULL CHECK (length(btrim("name")) > 0 AND "name" = btrim("name")),
  "ownerId" UUID NOT NULL REFERENCES contextflow."UserProfile"("id") ON DELETE RESTRICT,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "archivedAt" TIMESTAMPTZ(3),
  "styleRevision" INTEGER NOT NULL DEFAULT 1 CHECK ("styleRevision" > 0)
);
CREATE TABLE contextflow."WorkspaceMember" (
  "workspaceId" UUID NOT NULL REFERENCES contextflow."Workspace"("id") ON DELETE RESTRICT,
  "userId" UUID NOT NULL REFERENCES contextflow."UserProfile"("id") ON DELETE RESTRICT,
  "joinedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "leftAt" TIMESTAMPTZ(3),
  PRIMARY KEY ("workspaceId", "userId"),
  CHECK ("leftAt" IS NULL OR "leftAt" >= "joinedAt")
);
CREATE TABLE contextflow."WorkspaceInvite" (
  "id" UUID PRIMARY KEY,
  "workspaceId" UUID NOT NULL REFERENCES contextflow."Workspace"("id") ON DELETE RESTRICT,
  "email" VARCHAR(254) NOT NULL CHECK ("email" = lower(btrim("email"))),
  "tokenDigest" CHAR(64) NOT NULL UNIQUE CHECK ("tokenDigest" ~ '^[a-f0-9]{64}$'),
  "invitedBy" UUID NOT NULL REFERENCES contextflow."UserProfile"("id") ON DELETE RESTRICT,
  "acceptedBy" UUID REFERENCES contextflow."UserProfile"("id") ON DELETE RESTRICT,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "expiresAt" TIMESTAMPTZ(3) NOT NULL,
  "acceptedAt" TIMESTAMPTZ(3),
  CHECK ("expiresAt" > "createdAt"),
  CHECK (("acceptedAt" IS NULL) = ("acceptedBy" IS NULL))
);
CREATE TABLE contextflow."WorkspaceStyleRevision" (
  "workspaceId" UUID NOT NULL REFERENCES contextflow."Workspace"("id") ON DELETE RESTRICT,
  "revision" INTEGER NOT NULL CHECK ("revision" > 0),
  "brandbook" TEXT NOT NULL DEFAULT '',
  "tone" TEXT NOT NULL DEFAULT '',
  "settings" JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof("settings") = 'object'),
  "createdBy" UUID NOT NULL REFERENCES contextflow."UserProfile"("id") ON DELETE RESTRICT,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY ("workspaceId", "revision")
);

ALTER TABLE contextflow."Project" ADD COLUMN "workspaceId" UUID;
UPDATE contextflow."Project" SET "workspaceId" = gen_random_uuid();
INSERT INTO contextflow."Workspace" ("id", "name", "ownerId", "createdAt", "updatedAt", "archivedAt")
SELECT p."workspaceId", left('Проєкт: ' || p."topic", 120),
  COALESCE((SELECT pm."userId" FROM contextflow."ProjectMember" pm
    WHERE pm."projectId" = p."id" AND pm."leftAt" IS NULL
    ORDER BY (pm."userId" = p."createdBy") DESC, pm."joinedAt", pm."userId" LIMIT 1), p."createdBy"),
  p."createdAt", p."updatedAt",
  CASE WHEN EXISTS (SELECT 1 FROM contextflow."ProjectMember" pm WHERE pm."projectId" = p."id" AND pm."leftAt" IS NULL)
    THEN NULL ELSE CURRENT_TIMESTAMP END
FROM contextflow."Project" p;
INSERT INTO contextflow."WorkspaceMember" ("workspaceId", "userId", "joinedAt", "leftAt")
SELECT p."workspaceId", pm."userId", pm."joinedAt", pm."leftAt"
FROM contextflow."ProjectMember" pm JOIN contextflow."Project" p ON p."id" = pm."projectId";
INSERT INTO contextflow."WorkspaceStyleRevision" ("workspaceId", "revision", "createdBy", "createdAt")
SELECT "id", 1, "ownerId", "createdAt" FROM contextflow."Workspace";
ALTER TABLE contextflow."Project" ALTER COLUMN "workspaceId" SET NOT NULL;
ALTER TABLE contextflow."Project" ADD CONSTRAINT "Project_workspaceId_fkey" FOREIGN KEY ("workspaceId")
  REFERENCES contextflow."Workspace"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- Asset authorship remains a user attribution. ProjectMember is retained only as
-- historical membership evidence and cannot constrain future Workspace members.
ALTER TABLE contextflow."Asset" DROP CONSTRAINT "Asset_projectId_createdBy_fkey";
ALTER TABLE contextflow."Asset" ADD CONSTRAINT "Asset_createdBy_fkey" FOREIGN KEY ("createdBy")
  REFERENCES contextflow."UserProfile"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

CREATE INDEX "Workspace_ownerId_idx" ON contextflow."Workspace"("ownerId");
CREATE INDEX "WorkspaceMember_userId_leftAt_workspaceId_idx" ON contextflow."WorkspaceMember"("userId", "leftAt", "workspaceId");
CREATE INDEX "WorkspaceInvite_workspaceId_email_expiresAt_idx" ON contextflow."WorkspaceInvite"("workspaceId", "email", "expiresAt");
CREATE INDEX "Project_workspaceId_createdAt_id_idx" ON contextflow."Project"("workspaceId", "createdAt" DESC, "id" DESC);
REVOKE ALL ON contextflow."Workspace", contextflow."WorkspaceMember", contextflow."WorkspaceInvite", contextflow."WorkspaceStyleRevision" FROM PUBLIC;
DO $$
DECLARE provider_role TEXT;
BEGIN
  FOREACH provider_role IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF to_regrole(provider_role) IS NOT NULL THEN
      EXECUTE format('REVOKE ALL ON contextflow."Workspace", contextflow."WorkspaceMember", contextflow."WorkspaceInvite", contextflow."WorkspaceStyleRevision" FROM %I', provider_role);
    END IF;
  END LOOP;
END $$;
GRANT SELECT, INSERT, UPDATE, DELETE ON contextflow."Workspace", contextflow."WorkspaceMember", contextflow."WorkspaceInvite", contextflow."WorkspaceStyleRevision" TO cf_runtime;
