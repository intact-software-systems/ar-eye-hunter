#!/usr/bin/env bash
set -Eeuo pipefail

if [[ "$(id -u)" != "0" ]]; then
	echo "Run this script as root." >&2
	exit 1
fi

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
RALLAR_INCLUDE_CADDY="${RALLAR_INCLUDE_CADDY:-0}"

echo "Restarting controller services"
echo "Note: the API-v1 Postgres store survives a restart; only a rollout or deploy wipes it."

systemctl restart rallar-api-v1.service
systemctl restart rallar-black-box-control.service

if [[ "${RALLAR_INCLUDE_CADDY}" == "1" || "${RALLAR_INCLUDE_CADDY}" == "true" ]]; then
	systemctl reload caddy.service || systemctl restart caddy.service
fi

export RALLAR_INCLUDE_CADDY
"${SCRIPT_DIR}/05-start-controller.sh"
