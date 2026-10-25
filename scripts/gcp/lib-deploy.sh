#!/usr/bin/env bash
# Shared by deploy.sh and rollback.sh. Source this after common.sh; do not run it.
# shellcheck shell=bash

ROLLOUT_TIMEOUT="900s" # above the 750 s startup budget in deployment.yaml
RELEASES_KEPT=20

# resource_condition KIND NAME TYPE -> True, False, or empty
resource_condition() {
  kubectl -n "$NAMESPACE" get "$1" "$2" \
    -o "jsonpath={.status.conditions[?(@.type=='$3')].status}" 2>/dev/null || true
}

# route_ready NAME: true when every parent entry for our Gateway reports Accepted and
# ResolvedRefs as True for the route's CURRENT generation (so a stale status is not trusted).
route_ready() {
  kubectl -n "$NAMESPACE" get httproute "$1" -o json 2>/dev/null | jq -e --arg gw "llm-proxy-gw" --arg ns "$NAMESPACE" '
    .metadata.generation as $g
    | [.status.parents[]? | select(.parentRef.name == $gw and ((.parentRef.namespace // $ns) == $ns))] as $p
    | ($p | length) > 0
      and all($p[]; (.conditions // []) as $c
        | ([$c[] | select(.type == "Accepted" and .status == "True" and .observedGeneration == $g)] | length) == 1
          and ([$c[] | select(.type == "ResolvedRefs" and .status == "True" and .observedGeneration == $g)] | length) == 1)
  ' >/dev/null
}

wait_rollout() {
  kubectl -n "$NAMESPACE" rollout status deploy/llm-proxy --timeout="$ROLLOUT_TIMEOUT" \
    || die "rollout did not finish; old pods keep serving. To undo: scripts/gcp/rollback.sh <previous-sha> (see status.sh)"
}

wait_gateway() {

  for _ in $(seq 1 30); do
    if [ "$(resource_condition gateway llm-proxy-gw Programmed)" = "True" ] \
      && route_ready llm-proxy && route_ready llm-proxy-redirect; then
      ok "Gateway Programmed; HTTPRoutes Accepted and ResolvedRefs"
      return 0
    fi
    sleep 10
  done
  die "Gateway not Programmed or HTTPRoutes not Accepted after 5 minutes (kubectl -n ${NAMESPACE} describe gateway llm-proxy-gw; kubectl -n ${NAMESPACE} describe httproute)"
}

# wait_gone KIND NAME: poll until the object is confirmed gone (NotFound), up to 2 minutes.
# Any other lookup error (network, permission) stops the script: it is not "gone".
wait_gone() {
  local out rc
  for _ in $(seq 1 "${WAIT_GONE_TRIES:-24}"); do
    rc=0
    run_status out kubectl -n "$NAMESPACE" get "$1" "$2" -o name || rc=$?
    case "$rc" in
      44) return 0 ;;
      0) ;;
      *) die "cannot tell whether $1/$2 is gone: ${out}" ;;
    esac
    sleep "${WAIT_GONE_SLEEP:-5}"
  done
  die "$1/$2 still exists after 2 minutes"
}

# keda_installed: 0 when the ScaledObject CRD exists, 1 when it is confirmed absent; any other
# lookup error stops the script (an unreadable API is not "KEDA is absent").
keda_installed() {
  local out rc=0
  run_status out kubectl get crd scaledobjects.keda.sh -o name || rc=$?
  case "$rc" in
    0) return 0 ;;
    44) return 1 ;;
    *) die "cannot check whether KEDA is installed: ${out}" ;;
  esac
}

# apply_autoscaler FILE: HPA and KEDA must never both own the Deployment's replicas.
# Delete the old owner first, wait until it is confirmed gone (KEDA's generated HPA too), then
# apply the new one.
apply_autoscaler() {
  local file="$1"
  if grep -q 'kind: ScaledObject' "$file"; then
    kubectl -n "$NAMESPACE" delete hpa llm-proxy --ignore-not-found
    wait_gone hpa llm-proxy
  elif keda_installed; then
    kubectl -n "$NAMESPACE" delete scaledobject llm-proxy --ignore-not-found
    wait_gone scaledobject llm-proxy
    wait_gone hpa keda-hpa-llm-proxy
  fi
  kubectl -n "$NAMESPACE" apply -f "$file"
}

# apply_bundle PLATFORM_YAML APP_YAML AUTOSCALER_YAML (file paths)
apply_bundle() {
  kubectl apply -f "$1" >/dev/null
  kubectl apply -f "$2"
  apply_autoscaler "$3"
}

bundle_hash() { cat "$1" "$2" "$3" | shasum -a 256 | cut -d' ' -f1; }

