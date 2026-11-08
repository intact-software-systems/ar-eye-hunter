#!/usr/bin/env bash

# Game-server deployment surface for the games role: env files, systemd units, and the named
# Postgres stores behind relic-hunter-server-v1 and ar-eye-hunter-server-v1. It reuses the
# shared Postgres store helpers from rallar-api-prod-profile.sh by selecting each store's role,
# database name, and failure file before provision/migrate/read. Role facts (hosts, ports, store
# names, service names, env/failure files) live in rallar-controller-role.sh.

RALLAR_GAMES_PROD_PROFILE_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
source "${RALLAR_GAMES_PROD_PROFILE_DIR}/rallar-api-prod-profile.sh"
source "${RALLAR_GAMES_PROD_PROFILE_DIR}/rallar-controller-role.sh"

# Selects one game server's store then resolves (or generates) its loopback DATABASE_URL.
resolve_rallar_game_database_url() {
	local env_file="$1"
	local role="$2"
	local name="$3"
	local failure_file="$4"

	select_rallar_postgres_store "${role}" "${name}" "${failure_file}"
	resolve_rallar_api_database_url "${env_file}"
}

read_rallar_game_database_url() {
	local env_file="$1"
	local role="$2"
	local name="$3"
	local failure_file="$4"

	select_rallar_postgres_store "${role}" "${name}" "${failure_file}"
	read_rallar_api_database_url "${env_file}"
}

# Writes a game server's root-owned 0600 env file. DATABASE_URL is generated once by the caller
# and preserved across deploys/rollouts. The operator-token secret and client allowlist are also
# written because the game servers reuse api-v1's prod configuration, which validates them.
write_rallar_game_server_env_file() {
	local env_file="$1"
	local host="$2"
	local port="$3"
	local cors_origins="$4"
	local database_url="$5"
	local auth_secret="$6"
	local operator_token_secret="$7"
	local operator_client_ids="$8"
	local bindings_json="$9"

	install -d -m 0700 -o root -g root "$(dirname "${env_file}")"
	cat >"${env_file}" <<EOF
RALLAR_API_CONFIGURATION_PROFILE=prod
RALLAR_ICE_MODE=local
DATABASE_URL=${database_url}
PORT=${port}
CORS_ORIGINS=${cors_origins}
RALLAR_API_BASE_URL=https://${host}
RALLAR_WS_BASE_URL=wss://${host}
RALLAR_AUTH_CREDENTIAL_SECRET=${auth_secret}
RALLAR_BLACK_BOX_OPERATOR_TOKEN_SECRET=${operator_token_secret}
RALLAR_BLACK_BOX_OPERATOR_CLIENT_IDS=${operator_client_ids}
RALLAR_ROOM_OWNED_APP_DATA_BINDINGS_JSON=${bindings_json}
EOF
	chmod 0600 "${env_file}"
}

# Writes a game server's systemd unit, mirroring the api-v1 unit shape (Bun entry point in the
# app dir, env-file from /etc/rallar, rallar user, restart policy, and a store-failure fence).
write_rallar_game_server_unit() {
	local service="$1"
	local app_dir="$2"
	local env_file="$3"
	local failure_file="$4"
	local checkout_dir="$5"
	local description="$6"

	cat >"/etc/systemd/system/${service}" <<EOF
[Unit]
Description=${description}
After=network-online.target postgresql.service
Wants=network-online.target postgresql.service
ConditionPathExists=!${failure_file}

[Service]
Type=simple
User=rallar
Group=rallar
WorkingDirectory=${checkout_dir}/${app_dir}
EnvironmentFile=${env_file}
ExecStart=/usr/local/bin/bun run src/main.ts
Restart=always
RestartSec=5
NoNewPrivileges=true
PrivateTmp=true

[Install]
WantedBy=multi-user.target
EOF
}

# Resolves (or generates) one game server's loopback DATABASE_URL and stable secrets, then
# writes its env file and systemd unit. The store itself is provisioned/migrated by the caller.
write_rallar_game_server_surface() {
	local app_dir="$1"
	local service="$2"
	local env_file="$3"
	local failure_file="$4"
	local host="$5"
	local port="$6"
	local role="$7"
	local name="$8"
	local cors_origins="$9"
	local bindings_json="${10}"

	local database_url auth_secret existing_auth operator_token_secret operator_client_ids
	local existing_operator_token existing_operator_ids
	if [[ -e "${env_file}" || -L "${env_file}" ]]; then
		database_url="$(read_rallar_game_database_url "${env_file}" "${role}" "${name}" "${failure_file}")"
		existing_auth="$(read_rallar_api_file_value "${env_file}" RALLAR_AUTH_CREDENTIAL_SECRET || true)"
		existing_operator_token="$(read_rallar_api_file_value "${env_file}" RALLAR_BLACK_BOX_OPERATOR_TOKEN_SECRET || true)"
		existing_operator_ids="$(read_rallar_api_file_value "${env_file}" RALLAR_BLACK_BOX_OPERATOR_CLIENT_IDS || true)"
	else
		database_url="$(resolve_rallar_game_database_url "${env_file}" "${role}" "${name}" "${failure_file}")"
		existing_auth=""
		existing_operator_token=""
		existing_operator_ids=""
	fi
	auth_secret="${existing_auth:-${RALLAR_GAME_AUTH_CREDENTIAL_SECRET:-$(openssl rand -hex 32)}}"
	if ((${#auth_secret} < 32)); then
		echo "RALLAR_AUTH_CREDENTIAL_SECRET for ${service} must contain at least 32 characters." >&2
		return 1
	fi
	operator_token_secret="${existing_operator_token:-${RALLAR_GAME_OPERATOR_TOKEN_SECRET:-$(openssl rand -hex 32)}}"
	operator_client_ids="${existing_operator_ids:-${RALLAR_GAME_OPERATOR_CLIENT_IDS:-hosted-operator-$(openssl rand -hex 8)}}"
	write_rallar_game_server_env_file "${env_file}" "${host}" "${port}" "${cors_origins}" "${database_url}" "${auth_secret}" "${operator_token_secret}" "${operator_client_ids}" "${bindings_json}"
	write_rallar_game_server_unit "${service}" "${app_dir}" "${env_file}" "${failure_file}" "${RALLAR_CHECKOUT_DIR:-/opt/rallar/ar-eye-hunter}" "Rallar ${service%%.service} game server"
}

rallar_games_prod_profile_self_test() {
	case "${RALLAR_GAMES_PROD_PROFILE_SELF_TEST:-}" in
	resolve-relic-database-url)
		RALLAR_CONTROLLER_ROLE=games
		apply_rallar_controller_role
		resolve_rallar_game_database_url \
			"${RALLAR_GAME_ENV_FILE:?RALLAR_GAME_ENV_FILE is required}" \
			"${RALLAR_RELIC_DATABASE_ROLE}" "${RALLAR_RELIC_DATABASE_NAME}" \
			"${RALLAR_RELIC_STORE_FAILURE_FILE}"
		echo
		;;
	*)
		echo "Unknown RALLAR_GAMES_PROD_PROFILE_SELF_TEST: ${RALLAR_GAMES_PROD_PROFILE_SELF_TEST:-}" >&2
		return 2
		;;
	esac
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
	set -Eeuo pipefail
	rallar_games_prod_profile_self_test
fi
