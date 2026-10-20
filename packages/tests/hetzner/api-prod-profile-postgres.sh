#!/usr/bin/env bash
set -Eeuo pipefail

repo_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../../.." && pwd)"
fixture_dir="$(mktemp -d "${TMPDIR:-/tmp}/rallar-api-store-retention.XXXXXX")"
container_name="rallar-api-store-retention-$(openssl rand -hex 6)"

cleanup() {
	docker rm -f "${container_name}" >/dev/null 2>&1 || true
	rm -rf -- "${fixture_dir}"
}
trap cleanup EXIT

mkdir -p "${fixture_dir}/bin"
cat >"${fixture_dir}/bin/runuser" <<'EOF'
#!/usr/bin/env bash
set -Eeuo pipefail
user="$2"
shift 3
if [[ "${user}" == postgres && "$1" == psql ]]; then
	shift
	docker exec -i -u postgres "${RALLAR_TEST_CONTAINER}" psql "$@"
elif [[ "${user}" == rallar && "$1" == psql ]]; then
	shift
	docker exec -i -e PGPASSWORD="${PGPASSWORD}" "${RALLAR_TEST_CONTAINER}" psql "$@"
elif [[ "${user}" == rallar && "$1" == env && "$2" == DENO_DIR=* ]]; then
	shift 2
	if [[ "${RALLAR_TEST_FAIL_MIGRATION:-0}" == 1 ]]; then
		exit 37
	fi
	"$@"
else
	echo "Unexpected runuser operation in retention test." >&2
	exit 1
fi
EOF
chmod 0755 "${fixture_dir}/bin/runuser"

admin_password="$(openssl rand -hex 32)"
database_password="$(openssl rand -hex 32)"
database_url="postgres://rallar:${database_password}@127.0.0.1:5432/rallar_api_v1"
docker run --detach --rm --name "${container_name}" \
	--publish 127.0.0.1:5432:5432 \
	--env "POSTGRES_PASSWORD=${admin_password}" postgres:16-alpine >/dev/null

ready=0
for attempt in {1..30}; do
	if docker exec "${container_name}" pg_isready -U postgres -d postgres >/dev/null 2>&1; then
		ready=1
		break
	fi
	sleep 1
done
if [[ "${ready}" != 1 ]]; then
	echo "Isolated PostgreSQL did not become ready." >&2
	exit 1
fi

printf 'DATABASE_URL=%s\n' "${database_url}" >"${fixture_dir}/api-v1.env"

run_profile_operation() {
	PATH="${fixture_dir}/bin:${PATH}" \
		RALLAR_TEST_CONTAINER="${container_name}" \
		RALLAR_API_PROD_PROFILE_SELF_TEST="$1" \
		RALLAR_API_ENV_FILE="${fixture_dir}/api-v1.env" \
		RALLAR_API_STORE_FAILURE_FILE="${fixture_dir}/api-v1.store-failure" \
		RALLAR_CHECKOUT_DIR="${repo_root}" \
		bash "${repo_root}/scripts/hosted-rallar/controller/rallar-api-prod-profile.sh" >/dev/null
}

run_profile_operation provision-store

docker exec -i -u postgres "${container_name}" psql -v ON_ERROR_STOP=1 -d rallar_api_v1 >/dev/null <<'EOF_SQL'
INSERT INTO runtime_state_store (store_namespace, store_key, store_value, expire_at_ts)
VALUES
    ('auth-users:by-username', 'retained-user', '{"clientId":"retained-client"}', '2099-01-01'),
    ('group-state:groups', 'retained-group', '{"groupId":"retained-group"}', '2099-01-01'),
    ('retention-sentinel', 'unrelated-row', 'exact-retained-value', '2099-01-01');
EOF_SQL

read_rows() {
	docker exec -u postgres "${container_name}" psql -At -F '|' -d rallar_api_v1 -c \
		"SELECT store_namespace, store_key, store_value FROM runtime_state_store WHERE store_key IN ('retained-user', 'retained-group', 'unrelated-row') ORDER BY store_namespace"
}

read_identity() {
	docker exec -u postgres "${container_name}" psql -At -F '|' -d postgres -c \
		"SELECT d.oid, r.oid, r.rolpassword FROM pg_database d CROSS JOIN pg_authid r WHERE d.datname = 'rallar_api_v1' AND r.rolname = 'rallar'"
}

expected_rows=$'auth-users:by-username|retained-user|{"clientId":"retained-client"}\ngroup-state:groups|retained-group|{"groupId":"retained-group"}\nretention-sentinel|unrelated-row|exact-retained-value'
expected_identity="$(read_identity)"
[[ "$(read_rows)" == "${expected_rows}" ]]
[[ "${expected_identity}" =~ ^[0-9]+\|[0-9]+\|.+$ ]]
for operation in 1 2; do
	run_profile_operation migrate-store
	[[ "$(read_rows)" == "${expected_rows}" ]]
	[[ "$(read_identity)" == "${expected_identity}" ]]
	[[ ! -e "${fixture_dir}/api-v1.store-failure" ]]
done

if RALLAR_TEST_FAIL_MIGRATION=1 run_profile_operation migrate-store 2>"${fixture_dir}/failed-migration.log"; then
	echo "Expected migration failure was not reported." >&2
	exit 1
fi
[[ -e "${fixture_dir}/api-v1.store-failure" ]]
[[ "$(read_rows)" == "${expected_rows}" ]]
[[ "$(read_identity)" == "${expected_identity}" ]]
run_profile_operation migrate-store
[[ ! -e "${fixture_dir}/api-v1.store-failure" ]]
[[ "$(read_rows)" == "${expected_rows}" ]]
[[ "$(read_identity)" == "${expected_identity}" ]]

echo "provisionedFreshStore=true preservedStoredRows=3 repeatedMigrations=2 failureFenceClearedAfterRecovery=true databaseAndRoleIdentity=unchanged"
