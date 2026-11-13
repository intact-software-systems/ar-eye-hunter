#!/usr/bin/env bash
set -Eeuo pipefail

if [[ "$(id -u)" != "0" ]]; then
	echo "Run this script as root." >&2
	exit 1
fi

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/rallar-controller-role.sh"
apply_rallar_controller_role

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

echo "Starting Rallar controller services (role ${RALLAR_CONTROLLER_ROLE})"
for service in "${RALLAR_ROLE_APP_SERVICES[@]}"; do
	systemctl start "${service}"
done

if [[ "${RALLAR_INCLUDE_CADDY}" == "1" || "${RALLAR_INCLUDE_CADDY}" == "true" ]]; then
	systemctl start caddy.service
fi

case "${RALLAR_CONTROLLER_ROLE}" in
api)
	for api_replica_port in "${RALLAR_API_REPLICA_PORTS[@]}"; do
		wait_for_url "API-v1 config ${api_replica_port}" "http://127.0.0.1:${api_replica_port}/api/config"
	done
	;;
control)
	wait_for_url "control health" "http://127.0.0.1:5180/health" -H "x-forwarded-proto: https"
	;;
games)
	wait_for_url "Relic Hunter config" "http://127.0.0.1:${RALLAR_RELIC_PORT}/api/config"
	wait_for_url "AR Eye Hunter config" "http://127.0.0.1:${RALLAR_AR_EYE_PORT}/api/config"
	;;
esac

echo
for service in "${RALLAR_ROLE_APP_SERVICES[@]}" caddy.service; do
	printf "  %s: " "${service}"
	systemctl is-active "${service}" || true
done

echo "Controller services started."
