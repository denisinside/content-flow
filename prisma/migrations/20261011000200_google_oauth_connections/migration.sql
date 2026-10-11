BEGIN;
SET LOCAL search_path TO contextflow, public;
CREATE UNIQUE INDEX "AppSession_id_userId_key" ON "AppSession"("id", "userId");
CREATE TABLE "GoogleOAuthAttempt" (
 "id" UUID PRIMARY KEY,
 "userId" UUID NOT NULL REFERENCES "UserProfile"("id") ON DELETE RESTRICT ON UPDATE NO ACTION,
 "appSessionId" UUID NOT NULL,
 "stateDigest" CHAR(64) NOT NULL UNIQUE CHECK ("stateDigest" ~ '^[a-f0-9]{64}$'),
 "encryptedVerifier" TEXT,
 "tokenKeyVersion" INTEGER NOT NULL CHECK ("tokenKeyVersion" > 0),
 "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 "expiresAt" TIMESTAMPTZ(3) NOT NULL,
 "consumedAt" TIMESTAMPTZ(3),
 FOREIGN KEY ("appSessionId", "userId") REFERENCES "AppSession"("id", "userId") ON DELETE RESTRICT ON UPDATE NO ACTION,
 CHECK ("expiresAt" > "createdAt" AND "expiresAt" <= "createdAt" + INTERVAL '10 minutes'),
 CHECK (("consumedAt" IS NULL AND "encryptedVerifier" IS NOT NULL AND length("encryptedVerifier") BETWEEN 40 AND 32768)
 OR ("consumedAt" IS NOT NULL AND "encryptedVerifier" IS NULL AND "consumedAt" >= "createdAt"))
);
CREATE INDEX "GoogleOAuthAttempt_appSessionId_expiresAt_idx" ON "GoogleOAuthAttempt"("appSessionId", "expiresAt");
CREATE TABLE "GoogleDriveConnection" (
 "id" UUID PRIMARY KEY,
 "userId" UUID NOT NULL REFERENCES "UserProfile"("id") ON DELETE RESTRICT ON UPDATE NO ACTION,
 "googlePermissionId" VARCHAR(128) NOT NULL CHECK (length("googlePermissionId") > 0),
 "displayName" VARCHAR(200),
 "encryptedTokens" TEXT,
 "tokenKeyVersion" INTEGER NOT NULL CHECK ("tokenKeyVersion" > 0),
 "grantedScope" VARCHAR(128) NOT NULL CHECK ("grantedScope" = 'https://www.googleapis.com/auth/drive.file'),
 "accessExpiresAt" TIMESTAMPTZ(3) NOT NULL,
 "refreshExpiresAt" TIMESTAMPTZ(3),
 "generation" INTEGER NOT NULL DEFAULT 1 CHECK ("generation" > 0),
 "connectedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 "revokedAt" TIMESTAMPTZ(3),
 CHECK (("revokedAt" IS NULL AND "encryptedTokens" IS NOT NULL AND length("encryptedTokens") BETWEEN 40 AND 32768)
 OR ("revokedAt" IS NOT NULL AND "encryptedTokens" IS NULL)),
 CHECK ("updatedAt" >= "connectedAt"),
 UNIQUE ("userId", "googlePermissionId"),
 UNIQUE ("id", "userId")
);
CREATE FUNCTION guard_google_oauth_attempt_update() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF NEW."id" IS DISTINCT FROM OLD."id" OR NEW."userId" IS DISTINCT FROM OLD."userId"
 OR NEW."appSessionId" IS DISTINCT FROM OLD."appSessionId" OR NEW."stateDigest" IS DISTINCT FROM OLD."stateDigest"
 OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt" OR NEW."expiresAt" IS DISTINCT FROM OLD."expiresAt"
 OR NEW."tokenKeyVersion" IS DISTINCT FROM OLD."tokenKeyVersion" OR OLD."consumedAt" IS NOT NULL
 OR NEW."consumedAt" IS NULL OR NEW."encryptedVerifier" IS NOT NULL THEN
 RAISE EXCEPTION 'OAuth attempt may only be consumed once' USING ERRCODE = '23514'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER "GoogleOAuthAttempt_update_guard" BEFORE UPDATE ON "GoogleOAuthAttempt" FOR EACH ROW EXECUTE FUNCTION guard_google_oauth_attempt_update();
CREATE FUNCTION guard_google_connection_update() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF NEW."id" IS DISTINCT FROM OLD."id" OR NEW."userId" IS DISTINCT FROM OLD."userId"
 OR NEW."googlePermissionId" IS DISTINCT FROM OLD."googlePermissionId" OR NEW."connectedAt" IS DISTINCT FROM OLD."connectedAt"
 OR NEW."grantedScope" IS DISTINCT FROM OLD."grantedScope" OR NEW."generation" <> OLD."generation" + 1 THEN
 RAISE EXCEPTION 'Google connection identity is immutable; updates require next generation' USING ERRCODE = '23514'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER "GoogleDriveConnection_update_guard" BEFORE UPDATE ON "GoogleDriveConnection" FOR EACH ROW EXECUTE FUNCTION guard_google_connection_update();
REVOKE ALL ON "GoogleOAuthAttempt", "GoogleDriveConnection" FROM PUBLIC;
REVOKE ALL ON FUNCTION guard_google_oauth_attempt_update(), guard_google_connection_update() FROM PUBLIC;
DO $$ DECLARE role_name TEXT; BEGIN
 FOREACH role_name IN ARRAY ARRAY['anon','authenticated'] LOOP
  IF to_regrole(role_name) IS NOT NULL THEN
   EXECUTE format('REVOKE ALL ON contextflow."GoogleOAuthAttempt",contextflow."GoogleDriveConnection" FROM %I', role_name);
  END IF;
 END LOOP;
END $$;
GRANT SELECT,INSERT,UPDATE ON "GoogleOAuthAttempt", "GoogleDriveConnection" TO cf_runtime;
COMMIT;
