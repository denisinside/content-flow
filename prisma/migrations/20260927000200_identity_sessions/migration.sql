CREATE TABLE contextflow."UserProfile" (
  "id" UUID PRIMARY KEY,
  "displayName" VARCHAR(80),
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE contextflow."AppSession" (
  "id" UUID PRIMARY KEY,
  "cookieDigest" CHAR(64) NOT NULL UNIQUE CHECK ("cookieDigest" ~ '^[a-f0-9]{64}$'),
  "userId" UUID NOT NULL REFERENCES contextflow."UserProfile"("id") ON DELETE RESTRICT,
  "encryptedProviderTokens" TEXT,
  "tokenKeyVersion" INTEGER NOT NULL CHECK ("tokenKeyVersion" > 0),
  "providerSessionId" UUID,
  "providerTokenExpiresAt" TIMESTAMPTZ(3) NOT NULL,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lastUserActivityAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "expiresAt" TIMESTAMPTZ(3) NOT NULL,
  "revokedAt" TIMESTAMPTZ(3),
  CHECK ("expiresAt" > "createdAt"),
  CHECK (("revokedAt" IS NULL AND "encryptedProviderTokens" IS NOT NULL)
    OR ("revokedAt" IS NOT NULL AND "encryptedProviderTokens" IS NULL))
);
CREATE INDEX "AppSession_userId_idx" ON contextflow."AppSession"("userId");
CREATE INDEX "AppSession_expiresAt_idx" ON contextflow."AppSession"("expiresAt");
GRANT SELECT, INSERT, UPDATE, DELETE ON contextflow."UserProfile", contextflow."AppSession" TO cf_runtime;
