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

services=("${RALLAR_ROLE_APP_SERVICES[@]}")
if [[ "${RALLAR_INCLUDE_CADDY}" == "1" || "${RALLAR_INCLUDE_CADDY}" == "true" ]]; then
	services+=(caddy.service)
fi

echo "Stopping controller services (role ${RALLAR_CONTROLLER_ROLE}):"
printf "  %s\n" "${services[@]}"
echo
if [[ "${RALLAR_ROLE_HAS_POSTGRES}" == "1" ]]; then
	echo "Note: the Postgres store survives a stop, deploy, or rollout."
fi

for service in "${services[@]}"; do
	systemctl stop "${service}"
done

echo
echo "Stopped. Current service state:"
for service in "${services[@]}"; do
	printf "  %s: " "${service}"
	systemctl is-active "${service}" || true
done
