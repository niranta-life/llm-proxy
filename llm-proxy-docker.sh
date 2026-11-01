#!/usr/bin/env bash
# Build and run the llm-proxy Compose project on Colima.
# setup writes config/docker.env. start rebuilds the app image when the source changes.
# watch rebuilds that image, or recreates the app when the config file changes.
# The database volume stays. Inference stays off until keys turns it on for a set provider key.
# Provider API keys stay in config/provider-keys.env. The script does not print them.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROFILE="${COLIMA_PROFILE:-default}"
SOCKET="${COLIMA_SOCKET:-${HOME}/.colima/${PROFILE}/docker.sock}"
ENV_EXAMPLE="${ROOT}/config/docker.env.example"
ENV_FILE="${LLM_PROXY_ENV_FILE:-${ROOT}/config/docker.env}"
KEYS_EXAMPLE="${ROOT}/config/provider-keys.env.example"
KEYS_FILE="${LLM_PROXY_KEYS_FILE:-${ROOT}/config/provider-keys.env}"
TENANT_FILE="${ROOT}/config/local-tenant.json"
STAMP="${ROOT}/config/.image-stamp"
INGRESS_DIR="${ROOT}/config/ingress"
INGRESS_LIVE="${INGRESS_DIR}/live"
INGRESS_CA="${INGRESS_CA_FILE:-${INGRESS_LIVE}/ca.crt}"
READY_URL="${PROXY_BASE_URL:-https://127.0.0.1}/health/ready"
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
  RATE_LIMIT_STORE
  REDIS_SHADOW_CHECKS
  REDIS_URL
  REDIS_USERNAME
  REDIS_PASSWORD
  REDIS_TLS
  REDIS_TLS_CA_FILE
  REDIS_TLS_CERT_FILE
  REDIS_TLS_KEY_FILE
  REDIS_CONNECT_TIMEOUT_MS
  REDIS_RECONNECT_TIMEOUT_MS
  REDIS_BREAKER_COOLDOWN_MS
)

usage() {
  cat <<'EOF'
Usage: llm-proxy-docker.sh <build|setup|start|stop|status|watch|keys> [options]

  build               Build the app image on Colima.
  setup               Create config/docker.env when it is missing. Inference stays off.
                      Create config/provider-keys.env when it is missing. Store no provider key there.
  start [--build]     Start Colima when it is down, then start Compose.
                      Rebuild the app image when the program files changed or the image is missing.
  stop [--vm]         Stop Compose. Keep the database volume. --vm also stops Colima.
  status              Show Colima, the config file, and whether the image matches the program files.
                      Show the containers and the ready check when Colima is running.
  watch               Rebuild the app image when the program files change.
                      Recreate the app when the config file changes.
  keys                Read config/provider-keys.env. Do not print a provider key.
                      Turn inference on only when a provider key is set.
                      An empty file does not change inference and does not start Colima.
                      Register an enabled deployment for each provider that has a key.
                      Leave selection off. Leave automatic promotion off.

The script uses the Colima socket. The script does not change the Docker context.
Set COLIMA_PROFILE or COLIMA_SOCKET when yours differ.
Set LLM_PROXY_ENV_FILE only when that file already exists.
The script creates config/docker.env only when you do not set LLM_PROXY_ENV_FILE.
Set LLM_PROXY_KEYS_FILE only when that file already exists.
The image command stays node dist/index.js.
The image does not start the evaluation worker, the guardrail worker, or the promotion worker.
Nginx publishes port 443. The Node.js port stays private.
The host ready check uses HTTPS and the ingress CA file.
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

ready_curl() {
  curl -fsS --cacert "$INGRESS_CA" --max-time 10 "$READY_URL"
}

wait_ready() {
  if ! command -v curl >/dev/null 2>&1; then
    die "curl is not installed"
  fi
  if [[ ! -f "$INGRESS_CA" ]]; then
    die "ingress CA is missing. Run ./llm-proxy-docker.sh setup"
  fi
  for _ in $(seq 1 45); do
    if ready_curl >/dev/null 2>&1; then
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
  compose build ingress || return 1
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
      RATE_LIMIT_STORE)
        [[ "$value" == "postgres" || "$value" == "redis_shadow" || "$value" == "redis_active" ]] || die "RATE_LIMIT_STORE must be postgres, redis_shadow, or redis_active"
        ;;
      REDIS_SHADOW_CHECKS)
        [[ -z "$value" || "$value" == "true" || "$value" == "false" ]] || die "REDIS_SHADOW_CHECKS must be true or false"
        ;;
      REDIS_URL)
        if [[ -n "$value" ]]; then
          [[ "$value" == redis://* || "$value" == rediss://* ]] || die "REDIS_URL must be a redis or rediss URL"
          [[ "$value" != *"@"* ]] || die "REDIS_URL must not include credentials"
        fi
        ;;
      REDIS_USERNAME)
        if [[ -n "$value" ]]; then
          [[ "$value" != "default" && "$value" =~ ^[A-Za-z][A-Za-z0-9._-]{0,63}$ ]] || die "REDIS_USERNAME must be an ACL user"
        fi
        ;;
      REDIS_PASSWORD)
        if [[ -n "$value" ]]; then
          [[ ${#value} -ge 8 && ${#value} -le 256 && "$value" != *[[:space:]]* ]] || die "REDIS_PASSWORD must be 8 to 256 characters"
        fi
        ;;
      REDIS_TLS)
        [[ -z "$value" || "$value" == "true" || "$value" == "false" ]] || die "REDIS_TLS must be true or false"
        ;;
      REDIS_TLS_CA_FILE|REDIS_TLS_CERT_FILE|REDIS_TLS_KEY_FILE)
        ;;
      REDIS_CONNECT_TIMEOUT_MS|REDIS_RECONNECT_TIMEOUT_MS|REDIS_BREAKER_COOLDOWN_MS)
        [[ -z "$value" ]] || require_range "$key" "$value" 100 10000
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

