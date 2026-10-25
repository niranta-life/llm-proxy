#!/usr/bin/env bash
# Shared helpers for scripts/gcp/*. Source this; do not run it.
# shellcheck shell=bash

# Bash 5+ is required (macOS ships 3.2): smoke.sh times stream events with EPOCHREALTIME,
# which only exists from bash 5. Kept above everything else and written so that bash 3.2
# can still parse far enough to print the message.
if [ -z "${BASH_VERSINFO:-}" ] || [ "${BASH_VERSINFO[0]}" -lt 5 ]; then
  echo "ERROR: bash 5+ required (this is ${BASH_VERSION:-unknown}). On macOS: brew install bash (installs bash 5.x), then put \$(brew --prefix)/bin first in PATH." >&2
  exit 1
fi

set -euo pipefail
# These scripts handle passwords and API keys. Never trace them, even under
# `bash -x` or an inherited SHELLOPTS=xtrace.
{ set +x; } 2>/dev/null

GCP_SCRIPTS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "${GCP_SCRIPTS_DIR}/../.." && pwd)"
DEPLOY_DIR="${ROOT}/deploy/gcp"
TF_ROOT="${GCP_TF_ROOT:-${DEPLOY_DIR}/tofu}" # GCP_TF_ROOT: tests point this at a scratch copy
# Two OpenTofu stacks, two state prefixes:
#   persistent  Secret Manager secrets, the backups bucket, the build staging bucket
#   platform    everything else (cluster, network, IAM, load balancer, registry)
# shellcheck disable=SC2034 # used by infra.sh
TF_STACKS=(persistent platform)

# shellcheck source=../../deploy/gcp/env.sh
source "${DEPLOY_DIR}/env.sh"

# ---- output -----------------------------------------------------------------
log() { printf '==> %s\n' "$*" >&2; }
warn() { printf 'WARN: %s\n' "$*" >&2; }
die() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }
will() { printf '    will: %s\n' "$*" >&2; }
ok() { printf '  ok:   %s\n' "$*" >&2; }

# ---- help -------------------------------------------------------------------
# show_usage [script]: print the header comment of a script (default: the one running).
show_usage() {
  awk 'NR == 1 { next } /^#/ { sub(/^# ?/, ""); print; next } { exit }' "${1:-$0}"
}

# help_if_asked "$@": every script calls this first; -h or --help as the first argument prints
# the header comment and exits.
help_if_asked() {
  case "${1:-}" in
    -h | --help)
      show_usage "$0"
      exit 0
      ;;
  esac
}

# ---- dry run ----------------------------------------------------------------
# DRY_RUN=1 (up.sh --dry-run): every script prints what it would do and then
# stops before any remote call or file write. No gcloud, tofu, kubectl, or helm is run.
is_dry() { [ "${DRY_RUN:-0}" = "1" ]; }
# Call after the "will:" lines of a script.
stop_if_dry() {
  if is_dry; then
    log "dry run: nothing executed"
    exit 0
  fi
}

# ---- prompts ----------------------------------------------------------------
interactive() { [ -t 0 ] && [ -t 2 ]; }

confirm() { # confirm "question"   (YES=1 skips; refuses without a terminal)
  if is_dry; then
    printf '    [dry-run] would ask: %s\n' "$1" >&2
    return 0
  fi
  [ "${YES:-0}" = "1" ] && return 0
  interactive || die "need a terminal to confirm: ${1} (set YES=1 to skip prompts)"
  local answer
  read -r -p "$1 [y/N] " answer
  [ "$answer" = "y" ] || die "aborted"
}

# typed "text to type" "why": for destructive steps. YES=1 does NOT skip it.
typed() {
  local answer
  if is_dry; then
    printf '    [dry-run] would require typing: %s\n' "$1" >&2
    return 0
  fi
  interactive || die "this step needs a terminal and a typed confirmation (--yes does not skip it)"
  warn "$2"
  read -r -p "Type '$1' to continue: " answer
  [ "$answer" = "$1" ] || die "aborted"
}

