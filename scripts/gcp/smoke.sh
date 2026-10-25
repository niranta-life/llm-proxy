#!/usr/bin/env bash
# Smoke test through the public URL: health, then for every enabled deployment one plain
# call and one streaming call. Run from an IP in TEAM_CIDRS. Exits non-zero if any check
# fails, or if no deployment was tested at all.
#
# The stream check also measures when each event arrives. A proxy that buffers the whole
# answer delivers every event at once; a working stream spreads them out, so the first
# event must arrive well before the last. Needs bash 5 (EPOCHREALTIME), which common.sh
# requires; if the timing is somehow unavailable the check FAILS rather than passing blind.
source "$(dirname "$0")/common.sh"
help_if_asked "$@"
require_settings
require_tools curl jq kubectl

log "Step: smoke tests"
will "GET https://${DOMAIN}/health/ready"
will "list the enabled deployments from the CLI (list-inference), then for each: one plain chat call, one streaming call"
will "stream check: HTTP 200, text/event-stream, at least 10 data: events, ends with [DONE], events spread over time"
stop_if_dry

use_cluster
TENANT_JSON="$(read_secret llm-tenant-default)" || die "cannot read the tenant secret"
TENANT_ID="$(printf '%s' "$TENANT_JSON" | jq -r .tenantId)"
TENANT_SECRET="$(printf '%s' "$TENANT_JSON" | jq -r .secret)"
unset TENANT_JSON

BASE="https://${DOMAIN}"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
FAILED=0
TESTED=0
fail() { printf '  FAIL: %s\n' "$*" >&2; FAILED=1; }

# Deployments whose connection is enabled and whose provider is one we support.
DEPLOYMENTS="$(cli_run list-inference --tenant-id "$TENANT_ID" | jq -r '
  ([.connections[]? | select(.enabled == true and (.provider | IN("openai", "anthropic", "vertex"))) | .id]) as $ok
  | .deployments[]? | select(.connectionId as $c | $ok | index($c)) | .name')" \
  || die "cannot list deployments (list-inference failed)"

# curl_chat BODY_JSON: headers to $WORK/headers; the answer, one line per row, to stdout.
# The tenant secret goes to curl on stdin (-K -), so it is not in the process list.
curl_chat() {
  printf 'header = "X-Tenant-ID: %s"\nheader = "Authorization: Bearer %s"\n' "$TENANT_ID" "$TENANT_SECRET" \
    | curl -sS -K - -N --max-time 120 -D "${WORK}/headers" \
      -H 'content-type: application/json' -d "$1" "${BASE}/v1/chat/completions"
}
http_status() { awk 'NR == 1 { print $2 }' "${WORK}/headers"; }

plain_check() { # model
  local body status
  body="$(jq -nc --arg m "$1" '{model:$m, stream:false, messages:[{role:"user",content:"Say hello in five words."}]}')"
  curl_chat "$body" >"${WORK}/body" || { fail "plain call: curl failed"; return; }
  status="$(http_status)"
  if [ "$status" = "200" ] && jq -e '.choices[0].message.content | length > 0' "${WORK}/body" >/dev/null 2>&1; then
    ok "plain call (HTTP ${status})"
  else
    fail "plain call (HTTP ${status:-none}); body: $(head -c 300 "${WORK}/body")"
  fi
}

# stream_check MODEL: prints one line per data event to events: "<arrival seconds> <line>".
stream_check() {
  local body status events first last span now line
  body="$(jq -nc --arg m "$1" '{model:$m, stream:true, messages:[{role:"user",content:"Count from 1 to 40, one number per line."}]}')"
  : >"${WORK}/events"
  # Timestamp each event as it arrives. The loop's own exit status is irrelevant; curl's is checked.
  curl_chat "$body" | while IFS= read -r line; do
    now="${EPOCHREALTIME:-}"
    case "$line" in data:*) printf '%s %s\n' "$now" "$line" >>"${WORK}/events" ;; esac
  done
  [ "${PIPESTATUS[0]}" = 0 ] || { fail "stream call: curl failed"; return; }
  status="$(http_status)"
  events="$(grep -c . "${WORK}/events" || true)"
  if [ "$status" != "200" ] || ! grep -qi '^content-type:.*text/event-stream' "${WORK}/headers"; then
    fail "stream response (HTTP ${status:-none}) is not text/event-stream"
    return
  fi
  if [ "$events" -lt 10 ] || ! grep -q ' data: \[DONE\]$' "${WORK}/events"; then
    fail "stream is not a complete event stream (${events} events, need >= 10 ending in [DONE])"
    return
  fi
  first="$(head -n1 "${WORK}/events" | cut -d' ' -f1)"
  last="$(tail -n1 "${WORK}/events" | cut -d' ' -f1)"
  span="$(awk -v a="$first" -v b="$last" 'BEGIN { printf "%.2f", b - a }')"
  if [ -z "$first" ] || [ -z "$last" ]; then
    fail "stream timing not measured (no EPOCHREALTIME in bash ${BASH_VERSION}); cannot tell a stream from a buffered answer"
  elif awk -v s="$span" 'BEGIN { exit !(s < 0.10) }'; then
    fail "stream looks buffered: ${events} events all arrived within ${span}s"
  else
    ok "stream (${events} events spread over ${span}s)"
  fi
}

log "health"
if curl -fsS -o /dev/null --max-time 10 "${BASE}/health/ready"; then ok "/health/ready"; else fail "/health/ready (DNS, certificate, or your IP not in TEAM_CIDRS?)"; fi

while IFS= read -r model; do
  [ -n "$model" ] || continue
  log "$model"
  plain_check "$model"
  stream_check "$model"
  TESTED=$((TESTED + 1))
done <<<"$DEPLOYMENTS"

[ "$TESTED" -gt 0 ] || fail "no enabled deployment was tested (run scripts/gcp/providers.sh to register one)"
[ "$FAILED" = 0 ] || die "smoke tests failed"
log "smoke tests passed (${TESTED} deployment(s)). Test one stream longer than 60 s separately: not yet verified live, see \"Verify first\" U2 in docs/gcp-deployment.md."