ensure_ingress() {
  local work
  if [[ -f "${INGRESS_LIVE}/server.crt" && -f "${INGRESS_LIVE}/server.key" && -f "${INGRESS_LIVE}/ca.crt" ]]; then
    chmod 700 "$INGRESS_DIR" "$INGRESS_LIVE" 2>/dev/null || true
    chmod 600 "${INGRESS_LIVE}/server.key" 2>/dev/null || true
    if [[ -f "${INGRESS_DIR}/ca.key" ]]; then
      chmod 600 "${INGRESS_DIR}/ca.key" 2>/dev/null || true
    fi
    return 0
  fi
  if ! command -v openssl >/dev/null 2>&1; then
    die "openssl is not installed"
  fi
  mkdir -p "$INGRESS_LIVE"
  chmod 700 "$INGRESS_DIR" "$INGRESS_LIVE"
  work="$(mktemp -d "${INGRESS_DIR}/.issue.XXXXXX")"
  "${ROOT}/docker/nginx/issue-certificate.sh" "$work" local valid
  mv "$work/ca.key" "${INGRESS_DIR}/ca.key"
  mv "$work/ca.crt" "${INGRESS_LIVE}/ca.crt"
  mv "$work/server.crt" "${INGRESS_LIVE}/server.crt"
  mv "$work/server.key" "${INGRESS_LIVE}/server.key"
  rm -rf "$work"
  chmod 600 "${INGRESS_DIR}/ca.key" "${INGRESS_LIVE}/server.key"
  chmod 644 "${INGRESS_LIVE}/ca.crt" "${INGRESS_LIVE}/server.crt"
  echo "A local ingress certificate is stored in ${INGRESS_LIVE}."
  echo "The private key stays on the host."
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
  compose up -d --wait --no-deps --force-recreate ingress
  wait_ready
}

file_mode() {
  local mode
  mode="$(stat -f '%OLp' "$1" 2>/dev/null || true)"
  if [[ -z "$mode" ]]; then
    mode="$(stat -c '%a' "$1")"
  fi
  printf '%s' "$mode"
}

file_owner() {
  local owner
  owner="$(stat -f '%u' "$1" 2>/dev/null || true)"
  if [[ -z "$owner" ]]; then
    owner="$(stat -c '%u' "$1")"
  fi
  printf '%s' "$owner"
}

require_private_file() {
  local file="$1" label="$2" mode owner
  if [[ -L "$file" ]]; then
    die "${label} must not be a symlink: ${file}"
  fi
  [[ -f "$file" ]] || die "${label} is missing: ${file}"
  mode="$(file_mode "$file")"
  [[ "$mode" == "600" || "$mode" == "400" ]] || die "${label} must be mode 600 or 400: ${file}"
  owner="$(file_owner "$file")"
  [[ "$owner" == "$(id -u)" ]] || die "${label} must be owned by you: ${file}"
}

ensure_keys_file() {
  local old_umask
  if [[ "$KEYS_FILE" != "${ROOT}/config/provider-keys.env" ]]; then
    return 0
  fi
  if [[ -e "$KEYS_FILE" || -L "$KEYS_FILE" ]]; then
    return 0
  fi
  [[ -f "$KEYS_EXAMPLE" ]] || die "provider keys example is missing: ${KEYS_EXAMPLE}"
  mkdir -p "$(dirname "$KEYS_FILE")"
  old_umask="$(umask)"
  umask 077
  cp "$KEYS_EXAMPLE" "$KEYS_FILE"
  umask "$old_umask"
  chmod 600 "$KEYS_FILE"
  echo "Created ${KEYS_FILE}."
  echo "No provider key is stored in that file."
}

keys_value() {
  local key="$1" line
  [[ -f "$KEYS_FILE" ]] || return 1
  while IFS= read -r line || [[ -n "$line" ]]; do
    line="${line%$'\r'}"
    [[ "$line" == "$key="* ]] || continue
    strip_quotes "${line#"$key="}"
    return 0
  done < "$KEYS_FILE"
  printf ''
}

plain_text() {
  local key="$1" value="$2"
  # The value stays literal. The script does not source the keys file.
  # shellcheck disable=SC2016
  if [[ "$value" == *'$('* || "$value" == *'`'* || "$value" == *'${'* ]]; then
    die "config value must be plain text: ${key}"
  fi
}

require_model() {
  local key="$1" value="$2"
  [[ -n "$value" ]] || die "${key} is required"
  [[ "${#value}" -ge 1 && "${#value}" -le 128 ]] || die "${key} is invalid"
  [[ ! "$value" =~ [[:space:]] ]] || die "${key} is invalid"
}

require_api_key() {
  local key="$1" value="$2"
  [[ "${#value}" -ge 8 && "${#value}" -le 256 ]] || die "${key} must be 8 to 256 characters"
  [[ ! "$value" =~ [[:space:]] ]] || die "${key} must not contain whitespace"
}

