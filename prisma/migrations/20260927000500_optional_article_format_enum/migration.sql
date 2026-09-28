-- Commit the enum addition before the next migration uses the new value.
ALTER TYPE contextflow."ProjectFormat" ADD VALUE 'ARTICLE';
