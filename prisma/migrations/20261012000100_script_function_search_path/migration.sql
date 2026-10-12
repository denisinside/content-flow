-- Runtime sessions intentionally do not put the application schema on their search path.
-- Keep nested UTF-16 helper resolution independent of a caller's session settings.
ALTER FUNCTION contextflow.script_content_valid(jsonb) SET search_path = pg_catalog, contextflow;
