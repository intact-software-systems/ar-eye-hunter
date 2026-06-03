#!/usr/bin/env bash
set -Eeuo pipefail

if [[ "$(id -u)" != "0" ]]; then
  echo "Run this script as root." >&2
  exit 1
fi

RALLAR_INCLUDE_CADDY="${RALLAR_INCLUDE_CADDY:-0}"

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

echo "Starting Rallar controller services"
systemctl start rallar-api-v1.service
systemctl start rallar-black-box-control.service

if [[ "${RALLAR_INCLUDE_CADDY}" == "1" || "${RALLAR_INCLUDE_CADDY}" == "true" ]]; then
  systemctl start caddy.service
fi

wait_for_url "API-v1 config" "http://127.0.0.1:8080/api/config"
wait_for_url "control health" "http://127.0.0.1:5180/health" -H "x-forwarded-proto: https"

echo
for service in rallar-api-v1.service rallar-black-box-control.service caddy.service; do
  printf "  %s: " "${service}"
  systemctl is-active "${service}" || true
done

echo "Controller services started."
