#!/bin/sh
set -eu
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" \
  --set=db_name="$POSTGRES_DB" \
  --set=migration_password="$APP_MIGRATION_PASSWORD" \
  --set=runtime_password="$APP_RUNTIME_PASSWORD" <<'SQL'
CREATE ROLE cf_migrate WITH LOGIN PASSWORD :'migration_password' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
CREATE ROLE cf_runtime WITH LOGIN PASSWORD :'runtime_password' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
GRANT CONNECT, CREATE ON DATABASE :"db_name" TO cf_migrate;
GRANT CONNECT ON DATABASE :"db_name" TO cf_runtime;
CREATE SCHEMA contextflow AUTHORIZATION cf_migrate;
GRANT USAGE ON SCHEMA contextflow TO cf_runtime;
-- Domain migrations explicitly grant required runtime DML; metadata stays private.
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
SQL
