#!/usr/bin/env bash
set -Eeuo pipefail

SERVICE_NAME="${RALLAR_API_SERVICE_NAME:-rallar-api-v1.service}"
ETC_DIR="${RALLAR_ETC_DIR:-/etc/rallar}"
SYSTEMD_DIR="${RALLAR_SYSTEMD_DIR:-/etc/systemd/system}"
SECRET_FILE="${RALLAR_METERED_SECRET_FILE:-${ETC_DIR}/api-v1.secrets.env}"
DROPIN_DIR="${SYSTEMD_DIR}/${SERVICE_NAME}.d"
DROPIN_FILE="${DROPIN_DIR}/10-metered-turn.conf"
SYSTEMCTL_BIN="${RALLAR_SYSTEMCTL_BIN:-systemctl}"
REQUIRE_ROOT="${RALLAR_REQUIRE_ROOT:-1}"
RESTART_SERVICE="${RALLAR_RESTART_SERVICE:-1}"

usage() {
	cat <<EOF
Usage: sudo ./13-configure-metered-turn.sh [--no-restart]

Creates a root-only Metered TURN secret env file and wires it into
${SERVICE_NAME} through a systemd drop-in.

The script prompts for METERED_APP_NAME and METERED_API_KEY when they are not
already present in the process environment. Prefer the prompts for manual use so
the API key does not land in shell history.

Environment overrides for tests/automation:
  METERED_APP_NAME
  METERED_API_KEY
  RALLAR_ETC_DIR
  RALLAR_SYSTEMD_DIR
  RALLAR_METERED_SECRET_FILE
  RALLAR_SYSTEMCTL_BIN
  RALLAR_RESTART_SERVICE=0
EOF
}

while [[ $# -gt 0 ]]; do
	case "$1" in
	--help | -h)
		usage
		exit 0
		;;
	--no-restart)
		RESTART_SERVICE=0
		shift
		;;
	*)
		echo "Unknown argument: $1" >&2
		usage >&2
		exit 2
		;;
	esac
done

if [[ "${REQUIRE_ROOT}" != "0" && "$(id -u)" != "0" ]]; then
	echo "Run this script as root so /etc/rallar remains root-only." >&2
	exit 1
fi

read_required_value() {
	local name="$1"
	local prompt="$2"
	local silent="${3:-0}"
	local value="${!name:-}"

	if [[ -z "${value}" ]]; then
		if [[ "${silent}" == "1" ]]; then
			read -r -s -p "${prompt}: " value
			printf '\n'
		else
			read -r -p "${prompt}: " value
		fi
	fi

	if [[ -z "${value}" ]]; then
		echo "${name} cannot be empty." >&2
		exit 1
	fi

	if [[ "${value}" == *$'\n'* || "${value}" == *$'\r'* ]]; then
		echo "${name} cannot contain newlines." >&2
		exit 1
	fi

	printf '%s' "${value}"
}

metered_app_name="$(read_required_value METERED_APP_NAME METERED_APP_NAME 0)"
metered_api_key="$(read_required_value METERED_API_KEY METERED_API_KEY 1)"

echo "==> Writing Metered TURN secret env file"
mkdir -p "${ETC_DIR}"
chmod 0700 "${ETC_DIR}"

tmp_file="$(mktemp "${SECRET_FILE}.tmp.XXXXXX")"
chmod 0600 "${tmp_file}"
{
	printf 'RALLAR_ICE_MODE=metered\n'
	printf 'METERED_APP_NAME=%s\n' "${metered_app_name}"
	printf 'METERED_API_KEY=%s\n' "${metered_api_key}"
} >"${tmp_file}"
mv "${tmp_file}" "${SECRET_FILE}"
chmod 0600 "${SECRET_FILE}"

if [[ "$(id -u)" == "0" ]]; then
	chown root:root "${SECRET_FILE}"
fi

echo "==> Wiring ${SERVICE_NAME} to read ${SECRET_FILE}"
mkdir -p "${DROPIN_DIR}"
cat >"${DROPIN_FILE}" <<EOF
[Service]
EnvironmentFile=-${SECRET_FILE}
EOF
chmod 0644 "${DROPIN_FILE}"

if [[ "${RESTART_SERVICE}" == "0" ]]; then
	echo "Metered TURN secrets installed. Restart skipped; run '${SYSTEMCTL_BIN} daemon-reload' and '${SYSTEMCTL_BIN} restart ${SERVICE_NAME}' when ready."
	exit 0
fi

echo "==> Reloading systemd and restarting ${SERVICE_NAME}"
"${SYSTEMCTL_BIN}" daemon-reload
"${SYSTEMCTL_BIN}" restart "${SERVICE_NAME}"

echo "Metered TURN secrets installed. API key was not printed."
