#!/usr/bin/env bash
# shellcheck disable=SC2181,SC2030,SC2031 # each test runs in its own subshell on purpose
# Tests for scripts/gcp with stand-in gcloud, kubectl, helm and tofu (see stub.sh).
# Nothing here reaches a network, a cluster or a cloud project.
# Usage: scripts/gcp/tests/run.sh
set -u
case "${1:-}" in -h | --help) sed -n '3,5p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;; esac
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
GCP="$(cd "${HERE}/.." && pwd)"
PASSED=0
FAILED=0

# new_env: a fresh temp dir T with stubs first on PATH and a quiet settings environment.
new_env() {
  T="$(mktemp -d)"
  export T
  mkdir -p "${T}/bin" "${T}/sm"
  for tool in gcloud kubectl helm tofu; do ln -s "${HERE}/stub.sh" "${T}/bin/${tool}"; done
  : >"${T}/calls.log"
  export PATH="${T}/bin:${PATH}"
  export GCP_SETTINGS_FILE="${T}/settings.env"
  export PROJECT_ID="demo-llm-test" DOMAIN="llm.example.com" YES=1
  export LLM_KUBECONFIG="${T}/kubeconfig"
  unset STUB_CLUSTER STUB_API STUB_SM_ADD_FAIL STUB_WAIT_FAIL DRY_RUN OPENAI_API_KEY_FILE
}

check() { # check "name" condition-exit-status
  if [ "$2" -eq 0 ]; then PASSED=$((PASSED + 1)); printf '  ok   %s\n' "$1"; else FAILED=$((FAILED + 1)); printf '  FAIL %s\n' "$1"; fi
}
contains() { grep -q -- "$2" <<<"$1"; }

# run_script SCRIPT [args]: sets OUT (stdout+stderr) and RC.
run_script() {
  local s="$1"
  shift
  OUT="$("${GCP}/${s}" "$@" 2>&1 </dev/null)"
  RC=$?
}

echo "reload_settings"
(
  new_env
  # shellcheck disable=SC1091
  out="$(bash -c "source '${GCP}/common.sh'; write_setting REGION europe-west1; reload_settings; reload_settings; echo \"\$REGION \$PROJECT_ID\"" 2>&1)"
  rc=$?
  [ $rc -eq 0 ] && [ "$out" = "europe-west1 demo-llm-test" ]
) ; check "reload twice keeps the file value and the explicit env value, no readonly error" $?

echo "validate_settings"
for case_ in "MIN_REPLICAS=3 MAX_REPLICAS=2" "MIN_REPLICAS=2 PDB_MIN_AVAILABLE=2" "AUTOSCALER=foo" "PG_INSTANCES=0" "MIN_REPLICAS=0" "TEAM_CIDRS=300.1.1.1/32"; do
  (
    new_env
    # shellcheck disable=SC2086
    env $case_ bash -c "source '${GCP}/common.sh'; require_settings" >/dev/null 2>&1
    [ $? -ne 0 ]
  ) ; check "rejects ${case_}" $?
done
(
  new_env
  MIN_REPLICAS=2 MAX_REPLICAS=4 PDB_MIN_AVAILABLE=1 TEAM_CIDRS="203.0.113.7/32 2001:db8::/32" \
    bash -c "source '${GCP}/common.sh'; require_settings" >/dev/null 2>&1
) ; check "accepts a valid configuration" $?

echo "tofu.sh dry run"
(
  new_env
  DRY_RUN=1 TEAM_CIDRS="203.0.113.7/32" "${GCP}/tofu.sh" platform plan >/dev/null 2>&1
  [ $? -eq 0 ] && [ ! -e "${GCP}/../../deploy/gcp/tofu/platform/generated.auto.tfvars.json" ] && ! grep -q '^tofu' "${T}/calls.log"
) ; check "writes no tfvars file and runs no tofu" $?

echo "providers.sh: obtain_key failure propagates"
(
  new_env
  printf '%s' '{"tenantId":"11111111-1111-1111-1111-111111111111","keyId":"k","secret":"s"}' >"${T}/sm/llm-tenant-default"
  printf '%s' '{"data":{"limits":"done"}}' >"${T}/setup.json"
  printf '%s' '{"streamingEnabled":true,"connections":[],"deployments":[],"aliases":[]}' >"${T}/listing.json"
  printf '%s' 'sk-test-KEYMARKER123' >"${T}/openai.key"
  export OPENAI_API_KEY_FILE="${T}/openai.key" STUB_SM_ADD_FAIL=1
  OUT="$("${GCP}/providers.sh" 2>&1 </dev/null)"
  rc=$?
  [ $rc -ne 0 ] && contains "$OUT" "cannot get the OpenAI API key" && ! contains "$OUT" "KEYMARKER123" \
    && ! grep -q "KEYMARKER123" "${T}/calls.log"
) ; check "fails when Secret Manager rejects the key; key never printed or in argv" $?

