#!/usr/bin/env bash
set -Eeuo pipefail

RALLAR_REPO_REF="${RALLAR_REPO_REF:-main}"
RALLAR_CHECKOUT_DIR="${RALLAR_CHECKOUT_DIR:-/opt/rallar/ar-eye-hunter}"
RALLAR_API_HOST="${RALLAR_API_HOST:-api.rallar.intactss.com}"
RALLAR_CONTROL_HOST="${RALLAR_CONTROL_HOST:-control.rallar.intactss.com}"
RALLAR_BLACKBOX_HOST="${RALLAR_BLACKBOX_HOST:-blackbox.rallar.intactss.com}"
RALLAR_INCLUDE_CADDY="${RALLAR_INCLUDE_CADDY:-0}"
RALLAR_INSTALL_PLAYWRIGHT="${RALLAR_INSTALL_PLAYWRIGHT:-0}"
RALLAR_ACME_EMAIL="${RALLAR_ACME_EMAIL:-}"
RALLAR_BLACK_BOX_OPERATOR_TOKEN_TTL_MS="${RALLAR_BLACK_BOX_OPERATOR_TOKEN_TTL_MS:-86400000}"
RALLAR_BLACK_BOX_OPERATOR_CLIENT_IDS="${RALLAR_BLACK_BOX_OPERATOR_CLIENT_IDS:-}"

is_known_rollout_generated_lockfile() {
  case "$1" in
    apps/api-v1/deno.lock | apps/rallar-black-box-control-server/deno.lock)
      return 0
      ;;
    *)
      return 1
      ;;
  esac
}

repair_known_rollout_generated_checkout_changes() {
  local checkout_dir="$1"
  local status line state file repaired_files=()

  status="$(git -C "${checkout_dir}" status --porcelain)"
  [[ -z "${status}" ]] && return 0

  while IFS= read -r line; do
    [[ -z "${line}" ]] && continue
    state="${line:0:2}"
    file="${line:3}"
    if [[ "${state}" == " M" ]] && is_known_rollout_generated_lockfile "${file}"; then
      repaired_files+=("${file}")
      continue
    fi
    return 0
  done <<<"${status}"

  [[ "${#repaired_files[@]}" -gt 0 ]] || return 0

  echo "Repairing rollout-generated Deno lockfile drift before controlled rollout:"
  printf "  %s\n" "${repaired_files[@]}"
  git -C "${checkout_dir}" checkout -- "${repaired_files[@]}"
}

run_rollout_self_test() {
  case "${RALLAR_ROLLOUT_SCRIPT_SELF_TEST:-}" in
    repair-known-drift)
      repair_known_rollout_generated_checkout_changes "${RALLAR_CHECKOUT_DIR}"
      if [[ -n "$(git -C "${RALLAR_CHECKOUT_DIR}" status --porcelain)" ]]; then
        git -C "${RALLAR_CHECKOUT_DIR}" status --short >&2
        return 1
      fi
      echo "repairedKnownDenoLockDrift=true"
      ;;
    *)
      echo "Unknown RALLAR_ROLLOUT_SCRIPT_SELF_TEST: ${RALLAR_ROLLOUT_SCRIPT_SELF_TEST}" >&2
      return 2
      ;;
  esac
}

if [[ "${RALLAR_ROLLOUT_SCRIPT_SELF_TEST:-0}" != "0" ]]; then
  run_rollout_self_test
  exit 0
fi

if [[ "$(id -u)" != "0" ]]; then
  echo "Run this script as root." >&2
  exit 1
fi

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/rallar-deno-runtime.sh"
source "${SCRIPT_DIR}/rallar-public-spa-env.sh"
source "${SCRIPT_DIR}/rallar-playwright-install.sh"
apply_rallar_public_spa_defaults
apply_rallar_public_cors_defaults

services=(rallar-api-v1.service rallar-black-box-control.service)

if [[ "${RALLAR_INCLUDE_CADDY}" == "1" || "${RALLAR_INCLUDE_CADDY}" == "true" ]]; then
  services+=(caddy.service)
fi

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

wait_for_url() {
  local label="$1"
  local url="$2"
  shift 2
  local attempts=30
  local delay_seconds=1

  echo "Waiting for ${label}: ${url}"
  for _ in $(seq 1 "${attempts}"); do
    if curl -fsS "$@" "${url}" >/dev/null; then
      echo "  ok"
      return 0
    fi
    sleep "${delay_seconds}"
  done

  echo "Timed out waiting for ${label}." >&2
  return 1
}

