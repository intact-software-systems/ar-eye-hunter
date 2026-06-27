#!/usr/bin/env bash
set -Eeuo pipefail

if [[ "$(id -u)" != "0" ]]; then
  echo "Run this script as root." >&2
  exit 1
fi

SERVICE_NAME="rallar-black-box-headless-worker.service"
ENV_FILE="${RALLAR_HEADLESS_ENV_FILE:-/etc/rallar/headless-worker.env}"
RALLAR_CHECKOUT_DIR="${RALLAR_CHECKOUT_DIR:-/opt/rallar/ar-eye-hunter}"
RALLAR_WRITE_HEADLESS_ENV="${RALLAR_WRITE_HEADLESS_ENV:-1}"
RALLAR_INSTALL_PLAYWRIGHT="${RALLAR_INSTALL_PLAYWRIGHT:-0}"
RALLAR_NPM_CI="${RALLAR_NPM_CI:-0}"
RALLAR_WAIT_FOR_HEADLESS_WORKERS="${RALLAR_WAIT_FOR_HEADLESS_WORKERS:-1}"
RALLAR_HEADLESS_READY_TIMEOUT_SECONDS="${RALLAR_HEADLESS_READY_TIMEOUT_SECONDS:-75}"
RALLAR_BLACK_BOX_READY_TIMEOUT_MS="${RALLAR_BLACK_BOX_READY_TIMEOUT_MS:-$((RALLAR_HEADLESS_READY_TIMEOUT_SECONDS * 1000))}"

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/rallar-playwright-install.sh"

bool_enabled() {
  local value="${1:-0}"
  [[ "${value}" == "1" || "${value}" == "true" || "${value}" == "yes" || "${value}" == "on" ]]
}

require_command() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "Missing required command: $1. Run 01-install-runtime.sh first." >&2
    exit 1
  fi
}

run_with_heartbeat() {
  local label="$1"
  shift

  local interval="${RALLAR_LONG_COMMAND_HEARTBEAT_SECONDS:-30}"
  if ! [[ "${interval}" =~ ^[1-9][0-9]*$ ]]; then
    interval="30"
  fi

  "$@" &
  local pid=$!

  while kill -0 "${pid}" 2>/dev/null; do
    local elapsed=0
    while [[ "${elapsed}" -lt "${interval}" ]]; do
      sleep 1
      if ! kill -0 "${pid}" 2>/dev/null; then
        break 2
      fi
      elapsed=$((elapsed + 1))
    done
    echo "  ${label} still running at $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  done

  local status
  set +e
  wait "${pid}"
  status=$?
  set -e
  return "${status}"
}

load_env_file() {
  if [[ ! -r "${ENV_FILE}" ]]; then
    echo "Headless worker env file not found: ${ENV_FILE}" >&2
    echo "Run this script once with RALLAR_WRITE_HEADLESS_ENV=1 and the required worker env values." >&2
    exit 1
  fi

  set -a
  # shellcheck disable=SC1090
  source "${ENV_FILE}"
  set +a
}

quote_env_value() {
  local value="$1"
  if [[ "${value}" == *$'\n'* || "${value}" == *$'\r'* ]]; then
    echo "Environment values may not contain newlines." >&2
    exit 1
  fi
  value="${value//\\/\\\\}"
  value="${value//\"/\\\"}"
  value="${value//\$/\\\$}"
  value="${value//\`/\\\`}"
  printf '"%s"' "${value}"
}

write_env_var() {
  local key="$1"
  local value="${!key-}"
  if [[ -n "${value}" ]]; then
    printf '%s=%s\n' "${key}" "$(quote_env_value "${value}")" >>"${tmp_env_file}"
  fi
}

validate_positive_integer() {
  local key="$1"
  local value="$2"
  if ! [[ "${value}" =~ ^[1-9][0-9]*$ ]]; then
    echo "${key} must be a positive integer. Received: ${value}" >&2
    exit 1
  fi
}

validate_required_value() {
  local key="$1"
  local value="${!key-}"
  if [[ -z "${value}" ]]; then
    echo "Missing required value: ${key}" >&2
    exit 1
  fi
}

