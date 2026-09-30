BEGIN;
ALTER TABLE contextflow."ClaimConflict" ADD COLUMN "supersedesId" UUID,
  ADD CONSTRAINT "ClaimConflict_supersedes_check" CHECK ("supersedesId" IS NULL OR "supersedesId" <> "id"),
  ADD CONSTRAINT "ClaimConflict_projectId_supersedesId_fkey" FOREIGN KEY ("projectId", "supersedesId")
    REFERENCES contextflow."ClaimConflict"("projectId", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;
CREATE UNIQUE INDEX "ClaimConflict_projectId_supersedesId_key" ON contextflow."ClaimConflict" ("projectId", "supersedesId");
-- Existing conflict guard includes supersedesId in immutable identity automatically.
COMMIT;