# ask VAR "prompt" [default]   (reads from the terminal; sets VAR)
ask() {
  local var="$1" prompt="$2" default="${3:-}" answer
  interactive || die "need a terminal to ask: ${prompt} (put it in deploy/gcp/settings.env instead)"
  if [ -n "$default" ]; then
    read -r -p "${prompt} [${default}]: " answer
    answer="${answer:-$default}"
  else
    read -r -p "${prompt}: " answer
  fi
  printf -v "$var" '%s' "$answer"
}

# ask_secret VAR "prompt" [FILE_ENV]   (hidden input; empty allowed)
# When the environment variable named FILE_ENV holds a path, the value is read from that file
# instead (for runs without a terminal; keep the file mode 600 and delete it afterwards).
ask_secret() {
  local var="$1" prompt="$2" file_env="${3:-}" answer
  if [ -n "$file_env" ] && [ -n "${!file_env:-}" ]; then
    [ -r "${!file_env}" ] || die "${file_env} points to a file that cannot be read"
    answer="$(cat "${!file_env}")" || die "cannot read the file named by ${file_env}"
    printf -v "$var" '%s' "$answer"
    return 0
  fi
  [ -r /dev/tty ] || die "need a terminal for hidden input: ${prompt}${file_env:+ (or set ${file_env} to a file path)}"
  read -r -s -p "${prompt}: " answer </dev/tty
  printf '\n' >&2
  printf -v "$var" '%s' "$answer"
}

# ---- settings file ----------------------------------------------------------
is_setting_key() {
  local k
  for k in "${GCP_SETTING_KEYS[@]}"; do [ "$k" != "$1" ] || return 0; done
  return 1
}

# write_setting KEY VALUE: set KEY in settings.env (creating the file). settings.env is
# sourced by bash, so the value is limited to characters that cannot run code.
# Call reload_settings afterwards to see the new value.
write_setting() {
  local key="$1" value="$2" tmp
  is_setting_key "$key" || die "'${key}' is not a setting (see deploy/gcp/settings.env.example)"
  [[ "$value" =~ ^[A-Za-z0-9\ ._:/,@+=-]*$ ]] || die "setting ${key} has characters that are not allowed in settings.env"
  tmp="$(mktemp)"
  if [ -f "$SETTINGS_FILE" ]; then
    grep -v "^${key}=" "$SETTINGS_FILE" >"$tmp" || true
  fi
  printf '%s="%s"\n' "$key" "$value" >>"$tmp"
  mv "$tmp" "$SETTINGS_FILE"
}

# reload_settings: re-read settings.env after write_setting. Explicit environment
# values still win; constants are not touched.
reload_settings() { load_settings; }

