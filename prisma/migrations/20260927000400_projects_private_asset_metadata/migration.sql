CREATE TYPE contextflow."ProjectFormat" AS ENUM ('LINKEDIN_TEXT','LINKEDIN_COVER','LINKEDIN_CAROUSEL','INSTAGRAM_COVER','INSTAGRAM_CAROUSEL','INSTAGRAM_STORIES','TELEGRAM_POST');
CREATE TYPE contextflow."AssetState" AS ENUM ('STAGED','AVAILABLE','QUARANTINED');
CREATE TYPE contextflow."AssetPurpose" AS ENUM ('ORIGINAL','NORMALIZED','GENERATED','EXPORT');
CREATE TABLE contextflow."Project" (
  "id" UUID PRIMARY KEY,
  "topic" VARCHAR(500) NOT NULL CHECK (length(btrim("topic")) > 0 AND "topic" = btrim("topic")),
  "formats" contextflow."ProjectFormat"[] NOT NULL,
  "revision" INTEGER NOT NULL DEFAULT 1 CHECK ("revision" > 0),
  "createdBy" UUID NOT NULL REFERENCES contextflow."UserProfile"("id") ON DELETE RESTRICT,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "archivedAt" TIMESTAMPTZ(3),
  CHECK (cardinality("formats") BETWEEN 1 AND 7 AND array_position("formats", NULL) IS NULL
    AND cardinality("formats") = (('LINKEDIN_TEXT'::contextflow."ProjectFormat" = ANY("formats"))::int
      + ('LINKEDIN_COVER'::contextflow."ProjectFormat" = ANY("formats"))::int
      + ('LINKEDIN_CAROUSEL'::contextflow."ProjectFormat" = ANY("formats"))::int
      + ('INSTAGRAM_COVER'::contextflow."ProjectFormat" = ANY("formats"))::int
      + ('INSTAGRAM_CAROUSEL'::contextflow."ProjectFormat" = ANY("formats"))::int
      + ('INSTAGRAM_STORIES'::contextflow."ProjectFormat" = ANY("formats"))::int
      + ('TELEGRAM_POST'::contextflow."ProjectFormat" = ANY("formats"))::int))
);
CREATE TABLE contextflow."ProjectMember" (
  "projectId" UUID NOT NULL REFERENCES contextflow."Project"("id") ON DELETE RESTRICT,
  "userId" UUID NOT NULL REFERENCES contextflow."UserProfile"("id") ON DELETE RESTRICT,
  "joinedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "leftAt" TIMESTAMPTZ(3),
  PRIMARY KEY ("projectId", "userId"),
  CHECK ("leftAt" IS NULL OR "leftAt" >= "joinedAt")
);
CREATE TABLE contextflow."Asset" (
  "id" UUID PRIMARY KEY,
  "projectId" UUID NOT NULL REFERENCES contextflow."Project"("id") ON DELETE RESTRICT,
  "bucket" VARCHAR(63) NOT NULL CHECK ("bucket" ~ '^[a-z0-9][a-z0-9_-]{0,62}$'),
  "objectKey" VARCHAR(1024) NOT NULL CHECK (left("objectKey", 37) = "projectId"::text || '/'
    AND length("objectKey") > 37 AND "objectKey" !~ '(^|/)\.{1,2}(/|$)' AND strpos("objectKey", chr(92)) = 0),
  "mediaType" VARCHAR(255) NOT NULL CHECK ("mediaType" ~ '^[a-zA-Z0-9!#$&^_.+-]+/[a-zA-Z0-9!#$&^_.+-]+$'),
  "bytes" BIGINT NOT NULL CHECK ("bytes" BETWEEN 0 AND 9007199254740991),
  "sha256" CHAR(64) NOT NULL CHECK ("sha256" ~ '^[a-f0-9]{64}$'),
  "state" contextflow."AssetState" NOT NULL DEFAULT 'STAGED',
  "purpose" contextflow."AssetPurpose" NOT NULL,
  "createdBy" UUID NOT NULL,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE ("projectId", "id"),
  UNIQUE ("bucket", "objectKey"),
  FOREIGN KEY ("projectId", "createdBy") REFERENCES contextflow."ProjectMember"("projectId", "userId") ON DELETE RESTRICT
);
CREATE INDEX "Project_createdBy_idx" ON contextflow."Project"("createdBy");
CREATE INDEX "Project_createdAt_id_idx" ON contextflow."Project"("createdAt" DESC, "id" DESC);
CREATE INDEX "ProjectMember_userId_leftAt_projectId_idx" ON contextflow."ProjectMember"("userId", "leftAt", "projectId");
CREATE INDEX "Asset_projectId_state_createdAt_idx" ON contextflow."Asset"("projectId", "state", "createdAt");
CREATE INDEX "Asset_projectId_createdBy_idx" ON contextflow."Asset"("projectId", "createdBy");
REVOKE ALL ON contextflow."Project", contextflow."ProjectMember", contextflow."Asset" FROM PUBLIC;
DO $$
DECLARE provider_role TEXT;
BEGIN
  FOREACH provider_role IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF to_regrole(provider_role) IS NOT NULL THEN
      EXECUTE format('REVOKE ALL ON contextflow."Project", contextflow."ProjectMember", contextflow."Asset" FROM %I', provider_role);
    END IF;
  END LOOP;
END $$;
GRANT SELECT, INSERT, UPDATE, DELETE ON contextflow."Project", contextflow."ProjectMember", contextflow."Asset" TO cf_runtime;
