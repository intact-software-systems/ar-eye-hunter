#!/usr/bin/env bash
set -Eeuo pipefail

SERVICE_NAME="rallar-black-box-headless-worker.service"
ENV_FILE="${RALLAR_HEADLESS_ENV_FILE:-/etc/rallar/headless-worker.env}"
RALLAR_HEADLESS_LOG_LINES="${RALLAR_HEADLESS_LOG_LINES:-80}"
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

load_env_file_if_present

echo "==> Headless worker service"
systemctl status "${SERVICE_NAME}" --no-pager || true

echo
echo "==> Headless worker config"
echo "Env file    : ${ENV_FILE}"
echo "Run id      : ${RALLAR_BLACK_BOX_RUN_ID:-unknown}"
echo "Agent prefix: ${RALLAR_BLACK_BOX_AGENT_PREFIX:-unknown}"
echo "Agent count : ${RALLAR_BLACK_BOX_AGENT_COUNT:-unknown}"
echo "Entry      : ${RALLAR_BLACK_BOX_HEADLESS_ENTRY:-headless}"
echo "Browser eng.: ${RALLAR_BLACK_BOX_BROWSER_ENGINE:-unknown}"
echo "SPA URL     : ${RALLAR_BLACK_BOX_SPA_URL:-unknown}"
echo "Control URL : ${RALLAR_BLACK_BOX_CONTROL_URL:-unknown}"

echo
echo "==> Memory"
free -h || true

echo
echo "==> Browser and worker processes"
ps -eo pid,ppid,pcpu,pmem,rss,comm,args | \
  awk 'NR == 1 || $0 ~ /(chrome|chromium|firefox|webkit|WebKit|MiniBrowser|rallar-black-box)/ { print }' || true

if bool_enabled "${RALLAR_SHOW_HEADLESS_RUN}" && command -v curl >/dev/null 2>&1 && command -v jq >/dev/null 2>&1; then
  if [[ -n "${RALLAR_BLACK_BOX_CONTROL_URL:-}" && -n "${RALLAR_BLACK_BOX_RUN_ID:-}" ]]; then
    snapshot_url="$(control_run_snapshot_url "${RALLAR_BLACK_BOX_CONTROL_URL}" "${RALLAR_BLACK_BOX_RUN_ID}" || true)"
    if [[ -n "${snapshot_url:-}" ]]; then
      echo
      echo "==> Run snapshot: ${snapshot_url}"
      curl -fsS "${snapshot_url}" | jq '{runId, agents: [.agents[]? | {agentId, connected, status}]}' || true
    fi
  fi
fi

if [[ "${RALLAR_HEADLESS_LOG_LINES}" != "0" ]]; then
  echo
  echo "==> Recent headless worker logs"
  journalctl -u "${SERVICE_NAME}" -n "${RALLAR_HEADLESS_LOG_LINES}" --no-pager || true
fi
