#!/usr/bin/env bash
# Run the operator CLI inside the running app pod.
# Usage: scripts/gcp/llm-cli.sh <cli args>      e.g. list-inference --tenant-id <id>
#        scripts/gcp/llm-cli.sh --interactive
# Never pass secrets as arguments (they reach the Kubernetes audit log). Pipe them on
# stdin with a --*-stdin flag instead.
source "$(dirname "$0")/common.sh"
help_if_asked "$@"
require_settings
log "Step: operator CLI"
will "kubectl exec into a running llm-proxy pod: node dist/cli.js $*"
stop_if_dry
use_cluster
pod="$(cli_pod)"
flags="-i"
[ -t 0 ] && flags="-it"
exec kubectl -n "$NAMESPACE" exec "$flags" "$pod" -c llm-proxy -- node dist/cli.js "$@"
