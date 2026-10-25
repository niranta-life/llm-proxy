#!/usr/bin/env bash
# One command from an empty project to a working, smoke-tested llm-proxy on GCP.
# Safe to repeat: finished steps are skipped or only checked. On a re-run it still asks
# "Go ahead?" and "Continue?" (--yes skips both), re-applies the manifests, and runs the
# smoke tests, which make small billable calls to your providers (--skip-smoke skips them).
#
#   scripts/gcp/up.sh              interactive; asks once for what it cannot guess
#   scripts/gcp/up.sh --dry-run    print every step and what it would do; run nothing
#   scripts/gcp/up.sh --yes        skip the confirmation prompts (not the key prompts, and
#                                  not the typed confirmation for a plan that destroys things)
#   scripts/gcp/up.sh --skip-smoke do not run smoke.sh at the end
#
# Needs PROJECT_ID and DOMAIN (environment or deploy/gcp/settings.env, else it asks), and
# asks which IP addresses may reach the API (default: this machine). See settings.env.example.
# Before the first run:  gcloud auth login ; gcloud auth application-default login
# and commit deploy/gcp and scripts/gcp (the deploy refuses a dirty git tree).
source "$(dirname "$0")/common.sh"

DRY_RUN="${DRY_RUN:-0}"
SKIP_SMOKE="${SKIP_SMOKE:-0}"
YES="${YES:-0}"
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=1 ;;
    --yes | -y) YES=1 ;;
    --skip-smoke) SKIP_SMOKE=1 ;;
    -h | --help)
      show_usage
      exit 0
      ;;
    *)
      echo "unknown option: $arg (try --help)" >&2
      exit 2
      ;;
  esac
done
export DRY_RUN YES

# ---- 1. settings: ask once, remember in deploy/gcp/settings.env --------------
if [ -z "$PROJECT_ID" ] || [ -z "$DOMAIN" ]; then
  if is_dry; then
    die "dry run needs PROJECT_ID and DOMAIN, e.g.  PROJECT_ID=demo-llm DOMAIN=llm.example.com scripts/gcp/up.sh --dry-run"
  fi
  log "First run: two questions. Answers are saved to deploy/gcp/settings.env."
  if [ -z "$PROJECT_ID" ]; then
    ask PROJECT_ID "GCP project id (existing, or a new id to create)"
    valid_project_id "$PROJECT_ID" || die "'${PROJECT_ID}' is not a valid project id"
    write_setting PROJECT_ID "$PROJECT_ID"
  fi
  if [ -z "$DOMAIN" ]; then
    ask DOMAIN "Public host name (for example llm.example.com)"
    valid_domain "$DOMAIN" || die "'${DOMAIN}' is not a valid host name"
    write_setting DOMAIN "$DOMAIN"
  fi
  reload_settings
fi
require_settings

# ---- 2. preflight -------------------------------------------------------------
log "Preflight"
preflight

if ! is_dry && ! gcloud projects describe "$PROJECT_ID" >/dev/null 2>&1 && [ -z "$BILLING_ACCOUNT" ]; then
  log "Project ${PROJECT_ID} does not exist yet. To create it I need a billing account."
  gcloud billing accounts list --filter=open=true --format='table(name,displayName)' 2>/dev/null || true
  ask BILLING_ACCOUNT "Billing account id (blank = stop and create the project yourself)" ""
  [ -n "$BILLING_ACCOUNT" ] || die "create the project first, then re-run"
  [[ "$BILLING_ACCOUNT" =~ ^[A-Z0-9]{6}-[A-Z0-9]{6}-[A-Z0-9]{6}$ ]] || die "'${BILLING_ACCOUNT}' is not a billing account id like 0123AB-456CDE-789FGH"
  write_setting BILLING_ACCOUNT "$BILLING_ACCOUNT"
  reload_settings
fi