validate_credentials() {
  if [[ -n "${RALLAR_BLACK_BOX_USERNAME:-}" && -n "${RALLAR_BLACK_BOX_PASSWORD:-}" ]]; then
    return 0
  fi

  local ordinal username_var password_var
  for ordinal in $(seq 1 "${RALLAR_BLACK_BOX_AGENT_COUNT}"); do
    username_var="RALLAR_BLACK_BOX_AGENT_${ordinal}_USERNAME"
    password_var="RALLAR_BLACK_BOX_AGENT_${ordinal}_PASSWORD"
    if [[ -z "${!username_var:-}" || -z "${!password_var:-}" ]]; then
      echo "Missing credentials for headless worker agent ${ordinal}." >&2
      echo "Set RALLAR_BLACK_BOX_USERNAME/PASSWORD or ${username_var}/${password_var}." >&2
      exit 1
    fi
  done
}

apply_default_worker_env() {
  RALLAR_API_HOST="${RALLAR_API_HOST:-api.rallar.intactss.com}"
  RALLAR_CONTROL_HOST="${RALLAR_CONTROL_HOST:-control.rallar.intactss.com}"
  RALLAR_BLACKBOX_HOST="${RALLAR_BLACKBOX_HOST:-blackbox.rallar.intactss.com}"

  RALLAR_BLACK_BOX_SPA_URL="${RALLAR_BLACK_BOX_SPA_URL:-https://${RALLAR_BLACKBOX_HOST}}"
  RALLAR_BLACK_BOX_CONTROL_URL="${RALLAR_BLACK_BOX_CONTROL_URL:-wss://${RALLAR_CONTROL_HOST}/control}"
  RALLAR_API_BASE_URL="${RALLAR_API_BASE_URL:-https://${RALLAR_API_HOST}}"
  RALLAR_BLACK_BOX_RUN_ID="${RALLAR_BLACK_BOX_RUN_ID:-hetzner-headless-$(date -u +%Y%m%dT%H%M%SZ)}"
  RALLAR_BLACK_BOX_ROOM_ID="${RALLAR_BLACK_BOX_ROOM_ID:-hetzner-headless-room}"
  RALLAR_BLACK_BOX_AGENT_PREFIX="${RALLAR_BLACK_BOX_AGENT_PREFIX:-controller}"
  RALLAR_BLACK_BOX_AGENT_COUNT="${RALLAR_BLACK_BOX_AGENT_COUNT:-1}"
  RALLAR_BLACK_BOX_APPLICATION_ID="${RALLAR_BLACK_BOX_APPLICATION_ID:-${RALLAR_APPLICATION_ID:-rallar-server}}"
  RALLAR_BLACK_BOX_WORKSPACE_ID="${RALLAR_BLACK_BOX_WORKSPACE_ID:-${RALLAR_WORKSPACE_ID:-default}}"
  RALLAR_BLACK_BOX_BROWSER_LOG_LEVEL="${RALLAR_BLACK_BOX_BROWSER_LOG_LEVEL:-warning}"
  RALLAR_BLACK_BOX_HEADLESS="${RALLAR_BLACK_BOX_HEADLESS:-1}"
}

validate_worker_env() {
  validate_required_value RALLAR_BLACK_BOX_SPA_URL
  validate_required_value RALLAR_BLACK_BOX_CONTROL_URL
  validate_required_value RALLAR_API_BASE_URL
  validate_required_value RALLAR_BLACK_BOX_RUN_ID
  validate_required_value RALLAR_BLACK_BOX_ROOM_ID
  validate_required_value RALLAR_BLACK_BOX_AGENT_PREFIX
  validate_required_value RALLAR_BLACK_BOX_AGENT_COUNT
  validate_positive_integer RALLAR_BLACK_BOX_AGENT_COUNT "${RALLAR_BLACK_BOX_AGENT_COUNT}"
  validate_credentials
}

