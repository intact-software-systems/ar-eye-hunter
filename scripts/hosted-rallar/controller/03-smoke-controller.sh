#!/usr/bin/env bash
set -Eeuo pipefail

RALLAR_API_HOST="${RALLAR_API_HOST:-api.rallar.intactss.com}"
RALLAR_CONTROL_HOST="${RALLAR_CONTROL_HOST:-control.rallar.intactss.com}"
RALLAR_BLACKBOX_HOST="${RALLAR_BLACKBOX_HOST:-blackbox.rallar.intactss.com}"
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/rallar-controller-role.sh"
apply_rallar_controller_role

check() {
	local label="$1"
	shift
	echo "==> ${label}"
	"$@"
}

case "${RALLAR_CONTROLLER_ROLE}" in
api)
	check "API config" curl -fsS "https://${RALLAR_API_HOST}/api/config"
	echo
	check "API docs" curl -fsSI "https://${RALLAR_API_HOST}/api/docs"
	echo

	smoke_username="${RALLAR_SMOKE_USERNAME:-${RALLAR_BLACK_BOX_USERNAME:-}}"
	smoke_password="${RALLAR_SMOKE_PASSWORD:-${RALLAR_BLACK_BOX_PASSWORD:-}}"
	if [[ -n "${smoke_username}" && -n "${smoke_password}" ]]; then
		check "Authenticated API WebSocket" bun run \
			"${SCRIPT_DIR}/authenticated-ws-smoke.ts"
	else
		echo "==> Authenticated API WebSocket"
		echo "Skipping authenticated WS smoke. Set RALLAR_SMOKE_USERNAME/RALLAR_SMOKE_PASSWORD to verify login, CORS, ticketing, and public wss upgrade."
	fi
	;;
control)
	check "Control health" curl -fsS "https://${RALLAR_CONTROL_HOST}/health"
	echo
	check "SPA" curl -fsSI "https://${RALLAR_BLACKBOX_HOST}/"
	;;
games)
	check "Relic Hunter config" curl -fsS "https://${RALLAR_RELIC_HOST}/api/config"
	echo
	check "AR Eye Hunter config" curl -fsS "https://${RALLAR_AR_EYE_HOST}/api/config"
	;;
esac

echo "Controller public smoke checks passed."
