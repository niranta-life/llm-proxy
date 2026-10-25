#!/usr/bin/env bash
# Prove the backups restore: recover them into a throwaway cluster, check, delete.
# Usage: scripts/gcp/restore-drill.sh [--time "YYYY-MM-DD HH:MM:SS+00"]   (--time = point in time)
# A backup you have not restored is not a backup. Run this monthly.
#
# The drill runs in namespace llm-drill as Kubernetes ServiceAccount drill, because the
# restore identity (llm-pg-restore, read-only on the backups bucket) is bound to exactly
# that name in OpenTofu. So each run needs a clean slate: it creates the namespace with `kubectl create`, which fails while a
# previous drill namespace still exists. It asks before creating anything billable, and
# on any failure it tells you what was left running.
source "$(dirname "$0")/common.sh"
source "${GCP_SCRIPTS_DIR}/lib-down.sh"
help_if_asked "$@"
require_settings
target_time=""
if [ "${1:-}" = "--time" ]; then
  target_time="${2:-}"
  [[ "$target_time" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}\ [0-9]{2}:[0-9]{2}:[0-9]{2}\+00$ ]] \
    || die "--time needs a value like '2026-10-22 14:30:00+00'"
fi
log "Step: restore drill"
will "create namespace llm-drill (fails if it already exists: a previous drill was not cleaned up)"
will "ask before creating a 1-instance Postgres cluster (20Gi disk) that recovers from gs://${BACKUP_BUCKET}/"
will "wait for Ready, report restore duration and max(schema_migrations.version), then ask to delete llm-drill"
stop_if_dry
use_cluster

confirm "Create the drill cluster now (billable until deleted)?"

created=0
report_retained() {
  local code=$?
  if [ "$code" -ne 0 ] && [ "$created" = 1 ]; then
    warn "the drill did not finish. STILL RUNNING and billing: namespace llm-drill (cluster drill, its disk)."
    warn "Inspect: kubectl -n llm-drill describe cluster drill      Remove: kubectl delete namespace llm-drill"
    warn "Then check for a leftover disk: gcloud compute disks list --project ${PROJECT_ID} --filter 'name~^pvc-'"
  fi
}
trap report_retained EXIT

start=$(date +%s)
manifest="$(render "${DEPLOY_DIR}/k8s/drill/drill.yaml")" || die "cannot render the drill manifest"
if [ -n "$target_time" ]; then
  manifest="$(printf '%s\n' "$manifest" \
    | awk -v t="$target_time" '{print} /# PITR: add/ {print "      recoveryTarget:\n        targetTime: \"" t "\""}')"
fi
# create (not apply): fails if the namespace exists, so two drills can never share one.
if ! out="$(kubectl create namespace llm-drill 2>&1)"; then
  die "cannot create namespace llm-drill (an earlier drill still there? kubectl delete namespace llm-drill): ${out}"
fi
created=1
printf '%s\n' "$manifest" | kubectl apply -f - >/dev/null
kubectl -n llm-drill wait --for=condition=Ready cluster/drill --timeout=30m \
  || die "drill cluster not Ready; inspect: kubectl -n llm-drill describe cluster drill"
elapsed=$(($(date +%s) - start))
version="$(kubectl -n llm-drill exec drill-1 -c postgres -- psql -U postgres -d llm_proxy -Atc 'select max(version) from schema_migrations' 2>&1 </dev/null)" \
  || die "restored, but could not query schema_migrations: ${version}"
[ -n "$version" ] || die "restored, but schema_migrations is empty; the backup may predate the first migration"
log "RESTORE OK in ${elapsed}s; latest migration ${version}. Record this as your measured RTO."

# drill_cleanup: delete the namespace, wait for it, then wait for the drill's disks to go.
# Tracking (created=1) is only cleared once both are confirmed.
drill_cleanup() {
  local pvs pv
  pvs="$(kubectl -n llm-drill get pvc -o jsonpath='{range .items[*]}{.spec.volumeName}{"\n"}{end}' 2>&1)" \
    || die "cannot list the drill volumes: ${pvs}"
  kubectl delete namespace llm-drill --wait=true --timeout=10m \
    || die "namespace llm-drill did not delete in 10 minutes; check: kubectl get namespace llm-drill -o yaml"
  for pv in $pvs; do
    wait_until_none "disk ${pv}" gcloud compute disks list --project "$PROJECT_ID" --filter "name=${pv}" --format 'value(name)' \
      || die "disk ${pv} still exists; delete it: gcloud compute disks delete ${pv} --project ${PROJECT_ID}"
  done
}

if confirm "Delete the drill namespace llm-drill?"; then
  drill_cleanup
  created=0
fi
