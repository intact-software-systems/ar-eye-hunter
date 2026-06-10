#!/usr/bin/env bash
set -Eeuo pipefail

if [[ "$(id -u)" != "0" ]]; then
  echo "Run this script as root." >&2
  exit 1
fi

RALLAR_REPO_REF="${RALLAR_REPO_REF:-main}"
RALLAR_CHECKOUT_DIR="${RALLAR_CHECKOUT_DIR:-/opt/rallar/ar-eye-hunter}"
RALLAR_BLACKBOX_HOST="${RALLAR_BLACKBOX_HOST:-blackbox.rallar.intactss.com}"
RALLAR_API_CORS_ORIGINS="${RALLAR_API_CORS_ORIGINS:-https://${RALLAR_BLACKBOX_HOST},https://ar-eye-hunter.pages.dev,https://relic-hunters-v1.intact-software-systems.workers.dev}"
RALLAR_INCLUDE_CADDY="${RALLAR_INCLUDE_CADDY:-0}"
RALLAR_INSTALL_PLAYWRIGHT="${RALLAR_INSTALL_PLAYWRIGHT:-0}"

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
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

update_api_cors_origins() {
  local env_file="/etc/rallar/api-v1.env"
  local tmp_file

  if [[ ! -f "${env_file}" ]]; then
    echo "Missing ${env_file}. Run 02-deploy-controller.sh first." >&2
    exit 1
  fi

  tmp_file="$(mktemp)"
  awk -v value="CORS_ORIGINS=${RALLAR_API_CORS_ORIGINS}" '
    BEGIN { replaced = 0 }
    /^CORS_ORIGINS=/ {
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

require_command git
require_command npm
require_command deno
require_command rsync
require_command curl

if [[ ! -d "${RALLAR_CHECKOUT_DIR}/.git" ]]; then
  echo "Missing git checkout at ${RALLAR_CHECKOUT_DIR}. Run 02-deploy-controller.sh first." >&2
  exit 1
fi

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
  deno cache --config "${RALLAR_CHECKOUT_DIR}/apps/api-v1/deno.json" \
  "${RALLAR_CHECKOUT_DIR}/apps/api-v1/src/main.ts"
runuser -u rallar -- env DENO_DIR=/var/lib/rallar-deno \
  deno cache --config "${RALLAR_CHECKOUT_DIR}/apps/rallar-black-box-control-server/deno.json" \
  "${RALLAR_CHECKOUT_DIR}/apps/rallar-black-box-control-server/src/main.ts"

if [[ "${RALLAR_INSTALL_PLAYWRIGHT}" == "1" || "${RALLAR_INSTALL_PLAYWRIGHT}" == "true" ]]; then
  echo "==> Installing Playwright Chromium and Linux dependencies"
  npm --prefix "${RALLAR_CHECKOUT_DIR}" exec -- playwright install --with-deps chromium
fi

echo "==> Building rallar-black-box SPA"
runuser -u rallar -- npm --prefix "${RALLAR_CHECKOUT_DIR}" \
  --workspace rallar-black-box run build

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

echo "==> Updating API CORS origins"
update_api_cors_origins

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

echo
"${SCRIPT_DIR}/07-status-controller.sh"

echo
echo "Rollout complete: ${previous_revision} -> ${current_revision}"
