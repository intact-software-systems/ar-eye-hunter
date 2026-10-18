#!/usr/bin/env bash

RALLAR_API_PROD_PROFILE_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
source "${RALLAR_API_PROD_PROFILE_DIR}/rallar-apt-sources.sh"

RALLAR_API_DATABASE_ROLE="rallar"
RALLAR_API_DATABASE_NAME="rallar_api_v1"
RALLAR_API_STORE_FAILURE_FILE="${RALLAR_API_STORE_FAILURE_FILE:-/etc/rallar/api-v1.store-failure}"
RALLAR_API_SECRET_FILE="${RALLAR_API_SECRET_FILE:-/etc/rallar/api-v1.secrets.env}"
RALLAR_CONTROL_ENV_FILE="${RALLAR_CONTROL_ENV_FILE:-/etc/rallar/control-server.env}"
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

# Status 3 means a valid file omitted the key; read and syntax failures use other statuses.
read_rallar_api_file_value() {
	local env_file="$1"
	local key="$2"
	local contents line value="" found=0
	if [[ ! -f "${env_file}" || ! -r "${env_file}" ]]; then
		echo "Cannot read the API secret file or controller environment." >&2
		return 1
	fi
	contents="$(cat -- "${env_file}")" || {
		echo "Cannot read the API secret file or controller environment." >&2
		return 1
	}
	while IFS= read -r line; do
		if [[ "${line}" =~ ^[[:space:]]*(export[[:space:]]+)?${key}[[:space:]]*= ]]; then
			if [[ "${line}" != "${key}="* || "${line}" == *[\'\"\\]* || "${line}" =~ [[:space:]] ]]; then
				echo "Unsupported assignment in the API secret file or controller environment for ${key}." >&2
				return 1
			fi
			value="${line#*=}"
			found=1
		fi
	done <<<"${contents}"
	[[ "${found}" == "1" ]] || return 3
	printf '%s' "${value}"
}

read_rallar_api_effective_env_value() {
	local env_file="$1"
	local key="$2"
	local secret_value status
	if [[ -e "${RALLAR_API_SECRET_FILE}" || -L "${RALLAR_API_SECRET_FILE}" ]]; then
		if secret_value="$(read_rallar_api_file_value "${RALLAR_API_SECRET_FILE}" "${key}")"; then
			printf '%s' "${secret_value}"
			return 0
		else
			status=$?
			[[ "${status}" == "3" ]] || return "${status}"
		fi
	fi
	if secret_value="$(read_rallar_api_file_value "${env_file}" "${key}")"; then
		printf '%s' "${secret_value}"
		return 0
	else
		status=$?
		[[ "${status}" == "3" ]] || return "${status}"
	fi
}

read_rallar_api_database_url() {
	local database_url
	database_url="$(read_rallar_api_effective_env_value "$1" DATABASE_URL)" || return 1
	if ! [[ "${database_url}" =~ ${RALLAR_API_DATABASE_URL_PATTERN} ]]; then
		echo "Invalid controller DATABASE_URL for ${RALLAR_API_DATABASE_NAME}." >&2
		return 1
	fi
	printf '%s' "${database_url}"
}

resolve_rallar_api_database_url() {
	if [[ -e "$1" || -L "$1" ]]; then
		read_rallar_api_database_url "$1"
		return
	fi
	if [[ -e "${RALLAR_API_SECRET_FILE}" || -L "${RALLAR_API_SECRET_FILE}" ]]; then
		local key value
		for key in DATABASE_URL RALLAR_AUTH_CREDENTIAL_SECRET RALLAR_BLACK_BOX_OPERATOR_TOKEN_SECRET; do
			if value="$(read_rallar_api_file_value "${RALLAR_API_SECRET_FILE}" "${key}")"; then
				echo "Existing API store credentials have no controller environment; refusing to provision a new store." >&2
				return 1
			else
				[[ "$?" == "3" ]] || return 1
			fi
		done
	fi
	printf 'postgres://%s:%s@127.0.0.1:5432/%s' \
		"${RALLAR_API_DATABASE_ROLE}" "$(openssl rand -hex 32)" "${RALLAR_API_DATABASE_NAME}"
}

validate_rallar_api_existing_store_configuration() {
	local env_file="$1"
	local auth_secret operator_secret operator_client_ids control_operator_secret
	[[ -f "${env_file}" && -r "${env_file}" ]] || { echo "Missing readable controller API environment." >&2; return 1; }
	read_rallar_api_database_url "${env_file}" >/dev/null || return 1
	auth_secret="$(read_rallar_api_effective_env_value "${env_file}" RALLAR_AUTH_CREDENTIAL_SECRET)" || return 1
	operator_secret="$(read_rallar_api_effective_env_value "${env_file}" RALLAR_BLACK_BOX_OPERATOR_TOKEN_SECRET)" || return 1
	operator_client_ids="$(read_rallar_api_effective_env_value "${env_file}" RALLAR_BLACK_BOX_OPERATOR_CLIENT_IDS)" || return 1
	if ((${#auth_secret} < 32)) || [[ -z "${operator_secret}" ]]; then
		echo "Missing existing API auth or operator secret; refusing to replace credentials." >&2
		return 1
	fi
	if [[ -z "${operator_client_ids}" ]]; then
		echo "Missing existing operator allowlist; refusing to replace configuration." >&2
		return 1
	fi
	if [[ -e "${RALLAR_CONTROL_ENV_FILE}" || -L "${RALLAR_CONTROL_ENV_FILE}" ]]; then
		if [[ ! -f "${RALLAR_CONTROL_ENV_FILE}" || ! -r "${RALLAR_CONTROL_ENV_FILE}" ]]; then
			echo "Cannot read the control-server environment." >&2
			return 1
		fi
		if control_operator_secret="$(read_rallar_api_file_value "${RALLAR_CONTROL_ENV_FILE}" RALLAR_BLACK_BOX_OPERATOR_TOKEN_SECRET)"; then
			:
		else
			[[ "$?" == "3" ]] || return 1
		fi
		if [[ "${control_operator_secret}" != "${operator_secret}" ]]; then
			echo "The control-server operator secret differs from the effective API secret; refusing replacement." >&2
			return 1
		fi
	fi
	if [[ -n "${RALLAR_AUTH_CREDENTIAL_SECRET:-}" && "${RALLAR_AUTH_CREDENTIAL_SECRET}" != "${auth_secret}" ]] ||
		[[ -n "${RALLAR_BLACK_BOX_OPERATOR_TOKEN_SECRET:-}" && "${RALLAR_BLACK_BOX_OPERATOR_TOKEN_SECRET}" != "${operator_secret}" ]]; then
		echo "Requested API secret differs from the active secret; refusing credential rotation during rollout." >&2
		return 1
	fi
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
	if [[ -e "${env_file}" ]]; then
		current="$(read_rallar_api_effective_env_value "${env_file}" RALLAR_BLACK_BOX_OPERATOR_CLIENT_IDS)" || return 1
	fi
	if [[ -n "${current}" ]]; then
		printf '%s' "${current}"
		return 0
	fi
	printf 'hosted-operator-%s' "$(openssl rand -hex 8)"
}

write_rallar_api_postgres_sql() {
	(cd / && runuser -u postgres -- psql --no-psqlrc --quiet -At -v ON_ERROR_STOP=1 -d postgres)
}

# The mark outlives a killed rollout, so the API never starts on an unverified migration.
write_rallar_api_store_failure() {
	local stage="$1"
	local message="The ${stage} of the API-v1 Postgres store ${RALLAR_API_DATABASE_NAME} failed at $(date -u +%Y-%m-%dT%H:%M:%SZ); rallar-api-v1 stays stopped until 08-rollout-controller.sh succeeds."
	printf '%s\n' "${message}" >"${RALLAR_API_STORE_FAILURE_FILE}"
	echo "::error::${message}" >&2
}

migrate_rallar_api_postgres_store() {
	local checkout_dir="$1"
	local database_url="$2"

	if ! [[ "${database_url}" =~ ${RALLAR_API_DATABASE_URL_PATTERN} ]]; then
		echo "Invalid controller DATABASE_URL for ${RALLAR_API_DATABASE_NAME}; refusing to migrate." >&2
		return 1
	fi
	local password="${BASH_REMATCH[1]}"

	echo "==> Checking the existing API-v1 Postgres store ${RALLAR_API_DATABASE_NAME}"
	printf 'The migration of the API-v1 Postgres store %s has not finished.\n' "${RALLAR_API_DATABASE_NAME}" >"${RALLAR_API_STORE_FAILURE_FILE}"
	if ! (cd / && PGPASSWORD="${password}" runuser -u rallar -- psql --no-psqlrc --quiet -v ON_ERROR_STOP=1 \
		-h 127.0.0.1 -p 5432 -U "${RALLAR_API_DATABASE_ROLE}" -d "${RALLAR_API_DATABASE_NAME}" -Atqc 'SELECT 1' >/dev/null); then
		write_rallar_api_store_failure connection
		return 1
	fi

	echo "==> Applying API-v1 Prisma migrations"
	if ! (
		cd / &&
			DATABASE_URL="${database_url}" runuser -u rallar -- env DENO_DIR=/var/lib/rallar-deno deno task \
				--config "${checkout_dir}/apps/api-v1/deno.json" prisma migrate deploy
	); then
		write_rallar_api_store_failure migrations
		return 1
	fi
	rm -f -- "${RALLAR_API_STORE_FAILURE_FILE}"
}

provision_rallar_api_postgres_store() {
	local checkout_dir="$1"
	local database_url="$2"
	if ! [[ "${database_url}" =~ ${RALLAR_API_DATABASE_URL_PATTERN} ]]; then
		echo "Invalid controller DATABASE_URL for initial provisioning." >&2
		return 1
	fi
	local password="${BASH_REMATCH[1]}"
	require_rallar_api_absent_store || return 1
	printf 'Initial provisioning of the API-v1 Postgres store %s has not finished.\n' "${RALLAR_API_DATABASE_NAME}" >"${RALLAR_API_STORE_FAILURE_FILE}"
	if ! write_rallar_api_postgres_sql <<EOF_SQL
CREATE ROLE ${RALLAR_API_DATABASE_ROLE} LOGIN PASSWORD '${password}';
CREATE DATABASE ${RALLAR_API_DATABASE_NAME} OWNER ${RALLAR_API_DATABASE_ROLE};
EOF_SQL
	then
		write_rallar_api_store_failure provisioning
		return 1
	fi
	migrate_rallar_api_postgres_store "${checkout_dir}" "${database_url}"
}

require_rallar_api_absent_store() {
	local existing
	existing="$(write_rallar_api_postgres_sql <<EOF_SQL
SELECT (SELECT count(*) FROM pg_roles WHERE rolname = '${RALLAR_API_DATABASE_ROLE}') || '|' ||
       (SELECT count(*) FROM pg_database WHERE datname = '${RALLAR_API_DATABASE_NAME}');
EOF_SQL
)" || return 1
	if [[ "${existing}" != "0|0" ]]; then
		echo "Controller database or role already exists; refusing initial provisioning." >&2
		return 1
	fi
}

rallar_api_prod_profile_self_test() {
	case "${RALLAR_API_PROD_PROFILE_SELF_TEST:-}" in
	install-server)
		install_rallar_api_postgres_server
		echo "installedApiPostgresServer=true"
		;;
	resolve-initial-database-url)
		resolve_rallar_api_database_url "${RALLAR_API_ENV_FILE:?RALLAR_API_ENV_FILE is required}"
		echo
		;;
	validate-existing)
		validate_rallar_api_existing_store_configuration "${RALLAR_API_ENV_FILE:?RALLAR_API_ENV_FILE is required}"
		echo "validatedExistingApiStore=true"
		;;
	migrate-store)
		migrate_rallar_api_postgres_store \
			"${RALLAR_CHECKOUT_DIR:?RALLAR_CHECKOUT_DIR is required}" \
			"$(read_rallar_api_database_url "${RALLAR_API_ENV_FILE:?RALLAR_API_ENV_FILE is required}")"
		echo "migratedApiPostgresStore=true"
		;;
	provision-store)
		provision_rallar_api_postgres_store \
			"${RALLAR_CHECKOUT_DIR:?RALLAR_CHECKOUT_DIR is required}" \
			"$(read_rallar_api_database_url "${RALLAR_API_ENV_FILE:?RALLAR_API_ENV_FILE is required}")"
		echo "provisionedApiPostgresStore=true"
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
