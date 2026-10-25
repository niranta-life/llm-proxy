#!/usr/bin/env bash
# Step 5: CloudNativePG cluster + backup schedule, then create the four database roles.
# Safe to repeat. Role creation itself lives in db-bootstrap.sh, which only handles roles.
#
# Usage: scripts/gcp/database.sh                       create (or re-apply) the database
#        scripts/gcp/database.sh --restore [--from SERVER] [--time "YYYY-MM-DD HH:MM:SS+00"]
#                                                      create it FROM the backups bucket
#
# A fresh database is only created when the backups bucket is empty. If the bucket already
# holds backups (you ran down.sh and are coming back), the script refuses and tells you to
# use --restore: a brand-new database writing into a bucket that holds another database's
# WAL would corrupt the archive you need to recover from.
#
# --restore recovers to the end of the archived WAL, or to --time (UTC, point in time).
# --from is the server name inside the bucket (default llm-pg; see `gcloud storage ls
# gs://<project>-llm-pg-backup/`). The restored cluster archives under a NEW server name
# (llm-pg-r<timestamp>), because the old one must not be written to. Run backup-now.sh right
# after, so the new archive has a base backup. It only creates: if cluster llm-pg exists,
# --restore refuses.
source "$(dirname "$0")/common.sh"
help_if_asked "$@"
require_settings

RESTORE=0
FROM_SERVER="llm-pg"
RESTORE_TIME=""
while [ $# -gt 0 ]; do
  case "$1" in
    --restore) RESTORE=1 ;;
    --from)
      [ $# -ge 2 ] || die "--from needs a server name"
      FROM_SERVER="$2"
      shift
      ;;
    --time)
      [ $# -ge 2 ] || die "--time needs a value like '2026-10-22 14:30:00+00'"
      RESTORE_TIME="$2"
      shift
      ;;
    *) die "unknown option: $1 (see --help)" ;;
  esac
  shift
done
if [ "$RESTORE" = 0 ] && { [ "$FROM_SERVER" != "llm-pg" ] || [ -n "$RESTORE_TIME" ]; }; then
  die "--from and --time only make sense with --restore"
fi
[[ "$FROM_SERVER" =~ ^[A-Za-z0-9._-]+$ ]] || die "--from '${FROM_SERVER}' is not a plain server name"
[ -z "$RESTORE_TIME" ] || valid_pitr_time "$RESTORE_TIME" || die "--time needs a value like '2026-10-22 14:30:00+00' (UTC)"

log "Step: database"
if [ "$RESTORE" = 1 ]; then
  will "check cluster llm-pg does not exist and gs://${BACKUP_BUCKET}/${FROM_SERVER}/base/ holds a base backup (read-only)"
  will "ask, then create cluster llm-pg by RECOVERY from gs://${BACKUP_BUCKET}/ server ${FROM_SERVER}${RESTORE_TIME:+ up to ${RESTORE_TIME}}"
  will "archive the restored cluster under a new server name; wait for Ready (10 to 30 minutes)"
else
  will "refuse if the backups bucket gs://${BACKUP_BUCKET}/ already holds backups and cluster llm-pg is absent (use --restore)"
  will "kubectl apply deploy/gcp/k8s/db (Postgres 16, ${PG_INSTANCES} instance(s), daily backup to gs://${BACKUP_BUCKET})"
  will "wait for the cluster to be Ready (first time: 3 to 10 minutes)"
fi
will "run db-bootstrap.sh: create and verify llm_owner/llm_migrator/llm_auth/llm_runtime (same SQL as docker/postgres/init.sh)"
stop_if_dry

use_cluster

# ---- what exists now -----------------------------------------------------------
LIVE=""
live_rc=0
run_status LIVE kubectl -n "$NAMESPACE" get cluster.postgresql.cnpg.io llm-pg -o json || live_rc=$?
case "$live_rc" in
  0) ;;
  44) LIVE="" ;;
  *)
    if printf '%s' "$LIVE" | grep -q "doesn't have a resource type"; then
      die "the CloudNativePG operator is not installed yet. Run scripts/gcp/operators.sh first."
    fi
    die "cannot look up cluster llm-pg: ${LIVE}"
    ;;
esac

