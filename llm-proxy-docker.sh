#!/usr/bin/env bash
# Build and run the llm-proxy Compose project on Colima.
# setup writes config/docker.env. start rebuilds the app image when the source changes.
# watch rebuilds that image, or recreates the app when the config file changes.
# The database volume stays. Inference stays off until the config file sets it.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROFILE="${COLIMA_PROFILE:-default}"
SOCKET="${COLIMA_SOCKET:-${HOME}/.colima/${PROFILE}/docker.sock}"
ENV_EXAMPLE="${ROOT}/config/docker.env.example"
ENV_FILE="${LLM_PROXY_ENV_FILE:-${ROOT}/config/docker.env}"
STAMP="${ROOT}/config/.image-stamp"
READY_URL="${PROXY_BASE_URL:-http://127.0.0.1:8080}/health/ready"
WATCH_SECONDS="${LLM_PROXY_WATCH_SECONDS:-2}"
CONFIG_KEYS=(
  LOG_LEVEL
  INFERENCE_ENABLED
  OPENAI_BASE_URL
  PROVIDER_CREDENTIAL_KEY
  PROVIDER_CREDENTIAL_KEY_PREVIOUS
  MAX_ACTIVE_STREAMS
  MAX_STREAMS_PER_TENANT
  STREAM_SHUTDOWN_DRAIN_MS
  HTTP_KEEP_ALIVE_TIMEOUT_MS
  MIGRATION_LOCK_TIMEOUT_MS
  MIGRATION_STATEMENT_TIMEOUT_MS
)

usage() {
  cat <<'EOF'
Usage: llm-proxy-docker.sh <build|setup|start|stop|status|watch> [options]

  build               Build the app image on Colima.
  setup               Create config/docker.env when it is missing. Inference stays off.
  start [--build]     Start Colima when it is down, then start Compose.
                      Rebuild the app image when the program files changed or the image is missing.
  stop [--vm]         Stop Compose. Keep the database volume. --vm also stops Colima.
  status              Show Colima, the config file, and whether the image matches the program files.
                      Show the containers and the ready check when Colima is running.
  watch               Rebuild the app image when the program files change.
                      Recreate the app when the config file changes.

The script uses the Colima socket. The script does not change the Docker context.
Set COLIMA_PROFILE or COLIMA_SOCKET when yours differ.
Set LLM_PROXY_ENV_FILE only when that file already exists.
The script creates config/docker.env only when you do not set LLM_PROXY_ENV_FILE.
The image command stays node dist/index.js.
The image does not start the evaluation worker, the guardrail worker, or the promotion worker.
EOF
}

die() {
  echo "$*" >&2
  exit 1
}

require_tools() {
  if ! command -v colima >/dev/null 2>&1; then
    die "colima is not installed"
  fi
  if ! command -v docker >/dev/null 2>&1; then
    die "docker is not installed"
  fi
}

colima_running() {
  local output
  output="$(colima status -p "$PROFILE" 2>&1 || true)"
  [[ "$output" == *"colima is running"* ]]
}

ensure_colima() {
  require_tools
  if ! colima_running; then
    echo "starting colima profile ${PROFILE}"
    colima start -p "$PROFILE"
  fi
  if [[ ! -S "$SOCKET" ]]; then
    die "Colima socket is missing: ${SOCKET}"
  fi
  export DOCKER_HOST="unix://${SOCKET}"
}

compose() {
  local -a env_args=()
  if [[ "${1:-}" == "--no-env-file" ]]; then
    shift
  elif [[ -f "$ENV_FILE" ]]; then
    env_args=(--env-file "$ENV_FILE")
  fi
  docker compose "${env_args[@]}" --project-directory "$ROOT" -f "$ROOT/docker-compose.yml" "$@"
}

compose_project() {
  printf '%s' "${COMPOSE_PROJECT_NAME:-llm-proxy}"
}

app_image_name() {
  if [[ -n "${LLM_PROXY_IMAGE:-}" ]]; then
    printf '%s' "$LLM_PROXY_IMAGE"
    return 0
  fi
  printf '%s-app' "$(compose_project)"
}