validate_capabilities() {
  local value="$1" part seen=" "
  local -a parts=()
  [[ -n "$value" ]] || return 0
  read -r -a parts <<< "${value//,/ }"
  [[ ${#parts[@]} -gt 0 ]] || die "DEPLOYMENT_CAPABILITIES is invalid"
  for part in "${parts[@]}"; do
    part="${part#"${part%%[![:space:]]*}"}"
    part="${part%"${part##*[![:space:]]}"}"
    [[ -n "$part" ]] || die "DEPLOYMENT_CAPABILITIES is invalid"
    [[ "$seen" != *" ${part} "* ]] || die "DEPLOYMENT_CAPABILITIES is invalid"
    seen+=" ${part} "
    case "$part" in
      temperature|top_p|max_tokens|max_completion_tokens|stop|presence_penalty|frequency_penalty|seed|n|user|response_format_text)
        ;;
      *)
        die "DEPLOYMENT_CAPABILITIES is invalid"
        ;;
    esac
  done
}

public_provider_host() {
  local host="$1"
  host="$(printf '%s' "$host" | tr '[:upper:]' '[:lower:]')"
  host="${host%.}"
  case "$host" in
    openai.com|*.openai.com|anthropic.com|*.anthropic.com|x.ai|*.x.ai|openrouter.ai|*.openrouter.ai|googleapis.com|*.googleapis.com)
      return 0
      ;;
  esac
  return 1
}

validate_dgx_endpoint() {
  local value="$1" rest hostport host port path
  [[ "${#value}" -ge 8 && "${#value}" -le 512 ]] || die "DGX_ENDPOINT is invalid"
  [[ ! "$value" =~ [[:space:]] ]] || die "DGX_ENDPOINT is invalid"
  [[ "$value" == https://* ]] || die "DGX_ENDPOINT must be an https URL that ends in /v1"
  [[ "$value" != *"@"* && "$value" != *"?"* && "$value" != *"#"* ]] || die "DGX_ENDPOINT is invalid"
  [[ "$value" == */v1 || "$value" == */v1/ ]] || die "DGX_ENDPOINT must end in /v1"
  rest="${value#https://}"
  hostport="${rest%%/*}"
  path="${rest#*/}"
  path="${path%/}"
  [[ "$path" == "v1" ]] || die "DGX_ENDPOINT must end in /v1"
  if [[ "$hostport" == *:* ]]; then
    host="${hostport%%:*}"
    port="${hostport##*:}"
  else
    host="$hostport"
    port="443"
  fi
  host="$(printf '%s' "$host" | tr '[:upper:]' '[:lower:]')"
  host="${host%.}"
  [[ "$host" =~ ^[a-z0-9]([a-z0-9.-]{0,251}[a-z0-9])?$ ]] || die "DGX_ENDPOINT is invalid"
  [[ "$port" =~ ^[0-9]+$ ]] || die "DGX_ENDPOINT is invalid"
  (( 10#$port >= 1 && 10#$port <= 65535 )) || die "DGX_ENDPOINT is invalid"
  public_provider_host "$host" && die "DGX_ENDPOINT must not use a public provider host"
  DGX_HOST="$host"
  DGX_PORT="$port"
}

address_ok() {
  local value="$1" octet
  local IFS='.'
  local -a octets=()
  [[ "$value" != "0.0.0.0" && "$value" != "::" && "$value" != "::1" ]] || return 1
  [[ "$value" != 169.254.* && "$value" != "169.254.169.254" ]] || return 1
  if [[ "$value" == *:* ]]; then
    [[ "$value" =~ ^[0-9A-Fa-f:]{2,45}$ ]] || return 1
    return 0
  fi
  [[ "$value" =~ ^[0-9]{1,3}(\.[0-9]{1,3}){3}$ ]] || return 1
  read -r -a octets <<< "$value"
  [[ ${#octets[@]} -eq 4 ]] || return 1
  for octet in "${octets[@]}"; do
    (( 10#$octet <= 255 )) || return 1
  done
}

validate_allowlist() {
  local value="$1" part seen=" " count=0
  local -a parts=()
  [[ -n "$value" ]] || return 0
  read -r -a parts <<< "${value//,/ }"
  for part in "${parts[@]}"; do
    part="${part#"${part%%[![:space:]]*}"}"
    part="${part%"${part##*[![:space:]]}"}"
    [[ -n "$part" ]] || die "DGX_ALLOWLIST_ADDRESSES is invalid"
    [[ "$seen" != *" ${part} "* ]] || die "DGX_ALLOWLIST_ADDRESSES is invalid"
    seen+=" ${part} "
    address_ok "$part" || die "DGX_ALLOWLIST_ADDRESSES is invalid"
    count=$((count + 1))
  done
  (( count >= 1 && count <= 8 )) || die "DGX_ALLOWLIST_ADDRESSES is invalid"
}

validate_health_endpoint() {
  local value="$1" rest hostport host port path
  [[ -n "$value" ]] || return 0
  [[ "$value" == https://* ]] || die "DGX_HEALTH_ENDPOINT is invalid"
  [[ "$value" != *"@"* && "$value" != *"?"* && "$value" != *"#"* ]] || die "DGX_HEALTH_ENDPOINT is invalid"
  rest="${value#https://}"
  hostport="${rest%%/*}"
  path="/${rest#*/}"
  path="${path%/}"
  if [[ "$hostport" == *:* ]]; then
    host="${hostport%%:*}"
    port="${hostport##*:}"
  else
    host="$hostport"
    port="443"
  fi
  host="$(printf '%s' "$host" | tr '[:upper:]' '[:lower:]')"
  [[ "$host" == "$DGX_HOST" && "$port" == "$DGX_PORT" ]] || die "DGX_HEALTH_ENDPOINT is invalid"
  case "$path" in
    /health|/health/ready|/ready|/v1/health|/v1/health/ready)
      ;;
    *)
      die "DGX_HEALTH_ENDPOINT is invalid"
      ;;
  esac
}

validate_keys_file() {
  local line key value seen=" "
  KEYS_ANY=0
  DGX_HOST=""
  DGX_PORT=""
  require_private_file "$KEYS_FILE" "provider keys file"
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
    plain_text "$key" "$value"
    case "$key" in
      OPENAI_API_KEY|ANTHROPIC_API_KEY|XAI_API_KEY|OPENROUTER_API_KEY|DGX_API_KEY)
        [[ -z "$value" ]] || require_api_key "$key" "$value"
        [[ -z "$value" ]] || KEYS_ANY=1
        ;;
      VERTEX_SERVICE_ACCOUNT_JSON)
        if [[ -n "$value" ]]; then
          [[ "${#value}" -ge 8 && "${#value}" -le 3000 ]] || die "VERTEX_SERVICE_ACCOUNT_JSON must be 8 to 3000 characters"
          [[ "$value" == *private_key* || "$value" == *private-key* ]] || die "VERTEX_SERVICE_ACCOUNT_JSON must be a service account key"
          KEYS_ANY=1
        fi
        ;;
      OPENAI_MODEL|ANTHROPIC_MODEL|XAI_MODEL|OPENROUTER_MODEL|VERTEX_MODEL|DGX_MODEL)
        [[ -z "$value" ]] || require_model "$key" "$value"
        ;;
      ANTHROPIC_ENDPOINT)
        if [[ -n "$value" ]]; then
          [[ "${#value}" -ge 8 && "${#value}" -le 512 ]] || die "ANTHROPIC_ENDPOINT is invalid"
          [[ "$value" == http://* || "$value" == https://* ]] || die "ANTHROPIC_ENDPOINT must be an http or https URL"
          [[ "$value" != *"@"* && ! "$value" =~ [[:space:]] ]] || die "ANTHROPIC_ENDPOINT is invalid"
        fi
        ;;
      ANTHROPIC_WORKSPACE_ID)
        if [[ -n "$value" ]]; then
          [[ "${#value}" -le 128 && ! "$value" =~ [[:space:]] ]] || die "ANTHROPIC_WORKSPACE_ID is invalid"
        fi
        ;;
      ANTHROPIC_MAX_OUTPUT_TOKENS)
        [[ -z "$value" ]] || require_range "$key" "$value" 1 128000
        ;;
      VERTEX_PROJECT)
        [[ -z "$value" || "$value" =~ ^[a-z][a-z0-9-]{4,28}[a-z0-9]$ ]] || die "VERTEX_PROJECT is invalid"
        ;;
      VERTEX_LOCATION)
        [[ -z "$value" || "$value" =~ ^(global|[a-z]+(-[a-z0-9]+){1,3})$ ]] || die "VERTEX_LOCATION is invalid"
        ;;
      DGX_ENDPOINT)
        [[ -z "$value" ]] || validate_dgx_endpoint "$value"
        ;;
      DGX_ALLOWLIST_ADDRESSES)
        [[ -z "$value" ]] || validate_allowlist "$value"
        ;;
      DGX_HEALTH_ENDPOINT)
        ;;
      DEPLOYMENT_TIMEOUT_MS)
        [[ -z "$value" ]] || require_range "$key" "$value" 100 600000
        ;;
      DEPLOYMENT_CAPABILITIES)
        validate_capabilities "$value"
        ;;
      *)
        die "config key is not allowed: ${key}"
        ;;
    esac
  done < "$KEYS_FILE"
  validate_key_relations
}

