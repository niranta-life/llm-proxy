#!/usr/bin/env bash
# Put back a release that was deployed before: the same image (by digest) and the same
# manifests and settings that ran then, from the release record deploy.sh saved in the cluster.
#
# Usage: scripts/gcp/rollback.sh <git-sha>
#        scripts/gcp/rollback.sh --list        show recorded releases
#
# Database migrations are NOT undone. An old image is only safe on a newer database if that
# newer version only added things (tables or columns) and removed or renamed nothing.
# Check the migrations since <git-sha> before you roll back.
source "$(dirname "$0")/common.sh"
source "${GCP_SCRIPTS_DIR}/lib-deploy.sh"
help_if_asked "$@"
require_settings
require_tools kubectl jq curl
[ $# -eq 1 ] || die "usage: rollback.sh <git-sha> | --list"

list_releases() {
  kubectl -n "$NAMESPACE" get configmap -l app=llm-proxy-release -o json \
    | jq -r '.items | sort_by(.metadata.name)[] | "\(.metadata.name)  sha=\(.metadata.annotations["llm-proxy/sha"])  \(.metadata.annotations["llm-proxy/image-digest"])"'
}

if [ "$1" = "--list" ]; then
  if is_dry; then log "dry run: would list release records"; exit 0; fi
  use_cluster
  list_releases
  exit 0
fi

SHA="$1"
[[ "$SHA" =~ ^[0-9a-f]{7,40}$ ]] || die "'${SHA}' is not a git SHA"
log "Step: rollback to ${SHA}"
will "find the recorded release for ${SHA} in ConfigMaps labelled app=llm-proxy-release"
will "check its manifests against the recorded hash, then re-apply them and wait for the rollout"
stop_if_dry

use_cluster
record="$(kubectl -n "$NAMESPACE" get configmap -l app=llm-proxy-release -o json \
  | jq -c --arg sha "$SHA" '[.items[] | select(.metadata.annotations["llm-proxy/sha"] == $sha)] | sort_by(.metadata.name) | last // empty')" \
  || die "cannot read release records"
[ -n "$record" ] || die "no recorded release for ${SHA}. Recorded releases: scripts/gcp/rollback.sh --list"

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
IMAGE="$(extract_release "$record" "$WORK")" || exit 1

warn "Database migrations are not reverted. An old image is only safe on a newer database if that newer version only added things (tables or columns) and removed or renamed nothing."
log "Rolling back to ${IMAGE}"
confirm "Continue?"

apply_bundle "${WORK}/platform.yaml" "${WORK}/app.yaml" "${WORK}/autoscaler.yaml"
wait_rollout
wait_gateway
record_release "$SHA" "$IMAGE" "${WORK}/platform.yaml" "${WORK}/app.yaml" "${WORK}/autoscaler.yaml"
if public_check; then
  log "rolled back to ${SHA}; https://${DOMAIN}/health/ready is healthy"
else
  warn_public_unreachable
  exit 3
fi