wait_ready() {
  if ! command -v curl >/dev/null 2>&1; then
    die "curl is not installed"
  fi
  for _ in $(seq 1 45); do
    if curl -fsS "$READY_URL" >/dev/null 2>&1; then
      echo "ready ${READY_URL}"
      return 0
    fi
    sleep 2
  done
  echo "timed out waiting for ${READY_URL}" >&2
  return 1
}

source_hash() {
  (
    cd "$ROOT"
    find Dockerfile package.json package-lock.json tsconfig.json src migrations docker/postgres \
      -type f \
      ! -name '.DS_Store' \
      ! -name '*~' \
      ! -name '.#*' \
      -print0 \
      | sort -z \
      | xargs -0 shasum -a 256
  ) | shasum -a 256 | awk '{print $1}'
}

stamp_value() {
  if [[ -f "$STAMP" ]]; then
    tr -d '[:space:]' < "$STAMP"
  fi
}

env_hash() {
  if [[ -f "$ENV_FILE" ]]; then
    shasum -a 256 "$ENV_FILE" | awk '{print $1}'
  else
    printf 'missing'
  fi
}

app_image_id() {
  local id image project
  image="$(app_image_name)"
  project="$(compose_project)"
  # Compose names this service <project>-app when the file sets no image tag.
  # `compose images` only lists an image after a container exists.
  if docker image inspect "$image" >/dev/null 2>&1; then
    docker image inspect --format '{{.Id}}' "$image"
    return 0
  fi
  id="$(docker image ls -q \
    --filter "label=com.docker.compose.project=${project}" \
    --filter "label=com.docker.compose.service=app" \
    | head -n 1 || true)"
  if [[ -n "$id" ]]; then
    printf '%s\n' "$id"
    return 0
  fi
  return 1
}

assert_image_command() {
  local id cmd entry
  id="$(app_image_id)" || die "the app image is missing"
  cmd="$(docker image inspect --format '{{json .Config.Cmd}}' "$id")"
  entry="$(docker image inspect --format '{{json .Config.Entrypoint}}' "$id")"
  if [[ "$cmd" != '["node","dist/index.js"]' && "$cmd" != '["node", "dist/index.js"]' ]]; then
    echo "the image command is ${cmd}" >&2
    die "the image command must be node dist/index.js"
  fi
  case "$entry" in
    null|'["docker-entrypoint.sh"]'|'["/usr/local/bin/docker-entrypoint.sh"]')
      ;;
    *)
      echo "the image entrypoint is ${entry}" >&2
      die "the image entrypoint must stay the base image entrypoint"
      ;;
  esac
}

build_image() {
  local hash
  if [[ -f "$ENV_FILE" ]]; then
    validate_env_file
  fi
  ensure_colima
  echo "building the app image"
  compose build app || return 1
  assert_image_command || return 1
  hash="$(source_hash)"
  mkdir -p "$(dirname "$STAMP")"
  printf '%s\n' "$hash" > "$STAMP"
  echo "image command is node dist/index.js"
}

config_value() {
  local key="$1" line
  [[ -f "$ENV_FILE" ]] || return 1
  while IFS= read -r line || [[ -n "$line" ]]; do
    line="${line%$'\r'}"
    [[ "$line" == "$key="* ]] || continue
    strip_quotes "${line#"$key="}"
    return 0
  done < "$ENV_FILE"
  return 1
}