update_env_value() {
  local env_file="$1"
  local key="$2"
  local value="$3"
  local tmp_file

  if [[ ! -f "${env_file}" ]]; then
    echo "Missing ${env_file}. Run 02-deploy-controller.sh first." >&2
    exit 1
  fi

  tmp_file="$(mktemp)"
  awk -v key="${key}" -v value="${key}=${value}" '
    BEGIN { replaced = 0 }
    $0 ~ "^" key "=" {
      if (!replaced) {
        print value
        replaced = 1
      }
      next
    }
    { print }
    END {
      if (!replaced) {
        print value
      }
    }
  ' "${env_file}" >"${tmp_file}"
  install -m 0600 -o root -g root "${tmp_file}" "${env_file}"
  rm -f "${tmp_file}"
}

read_env_value() {
  local env_file="$1"
  local key="$2"

  if [[ ! -r "${env_file}" ]]; then
    return 0
  fi

  grep -E "^${key}=" "${env_file}" \
    | tail -n 1 \
    | cut -d= -f2- || true
}

ensure_operator_token_secret() {
  local secret="${RALLAR_BLACK_BOX_OPERATOR_TOKEN_SECRET:-}"

  if [[ -z "${secret}" ]]; then
    secret="$(read_env_value "/etc/rallar/api-v1.env" "RALLAR_BLACK_BOX_OPERATOR_TOKEN_SECRET")"
  fi
  if [[ -z "${secret}" ]]; then
    secret="$(read_env_value "/etc/rallar/control-server.env" "RALLAR_BLACK_BOX_OPERATOR_TOKEN_SECRET")"
  fi
  if [[ -z "${secret}" ]]; then
    secret="$(openssl rand -hex 32)"
  fi

  update_env_value "/etc/rallar/api-v1.env" "RALLAR_BLACK_BOX_OPERATOR_TOKEN_SECRET" "${secret}"
  update_env_value "/etc/rallar/api-v1.env" "RALLAR_BLACK_BOX_OPERATOR_TOKEN_TTL_MS" "${RALLAR_BLACK_BOX_OPERATOR_TOKEN_TTL_MS}"
  update_env_value "/etc/rallar/api-v1.env" "RALLAR_BLACK_BOX_OPERATOR_CLIENT_IDS" "${RALLAR_BLACK_BOX_OPERATOR_CLIENT_IDS}"
  update_env_value "/etc/rallar/control-server.env" "RALLAR_BLACK_BOX_OPERATOR_TOKEN_SECRET" "${secret}"
}

update_api_cors_origins() {
  apply_rallar_public_cors_defaults
  update_env_value "/etc/rallar/api-v1.env" "CORS_ORIGINS" "${RALLAR_API_CORS_ORIGINS}"
}

update_control_allowed_origins() {
  apply_rallar_public_cors_defaults
  update_env_value "/etc/rallar/control-server.env" "RALLAR_BLACK_BOX_ALLOWED_ORIGINS" "${RALLAR_BLACK_BOX_ALLOWED_ORIGINS}"
}

require_command git
require_command npm
require_command deno
require_rallar_min_deno_version
require_command rsync
require_command curl
require_command openssl
require_command caddy

if [[ ! -d "${RALLAR_CHECKOUT_DIR}/.git" ]]; then
  echo "Missing git checkout at ${RALLAR_CHECKOUT_DIR}. Run 02-deploy-controller.sh first." >&2
  exit 1
fi

repair_known_rollout_generated_checkout_changes "${RALLAR_CHECKOUT_DIR}"

if [[ -n "$(git -C "${RALLAR_CHECKOUT_DIR}" status --porcelain)" ]]; then
  echo "Checkout has local changes; refusing controlled rollout:" >&2
  git -C "${RALLAR_CHECKOUT_DIR}" status --short >&2
  exit 1
fi

previous_revision="$(git -C "${RALLAR_CHECKOUT_DIR}" rev-parse --short HEAD)"
stopped_services=0

