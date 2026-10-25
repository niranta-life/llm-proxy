#!/usr/bin/env bash
# One-screen health check. Exits non-zero if something is wrong.
# Usage: scripts/gcp/status.sh
source "$(dirname "$0")/common.sh"
help_if_asked "$@"
require_settings
require_tools gcloud kubectl curl
log "Step: status"
will "show pods, database cluster, autoscaler, gateway, and GET https://${DOMAIN}/health/ready"
stop_if_dry
use_cluster
rc=0
kubectl -n "$NAMESPACE" get pods,hpa,gateway,httproute 2>&1 || rc=1
kubectl -n "$NAMESPACE" get cluster.postgresql.cnpg.io llm-pg 2>&1 || rc=1
kubectl -n "$NAMESPACE" rollout status deploy/llm-proxy --timeout=10s || rc=1
code="$(curl -sS -o /dev/null -w '%{http_code}' --max-time 15 "https://${DOMAIN}/health/ready" || true)"
log "public /health/ready: ${code}"
[ "$code" = "200" ] || rc=1
exit "$rc"
