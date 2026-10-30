#!/usr/bin/env bash
# Call the real llm-proxy-docker.sh for usage, setup, and a rejected config.
# This check does not build an image and does not start Colima.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SCRIPT="${ROOT}/llm-proxy-docker.sh"
CONFIG="${ROOT}/config/docker.env"
WORK="${LLM_PROXY_DOCKER_CHECK_DIR:-$(mktemp -d)}"
mkdir -p "$WORK"

fail() {
  echo "$*" >&2
  exit 1
}

run_to() {
  local outfile="$1"
  shift
  set +e
  "$@" >"$outfile" 2>&1
  local code=$?
  set -e
  printf '%s' "$code"
}

assert_no_secret() {
  local outfile="$1" key="$2"
  if [[ -n "$key" ]] && grep -F -q -- "$key" "$outfile"; then
    fail "output printed the provider credential key"
  fi
  if grep -E -q 'sk-[A-Za-z0-9_-]+' "$outfile"; then
    fail "output printed a provider key"
  fi
  if grep -F -q 'starting colima' "$outfile"; then
    fail "output started Colima"
  fi
  if grep -F -q 'building the app image' "$outfile"; then
    fail "output built an image"
  fi
}

key_of() {
  awk -F= '/^PROVIDER_CREDENTIAL_KEY=/{print substr($0, index($0, "=") + 1); exit}' "$1"
}

inference_of() {
  awk -F= '/^INFERENCE_ENABLED=/{print substr($0, index($0, "=") + 1); exit}' "$1"
}

[[ -x "$SCRIPT" ]] || fail "llm-proxy-docker.sh is not executable"

usage_code="$(run_to "${WORK}/usage.txt" "$SCRIPT")"
[[ "$usage_code" == "1" ]] || fail "usage exit was ${usage_code}"
grep -F -q 'Usage: llm-proxy-docker.sh <build|setup|start|stop|status|watch>' "${WORK}/usage.txt" \
  || fail "usage text omitted a command"
assert_no_secret "${WORK}/usage.txt" ""

help_code="$(run_to "${WORK}/help.txt" "$SCRIPT" --help)"
[[ "$help_code" == "0" ]] || fail "help exit was ${help_code}"
assert_no_secret "${WORK}/help.txt" ""

backup=""
if [[ -f "$CONFIG" ]]; then
  backup="${WORK}/docker.env.backup"
  cp "$CONFIG" "$backup"
  chmod 600 "$backup"
fi
rm -f "$CONFIG"

setup1_code="$(run_to "${WORK}/setup1.txt" "$SCRIPT" setup)"
[[ "$setup1_code" == "0" ]] || fail "first setup exit was ${setup1_code}"
[[ -f "$CONFIG" ]] || fail "setup did not create ${CONFIG}"
[[ "$(inference_of "$CONFIG")" == "false" ]] || fail "setup turned inference on"
key1="$(key_of "$CONFIG")"
[[ -n "$key1" ]] || fail "setup did not store a provider credential key"
assert_no_secret "${WORK}/setup1.txt" "$key1"
grep -F -q 'Inference stays off.' "${WORK}/setup1.txt" || fail "setup did not say inference stays off"

setup2_code="$(run_to "${WORK}/setup2.txt" "$SCRIPT" setup)"
[[ "$setup2_code" == "0" ]] || fail "second setup exit was ${setup2_code}"
[[ "$(inference_of "$CONFIG")" == "false" ]] || fail "second setup changed inference"
key2="$(key_of "$CONFIG")"
[[ "$key1" == "$key2" ]] || fail "second setup changed the provider credential key"
assert_no_secret "${WORK}/setup2.txt" "$key2"
grep -F -q 'inference: false' "${WORK}/setup2.txt" || fail "second setup did not report inference false"

reject_file="${WORK}/reject.env"
printf 'INFERENCE_ENABLED=true\nPROVIDER_CREDENTIAL_KEY=\n' >"$reject_file"
reject_code="$(run_to "${WORK}/reject.txt" env LLM_PROXY_ENV_FILE="$reject_file" "$SCRIPT" start)"
[[ "$reject_code" != "0" ]] || fail "rejected config exited 0"
reject_text="$(grep -F 'PROVIDER_CREDENTIAL_KEY is required when INFERENCE_ENABLED is true' "${WORK}/reject.txt" || true)"
[[ -n "$reject_text" ]] || fail "rejected config did not name the missing key"
assert_no_secret "${WORK}/reject.txt" ""

printf 'INFERENCE_ENABLED=false\nPROVIDER_CREDENTIAL_KEY=abcd\n' >"$reject_file"
bad_key_code="$(run_to "${WORK}/bad-key.txt" env LLM_PROXY_ENV_FILE="$reject_file" "$SCRIPT" build)"
[[ "$bad_key_code" != "0" ]] || fail "short key exited 0"
grep -F -q 'PROVIDER_CREDENTIAL_KEY must be 32 bytes, base64-encoded' "${WORK}/bad-key.txt" \
  || fail "short key was accepted"
assert_no_secret "${WORK}/bad-key.txt" ""

printf 'INFERENCE_ENABLED=false\nMAX_ACTIVE_STREAMS=0\n' >"$reject_file"
bad_range_code="$(run_to "${WORK}/bad-range.txt" env LLM_PROXY_ENV_FILE="$reject_file" "$SCRIPT" start)"
[[ "$bad_range_code" != "0" ]] || fail "stream limit exited 0"
grep -F -q 'MAX_ACTIVE_STREAMS must be an integer from 1 to 10000' "${WORK}/bad-range.txt" \
  || fail "stream limit was accepted"
assert_no_secret "${WORK}/bad-range.txt" ""

# The substitution stays literal. The script must reject it.
# shellcheck disable=SC2016
printf 'INFERENCE_ENABLED=false\nOPENAI_BASE_URL=$(echo hi)\n' >"$reject_file"
bad_cmd_code="$(run_to "${WORK}/bad-cmd.txt" env LLM_PROXY_ENV_FILE="$reject_file" "$SCRIPT" start)"
[[ "$bad_cmd_code" != "0" ]] || fail "command value exited 0"
grep -F -q 'config value must be plain text: OPENAI_BASE_URL' "${WORK}/bad-cmd.txt" \
  || fail "command value was accepted"
assert_no_secret "${WORK}/bad-cmd.txt" ""

if [[ -n "$backup" ]]; then
  mv "$backup" "$CONFIG"
  chmod 600 "$CONFIG"
fi

echo "usage_exit:${usage_code}"
echo "help_exit:${help_code}"
echo "setup1_exit:${setup1_code}"
echo "setup2_exit:${setup2_code}"
echo "inference:false"
echo "inference_same:yes"
echo "key_same:yes"
echo "key_in_output:no"
echo "reject_exit:${reject_code}"
echo "reject_text:${reject_text}"
echo "bad_key_exit:${bad_key_code}"
echo "bad_key_text:PROVIDER_CREDENTIAL_KEY must be 32 bytes, base64-encoded"
echo "bad_range_exit:${bad_range_code}"
echo "bad_range_text:MAX_ACTIVE_STREAMS must be an integer from 1 to 10000"
echo "bad_cmd_exit:${bad_cmd_code}"
echo "bad_cmd_text:config value must be plain text: OPENAI_BASE_URL"
echo "starting_colima:no"
echo "building:no"
