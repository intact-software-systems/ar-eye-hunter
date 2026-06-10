#!/usr/bin/env bash
set -Eeuo pipefail

if [[ "$(id -u)" != "0" ]]; then
  echo "Run this script as root." >&2
  exit 1
fi

SERVICE_NAME="rallar-black-box-headless-worker.service"
ENV_FILE="${RALLAR_HEADLESS_ENV_FILE:-/etc/rallar/headless-worker.env}"
RALLAR_SHOW_HEADLESS_RUN="${RALLAR_SHOW_HEADLESS_RUN:-1}"

bool_enabled() {
  local value="${1:-0}"
  [[ "${value}" == "1" || "${value}" == "true" || "${value}" == "yes" || "${value}" == "on" ]]
}

load_env_file_if_present() {
  if [[ -r "${ENV_FILE}" ]]; then
    set -a
    # shellcheck disable=SC1090
    source "${ENV_FILE}"
    set +a
  fi
}

control_run_snapshot_url() {
  local control_url="$1"
  local run_id="$2"
  local scheme rest host encoded_run_id

  if [[ "${control_url}" == ws://* ]]; then
    scheme="http"
    rest="${control_url#ws://}"
  elif [[ "${control_url}" == wss://* ]]; then
    scheme="https"
    rest="${control_url#wss://}"
  elif [[ "${control_url}" == http://* ]]; then
    scheme="http"
    rest="${control_url#http://}"
  elif [[ "${control_url}" == https://* ]]; then
    scheme="https"
    rest="${control_url#https://}"
  else
    return 1
  fi

  host="${rest%%/*}"
  encoded_run_id="$(jq -nr --arg v "${run_id}" '$v|@uri')"
  printf '%s://%s/runs/%s' "${scheme}" "${host}" "${encoded_run_id}"
}

if systemctl list-unit-files "${SERVICE_NAME}" >/dev/null 2>&1; then
  echo "==> Stopping ${SERVICE_NAME}"
  systemctl stop "${SERVICE_NAME}" || true
else
  echo "${SERVICE_NAME} is not installed. Nothing to stop."
fi

for _ in $(seq 1 30); do
  if ! systemctl is-active --quiet "${SERVICE_NAME}"; then
    break
  fi
  sleep 1
done

printf '%s: ' "${SERVICE_NAME}"
systemctl is-active "${SERVICE_NAME}" || true

load_env_file_if_present
if bool_enabled "${RALLAR_SHOW_HEADLESS_RUN}" && command -v curl >/dev/null 2>&1 && command -v jq >/dev/null 2>&1; then
  if [[ -n "${RALLAR_BLACK_BOX_CONTROL_URL:-}" && -n "${RALLAR_BLACK_BOX_RUN_ID:-}" ]]; then
    snapshot_url="$(control_run_snapshot_url "${RALLAR_BLACK_BOX_CONTROL_URL}" "${RALLAR_BLACK_BOX_RUN_ID}" || true)"
    if [[ -n "${snapshot_url:-}" ]]; then
      echo "==> Run snapshot after stop: ${snapshot_url}"
      curl -fsS "${snapshot_url}" | jq '{runId, agents: [.agents[]? | {agentId, connected, status}]}' || true
    fi
  fi
fi
