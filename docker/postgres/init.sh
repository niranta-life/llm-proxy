#!/bin/bash
# Creates the three login roles and the NOLOGIN owner. Keep attributes aligned
# with src/db/bootstrap-roles.ts, which tests apply on a fresh cluster.
set -euo pipefail

: "${MIGRATOR_PASSWORD:?MIGRATOR_PASSWORD is required}"
: "${AUTH_PASSWORD:?AUTH_PASSWORD is required}"
: "${RUNTIME_PASSWORD:?RUNTIME_PASSWORD is required}"
: "${POSTGRES_USER:?POSTGRES_USER is required}"
: "${POSTGRES_DB:?POSTGRES_DB is required}"

for value in "$MIGRATOR_PASSWORD" "$AUTH_PASSWORD" "$RUNTIME_PASSWORD"; do
  if [[ "$value" == *$'\n'* ]]; then
    echo "role passwords must be a single line" >&2
    exit 1
  fi
done

psql -v ON_ERROR_STOP=1 \
  --username "$POSTGRES_USER" \
  --dbname "$POSTGRES_DB" \
  -v migrator_password="$MIGRATOR_PASSWORD" \
  -v auth_password="$AUTH_PASSWORD" \
  -v runtime_password="$RUNTIME_PASSWORD" \
  -v dbname="$POSTGRES_DB" <<'SQL'
CREATE ROLE llm_owner NOLOGIN BYPASSRLS NOSUPERUSER NOCREATEDB NOCREATEROLE;
CREATE ROLE llm_migrator LOGIN PASSWORD :'migrator_password' NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS NOINHERIT;
CREATE ROLE llm_auth LOGIN PASSWORD :'auth_password' NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS NOINHERIT;
CREATE ROLE llm_runtime LOGIN PASSWORD :'runtime_password' NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS NOINHERIT;

GRANT llm_owner TO llm_migrator;
GRANT CONNECT ON DATABASE :"dbname" TO llm_migrator, llm_auth, llm_runtime;
GRANT USAGE, CREATE ON SCHEMA public TO llm_migrator;
GRANT USAGE, CREATE ON SCHEMA public TO llm_owner;
GRANT USAGE ON SCHEMA public TO llm_auth, llm_runtime;
SQL