validate_key_relations() {
  local openai anthropic xai router vertex dgx endpoint project location addresses health max_out
  openai="$(keys_value OPENAI_API_KEY || true)"
  anthropic="$(keys_value ANTHROPIC_API_KEY || true)"
  xai="$(keys_value XAI_API_KEY || true)"
  router="$(keys_value OPENROUTER_API_KEY || true)"
  vertex="$(keys_value VERTEX_SERVICE_ACCOUNT_JSON || true)"
  dgx="$(keys_value DGX_API_KEY || true)"
  if [[ -n "$openai" ]]; then
    require_model OPENAI_MODEL "$(keys_value OPENAI_MODEL || true)"
  fi
  if [[ -n "$anthropic" ]]; then
    endpoint="$(keys_value ANTHROPIC_ENDPOINT || true)"
    [[ -n "$endpoint" ]] || die "ANTHROPIC_ENDPOINT is required when ANTHROPIC_API_KEY is set"
    require_model ANTHROPIC_MODEL "$(keys_value ANTHROPIC_MODEL || true)"
  fi
  if [[ -n "$xai" ]]; then
    require_model XAI_MODEL "$(keys_value XAI_MODEL || true)"
  fi
  if [[ -n "$router" ]]; then
    require_model OPENROUTER_MODEL "$(keys_value OPENROUTER_MODEL || true)"
  fi
  if [[ -n "$vertex" ]]; then
    project="$(keys_value VERTEX_PROJECT || true)"
    location="$(keys_value VERTEX_LOCATION || true)"
    [[ -n "$project" ]] || die "VERTEX_PROJECT is required when VERTEX_SERVICE_ACCOUNT_JSON is set"
    [[ -n "$location" ]] || die "VERTEX_LOCATION is required when VERTEX_SERVICE_ACCOUNT_JSON is set"
    require_model VERTEX_MODEL "$(keys_value VERTEX_MODEL || true)"
  fi
  endpoint="$(keys_value DGX_ENDPOINT || true)"
  addresses="$(keys_value DGX_ALLOWLIST_ADDRESSES || true)"
  health="$(keys_value DGX_HEALTH_ENDPOINT || true)"
  if [[ -n "$dgx" && -z "$endpoint" ]]; then
    die "DGX_ENDPOINT is required when DGX_API_KEY is set"
  fi
  if [[ -z "$dgx" && -n "$endpoint" ]]; then
    die "DGX_API_KEY is required when DGX_ENDPOINT is set"
  fi
  if [[ -n "$dgx" ]]; then
    require_model DGX_MODEL "$(keys_value DGX_MODEL || true)"
    [[ -n "$addresses" || -z "$health" ]] || die "DGX_ALLOWLIST_ADDRESSES is required when DGX_HEALTH_ENDPOINT is set"
    validate_health_endpoint "$health"
  elif [[ -n "$addresses" || -n "$health" ]]; then
    die "DGX_API_KEY is required when a DGX allowlist is set"
  fi
  unset openai anthropic xai router vertex dgx endpoint project location addresses health max_out
}

output_has_secret() {
  local file="$1"
  shift
  local secret line
  if grep -E -q 'sk-[A-Za-z0-9_-]+|yck_[A-Za-z0-9_-]+|private[_-]key|BEGIN PRIVATE' "$file"; then
    return 0
  fi
  for secret in "$@"; do
    [[ -n "$secret" ]] || continue
    # Compare inside this shell. Do not pass the secret to another process.
    while IFS= read -r line || [[ -n "$line" ]]; do
      if [[ "$line" == *"$secret"* ]]; then
        return 0
      fi
    done < "$file"
  done
  return 1
}

discard_secret_output() {
  local file
  for file in "$@"; do
    [[ -n "$file" ]] || continue
    rm -f "$file"
  done
  die "command output contained a secret and was discarded"
}

new_private_temp() {
  local file
  file="$(mktemp)"
  chmod 600 "$file"
  KEY_TEMPS+=("$file")
  printf '%s' "$file"
}

