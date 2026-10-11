BEGIN;
SET LOCAL search_path TO contextflow, public;

ALTER TABLE "GoogleDocBinding"
  DROP CONSTRAINT "GoogleDocBinding_document_id_check",
  ALTER COLUMN "documentId" TYPE VARCHAR(1024),
  ADD CONSTRAINT "GoogleDocBinding_document_id_check"
    CHECK (length(btrim("documentId")) BETWEEN 1 AND 1024 AND octet_length("documentId") <= 1024);

ALTER TABLE "GoogleDocCreateCommand"
  DROP CONSTRAINT "GoogleDocCreateCommand_document_id_check",
  ALTER COLUMN "documentId" TYPE VARCHAR(1024),
  ADD CONSTRAINT "GoogleDocCreateCommand_document_id_check"
    CHECK ("documentId" IS NULL OR (length(btrim("documentId")) BETWEEN 1 AND 1024 AND octet_length("documentId") <= 1024));

COMMIT;
