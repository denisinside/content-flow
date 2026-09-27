-- Runtime has no domain tables to access in M1.1.
-- Domain migrations must grant their own explicit runtime DML permissions later.
REVOKE ALL ON TABLE "contextflow"."_prisma_migrations" FROM cf_runtime;
ALTER DEFAULT PRIVILEGES IN SCHEMA "contextflow" REVOKE ALL ON TABLES FROM cf_runtime;
ALTER DEFAULT PRIVILEGES IN SCHEMA "contextflow" REVOKE ALL ON SEQUENCES FROM cf_runtime;
