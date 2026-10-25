#!/usr/bin/env bash
# Build the image for the current commit with Cloud Build (linux/amd64, no local Docker).
# Source is staged in gs://<project>-llm-build-staging (14-day expiry). Skips when the image already exists. Called by deploy.sh.
source "$(dirname "$0")/common.sh"
help_if_asked "$@"
require_settings
require_tools gcloud git

log "Step: image build"
will "require a clean git tree; tag the image with the commit SHA"
will "skip when ${REGISTRY}/${IMAGE_NAME}:<sha> already exists, otherwise gcloud builds submit as ${BUILD_SA}"
stop_if_dry

require_clean_tree
SHA="$(git_sha)"
IMAGE="${REGISTRY}/${IMAGE_NAME}:${SHA}"

if gcloud artifacts docker images describe "$IMAGE" --project "$PROJECT_ID" >/dev/null 2>&1; then
  log "image ${IMAGE} already exists, skipping build"
  exit 0
fi

log "building ${IMAGE}"
confirm "Build ${IMAGE} with Cloud Build?"
gcloud builds submit "$ROOT" --project "$PROJECT_ID" --region "$REGION" \
  --config "${DEPLOY_DIR}/cloudbuild.yaml" \
  --substitutions "_IMAGE=${IMAGE}" \
  --gcs-source-staging-dir "gs://${STAGING_BUCKET}/source" \
  --service-account "projects/${PROJECT_ID}/serviceAccounts/${BUILD_SA}"
