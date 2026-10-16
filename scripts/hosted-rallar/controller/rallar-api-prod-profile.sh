#!/usr/bin/env bash

RALLAR_API_PROD_PROFILE_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
source "${RALLAR_API_PROD_PROFILE_DIR}/rallar-apt-sources.sh"

RALLAR_API_DATABASE_ROLE="rallar"
RALLAR_API_DATABASE_NAME="rallar_api_v1"
RALLAR_API_DATABASE_URL_PATTERN="^postgres://${RALLAR_API_DATABASE_ROLE}:([0-9a-f]{64})@127\.0\.0\.1:5432/${RALLAR_API_DATABASE_NAME}$"

install_rallar_api_postgres_server() {
	if [[ "$(dpkg-query -W -f='${db:Status-Status}' postgresql 2>/dev/null || true)" != "installed" ]]; then
		echo "==> Installing PostgreSQL from the Ubuntu archive"
		local apt_dir
		apt_dir="$(mktemp -d "${TMPDIR:-/tmp}/rallar-apt-postgres.XXXXXX")"
		write_rallar_apt_profile ubuntu "${apt_dir}/ubuntu.conf"
		env DEBIAN_FRONTEND=noninteractive APT_CONFIG="${apt_dir}/ubuntu.conf" apt update
		env DEBIAN_FRONTEND=noninteractive APT_CONFIG="${apt_dir}/ubuntu.conf" apt install -y postgresql
		rm -rf -- "${apt_dir}"
	fi
	systemctl enable --now postgresql.service
}

read_rallar_api_database_url() {
	local env_file="$1"
	local value=""

	if [[ -r "${env_file}" ]]; then
		value="$(grep -E '^DATABASE_URL=' "${env_file}" | tail -n 1 | cut -d= -f2- || true)"
	fi
	if [[ "${value}" =~ ${RALLAR_API_DATABASE_URL_PATTERN} ]]; then
		printf '%s' "${value}"
	fi
}

resolve_rallar_api_database_url() {
	local database_url
	database_url="$(read_rallar_api_database_url "$1")"
	if [[ -z "${database_url}" ]]; then
		database_url="postgres://${RALLAR_API_DATABASE_ROLE}:$(openssl rand -hex 32)@127.0.0.1:5432/${RALLAR_API_DATABASE_NAME}"
	fi
	printf '%s' "${database_url}"
}

# The prod profile refuses an empty operator allowlist and bundled demo identities.
resolve_rallar_api_operator_client_ids() {
	local env_file="$1"
	local requested="$2"
	local current=""

	if [[ -n "${requested}" ]]; then
		printf '%s' "${requested}"
		return 0
	fi
	if [[ -r "${env_file}" ]]; then
		current="$(grep -E '^RALLAR_BLACK_BOX_OPERATOR_CLIENT_IDS=' "${env_file}" | tail -n 1 | cut -d= -f2- || true)"
	fi
	if [[ -n "${current}" ]]; then
		printf '%s' "${current}"
		return 0
	fi
	printf 'hosted-operator-%s' "$(openssl rand -hex 8)"
}

write_rallar_api_postgres_sql() {
	(cd / && runuser -u postgres -- psql --no-psqlrc --quiet -v ON_ERROR_STOP=1 -d postgres)
}

reset_rallar_api_postgres_store() {
	local checkout_dir="$1"
	local database_url="$2"

	if ! [[ "${database_url}" =~ ${RALLAR_API_DATABASE_URL_PATTERN} ]]; then
		echo "Missing the controller DATABASE_URL for ${RALLAR_API_DATABASE_NAME}; refusing to wipe the API store." >&2
		return 1
	fi
	local password="${BASH_REMATCH[1]}"

	echo "==> Wiping the API-v1 Postgres store ${RALLAR_API_DATABASE_NAME}"
	write_rallar_api_postgres_sql <<EOF_SQL
SELECT 'CREATE ROLE ${RALLAR_API_DATABASE_ROLE} LOGIN' WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = '${RALLAR_API_DATABASE_ROLE}')\gexec
ALTER ROLE ${RALLAR_API_DATABASE_ROLE} WITH LOGIN PASSWORD '${password}';
DROP DATABASE IF EXISTS ${RALLAR_API_DATABASE_NAME} WITH (FORCE);
CREATE DATABASE ${RALLAR_API_DATABASE_NAME} OWNER ${RALLAR_API_DATABASE_ROLE};
EOF_SQL

	echo "==> Applying API-v1 Prisma migrations"
	(
		cd / &&
			DATABASE_URL="${database_url}" runuser -u rallar -- env DENO_DIR=/var/lib/rallar-deno deno task \
				--config "${checkout_dir}/apps/api-v1/deno.json" prisma migrate deploy
	)
}

rallar_api_prod_profile_self_test() {
	case "${RALLAR_API_PROD_PROFILE_SELF_TEST:-}" in
	install-server)
		install_rallar_api_postgres_server
		echo "installedApiPostgresServer=true"
		;;
	reset-store)
		reset_rallar_api_postgres_store \
			"${RALLAR_CHECKOUT_DIR:?RALLAR_CHECKOUT_DIR is required}" \
			"$(read_rallar_api_database_url "${RALLAR_API_ENV_FILE:?RALLAR_API_ENV_FILE is required}")"
		echo "resetApiPostgresStore=true"
		;;
	*)
		echo "Unknown RALLAR_API_PROD_PROFILE_SELF_TEST: ${RALLAR_API_PROD_PROFILE_SELF_TEST:-}" >&2
		return 2
		;;
	esac
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
	set -Eeuo pipefail
	rallar_api_prod_profile_self_test
fi
