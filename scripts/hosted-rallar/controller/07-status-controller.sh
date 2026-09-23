#!/usr/bin/env bash
set -Eeuo pipefail

echo "==> Service status"
systemctl status rallar-api-v1.service --no-pager || true
systemctl status rallar-black-box-control.service --no-pager || true
systemctl status caddy.service --no-pager || true

echo
echo "==> API-v1 configuration profile"
if [[ -r /etc/rallar/api-v1.env ]] &&
	grep -Eq '^RALLAR_API_CONFIGURATION_PROFILE=prod-in-memory$' /etc/rallar/api-v1.env; then
	echo "WARNING: RALLAR_API_CONFIGURATION_PROFILE=prod-in-memory; restarting rallar-api-v1 resets auth sessions and runtime state."
else
	grep -E '^RALLAR_API_CONFIGURATION_PROFILE=' /etc/rallar/api-v1.env 2>/dev/null || echo "RALLAR_API_CONFIGURATION_PROFILE not found in /etc/rallar/api-v1.env"
fi

echo
echo "==> Memory"
free -h

echo
echo "==> Recent API-v1 logs"
journalctl -u rallar-api-v1.service -n 40 --no-pager || true

echo
echo "==> Recent control-server logs"
journalctl -u rallar-black-box-control.service -n 40 --no-pager || true
