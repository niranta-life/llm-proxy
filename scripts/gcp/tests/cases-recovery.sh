#!/usr/bin/env bash
# shellcheck shell=bash disable=SC2181,SC2030,SC2031
# More cases for run.sh (recovery, teardown, fail-closed checks). Sourced by run.sh, which
# provides new_env, check, contains, run_script, GCP and HERE.

# lib CMD: run CMD in a bash that has common.sh, lib-plan.sh, lib-down.sh and lib-deploy.sh loaded.
lib() {
  bash -c "source '${GCP}/common.sh'; source '${GCP}/lib-plan.sh'; source '${GCP}/lib-down.sh'; source '${GCP}/lib-deploy.sh'; require_settings; $1" 2>&1 </dev/null
}
# scratch_tofu: a copy of the tofu stacks so tofu.sh writes its tfvars there, not into the repo.
scratch_tofu() {
  cp -R "${GCP}/../../deploy/gcp/tofu" "${T}/tofu"
  export GCP_TF_ROOT="${T}/tofu" TEAM_CIDRS="203.0.113.7/32"
}

echo "CIDR validation"
for c in "::::/64" "1.2.3.4/24" "1.2.3.4" "10.0.0.0/33" "abc/8"; do
  (
    new_env
    TEAM_CIDRS="$c" bash -c "source '${GCP}/common.sh'; require_settings" >/dev/null 2>&1
    [ $? -ne 0 ]
  ); check "rejects ${c}" $?
done
(
  new_env
  TEAM_CIDRS="10.0.0.0/8 2001:db8::/32" bash -c "source '${GCP}/common.sh'; require_settings" >/dev/null 2>&1
); check "accepts 10.0.0.0/8 and 2001:db8::/32" $?

echo "release record"
(
  new_env
  d="${T}/w"; mkdir -p "$d"
  printf 'kind: A' >"${d}/platform.yaml"          # no trailing newline on purpose
  printf 'kind: B\n\n' >"${d}/app.yaml"
  printf 'kind: C\n' >"${d}/autoscaler.yaml"
  h="$(lib "bundle_hash ${d}/platform.yaml ${d}/app.yaml ${d}/autoscaler.yaml")"
  digest="$(printf 'a%.0s' $(seq 1 64))"
  rec="$(jq -n --arg h "$h" --arg i "reg/img@sha256:${digest}" --rawfile p "${d}/platform.yaml" --rawfile a "${d}/app.yaml" --rawfile c "${d}/autoscaler.yaml" \
    '{metadata:{annotations:{"llm-proxy/sha":"abc1234","llm-proxy/image":$i,"llm-proxy/bundle-sha256":$h}},data:{"platform.yaml":$p,"app.yaml":$a,"autoscaler.yaml":$c}}')"
  mkdir "${T}/out"
  printf '%s' "$rec" >"${T}/rec.json"
  img="$(lib "extract_release \"\$(cat ${T}/rec.json)\" ${T}/out")"
  [ "$img" = "reg/img@sha256:${digest}" ] \
    && cmp "${d}/platform.yaml" "${T}/out/platform.yaml" && cmp "${d}/app.yaml" "${T}/out/app.yaml" && cmp "${d}/autoscaler.yaml" "${T}/out/autoscaler.yaml"
); check "extract gives back the exact bytes (no trailing newline added or lost)" $?
(
  new_env
  mkdir "${T}/out"
  jq -n '{metadata:{annotations:{"llm-proxy/sha":"abc1234"}},data:{}}' >"${T}/rec.json"
  out="$(lib "extract_release \"\$(cat ${T}/rec.json)\" ${T}/out")"
  [ $? -ne 0 ] && contains "$out" "incomplete or malformed"
); check "an incomplete record is refused" $?
(
  new_env
  mkdir "${T}/out"
  digest="$(printf 'b%.0s' $(seq 1 64))"
  jq -n --arg i "reg/img@sha256:${digest}" --arg h "$(printf 'c%.0s' $(seq 1 64))" \
    '{metadata:{annotations:{"llm-proxy/sha":"abc1234","llm-proxy/image":$i,"llm-proxy/bundle-sha256":$h}},data:{"platform.yaml":"x","app.yaml":"y","autoscaler.yaml":"z"}}' >"${T}/rec.json"
  out="$(lib "extract_release \"\$(cat ${T}/rec.json)\" ${T}/out")"
  [ $? -ne 0 ] && contains "$out" "do not match their recorded hash"
); check "a record whose manifests do not match the hash is refused" $?

