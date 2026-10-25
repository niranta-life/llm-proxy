#!/usr/bin/env bash
# Step 3: cluster credentials and in-cluster operators (cert-manager, CloudNativePG,
# the barman-cloud backup plugin, and KEDA only if AUTOSCALER=keda).
# Safe to repeat. A Helm release is skipped only when it is deployed, at the pinned chart
# version, and its workloads are Available; a failed release is upgraded; a release stuck
# in pending-* or unknown state stops the script with instructions.
source "$(dirname "$0")/common.sh"
help_if_asked "$@"
require_settings

log "Step: cluster operators"
will "get credentials for cluster ${CLUSTER} into a dedicated kubeconfig"
will "helm install cert-manager ${CERT_MANAGER_CHART_VERSION} and cloudnative-pg ${CNPG_CHART_VERSION} (skipped if deployed, at that version, and Available)"
will "kubectl apply barman-cloud plugin ${BARMAN_PLUGIN_VERSION} (skipped if already at that version and Available)"
[ "$AUTOSCALER" != "keda" ] || will "helm install keda ${KEDA_CHART_VERSION}"
stop_if_dry

use_cluster
kubectl apply -f "${DEPLOY_DIR}/k8s/platform/namespace.yaml" >/dev/null

# release_field NAME NAMESPACE FIELD: a field of the Helm release ("" when there is none).
release_field() {
  local listing
  listing="$(helm list -n "$2" --all --filter "^${1}\$" -o json)" || die "helm list failed for ${1}"
  printf '%s' "$listing" | jq -r --arg f "$3" '.[0][$f] // empty'
}

# helm_ensure NAME REPO_NAME REPO_URL CHART VERSION NAMESPACE [extra helm args...]
helm_ensure() {
  local name="$1" repo="$2" url="$3" chart="$4" version="$5" ns="$6" status have
  shift 6
  status="$(release_field "$name" "$ns" status)"
  have="$(release_field "$name" "$ns" chart)"
  case "$status" in
    deployed)
      if { [ "$have" = "${chart##*/}-${version}" ] || [ "$have" = "${chart##*/}-${version#v}" ]; } \
        && kubectl -n "$ns" wait --for=condition=Available deployment \
          -l "app.kubernetes.io/instance=${name}" --timeout=60s >/dev/null 2>&1; then
        ok "${name} deployed at ${version} and Available"
        return 0
      fi
      log "${name}: deployed as '${have}' but not at ${version} or not Available; upgrading"
      ;;
    failed) log "${name}: previous release failed; upgrading" ;;
    "") ;;
    *)
      die "helm release ${name} is stuck in status '${status}'. Remove it, then re-run: helm uninstall ${name} -n ${ns} (add --no-hooks if that hangs)"
      ;;
  esac
  helm repo add "$repo" "$url" >/dev/null 2>&1 || true
  helm repo update "$repo" >/dev/null
  helm upgrade --install "$name" "$chart" --version "$version" \
    --namespace "$ns" --create-namespace --wait --timeout 10m "$@"
}

# Not yet verified on a live cluster: see "Verify first" U5 in docs/gcp-deployment.md.
# Autopilot restricts kube-system, so cert-manager keeps its leader election in its own namespace.
helm_ensure cert-manager jetstack https://charts.jetstack.io jetstack/cert-manager \
  "$CERT_MANAGER_CHART_VERSION" cert-manager \
  --set crds.enabled=true --set global.leaderElection.namespace=cert-manager

helm_ensure cnpg cnpg https://cloudnative-pg.github.io/charts cnpg/cloudnative-pg \
  "$CNPG_CHART_VERSION" cnpg-system

# The barman-cloud plugin has no known Helm chart, so it is applied from its release manifest.
# Not yet verified on a live cluster: see "Verify first" U5 in docs/gcp-deployment.md.
recorded="$(setup_get barman-plugin)" || die "cannot read the recorded barman plugin version"
if [ "$recorded" = "$BARMAN_PLUGIN_VERSION" ] \
  && kubectl -n cnpg-system wait --for=condition=Available deployment/barman-cloud --timeout=60s >/dev/null 2>&1; then
  ok "barman-cloud plugin at ${BARMAN_PLUGIN_VERSION} and Available"
else
  kubectl apply -f "https://github.com/cloudnative-pg/plugin-barman-cloud/releases/download/${BARMAN_PLUGIN_VERSION}/manifest.yaml"
  kubectl -n cnpg-system rollout status deploy/barman-cloud --timeout=300s
  setup_set barman-plugin "$BARMAN_PLUGIN_VERSION"
fi

if [ "$AUTOSCALER" = "keda" ]; then
  helm_ensure keda kedacore https://kedacore.github.io/charts kedacore/keda \
    "$KEDA_CHART_VERSION" keda
fi
