#!/usr/bin/env bash
# Take an on-demand base backup and wait for it to finish.
source "$(dirname "$0")/common.sh"
help_if_asked "$@"
require_settings
log "Step: backup now"
will "create a CNPG Backup (barman-cloud plugin) and wait until phase=completed"
stop_if_dry
use_cluster
name="llm-pg-manual-$(date -u +%Y%m%d-%H%M%S)"
kubectl -n "$NAMESPACE" apply -f - <<YAML
apiVersion: postgresql.cnpg.io/v1
kind: Backup
metadata:
  name: ${name}
spec:
  method: plugin
  cluster:
    name: llm-pg
  pluginConfiguration:
    name: barman-cloud.cloudnative-pg.io
YAML
for _ in $(seq 1 120); do
  phase="$(kubectl -n "$NAMESPACE" get backup "$name" -o jsonpath='{.status.phase}' 2>/dev/null || true)"
  case "$phase" in
    completed) log "backup ${name} completed"; exit 0 ;;
    failed) kubectl -n "$NAMESPACE" get backup "$name" -o jsonpath='{.status.error}' >&2; die "backup failed" ;;
  esac
  sleep 10
done
die "backup ${name} did not finish in 20 minutes (phase: ${phase:-unknown})"
