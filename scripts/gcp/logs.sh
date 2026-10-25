#!/usr/bin/env bash
# Follow app logs. Usage: scripts/gcp/logs.sh [kubectl logs flags, e.g. --since=1h]
source "$(dirname "$0")/common.sh"
help_if_asked "$@"
require_settings
log "Step: logs"
will "kubectl logs -f for deploy/llm-proxy in ${NAMESPACE}"
stop_if_dry
use_cluster
exec kubectl -n "$NAMESPACE" logs -f deploy/llm-proxy -c llm-proxy --tail=100 "$@"
