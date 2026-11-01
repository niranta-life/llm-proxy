#!/usr/bin/env bash
# Call the real llm-proxy-docker.sh for usage, setup, and a rejected config.
# This check does not build an image and does not start Colima.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SCRIPT="${ROOT}/llm-proxy-docker.sh"
CONFIG="${ROOT}/config/docker.env"
KEYS="${ROOT}/config/provider-keys.env"
WORK="${LLM_PROXY_DOCKER_CHECK_DIR:-$(mktemp -d)}"
mkdir -p "$WORK"
chmod 700 "$WORK"

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
  local outfile="$1" key="$2" line
  if [[ -n "$key" ]]; then
    # Compare inside this shell. Do not pass the key to another process.
    while IFS= read -r line || [[ -n "$line" ]]; do
      if [[ "$line" == *"$key"* ]]; then
        fail "output printed the provider credential key"
      fi
    done < "$outfile"
  fi
  if grep -E -q 'sk-[A-Za-z0-9_-]+|yck_[A-Za-z0-9_-]+' "$outfile"; then
    fail "output printed a provider key"
  fi
  if grep -F -q 'starting colima' "$outfile"; then
    fail "output started Colima"
  fi
  if grep -F -q 'building the app image' "$outfile"; then
    fail "output built an image"
  fi
  if grep -F -q 'starting the llm-proxy Compose project' "$outfile"; then
    fail "output started Compose"
  fi
}

key_of() {
  awk -F= '/^PROVIDER_CREDENTIAL_KEY=/{print substr($0, index($0, "=") + 1); exit}' "$1"
}

inference_of() {
  awk -F= '/^INFERENCE_ENABLED=/{print substr($0, index($0, "=") + 1); exit}' "$1"
}

[[ -x "$SCRIPT" ]] || fail "llm-proxy-docker.sh is not executable"
# The pattern stays literal. It looks for a secret passed to grep.
# shellcheck disable=SC2016
if grep -n -E 'grep.*( -e | -- )"\$(secret|key)\b' "$SCRIPT" "${BASH_SOURCE[0]}"; then
  fail "a secret is passed to grep"
fi

usage_code="$(run_to "${WORK}/usage.txt" "$SCRIPT")"
[[ "$usage_code" == "1" ]] || fail "usage exit was ${usage_code}"
grep -F -q 'Usage: llm-proxy-docker.sh <build|setup|start|stop|status|watch|keys>' "${WORK}/usage.txt" \
  || fail "usage text omitted a command"
assert_no_secret "${WORK}/usage.txt" ""

help_code="$(run_to "${WORK}/help.txt" "$SCRIPT" --help)"
[[ "$help_code" == "0" ]] || fail "help exit was ${help_code}"
assert_no_secret "${WORK}/help.txt" ""

mode_of() {
  stat -f '%OLp' "$1" 2>/dev/null || stat -c '%a' "$1"
}

restore_configs() {
  if [[ -n "${backup:-}" && -f "$backup" ]]; then
    mv "$backup" "$CONFIG"
    chmod 600 "$CONFIG"
    backup=""
  fi
  if [[ -n "${keys_backup:-}" && -e "$keys_backup" ]]; then
    rm -f "$KEYS"
    mv "$keys_backup" "$KEYS"
    if [[ "${keys_was_link:-0}" -eq 0 && -f "$KEYS" ]]; then
      chmod 600 "$KEYS"
    fi
    keys_backup=""
  fi
}
trap restore_configs EXIT

backup=""
keys_backup=""
keys_was_link=0
if [[ -f "$CONFIG" ]]; then
  backup="${WORK}/docker.env.backup"
  cp "$CONFIG" "$backup"
  chmod 600 "$backup"
fi
if [[ -L "$KEYS" ]]; then
  keys_was_link=1
  keys_backup="${WORK}/keys.backup"
  cp -P "$KEYS" "$keys_backup"
elif [[ -f "$KEYS" ]]; then
  keys_backup="${WORK}/keys.backup"
  cp "$KEYS" "$keys_backup"
  chmod 600 "$keys_backup"
fi
rm -f "$CONFIG" "$KEYS"

setup1_code="$(run_to "${WORK}/setup1.txt" "$SCRIPT" setup)"
[[ "$setup1_code" == "0" ]] || fail "first setup exit was ${setup1_code}"
[[ -f "$CONFIG" ]] || fail "setup did not create ${CONFIG}"
[[ "$(inference_of "$CONFIG")" == "false" ]] || fail "setup turned inference on"
key1="$(key_of "$CONFIG")"
[[ -n "$key1" ]] || fail "setup did not store a provider credential key"
assert_no_secret "${WORK}/setup1.txt" "$key1"
grep -F -q 'Inference stays off.' "${WORK}/setup1.txt" || fail "setup did not say inference stays off"
[[ -f "$KEYS" ]] || fail "setup did not create the provider keys file"
[[ ! -L "$KEYS" ]] || fail "provider keys file is a symlink"
[[ "$(mode_of "$KEYS")" == "600" ]] || fail "provider keys file mode was not 600"
grep -F -q 'No provider key is stored in that file.' "${WORK}/setup1.txt" \
  || fail "setup did not say the provider keys file is empty"
