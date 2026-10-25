#!/usr/bin/env bash
# Step: first tenant, then OpenAI, Anthropic, and Vertex AI providers, streaming, and the
# "auto" alias. Safe to repeat and safe to restart after a crash: every phase first reads
# what already exists in the database (CLI list-inference) and only does what is missing.
# Only two facts are kept as markers in ConfigMap llm-setup, because the database cannot
# show them: "limits" and "vertex-validated".
#
# Provider API keys are asked once with hidden input, stored in Secret Manager, and
# piped to the CLI on stdin (--api-key-stdin). They never appear in argv, logs, or files.
# Press Enter at a key prompt to skip that provider; the next run asks again.
# For runs without a terminal, OPENAI_API_KEY_FILE / ANTHROPIC_API_KEY_FILE may name a
# file (mode 600) holding the key.
#
# Tenant limits are set in "observe" mode: limits are recorded and counted, but a request
# over a limit is still allowed (see docs/limits.md). Switch to "hard" later with the CLI.
source "$(dirname "$0")/common.sh"
help_if_asked "$@"
require_settings

log "Step: tenant and providers"
will "create tenant '${TENANT_NAME}' once; store its JSON (tenant id, key id, secret) in Secret Manager secret llm-tenant-default"
will "set tenant limits (observe mode: recorded, not enforced; 32 streams, 600000 ms lease)"
will "OpenAI (${OPENAI_MODEL}) and Anthropic (${ANTHROPIC_MODEL}): ask for each API key with hidden input, store in Secret Manager, register via CLI stdin"
will "Vertex AI (${VERTEX_MODEL}): register with Workload Identity (no key), then validate access and test inference"
will "enable streaming per deployment with explicit timeouts (30000/60000/600000/30000 ms), set alias 'auto'"
stop_if_dry

grep -q 'api-key-stdin' "${ROOT}/src/cli.ts" \
  || die "src/cli.ts has no --api-key-stdin. Update the app to a version that has it, then re-run scripts/gcp/providers.sh."

use_cluster
TENANT_SECRET_NAME="llm-tenant-default"
STREAM_CONNECT_MS=30000
STREAM_IDLE_MS=60000
STREAM_TOTAL_MS=600000
STREAM_BACKPRESSURE_MS=30000

# ---- tenant -----------------------------------------------------------------
# revoke_pending_key TENANT_ID KEY_ID: a key whose secret was never stored is useless; revoke it.
revoke_pending_key() {
  if cli_run revoke-key --tenant-id "$1" --key-id "$2" >/dev/null; then
    setup_set tenant-pending-key-id ""
    return 0
  fi
  return 1
}

# store_tenant_secret JSON: Secret Manager, three tries. Never prints the JSON.
store_tenant_secret() {
  local attempt
  for attempt in 1 2 3; do
    if printf '%s' "$1" | secret_try_add "$TENANT_SECRET_NAME" 2>/dev/null; then return 0; fi
    sleep $((attempt * 2))
  done
  return 1
}

