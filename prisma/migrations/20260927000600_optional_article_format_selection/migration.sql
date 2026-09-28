-- Preserve every existing selection; Article is never inserted implicitly.
BEGIN;
ALTER TABLE contextflow."Project" DROP CONSTRAINT "Project_formats_check";
ALTER TABLE contextflow."Project" ADD CONSTRAINT "Project_formats_check"
  CHECK (cardinality("formats") BETWEEN 1 AND 8 AND array_position("formats", NULL) IS NULL
    AND cardinality("formats") = (('ARTICLE'::contextflow."ProjectFormat" = ANY("formats"))::int
      + ('LINKEDIN_TEXT'::contextflow."ProjectFormat" = ANY("formats"))::int
      + ('LINKEDIN_COVER'::contextflow."ProjectFormat" = ANY("formats"))::int
      + ('LINKEDIN_CAROUSEL'::contextflow."ProjectFormat" = ANY("formats"))::int
      + ('INSTAGRAM_COVER'::contextflow."ProjectFormat" = ANY("formats"))::int
      + ('INSTAGRAM_CAROUSEL'::contextflow."ProjectFormat" = ANY("formats"))::int
      + ('INSTAGRAM_STORIES'::contextflow."ProjectFormat" = ANY("formats"))::int
      + ('TELEGRAM_POST'::contextflow."ProjectFormat" = ANY("formats"))::int));
COMMIT;
