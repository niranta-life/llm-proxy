#!/usr/bin/env bash
# DNS and certificate for the public host name.
# Usage: scripts/gcp/dns.sh show | wait
#   show  print the DNS records you must create (nothing to do when Cloud DNS is managed by tofu)
#   wait  poll until DOMAIN resolves to the load balancer and the certificate is ACTIVE
# Environment: DNS_WAIT_MINUTES (default 45) is how long wait polls before giving up.
source "$(dirname "$0")/common.sh"
help_if_asked "$@"
require_settings
MODE="${1:-show}"
case "$MODE" in show | wait) ;; *) die "usage: dns.sh show|wait" ;; esac

log "Step: DNS and TLS certificate (${MODE})"
will "read lb_ip and the certificate DNS record from OpenTofu outputs"
if [ -n "$DNS_ZONE" ]; then
  will "records are managed in Cloud DNS zone ${DNS_ZONE}; nothing to create by hand"
else
  will "print the A and CNAME records for you to create at your DNS provider"
fi
[ "$MODE" != "wait" ] || will "poll up to ${DNS_WAIT_MINUTES:-45} minutes for DNS, then for the certificate to be ACTIVE"
stop_if_dry

LB_IP="$(tofu_out platform lb_ip | jq -r .)"
AUTH_NAME="$(tofu_out platform cert_dns_auth | jq -r .name)"
AUTH_TYPE="$(tofu_out platform cert_dns_auth | jq -r .type)"
AUTH_DATA="$(tofu_out platform cert_dns_auth | jq -r .data)"

if [ "$MODE" = "show" ]; then
  if [ -n "$DNS_ZONE" ]; then
    log "Cloud DNS zone ${DNS_ZONE} holds the records: ${DOMAIN} A ${LB_IP}"
  else
    cat >&2 <<REC

  Create these two DNS records at your DNS provider now:

    ${DOMAIN}.   A      ${LB_IP}
    ${AUTH_NAME}   ${AUTH_TYPE}   ${AUTH_DATA}

  The first sends traffic to the load balancer. The second proves to Google that you own the domain,
  so it can issue the certificate. up.sh waits for both.

REC
  fi
  exit 0
fi

resolve() { # resolve host -> first A record, or nothing
  if command -v dig >/dev/null 2>&1; then
    dig +short A "$1" @8.8.8.8 | grep -E '^[0-9.]+$' | head -n1 || true
  else
    curl -fsS --max-time 10 "https://dns.google/resolve?name=${1}&type=A" | jq -r '.Answer[]?.data' | head -n1 || true
  fi
}

DEADLINE=$(( $(date +%s) + ${DNS_WAIT_MINUTES:-45} * 60 ))
log "waiting for ${DOMAIN} to resolve to ${LB_IP}"
until [ "$(resolve "$DOMAIN")" = "$LB_IP" ]; do
  [ "$(date +%s)" -lt "$DEADLINE" ] || die "DNS for ${DOMAIN} still does not point to ${LB_IP}. Create the records (scripts/gcp/dns.sh show) and run up.sh again."
  sleep 15
done
log "DNS ok"

log "waiting for the managed certificate to become ACTIVE"
while true; do
  state="$(gcloud certificate-manager certificates describe llm-proxy --project "$PROJECT_ID" \
    --format='value(managed.state)' 2>/dev/null || true)"
  [ "$state" != "ACTIVE" ] || break
  [ "$(date +%s)" -lt "$DEADLINE" ] || die "certificate is ${state:-unknown}, not ACTIVE. Check the CNAME record: scripts/gcp/dns.sh show"
  sleep 20
done
log "certificate ACTIVE"
