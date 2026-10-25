#!/usr/bin/env bash
# Run OpenTofu for one stack with values from settings.env.
#
# Usage: scripts/gcp/tofu.sh <persistent|platform> <tofu args>
#   e.g. scripts/gcp/tofu.sh platform plan
#        scripts/gcp/tofu.sh platform output lb_ip
#
# Stacks (separate state, so tearing down the platform keeps backups and secrets):
#   persistent  Secret Manager secrets, the backups bucket, the build staging bucket
#   platform    cluster, network, IAM, load balancer, registry
#
# Writes <stack>/generated.auto.tfvars.json (no secrets in it). With DRY_RUN=1 it only
# prints the command and writes nothing.
source "$(dirname "$0")/common.sh"
help_if_asked "$@"
require_settings
require_tools tofu jq

stack_name="${1:-}"
case "$stack_name" in
  persistent | platform) ;;
  *) die "usage: tofu.sh <persistent|platform> <tofu args>" ;;
esac
shift
[ $# -ge 1 ] || die "usage: tofu.sh ${stack_name} <tofu args>"

stack_dir="$(tf_dir "$stack_name")"
# shellcheck disable=SC2153 # STATE_PREFIX is a constant from env.sh
state_prefix="${STATE_PREFIX}/${stack_name}"

if is_dry; then
  printf '    [dry-run] tofu -chdir=%s %s\n' "$stack_dir" "$*" >&2
  exit 0
fi

if [ "$stack_name" = "persistent" ]; then
  tfvars="$(jq -n --arg p "$PROJECT_ID" --arg r "$REGION" '{project_id:$p, region:$r}')"
else
  [ -n "$TEAM_CIDRS" ] || die "TEAM_CIDRS is empty (run scripts/gcp/up.sh, or set it in settings.env)"
  # Unquoted on purpose: TEAM_CIDRS is a space-separated list, one JSON string per word.
  # shellcheck disable=SC2086
  cidrs_json="$(printf '%s\n' $TEAM_CIDRS | jq -R . | jq -s .)"
  tfvars="$(jq -n --arg p "$PROJECT_ID" --arg r "$REGION" --arg d "$DOMAIN" --arg z "$DNS_ZONE" \
    --argjson c "$cidrs_json" \
    '{project_id:$p, region:$r, domain:$d, dns_zone:$z, team_cidrs:$c}')"
fi
printf '%s\n' "$tfvars" >"${stack_dir}/generated.auto.tfvars.json"

if [ "$1" = "init" ]; then
  shift
  exec tofu -chdir="$stack_dir" init -input=false \
    -backend-config="bucket=${STATE_BUCKET}" -backend-config="prefix=${state_prefix}" "$@"
fi
exec tofu -chdir="$stack_dir" "$@"