restart_stopped_services_on_error() {
  local exit_code="$?"
  if [[ "${stopped_services}" == "1" ]]; then
    echo
    echo "Rollout failed after services were stopped. Attempting to start controller services again." >&2
    systemctl start rallar-api-v1.service || true
    systemctl start rallar-black-box-control.service || true
    if [[ "${RALLAR_INCLUDE_CADDY}" == "1" || "${RALLAR_INCLUDE_CADDY}" == "true" ]]; then
      systemctl start caddy.service || true
    else
      systemctl reload caddy.service || systemctl restart caddy.service || true
    fi
  fi
  exit "${exit_code}"
}

echo "==> Controlled rollout from ${previous_revision} to origin/${RALLAR_REPO_REF}"
echo "Checkout: ${RALLAR_CHECKOUT_DIR}"
echo "Services:"
printf "  %s\n" "${services[@]}"
echo
echo "Note: stopping rallar-api-v1 resets its pglite-memory data."

trap restart_stopped_services_on_error ERR

echo "==> Updating git checkout"
git -C "${RALLAR_CHECKOUT_DIR}" fetch --prune origin
git -C "${RALLAR_CHECKOUT_DIR}" checkout "${RALLAR_REPO_REF}"
git -C "${RALLAR_CHECKOUT_DIR}" pull --ff-only origin "${RALLAR_REPO_REF}"
chown -R rallar:rallar "${RALLAR_CHECKOUT_DIR}"

current_revision="$(git -C "${RALLAR_CHECKOUT_DIR}" rev-parse --short HEAD)"
echo "Updated ${previous_revision} -> ${current_revision}"

echo "==> Installing npm dependencies"
runuser -u rallar -- npm --prefix "${RALLAR_CHECKOUT_DIR}" ci

echo "==> Warming Deno caches"
runuser -u rallar -- env DENO_DIR=/var/lib/rallar-deno \
  deno cache --frozen --config "${RALLAR_CHECKOUT_DIR}/apps/api-v1/deno.json" \
  "${RALLAR_CHECKOUT_DIR}/apps/api-v1/src/main.ts"
runuser -u rallar -- env DENO_DIR=/var/lib/rallar-deno \
  deno cache --frozen --config "${RALLAR_CHECKOUT_DIR}/apps/rallar-black-box-control-server/deno.json" \
  "${RALLAR_CHECKOUT_DIR}/apps/rallar-black-box-control-server/src/main.ts"

if [[ "${RALLAR_INSTALL_PLAYWRIGHT}" == "1" || "${RALLAR_INSTALL_PLAYWRIGHT}" == "true" ]]; then
  install_rallar_playwright_chromium "${RALLAR_CHECKOUT_DIR}"
fi

echo "==> Building rallar-black-box SPA"
build_rallar_black_box_spa "${RALLAR_CHECKOUT_DIR}"

echo "==> Stopping services for publish/start"
stopped_services=1
for service in "${services[@]}"; do
  systemctl stop "${service}"
done

echo "==> Publishing SPA static files"
rm -rf /var/www/rallar-black-box/*
rsync -a --delete \
  "${RALLAR_CHECKOUT_DIR}/apps/rallar-black-box/dist/" \
  /var/www/rallar-black-box/
chown -R caddy:caddy /var/www/rallar-black-box

echo "==> Writing SPA public env audit"
write_rallar_black_box_spa_env_file

echo "==> Updating API CORS origins"
update_api_cors_origins

echo "==> Updating control-server browser origins"
update_control_allowed_origins

echo "==> Ensuring black-box operator token broker secret"
ensure_operator_token_secret

echo "==> Writing Caddyfile"
write_rallar_controller_caddyfile

echo "==> Starting services"
systemctl daemon-reload
systemctl start rallar-api-v1.service
systemctl start rallar-black-box-control.service

if [[ "${RALLAR_INCLUDE_CADDY}" == "1" || "${RALLAR_INCLUDE_CADDY}" == "true" ]]; then
  systemctl start caddy.service
else
  systemctl reload caddy.service || systemctl restart caddy.service
fi
stopped_services=0
trap - ERR

wait_for_url "API-v1 config" "http://127.0.0.1:8080/api/config"
wait_for_url "API-v1 docs" "http://127.0.0.1:8080/api/docs"
wait_for_url "control health" "http://127.0.0.1:5180/health" -H "x-forwarded-proto: https"
verify_rallar_control_public_cors

echo
"${SCRIPT_DIR}/07-status-controller.sh"

echo
echo "Rollout complete: ${previous_revision} -> ${current_revision}"