# ---- validation (all before any mutation) -----------------------------------
valid_project_id() { [[ "$1" =~ ^[a-z][a-z0-9-]{4,28}[a-z0-9]$ ]]; }
valid_domain() { [[ "$1" =~ ^([a-z0-9]([a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$ ]]; }
is_uint() { [[ "$1" =~ ^[0-9]+$ ]]; }

# valid_cidr 203.0.113.7/32 | 2001:db8::/32: true for a network address with a numeric
# prefix and no host bits set (203.0.113.7/24 is rejected). Parsing is done by python3's
# ipaddress module (python3 ships with macOS); the caller must have checked python3 exists.
valid_cidr() {
  [[ "$1" == */* ]] && is_uint "${1##*/}" || return 1
  python3 -I -c 'import ipaddress, sys; ipaddress.ip_network(sys.argv[1], strict=True)' "$1" >/dev/null 2>&1
}

# validate_cidrs "a b c": die unless every word is a CIDR and there are at most 50.
validate_cidrs() {
  local c n=0
  command -v python3 >/dev/null 2>&1 || die "missing tool: python3 (used to validate CIDRs). Install: $(install_hint python3)"
  for c in $1; do
    valid_cidr "$c" || die "'${c}' is not a network in CIDR form like 203.0.113.7/32 (host bits must be zero)"
    n=$((n + 1))
  done
  [ "$n" -le 50 ] || die "${n} allowed ranges; the cluster API accepts at most 50"
}

validate_settings() {
  [[ "$REGION" =~ ^[a-z]+-[a-z]+[0-9]+$ ]] || die "REGION '${REGION}' does not look like us-central1"
  case "$AUTOSCALER" in hpa | keda) ;; *) die "AUTOSCALER must be hpa or keda (is '${AUTOSCALER}')" ;; esac
  is_uint "$MIN_REPLICAS" && [ "$MIN_REPLICAS" -ge 1 ] || die "MIN_REPLICAS must be a whole number >= 1 (is '${MIN_REPLICAS}')"
  is_uint "$MAX_REPLICAS" && [ "$MAX_REPLICAS" -ge "$MIN_REPLICAS" ] \
    || die "MAX_REPLICAS must be a whole number >= MIN_REPLICAS (${MAX_REPLICAS} vs ${MIN_REPLICAS})"
  is_uint "$PDB_MIN_AVAILABLE" && [ "$PDB_MIN_AVAILABLE" -lt "$MIN_REPLICAS" ] \
    || die "PDB_MIN_AVAILABLE must be a whole number below MIN_REPLICAS, or node upgrades would stall (${PDB_MIN_AVAILABLE} vs ${MIN_REPLICAS})"
  is_uint "$PG_INSTANCES" && [ "$PG_INSTANCES" -ge 1 ] || die "PG_INSTANCES must be a whole number >= 1 (is '${PG_INSTANCES}')"
  [ -z "$DNS_ZONE" ] || [[ "$DNS_ZONE" =~ ^[a-z]([-a-z0-9]*[a-z0-9])?$ ]] || die "DNS_ZONE '${DNS_ZONE}' is not a Cloud DNS zone name"
  [[ "$TENANT_NAME" =~ ^[A-Za-z0-9._-]+$ ]] || die "TENANT_NAME may contain letters, digits, dot, underscore, hyphen"
  local m
  for m in "$OPENAI_MODEL" "$ANTHROPIC_MODEL" "$VERTEX_MODEL"; do
    [[ "$m" =~ ^[A-Za-z0-9._:/-]+$ ]] || die "model id '${m}' has characters that are not allowed"
  done
  [ -z "$TEAM_CIDRS" ] || validate_cidrs "$TEAM_CIDRS"
}

require_settings() {
  [ -n "$PROJECT_ID" ] || die "PROJECT_ID is not set (run scripts/gcp/up.sh, or edit deploy/gcp/settings.env)"
  [ -n "$DOMAIN" ] || die "DOMAIN is not set (run scripts/gcp/up.sh, or edit deploy/gcp/settings.env)"
  valid_project_id "$PROJECT_ID" || die "PROJECT_ID '${PROJECT_ID}' is not a valid project id"
  valid_domain "$DOMAIN" || die "DOMAIN '${DOMAIN}' is not a valid host name"
  validate_settings
}

# ---- tools and versions -----------------------------------------------------
ver_ge() { # ver_ge have want  -> true when have >= want
  [ "$(printf '%s\n%s\n' "$2" "$1" | sort -V | head -n1)" = "$2" ]
}

install_hint() { # install_hint tool -> how to get it
  case "$1" in
    tofu) echo "brew install opentofu" ;;
    kubectl) echo "brew install kubernetes-cli" ;;
    helm) echo "brew install helm" ;;
    jq) echo "brew install jq" ;;
    openssl) echo "brew install openssl" ;;
    bash) echo "brew install bash (installs bash 5.x)" ;;
    python3) echo "xcode-select --install (or brew install python)" ;;
    dig) echo "brew install bind" ;;
    git | curl) echo "xcode-select --install (or brew install $1)" ;;
    gcloud) echo "install the Google Cloud SDK: https://cloud.google.com/sdk/docs/install" ;;
    gke-gcloud-auth-plugin) echo "gcloud components install gke-gcloud-auth-plugin" ;;
    *) echo "install it and put it on PATH" ;;
  esac
}

upgrade_hint() {
  case "$1" in
    tofu) echo "brew upgrade opentofu" ;;
    kubectl) echo "brew upgrade kubernetes-cli" ;;
    helm) echo "brew upgrade helm" ;;
    gcloud) echo "gcloud components update" ;;
    *) echo "upgrade it" ;;
  esac
}

