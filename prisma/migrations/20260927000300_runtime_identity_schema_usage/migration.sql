-- Fresh databases may receive the application schema from migrations rather than
-- the initial role bootstrap. Runtime needs USAGE, never CREATE, in both cases.
GRANT USAGE ON SCHEMA contextflow TO cf_runtime;
