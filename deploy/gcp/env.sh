#!/usr/bin/env bash
# Sourced by every script in scripts/gcp. Edit settings.env (or answer the up.sh
# prompts), not this file, unless you are bumping a pinned version.
#
# Two parts, on purpose:
#   1. constants   fixed names and pinned versions. Set once per process (guarded,
#                  because `readonly` variables cannot be assigned twice).
#   2. load_settings   reads settings.env, applies defaults, derives names. Safe to
#                  call again after settings.env changes (see reload_settings).
#
# Precedence for a setting: value in the environment when the process started >
# settings.env > default. That keeps `PROJECT_ID=x scripts/gcp/up.sh` and the tests
# working, and it survives a reload.
# shellcheck shell=bash disable=SC2034

_GCP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SETTINGS_FILE="${GCP_SETTINGS_FILE:-${_GCP_DIR}/settings.env}"

# ---- 1. constants (set once) -------------------------------------------------
if [ -z "${GCP_CONSTANTS_LOADED:-}" ]; then
  # Fixed names: tofu and the manifests use the same ones.
  readonly CLUSTER="llm-proxy"
  readonly NAMESPACE="llm-proxy"
  readonly REPO="llm-proxy"
  readonly IMAGE_NAME="llm-proxy"
  readonly STATE_PREFIX="llm-proxy" # each OpenTofu stack adds /persistent or /platform

  # The names a user may set in settings.env.
  readonly GCP_SETTING_KEYS=(PROJECT_ID DOMAIN BILLING_ACCOUNT REGION TEAM_CIDRS DNS_ZONE
    AUTOSCALER MIN_REPLICAS MAX_REPLICAS PDB_MIN_AVAILABLE PG_INSTANCES
    TENANT_NAME OPENAI_MODEL ANTHROPIC_MODEL VERTEX_MODEL)

  # ---- pinned versions ----
  # Checked on 2026-10-22 against the upstream index or release list (network read):
  #   cert-manager chart v1.21.2 (charts.jetstack.io index, = GitHub latest)
  #   cloudnative-pg chart 0.29.1 / operator 1.30.1 (cloudnative-pg.github.io index)
  #   barman-cloud plugin v0.15.1 (GitHub latest release; manifest fetched, CRD checked)
  #   postgresql image 16.15-standard-bookworm (tag exists on ghcr.io)
  # Not yet verified on a live cluster: see "Verify first" U5 in docs/gcp-deployment.md.
  # Not checked at all: the KEDA chart version (taken from the GitHub release tag).
  readonly CERT_MANAGER_CHART_VERSION="v1.21.2"
  readonly CNPG_CHART_VERSION="0.29.1"
  readonly BARMAN_PLUGIN_VERSION="v0.15.1"
  readonly CNPG_POSTGRES_IMAGE="ghcr.io/cloudnative-pg/postgresql:16.15-standard-bookworm" # must stay major 16
  readonly KEDA_CHART_VERSION="2.21.0"

  # ---- minimum tool versions ----
  readonly MIN_TOFU_VERSION="1.8"
  readonly MIN_KUBECTL_VERSION="1.28"
  readonly MIN_HELM_VERSION="3.12"
  readonly MIN_GCLOUD_VERSION="450.0.0"

  GCP_CONSTANTS_LOADED=1
fi

# ---- remember what was set in the environment when the process started -------
if [ -z "${_GCP_ENV_SNAPSHOT:-}" ]; then
  for _key in "${GCP_SETTING_KEYS[@]}"; do
    if [ -n "${!_key:-}" ]; then printf -v "_EXPLICIT_${_key}" '%s' "${!_key}"; fi
  done
  unset _key
  _GCP_ENV_SNAPSHOT=1
fi

# ---- 2. the settings loader (repeatable) ------------------------------------
load_settings() {
  local key explicit
  for key in "${GCP_SETTING_KEYS[@]}"; do unset "$key"; done

  if [ -f "$SETTINGS_FILE" ]; then
    # shellcheck source=/dev/null
    source "$SETTINGS_FILE"
  fi
  for key in "${GCP_SETTING_KEYS[@]}"; do
    explicit="_EXPLICIT_${key}"
    # shellcheck disable=SC2163 # export by name, on purpose
    # Exported again so child scripts (up.sh runs the others) see the explicit value too.
    if [ -n "${!explicit:-}" ]; then printf -v "$key" '%s' "${!explicit}" && export "$key"; fi
  done

  # defaults
  PROJECT_ID="${PROJECT_ID:-}"
  DOMAIN="${DOMAIN:-}"
  BILLING_ACCOUNT="${BILLING_ACCOUNT:-}"
  REGION="${REGION:-us-central1}"
  TEAM_CIDRS="${TEAM_CIDRS:-}" # up.sh fills this with your public IP after you confirm
  DNS_ZONE="${DNS_ZONE:-}"
  AUTOSCALER="${AUTOSCALER:-hpa}"
  MIN_REPLICAS="${MIN_REPLICAS:-1}"
  MAX_REPLICAS="${MAX_REPLICAS:-4}"
  PDB_MIN_AVAILABLE="${PDB_MIN_AVAILABLE:-0}"
  PG_INSTANCES="${PG_INSTANCES:-2}"
  TENANT_NAME="${TENANT_NAME:-default}"
  OPENAI_MODEL="${OPENAI_MODEL:-gpt-4o-mini}"
  ANTHROPIC_MODEL="${ANTHROPIC_MODEL:-claude-sonnet-4-5}"
  VERTEX_MODEL="${VERTEX_MODEL:-gemini-2.5-flash}" # model ids may be retired: U14 in docs/gcp-deployment.md

  # derived from PROJECT_ID / REGION
  REGISTRY="${REGION}-docker.pkg.dev/${PROJECT_ID}/${REPO}"
  STATE_BUCKET="${PROJECT_ID}-tfstate"
  BACKUP_BUCKET="${PROJECT_ID}-llm-pg-backup"
  STAGING_BUCKET="${PROJECT_ID}-llm-build-staging"
  APP_GSA="llm-proxy-app@${PROJECT_ID}.iam.gserviceaccount.com"
  BACKUP_GSA="llm-pg-backup@${PROJECT_ID}.iam.gserviceaccount.com"
  RESTORE_GSA="llm-pg-restore@${PROJECT_ID}.iam.gserviceaccount.com"
  BUILD_SA="llm-proxy-build@${PROJECT_ID}.iam.gserviceaccount.com"
}

load_settings