ensure_tenant() {
  local created key_id pending stored_id
  if secret_has_version "$TENANT_SECRET_NAME"; then
    TENANT_ID="$(read_secret "$TENANT_SECRET_NAME" | jq -r .tenantId)" || die "cannot read ${TENANT_SECRET_NAME}"
    [ -n "$TENANT_ID" ] && [ "$TENANT_ID" != "null" ] || die "tenant id missing from ${TENANT_SECRET_NAME}"
    # The secret outlives the database (it is kept across down.sh). Trust it only if the tenant
    # is really in the database; list-inference fails for an unknown tenant.
    cli_run list-inference --tenant-id "$TENANT_ID" >/dev/null 2>&1 \
      || die "secret ${TENANT_SECRET_NAME} names tenant ${TENANT_ID}, but the CLI cannot list it: the tenant is missing from the database (a fresh database after a teardown?) or the CLI failed. If the database should have been restored, run scripts/gcp/database.sh --restore. If it is truly new, delete the stale secret (gcloud secrets delete ${TENANT_SECRET_NAME}) and re-run."
    return 0
  fi

  stored_id="$(setup_get tenant-id)" || die "cannot read setup state"
  pending="$(setup_get tenant-pending-key-id)" || die "cannot read setup state"
  if [ -n "$stored_id" ] && [ -n "$pending" ]; then
    # An earlier run made a key but never stored its secret.
    revoke_pending_key "$stored_id" "$pending" \
      || warn "could not revoke earlier key ${pending} of tenant ${stored_id}; revoke it later with revoke-key"
  fi

  if [ -z "$stored_id" ]; then
    log "creating tenant ${TENANT_NAME}"
    created="$(cli_run provision-tenant --name "$TENANT_NAME")" || die "provision-tenant failed"
  else
    log "tenant ${stored_id} exists but its secret was never stored; issuing a new key"
    created="$(cli_run add-key --tenant-id "$stored_id" --label "gcp-setup")" || die "add-key failed"
  fi
  printf '%s' "$created" | jq -e '.tenantId and .keyId and .secret' >/dev/null \
    || die "the CLI returned something unexpected; check the CLI logs"
  TENANT_ID="$(printf '%s' "$created" | jq -r .tenantId)"
  key_id="$(printf '%s' "$created" | jq -r .keyId)"
  # Record ids (not secrets) before anything else can fail.
  setup_set tenant-id "$TENANT_ID"
  setup_set tenant-pending-key-id "$key_id"

  if ! store_tenant_secret "$created"; then
    unset created
    if revoke_pending_key "$TENANT_ID" "$key_id"; then
      die "could not store the tenant secret in Secret Manager. The new key was revoked, nothing is lost. Re-run scripts/gcp/providers.sh."
    fi
    die "could not store the tenant secret in Secret Manager, and revoking key ${key_id} of tenant ${TENANT_ID} also failed. Revoke it by hand (revoke-key --tenant-id ${TENANT_ID} --key-id ${key_id}), then re-run scripts/gcp/providers.sh."
  fi
  unset created
  setup_set tenant-pending-key-id ""
}

# ---- reading what exists ------------------------------------------------------
refresh_listing() {
  LISTING="$(cli_run list-inference --tenant-id "$TENANT_ID")" || die "list-inference failed"
  printf '%s' "$LISTING" | jq -e '.connections and .deployments' >/dev/null \
    || die "list-inference returned something unexpected"
}
has_connection() { printf '%s' "$LISTING" | jq -e --arg p "$1" '[.connections[] | select(.provider == $p)] | length > 0' >/dev/null; }
has_deployment() { printf '%s' "$LISTING" | jq -e --arg n "$1" '[.deployments[] | select(.name == $n)] | length > 0' >/dev/null; }
has_alias_auto() { printf '%s' "$LISTING" | jq -e '[.aliases[]? | select(.alias == "auto")] | length > 0' >/dev/null; }
streaming_ok() { # deployment name: streaming on with the four timeouts we want
  printf '%s' "$LISTING" | jq -e --arg n "$1" \
    --argjson c "$STREAM_CONNECT_MS" --argjson i "$STREAM_IDLE_MS" --argjson t "$STREAM_TOTAL_MS" --argjson b "$STREAM_BACKPRESSURE_MS" '
    [.deployments[] | select(.name == $n and .streamingEnabled == true
      and .streamConnectTimeoutMs == $c and .streamIdleTimeoutMs == $i
      and .streamTotalTimeoutMs == $t and .streamBackpressureTimeoutMs == $b)] | length > 0' >/dev/null
}

# ---- helpers ----------------------------------------------------------------
# obtain_key SECRET_NAME LABEL FILE_ENV: sets PROVIDER_KEY.
# Returns 0 key available, 1 skipped by the user, 2 failure (explicit; no reliance on errexit).
obtain_key() {
  local secret="$1" label="$2" file_env="$3" key=""
  PROVIDER_KEY=""
  if secret_has_version "$secret"; then
    key="$(read_secret "$secret")" || return 2
    PROVIDER_KEY="$key"
    return 0
  fi
  ask_secret key "Paste your ${label} API key (hidden; Enter to skip)" "$file_env" || return 2
  key="$(printf '%s' "$key" | tr -d '[:space:]')"
  [ -n "$key" ] || return 1
  printf '%s' "$key" | secret_try_add "$secret" || return 2
  PROVIDER_KEY="$key"
  return 0
}

# ensure_key_connection PROVIDER LABEL SECRET FILE_ENV REGISTER_COMMAND [extra args...]
# Returns 0 when the connection exists afterwards, 1 when the user skipped it.
ensure_key_connection() {
  local provider="$1" label="$2" secret="$3" file_env="$4" command="$5" rc
  shift 5
  has_connection "$provider" && return 0
  rc=0
  obtain_key "$secret" "$label" "$file_env" || rc=$?
  case "$rc" in
    0) ;;
    1) warn "${label} skipped"; return 1 ;;
    *) die "cannot get the ${label} API key (see the error above)" ;;
  esac
  printf '%s' "$PROVIDER_KEY" | cli_run_stdin "$command" --tenant-id "$TENANT_ID" "$@" --api-key-stdin >/dev/null \
    || die "${command} failed for ${label}. Re-run scripts/gcp/providers.sh."
  PROVIDER_KEY=""
  refresh_listing
}

