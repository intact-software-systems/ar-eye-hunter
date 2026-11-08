#!/usr/bin/env bash
set -Eeuo pipefail

if [[ "$(id -u)" != "0" ]]; then
	echo "Run this script as root." >&2
	exit 1
fi

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/rallar-controller-lock.sh"
rallar_lock_controller
source "${SCRIPT_DIR}/rallar-bun-runtime.sh"
source "${SCRIPT_DIR}/rallar-controller-role.sh"
source "${SCRIPT_DIR}/rallar-public-spa-env.sh"
source "${SCRIPT_DIR}/rallar-playwright-install.sh"
source "${SCRIPT_DIR}/rallar-api-prod-profile.sh"
source "${SCRIPT_DIR}/rallar-headless-worker-env.sh"
source "${SCRIPT_DIR}/rallar-games-prod-profile.sh"
apply_rallar_controller_role

RALLAR_REPO_URL="${RALLAR_REPO_URL:-https://github.com/intact-software-systems/ar-eye-hunter.git}"
RALLAR_REPO_REF="${RALLAR_REPO_REF:-main}"
RALLAR_CHECKOUT_DIR="${RALLAR_CHECKOUT_DIR:-/opt/rallar/ar-eye-hunter}"
RALLAR_API_HOST="${RALLAR_API_HOST:-api.rallar.intactss.com}"
RALLAR_CONTROL_HOST="${RALLAR_CONTROL_HOST:-control.rallar.intactss.com}"
RALLAR_BLACKBOX_HOST="${RALLAR_BLACKBOX_HOST:-blackbox.rallar.intactss.com}"
RALLAR_RETENTION_MAX_RUNS="${RALLAR_RETENTION_MAX_RUNS:-5}"
RALLAR_INSTALL_PLAYWRIGHT="${RALLAR_INSTALL_PLAYWRIGHT:-1}"
RALLAR_ACME_EMAIL="${RALLAR_ACME_EMAIL:-}"
RALLAR_BLACK_BOX_OPERATOR_TOKEN_TTL_MS="${RALLAR_BLACK_BOX_OPERATOR_TOKEN_TTL_MS:-86400000}"
RALLAR_BLACK_BOX_OPERATOR_CLIENT_IDS="${RALLAR_BLACK_BOX_OPERATOR_CLIENT_IDS:-}"

apply_rallar_public_spa_defaults
apply_rallar_public_cors_defaults

require_command() {
	if ! command -v "$1" >/dev/null 2>&1; then
		echo "Missing required command: $1. Run 01-install-runtime.sh first." >&2
		exit 1
	fi
}

require_command git
require_command npm
require_command bun
require_rallar_min_bun_version
require_command caddy
require_command openssl
require_command curl

stop_controller_service_for_store_change() {
	local service="$1"
	local original_load_state="$2"
	local active_state
	if [[ -z "${original_load_state}" ]]; then
		echo "Cannot determine whether ${service} was installed; refusing a store change." >&2
		return 1
	fi
	if [[ "${original_load_state}" != not-found ]]; then
		systemctl stop "${service}" || {
			echo "Could not stop ${service}; refusing a store change." >&2
			return 1
		}
	fi
	active_state="$(systemctl show -p ActiveState --value "${service}")" || return 1
	if [[ "${active_state}" != inactive && "${active_state}" != failed ]]; then
		echo "${service} is ${active_state:-unknown}; refusing a store change." >&2
		return 1
	fi
}

echo "==> Deploying ${RALLAR_REPO_URL} ref ${RALLAR_REPO_REF} for role ${RALLAR_CONTROLLER_ROLE}"
# Re-runs operate on a checkout the first deploy chowned to the rallar user; allow git to trust it.
git config --global --add safe.directory "${RALLAR_CHECKOUT_DIR}"
if [[ -d "${RALLAR_CHECKOUT_DIR}/.git" ]]; then
	git -C "${RALLAR_CHECKOUT_DIR}" fetch --prune origin
else
	install -d -m 0755 -o rallar -g rallar "$(dirname "${RALLAR_CHECKOUT_DIR}")"
	git clone "${RALLAR_REPO_URL}" "${RALLAR_CHECKOUT_DIR}"
fi

git -C "${RALLAR_CHECKOUT_DIR}" checkout "${RALLAR_REPO_REF}"
git -C "${RALLAR_CHECKOUT_DIR}" pull --ff-only origin "${RALLAR_REPO_REF}" || true
chown -R rallar:rallar "${RALLAR_CHECKOUT_DIR}"

