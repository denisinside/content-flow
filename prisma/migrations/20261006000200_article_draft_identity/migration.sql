BEGIN;
SET LOCAL search_path TO contextflow;
-- Mutable text may diverge from its short original linkage receipt. Preserve that
-- draft/checkpoint text and expose the invalid mapping instead of truncating it.
ALTER TABLE "ArticleVersionClaim" ALTER COLUMN "linkedText" TYPE TEXT;
ALTER TABLE "ArticleVersionClaim" DROP CONSTRAINT "ArticleVersionClaim_shape_check";
ALTER TABLE "ArticleVersionClaim" ADD CONSTRAINT "ArticleVersionClaim_shape_check" CHECK (
 length("locator") BETWEEN 1 AND 200 AND length("quote") BETWEEN 1 AND 10000 AND length("linkedText") BETWEEN 1 AND 500000);
CREATE FUNCTION guard_article_draft_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF ROW(NEW."articleId",NEW."projectId") IS DISTINCT FROM ROW(OLD."articleId",OLD."projectId") THEN
  RAISE EXCEPTION 'article draft identity is immutable' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER "ArticleDraft_identity_guard" BEFORE UPDATE ON "ArticleDraft" FOR EACH ROW EXECUTE FUNCTION guard_article_draft_identity();
COMMIT;
