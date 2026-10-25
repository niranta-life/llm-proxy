#!/usr/bin/env bash
# Step 2: OpenTofu for both stacks (persistent, then platform): init, validate, plan,
# show the plan, confirm, apply. A stack with no changes is skipped, so a re-run is fast.
# A plan that destroys or replaces anything needs a typed confirmation, even with --yes.
source "$(dirname "$0")/common.sh"
source "${GCP_SCRIPTS_DIR}/lib-plan.sh"
help_if_asked "$@"
require_settings

log "Step: infrastructure (OpenTofu)"
will "for each stack (persistent, then platform): tofu init (state in gs://${STATE_BUCKET})"
will "tofu validate, then tofu plan; print the plan and flag any destroy or replace"
will "ask for confirmation, then tofu apply the saved plan (skipped when there are no changes)"
stop_if_dry

apply_stack() {
  local stack="$1" dir plan text code
  dir="$(tf_dir "$stack")"
  plan="${dir}/plan.tfplan"
  text="${dir}/plan.txt"
  log "stack: ${stack}"
  "${GCP_SCRIPTS_DIR}/tofu.sh" "$stack" init >/dev/null
  "${GCP_SCRIPTS_DIR}/tofu.sh" "$stack" validate >/dev/null

  # tofu plan -detailed-exitcode: 0 = no changes, 1 = error, 2 = changes to apply.
  code=0
  "${GCP_SCRIPTS_DIR}/tofu.sh" "$stack" plan -input=false -detailed-exitcode -out "$plan" >"$text" 2>&1 || code=$?
  case "$code" in
    0)
      ok "${stack}: up to date, nothing to apply"
      return 0
      ;;
    2) ;;
    *)
      cat "$text" >&2
      die "tofu plan failed for stack ${stack}"
      ;;
  esac

  "${GCP_SCRIPTS_DIR}/tofu.sh" "$stack" show -no-color "$plan"
  # plan_destroys stops the script when the plan cannot be parsed; it never guesses "no destroy".
  if plan_destroys "$stack" "$plan"; then
    typed "destroy ${stack}" "THE PLAN ABOVE DESTROYS OR REPLACES RESOURCES. Read it before you answer."
  else
    confirm "Apply the ${stack} plan?"
  fi
  "${GCP_SCRIPTS_DIR}/tofu.sh" "$stack" apply -input=false "$plan"
  rm -f "$plan" "$text"
}

for stack in "${TF_STACKS[@]}"; do apply_stack "$stack"; done
