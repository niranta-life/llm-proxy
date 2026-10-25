#!/usr/bin/env bash
# Deploy a version of the app, then check the rollout, the gateway, and /health/ready
# (run smoke.sh for the full check). Safe to repeat: it asks "Continue?" each time
# (YES=1 skips that) and re-applies the manifests.
#
# Usage: scripts/gcp/deploy.sh [git-sha]
#   no argument: deploy the current clean commit (builds the image if needed)
#   git-sha:     deploy an image that already exists, with the manifests from your CURRENT
#                checkout (image only). To put back an earlier release exactly, use rollback.sh.
#
# Prints the plan and asks BEFORE building. After a verified rollout it records a release
# (image digest, manifests, settings) in the cluster for rollback.sh.
# Environment: SKIP_PUBLIC_CHECK=1 skips the public URL check (up.sh sets it before DNS is ready).
source "$(dirname "$0")/common.sh"
source "${GCP_SCRIPTS_DIR}/lib-deploy.sh"
help_if_asked "$@"
require_settings
require_tools gcloud kubectl git curl jq

TARGET_SHA="${1:-}"
OTHER_AUTOSCALER="keda"
[ "$AUTOSCALER" != "keda" ] || OTHER_AUTOSCALER="hpa"

log "Step: deploy app"
will "compute the image tag from git (or use the given SHA), refuse a dirty tree when building"
will "print current vs new image, autoscaler (${AUTOSCALER} min ${MIN_REPLICAS} max ${MAX_REPLICAS}), then ask"
will "build with Cloud Build if the image is missing, apply the gateway and app manifests, replace the ${OTHER_AUTOSCALER} autoscaler"
will "wait for rollout (up to 15 minutes), Gateway Programmed, HTTPRoutes Accepted, then GET https://${DOMAIN}/health/ready"
will "record the release so rollback.sh can restore it"
stop_if_dry

BUILD_NEEDED=0
if [ -n "$TARGET_SHA" ]; then
  SHA="$TARGET_SHA"
else
  require_clean_tree
  SHA="$(git_sha)"
  BUILD_NEEDED=1
fi
IMAGE_TAG="${REGISTRY}/${IMAGE_NAME}:${SHA}"

HAVE_IMAGE=0
if gcloud artifacts docker images describe "$IMAGE_TAG" --project "$PROJECT_ID" >/dev/null 2>&1; then
  HAVE_IMAGE=1
fi
if [ "$HAVE_IMAGE" = 0 ] && [ "$BUILD_NEEDED" = 0 ]; then
  die "image ${IMAGE_TAG} not found; check out that commit and run deploy.sh without an argument"
fi

use_cluster
CURRENT="$(kubectl -n "$NAMESPACE" get deploy llm-proxy \
  -o jsonpath='{.spec.template.spec.containers[0].image}' 2>/dev/null || true)"
CURRENT="${CURRENT:-none}"
[ "${CURRENT%%@*}" != "$IMAGE_TAG" ] || log "this image is already deployed; re-applying manifests (idempotent)"

log "Cluster:    ${CLUSTER} (${PROJECT_ID}, ${REGION})"
log "Current:    ${CURRENT}"
log "New:        ${IMAGE_TAG} (build needed: $([ "$HAVE_IMAGE" = 0 ] && echo yes || echo no))"
log "Autoscaler: ${AUTOSCALER}, min ${MIN_REPLICAS}, max ${MAX_REPLICAS}; replaces ${OTHER_AUTOSCALER} if present"
log "The new pod runs database migrations at startup (up to 12 minutes); old pods keep serving until it is ready."
confirm "Continue?"

if [ "$HAVE_IMAGE" = 0 ]; then YES=1 "${GCP_SCRIPTS_DIR}/build.sh"; fi

# Pin by digest so a re-pushed tag cannot change what runs.
DIGEST="$(gcloud artifacts docker images describe "$IMAGE_TAG" --project "$PROJECT_ID" \
  --format='value(image_summary.digest)')" || die "cannot read the image digest of ${IMAGE_TAG}"
[ -n "$DIGEST" ] || die "no digest for ${IMAGE_TAG}"
IMAGE="${IMAGE_TAG}@${DIGEST}"
export IMAGE

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
render "${DEPLOY_DIR}/k8s/platform" >"${WORK}/platform.yaml"
render "${DEPLOY_DIR}/k8s/app" >"${WORK}/app.yaml"
render "${DEPLOY_DIR}/k8s/autoscaler/${AUTOSCALER}.yaml" >"${WORK}/autoscaler.yaml"

apply_bundle "${WORK}/platform.yaml" "${WORK}/app.yaml" "${WORK}/autoscaler.yaml"
wait_rollout
wait_gateway
record_release "$SHA" "$IMAGE" "${WORK}/platform.yaml" "${WORK}/app.yaml" "${WORK}/autoscaler.yaml"

if [ "${SKIP_PUBLIC_CHECK:-0}" = "1" ]; then
  log "deployed ${SHA}; public URL check skipped (up.sh checks it after DNS and TLS are ready)"
  exit 0
fi
if public_check; then
  log "deployed ${SHA}; https://${DOMAIN}/health/ready is healthy"
  exit 0
fi
warn_public_unreachable
exit 3
