#!/usr/bin/env bash
set -Eeuo pipefail

RALLAR_API_ENV_FILE="${RALLAR_API_ENV_FILE:-/etc/rallar/api-v1.env}"
RALLAR_API_STORE_FAILURE_FILE="${RALLAR_API_STORE_FAILURE_FILE:-/etc/rallar/api-v1.store-failure}"

echo "==> Service status"
systemctl status rallar-api-v1.service --no-pager || true
systemctl status rallar-black-box-control.service --no-pager || true
systemctl status postgresql.service --no-pager || true
systemctl status caddy.service --no-pager || true

echo
echo "==> API-v1 configuration profile"
api_profile=""
if [[ -r "${RALLAR_API_ENV_FILE}" ]]; then
	api_profile="$(grep -E '^RALLAR_API_CONFIGURATION_PROFILE=' "${RALLAR_API_ENV_FILE}" | tail -n 1 | cut -d= -f2- || true)"
fi
if [[ -z "${api_profile}" ]]; then
	echo "RALLAR_API_CONFIGURATION_PROFILE not found in ${RALLAR_API_ENV_FILE}"
elif [[ "${api_profile}" == "prod" ]]; then
	echo "RALLAR_API_CONFIGURATION_PROFILE=prod on this VM's Postgres; rollouts preserve the store."
else
	echo "WARNING: RALLAR_API_CONFIGURATION_PROFILE=${api_profile}; the controller runs the prod profile on this VM's Postgres. Run 08-rollout-controller.sh to apply it."
fi

if [[ -e "${RALLAR_API_STORE_FAILURE_FILE}" ]]; then
	echo "ERROR: $(cat "${RALLAR_API_STORE_FAILURE_FILE}")"
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
