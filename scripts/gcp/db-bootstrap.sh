#!/usr/bin/env bash
# Create the four llm_* database roles on the CloudNativePG primary, then verify them.
# Safe to repeat: 4 roles present -> verify only; 0 -> create all four in one
# transaction (all or nothing); 1 to 3 -> stop with numbered cleanup steps.
#
# The SQL mirrors docker/postgres/init.sh (used by docker compose). Keep the two aligned
# with src/db/bootstrap-roles.ts. It is not run through init.sh because that script
# takes the passwords from environment variables, and this one keeps them off every
# command line: the SQL, passwords included, goes to psql over stdin.
#
# Different from database.sh: database.sh creates the Postgres cluster and then calls
# this script; this script only creates and checks roles.
source "$(dirname "$0")/common.sh"
help_if_asked "$@"
require_settings

log "Step: database roles"
will "count the llm_* roles on the primary; create them in one transaction only when none exist"
will "verify attributes, role membership and privileges; passwords go over stdin, never on a command line"
stop_if_dry

use_cluster
# Read every password first; a failure here changes nothing.
MIGRATOR_PW="$(read_secret llm-migrator-password)" || die "cannot read the migrator password"
AUTH_PW="$(read_secret llm-auth-password)" || die "cannot read the auth password"
RUNTIME_PW="$(read_secret llm-runtime-password)" || die "cannot read the runtime password"
# The SQL below embeds these inside single quotes, so only plain letters and digits are allowed.
for pw in "$MIGRATOR_PW" "$AUTH_PW" "$RUNTIME_PW"; do
  [[ "$pw" =~ ^[A-Za-z0-9]+$ ]] || die "a role password has characters other than letters and digits; secrets.sh generates hex, so this one was replaced by hand"
done

PRIMARY="$(kubectl -n "$NAMESPACE" get cluster.postgresql.cnpg.io llm-pg \
  -o jsonpath='{.status.currentPrimary}')" || die "cannot read the Postgres cluster status"
[ -n "$PRIMARY" ] || die "cluster llm-pg has no primary yet"

# Read-only query from an argument (no secrets in it).
psql_query() {
  kubectl -n "$NAMESPACE" exec "$PRIMARY" -c postgres -- \
    psql -U postgres -d llm_proxy -v ON_ERROR_STOP=1 -Atc "$1" </dev/null
}

# Role-creating SQL on stdin. log_min_error_statement=panic keeps a failed CREATE ROLE
# statement (which contains a password) out of the Postgres server log.
create_roles() {
  {
    printf "SET log_min_error_statement = 'panic';\n"
    printf 'CREATE ROLE llm_owner NOLOGIN BYPASSRLS NOSUPERUSER NOCREATEDB NOCREATEROLE;\n'
    printf "CREATE ROLE llm_migrator LOGIN PASSWORD '%s' NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS NOINHERIT;\n" "$MIGRATOR_PW"
    printf "CREATE ROLE llm_auth LOGIN PASSWORD '%s' NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS NOINHERIT;\n" "$AUTH_PW"
    printf "CREATE ROLE llm_runtime LOGIN PASSWORD '%s' NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS NOINHERIT;\n" "$RUNTIME_PW"
    printf 'GRANT llm_owner TO llm_migrator;\n'
    printf 'GRANT CONNECT ON DATABASE llm_proxy TO llm_migrator, llm_auth, llm_runtime;\n'
    printf 'GRANT USAGE, CREATE ON SCHEMA public TO llm_migrator, llm_owner;\n'
    printf 'GRANT USAGE ON SCHEMA public TO llm_auth, llm_runtime;\n'
  } | kubectl -n "$NAMESPACE" exec -i "$PRIMARY" -c postgres -- \
    psql -U postgres -d llm_proxy -v ON_ERROR_STOP=1 --single-transaction -q -f - >/dev/null
}

# One row per failed check; no rows means everything is as init.sh would have left it.
VERIFY_SQL="$(cat "${GCP_SCRIPTS_DIR}/db-verify.sql")"

COUNT="$(psql_query "select count(*) from pg_roles where rolname in ('llm_owner','llm_migrator','llm_auth','llm_runtime')")" \
  || die "cannot count the llm_* roles on ${PRIMARY}"
case "$COUNT" in
  4) log "all four llm_* roles exist; verifying only" ;;
  0)
    log "creating the llm_* roles on ${PRIMARY} (one transaction)"
    create_roles || die "creating the roles failed; nothing was created (single transaction). Re-run this script."
    ;;
  *)
    die "PARTIAL role setup: ${COUNT} of 4 llm_* roles exist (an earlier run stopped midway). Fix it by hand:
  1. Open a database shell:  kubectl -n ${NAMESPACE} exec -it ${PRIMARY} -c postgres -- psql -U postgres -d llm_proxy
  2. Count objects owned by these roles (only safe to continue if the app never started):
       select count(*) from pg_class c join pg_roles r on r.oid = c.relowner where r.rolname like 'llm\\_%';
     If any count is not 0, stop and have someone review those objects first.
  3. Drop the roles:  DROP ROLE IF EXISTS llm_migrator, llm_auth, llm_runtime, llm_owner;
  4. Then re-run scripts/gcp/db-bootstrap.sh"
    ;;
esac

failed="$(psql_query "$VERIFY_SQL")" || die "cannot verify the roles on ${PRIMARY}"
if [ -n "$failed" ]; then
  printf 'FAILED CHECK: %s\n' "$failed" >&2
  if printf '%s\n' "$failed" | grep -q BYPASSRLS; then
    flags="$(psql_query "select rolname || ' bypassrls=' || rolbypassrls from pg_roles where rolname like 'llm\\_%' order by 1")" || flags="(could not list)"
    printf '%s\n' "$flags" >&2
    die "an app role has BYPASSRLS (must be off) or llm_owner lacks it. Find it in the flags printed above, then run: ALTER ROLE <name> NOBYPASSRLS;"
  fi
  die "role setup does not match docker/postgres/init.sh (checks above). Fix the roles, then re-run scripts/gcp/db-bootstrap.sh"
fi
ok "roles, memberships and privileges match docker/postgres/init.sh"
