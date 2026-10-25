#!/usr/bin/env bash
# Allow (or remove) an IP range for the API and the cluster endpoint.
# Usage: scripts/gcp/add-team-ip.sh [CIDR]            default: this machine's public IP
#        scripts/gcp/add-team-ip.sh --remove CIDR
source "$(dirname "$0")/common.sh"
help_if_asked "$@"
require_settings
mode="add"
if [ "${1:-}" = "--remove" ]; then mode="remove"; shift; fi
cidr="${1:-}"
if [ -z "$cidr" ]; then
  if is_dry; then cidr="<your public IP>/32"; else cidr="$(public_ip)" || die "cannot detect public IP; pass a CIDR"; fi
fi
[ "$cidr" = "<your public IP>/32" ] || valid_cidr "$cidr" || die "'${cidr}' is not a CIDR like 203.0.113.7/32"
log "Step: ${mode} ${cidr} in TEAM_CIDRS"
will "update TEAM_CIDRS in settings.env, then run infra.sh (Cloud Armor and cluster authorized networks)"
stop_if_dry
new=""
for c in $TEAM_CIDRS; do
  [ "$c" = "$cidr" ] || new="${new:+$new }$c"
done
[ "$mode" = "remove" ] || new="${new:+$new }${cidr}"
[ -n "$new" ] || die "refusing to leave TEAM_CIDRS empty"
validate_cidrs "$new"
write_setting TEAM_CIDRS "$new"
reload_settings
exec "${GCP_SCRIPTS_DIR}/infra.sh"