echo "operators.sh: helm release status"
helm_case() { # name, cert-manager JSON, cnpg JSON, expect(upgrade|skip|die)
  (
    new_env
    printf '%s' '{"data":{"barman-plugin":"v0.15.1"}}' >"${T}/setup.json"
    printf '%s' "$2" >"${T}/helm_cert-manager.json"
    printf '%s' "$3" >"${T}/helm_cnpg.json"
    OUT="$("${GCP}/operators.sh" 2>&1 </dev/null)"
    rc=$?
    upgrades="$(grep -c '^helm upgrade' "${T}/calls.log" || true)"
    case "$4" in
      skip) [ $rc -eq 0 ] && [ "$upgrades" -eq 0 ] ;;
      upgrade) [ $rc -eq 0 ] && [ "$upgrades" -ge 1 ] ;;
      die) [ $rc -ne 0 ] && [ "$upgrades" -eq 0 ] && contains "$OUT" "helm uninstall" ;;
    esac
  ) ; check "$1" $?
}
CM_OK='[{"name":"cert-manager","status":"deployed","chart":"cert-manager-v1.21.2"}]'
CN_OK='[{"name":"cnpg","status":"deployed","chart":"cloudnative-pg-0.29.1"}]'
helm_case "deployed, right version, Available: skipped" "$CM_OK" "$CN_OK" skip
helm_case "deployed but wrong chart version: upgraded" '[{"name":"cert-manager","status":"deployed","chart":"cert-manager-v1.0.0"}]' "$CN_OK" upgrade
helm_case "failed release: upgraded" '[{"name":"cert-manager","status":"failed","chart":"cert-manager-v1.21.2"}]' "$CN_OK" upgrade
helm_case "pending-upgrade: stops with uninstall instructions" '[{"name":"cert-manager","status":"pending-upgrade","chart":"cert-manager-v1.21.2"}]' "$CN_OK" die
(
  new_env
  printf '%s' '{"data":{"barman-plugin":"v0.15.1"}}' >"${T}/setup.json"
  printf '%s' "$CM_OK" >"${T}/helm_cert-manager.json"
  printf '%s' "$CN_OK" >"${T}/helm_cnpg.json"
  STUB_WAIT_FAIL=1 "${GCP}/operators.sh" >/dev/null 2>&1
  [ "$(grep -c '^helm upgrade' "${T}/calls.log")" -ge 1 ]
) ; check "deployed at the right version but not Available: upgraded" $?

echo "down.sh: preflight"
(
  new_env
  STUB_API=unreachable run_script down.sh
  [ $RC -ne 0 ] && contains "$OUT" "cannot reach the Kubernetes API" && ! grep -qE 'delete|^tofu' "${T}/calls.log"
) ; check "aborts, deleting nothing, when the Kubernetes API is unreachable" $?
(
  new_env
  STUB_CLUSTER=denied run_script down.sh
  [ $RC -ne 0 ] && contains "$OUT" "cannot describe cluster" && ! grep -qE 'delete|^tofu' "${T}/calls.log"
) ; check "aborts when the cluster cannot be described (not 'not found')" $?
(
  new_env
  STUB_API=ok run_script down.sh
  # Preflight passes; the typed confirmation then refuses to run without a terminal.
  [ $RC -ne 0 ] && contains "$OUT" "needs a terminal" && ! grep -qE 'delete|^tofu' "${T}/calls.log"
) ; check "typed confirmation is required even with YES=1" $?

echo "secrets.sh: secrets stay off the command line"
(
  new_env
  for n in llm-migrator-password llm-auth-password llm-runtime-password llm-pg-superuser-password; do
    printf '%s' "PWMARKER${n//-/}" >"${T}/sm/${n}"
  done
  printf '%s' "KEYMARKERabc123=" >"${T}/sm/llm-provider-credential-key"
  run_script secrets.sh
  b64v="$(printf '%s' "PWMARKERllmmigratorpassword" | base64 | tr -d '\n')"
  [ $RC -eq 0 ] && ! grep -q "MARKER" "${T}/calls.log" && grep -q "$b64v" "${T}/stdin_kubectl_apply.log" \
    && ! grep -q 'stringData' "${T}/stdin_kubectl_apply.log" \
    && ! grep -q -- "--from-literal" "${T}/calls.log" && ! contains "$OUT" "MARKER"
  # re-run: same input, same bytes (server-side apply is idempotent on identical data)
  cp "${T}/stdin_kubectl_apply.log" "${T}/first.log"; : >"${T}/stdin_kubectl_apply.log"
  run_script secrets.sh
  [ $RC -eq 0 ] && cmp -s "${T}/first.log" "${T}/stdin_kubectl_apply.log"
) ; check "values reach kubectl on stdin as base64 data only; re-run sends identical bytes" $?

# shellcheck source=cases-recovery.sh
source "${HERE}/cases-recovery.sh"

echo
printf '%s passed, %s failed\n' "$PASSED" "$FAILED"
[ "$FAILED" -eq 0 ]