run_cli() {
  local out err code
  out="$(new_private_temp)"
  err="$(new_private_temp)"
  set +e
  compose run --rm -T --no-deps app node dist/cli.js "$@" >"$out" 2>"$err"
  code=$?
  set -e
  if output_has_secret "$out" || output_has_secret "$err"; then
    discard_secret_output "$out" "$err"
  fi
  if [[ "$code" -ne 0 ]]; then
    cat "$err" >&2
    die "provider command failed"
  fi
  printf '%s' "$out"
}

pipe_key() {
  local key="$1"
  shift
  local out err code
  out="$(new_private_temp)"
  err="$(new_private_temp)"
  set +e
  printf '%s' "$key" | compose run --rm -T --no-deps app node dist/cli.js "$@" >"$out" 2>"$err"
  code=$?
  set -e
  if output_has_secret "$out" "$key" || output_has_secret "$err" "$key"; then
    discard_secret_output "$out" "$err"
  fi
  if [[ "$code" -ne 0 ]]; then
    cat "$err" >&2
    die "provider command failed"
  fi
}

listing_has() {
  local kind="$1" name="$2" code
  set +e
  node --no-warnings -e '
    const fs = require("fs");
    let data;
    try {
      data = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    } catch (err) {
      process.exit(2);
    }
    const kind = process.argv[2];
    const name = process.argv[3];
    const rows = kind === "deployment" ? data.deployments : data.connections;
    const field = kind === "deployment" ? "name" : "provider";
    const found = Array.isArray(rows) && rows.some((row) => row && row[field] === name);
    process.exit(found ? 0 : 1);
  ' "$LISTING" "$kind" "$name"
  code=$?
  set -e
  if [[ "$code" -ne 0 && "$code" -ne 1 ]]; then
    die "inference listing is invalid"
  fi
  return "$code"
}

deployment_field() {
  local name="$1" field="$2"
  node --no-warnings -e '
    const fs = require("fs");
    let data;
    try {
      data = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    } catch (err) {
      process.exit(2);
    }
    const name = process.argv[2];
    const field = process.argv[3];
    const rows = Array.isArray(data.deployments) ? data.deployments : [];
    const row = rows.find((item) => item && item.name === name);
    if (!row) process.exit(1);
    const value = row[field];
    if (value === null || value === undefined) {
      process.stdout.write("");
      process.exit(0);
    }
    if (Array.isArray(value)) {
      process.stdout.write(value.join(","));
      process.exit(0);
    }
    process.stdout.write(String(value));
  ' "$LISTING" "$name" "$field"
}

refresh_listing() {
  local out
  out="$(run_cli list-inference --tenant-id "$TENANT_ID")"
  LISTING="$out"
}

deployment_timeout() {
  local value
  value="$(keys_value DEPLOYMENT_TIMEOUT_MS || true)"
  if [[ -z "$value" ]]; then
    printf '60000'
  else
    printf '%s' "$value"
  fi
}

deployment_capabilities() {
  local value
  value="$(keys_value DEPLOYMENT_CAPABILITIES || true)"
  if [[ -z "$value" ]]; then
    printf 'temperature,max_tokens'
  else
    printf '%s' "$value"
  fi
}

capabilities_for() {
  local provider="$1" model="$2" caps
  caps="$(deployment_capabilities)"
  if [[ "$provider" == "anthropic" && "$model" == "claude-sonnet-5-5" ]]; then
    node --no-warnings -e '
      const parts = String(process.argv[1] || "")
        .split(",")
        .map((part) => part.trim())
        .filter((part) => part.length > 0 && part !== "temperature");
      process.stdout.write(parts.join(","));
    ' "$caps"
  else
    printf '%s' "$caps"
  fi
}

sorted_caps() {
  node --no-warnings -e '
    const parts = String(process.argv[1] || "")
      .split(",")
      .map((part) => part.trim())
      .filter((part) => part.length > 0)
      .sort();
    process.stdout.write(parts.join(","));
  ' "$1"
}

ensure_deployment() {
  local provider="$1" model="$2" caps stored_model stored_caps stored_enabled
  caps="$(capabilities_for "$provider" "$model")"
  if listing_has deployment "$provider"; then
    stored_model="$(deployment_field "$provider" upstreamModel || true)"
    if [[ "$stored_model" != "$model" ]]; then
      run_cli set-deployment-model --tenant-id "$TENANT_ID" --deployment "$provider" --upstream-model "$model" >/dev/null
      echo "${provider}: upstream model updated"
    fi
    stored_caps="$(deployment_field "$provider" capabilities || true)"
    if [[ "$(sorted_caps "$stored_caps")" != "$(sorted_caps "$caps")" ]]; then
      run_cli set-deployment-capabilities --tenant-id "$TENANT_ID" --deployment "$provider" --capabilities "$caps" >/dev/null
      echo "${provider}: capabilities updated"
    fi
    stored_enabled="$(deployment_field "$provider" enabled || true)"
    if [[ "$stored_enabled" != "true" ]]; then
      run_cli set-deployment-enabled --tenant-id "$TENANT_ID" --name "$provider" --enabled true >/dev/null
      echo "${provider}: deployment enabled"
    fi
    ensure_deployment_policy "$provider"
    return 0
  fi
  if [[ "$provider" == "anthropic" ]]; then
    run_cli register-deployment \
      --tenant-id "$TENANT_ID" \
      --provider "$provider" \
      --name "$provider" \
      --upstream-model "$model" \
      --timeout-ms "$(deployment_timeout)" \
      --capabilities "$caps" \
      --default-max-output-tokens "$(keys_value ANTHROPIC_MAX_OUTPUT_TOKENS)" \
      --enabled true >/dev/null
  else
    run_cli register-deployment \
      --tenant-id "$TENANT_ID" \
      --provider "$provider" \
      --name "$provider" \
      --upstream-model "$model" \
      --timeout-ms "$(deployment_timeout)" \
      --capabilities "$caps" \
      --enabled true >/dev/null
  fi
  echo "${provider}: deployment registered"
  refresh_listing
  ensure_deployment_policy "$provider"
}

