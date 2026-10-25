#!/usr/bin/env bash
# One stand-in for gcloud, kubectl, helm and tofu, used only by run.sh. It is installed under
# those four names in a temp directory placed first on PATH. It logs every call to
# $T/calls.log and answers from fixture files in $T. It never talks to any network.
# Behaviour switches are environment variables named STUB_*.
set -u
tool="$(basename "$0")"
args="$*"
printf '%s %s\n' "$tool" "$args" >>"${T}/calls.log"

case "$tool" in
  gcloud)
    case "$args" in
      "secrets versions list "*)
        name="${args#secrets versions list }"; name="${name%% *}"
        [ -f "${T}/sm/${name}" ] && echo "1"
        exit 0 ;;
      "secrets versions access latest --secret "*)
        name="${args#secrets versions access latest --secret }"; name="${name%% *}"
        [ -f "${T}/sm/${name}" ] || { echo "NOT_FOUND" >&2; exit 1; }
        cat "${T}/sm/${name}"; exit 0 ;;
      "secrets versions add "*)
        name="${args#secrets versions add }"; name="${name%% *}"
        cat >"${T}/stdin_sm_add.log"
        [ "${STUB_SM_ADD_FAIL:-0}" = 1 ] && { echo "PERMISSION_DENIED" >&2; exit 1; }
        cp "${T}/stdin_sm_add.log" "${T}/sm/${name}"; echo "projects/p/secrets/${name}/versions/1"; exit 0 ;;
      "storage ls "*)
        case "${STUB_GCS:-empty}" in
          present) echo "gs://bucket/llm-pg/base/"; exit 0 ;;
          empty) exit 0 ;;
          nomatch) echo "ERROR: One or more URLs matched no objects." >&2; exit 1 ;;
          *) echo "ERROR: PERMISSION_DENIED on bucket" >&2; exit 1 ;;
        esac ;;
      "compute "*" list "*)
        # STUB_COMPUTE_<kind> holds what a list returns; default nothing.
        kind="${args#compute }"; kind="${kind%% *}"; kind="${kind//-/_}"
        var="STUB_COMPUTE_${kind}"
        [ "${STUB_COMPUTE_FAIL:-0}" = 1 ] && { echo "PERMISSION_DENIED" >&2; exit 1; }
        [ -n "${!var:-}" ] && echo "${!var}"
        exit 0 ;;
      "secrets delete "*) [ "${STUB_SECRET_DELETE:-ok}" = fail ] && { echo "PERMISSION_DENIED" >&2; exit 1; }; exit 0 ;;
      "secrets describe "*)
        [ "${STUB_SECRET_GONE:-1}" = 1 ] && { echo "NOT_FOUND: secret does not exist" >&2; exit 1; }
        echo "secret"; exit 0 ;;
      "container clusters describe "*)
        case "${STUB_CLUSTER:-ok}" in
          ok) echo "llm-proxy"; exit 0 ;;
          notfound) echo "ERROR: (gcloud) NOT_FOUND: cluster was not found" >&2; exit 1 ;;
          *) echo "ERROR: PERMISSION_DENIED on cluster" >&2; exit 1 ;;
        esac ;;
    esac
    exit 0 ;;
  kubectl)
    case "$args" in
      "get namespace "*)
        if [ "${STUB_API:-ok}" = ok ]; then echo "namespace/llm-proxy"; exit 0; fi
        echo "Unable to connect to the server: dial tcp: i/o timeout" >&2; exit 1 ;;
      *"get configmap llm-setup -o json"*)
        if [ -f "${T}/setup.json" ]; then cat "${T}/setup.json"; exit 0; fi
        echo 'Error from server (NotFound): configmaps "llm-setup" not found' >&2; exit 1 ;;
      *"get hpa "*|*"get scaledobject "*)
        case "${STUB_HPA:-gone}" in
          gone) echo 'Error from server (NotFound): hpa not found' >&2; exit 1 ;;
          present) echo "hpa/llm-proxy"; exit 0 ;;
          *) echo "Unable to connect to the server: i/o timeout" >&2; exit 1 ;;
        esac ;;
      *"get crd "*)
        case "${STUB_CRD:-absent}" in
          absent) echo 'Error from server (NotFound): customresourcedefinitions not found' >&2; exit 1 ;;
          present) echo "customresourcedefinition/scaledobjects.keda.sh"; exit 0 ;;
          *) echo "Unable to connect to the server: i/o timeout" >&2; exit 1 ;;
        esac ;;
      *"get pods"*) echo "pod/llm-proxy-abc"; exit 0 ;;
      *"get cluster.postgresql.cnpg.io llm-pg -o json"*)
        if [ -f "${T}/pg.json" ]; then cat "${T}/pg.json"; exit 0; fi
        echo 'Error from server (NotFound): clusters.postgresql.cnpg.io "llm-pg" not found' >&2; exit 1 ;;
      *"get cluster.postgresql.cnpg.io"*) echo "cluster.postgresql.cnpg.io/llm-pg"; exit 0 ;;
      *" exec "*)
        case "$args" in
          *list-inference*) [ "${STUB_LIST_FAIL:-0}" = 1 ] && { echo "tenant not found" >&2; exit 1; }; cat "${T}/listing.json"; exit 0 ;;
        esac
        cat >/dev/null 2>&1 </dev/null || true
        exit 0 ;;
      "apply "*"-f -"*|*"apply --server-side"*)
        cat >>"${T}/stdin_kubectl_apply.log"; exit 0 ;;
      "kustomize "*) exec "${STUB_REAL_KUBECTL:-/usr/local/bin/kubectl}" "$@" ;;
      *" wait "*) [ "${STUB_WAIT_FAIL:-0}" = 1 ] && exit 1; exit 0 ;;
    esac
    exit 0 ;;
  helm)
    case "$args" in
      "list "*)
        rel="${args#*--filter }"; rel="${rel%% *}"; rel="${rel#^}"; rel="${rel%\$}"
        if [ -f "${T}/helm_${rel}.json" ]; then cat "${T}/helm_${rel}.json"; else echo "[]"; fi
        exit 0 ;;
    esac
    exit 0 ;;
  tofu)
    case "$args" in
      *"state list"*) [ -f "${T}/state.list" ] && cat "${T}/state.list"; exit 0 ;;
      *" show -json "*) cat "${T}/plan.json"; exit $? ;;
    esac
    exit 0 ;;
esac
