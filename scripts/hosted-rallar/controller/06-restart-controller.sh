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

echo "Restarting controller services (role ${RALLAR_CONTROLLER_ROLE})"
if [[ "${RALLAR_ROLE_HAS_POSTGRES}" == "1" ]]; then
	echo "Note: the Postgres store survives a restart, deploy, or rollout."
fi

for service in "${RALLAR_ROLE_APP_SERVICES[@]}"; do
	systemctl restart "${service}"
done

if [[ "${RALLAR_INCLUDE_CADDY}" == "1" || "${RALLAR_INCLUDE_CADDY}" == "true" ]]; then
	systemctl reload caddy.service || systemctl restart caddy.service
fi

export RALLAR_INCLUDE_CADDY
"${SCRIPT_DIR}/05-start-controller.sh"