ensure_deployment_policy() {
  local provider="$1" class collection
  class="$(deployment_field "$provider" dataClassification || true)"
  if [[ -z "$class" ]]; then
    run_cli set-deployment-data-class --tenant-id "$TENANT_ID" --deployment "$provider" --data-class internal >/dev/null
    echo "${provider}: data class set to internal"
  fi
  collection="$(deployment_field "$provider" dataCollection || true)"
  if [[ -z "$collection" ]]; then
    run_cli set-deployment-data-collection --tenant-id "$TENANT_ID" --deployment "$provider" --data-collection allow >/dev/null
    echo "${provider}: data collection set to allow"
  fi
  ensure_sample_allowlist "$provider"
  refresh_listing
}

ensure_sample_allowlist() {
  local provider="$1" out_file next code
  out_file="$(run_cli show-sample-policy --tenant-id "$TENANT_ID")"
  set +e
  next="$(node --no-warnings -e '
    const fs = require("fs");
    let data;
    try {
      data = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    } catch (err) {
      process.exit(2);
    }
    if (!data || data.attached === false || data.mode !== "encrypted_sample") process.exit(0);
    const provider = process.argv[2];
    const providers = Array.isArray(data.providers) ? [...data.providers] : [];
    const deployments = Array.isArray(data.deployments) ? [...data.deployments] : [];
    const hasProvider = providers.includes(provider);
    const hasDeployment = deployments.includes(provider);
    if (hasProvider && hasDeployment) process.exit(0);
    if (!hasProvider) providers.push(provider);
    if (!hasDeployment) deployments.push(provider);
    process.stdout.write(JSON.stringify({
      mode: String(data.mode),
      contentCapture: data.contentCapture === true ? "true" : "false",
      streamingCapture: data.streamingCapture === true ? "true" : "false",
      replay: data.replay === true ? "true" : "false",
      judgeDisclosure: data.judgeDisclosure === true ? "true" : "false",
      sampleRate: String(data.sampleRate),
      maxSampleBytes: String(data.maxSampleBytes),
      maxSampleCount: String(data.maxSampleCount),
      retentionSeconds: String(data.retentionSeconds),
      recentShare: String(data.recentShare),
      classifications: (Array.isArray(data.classifications) ? data.classifications : []).join(","),
      providers: providers.join(","),
      deployments: deployments.join(","),
    }));
  ' "$out_file" "$provider")"
  code=$?
  set -e
  if [[ "$code" -ne 0 ]]; then
    die "Could not read the sample policy. keys stopped."
  fi
  [[ -n "$next" ]] || return 0
  run_cli set-sample-policy \
    --tenant-id "$TENANT_ID" \
    --mode "$(node --no-warnings -e 'process.stdout.write(JSON.parse(process.argv[1]).mode)' "$next")" \
    --content-capture "$(node --no-warnings -e 'process.stdout.write(JSON.parse(process.argv[1]).contentCapture)' "$next")" \
    --streaming-capture "$(node --no-warnings -e 'process.stdout.write(JSON.parse(process.argv[1]).streamingCapture)' "$next")" \
    --replay "$(node --no-warnings -e 'process.stdout.write(JSON.parse(process.argv[1]).replay)' "$next")" \
    --judge-disclosure "$(node --no-warnings -e 'process.stdout.write(JSON.parse(process.argv[1]).judgeDisclosure)' "$next")" \
    --sample-rate "$(node --no-warnings -e 'process.stdout.write(JSON.parse(process.argv[1]).sampleRate)' "$next")" \
    --max-sample-bytes "$(node --no-warnings -e 'process.stdout.write(JSON.parse(process.argv[1]).maxSampleBytes)' "$next")" \
    --max-sample-count "$(node --no-warnings -e 'process.stdout.write(JSON.parse(process.argv[1]).maxSampleCount)' "$next")" \
    --retention-seconds "$(node --no-warnings -e 'process.stdout.write(JSON.parse(process.argv[1]).retentionSeconds)' "$next")" \
    --recent-share "$(node --no-warnings -e 'process.stdout.write(JSON.parse(process.argv[1]).recentShare)' "$next")" \
    --classifications "$(node --no-warnings -e 'process.stdout.write(JSON.parse(process.argv[1]).classifications)' "$next")" \
    --providers "$(node --no-warnings -e 'process.stdout.write(JSON.parse(process.argv[1]).providers)' "$next")" \
    --deployments "$(node --no-warnings -e 'process.stdout.write(JSON.parse(process.argv[1]).deployments)' "$next")" \
    >/dev/null
  echo "${provider}: sample policy allow-list updated"
}

apply_openai() {
  local key
  key="$(keys_value OPENAI_API_KEY || true)"
  [[ -n "$key" ]] || return 0
  if listing_has connection openai; then
    pipe_key "$key" set-openai-credential --tenant-id "$TENANT_ID" --api-key-stdin
    echo "openai: key replaced"
  else
    pipe_key "$key" register-openai-connection --tenant-id "$TENANT_ID" --api-key-stdin
    echo "openai: connection registered"
  fi
  ensure_deployment openai "$(keys_value OPENAI_MODEL)"
  unset key
}

apply_anthropic() {
  local key endpoint workspace max_out
  local -a args=()
  key="$(keys_value ANTHROPIC_API_KEY || true)"
  [[ -n "$key" ]] || return 0
  max_out="$(keys_value ANTHROPIC_MAX_OUTPUT_TOKENS || true)"
  if [[ -z "$max_out" ]]; then
    echo "anthropic: skipped because ANTHROPIC_MAX_OUTPUT_TOKENS is empty. The key was not replaced."
    unset key endpoint workspace max_out
    return 0
  fi
  endpoint="$(keys_value ANTHROPIC_ENDPOINT)"
  workspace="$(keys_value ANTHROPIC_WORKSPACE_ID || true)"
  if listing_has connection anthropic; then
    pipe_key "$key" set-anthropic-credential --tenant-id "$TENANT_ID" --api-key-stdin
    echo "anthropic: key replaced"
  else
    args=(register-anthropic-connection --tenant-id "$TENANT_ID" --endpoint "$endpoint" --api-key-stdin)
    if [[ -n "$workspace" ]]; then
      args+=(--workspace-id "$workspace")
    fi
    pipe_key "$key" "${args[@]}"
    echo "anthropic: connection registered"
  fi
  ensure_deployment anthropic "$(keys_value ANTHROPIC_MODEL)"
  unset key endpoint workspace max_out
}

