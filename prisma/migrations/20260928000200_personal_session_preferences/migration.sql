BEGIN;

ALTER TABLE contextflow."UserProfile"
  ADD COLUMN "idleTimeoutMinutes" INTEGER NOT NULL DEFAULT 1440
  CONSTRAINT "UserProfile_idleTimeoutMinutes_check" CHECK ("idleTimeoutMinutes" BETWEEN 1 AND 10080);

-- Apply the former 60-minute idle and stored absolute deadlines before any
-- extension. A row already expired under the previous policy must not revive.
UPDATE contextflow."AppSession"
SET "revokedAt" = CURRENT_TIMESTAMP, "encryptedProviderTokens" = NULL
WHERE "revokedAt" IS NULL
  AND ("expiresAt" <= CURRENT_TIMESTAMP
    OR "lastUserActivityAt" <= CURRENT_TIMESTAMP - INTERVAL '60 minutes');

-- Surviving sessions receive the new absolute deadline from their original
-- sign-in, never from this migration or later activity.
UPDATE contextflow."AppSession"
SET "expiresAt" = "createdAt" + INTERVAL '7 days'
WHERE "revokedAt" IS NULL;

COMMIT;
