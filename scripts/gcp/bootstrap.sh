#!/usr/bin/env bash
# Step 1: project (create if missing), billing link, bootstrap APIs, state bucket.
# Safe to repeat.
source "$(dirname "$0")/common.sh"
help_if_asked "$@"
require_settings

log "Step: project, bootstrap APIs, OpenTofu state bucket"
will "check project ${PROJECT_ID} exists (create it if BILLING_ACCOUNT is set and it does not)"
will "check billing is enabled on ${PROJECT_ID}"
will "enable APIs needed before OpenTofu can run: serviceusage, cloudresourcemanager, cloudbilling, iam, storage"
will "create versioned bucket gs://${STATE_BUCKET} in ${REGION} if missing (OpenTofu state)"
stop_if_dry

if ! gcloud projects describe "$PROJECT_ID" >/dev/null 2>&1; then
  [ -n "$BILLING_ACCOUNT" ] \
    || die "project ${PROJECT_ID} does not exist. Create it, or set BILLING_ACCOUNT in deploy/gcp/settings.env so this script can (find yours: gcloud billing accounts list)"
  confirm "Create project ${PROJECT_ID} and link billing account ${BILLING_ACCOUNT}?"
  gcloud projects create "$PROJECT_ID"
  gcloud billing projects link "$PROJECT_ID" --billing-account "$BILLING_ACCOUNT"
fi

billing="$(gcloud billing projects describe "$PROJECT_ID" --format='value(billingEnabled)' 2>/dev/null || true)"
if [ "$billing" != "True" ]; then
  [ -n "$BILLING_ACCOUNT" ] \
    || die "billing is not enabled on ${PROJECT_ID}. Link it (gcloud billing projects link ${PROJECT_ID} --billing-account=ID) or set BILLING_ACCOUNT in settings.env"
  gcloud billing projects link "$PROJECT_ID" --billing-account "$BILLING_ACCOUNT"
fi

gcloud services enable serviceusage.googleapis.com cloudresourcemanager.googleapis.com \
  cloudbilling.googleapis.com iam.googleapis.com storage.googleapis.com --project "$PROJECT_ID"

if gcloud storage buckets describe "gs://${STATE_BUCKET}" --project "$PROJECT_ID" >/dev/null 2>&1; then
  log "state bucket exists"
else
  gcloud storage buckets create "gs://${STATE_BUCKET}" --project "$PROJECT_ID" \
    --location "$REGION" --uniform-bucket-level-access --public-access-prevention
  gcloud storage buckets update "gs://${STATE_BUCKET}" --versioning
fi
