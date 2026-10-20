#!/usr/bin/env bash
# Start, stop, and restart the llm-proxy Compose project on Colima.
# Colima stays up on stop unless --vm is set. The database volume is kept.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PROFILE="${COLIMA_PROFILE:-default}"
SOCKET="${COLIMA_SOCKET:-${HOME}/.colima/${PROFILE}/docker.sock}"
READY_URL="${PROXY_BASE_URL:-http://127.0.0.1:8080}/health/ready"

usage() {
  cat <<'EOF'
Usage: scripts/colima.sh <start|stop|restart|status> [options]

  start [--build]     Start Colima when it is down, then start the Compose project.
  stop [--vm]         Stop the Compose project. --vm also stops the Colima VM.
  restart [--build]   Restart the Compose project. Start Colima first when it is down.
  status              Show Colima and Compose status.

The Docker daemon is the Colima socket. The script does not change the Docker context.
Stop does not delete the database volume.
EOF
}

require_tools() {
  if ! command -v colima >/dev/null 2>&1; then
    echo "colima is not installed" >&2
    exit 1
  fi
  if ! command -v docker >/dev/null 2>&1; then
    echo "docker is not installed" >&2
    exit 1
  fi
}

colima_running() {
  colima status -p "$PROFILE" 2>&1 | grep -q "colima is running"
}

ensure_colima() {
  require_tools
  if ! colima_running; then
    echo "starting colima profile ${PROFILE}"
    colima start -p "$PROFILE"
  fi
  if [[ ! -S "$SOCKET" ]]; then
    echo "Colima socket is missing: ${SOCKET}" >&2
    exit 1
  fi
  export DOCKER_HOST="unix://${SOCKET}"
}

compose() {
  docker compose --project-directory "$ROOT" -f "$ROOT/docker-compose.yml" "$@"
}

wait_ready() {
  local attempt
  for attempt in $(seq 1 45); do
    if curl -fsS "$READY_URL" >/dev/null 2>&1; then
      echo "ready ${READY_URL}"
      return 0
    fi
    sleep 2
  done
  echo "timed out waiting for ${READY_URL}" >&2
  return 1
}

command_name="${1:-}"
if [[ $# -gt 0 ]]; then
  shift
fi

has_build=0
has_vm=0
args=()
for arg in "$@"; do
  case "$arg" in
    --build) has_build=1; args+=("$arg") ;;
    --vm) has_vm=1 ;;
    *) args+=("$arg") ;;
  esac
done

case "$command_name" in
  start)
    ensure_colima
    echo "starting the llm-proxy Compose project"
    compose up -d --wait ${args[@]+"${args[@]}"}
    wait_ready
    ;;
  stop)
    require_tools
    if colima_running && [[ -S "$SOCKET" ]]; then
      export DOCKER_HOST="unix://${SOCKET}"
      echo "stopping the llm-proxy Compose project"
      compose stop ${args[@]+"${args[@]}"}
    else
      echo "Colima is not running. The Compose project is already stopped."
    fi
    if [[ "$has_vm" -eq 1 ]]; then
      echo "stopping colima profile ${PROFILE}"
      colima stop -p "$PROFILE"
    fi
    ;;
  restart)
    ensure_colima
    if [[ "$has_build" -eq 1 ]]; then
      echo "recreating the llm-proxy Compose project"
      compose up -d --wait --force-recreate ${args[@]+"${args[@]}"}
    elif [[ -z "$(compose ps -aq)" ]]; then
      echo "starting the llm-proxy Compose project"
      compose up -d --wait ${args[@]+"${args[@]}"}
    else
      echo "restarting the llm-proxy Compose project"
      compose restart ${args[@]+"${args[@]}"}
    fi
    wait_ready
    ;;
  status)
    require_tools
    colima status -p "$PROFILE" || true
    if colima_running && [[ -S "$SOCKET" ]]; then
      export DOCKER_HOST="unix://${SOCKET}"
      compose ps
    fi
    ;;
  *)
    usage
    exit 1
    ;;
esac