# need_tool NAME: in a dry run a missing tool is a warning, otherwise fatal.
need_tool() {
  if command -v "$1" >/dev/null 2>&1; then return 0; fi
  if is_dry; then
    warn "missing tool: $1. Install: $(install_hint "$1")"
    return 0
  fi
  die "missing tool: $1. Install: $(install_hint "$1")"
}

require_tools() {
  local t
  for t in "$@"; do need_tool "$t"; done
}

too_old() { die "$1 $2 is too old (need >= $3). Upgrade: $(upgrade_hint "$1")"; }

check_versions() {
  local v
  if command -v tofu >/dev/null 2>&1; then
    v="$(tofu version -json | jq -r .terraform_version)"
    ver_ge "$v" "$MIN_TOFU_VERSION" || too_old tofu "$v" "$MIN_TOFU_VERSION"
  fi
  if command -v kubectl >/dev/null 2>&1; then
    v="$(kubectl version --client -o json | jq -r .clientVersion.gitVersion)"
    ver_ge "${v#v}" "$MIN_KUBECTL_VERSION" || too_old kubectl "$v" "$MIN_KUBECTL_VERSION"
  fi
  if command -v gcloud >/dev/null 2>&1; then
    v="$(gcloud version --format='value("Google Cloud SDK")' 2>/dev/null || true)"
    [ -z "$v" ] || ver_ge "$v" "$MIN_GCLOUD_VERSION" || too_old gcloud "$v" "$MIN_GCLOUD_VERSION"
  fi
  if command -v helm >/dev/null 2>&1; then
    v="$(helm version --template '{{.Version}}')"
    ver_ge "${v#v}" "$MIN_HELM_VERSION" || too_old helm "$v" "$MIN_HELM_VERSION"
  fi
}

# preflight: tools and versions always; auth and billing unless a dry run.
preflight() {
  require_tools gcloud tofu kubectl helm jq curl git openssl python3 gke-gcloud-auth-plugin
  check_versions
  command -v dig >/dev/null 2>&1 || warn "dig not found; DNS polling will use curl instead (optional: $(install_hint dig))"
  is_dry && return 0
  gcloud auth list --filter=status:ACTIVE --format='value(account)' | grep -q . \
    || die "not logged in. Run: gcloud auth login"
  gcloud auth application-default print-access-token >/dev/null 2>&1 \
    || die "no application default credentials (tofu needs them). Run: gcloud auth application-default login"
}

require_clean_tree() {
  if ! git -C "$ROOT" diff --quiet || ! git -C "$ROOT" diff --cached --quiet; then
    die "working tree has uncommitted changes; commit or stash first (the image tag is the git SHA)"
  fi
  [ -z "$(git -C "$ROOT" ls-files --others --exclude-standard)" ] \
    || die "working tree has untracked files; commit, stash or remove them"
}

git_sha() { git -C "$ROOT" rev-parse --short=12 HEAD; }

# ---- kubectl ----------------------------------------------------------------
# A dedicated kubeconfig keeps these scripts from touching your other contexts.
# To use kubectl by hand:  export KUBECONFIG="$HOME/.config/llm-proxy/kubeconfig"
use_cluster() {
  export KUBECONFIG="${LLM_KUBECONFIG:-${HOME}/.config/llm-proxy/kubeconfig}"
  mkdir -p "$(dirname "$KUBECONFIG")"
  gcloud container clusters get-credentials "$CLUSTER" \
    --region "$REGION" --project "$PROJECT_ID" >/dev/null 2>&1 \
    || die "cannot get credentials for cluster ${CLUSTER} (not created yet, or your IP is not in TEAM_CIDRS)"
}

# is_not_found "text from kubectl or gcloud": true when the text says the thing does not exist.
is_not_found() { printf '%s' "$1" | grep -qiE 'NotFound|NOT_FOUND|not found|does not exist'; }

# run_status OUT_VAR cmd args...: run a command, put its stdout+stderr in OUT_VAR, and return
#   0 success, 44 the text says the thing does not exist (NotFound), 1 any other failure.
# Use it for every mutation or lookup where "already gone" is fine but "denied" is not.
run_status() {
  local -n _rs_out="$1"
  shift
  if _rs_out="$("$@" 2>&1)"; then return 0; fi
  if is_not_found "$_rs_out"; then return 44; fi
  return 1
}