# extract_release RECORD_JSON DIR: validate a release record (one ConfigMap as JSON) and write its
# three manifests to DIR/platform.yaml, app.yaml, autoscaler.yaml byte for byte (jq -j adds no
# newline; the stored hash covers exact bytes). Prints the image reference. Dies on a record that
# is missing a field, has a malformed hash or image, or whose manifests do not match the hash.
extract_release() {
  local record="$1" dir="$2" f want have image
  printf '%s' "$record" | jq -e '
    (.metadata.annotations["llm-proxy/sha"] | type == "string" and test("^[0-9a-f]{7,40}$"))
    and (.metadata.annotations["llm-proxy/image"] | type == "string" and test("@sha256:[0-9a-f]{64}$"))
    and (.metadata.annotations["llm-proxy/bundle-sha256"] | type == "string" and test("^[0-9a-f]{64}$"))
    and ([.data["platform.yaml"], .data["app.yaml"], .data["autoscaler.yaml"]] | all(type == "string" and length > 0))
  ' >/dev/null 2>&1 \
    || die "the release record is incomplete or malformed (needs sha, image@sha256 digest, bundle hash, and the three manifests). Pick another release: scripts/gcp/rollback.sh --list"
  for f in platform app autoscaler; do
    printf '%s' "$record" | jq -j --arg k "${f}.yaml" '.data[$k]' >"${dir}/${f}.yaml" \
      || die "cannot extract ${f}.yaml from the release record"
  done
  want="$(printf '%s' "$record" | jq -r '.metadata.annotations["llm-proxy/bundle-sha256"]')"
  have="$(bundle_hash "${dir}/platform.yaml" "${dir}/app.yaml" "${dir}/autoscaler.yaml")"
  [ "$want" = "$have" ] \
    || die "the stored manifests do not match their recorded hash; refusing to apply them. Pick another release: scripts/gcp/rollback.sh --list"
  image="$(printf '%s' "$record" | jq -r '.metadata.annotations["llm-proxy/image"]')"
  printf '%s' "$image"
}

# record_release SHA IMAGE_REF PLATFORM_YAML APP_YAML AUTOSCALER_YAML
# A ConfigMap per verified deploy: the exact manifests, image digest and settings, so
# rollback.sh can put back what ran, not what the current checkout would render.
record_release() {
  local sha="$1" image="$2" name settings hash digest
  name="llm-release-$(date -u +%Y%m%d%H%M%S)-${sha}"
  hash="$(bundle_hash "$3" "$4" "$5")"
  digest="${image#*@}"
  settings="$(jq -nc --arg a "$AUTOSCALER" --arg lo "$MIN_REPLICAS" --arg hi "$MAX_REPLICAS" --arg pdb "$PDB_MIN_AVAILABLE" \
    '{autoscaler: $a, minReplicas: $lo, maxReplicas: $hi, pdbMinAvailable: $pdb}')"
  jq -n --arg name "$name" --arg ns "$NAMESPACE" --arg sha "$sha" --arg image "$image" \
    --arg digest "$digest" --arg hash "$hash" --arg settings "$settings" \
    --rawfile platform "$3" --rawfile app "$4" --rawfile autoscaler "$5" '{
      apiVersion: "v1", kind: "ConfigMap",
      metadata: {name: $name, namespace: $ns, labels: {"app": "llm-proxy-release"},
        annotations: {"llm-proxy/sha": $sha, "llm-proxy/image": $image, "llm-proxy/image-digest": $digest,
          "llm-proxy/bundle-sha256": $hash, "llm-proxy/settings": $settings}},
      data: {"platform.yaml": $platform, "app.yaml": $app, "autoscaler.yaml": $autoscaler}}' \
    | kubectl apply -f - >/dev/null
  ok "release recorded: ${name}"
  prune_releases
}

prune_releases() {
  local names count
  names="$(kubectl -n "$NAMESPACE" get configmap -l app=llm-proxy-release -o name | sort)" || return 0
  count="$(printf '%s\n' "$names" | grep -c . || true)"
  [ "$count" -gt "$RELEASES_KEPT" ] || return 0
  printf '%s\n' "$names" | head -n "$((count - RELEASES_KEPT))" \
    | xargs -n1 kubectl -n "$NAMESPACE" delete >/dev/null
}

# public_check: poll the public readiness URL; returns 0 healthy, 1 not.
public_check() {
  local url="https://${DOMAIN}/health/ready"
  for _ in $(seq 1 12); do
    curl -fsS -o /dev/null --max-time 10 "$url" && return 0
    sleep 10
  done
  return 1
}

warn_public_unreachable() {
  warn "https://${DOMAIN}/health/ready did not return 200. The app rolled out. Check, in order:
  1. DNS: does ${DOMAIN} point at the load balancer? (scripts/gcp/dns.sh show)
  2. Certificate: is it ACTIVE? (scripts/gcp/dns.sh wait)
  3. Your IP: is it in TEAM_CIDRS? (scripts/gcp/add-team-ip.sh)"
}
