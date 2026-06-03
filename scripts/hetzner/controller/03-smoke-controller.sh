#!/usr/bin/env bash
set -Eeuo pipefail

RALLAR_API_HOST="${RALLAR_API_HOST:-api.rallar.intactss.com}"
RALLAR_CONTROL_HOST="${RALLAR_CONTROL_HOST:-control.rallar.intactss.com}"
RALLAR_BLACKBOX_HOST="${RALLAR_BLACKBOX_HOST:-blackbox.rallar.intactss.com}"

check() {
  local label="$1"
  shift
  echo "==> ${label}"
  "$@"
}

check "API config" curl -fsS "https://${RALLAR_API_HOST}/api/config"
echo
check "API docs" curl -fsSI "https://${RALLAR_API_HOST}/api/docs"
check "Control health" curl -fsS "https://${RALLAR_CONTROL_HOST}/health"
echo
check "SPA" curl -fsSI "https://${RALLAR_BLACKBOX_HOST}/"

echo "Controller public smoke checks passed."