# valid_pitr_time "YYYY-MM-DD HH:MM:SS+00"
valid_pitr_time() { [[ "$1" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}\ [0-9]{2}:[0-9]{2}:[0-9]{2}\+00$ ]]; }

# gcs_prefix_state URL: prints "empty" or "present" for a gs:// prefix; returns 1 (message on
# stderr) when it cannot be read (denied, no such bucket, network), so an error is never
# mistaken for "empty". Read-only.
gcs_prefix_state() {
  local out
  if out="$(gcloud storage ls "$1" --project "$PROJECT_ID" 2>&1)"; then
    if [ -n "$out" ]; then echo present; else echo empty; fi
    return 0
  fi
  if printf '%s' "$out" | grep -qi 'matched no objects'; then
    echo empty
    return 0
  fi
  printf 'cannot read %s: %s\n' "$1" "$out" >&2
  return 1
}

# Setup progress lives in ConfigMap llm-setup so up.sh can skip finished work quickly.
# setup_get KEY: prints the value; prints nothing when the key or the ConfigMap is
# missing (status 0). Any other failure (network, permission) returns 2, so a read
# error is never mistaken for "not done".
setup_get() {
  local out
  if ! out="$(kubectl -n "$NAMESPACE" get configmap llm-setup -o json 2>&1)"; then
    is_not_found "$out" && return 0
    printf 'ERROR: cannot read ConfigMap llm-setup: %s\n' "$out" >&2
    return 2
  fi
  printf '%s' "$out" | jq -r --arg k "$1" '.data[$k] // empty'
}

setup_set() { # setup_set key value
  local out patch
  if ! out="$(kubectl -n "$NAMESPACE" get configmap llm-setup -o name 2>&1)"; then
    is_not_found "$out" || die "cannot read ConfigMap llm-setup: ${out}"
    kubectl -n "$NAMESPACE" create configmap llm-setup >/dev/null
  fi
  patch="$(jq -nc --arg k "$1" --arg v "$2" '{data: {($k): $v}}')"
  kubectl -n "$NAMESPACE" patch configmap llm-setup --type merge -p "$patch" >/dev/null
}

# step_done KEY: true when the marker is "done". A failed read stops the script.
step_done() {
  local value
  value="$(setup_get "$1")" || die "cannot tell whether step '$1' is done (see the error above)"
  [ "$value" = "done" ]
}
mark_step_done() { setup_set "$1" "done"; }

# ---- Secret Manager ---------------------------------------------------------
# Fails loudly: never returns an empty value. Use as a plain assignment:
#   VAR="$(read_secret name)" || die "..."
# (not `local VAR="$(...)"`, which hides the exit status). Inside $(...) the die
# below only ends the subshell, so callers must check the assignment status.
read_secret() {
  local value
  value="$(gcloud secrets versions access latest --secret "$1" --project "$PROJECT_ID")" \
    || die "cannot read secret $1 (permission, network, or no version yet)"
  [ -n "$value" ] || die "secret $1 is empty"
  printf '%s' "$value"
}

# secret_has_version NAME: 0 yes, 1 no. Any error other than "no versions" is fatal.
secret_has_version() {
  local listing
  listing="$(gcloud secrets versions list "$1" --project "$PROJECT_ID" --limit 1 \
    --filter 'state=ENABLED' --format 'value(name)')" \
    || die "cannot list versions of secret $1 (does it exist? has tofu run?)"
  [ -n "$listing" ]
}

# secret_add_version NAME: new version from stdin (never from argv). Prints the version
# resource name; returns gcloud's status.
secret_add_version() {
  gcloud secrets versions add "$1" --project "$PROJECT_ID" --data-file=- --format='value(name)'
}

# secret_try_add NAME: like secret_add_version, discarding the output. Returns the status.
secret_try_add() {
  secret_add_version "$1" >/dev/null
}

