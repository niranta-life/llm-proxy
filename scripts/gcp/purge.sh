#!/usr/bin/env bash
# Delete what down.sh keeps: all database backups, all Secret Manager secrets (including
# the provider credential key), and the build staging bucket. Cannot be undone.
# Run down.sh first. Asks you to type: delete backups and secrets
#
# The OpenTofu state bucket and the project are never touched. Safe to re-run after a
# partial failure. Every mutation is checked: "already gone" continues, any other error
# (denied, network) stops the script before anything further is removed.
source "$(dirname "$0")/common.sh"
help_if_asked "$@"
require_settings
require_tools gcloud tofu jq

CREDENTIAL_SECRET="llm-provider-credential-key"
CREDENTIAL_STATE_ADDR="google_secret_manager_secret.credential_key"

log "Step: purge backups and secrets in ${PROJECT_ID}"
will "refuse to run while the platform stack still has resources in its state"
will "ask you to type 'delete backups and secrets'"
will "empty gs://${BACKUP_BUCKET} including old object versions (stop if that fails), then tofu destroy the persistent stack"
will "delete the credential key secret ${CREDENTIAL_SECRET}, confirm it is gone, then remove it from tofu state (it is protected there with prevent_destroy)"
stop_if_dry

"${GCP_SCRIPTS_DIR}/tofu.sh" platform init >/dev/null
remaining="$("${GCP_SCRIPTS_DIR}/tofu.sh" platform state list)" || die "cannot read the platform state"
[ -z "$remaining" ] || die "the platform stack still exists. Run scripts/gcp/down.sh first."

typed "delete backups and secrets" \
  "This deletes ALL database backups in gs://${BACKUP_BUCKET} and every Secret Manager secret in ${PROJECT_ID} for llm-proxy, including ${CREDENTIAL_SECRET}. Encrypted provider credentials in any restored database become unreadable."

"${GCP_SCRIPTS_DIR}/tofu.sh" persistent init >/dev/null

# ---- 1. backups bucket: describe -> exists / absent / error; then empty it ----------
rc=0
run_status out gcloud storage buckets describe "gs://${BACKUP_BUCKET}" --project "$PROJECT_ID" || rc=$?
case "$rc" in
  0)
    rc=0
    run_status out gcloud storage rm -r --all-versions "gs://${BACKUP_BUCKET}/**" --project "$PROJECT_ID" || rc=$?
    case "$rc" in
      0) ok "backups deleted" ;;
      44) ok "backups bucket was already empty" ;;
      *)
        # "matched no objects" is how gcloud reports an empty bucket.
        if printf '%s' "$out" | grep -qi 'matched no objects'; then
          ok "backups bucket was already empty"
        else
          die "could not delete the backups: ${out}"
        fi
        ;;
    esac
    ;;
  44) ok "backups bucket ${BACKUP_BUCKET} does not exist" ;;
  *) die "cannot check the backups bucket: ${out}" ;;
esac

# ---- 2. credential key secret: delete, confirm gone, only then forget it in state ---
rc=0
run_status out gcloud secrets delete "$CREDENTIAL_SECRET" --project "$PROJECT_ID" --quiet || rc=$?
case "$rc" in
  0) ok "deleted secret ${CREDENTIAL_SECRET}" ;;
  44) ok "secret ${CREDENTIAL_SECRET} was already gone" ;;
  *) die "could not delete secret ${CREDENTIAL_SECRET}: ${out}" ;;
esac
rc=0
run_status out gcloud secrets describe "$CREDENTIAL_SECRET" --project "$PROJECT_ID" || rc=$?
[ "$rc" = 44 ] || die "secret ${CREDENTIAL_SECRET} still answers after deletion (status ${rc}): ${out}"

state="$("${GCP_SCRIPTS_DIR}/tofu.sh" persistent state list)" || die "cannot read the persistent state"
if printf '%s\n' "$state" | grep -qx "$CREDENTIAL_STATE_ADDR"; then
  "${GCP_SCRIPTS_DIR}/tofu.sh" persistent state rm "$CREDENTIAL_STATE_ADDR" || die "could not remove ${CREDENTIAL_STATE_ADDR} from state"
fi

# ---- 3. everything else in the persistent stack --------------------------------------
"${GCP_SCRIPTS_DIR}/tofu.sh" persistent destroy -auto-approve -input=false
log "done. Kept: state bucket ${STATE_BUCKET} and the project."
