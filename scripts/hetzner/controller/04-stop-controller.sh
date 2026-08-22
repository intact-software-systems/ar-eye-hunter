#!/usr/bin/env bash
set -Eeuo pipefail

if [[ "$(id -u)" != "0" ]]; then
	echo "Run this script as root." >&2
	exit 1
fi

RALLAR_INCLUDE_CADDY="${RALLAR_INCLUDE_CADDY:-0}"

services=(rallar-api-v1.service rallar-black-box-control.service)
if [[ "${RALLAR_INCLUDE_CADDY}" == "1" || "${RALLAR_INCLUDE_CADDY}" == "true" ]]; then
	services+=(caddy.service)
fi

echo "Stopping controller services:"
printf "  %s\n" "${services[@]}"
echo
echo "Note: stopping rallar-api-v1 resets its pglite-memory data."

for service in "${services[@]}"; do
	systemctl stop "${service}"
done

echo
echo "Stopped. Current service state:"
for service in "${services[@]}"; do
	printf "  %s: " "${service}"
	systemctl is-active "${service}" || true
done
