#!/usr/bin/env bash
set -Eeuo pipefail

echo "==> Service status"
systemctl status rallar-api-v1.service --no-pager || true
systemctl status rallar-black-box-control.service --no-pager || true
systemctl status caddy.service --no-pager || true

echo
echo "==> Memory"
free -h

echo
echo "==> Recent API-v1 logs"
journalctl -u rallar-api-v1.service -n 40 --no-pager || true

echo
echo "==> Recent control-server logs"
journalctl -u rallar-black-box-control.service -n 40 --no-pager || true