strip_quotes() {
  local value="$1"
  if [[ "$value" == \"*\" && "$value" == *\" ]]; then
    value="${value:1:${#value}-2}"
  elif [[ "$value" == \'*\' && "$value" == *\' ]]; then
    value="${value:1:${#value}-2}"
  fi
  printf '%s' "$value"
}

credential_is_32() {
  local text="$1" normalized len
  [[ "$text" =~ ^[A-Za-z0-9+/=_-]+$ ]] || return 1
  command -v openssl >/dev/null 2>&1 || return 1
  normalized="$(printf '%s' "$text" | tr '_-' '/+')"
  if ! printf '%s' "$normalized" | openssl base64 -d -A >/dev/null 2>&1; then
    return 1
  fi
  len="$(printf '%s' "$normalized" | openssl base64 -d -A 2>/dev/null | wc -c | tr -d '[:space:]')"
  [[ "$len" == "32" ]]
}

require_range() {
  local name="$1" value="$2" min="$3" max="$4"
  [[ -n "$value" ]] || return 0
  if [[ ! "$value" =~ ^[0-9]+$ ]] || (( 10#$value < min || 10#$value > max )); then
    die "${name} must be an integer from ${min} to ${max}"
  fi
}

require_credential() {
  local name="$1" text="$2" part
  local IFS=','
  local -a parts=()
  [[ -n "$text" ]] || return 0
  command -v openssl >/dev/null 2>&1 || die "openssl is required to check ${name}"
  if [[ "$name" == "PROVIDER_CREDENTIAL_KEY" ]]; then
    credential_is_32 "$text" || die "PROVIDER_CREDENTIAL_KEY must be 32 bytes, base64-encoded"
    return 0
  fi
  read -r -a parts <<< "$text"
  [[ ${#parts[@]} -gt 0 ]] || die "PROVIDER_CREDENTIAL_KEY_PREVIOUS must be 32-byte keys, base64-encoded, comma-separated"
  for part in "${parts[@]}"; do
    part="${part#"${part%%[![:space:]]*}"}"
    part="${part%"${part##*[![:space:]]}"}"
    [[ -n "$part" ]] || die "PROVIDER_CREDENTIAL_KEY_PREVIOUS must be 32-byte keys, base64-encoded, comma-separated"
    credential_is_32 "$part" || die "PROVIDER_CREDENTIAL_KEY_PREVIOUS must be 32-byte keys, base64-encoded, comma-separated"
  done
}

validate_env_file() {
  local line key value seen=" " inference_value="" credential_value=""
  [[ -f "$ENV_FILE" ]] || die "config file is missing: ${ENV_FILE}"
  while IFS= read -r line || [[ -n "$line" ]]; do
    line="${line%$'\r'}"
    [[ -z "$line" || "$line" =~ ^[[:space:]]*# ]] && continue
    [[ "$line" =~ ^[A-Z0-9_]+= ]] || die "config line is not KEY=VALUE"
    key="${line%%=*}"
    if [[ "$seen" == *" ${key} "* ]]; then
      die "config key is repeated: ${key}"
    fi
    seen+=" ${key} "
    value="$(strip_quotes "${line#*=}")"
    # Check the unquoted value so a command substitution is rejected.
    # shellcheck disable=SC2016
    if [[ "$value" == *'$('* || "$value" == *'`'* || "$value" == *'${'* ]]; then
      die "config value must be plain text: ${key}"
    fi
    case "$key" in
      LOG_LEVEL)
        [[ "$value" == "debug" || "$value" == "info" || "$value" == "warn" || "$value" == "error" ]] \
          || die "LOG_LEVEL must be debug, info, warn, or error"
        ;;
      INFERENCE_ENABLED)
        [[ "$value" == "true" || "$value" == "false" ]] || die "INFERENCE_ENABLED must be true or false"
        inference_value="$value"
        ;;
      OPENAI_BASE_URL)
        if [[ -n "$value" ]]; then
          [[ "$value" == http://* || "$value" == https://* ]] || die "OPENAI_BASE_URL must be an http or https URL"
          [[ "$value" != *"@"* ]] || die "OPENAI_BASE_URL must not include credentials"
        fi
        ;;
      PROVIDER_CREDENTIAL_KEY)
        require_credential "$key" "$value"
        credential_value="$value"
        ;;
      PROVIDER_CREDENTIAL_KEY_PREVIOUS)
        require_credential "$key" "$value"
        ;;
      MAX_ACTIVE_STREAMS|MAX_STREAMS_PER_TENANT)
        require_range "$key" "$value" 1 10000
        ;;
      STREAM_SHUTDOWN_DRAIN_MS)
        require_range "$key" "$value" 0 600000
        ;;
      HTTP_KEEP_ALIVE_TIMEOUT_MS|MIGRATION_LOCK_TIMEOUT_MS|MIGRATION_STATEMENT_TIMEOUT_MS)
        require_range "$key" "$value" 1000 3600000
        ;;
      DATABASE_HOST|DATABASE_PORT|DATABASE_NAME|MIGRATOR_USER|MIGRATOR_PASSWORD|AUTH_USER|AUTH_PASSWORD|RUNTIME_USER|RUNTIME_PASSWORD|HOST|PORT)
        die "Compose sets ${key}. Remove it from ${ENV_FILE}"
        ;;
      *)
        die "config key is not allowed: ${key}"
        ;;
    esac
  done < "$ENV_FILE"
  if [[ "$inference_value" == "true" && -z "$credential_value" ]]; then
    die "PROVIDER_CREDENTIAL_KEY is required when INFERENCE_ENABLED is true"
  fi
}

load_env_file() {
  local line key value name
  # Compose uses a shell variable before --env-file.
  # Clear every config key first so a removed line cannot stay exported.
  validate_env_file
  for name in "${CONFIG_KEYS[@]}"; do
    unset "$name"
  done
  while IFS= read -r line || [[ -n "$line" ]]; do
    line="${line%$'\r'}"
    [[ -z "$line" || "$line" =~ ^[[:space:]]*# ]] && continue
    key="${line%%=*}"
    value="$(strip_quotes "${line#*=}")"
    printf -v "$key" '%s' "$value"
    export "${key?}"
  done < "$ENV_FILE"
}

fill_provider_key() {
  local key tmp line
  if [[ ! -f "$ENV_FILE" ]]; then
    return 0
  fi
  if [[ -n "$(config_value PROVIDER_CREDENTIAL_KEY || true)" ]]; then
    return 0
  fi
  if ! command -v openssl >/dev/null 2>&1; then
    echo "openssl is not installed. PROVIDER_CREDENTIAL_KEY stays empty."
    return 0
  fi
  key="$(openssl rand -base64 32)"
  tmp="$(mktemp)"
  while IFS= read -r line || [[ -n "$line" ]]; do
    if [[ "$line" == "PROVIDER_CREDENTIAL_KEY=" ]]; then
      printf 'PROVIDER_CREDENTIAL_KEY=%s\n' "$key"
    else
      printf '%s\n' "$line"
    fi
  done < "$ENV_FILE" > "$tmp"
  mv "$tmp" "$ENV_FILE"
  chmod 600 "$ENV_FILE"
  echo "A provider credential key is stored in ${ENV_FILE}."
  echo "The proxy does not use it until INFERENCE_ENABLED is true."
}

ensure_config() {
  if [[ -f "$ENV_FILE" ]]; then
    chmod 600 "$ENV_FILE" 2>/dev/null || true
    return 0
  fi
  if [[ "$ENV_FILE" != "${ROOT}/config/docker.env" ]]; then
    die "config file is missing: ${ENV_FILE}"
  fi
  [[ -f "$ENV_EXAMPLE" ]] || die "config example is missing: ${ENV_EXAMPLE}"
  mkdir -p "$(dirname "$ENV_FILE")"
  cp "$ENV_EXAMPLE" "$ENV_FILE"
  chmod 600 "$ENV_FILE"
  echo "Created ${ENV_FILE}."
  echo "Inference stays off."
  fill_provider_key
}

image_state() {
  local hash stamp
  hash="$(source_hash)"
  stamp="$(stamp_value)"
  if [[ -z "$stamp" ]]; then
    printf 'not built'
    return 0
  fi
  if [[ "$hash" != "$stamp" ]]; then
    printf 'stale'
    return 0
  fi
  if ! colima_running || [[ ! -S "$SOCKET" ]]; then
    printf 'not checked'
    return 0
  fi
  export DOCKER_HOST="unix://${SOCKET}"
  if ! image_exists; then
    printf 'missing'
    return 0
  fi
  printf 'current'
}

image_exists() {
  app_image_id >/dev/null 2>&1
}

recreate_app() {
  compose up -d --wait postgres
  compose up -d --wait --no-deps --force-recreate app
  wait_ready
}

cmd_build() {
  build_image
}

cmd_setup() {
  if [[ -f "$ENV_FILE" ]]; then
    validate_env_file
    echo "Config file already exists: ${ENV_FILE}"
    echo "inference: $(config_value INFERENCE_ENABLED || echo missing)"
    return 0
  fi
  ensure_config
  validate_env_file
  echo "Edit ${ENV_FILE}, then run ./llm-proxy-docker.sh start."
}

cmd_start() {
  local rebuilt=0
  ensure_config
  load_env_file
  ensure_colima
  if [[ "${1:-0}" -eq 1 || "$(source_hash)" != "$(stamp_value)" ]] || ! image_exists; then
    build_image
    rebuilt=1
  fi
  echo "starting the llm-proxy Compose project"
  if [[ "$rebuilt" -eq 1 ]]; then
    recreate_app
  else
    compose up -d --wait postgres
    compose up -d --wait --no-deps app
    wait_ready
  fi
}

cmd_stop() {
  local stop_vm="${1:-0}"
  require_tools
  if colima_running && [[ -S "$SOCKET" ]]; then
    export DOCKER_HOST="unix://${SOCKET}"
    echo "stopping the llm-proxy Compose project"
    compose --no-env-file stop
  else
    echo "Colima is not running. The Compose project is already stopped."
  fi
  if [[ "$stop_vm" -eq 1 ]]; then
    echo "stopping colima profile ${PROFILE}"
    colima stop -p "$PROFILE"
  fi
}

cmd_status() {
  local inference="missing"
  require_tools
  colima status -p "$PROFILE" || true
  if [[ -S "$SOCKET" ]]; then
    echo "socket: ${SOCKET}"
  else
    echo "socket: missing ${SOCKET}"
  fi
  if [[ -f "$ENV_FILE" ]]; then
    echo "config: ${ENV_FILE}"
    inference="$(config_value INFERENCE_ENABLED || echo missing)"
    echo "inference: ${inference}"
  else
    echo "config: missing"
    echo "Run ./llm-proxy-docker.sh setup"
  fi
  echo "image: $(image_state)"
  if colima_running && [[ -S "$SOCKET" ]]; then
    export DOCKER_HOST="unix://${SOCKET}"
    compose --no-env-file ps || true
    if command -v curl >/dev/null 2>&1; then
      if curl -fsS "$READY_URL" >/dev/null 2>&1; then
        echo "ready ${READY_URL}"
      else
        echo "not ready ${READY_URL}"
      fi
    else
      echo "curl is not installed"
    fi
  fi
}

cmd_watch() {
  local src envh new_src new_env
  cmd_start 0
  src="$(source_hash)"
  envh="$(env_hash)"
  echo "watching for source and config changes"
  trap 'echo "watch stopped"; exit 0' INT TERM
  while true; do
    sleep "$WATCH_SECONDS"
    new_src="$(source_hash)"
    new_env="$(env_hash)"
    if [[ "$new_src" != "$src" ]]; then
      echo "source changed"
      if build_image; then
        load_env_file
        recreate_app
        src="$new_src"
        envh="$(env_hash)"
      else
        echo "build failed" >&2
      fi
    elif [[ "$new_env" != "$envh" ]]; then
      echo "configuration changed"
      load_env_file
      recreate_app
      envh="$new_env"
    fi
  done
}

main() {
  local command_name="${1:-}"
  local has_build=0
  local has_vm=0
  local arg
  [[ "$WATCH_SECONDS" =~ ^[1-9][0-9]*$ ]] || die "LLM_PROXY_WATCH_SECONDS must be a positive integer"
  if [[ $# -gt 0 ]]; then
    shift
  fi
  for arg in "$@"; do
    case "$arg" in
      --build) has_build=1 ;;
      --vm) has_vm=1 ;;
      -h|--help) usage; exit 0 ;;
      *) usage; exit 1 ;;
    esac
  done
  case "$command_name" in
    build)
      [[ "$has_build" -eq 0 && "$has_vm" -eq 0 ]] || die "build does not take options"
      cmd_build
      ;;
    setup)
      [[ "$has_build" -eq 0 && "$has_vm" -eq 0 ]] || die "setup does not take options"
      cmd_setup
      ;;
    start)
      [[ "$has_vm" -eq 0 ]] || die "start does not take --vm"
      cmd_start "$has_build"
      ;;
    stop)
      [[ "$has_build" -eq 0 ]] || die "stop does not take --build"
      cmd_stop "$has_vm"
      ;;
    status)
      [[ "$has_build" -eq 0 && "$has_vm" -eq 0 ]] || die "status does not take options"
      cmd_status
      ;;
    watch)
      [[ "$has_build" -eq 0 && "$has_vm" -eq 0 ]] || die "watch does not take options"
      cmd_watch
      ;;
    -h|--help)
      usage
      ;;
    *)
      usage
      exit 1
      ;;
  esac
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  main "$@"
fi