write_worker_env_file() {
  install -d -m 0700 -o root -g root "$(dirname "${ENV_FILE}")"
  tmp_env_file="$(mktemp "$(dirname "${ENV_FILE}")/.headless-worker.env.XXXXXX")"
  chmod 0600 "${tmp_env_file}"

  cat >"${tmp_env_file}" <<EOF_ENV
# Written by scripts/hetzner/controller/09-start-headless-workers.sh.
# Contains credentials; keep this file root-readable only.
EOF_ENV

  local required_vars=(
    RALLAR_BLACK_BOX_SPA_URL
    RALLAR_BLACK_BOX_CONTROL_URL
    RALLAR_API_BASE_URL
    RALLAR_BLACK_BOX_RUN_ID
    RALLAR_BLACK_BOX_ROOM_ID
    RALLAR_BLACK_BOX_AGENT_PREFIX
    RALLAR_BLACK_BOX_AGENT_COUNT
  )
  local optional_vars=(
    RALLAR_BLACK_BOX_USERNAME
    RALLAR_BLACK_BOX_PASSWORD
    RALLAR_BLACK_BOX_CONTROL_TOKEN
    RALLAR_BLACK_BOX_REPORT_UPLOAD_URL
    RALLAR_BLACK_BOX_ENVIRONMENT
    RALLAR_BLACK_BOX_TRANSPORT
    RALLAR_BLACK_BOX_STATS_INTERVAL_MS
    RALLAR_BLACK_BOX_HEARTBEAT_INTERVAL_MS
    RALLAR_APPLICATION_ID
    RALLAR_BLACK_BOX_APPLICATION_ID
    RALLAR_WORKSPACE_ID
    RALLAR_BLACK_BOX_WORKSPACE_ID
    RALLAR_BLACK_BOX_REGISTER
    RALLAR_BLACK_BOX_RESTORE_SESSION
    RALLAR_BLACK_BOX_LOGOUT_ON_CLOSE
    RALLAR_BLACK_BOX_LEAVE_ROOM_ON_CLOSE
    RALLAR_BLACK_BOX_BROWSER_LOG_LEVEL
    RALLAR_BLACK_BOX_HEADLESS
    RALLAR_BLACK_BOX_LAUNCH_TIMEOUT_MS
    RALLAR_BLACK_BOX_READY_TIMEOUT_MS
  )

  local key
  for key in "${required_vars[@]}" "${optional_vars[@]}"; do
    write_env_var "${key}"
  done

  while IFS= read -r key; do
    write_env_var "${key}"
  done < <(compgen -e | grep -E '^RALLAR_BLACK_BOX_AGENT_[0-9]+_(USERNAME|PASSWORD)$' | sort || true)

  mv "${tmp_env_file}" "${ENV_FILE}"
  chmod 0600 "${ENV_FILE}"
}

write_systemd_service() {
  local npm_bin
  npm_bin="$(command -v npm)"

  cat >/etc/systemd/system/${SERVICE_NAME} <<EOF_SERVICE
[Unit]
Description=Rallar Black Box headless browser worker
After=network-online.target rallar-api-v1.service rallar-black-box-control.service
Wants=network-online.target

[Service]
Type=simple
User=rallar
Group=rallar
WorkingDirectory=${RALLAR_CHECKOUT_DIR}
Environment=CI=1
Environment=HOME=/opt/rallar
EnvironmentFile=${ENV_FILE}
ExecStart=${npm_bin} --workspace rallar-black-box run worker:headless
Restart=on-failure
RestartSec=5
KillSignal=SIGTERM
KillMode=control-group
TimeoutStopSec=45
PrivateTmp=true

[Install]
WantedBy=multi-user.target
EOF_SERVICE

  systemctl daemon-reload
  systemctl enable "${SERVICE_NAME}" >/dev/null
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
    echo "Unsupported control URL: ${control_url}" >&2
    return 1
  fi

  host="${rest%%/*}"
  encoded_run_id="$(jq -nr --arg v "${run_id}" '$v|@uri')"
  printf '%s://%s/runs/%s' "${scheme}" "${host}" "${encoded_run_id}"
}

install_npm_dependencies_if_requested() {
  if bool_enabled "${RALLAR_NPM_CI}"; then
    echo "==> Running npm ci"
    runuser -u rallar -- npm --prefix "${RALLAR_CHECKOUT_DIR}" ci
  fi
}

