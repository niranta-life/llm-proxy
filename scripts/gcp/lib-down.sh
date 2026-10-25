#!/usr/bin/env bash
# Teardown steps for down.sh, as functions so tests can call them one at a time.
# Source after common.sh and lib-plan.sh; do not run it.
# shellcheck shell=bash

# wait_until_none "what" LIST_COMMAND...: poll a read-only gcloud list until it prints nothing.
# A failing list command is fatal: "cannot list" is never read as "none left".
wait_until_none() {
  local what="$1" deadline listing
  shift
  deadline=$(($(date +%s) + ${DOWN_WAIT_MINUTES:-15} * 60))
  while true; do
    listing="$("$@")" || die "cannot list ${what}"
    if [ -z "$listing" ]; then
      ok "no ${what} left"
      return 0
    fi
    [ "$(date +%s)" -lt "$deadline" ] || die "${what} still exist after waiting. Remove them (they keep billing), then re-run scripts/gcp/down.sh: $(printf '%s' "$listing" | tr '\n' ' ')"
    sleep "${DOWN_POLL_SECONDS:-10}"
  done
}

# kdelete DESCRIPTION kubectl-args...: a kubectl delete where "already gone" is fine and
# anything else (denied, timeout) stops the teardown.
kdelete() {
  local what="$1" out rc=0
  shift
  run_status out kubectl "$@" || rc=$?
  case "$rc" in
    0 | 44) return 0 ;;
    *) die "could not delete ${what}: ${out}" ;;
  esac
}

# delete_drill_namespace: the restore drill's namespace goes FIRST and is waited for, so its
# disks are already released when the disk check below runs.
delete_drill_namespace() {
  kdelete "namespace llm-drill" delete namespace llm-drill --ignore-not-found --wait=true --timeout=10m
}

# delete_gateway: HTTPRoutes first, then the Gateway (this releases the load balancer).
delete_gateway() {
  kdelete "HTTPRoutes" -n "$NAMESPACE" delete httproute --all --ignore-not-found --wait=true --timeout=5m
  kdelete "Gateways" -n "$NAMESPACE" delete gateway --all --ignore-not-found --wait=true --timeout=10m
}

delete_database() {
  kdelete "Postgres cluster llm-pg" -n "$NAMESPACE" delete cluster.postgresql.cnpg.io llm-pg --ignore-not-found --wait=true --timeout=10m
  kdelete "Postgres PVCs" -n "$NAMESPACE" delete pvc -l cnpg.io/cluster=llm-pg --ignore-not-found --wait=true --timeout=5m
}

# verify_gcp_cleanup: with the Kubernetes objects gone, check Google Cloud directly that nothing
# they created is left. Runs whether or not the Gateway or database objects still existed, so
# resources orphaned by an earlier partial run are found too. Read-only.
# The name patterns are what GKE uses today (Gateway: gkegw*, NEGs: k8s1-*, PD volumes: pvc-*);
# not yet verified on a live cluster: see "Verify first" U16 in docs/gcp-deployment.md.
verify_gcp_cleanup() {
  local kind
  log "checking that load balancer resources and disks are gone"
  for kind in forwarding-rules target-https-proxies target-http-proxies url-maps backend-services; do
    wait_until_none "load balancer ${kind}" gcloud compute "$kind" list \
      --project "$PROJECT_ID" --filter 'name~^gkegw' --format 'value(name)'
  done
  wait_until_none "network endpoint groups" gcloud compute network-endpoint-groups list \
    --project "$PROJECT_ID" --filter 'name~^k8s1-' --format 'value(name)'
  wait_until_none "persistent disks" gcloud compute disks list \
    --project "$PROJECT_ID" --filter 'name~^pvc-' --format 'value(name)'
}

# unprotect_cluster HAVE_CLUSTER(0|1): turn off deletion protection on the GKE cluster, using a
# saved, targeted plan. Skipped when the cluster does not exist (a targeted apply would then
# try to CREATE it). Refuses to apply a plan that creates, deletes or replaces anything.
unprotect_cluster() {
  local have="$1" dir plan
  if [ "$have" != 1 ]; then
    log "cluster ${CLUSTER} does not exist; skipping the deletion-protection change"
    return 0
  fi
  dir="$(mktemp -d)"
  plan="${dir}/unprotect.tfplan"
  TF_VAR_deletion_protection=false "${GCP_SCRIPTS_DIR}/tofu.sh" platform plan -input=false \
    -target=google_container_cluster.main -out "$plan" >&2 \
    || {
      rm -rf "$dir"
      die "cannot plan the deletion-protection change"
    }
  if ! plan_only_updates platform "$plan"; then
    rm -rf "$dir"
    die "refusing to apply: the targeted plan creates, deletes or replaces resources, not just the deletion-protection flag. Read it above; nothing was changed."
  fi
  if plan_has_changes platform "$plan"; then
    TF_VAR_deletion_protection=false "${GCP_SCRIPTS_DIR}/tofu.sh" platform apply -input=false "$plan" \
      || {
        rm -rf "$dir"
        die "applying the deletion-protection change failed"
      }
  else
    ok "deletion protection is already off"
  fi
  rm -rf "$dir"
}