apply_registry_key() {
  local provider="$1" key_name="$2" model_name="$3"
  shift 3
  local key
  key="$(keys_value "$key_name" || true)"
  [[ -n "$key" ]] || return 0
  if listing_has connection "$provider"; then
    case "$provider" in
      xai) pipe_key "$key" set-xai-credential --tenant-id "$TENANT_ID" --api-key-stdin ;;
      openrouter) pipe_key "$key" set-openrouter-credential --tenant-id "$TENANT_ID" --api-key-stdin ;;
      vertex) pipe_key "$key" set-vertex-credential --tenant-id "$TENANT_ID" --api-key-stdin ;;
      dgx) pipe_key "$key" set-dgx-credential --tenant-id "$TENANT_ID" --api-key-stdin ;;
      *) die "provider is invalid: ${provider}" ;;
    esac
    if [[ "$provider" == "vertex" ]]; then
      echo "vertex: credential replaced"
    else
      echo "${provider}: key replaced"
    fi
  else
    pipe_key "$key" "$@"
    echo "${provider}: connection registered"
  fi
  ensure_deployment "$provider" "$(keys_value "$model_name")"
  unset key
}

apply_dgx_allowlist() {
  local addresses health
  local -a args=()
  addresses="$(keys_value DGX_ALLOWLIST_ADDRESSES || true)"
  [[ -n "$addresses" ]] || return 0
  health="$(keys_value DGX_HEALTH_ENDPOINT || true)"
  args=(
    approve-private-endpoint
    --tenant-id "$TENANT_ID"
    --host "$DGX_HOST"
    --port "$DGX_PORT"
    --addresses "$addresses"
    --tls-verify true
  )
  if [[ -n "$health" ]]; then
    args+=(--health-endpoint "$health")
  fi
  run_cli "${args[@]}" >/dev/null
  echo "dgx: allowlist stored"
  unset addresses health
}

load_tenant() {
  local out err code capture idfile
  if [[ -L "$TENANT_FILE" ]]; then
    die "tenant file must not be a symlink: ${TENANT_FILE}"
  fi
  if [[ -f "$TENANT_FILE" ]]; then
    require_private_file "$TENANT_FILE" "tenant file"
    if ! TENANT_ID="$(node --no-warnings -e '
      const fs = require("fs");
      let data;
      try {
        data = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
      } catch (err) {
        process.exit(2);
      }
      if (!data || typeof data.tenantId !== "string" || data.tenantId.length === 0) process.exit(2);
      process.stdout.write(data.tenantId);
    ' "$TENANT_FILE")"; then
      die "tenant file is invalid: ${TENANT_FILE}"
    fi
    [[ "$TENANT_ID" =~ ^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$ ]] \
      || die "tenant file is invalid: ${TENANT_FILE}"
    echo "Tenant id: ${TENANT_ID}"
    echo "Tenant secret stays in ${TENANT_FILE}."
    return 0
  fi
  command -v node >/dev/null 2>&1 || die "node is required to store the tenant file"
  out="$(new_private_temp)"
  err="$(new_private_temp)"
  set +e
  compose run --rm -T --no-deps app node dist/cli.js provision-tenant --name local >"$out" 2>"$err"
  code=$?
  set -e
  if [[ "$code" -ne 0 ]]; then
    if output_has_secret "$err"; then
      discard_secret_output "$out" "$err"
    fi
    cat "$err" >&2
    die "tenant was not created"
  fi
  capture="$(new_private_temp)"
  idfile="$(new_private_temp)"
  if ! node --no-warnings -e '
    const fs = require("fs");
    let data;
    try {
      data = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    } catch (err) {
      process.exit(2);
    }
    if (!data || typeof data.tenantId !== "string" || data.tenantId.length === 0) process.exit(2);
    if (typeof data.secret !== "string" || data.secret.length === 0) process.exit(2);
    if (typeof data.keyId !== "string" || data.keyId.length === 0) process.exit(2);
    fs.writeFileSync(process.argv[2], JSON.stringify({
      tenantId: data.tenantId,
      keyId: data.keyId,
      secret: data.secret,
      name: data.name,
    }) + "\n", { mode: 0o600 });
    process.stdout.write(data.tenantId);
  ' "$out" "$capture" >"$idfile"; then
    wipe_file "$out"
    wipe_file "$idfile"
    wipe_file "$capture"
    die "tenant was not created"
  fi
  TENANT_ID="$(cat "$idfile")"
  chmod 600 "$capture"
  mv "$capture" "$TENANT_FILE"
  chmod 600 "$TENANT_FILE"
  wipe_file "$out"
  wipe_file "$idfile"
  [[ "$TENANT_ID" =~ ^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$ ]] \
    || die "tenant was not created"
  echo "Tenant id: ${TENANT_ID}"
  echo "Tenant secret stays in ${TENANT_FILE}."
}

set_inference_on() {
  local tmp line found=0 old_umask
  old_umask="$(umask)"
  umask 077
  tmp="$(mktemp)"
  umask "$old_umask"
  chmod 600 "$tmp"
  while IFS= read -r line || [[ -n "$line" ]]; do
    if [[ "$line" == INFERENCE_ENABLED=* ]]; then
      printf 'INFERENCE_ENABLED=true\n'
      found=1
    else
      printf '%s\n' "$line"
    fi
  done < "$ENV_FILE" > "$tmp"
  if [[ "$found" -eq 0 ]]; then
    printf 'INFERENCE_ENABLED=true\n' >> "$tmp"
  fi
  mv "$tmp" "$ENV_FILE"
  chmod 600 "$ENV_FILE"
}