if grep -E -q 'sk-[A-Za-z0-9_-]+' "$KEYS"; then
  fail "provider keys file stored a provider key"
fi
keys_hash="$(shasum -a 256 "$KEYS" | awk '{print $1}')"

setup2_code="$(run_to "${WORK}/setup2.txt" "$SCRIPT" setup)"
[[ "$setup2_code" == "0" ]] || fail "second setup exit was ${setup2_code}"
[[ "$(inference_of "$CONFIG")" == "false" ]] || fail "second setup changed inference"
key2="$(key_of "$CONFIG")"
[[ "$key1" == "$key2" ]] || fail "second setup changed the provider credential key"
assert_no_secret "${WORK}/setup2.txt" "$key2"
grep -F -q 'inference: false' "${WORK}/setup2.txt" || fail "second setup did not report inference false"
[[ "$(shasum -a 256 "$KEYS" | awk '{print $1}')" == "$keys_hash" ]] \
  || fail "second setup changed the provider keys file"

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

empty_keys="${WORK}/empty-keys.env"
cp "${ROOT}/config/provider-keys.env.example" "$empty_keys"
chmod 600 "$empty_keys"
inference_before="$(inference_of "$CONFIG")"
empty_code="$(run_to "${WORK}/empty-keys.txt" env LLM_PROXY_KEYS_FILE="$empty_keys" "$SCRIPT" keys)"
[[ "$empty_code" == "0" ]] || fail "empty keys exit was ${empty_code}"
grep -F -q 'No provider keys are set. Inference is unchanged.' "${WORK}/empty-keys.txt" \
  || fail "empty keys did not say inference is unchanged"
assert_no_secret "${WORK}/empty-keys.txt" ""
[[ "$(inference_of "$CONFIG")" == "$inference_before" ]] || fail "empty keys changed inference"

loose_keys="${WORK}/loose-keys.env"
printf 'OPENAI_API_KEY=sk-check-fake-key-value\n' >"$loose_keys"
chmod 644 "$loose_keys"
loose_code="$(run_to "${WORK}/loose-keys.txt" env LLM_PROXY_KEYS_FILE="$loose_keys" "$SCRIPT" keys)"
[[ "$loose_code" != "0" ]] || fail "world-readable keys exited 0"
grep -F -q 'provider keys file must be mode 600 or 400' "${WORK}/loose-keys.txt" \
  || fail "world-readable keys were accepted"
assert_no_secret "${WORK}/loose-keys.txt" ""

link_target="${WORK}/link-target.env"
cp "$empty_keys" "$link_target"
chmod 600 "$link_target"
link_keys="${WORK}/link-keys.env"
ln -s "$link_target" "$link_keys"
link_code="$(run_to "${WORK}/link-keys.txt" env LLM_PROXY_KEYS_FILE="$link_keys" "$SCRIPT" keys)"
[[ "$link_code" != "0" ]] || fail "symlink keys exited 0"
grep -F -q 'provider keys file must not be a symlink' "${WORK}/link-keys.txt" \
  || fail "symlink keys were accepted"
assert_no_secret "${WORK}/link-keys.txt" ""

bad_keys="${WORK}/bad-keys.env"
# The substitution stays literal. The script must reject it.
# shellcheck disable=SC2016
printf 'OPENAI_API_KEY=$(echo sk-check-fake-key-value)\n' >"$bad_keys"
chmod 600 "$bad_keys"
bad_keys_code="$(run_to "${WORK}/bad-keys.txt" env LLM_PROXY_KEYS_FILE="$bad_keys" "$SCRIPT" keys)"
[[ "$bad_keys_code" != "0" ]] || fail "command key exited 0"
grep -F -q 'config value must be plain text: OPENAI_API_KEY' "${WORK}/bad-keys.txt" \
  || fail "command key was accepted"
assert_no_secret "${WORK}/bad-keys.txt" ""

unknown_keys="${WORK}/unknown-keys.env"
printf 'NOT_A_KEY=value\n' >"$unknown_keys"
chmod 600 "$unknown_keys"
unknown_code="$(run_to "${WORK}/unknown-keys.txt" env LLM_PROXY_KEYS_FILE="$unknown_keys" "$SCRIPT" keys)"
[[ "$unknown_code" != "0" ]] || fail "unknown key exited 0"
grep -F -q 'config key is not allowed: NOT_A_KEY' "${WORK}/unknown-keys.txt" \
  || fail "unknown key was accepted"
assert_no_secret "${WORK}/unknown-keys.txt" ""

[[ "$(inference_of "$CONFIG")" == "$inference_before" ]] || fail "rejected keys changed inference"

restore_configs

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
echo "keys_mode:600"
echo "empty_keys_exit:${empty_code}"
echo "loose_keys_exit:${loose_code}"
echo "link_keys_exit:${link_code}"
echo "bad_keys_exit:${bad_keys_code}"
echo "unknown_keys_exit:${unknown_code}"
echo "starting_colima:no"
echo "building:no"
