#!/usr/bin/env bash

# Selects and validates the Hetzner controller role (api | control | games) and exports the
# role's service/host/port/store facts. Every role-aware script sources this file and calls
# apply_rallar_controller_role before touching systemd or Postgres. The role also owns the
# role-scoped Caddyfile: each server only reverse-proxies the hosts its role serves.

RALLAR_API_HOST_DEFAULT="api.rallar.intactss.com"
RALLAR_CONTROL_HOST_DEFAULT="control.rallar.intactss.com"
RALLAR_BLACKBOX_HOST_DEFAULT="blackbox.rallar.intactss.com"

RALLAR_API_PORT_DEFAULT="8080"
RALLAR_CONTROL_PORT_DEFAULT="5180"

# The api role runs three api-v1 replicas behind one shared Postgres store. Each replica
# binds a distinct loopback port; Caddy round-robins the public host across all three.
# Multi-instance correctness (cross-instance WS/RTC fanout) relies on RALLAR_DB_PUBSUB=postgres.
RALLAR_API_REPLICA_PORTS_DEFAULT=(8080 8081 8082)
RALLAR_API_REPLICA_SERVICES_DEFAULT=(rallar-api-v1.service rallar-api-v1-2.service rallar-api-v1-3.service)

RALLAR_API_STORE_FAILURE_FILE_DEFAULT="/etc/rallar/api-v1.store-failure"

RALLAR_RELIC_HOST_DEFAULT="relic.rallar.intactss.com"
RALLAR_RELIC_PORT_DEFAULT="8090"
RALLAR_RELIC_DATABASE_NAME_DEFAULT="relic_hunter_v1"
RALLAR_RELIC_SERVICE_DEFAULT="rallar-relic-hunter-server-v1.service"
RALLAR_RELIC_ENV_FILE_DEFAULT="/etc/rallar/relic-hunter-server-v1.env"
RALLAR_RELIC_STORE_FAILURE_FILE_DEFAULT="/etc/rallar/relic-hunter-server-v1.store-failure"
RALLAR_RELIC_APP_DIR_DEFAULT="apps/relic-hunter-server-v1"

RALLAR_AR_EYE_HOST_DEFAULT="ar-eye.rallar.intactss.com"
RALLAR_AR_EYE_PORT_DEFAULT="8091"
RALLAR_AR_EYE_DATABASE_NAME_DEFAULT="ar_eye_hunter_v1"
RALLAR_AR_EYE_SERVICE_DEFAULT="rallar-ar-eye-hunter-server-v1.service"
RALLAR_AR_EYE_ENV_FILE_DEFAULT="/etc/rallar/ar-eye-hunter-server-v1.env"
RALLAR_AR_EYE_STORE_FAILURE_FILE_DEFAULT="/etc/rallar/ar-eye-hunter-server-v1.store-failure"
RALLAR_AR_EYE_APP_DIR_DEFAULT="apps/ar-eye-hunter-server-v1"

RALLAR_GAME_CORS_ORIGINS_DEFAULT="https://ar-eye-hunter.pages.dev,https://relic-hunters-v1.intact-software-systems.workers.dev"

# The api role's replica units, one per line: the units the role installs and every reader of their journals.
rallar_api_replica_services() {
	printf '%s\n' "${RALLAR_API_REPLICA_SERVICES[@]:-${RALLAR_API_REPLICA_SERVICES_DEFAULT[@]}}"
}