# ensure_deployment NAME PROVIDER MODEL TIMEOUT_MS extra register-deployment args...
ensure_deployment() {
  local name="$1" provider="$2" model="$3" timeout="$4"
  shift 4
  if ! has_deployment "$name"; then
    cli_run register-deployment --tenant-id "$TENANT_ID" --name "$name" --provider "$provider" \
      --upstream-model "$model" --timeout-ms "$timeout" --enabled true "$@" >/dev/null \
      || die "register-deployment ${name} failed"
    refresh_listing
  fi
  if ! streaming_ok "$name"; then
    # The command replaces all four timeouts at once.
    cli_run set-deployment-streaming --tenant-id "$TENANT_ID" --deployment "$name" --enabled true \
      --connect-timeout-ms "$STREAM_CONNECT_MS" --idle-timeout-ms "$STREAM_IDLE_MS" \
      --total-timeout-ms "$STREAM_TOTAL_MS" --backpressure-timeout-ms "$STREAM_BACKPRESSURE_MS" >/dev/null \
      || die "set-deployment-streaming ${name} failed"
    refresh_listing
  fi
}

# ---- run ----------------------------------------------------------------------
ensure_tenant
refresh_listing

if ! step_done limits; then
  # Lease must be at least the longest stream (600 s), or the shared cap under-counts.
  # Not yet verified on a live cluster: see "Verify first" U15 in docs/gcp-deployment.md.
  cli_run set-tenant-limits --tenant-id "$TENANT_ID" --mode observe \
    --concurrent-streams 32 --lease-ms 600000 >/dev/null || die "set-tenant-limits failed"
  mark_step_done limits
fi
if ! printf '%s' "$LISTING" | jq -e '.streamingEnabled == true' >/dev/null; then
  cli_run set-tenant-streaming --tenant-id "$TENANT_ID" --enabled true >/dev/null || die "set-tenant-streaming failed"
  refresh_listing
fi

# OpenAI
if ensure_key_connection openai OpenAI llm-openai-api-key OPENAI_API_KEY_FILE register-openai-connection; then
  ensure_deployment openai-mini openai "$OPENAI_MODEL" 30000 --capabilities temperature
fi

# Anthropic
if ensure_key_connection anthropic Anthropic llm-anthropic-api-key ANTHROPIC_API_KEY_FILE \
  register-anthropic-connection --endpoint https://api.anthropic.com; then
  ensure_deployment claude anthropic "$ANTHROPIC_MODEL" 60000 \
    --default-max-output-tokens 1024 --capabilities temperature,stop,max_completion_tokens
fi

# Vertex AI (Workload Identity, no key)
if ! has_connection vertex; then
  cli_run register-vertex-connection --tenant-id "$TENANT_ID" --auth-mode workload_identity \
    --project "$PROJECT_ID" --location "$REGION" --api-version v1 >/dev/null || die "register-vertex-connection failed"
  refresh_listing
fi
ensure_deployment vertex-flash vertex "$VERTEX_MODEL" 30000 --capabilities temperature,max_tokens,stop
if ! step_done vertex-validated; then
  # These need the pod's Workload Identity, which is why they run in the cluster.
  # Not yet verified on a live cluster: see "Verify first" U3 in docs/gcp-deployment.md.
  cli_run validate-vertex-credential --tenant-id "$TENANT_ID" >/dev/null || die "validate-vertex-credential failed"
  cli_run validate-vertex-access --tenant-id "$TENANT_ID" >/dev/null || die "validate-vertex-access failed"
  cli_run test-vertex-inference --tenant-id "$TENANT_ID" --deployment vertex-flash >/dev/null || die "test-vertex-inference failed"
  mark_step_done vertex-validated
fi

# Alias "auto": the first deployment that exists, in the order OpenAI, Anthropic, Vertex.
if ! has_alias_auto; then
  for name in openai-mini claude vertex-flash; do
    if has_deployment "$name"; then
      cli_run set-alias --tenant-id "$TENANT_ID" --alias auto --deployment "$name" >/dev/null || die "set-alias failed"
      break
    fi
  done
fi
log "providers configured"