report_provider_keys() {
  local mode owner value label
  PROVIDER_LIST=""
  if [[ ! -e "$KEYS_FILE" && ! -L "$KEYS_FILE" ]]; then
    echo "provider keys: missing"
    return 0
  fi
  if [[ -L "$KEYS_FILE" ]]; then
    echo "provider keys: refused"
    return 0
  fi
  mode="$(file_mode "$KEYS_FILE" 2>/dev/null || true)"
  owner="$(file_owner "$KEYS_FILE" 2>/dev/null || true)"
  if [[ "$mode" != "600" && "$mode" != "400" ]] || [[ "$owner" != "$(id -u)" ]]; then
    echo "provider keys: refused"
    return 0
  fi
  append_provider OPENAI_API_KEY openai
  append_provider ANTHROPIC_API_KEY anthropic
  append_provider XAI_API_KEY xai
  append_provider OPENROUTER_API_KEY openrouter
  append_provider VERTEX_SERVICE_ACCOUNT_JSON vertex
  append_provider DGX_API_KEY dgx
  if [[ -z "$PROVIDER_LIST" ]]; then
    echo "provider keys: none"
  else
    echo "provider keys: ${PROVIDER_LIST}"
  fi
}

append_provider() {
  local key="$1" label="$2" value
  value="$(keys_value "$key" || true)"
  if [[ -n "$value" ]]; then
    if [[ -n "$PROVIDER_LIST" ]]; then
      PROVIDER_LIST="${PROVIDER_LIST}, ${label}"
    else
      PROVIDER_LIST="$label"
    fi
  fi
  unset value
}

wipe_file() {
  local file="$1"
  [[ -n "$file" && -f "$file" ]] || return 0
  dd if=/dev/zero of="$file" bs=1024 count=64 >/dev/null 2>&1 || true
  rm -f "$file"
}

cleanup_key_temps() {
  local file
  for file in ${KEY_TEMPS+"${KEY_TEMPS[@]}"}; do
    wipe_file "$file"
  done
}

cmd_keys() {
  KEY_TEMPS=()
  trap cleanup_key_temps EXIT
  if [[ ! -e "$KEYS_FILE" && ! -L "$KEYS_FILE" ]]; then
    die "provider keys file is missing: ${KEYS_FILE}. Run ./llm-proxy-docker.sh setup."
  fi
  validate_keys_file
  if [[ "$KEYS_ANY" -eq 0 ]]; then
    echo "No provider keys are set. Inference is unchanged."
    return 0
  fi
  command -v node >/dev/null 2>&1 || die "node is required to apply provider keys"
  ensure_config
  validate_env_file
  if [[ -z "$(config_value PROVIDER_CREDENTIAL_KEY || true)" ]]; then
    die "PROVIDER_CREDENTIAL_KEY is required before provider keys are applied"
  fi
  set_inference_on
  load_env_file
  ensure_colima
  if [[ "$(source_hash)" != "$(stamp_value)" ]] || ! image_exists; then
    build_image
  fi
  echo "starting the llm-proxy Compose project"
  recreate_app
  load_tenant
  refresh_listing
  apply_openai
  apply_anthropic
  apply_registry_key xai XAI_API_KEY XAI_MODEL register-xai-connection --tenant-id "$TENANT_ID" --api-key-stdin
  apply_registry_key openrouter OPENROUTER_API_KEY OPENROUTER_MODEL register-openrouter-connection --tenant-id "$TENANT_ID" --api-key-stdin
  apply_registry_key vertex VERTEX_SERVICE_ACCOUNT_JSON VERTEX_MODEL \
    register-vertex-connection --tenant-id "$TENANT_ID" \
    --project "$(keys_value VERTEX_PROJECT)" \
    --location "$(keys_value VERTEX_LOCATION)" \
    --api-key-stdin
  apply_registry_key dgx DGX_API_KEY DGX_MODEL \
    register-dgx-connection --tenant-id "$TENANT_ID" \
    --endpoint "$(keys_value DGX_ENDPOINT)" \
    --api-key-stdin
  if [[ -n "$(keys_value DGX_API_KEY || true)" ]]; then
    if [[ -n "$(keys_value DGX_ALLOWLIST_ADDRESSES || true)" ]]; then
      apply_dgx_allowlist
    else
      echo "dgx: chat needs DGX_ALLOWLIST_ADDRESSES before the proxy can call that host."
    fi
  fi
  echo "Inference is on."
  echo "Selection stays off."
  echo "Automatic promotion stays off."
  echo "The script did not mark a deployment validated."
}

cmd_build() {
  build_image
}

cmd_setup() {
  ensure_keys_file
  if [[ -f "$ENV_FILE" ]]; then
    validate_env_file
    ensure_ingress
    echo "Config file already exists: ${ENV_FILE}"
    echo "inference: $(config_value INFERENCE_ENABLED || echo missing)"
    return 0
  fi
  ensure_config
  ensure_ingress
  validate_env_file
  echo "Edit ${ENV_FILE}, then run ./llm-proxy-docker.sh start."
}

cmd_start() {
  local rebuilt=0
  ensure_config
  load_env_file
  ensure_ingress
  ensure_colima
  if [[ "${1:-0}" -eq 1 || "$(source_hash)" != "$(stamp_value)" ]] || ! image_exists; then
    build_image
    rebuilt=1
  else
    compose build ingress
  fi
  echo "starting the llm-proxy Compose project"
  if [[ "$rebuilt" -eq 1 ]]; then
    recreate_app
  else
    compose up -d --wait postgres
    compose up -d --wait --no-deps app
    compose up -d --wait --no-deps ingress
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
  report_provider_keys
  echo "image: $(image_state)"
  if colima_running && [[ -S "$SOCKET" ]]; then
    export DOCKER_HOST="unix://${SOCKET}"
    compose --no-env-file ps || true
    if command -v curl >/dev/null 2>&1; then
      if [[ -f "$INGRESS_CA" ]] && ready_curl >/dev/null 2>&1; then
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
    keys)
      [[ "$has_build" -eq 0 && "$has_vm" -eq 0 ]] || die "keys does not take options"
      cmd_keys
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