apply_rallar_controller_role() {
	local role="${RALLAR_CONTROLLER_ROLE:-api}"

	case "${role}" in
	api)
		RALLAR_ROLE_HAS_POSTGRES=1
		RALLAR_ROLE_WRITES_HEADLESS_WORKER=0
		RALLAR_ROLE_APP_SERVICES=()
		while IFS= read -r api_replica_service; do
			RALLAR_ROLE_APP_SERVICES+=("${api_replica_service}")
		done < <(rallar_api_replica_services)
		RALLAR_ROLE_HOST="${RALLAR_API_HOST:-${RALLAR_API_HOST_DEFAULT}}"
		RALLAR_ROLE_PORT="${RALLAR_API_PORT:-${RALLAR_API_PORT_DEFAULT}}"
		RALLAR_API_REPLICA_PORTS=("${RALLAR_API_REPLICA_PORTS[@]:-${RALLAR_API_REPLICA_PORTS_DEFAULT[@]}}")
		RALLAR_API_REPLICA_PORTS_UPSTREAMS=''
		for port in "${RALLAR_API_REPLICA_PORTS[@]}"; do
			RALLAR_API_REPLICA_PORTS_UPSTREAMS="${RALLAR_API_REPLICA_PORTS_UPSTREAMS:+${RALLAR_API_REPLICA_PORTS_UPSTREAMS} }127.0.0.1:${port}"
		done
		;;
	control)
		RALLAR_ROLE_HAS_POSTGRES=0
		RALLAR_ROLE_WRITES_HEADLESS_WORKER=1
		RALLAR_ROLE_APP_SERVICES=(rallar-black-box-control.service)
		RALLAR_ROLE_HOST="${RALLAR_CONTROL_HOST:-${RALLAR_CONTROL_HOST_DEFAULT}}"
		RALLAR_ROLE_PORT="${RALLAR_CONTROL_PORT:-${RALLAR_CONTROL_PORT_DEFAULT}}"
		;;
	games)
		RALLAR_ROLE_HAS_POSTGRES=1
		RALLAR_ROLE_WRITES_HEADLESS_WORKER=0
		RALLAR_ROLE_APP_SERVICES=(rallar-relic-hunter-server-v1.service rallar-ar-eye-hunter-server-v1.service)
		RALLAR_ROLE_HOST="${RALLAR_RELIC_HOST:-${RALLAR_RELIC_HOST_DEFAULT}}"
		RALLAR_ROLE_PORT="${RALLAR_RELIC_PORT:-${RALLAR_RELIC_PORT_DEFAULT}}"
		;;
	*)
		echo "Invalid RALLAR_CONTROLLER_ROLE: '${role}'. Expected api, control, or games." >&2
		return 1
		;;
	esac

	RALLAR_CONTROLLER_ROLE="${role}"

	RALLAR_RELIC_HOST="${RALLAR_RELIC_HOST:-${RALLAR_RELIC_HOST_DEFAULT}}"
	RALLAR_RELIC_PORT="${RALLAR_RELIC_PORT:-${RALLAR_RELIC_PORT_DEFAULT}}"
	RALLAR_RELIC_DATABASE_ROLE="${RALLAR_RELIC_DATABASE_ROLE:-${RALLAR_RELIC_DATABASE_NAME_DEFAULT}}"
	RALLAR_RELIC_DATABASE_NAME="${RALLAR_RELIC_DATABASE_NAME:-${RALLAR_RELIC_DATABASE_NAME_DEFAULT}}"
	RALLAR_RELIC_SERVICE="${RALLAR_RELIC_SERVICE:-${RALLAR_RELIC_SERVICE_DEFAULT}}"
	RALLAR_RELIC_ENV_FILE="${RALLAR_RELIC_ENV_FILE:-${RALLAR_RELIC_ENV_FILE_DEFAULT}}"
	RALLAR_RELIC_STORE_FAILURE_FILE="${RALLAR_RELIC_STORE_FAILURE_FILE:-${RALLAR_RELIC_STORE_FAILURE_FILE_DEFAULT}}"
	RALLAR_RELIC_APP_DIR="${RALLAR_RELIC_APP_DIR:-${RALLAR_RELIC_APP_DIR_DEFAULT}}"
	RALLAR_RELIC_CORS_ORIGINS="${RALLAR_RELIC_CORS_ORIGINS:-${RALLAR_GAME_CORS_ORIGINS_DEFAULT}}"

	RALLAR_AR_EYE_HOST="${RALLAR_AR_EYE_HOST:-${RALLAR_AR_EYE_HOST_DEFAULT}}"
	RALLAR_AR_EYE_PORT="${RALLAR_AR_EYE_PORT:-${RALLAR_AR_EYE_PORT_DEFAULT}}"
	RALLAR_AR_EYE_DATABASE_ROLE="${RALLAR_AR_EYE_DATABASE_ROLE:-${RALLAR_AR_EYE_DATABASE_NAME_DEFAULT}}"
	RALLAR_AR_EYE_DATABASE_NAME="${RALLAR_AR_EYE_DATABASE_NAME:-${RALLAR_AR_EYE_DATABASE_NAME_DEFAULT}}"
	RALLAR_AR_EYE_SERVICE="${RALLAR_AR_EYE_SERVICE:-${RALLAR_AR_EYE_SERVICE_DEFAULT}}"
	RALLAR_AR_EYE_ENV_FILE="${RALLAR_AR_EYE_ENV_FILE:-${RALLAR_AR_EYE_ENV_FILE_DEFAULT}}"
	RALLAR_AR_EYE_STORE_FAILURE_FILE="${RALLAR_AR_EYE_STORE_FAILURE_FILE:-${RALLAR_AR_EYE_STORE_FAILURE_FILE_DEFAULT}}"
	RALLAR_AR_EYE_APP_DIR="${RALLAR_AR_EYE_APP_DIR:-${RALLAR_AR_EYE_APP_DIR_DEFAULT}}"
	RALLAR_AR_EYE_CORS_ORIGINS="${RALLAR_AR_EYE_CORS_ORIGINS:-${RALLAR_GAME_CORS_ORIGINS_DEFAULT}}"
}