# secret_add NAME: like secret_try_add, but a failure ends the script.
secret_add() {
  secret_try_add "$1" || die "cannot add a version to secret $1"
}

# ---- OpenTofu ---------------------------------------------------------------
tf_dir() { printf '%s/%s' "$TF_ROOT" "$1"; }

tofu_out() { # tofu_out stack name -> JSON value
  tofu -chdir="$(tf_dir "$1")" output -json "$2"
}

# ---- manifests --------------------------------------------------------------
# render <kustomize dir | yaml file>: fill __NAME__ placeholders, then fail if
# any remain. Each token is unique, so no placeholder matches inside another.
render() {
  local raw out left rtime=""
  [ -z "${RECOVERY_TIME:-}" ] || rtime="\"${RECOVERY_TIME}\"" # kustomize drops the quotes; YAML needs them
  if [ -d "$1" ]; then raw="$(kubectl kustomize "$1")"; else raw="$(cat "$1")"; fi
  out="$(printf '%s\n' "$raw" | sed \
    -e "s|__IMAGE__|${IMAGE:-__IMAGE__}|g" \
    -e "s|__DOMAIN__|${DOMAIN}|g" \
    -e "s|__APP_GSA__|${APP_GSA}|g" \
    -e "s|__BACKUP_GSA__|${BACKUP_GSA}|g" \
    -e "s|__RESTORE_GSA__|${RESTORE_GSA}|g" \
    -e "s|__BACKUP_BUCKET__|${BACKUP_BUCKET}|g" \
    -e "s|__POSTGRES_IMAGE__|${CNPG_POSTGRES_IMAGE}|g" \
    -e "s|__PG_INSTANCES__|${PG_INSTANCES}|g" \
    -e "s|__MIN_REPLICAS__|${MIN_REPLICAS}|g" \
    -e "s|__MAX_REPLICAS__|${MAX_REPLICAS}|g" \
    -e "s|__PDB_MIN_AVAILABLE__|${PDB_MIN_AVAILABLE}|g" \
    -e "s|__ARCHIVE_SERVER__|${ARCHIVE_SERVER:-__ARCHIVE_SERVER__}|g" \
    -e "s|__RECOVERY_SERVER__|${RECOVERY_SERVER:-__RECOVERY_SERVER__}|g" \
    -e "s|__RECOVERY_TIME__|${rtime:-__RECOVERY_TIME__}|g")"
  left="$(printf '%s\n' "$out" | grep -oE '__[A-Z0-9_]+__' | sort -u || true)"
  [ -z "$left" ] || die "unresolved placeholders in ${1}: $(printf '%s' "$left" | tr '\n' ' ')"
  printf '%s\n' "$out"
}

# ---- operator CLI (runs inside a running app pod) ---------------------------
cli_pod() {
  local pod
  pod="$(kubectl -n "$NAMESPACE" get pods -l app=llm-proxy \
    --field-selector=status.phase=Running -o name | head -n1)"
  [ -n "$pod" ] || die "no running llm-proxy pod"
  printf '%s' "${pod#pod/}"
}

# cli_run args...: no stdin forwarded; stdout is the CLI's JSON.
cli_run() {
  local pod
  pod="$(cli_pod)"
  kubectl -n "$NAMESPACE" exec "$pod" -c llm-proxy -- node dist/cli.js "$@" </dev/null
}

# cli_run_stdin args...: forwards this process's stdin (pipe a secret in).
# Secrets go through stdin only; command-line flags land in the Kubernetes audit log.
cli_run_stdin() {
  local pod
  pod="$(cli_pod)"
  kubectl -n "$NAMESPACE" exec -i "$pod" -c llm-proxy -- node dist/cli.js "$@"
}

public_ip() {
  local ip
  ip="$(curl -fsS --max-time 10 https://api.ipify.org 2>/dev/null || curl -fsS --max-time 10 https://checkip.amazonaws.com 2>/dev/null || true)"
  ip="$(printf '%s' "$ip" | tr -d '[:space:]')"
  if [[ "$ip" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
    printf '%s/32' "$ip"
  elif [[ "$ip" == *:* ]]; then
    printf '%s/128' "$ip"
  else
    return 1
  fi
}