# overlay_for_live: pick the manifests that match how the live cluster was created, and read
# the names back from it, so a re-apply never turns a restored cluster back into an initdb one.
overlay_for_live() {
  local recovery
  recovery="$(printf '%s' "$LIVE" | jq -r '.spec.bootstrap.recovery.source // empty')" || die "cannot parse cluster llm-pg"
  if [ -z "$recovery" ]; then
    DB_DIR="${DEPLOY_DIR}/k8s/db"
    return 0
  fi
  ARCHIVE_SERVER="$(printf '%s' "$LIVE" | jq -r '.spec.plugins[0].parameters.serverName // empty')"
  RECOVERY_SERVER="$(printf '%s' "$LIVE" | jq -r '.spec.externalClusters[0].plugin.parameters.serverName // empty')"
  RECOVERY_TIME="$(printf '%s' "$LIVE" | jq -r '.spec.bootstrap.recovery.recoveryTarget.targetTime // empty')"
  [[ "$ARCHIVE_SERVER" =~ ^[A-Za-z0-9._-]+$ ]] && [[ "$RECOVERY_SERVER" =~ ^[A-Za-z0-9._-]+$ ]] \
    || die "cluster llm-pg was created by recovery but its server names cannot be read back; fix by hand: kubectl -n ${NAMESPACE} get cluster llm-pg -o yaml"
  DB_DIR="${DEPLOY_DIR}/k8s/db-restore"
  if [ -n "$RECOVERY_TIME" ]; then
    valid_pitr_time "$RECOVERY_TIME" || die "recovery target time on cluster llm-pg is not in the expected format: ${RECOVERY_TIME}"
    DB_DIR="${DEPLOY_DIR}/k8s/db-restore-pitr"
  fi
  log "cluster llm-pg was created by recovery (archives as ${ARCHIVE_SERVER}); re-applying the matching manifests"
}

if [ -n "$LIVE" ]; then
  [ "$RESTORE" = 0 ] || die "cluster llm-pg already exists; --restore only creates a new one. To replace it, run scripts/gcp/down.sh (type 'delete database'), then database.sh --restore."
  overlay_for_live
elif [ "$RESTORE" = 1 ]; then
  base_state="$(gcs_prefix_state "gs://${BACKUP_BUCKET}/${FROM_SERVER}/base/")" || die "cannot check for a base backup (see the error above)"
  [ "$base_state" = present ] || die "gs://${BACKUP_BUCKET}/${FROM_SERVER}/base/ holds no base backup, so there is nothing to restore. Servers in the bucket: gcloud storage ls gs://${BACKUP_BUCKET}/"
  ARCHIVE_SERVER="llm-pg-r$(date -u +%Y%m%d%H%M%S)"
  RECOVERY_SERVER="$FROM_SERVER"
  RECOVERY_TIME="$RESTORE_TIME"
  DB_DIR="${DEPLOY_DIR}/k8s/db-restore"
  [ -z "$RECOVERY_TIME" ] || DB_DIR="${DEPLOY_DIR}/k8s/db-restore-pitr"
  warn "This creates the production database from backups: server ${FROM_SERVER}${RECOVERY_TIME:+ as of ${RECOVERY_TIME}}. Anything written after that point is not in it."
  confirm "Create cluster llm-pg by recovery now?"
else
  store_state="$(gcs_prefix_state "gs://${BACKUP_BUCKET}/")" || die "cannot check the backups bucket (see the error above); not creating a database blind"
  if [ "$store_state" = present ]; then
    die "gs://${BACKUP_BUCKET}/ already holds backups and cluster llm-pg does not exist. A fresh database would write its WAL next to them. Restore instead:
  scripts/gcp/database.sh --restore [--from SERVER] [--time 'YYYY-MM-DD HH:MM:SS+00']
(servers in the bucket: gcloud storage ls gs://${BACKUP_BUCKET}/). If you really want a new, empty database, delete the old backups first with scripts/gcp/purge.sh."
  fi
  DB_DIR="${DEPLOY_DIR}/k8s/db"
fi

# ---- apply -----------------------------------------------------------------------
manifest="$(ARCHIVE_SERVER="${ARCHIVE_SERVER:-}" RECOVERY_SERVER="${RECOVERY_SERVER:-}" RECOVERY_TIME="${RECOVERY_TIME:-}" render "$DB_DIR")" \
  || die "cannot render ${DB_DIR}"
printf '%s\n' "$manifest" | kubectl apply -f - >/dev/null
kubectl -n "$NAMESPACE" wait --for=condition=Ready cluster.postgresql.cnpg.io/llm-pg --timeout="${DB_READY_TIMEOUT:-1800s}" \
  || die "database cluster is not Ready. Look: kubectl -n ${NAMESPACE} describe cluster.postgresql.cnpg.io llm-pg"
if [ "$RESTORE" = 1 ]; then
  log "restored. Run scripts/gcp/backup-now.sh now: the new archive (${ARCHIVE_SERVER}) has no base backup until one runs."
fi
"${GCP_SCRIPTS_DIR}/db-bootstrap.sh"
