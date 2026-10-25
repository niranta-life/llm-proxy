#!/usr/bin/env bash
# Reading a saved OpenTofu plan. Source after common.sh; do not run it.
# shellcheck shell=bash
#
# Every function here fails closed: if `tofu show -json` fails, or its output is not the
# JSON we expect, the script stops. Only an explicit parsed "true" or "false" is acted on.

# plan_json STACK PLANFILE: the plan as JSON on stdout; dies when it cannot be read or parsed.
plan_json() {
  local json
  json="$("${GCP_SCRIPTS_DIR}/tofu.sh" "$1" show -json "$2")" || die "cannot read the saved plan with 'tofu show -json'; not applying anything"
  printf '%s' "$json" | jq -e '(.resource_changes | type) == "array"' >/dev/null 2>&1 \
    || die "the plan JSON has no resource_changes list (unexpected tofu output); not applying anything"
  printf '%s' "$json"
}

# plan_bool JSON JQ_BOOLEAN_EXPRESSION: prints "true" or "false"; dies on anything else.
plan_bool() {
  local result
  result="$(printf '%s' "$1" | jq -r "$2")" || die "cannot evaluate the plan; not applying anything"
  case "$result" in
    true | false) printf '%s' "$result" ;;
    *) die "plan check returned '${result}', not true or false; not applying anything" ;;
  esac
}

# plan_destroys STACK PLANFILE: returns 0 when the plan deletes or replaces anything, 1 when
# it does not; dies when that cannot be decided.
plan_destroys() {
  local json answer
  json="$(plan_json "$1" "$2")" || exit 1
  answer="$(plan_bool "$json" '[.resource_changes[] | select(.change.actions | index("delete"))] | length > 0')" || exit 1
  [ "$answer" = true ]
}

# plan_only_updates STACK PLANFILE: returns 0 when every change in the plan is an in-place
# update (or a no-op or a read); 1 when anything would be created, deleted or replaced.
plan_only_updates() {
  local json answer
  json="$(plan_json "$1" "$2")" || exit 1
  answer="$(plan_bool "$json" '[.resource_changes[] | select((.change.actions - ["no-op", "update", "read"]) | length > 0)] | length == 0')" || exit 1
  [ "$answer" = true ]
}

# plan_has_changes STACK PLANFILE: returns 0 when the plan changes anything.
plan_has_changes() {
  local json answer
  json="$(plan_json "$1" "$2")" || exit 1
  answer="$(plan_bool "$json" '[.resource_changes[] | select((.change.actions - ["no-op", "read"]) | length > 0)] | length > 0')" || exit 1
  [ "$answer" = true ]
}