echo "wait_gone and keda_installed"
(
  new_env
  STUB_HPA=gone WAIT_GONE_SLEEP=0 lib "wait_gone hpa llm-proxy" >/dev/null
); check "NotFound counts as gone" $?
(
  new_env
  STUB_HPA=error WAIT_GONE_SLEEP=0 lib "wait_gone hpa llm-proxy" >"${T}/o"
  [ $? -ne 0 ] && grep -q "cannot tell" "${T}/o"
); check "a lookup error aborts instead of counting as gone" $?
(
  new_env
  STUB_HPA=present WAIT_GONE_TRIES=2 WAIT_GONE_SLEEP=0 lib "wait_gone hpa llm-proxy" >"${T}/o"
  [ $? -ne 0 ] && grep -q "still exists" "${T}/o"
); check "an object that stays is reported" $?
(
  new_env
  STUB_CRD=absent lib "keda_installed" >/dev/null; a=$?
  STUB_CRD=present lib "keda_installed" >/dev/null; b=$?
  STUB_CRD=error lib "keda_installed" >"${T}/o"; c=$?
  [ $a -eq 1 ] && [ $b -eq 0 ] && [ $c -ne 0 ] && grep -q "cannot check whether KEDA" "${T}/o"
); check "CRD lookup: absent=1, present=0, error aborts" $?

echo "plan inspection fails closed"
(
  new_env; scratch_tofu
  echo 'not json' >"${T}/plan.json"
  lib "plan_destroys platform x" >"${T}/o"
  [ $? -ne 0 ] && grep -q "no resource_changes" "${T}/o"
); check "garbage plan JSON aborts (neither yes nor no)" $?
(
  new_env; scratch_tofu
  echo '{"resource_changes":[{"change":{"actions":["delete","create"]}}]}' >"${T}/plan.json"
  lib "plan_destroys platform x" >/dev/null; a=$?
  echo '{"resource_changes":[{"change":{"actions":["update"]}}]}' >"${T}/plan.json"
  lib "plan_destroys platform x" >/dev/null; b=$?
  [ $a -eq 0 ] && [ $b -eq 1 ]
); check "replace detected; update-only is not a destroy" $?

echo "unprotect_cluster"
(
  new_env; scratch_tofu
  lib "unprotect_cluster 0" >/dev/null
  rc=$?
  [ $rc -eq 0 ] && ! grep -q '^tofu' "${T}/calls.log"
); check "cluster absent: no tofu call at all" $?
(
  new_env; scratch_tofu
  echo '{"resource_changes":[{"change":{"actions":["create"]}}]}' >"${T}/plan.json"
  lib "unprotect_cluster 1" >/dev/null
  rc=$?
  [ $rc -ne 0 ] && ! grep -q 'tofu.* apply' "${T}/calls.log"
); check "a plan that creates something is refused; no apply" $?
(
  new_env; scratch_tofu
  echo '{"resource_changes":[{"change":{"actions":["update"]}}]}' >"${T}/plan.json"
  lib "unprotect_cluster 1" >/dev/null
  rc=$?
  [ $rc -eq 0 ] && grep -q 'tofu.* apply .*unprotect.tfplan' "${T}/calls.log"
); check "an update-only plan applies the saved plan file" $?

echo "verify_gcp_cleanup"
(
  new_env
  DOWN_WAIT_MINUTES=0 DOWN_POLL_SECONDS=0 STUB_COMPUTE_disks="pvc-orphan" lib "verify_gcp_cleanup" >"${T}/o"
  [ $? -ne 0 ] && grep -q "pvc-orphan" "${T}/o"
); check "an orphaned disk is found even with no cluster object" $?
(
  new_env
  STUB_COMPUTE_FAIL=1 lib "verify_gcp_cleanup" >/dev/null
  [ $? -ne 0 ]
); check "a failing list is fatal, not 'none left'" $?