# ---- 3. who may reach it: default to this machine's public IP ------------------
if [ -z "$TEAM_CIDRS" ]; then
  if is_dry; then
    TEAM_CIDRS="<your public IP>/32"
    log "[dry-run] TEAM_CIDRS would default to this machine's public IP"
  else
    detected="$(public_ip)" || die "cannot detect your public IP; set TEAM_CIDRS in deploy/gcp/settings.env"
    log "Only these addresses will reach the API and the cluster: ${detected}"
    ask TEAM_CIDRS "Allowed IP ranges, space separated" "$detected"
    validate_cidrs "$TEAM_CIDRS"
    write_setting TEAM_CIDRS "$TEAM_CIDRS"
    reload_settings
  fi
elif ! is_dry; then
  current="$(public_ip || true)"
  case " ${TEAM_CIDRS} " in
    *" ${current} "*) ;;
    *) [ -z "$current" ] || warn "your current IP ${current} is not in TEAM_CIDRS; smoke tests and kubectl will be blocked. Fix: scripts/gcp/add-team-ip.sh" ;;
  esac
fi

# ---- 4. summary ----------------------------------------------------------------
cat >&2 <<SUMMARY

  Project      ${PROJECT_ID}  (${REGION})
  Endpoint     https://${DOMAIN}
  Allowed IPs  ${TEAM_CIDRS}
  DNS          $([ -n "$DNS_ZONE" ] && echo "Cloud DNS zone ${DNS_ZONE} (managed here)" || echo "by hand: I will print the records")
  App          min ${MIN_REPLICAS} / max ${MAX_REPLICAS} replicas, ${AUTOSCALER}
  Database     ${PG_INSTANCES} x Postgres 16 (CloudNativePG)
  Estimated    about 190 to 280 USD per month before provider usage; estimate, see "Verify first" U12 in docs/gcp-deployment.md

SUMMARY
is_dry || confirm "Go ahead?"

# ---- 5. the steps ---------------------------------------------------------------
"${GCP_SCRIPTS_DIR}/bootstrap.sh"
"${GCP_SCRIPTS_DIR}/infra.sh"
"${GCP_SCRIPTS_DIR}/dns.sh" show
"${GCP_SCRIPTS_DIR}/operators.sh"
"${GCP_SCRIPTS_DIR}/secrets.sh"
"${GCP_SCRIPTS_DIR}/database.sh"
SKIP_PUBLIC_CHECK=1 "${GCP_SCRIPTS_DIR}/deploy.sh"
"${GCP_SCRIPTS_DIR}/providers.sh"
"${GCP_SCRIPTS_DIR}/dns.sh" wait
if [ "$SKIP_SMOKE" = 1 ]; then log "smoke tests skipped (--skip-smoke); run scripts/gcp/smoke.sh later"; else "${GCP_SCRIPTS_DIR}/smoke.sh"; fi

if is_dry; then
  log "dry run finished. Nothing was executed."
  exit 0
fi

# ---- 6. result ------------------------------------------------------------------
use_cluster
TENANT_JSON="$(read_secret llm-tenant-default)" || die "cannot read the tenant secret"
TENANT_ID="$(printf '%s' "$TENANT_JSON" | jq -r .tenantId)"
unset TENANT_JSON
cat >&2 <<DONE

  Done.

  Endpoint      https://${DOMAIN}/v1/chat/completions
  Tenant id     ${TENANT_ID}   (send as the X-Tenant-ID header)
  Tenant secret in Secret Manager secret llm-tenant-default (field "secret"):
                gcloud secrets versions access latest --secret llm-tenant-default --project ${PROJECT_ID} | jq -r .secret
  Provider keys in Secret Manager: llm-openai-api-key, llm-anthropic-api-key
  IMPORTANT     Copy secret llm-provider-credential-key to your team vault. Losing it makes
                the stored provider keys unreadable.
  Day 2         see scripts/gcp/README.md
DONE