install_playwright_if_requested() {
  if bool_enabled "${RALLAR_INSTALL_PLAYWRIGHT}"; then
    install_rallar_playwright_chromium "${RALLAR_CHECKOUT_DIR}"
  fi
}

wait_for_workers() {
  if ! bool_enabled "${RALLAR_WAIT_FOR_HEADLESS_WORKERS}"; then
    return 0
  fi

  require_command curl
  require_command jq
  validate_positive_integer RALLAR_HEADLESS_READY_TIMEOUT_SECONDS "${RALLAR_HEADLESS_READY_TIMEOUT_SECONDS}"

  local snapshot_url expected prefix connected total snapshot last_state
  snapshot_url="$(control_run_snapshot_url "${RALLAR_BLACK_BOX_CONTROL_URL}" "${RALLAR_BLACK_BOX_RUN_ID}")"
  expected="${RALLAR_BLACK_BOX_AGENT_COUNT}"
  prefix="${RALLAR_BLACK_BOX_AGENT_PREFIX}-"
  last_state="no snapshot yet"

  echo "==> Waiting for ${expected} connected headless agent(s) in ${snapshot_url}"
  for _ in $(seq 1 "${RALLAR_HEADLESS_READY_TIMEOUT_SECONDS}"); do
    if ! systemctl is-active --quiet "${SERVICE_NAME}"; then
      echo "${SERVICE_NAME} is not active." >&2
      journalctl -u "${SERVICE_NAME}" -n 80 --no-pager || true
      return 1
    fi

    snapshot="$(curl -fsS "${snapshot_url}" 2>/dev/null || true)"
    if [[ -n "${snapshot}" ]]; then
      connected="$(jq --arg prefix "${prefix}" '[.agents[]? | select(.connected == true and (.agentId | startswith($prefix)))] | length' <<<"${snapshot}" 2>/dev/null || echo 0)"
      total="$(jq '[.agents[]?] | length' <<<"${snapshot}" 2>/dev/null || echo 0)"
      last_state="connected=${connected}/${expected}, totalAgents=${total}"
      if [[ "${connected}" -ge "${expected}" ]]; then
        echo "  ok (${last_state})"
        return 0
      fi
    fi
    sleep 1
  done

  echo "Timed out waiting for headless workers. Last state: ${last_state}" >&2
  journalctl -u "${SERVICE_NAME}" -n 80 --no-pager || true
  return 1
}

require_command npm
require_command systemctl

if [[ ! -d "${RALLAR_CHECKOUT_DIR}/apps/rallar-black-box" ]]; then
  echo "Checkout not found or missing rallar-black-box app: ${RALLAR_CHECKOUT_DIR}" >&2
  exit 1
fi

if bool_enabled "${RALLAR_WRITE_HEADLESS_ENV}"; then
  apply_default_worker_env
  validate_worker_env
  write_worker_env_file
else
  load_env_file
  validate_required_value RALLAR_BLACK_BOX_CONTROL_URL
  validate_required_value RALLAR_BLACK_BOX_RUN_ID
  validate_required_value RALLAR_BLACK_BOX_AGENT_PREFIX
  validate_required_value RALLAR_BLACK_BOX_AGENT_COUNT
  validate_positive_integer RALLAR_BLACK_BOX_AGENT_COUNT "${RALLAR_BLACK_BOX_AGENT_COUNT}"
fi

install_npm_dependencies_if_requested
install_playwright_if_requested
write_systemd_service

echo "==> Starting ${SERVICE_NAME}"
echo "Run id      : ${RALLAR_BLACK_BOX_RUN_ID}"
echo "Agent prefix: ${RALLAR_BLACK_BOX_AGENT_PREFIX}"
echo "Agent count : ${RALLAR_BLACK_BOX_AGENT_COUNT}"
echo "SPA URL     : ${RALLAR_BLACK_BOX_SPA_URL:-from ${ENV_FILE}}"
echo "Control URL : ${RALLAR_BLACK_BOX_CONTROL_URL}"

systemctl restart "${SERVICE_NAME}"
wait_for_workers

systemctl --no-pager --full status "${SERVICE_NAME}" || true