echo "==> Installing npm dependencies"
runuser -u rallar -- npm --prefix "${RALLAR_CHECKOUT_DIR}" ci

if [[ "${RALLAR_CONTROLLER_ROLE}" == "api" || "${RALLAR_CONTROLLER_ROLE}" == "control" ]] &&
	{ [[ "${RALLAR_INSTALL_PLAYWRIGHT}" == "1" || "${RALLAR_INSTALL_PLAYWRIGHT}" == "true" ]]; }; then
	install_rallar_playwright_browser "${RALLAR_CHECKOUT_DIR}" "${RALLAR_BLACK_BOX_BROWSER_ENGINE:-chromium}"
fi

case "${RALLAR_CONTROLLER_ROLE}" in
api)
	install_rallar_api_postgres_server

	rallar_api_service_load_state="$(systemctl show -p LoadState --value rallar-api-v1.service)"

	if [[ -e /etc/rallar/api-v1.env || -L /etc/rallar/api-v1.env ]]; then
		validate_rallar_api_existing_store_configuration /etc/rallar/api-v1.env
		RALLAR_API_EXISTING_STORE=1
	else
		require_rallar_api_absent_store
		RALLAR_API_EXISTING_STORE=0
	fi

	echo "==> Building rallar-black-box SPA"
	build_rallar_black_box_spa "${RALLAR_CHECKOUT_DIR}"

	echo "==> Publishing SPA static files"
	rm -rf /var/www/rallar-black-box/*
	rsync -a --delete \
		"${RALLAR_CHECKOUT_DIR}/apps/rallar-black-box/dist/" \
		/var/www/rallar-black-box/
	install -d -m 0755 -o caddy -g caddy /var/www/rallar-black-box/headless
	rsync -a --delete \
		"${RALLAR_CHECKOUT_DIR}/apps/rallar-black-box-headless/dist/" \
		/var/www/rallar-black-box/headless/
	chown -R caddy:caddy /var/www/rallar-black-box

	echo "==> Writing environment files"
	install -d -m 0700 -o root -g root /etc/rallar
	write_rallar_black_box_spa_env_file

	if [[ "${RALLAR_API_EXISTING_STORE}" == "1" ]]; then
		RALLAR_BLACK_BOX_OPERATOR_TOKEN_SECRET="$(read_rallar_api_effective_env_value /etc/rallar/api-v1.env RALLAR_BLACK_BOX_OPERATOR_TOKEN_SECRET)"
		RALLAR_AUTH_CREDENTIAL_SECRET="$(read_rallar_api_effective_env_value /etc/rallar/api-v1.env RALLAR_AUTH_CREDENTIAL_SECRET)"
	else
		RALLAR_BLACK_BOX_OPERATOR_TOKEN_SECRET="${RALLAR_BLACK_BOX_OPERATOR_TOKEN_SECRET:-$(openssl rand -hex 32)}"
		RALLAR_AUTH_CREDENTIAL_SECRET="${RALLAR_AUTH_CREDENTIAL_SECRET:-$(openssl rand -hex 32)}"
	fi
	if ((${#RALLAR_AUTH_CREDENTIAL_SECRET} < 32)); then
		echo "RALLAR_AUTH_CREDENTIAL_SECRET must contain at least 32 characters." >&2
		exit 1
	fi

	RALLAR_API_DATABASE_URL="$(resolve_rallar_api_database_url /etc/rallar/api-v1.env)"
	RALLAR_BLACK_BOX_OPERATOR_CLIENT_IDS="$(
		resolve_rallar_api_operator_client_ids /etc/rallar/api-v1.env "${RALLAR_BLACK_BOX_OPERATOR_CLIENT_IDS}"
	)"

	CO_LOCATED_AUTH_IP_RATE_LIMIT=200
	RALLAR_API_TIMING_LOGS=0
	RALLAR_API_APP_INBOX_PHASE_TIMING=false
	case "$(printf '%s' "${RALLAR_API_SERVER_TIMING:-0}" | tr '[:upper:]' '[:lower:]')" in
	1 | true | yes | on)
		RALLAR_API_TIMING_LOGS=1
		RALLAR_API_APP_INBOX_PHASE_TIMING=true
		;;
	esac

	cat >/etc/rallar/api-v1.env <<EOF
RALLAR_API_CONFIGURATION_PROFILE=prod
RALLAR_ICE_MODE=local
DATABASE_URL=${RALLAR_API_DATABASE_URL}
PORT=8080
CORS_ORIGINS=${RALLAR_API_CORS_ORIGINS}
RALLAR_API_BASE_URL=https://${RALLAR_API_HOST}
RALLAR_WS_BASE_URL=wss://${RALLAR_API_HOST}
RALLAR_LOGIN_USER_RATE_LIMIT=100
RALLAR_REGISTRATION_IP_RATE_LIMIT=${CO_LOCATED_AUTH_IP_RATE_LIMIT}
RALLAR_LOGIN_IP_RATE_LIMIT=${CO_LOCATED_AUTH_IP_RATE_LIMIT}
RALLAR_TIMING_LOGS=${RALLAR_API_TIMING_LOGS}
RALLAR_APP_INBOX_PHASE_TIMING=${RALLAR_API_APP_INBOX_PHASE_TIMING}
RALLAR_AUTH_CREDENTIAL_SECRET=${RALLAR_AUTH_CREDENTIAL_SECRET}
RALLAR_BLACK_BOX_OPERATOR_TOKEN_SECRET=${RALLAR_BLACK_BOX_OPERATOR_TOKEN_SECRET}
RALLAR_BLACK_BOX_OPERATOR_TOKEN_TTL_MS=${RALLAR_BLACK_BOX_OPERATOR_TOKEN_TTL_MS}
RALLAR_BLACK_BOX_OPERATOR_CLIENT_IDS=${RALLAR_BLACK_BOX_OPERATOR_CLIENT_IDS}
EOF
	chmod 0600 /etc/rallar/api-v1.env
	echo "API-v1 uses the prod profile on this VM's Postgres store ${RALLAR_API_DATABASE_NAME}; deploy and rollout preserve existing data."

	echo "==> Writing systemd services"
	write_rallar_api_replica_units

	echo "==> Writing Caddyfile"
	write_rallar_role_caddyfile

	echo "==> Preparing the API-v1 Postgres store"
	systemctl daemon-reload
	for api_replica_service in "${RALLAR_ROLE_APP_SERVICES[@]}"; do
		stop_controller_service_for_store_change "${api_replica_service}" "$(systemctl show -p LoadState --value "${api_replica_service}")"
	done
	if [[ "${RALLAR_API_EXISTING_STORE}" == "1" ]]; then
		migrate_rallar_api_postgres_store "${RALLAR_CHECKOUT_DIR}" "${RALLAR_API_DATABASE_URL}"
	else
		provision_rallar_api_postgres_store "${RALLAR_CHECKOUT_DIR}" "${RALLAR_API_DATABASE_URL}"
	fi

	echo "==> Starting services"
	for api_replica_service in "${RALLAR_ROLE_APP_SERVICES[@]}"; do
		systemctl enable --now "${api_replica_service}"
		systemctl restart "${api_replica_service}"
	done
	systemctl reload caddy || systemctl restart caddy

	echo "==> Local health checks"
	for api_replica_port in "${RALLAR_API_REPLICA_PORTS[@]}"; do
		curl -fsS "http://127.0.0.1:${api_replica_port}/api/config" >/dev/null
		curl -fsS "http://127.0.0.1:${api_replica_port}/api/docs" >/dev/null
	done
	;;
control)
	echo "==> Writing environment files"
	install -d -m 0700 -o root -g root /etc/rallar
	install -d -m 0755 -o rallar -g rallar /var/lib/rallar-black-box-control

	if [[ -z "${RALLAR_BLACK_BOX_OPERATOR_TOKEN_SECRET:-}" && -r /etc/rallar/control-server.env ]]; then
		RALLAR_BLACK_BOX_OPERATOR_TOKEN_SECRET="$(
			grep -E "^RALLAR_BLACK_BOX_OPERATOR_TOKEN_SECRET=" /etc/rallar/control-server.env |
				tail -n 1 |
				cut -d= -f2- || true
		)"
	fi
	if [[ -z "${RALLAR_BLACK_BOX_OPERATOR_TOKEN_SECRET:-}" ]]; then
		RALLAR_BLACK_BOX_OPERATOR_TOKEN_SECRET="$(openssl rand -hex 32)"
		echo "WARNING: generated a new operator token secret; it must match the API-v1 server's RALLAR_BLACK_BOX_OPERATOR_TOKEN_SECRET." >&2
	fi
	if [[ -z "${RALLAR_CONTROL_ADMIN_TOKEN:-}" && -r /etc/rallar/control-server.env ]]; then
		RALLAR_CONTROL_ADMIN_TOKEN="$(
			grep -E "^RALLAR_BLACK_BOX_ADMIN_TOKEN=" /etc/rallar/control-server.env |
				tail -n 1 |
				cut -d= -f2- || true
		)"
	fi
	if [[ -z "${RALLAR_CONTROL_ADMIN_TOKEN:-}" ]]; then
		RALLAR_CONTROL_ADMIN_TOKEN="$(openssl rand -hex 32)"
	fi

	cat >/etc/rallar/control-server.env <<EOF
PORT=5180
RALLAR_BLACK_BOX_ADMIN_TOKEN=${RALLAR_CONTROL_ADMIN_TOKEN}
RALLAR_BLACK_BOX_OPERATOR_TOKEN_SECRET=${RALLAR_BLACK_BOX_OPERATOR_TOKEN_SECRET}
RALLAR_BLACK_BOX_REQUIRE_TLS=1
RALLAR_BLACK_BOX_ALLOWED_ORIGINS=${RALLAR_BLACK_BOX_ALLOWED_ORIGINS}
RALLAR_BLACK_BOX_HTTP_ALLOWED_HOSTS=${RALLAR_API_HOST}
RALLAR_BLACK_BOX_WS_ALLOWED_HOSTS=${RALLAR_API_HOST},${RALLAR_CONTROL_HOST}
RALLAR_BLACK_BOX_STORAGE_DIR=/var/lib/rallar-black-box-control
RALLAR_BLACK_BOX_RETENTION_MAX_RUNS=${RALLAR_RETENTION_MAX_RUNS}
RALLAR_BLACK_BOX_RUNTIME_RETAIN_COMMANDS=1000
RALLAR_BLACK_BOX_RUNTIME_RETAIN_RESULTS=1000
RALLAR_BLACK_BOX_RUNTIME_RETAIN_EVENTS=2000
RALLAR_BLACK_BOX_RUNTIME_RETAIN_STATS=500
RALLAR_BLACK_BOX_RUNTIME_RETAIN_REPORTS=20
RALLAR_BLACK_BOX_RUNTIME_RETAIN_HEARTBEATS=500
RALLAR_BLACK_BOX_SNAPSHOT_PERSIST_REPORTS=20
RALLAR_BLACK_BOX_SNAPSHOT_FLUSH_INTERVAL_MS=10000
EOF
	chmod 0600 /etc/rallar/control-server.env

	echo "==> Writing systemd services"
	cat >/etc/systemd/system/rallar-black-box-control.service <<EOF
[Unit]
Description=Rallar Black Box control server
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=rallar
Group=rallar
WorkingDirectory=${RALLAR_CHECKOUT_DIR}/apps/rallar-black-box-control-server
EnvironmentFile=/etc/rallar/control-server.env
ExecStart=/usr/local/bin/bun run src/main.ts
Restart=always
RestartSec=5
NoNewPrivileges=true
PrivateTmp=true

[Install]
WantedBy=multi-user.target
EOF
	write_rallar_headless_worker_unit \
		"rallar-black-box-headless-worker.service" \
		"${RALLAR_HEADLESS_ENV_FILE:-/etc/rallar/headless-worker.env}" \
		"${RALLAR_CHECKOUT_DIR}"

	echo "==> Writing Caddyfile"
	write_rallar_role_caddyfile

	echo "==> Starting services"
	systemctl daemon-reload
	systemctl enable --now rallar-black-box-control.service
	systemctl restart rallar-black-box-control.service
	systemctl reload caddy || systemctl restart caddy

	echo "==> Local health checks"
	curl -fsS -H "x-forwarded-proto: https" http://127.0.0.1:5180/health >/dev/null
	verify_rallar_control_public_cors
	;;
games)
	install_rallar_api_postgres_server

	relic_store_existing=0
	ar_eye_store_existing=0
	[[ -e "${RALLAR_RELIC_ENV_FILE}" || -L "${RALLAR_RELIC_ENV_FILE}" ]] && relic_store_existing=1
	[[ -e "${RALLAR_AR_EYE_ENV_FILE}" || -L "${RALLAR_AR_EYE_ENV_FILE}" ]] && ar_eye_store_existing=1

	echo "==> Writing environment files and systemd services"
	install -d -m 0700 -o root -g root /etc/rallar
	write_rallar_game_server_surface \
		"${RALLAR_RELIC_APP_DIR}" "${RALLAR_RELIC_SERVICE}" "${RALLAR_RELIC_ENV_FILE}" "${RALLAR_RELIC_STORE_FAILURE_FILE}" \
		"${RALLAR_RELIC_HOST}" "${RALLAR_RELIC_PORT}" "${RALLAR_RELIC_DATABASE_ROLE}" "${RALLAR_RELIC_DATABASE_NAME}" \
		"${RALLAR_RELIC_CORS_ORIGINS}" \
		'[{"applicationId":"rallar-server","workspaceId":"default","namespace":"relic-hunter-v1","storeName":"relic-hunter-games"}]'
	write_rallar_game_server_surface \
		"${RALLAR_AR_EYE_APP_DIR}" "${RALLAR_AR_EYE_SERVICE}" "${RALLAR_AR_EYE_ENV_FILE}" "${RALLAR_AR_EYE_STORE_FAILURE_FILE}" \
		"${RALLAR_AR_EYE_HOST}" "${RALLAR_AR_EYE_PORT}" "${RALLAR_AR_EYE_DATABASE_ROLE}" "${RALLAR_AR_EYE_DATABASE_NAME}" \
		"${RALLAR_AR_EYE_CORS_ORIGINS}" \
		'[{"applicationId":"ar-eye-hunter","workspaceId":"default","namespace":"app:ar-eye","storeName":"tournament-arenas"}]'

	echo "==> Writing Caddyfile"
	write_rallar_role_caddyfile

	echo "==> Preparing the game Postgres stores"
	relic_load_state="$(systemctl show -p LoadState --value "${RALLAR_RELIC_SERVICE}")"
	ar_eye_load_state="$(systemctl show -p LoadState --value "${RALLAR_AR_EYE_SERVICE}")"
	systemctl daemon-reload
	stop_controller_service_for_store_change "${RALLAR_RELIC_SERVICE}" "${relic_load_state}"
	stop_controller_service_for_store_change "${RALLAR_AR_EYE_SERVICE}" "${ar_eye_load_state}"

	select_rallar_postgres_store "${RALLAR_RELIC_DATABASE_ROLE}" "${RALLAR_RELIC_DATABASE_NAME}" "${RALLAR_RELIC_STORE_FAILURE_FILE}"
	if [[ "${relic_store_existing}" == "1" ]]; then
		migrate_rallar_api_postgres_store "${RALLAR_CHECKOUT_DIR}" "$(read_rallar_api_database_url "${RALLAR_RELIC_ENV_FILE}")"
	else
		provision_rallar_api_postgres_store "${RALLAR_CHECKOUT_DIR}" "$(read_rallar_api_database_url "${RALLAR_RELIC_ENV_FILE}")"
	fi

	select_rallar_postgres_store "${RALLAR_AR_EYE_DATABASE_ROLE}" "${RALLAR_AR_EYE_DATABASE_NAME}" "${RALLAR_AR_EYE_STORE_FAILURE_FILE}"
	if [[ "${ar_eye_store_existing}" == "1" ]]; then
		migrate_rallar_api_postgres_store "${RALLAR_CHECKOUT_DIR}" "$(read_rallar_api_database_url "${RALLAR_AR_EYE_ENV_FILE}")"
	else
		provision_rallar_api_postgres_store "${RALLAR_CHECKOUT_DIR}" "$(read_rallar_api_database_url "${RALLAR_AR_EYE_ENV_FILE}")"
	fi

	echo "==> Starting services"
	systemctl enable --now "${RALLAR_RELIC_SERVICE}"
	systemctl enable --now "${RALLAR_AR_EYE_SERVICE}"
	systemctl restart "${RALLAR_RELIC_SERVICE}"
	systemctl restart "${RALLAR_AR_EYE_SERVICE}"
	systemctl reload caddy || systemctl restart caddy

	echo "==> Local health checks"
	curl -fsS "http://127.0.0.1:${RALLAR_RELIC_PORT}/api/config" >/dev/null
	curl -fsS "http://127.0.0.1:${RALLAR_AR_EYE_PORT}/api/config" >/dev/null
	;;
esac

echo "Deployment complete."
case "${RALLAR_CONTROLLER_ROLE}" in
api)
	echo "Public checks:"
	echo "  https://${RALLAR_API_HOST}/api/config"
	echo "  https://${RALLAR_API_HOST}/api/docs"
	;;
control)
	echo "Public checks:"
	echo "  https://${RALLAR_CONTROL_HOST}/health"
	echo "  https://${RALLAR_BLACKBOX_HOST}/"
	echo "Control admin token is stored in /etc/rallar/control-server.env"
	;;
games)
	echo "Public checks:"
	echo "  https://${RALLAR_RELIC_HOST}/api/config"
	echo "  https://${RALLAR_AR_EYE_HOST}/api/config"
	;;
esac