# The store-failure fence for a DB-bearing service; empty for services without a Postgres store.
rallar_role_service_failure_file() {
	case "$1" in
	rallar-api-v1.service | rallar-api-v1-2.service | rallar-api-v1-3.service)
		printf '%s' "${RALLAR_API_STORE_FAILURE_FILE:-${RALLAR_API_STORE_FAILURE_FILE_DEFAULT}}"
		;;
	rallar-relic-hunter-server-v1.service) printf '%s' "${RALLAR_RELIC_STORE_FAILURE_FILE:-${RALLAR_RELIC_STORE_FAILURE_FILE_DEFAULT}}" ;;
	rallar-ar-eye-hunter-server-v1.service) printf '%s' "${RALLAR_AR_EYE_STORE_FAILURE_FILE:-${RALLAR_AR_EYE_STORE_FAILURE_FILE_DEFAULT}}" ;;
	*) return 1 ;;
	esac
}

rallar_controller_role_url_origin() {
	local url="${1:-}"
	local scheme rest host

	if [[ "${url}" != http://* && "${url}" != https://* ]]; then
		return 1
	fi
	scheme="${url%%://*}"
	rest="${url#*://}"
	host="${rest%%/*}"
	[[ -n "${scheme}" && -n "${host}" ]] || return 1
	printf '%s://%s' "${scheme}" "${host}"
}

# Writes the api role's three api-v1 replica systemd units. Each replica binds its own
# loopback port (from RALLAR_API_REPLICA_PORTS) and shares the one Postgres store in the env file.
write_rallar_api_replica_units() {
	local api_replica_index=0 api_replica_port
	local unit_dir="${RALLAR_SYSTEMD_UNIT_DIR:-/etc/systemd/system}"
	for api_replica_service in "${RALLAR_ROLE_APP_SERVICES[@]}"; do
		api_replica_port="${RALLAR_API_REPLICA_PORTS[${api_replica_index}]}"
		cat >"${unit_dir}/${api_replica_service}" <<EOF
[Unit]
Description=Rallar API-v1 controller replica ${api_replica_port}
After=network-online.target postgresql.service
Wants=network-online.target postgresql.service
ConditionPathExists=!${RALLAR_API_STORE_FAILURE_FILE}

[Service]
Type=simple
User=rallar
Group=rallar
WorkingDirectory=${RALLAR_CHECKOUT_DIR}/apps/api-v1
EnvironmentFile=/etc/rallar/api-v1.env
EnvironmentFile=-/etc/rallar/api-v1.secrets.env
ExecStart=/usr/bin/env PORT=${api_replica_port} /usr/local/bin/bun run src/main.ts
SyslogIdentifier=${api_replica_service%.service}
Restart=always
RestartSec=5
NoNewPrivileges=true
PrivateTmp=true

[Install]
WantedBy=multi-user.target
EOF
		api_replica_index=$((api_replica_index + 1))
	done
}

# Writes the role's Caddyfile: each server only serves the hosts its role owns.
write_rallar_role_caddyfile() {
	local caddyfile caddy_dir tmp_file spa_origin
	caddyfile="${RALLAR_CADDYFILE:-/etc/caddy/Caddyfile}"
	caddy_dir="${caddyfile%/*}"
	if [[ "${caddy_dir}" == "${caddyfile}" ]]; then
		caddy_dir="."
	fi
	spa_origin="$(rallar_controller_role_url_origin "${RALLAR_BLACK_BOX_SPA_URL:-https://${RALLAR_BLACKBOX_HOST_DEFAULT}}" || printf 'https://%s' "${RALLAR_BLACKBOX_HOST_DEFAULT}")"
	tmp_file="$(mktemp)"

	{
		if [[ -n "${RALLAR_ACME_EMAIL:-}" ]]; then
			printf '{\n\temail %s\n}\n\n' "${RALLAR_ACME_EMAIL}"
		fi
		case "${RALLAR_CONTROLLER_ROLE}" in
		api)
			cat <<EOF
${RALLAR_API_HOST:-${RALLAR_API_HOST_DEFAULT}} {
	reverse_proxy ${RALLAR_API_REPLICA_PORTS_UPSTREAMS}
}

${RALLAR_BLACKBOX_HOST:-${RALLAR_BLACKBOX_HOST_DEFAULT}} {
	root * /var/www/rallar-black-box
	try_files {path} {path}/index.html /index.html
	file_server
}
EOF
			;;
		control)
			cat <<EOF
${RALLAR_CONTROL_HOST:-${RALLAR_CONTROL_HOST_DEFAULT}} {
	reverse_proxy 127.0.0.1:${RALLAR_CONTROL_PORT:-${RALLAR_CONTROL_PORT_DEFAULT}}
	handle_errors {
		header Access-Control-Allow-Origin "${spa_origin}"
		header Access-Control-Allow-Methods "GET,POST,DELETE,OPTIONS"
		header Access-Control-Allow-Headers "Content-Type,Authorization,X-Rallar-Run-Token"
		header Vary "Origin"
		respond "Rallar Black Box control upstream unavailable" 502
	}
}
EOF
			;;
		games)
			cat <<EOF
${RALLAR_RELIC_HOST} {
	reverse_proxy 127.0.0.1:${RALLAR_RELIC_PORT}
}

${RALLAR_AR_EYE_HOST} {
	reverse_proxy 127.0.0.1:${RALLAR_AR_EYE_PORT}
}
EOF
			;;
		esac
	} >"${tmp_file}"

	if ! caddy fmt --overwrite "${tmp_file}"; then
		rm -f "${tmp_file}"
		return 1
	fi
	if ! caddy validate --config "${tmp_file}" --adapter caddyfile; then
		rm -f "${tmp_file}"
		return 1
	fi

	install -d -m 0755 "${caddy_dir}"
	install -m 0644 "${tmp_file}" "${caddyfile}"
	rm -f "${tmp_file}"
}

run_rallar_controller_role_self_test() {
	case "${RALLAR_CONTROLLER_ROLE_SELF_TEST:-}" in
	resolve)
		apply_rallar_controller_role
		printf 'role=%s\nhasPostgres=%s\nwritesHeadlessWorker=%s\nhost=%s\nport=%s\nservices=%s\n' \
			"${RALLAR_CONTROLLER_ROLE}" "${RALLAR_ROLE_HAS_POSTGRES}" "${RALLAR_ROLE_WRITES_HEADLESS_WORKER}" \
			"${RALLAR_ROLE_HOST}" "${RALLAR_ROLE_PORT}" "$(printf '%s ' "${RALLAR_ROLE_APP_SERVICES[@]}")"
		;;
	*)
		echo "Unknown RALLAR_CONTROLLER_ROLE_SELF_TEST: ${RALLAR_CONTROLLER_ROLE_SELF_TEST:-}" >&2
		return 2
		;;
	esac
}

if [[ "${BASH_SOURCE[0]}" == "$0" && "${RALLAR_CONTROLLER_ROLE_SELF_TEST:-0}" != "0" ]]; then
	set -Eeuo pipefail
	run_rallar_controller_role_self_test
fi
