#!/usr/bin/env bash
set -Eeuo pipefail

RALLAR_API_HOST="${RALLAR_API_HOST:-api.rallar.intactss.com}"
RALLAR_CONTROL_HOST="${RALLAR_CONTROL_HOST:-control.rallar.intactss.com}"
RALLAR_BLACKBOX_HOST="${RALLAR_BLACKBOX_HOST:-blackbox.rallar.intactss.com}"
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"

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
echo

smoke_username="${RALLAR_SMOKE_USERNAME:-${RALLAR_BLACK_BOX_USERNAME:-}}"
smoke_password="${RALLAR_SMOKE_PASSWORD:-${RALLAR_BLACK_BOX_PASSWORD:-}}"
if [[ -n "${smoke_username}" && -n "${smoke_password}" ]]; then
	check "Authenticated API WebSocket" deno run --allow-net --allow-env \
		"${SCRIPT_DIR}/authenticated-ws-smoke.ts"
else
	echo "==> Authenticated API WebSocket"
	echo "Skipping authenticated WS smoke. Set RALLAR_SMOKE_USERNAME/RALLAR_SMOKE_PASSWORD to verify login, CORS, ticketing, and public wss upgrade."
fi

echo "Controller public smoke checks passed."
