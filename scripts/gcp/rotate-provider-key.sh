#!/usr/bin/env bash
# Replace an OpenAI or Anthropic API key.
# Usage: scripts/gcp/rotate-provider-key.sh openai|anthropic
#
# Asks for the new key with hidden input, stores it as a new Secret Manager version, then
# pipes it to the CLI on stdin. If the CLI step fails, the new version is disabled and the
# previous key is stored again as the newest version, so Secret Manager's "latest" always
# matches the key the database really uses. Fix the cause and run this script again.
# Vertex AI uses Workload Identity: nothing to rotate.
source "$(dirname "$0")/common.sh"
help_if_asked "$@"
require_settings
provider="${1:-}"
case "$provider" in openai | anthropic) ;; *) die "usage: rotate-provider-key.sh openai|anthropic" ;; esac
secret_name="llm-${provider}-api-key"

log "Step: rotate ${provider} key"
will "ask for the new key (hidden), add a version to ${secret_name}, update the credential via CLI stdin"
will "if the CLI fails: disable the new version and store the previous key again, then stop"
stop_if_dry
grep -q 'api-key-stdin' "${ROOT}/src/cli.ts" \
  || die "src/cli.ts has no --api-key-stdin. Update the app to a version that has it, then re-run."

use_cluster
tenant_json="$(read_secret llm-tenant-default)" || die "cannot read the tenant secret"
tenant_id="$(printf '%s' "$tenant_json" | jq -r .tenantId)"
unset tenant_json

previous=""
if secret_has_version "$secret_name"; then
  previous="$(read_secret "$secret_name")" || die "cannot read the current key"
fi

ask_secret key "New ${provider} API key" "ROTATE_API_KEY_FILE"
key="$(printf '%s' "$key" | tr -d '[:space:]')"
[ -n "$key" ] || die "empty key, nothing changed"

new_version="$(printf '%s' "$key" | secret_add_version "$secret_name")" || die "cannot add a version to ${secret_name}; nothing changed"

if ! printf '%s' "$key" | cli_run_stdin "set-${provider}-credential" --tenant-id "$tenant_id" --api-key-stdin >/dev/null; then
  unset key
  warn "the CLI could not apply the new key; undoing the Secret Manager change"
  gcloud secrets versions disable "${new_version##*/}" --secret "$secret_name" --project "$PROJECT_ID" >/dev/null \
    || warn "could not disable ${new_version}: disable it by hand"
  if [ -n "$previous" ]; then
    printf '%s' "$previous" | secret_try_add "$secret_name" \
      || warn "could not store the previous key again: ${secret_name} 'latest' may not match the live key. Check it before relying on it."
  fi
  unset previous
  die "rotation failed; the database still uses the previous key. Fix the cause, then run this script again."
fi
unset key previous
log "rotated. Run scripts/gcp/smoke.sh to confirm."
