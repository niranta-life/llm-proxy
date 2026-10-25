#!/usr/bin/env bash
# Tear down the llm-proxy platform in one project. Destructive; asks you to type confirmations.
#
# Typed confirmations, in this order (--yes does not skip them):
#   1. the project id    -> removes the gateway (and its load balancer) and the cluster
#   2. "delete database" -> removes the Postgres cluster and its disks (declining aborts)
#
# Kept: the database backups bucket, all Secret Manager secrets (including the provider
# credential key), the OpenTofu state bucket, and the project. To remove backups and
# secrets as well, run scripts/gcp/purge.sh afterwards.
#
# Before anything is deleted this script checks that the cluster and its API can be
# reached. If the API is unreachable (for example your IP is not in TEAM_CIDRS) it stops:
# deleting the cluster anyway would leave load balancers and disks behind, still billing.
source "$(dirname "$0")/common.sh"
source "${GCP_SCRIPTS_DIR}/lib-plan.sh"
source "${GCP_SCRIPTS_DIR}/lib-down.sh"
help_if_asked "$@"
require_settings
require_tools gcloud kubectl tofu jq

log "Step: teardown of ${PROJECT_ID}"
will "check the cluster and its Kubernetes API are reachable (read-only); stop if not"
will "ask you to type the project id; ask you to type 'delete database' if the Postgres cluster exists"
will "delete namespace llm-drill, Gateway/HTTPRoute, then the Postgres cluster; wait for each"
will "check in Google Cloud that no load balancer parts, network endpoint groups or pvc- disks are left"
will "turn off cluster deletion protection with a saved, targeted plan (refused if it would create or replace anything; skipped if the cluster is gone)"
will "tofu destroy of the platform stack (the persistent stack is kept)"
stop_if_dry

# --- read-only preflight: tell "does not exist" apart from "cannot reach" ---
HAVE_CLUSTER=0
HAVE_NAMESPACE=0
HAVE_DB=0
if out="$(gcloud container clusters describe "$CLUSTER" --region "$REGION" --project "$PROJECT_ID" --format='value(name)' 2>&1)"; then
  HAVE_CLUSTER=1
elif is_not_found "$out"; then
  log "cluster ${CLUSTER} does not exist; only the remaining OpenTofu resources will be destroyed"
else
  die "cannot describe cluster ${CLUSTER}: ${out}"
fi

if [ "$HAVE_CLUSTER" = 1 ]; then
  use_cluster
  if out="$(kubectl get namespace "$NAMESPACE" -o name 2>&1)"; then
    HAVE_NAMESPACE=1
  elif is_not_found "$out"; then
    log "namespace ${NAMESPACE} does not exist"
  else
    die "cannot reach the Kubernetes API (is your IP in TEAM_CIDRS? scripts/gcp/add-team-ip.sh): ${out}"
  fi
fi

if [ "$HAVE_NAMESPACE" = 1 ]; then
  if out="$(kubectl -n "$NAMESPACE" get cluster.postgresql.cnpg.io llm-pg -o name 2>&1)"; then
    HAVE_DB=1
  elif is_not_found "$out" || printf '%s' "$out" | grep -q "doesn't have a resource type"; then
    log "no Postgres cluster llm-pg"
  else
    die "cannot look up the Postgres cluster: ${out}"
  fi
fi

# --- decisions first, deletions after ---
typed "$PROJECT_ID" "This destroys the llm-proxy platform in ${PROJECT_ID}."
if [ "$HAVE_DB" = 1 ]; then
  typed "delete database" "This deletes the Postgres cluster llm-pg and its disks. Backups stay in gs://${BACKUP_BUCKET}."
fi

# --- deletions: drill first, then the edge, then the database; then verify in Google Cloud ---
if [ "$HAVE_CLUSTER" = 1 ]; then delete_drill_namespace; fi
if [ "$HAVE_NAMESPACE" = 1 ]; then delete_gateway; fi
if [ "$HAVE_DB" = 1 ]; then delete_database; fi
# Checked even when the Kubernetes objects were already gone: an earlier partial run may have
# left load balancer parts or disks behind.
verify_gcp_cleanup

# --- infrastructure: platform stack only ---
"${GCP_SCRIPTS_DIR}/tofu.sh" platform init >/dev/null
unprotect_cluster "$HAVE_CLUSTER"
TF_VAR_deletion_protection=false "${GCP_SCRIPTS_DIR}/tofu.sh" platform destroy -auto-approve -input=false
log "done. Kept: backups bucket gs://${BACKUP_BUCKET}, Secret Manager secrets, state bucket ${STATE_BUCKET}, the project."
log "To delete backups and secrets too: scripts/gcp/purge.sh"
