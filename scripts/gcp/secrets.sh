#!/usr/bin/env bash
# Step 4: generate any missing secrets into Secret Manager, then copy them into
# Kubernetes Secrets. Values are never printed and never appear on a command line:
# the Secret manifests go to kubectl over stdin. Existing secret versions are never
# replaced. Safe to repeat.
source "$(dirname "$0")/common.sh"
help_if_asked "$@"
require_settings

GENERATED=(llm-migrator-password llm-auth-password llm-runtime-password
  llm-pg-superuser-password llm-provider-credential-key)

log "Step: secrets"
will "add a random first version to each EMPTY secret: ${GENERATED[*]}"
will "copy them into Kubernetes Secrets llm-proxy-secrets and llm-pg-superuser in namespace ${NAMESPACE} (over stdin)"
will "NOT touch existing secret versions. Copy llm-provider-credential-key to your team vault afterwards."
stop_if_dry

{ set +x; } 2>/dev/null

generate() {
  case "$1" in
    llm-provider-credential-key) openssl rand -base64 32 | tr -d '\n' ;;
    *) openssl rand -hex 24 | tr -d '\n' ;;
  esac
}

created_key=0
for name in "${GENERATED[@]}"; do
  if secret_has_version "$name"; then continue; fi
  value="$(generate "$name")" || die "openssl failed while generating ${name}"
  [ -n "$value" ] || die "generated an empty value for ${name}"
  printf '%s' "$value" | secret_add "$name"
  log "${name}: created"
  [ "$name" != "llm-provider-credential-key" ] || created_key=1
done
if [ "$created_key" = 1 ]; then
  warn "llm-provider-credential-key was just created. Losing it makes every stored provider key unreadable: copy it to your team vault now."
fi

use_cluster
# Read everything first; any failure stops here, before the cluster is touched.
MIGRATOR_PW="$(read_secret llm-migrator-password)" || die "cannot read the migrator password"
AUTH_PW="$(read_secret llm-auth-password)" || die "cannot read the auth password"
RUNTIME_PW="$(read_secret llm-runtime-password)" || die "cannot read the runtime password"
CRED_KEY="$(read_secret llm-provider-credential-key)" || die "cannot read the credential key"
SUPER_PW="$(read_secret llm-pg-superuser-password)" || die "cannot read the superuser password"

# The manifests below are written as plain YAML scalars (base64 in `data`), so values must be
# plain characters (hex and base64 from openssl are).
for v in "$MIGRATOR_PW" "$AUTH_PW" "$RUNTIME_PW" "$CRED_KEY" "$SUPER_PW"; do
  [[ "$v" =~ ^[A-Za-z0-9+/=_-]+$ ]] || die "a secret has characters outside A-Z a-z 0-9 + / = _ - ; refusing to put it in a manifest"
done

kubectl apply -f "${DEPLOY_DIR}/k8s/platform/namespace.yaml" >/dev/null

# Server-side apply keeps the plaintext out of the last-applied-configuration annotation.
# The values go in `data` (base64), not `stringData`: with server-side apply `stringData` is
# write-only and converted by the API server, so the field manager never owns it and a re-apply
# cannot tell whether anything changed. printf is a shell builtin and base64 reads stdin, so the
# values never reach any process's argument list.
b64() { printf '%s' "$1" | base64 | tr -d '\n'; }
apply_secret() { kubectl apply --server-side --force-conflicts --field-manager llm-proxy-scripts -f - >/dev/null; }

printf 'apiVersion: v1\nkind: Secret\nmetadata:\n  name: llm-proxy-secrets\n  namespace: %s\ntype: Opaque\ndata:\n  migrator-password: "%s"\n  auth-password: "%s"\n  runtime-password: "%s"\n  provider-credential-key: "%s"\n' \
  "$NAMESPACE" "$(b64 "$MIGRATOR_PW")" "$(b64 "$AUTH_PW")" "$(b64 "$RUNTIME_PW")" "$(b64 "$CRED_KEY")" | apply_secret

# CNPG expects a basic-auth secret with username and password.
printf 'apiVersion: v1\nkind: Secret\nmetadata:\n  name: llm-pg-superuser\n  namespace: %s\ntype: kubernetes.io/basic-auth\ndata:\n  username: "%s"\n  password: "%s"\n' \
  "$NAMESPACE" "$(b64 postgres)" "$(b64 "$SUPER_PW")" | apply_secret

log "Kubernetes secrets are in sync. Restart the app to pick up changed values."