echo "database.sh"
(
  new_env
  STUB_GCS=present run_script database.sh
  [ "$RC" -ne 0 ] && contains "$OUT" "--restore" && ! grep -q 'apply' "${T}/calls.log"
); check "a fresh database is refused when the bucket holds backups" $?
(
  new_env
  STUB_GCS=denied run_script database.sh
  [ "$RC" -ne 0 ] && contains "$OUT" "cannot check" && ! grep -q 'apply' "${T}/calls.log"
); check "a bucket check error is not read as empty" $?
(
  new_env
  STUB_GCS=nomatch run_script database.sh
  # db-bootstrap.sh runs next and has no secrets in this fixture; only the apply matters here.
  grep -q 'initdb' "${T}/stdin_kubectl_apply.log" && contains "$OUT" "database roles"
); check "an empty bucket gets a fresh initdb cluster" $?
(
  new_env
  STUB_GCS=present run_script database.sh --restore --time "2026-10-22 14:30:00+00"
  grep -q 'recovery' "${T}/stdin_kubectl_apply.log" && grep -q 'targetTime: "2026-10-22 14:30:00+00"' "${T}/stdin_kubectl_apply.log" \
    && grep -q 'serverName: llm-pg-r' "${T}/stdin_kubectl_apply.log" && ! grep -q 'initdb' "${T}/stdin_kubectl_apply.log"
); check "--restore --time renders the PITR overlay with a new archive server name" $?
(
  new_env
  STUB_GCS=empty run_script database.sh --restore
  [ "$RC" -ne 0 ] && contains "$OUT" "no base backup"
); check "--restore with no base backup stops" $?
(
  new_env
  echo '{"spec":{}}' >"${T}/pg.json"
  STUB_GCS=present run_script database.sh --restore
  [ "$RC" -ne 0 ] && contains "$OUT" "already exists"
); check "--restore refuses when cluster llm-pg exists" $?
(
  new_env
  run_script database.sh --time "tomorrow"
  [ "$RC" -ne 0 ]
); check "bad --time is rejected" $?

echo "providers.sh: tenant missing from the database"
(
  new_env
  printf '%s' '{"tenantId":"11111111-1111-1111-1111-111111111111","keyId":"k","secret":"s"}' >"${T}/sm/llm-tenant-default"
  printf '%s' '{"data":{"limits":"done"}}' >"${T}/setup.json"
  : >"${T}/listing.json"
  STUB_LIST_FAIL=1 run_script providers.sh
  [ "$RC" -ne 0 ] && contains "$OUT" "tenant is missing from the database"
); check "a stored tenant secret is not trusted when list-inference fails" $?

echo "restore overlays"
for d in db db-restore db-restore-pitr; do
  (
    new_env
    ARCHIVE_SERVER=llm-pg-r1 RECOVERY_SERVER=llm-pg RECOVERY_TIME="2026-10-22 14:30:00+00" \
      bash -c "source '${GCP}/common.sh'; require_settings; render '${GCP}/../../deploy/gcp/k8s/${d}'" >"${T}/o" 2>&1
    [ $? -eq 0 ] && ! grep -q '__[A-Z_]*__' "${T}/o"
  ); check "overlay ${d} renders with no leftover placeholders" $?
done

echo "db-verify.sql (throwaway local postgres:16; skipped without docker or the image)"
if docker image inspect postgres:16 >/dev/null 2>&1; then
  (
    name="llm-verify-test-$$"
    # The password is for a container that lives for seconds and listens on no host port.
    docker run -d --rm --name "$name" -e POSTGRES_PASSWORD=throwaway -e POSTGRES_DB=llm_proxy postgres:16 >/dev/null || exit 1
    trap 'docker rm -f "$name" >/dev/null 2>&1' EXIT
    for _ in $(seq 1 60); do docker exec "$name" pg_isready -U postgres -d llm_proxy >/dev/null 2>&1 && break; sleep 1; done
    sleep 2
    q() { docker exec -i "$name" psql -U postgres -d llm_proxy -v ON_ERROR_STOP=1 -Atq "$@"; }
    q <<'SQL' || exit 1
create role llm_owner nologin bypassrls;
create role llm_migrator login noinherit in role llm_owner;
create role llm_auth login noinherit;
create role llm_runtime login noinherit;
grant usage, create on schema public to llm_owner, llm_migrator;
grant usage on schema public to llm_auth, llm_runtime;
SQL
    good="$(q <"${GCP}/db-verify.sql")"
    q -c "revoke create on schema public from llm_migrator" || exit 1
    bad="$(q <"${GCP}/db-verify.sql")"
    [ -z "$good" ] && printf '%s' "$bad" | grep -q "USAGE and CREATE"
  ); check "verify SQL passes good roles and flags a role that has USAGE but not CREATE" $?
else
  echo "  skip no local postgres:16 image"
fi
