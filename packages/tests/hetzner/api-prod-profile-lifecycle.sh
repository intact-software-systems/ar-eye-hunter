#!/usr/bin/env bash
set -Eeuo pipefail

repo_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../../.." && pwd)"

if [[ "${1:-}" == --inspect-query ]]; then
	shift
	[[ "${1:-}" == -u && "${2:-}" == postgres && "${3:-}" == -- && "${4:-}" == psql ]]
	shift 4
	initdb -D /tmp/inspect-pg -A trust >/dev/null
	pg_ctl -D /tmp/inspect-pg -o '-c listen_addresses=' -w start >/dev/null
	createdb rallar_api_v1
	psql -d postgres -qc 'CREATE ROLE rallar'
	psql -d rallar_api_v1 -qc 'CREATE TABLE runtime_state_store (store_namespace text NOT NULL)'
	psql -d rallar_api_v1 -qc "INSERT INTO runtime_state_store VALUES ('auth-users:by-username'), ('auth-users:by-username'), ('group-state:groups'), ('other'), ('other')"
	psql -d rallar_api_v1 -qc 'CREATE TABLE _prisma_migrations (migration_name text NOT NULL, checksum text NOT NULL, finished_at timestamptz, rolled_back_at timestamptz)'
	psql -d rallar_api_v1 -qc "INSERT INTO _prisma_migrations VALUES ('20261018000000_fixture', repeat('0', 64), now(), NULL)"
	psql "$@"
	pg_ctl -D /tmp/inspect-pg -m immediate -w stop >/dev/null
	exit 0
fi

if [[ "${1:-}" != --inside ]]; then
	for scenario in deploy-success deploy-initial deploy-stop-api-fail deploy-stop-control-fail deploy-still-active deploy-migration-fail deploy-secret-directory \
		rollout-success rollout-metered-preserve rollout-migration-fail rollout-secret-directory rollout-secret-syntax; do
		docker run --rm --network none --user root \
			--mount "type=bind,src=${repo_root},dst=/repo,readonly" \
			-e "TEST_SCENARIO=${scenario}" postgres:16 \
			bash /repo/packages/tests/hetzner/api-prod-profile-lifecycle.sh --inside
	done
	echo 'deployAndRolloutLifecycle=passed stopFailureFence=passed configPreflight=passed migrationFailureFence=passed'
	exit 0
fi

mkdir -p /fixture/bin /fixture/checkout/.git /fixture/playwright/active /etc/rallar /etc/systemd/system /var/www/rallar-black-box
useradd -M rallar
useradd -M caddy
printf '{"packages":{"node_modules/playwright":{"version":"1.0.0"}}}\n' >/fixture/checkout/package-lock.json
database_url="postgres://rallar:$(printf 'a%.0s' {1..64})@127.0.0.1:5432/rallar_api_v1"
cat >/etc/rallar/api-v1.env <<EOF
RALLAR_API_CONFIGURATION_PROFILE=prod
DATABASE_URL=${database_url}
RALLAR_AUTH_CREDENTIAL_SECRET=$(printf 'x%.0s' {1..32})
RALLAR_BLACK_BOX_OPERATOR_TOKEN_SECRET=stable-operator-token
RALLAR_BLACK_BOX_OPERATOR_CLIENT_IDS=operations-admin
EOF
if [[ "${TEST_SCENARIO}" == rollout-success ]]; then
	printf 'RALLAR_BLACK_BOX_OPERATOR_TOKEN_TTL_MS=3600000\n' >>/etc/rallar/api-v1.env
fi
if [[ "${TEST_SCENARIO}" == rollout-metered-preserve ]]; then
	printf 'RALLAR_BLACK_BOX_OPERATOR_TOKEN_TTL_MS=86400000\n' >>/etc/rallar/api-v1.env
	cat >/etc/rallar/api-v1.secrets.env <<EOF
DATABASE_URL=postgres://rallar:$(printf 'b%.0s' {1..64})@127.0.0.1:5432/rallar_api_v1
RALLAR_AUTH_CREDENTIAL_SECRET=$(printf 'y%.0s' {1..32})
RALLAR_BLACK_BOX_OPERATOR_TOKEN_TTL_MS=3600000
RALLAR_RTC_TOPOLOGY_DEGREE_LIMIT=4
RALLAR_ICE_MODE=local
METERED_APP_NAME=prior-app
METERED_API_KEY=prior-key
EOF
fi
printf 'RALLAR_BLACK_BOX_OPERATOR_TOKEN_SECRET=stable-operator-token\nRALLAR_BLACK_BOX_ADMIN_TOKEN=stable-admin-token\n' >/etc/rallar/control-server.env
original_api_environment="$(cat /etc/rallar/api-v1.env)"
original_control_environment="$(cat /etc/rallar/control-server.env)"

cat >/fixture/bin/record-command <<'EOF'
#!/usr/bin/env bash
set -Eeuo pipefail
name="$(basename "$0")"
printf '%s %s\n' "${name}" "$*" >>/fixture/commands.log
case "${name}" in
	systemctl)
		if [[ "$1" == show ]]; then
			if [[ "$*" == *LoadState* && "${TEST_SCENARIO}" == deploy-initial ]]; then printf 'not-found\n';
			elif [[ "$*" == *LoadState* ]]; then printf 'loaded\n';
			elif [[ "${TEST_SCENARIO}" == deploy-still-active ]]; then printf 'active\n';
			else printf 'inactive\n'; fi
		elif [[ "$1" == stop && "${TEST_SCENARIO}" == deploy-stop-api-fail && "$2" == rallar-api-v1.service ]] ||
			[[ "$1" == stop && "${TEST_SCENARIO}" == deploy-stop-control-fail && "$2" == rallar-black-box-control.service ]]; then
			exit 1
		fi
		;;
	runuser)
		if [[ "$2" == postgres ]]; then
			sql="$(cat)"
			if [[ "${sql}" == *'CREATE ROLE'* ]]; then
				printf 'postgres-sql create-role\n' >>/fixture/commands.log
			else
				printf 'postgres-sql absent-check\n' >>/fixture/commands.log
			fi
			printf '0|0\n'
		elif [[ "$*" == *'prisma migrate deploy'* && "${TEST_SCENARIO}" == *migration-fail ]]; then
			exit 37
		fi
		;;
	git)
		if [[ "$*" == *'rev-parse --short HEAD'* ]]; then printf 'abcdef0\n';
		elif [[ "$*" == *'rev-parse HEAD'* ]]; then printf 'abcdef0123456789abcdef0123456789abcdef01\n'; fi
		;;
	dpkg-query) printf 'installed' ;;
	curl)
		while (($#)); do
			case "$1" in
			-D) printf 'HTTP/1.1 200 OK\nAccess-Control-Allow-Origin: https://blackbox.rallar.intactss.com\n' >"$2"; shift 2 ;;
			-o) : >"$2"; shift 2 ;;
			-w) printf '200'; shift 2 ;;
			*) shift ;;
			esac
		done
		;;
	jq)
		if [[ "$1" == -n ]]; then printf '{}\n'; else printf '1.0.0\n'; fi
		;;
esac
EOF
chmod 0755 /fixture/bin/record-command
for command in systemctl runuser git dpkg-query curl jq npm deno rsync caddy chown free journalctl; do
	ln -s record-command "/fixture/bin/${command}"
done

export PATH="/fixture/bin:${PATH}"
export RALLAR_DENO_SELF_TEST_VERSION=2.9.0
export RALLAR_CHECKOUT_DIR=/fixture/checkout
export RALLAR_API_ENV_FILE=/etc/rallar/api-v1.env
export RALLAR_API_SECRET_FILE=/etc/rallar/api-v1.secrets.env
export RALLAR_API_STORE_FAILURE_FILE=/etc/rallar/api-v1.store-failure
export RALLAR_CONTROL_ENV_FILE=/etc/rallar/control-server.env
export RALLAR_BLACK_BOX_SPA_ENV_FILE=/fixture/black-box-spa.env
export RALLAR_CADDYFILE=/fixture/Caddyfile
export RALLAR_DEPLOYMENT_READINESS_PATH=/fixture/readiness.json
export RALLAR_PLAYWRIGHT_ROOT=/fixture/playwright
export RALLAR_INSTALL_PLAYWRIGHT=0
export RALLAR_DISTRIBUTED_ARTIFACT_DIR=/fixture/artifacts
export RALLAR_ROLLOUT_CONTROL_STATE_DIR=/fixture/control
export RALLAR_ROLLOUT_TMP_DIR=/fixture/tmp
export RALLAR_ROLLOUT_NPM_CACHE_DIR=/fixture/npm-cache
export RALLAR_ROLLOUT_NPM_LOG_DIR=/fixture/npm-logs
export RALLAR_ROLLOUT_PLAYWRIGHT_CACHE_DIR=/fixture/playwright-cache

case "${TEST_SCENARIO}" in
	deploy-initial) rm /etc/rallar/api-v1.env ;;
	deploy-secret-directory | rollout-secret-directory) mkdir /etc/rallar/api-v1.secrets.env ;;
	rollout-secret-syntax) printf 'export DATABASE_URL=unsupported\n' >/etc/rallar/api-v1.secrets.env ;;
esac

case "${TEST_SCENARIO}" in
	deploy-*) script=/repo/scripts/hosted-rallar/controller/02-deploy-controller.sh ;;
	rollout-*) script=/repo/scripts/hosted-rallar/controller/08-rollout-controller.sh ;;
esac

case "${TEST_SCENARIO}" in
	rollout-metered-preserve)
		RALLAR_API_PROD_PROFILE_SELF_TEST=validate-existing bash /repo/scripts/hosted-rallar/controller/rallar-api-prod-profile.sh >/fixture/preflight-before.log 2>&1
		METERED_APP_NAME=replacement-app METERED_API_KEY=replacement-key bash /repo/scripts/hosted-rallar/controller/13-configure-metered-turn.sh --no-restart >/fixture/metered-output.log 2>&1
		RALLAR_API_PROD_PROFILE_SELF_TEST=validate-existing bash /repo/scripts/hosted-rallar/controller/rallar-api-prod-profile.sh >/fixture/preflight-after.log 2>&1
		if RALLAR_RTC_TOPOLOGY_DEGREE_LIMIT=3 RALLAR_ROLLOUT_SCRIPT_SELF_TEST=preflight-api-overrides bash "${script}" >/fixture/topology-preflight.log 2>&1; then
			echo 'Expected preserved secret topology to reject an ineffective rollout override.' >&2
			exit 1
		fi
		bash "${script}" >/fixture/output.log 2>&1
		grep -Fqx "RALLAR_AUTH_CREDENTIAL_SECRET=$(printf 'y%.0s' {1..32})" /etc/rallar/api-v1.env
		grep -Fqx 'RALLAR_BLACK_BOX_OPERATOR_TOKEN_TTL_MS=3600000' /etc/rallar/api-v1.env
		grep -Fqx "DATABASE_URL=postgres://rallar:$(printf 'b%.0s' {1..64})@127.0.0.1:5432/rallar_api_v1" /etc/rallar/api-v1.secrets.env
		grep -Fqx "RALLAR_AUTH_CREDENTIAL_SECRET=$(printf 'y%.0s' {1..32})" /etc/rallar/api-v1.secrets.env
		grep -Fqx 'RALLAR_BLACK_BOX_OPERATOR_TOKEN_TTL_MS=3600000' /etc/rallar/api-v1.secrets.env
		grep -Fqx 'RALLAR_RTC_TOPOLOGY_DEGREE_LIMIT=4' /etc/rallar/api-v1.secrets.env
		grep -Fqx 'METERED_APP_NAME=replacement-app' /etc/rallar/api-v1.secrets.env
		grep -Fqx 'METERED_API_KEY=replacement-key' /etc/rallar/api-v1.secrets.env
		[[ "$(grep -c '^METERED_APP_NAME=' /etc/rallar/api-v1.secrets.env)" == 1 ]]
		[[ "$(grep -c '^METERED_API_KEY=' /etc/rallar/api-v1.secrets.env)" == 1 ]]
		;;
	rollout-success)
		RALLAR_API_SERVER_TIMING=1 bash "${script}" >/fixture/output.log 2>&1
		grep -Fqx 'RALLAR_BLACK_BOX_OPERATOR_TOKEN_TTL_MS=3600000' /etc/rallar/api-v1.env
		grep -Fqx 'RALLAR_TIMING_LOGS=1' /etc/rallar/api-v1.env
		RALLAR_API_SERVER_TIMING=0 bash "${script}" >>/fixture/output.log 2>&1
		grep -Fqx 'RALLAR_BLACK_BOX_OPERATOR_TOKEN_TTL_MS=3600000' /etc/rallar/api-v1.env
		grep -Fqx 'RALLAR_TIMING_LOGS=0' /etc/rallar/api-v1.env
		;;
	deploy-success | deploy-initial)
		bash "${script}" >/fixture/output.log 2>&1
		;;
	*)
		if bash "${script}" >/fixture/output.log 2>&1; then
			echo "Expected ${TEST_SCENARIO} to fail." >&2
			exit 1
		fi
		;;
esac

commands="$(cat /fixture/commands.log 2>/dev/null || true)"
line_of() {
	printf '%s\n' "${commands}" | grep -n -F "$1" | head -n 1 | cut -d: -f1
}
assert_before() {
	local first second
	first="$(line_of "$1")"
	second="$(line_of "$2")"
	[[ -n "${first}" && -n "${second}" && "${first}" -lt "${second}" ]]
}

case "${TEST_SCENARIO}" in
	deploy-success | deploy-initial | rollout-success | rollout-metered-preserve)
		if [[ "${TEST_SCENARIO}" == deploy-initial ]]; then
			[[ "${commands}" != *'systemctl stop rallar-api-v1.service'* ]]
			assert_before 'systemctl show -p ActiveState --value rallar-api-v1.service' 'postgres-sql create-role'
		else
			assert_before 'systemctl stop rallar-api-v1.service' 'runuser -u rallar -- env DENO_DIR=/var/lib/rallar-deno deno task'
			assert_before 'systemctl stop rallar-black-box-control.service' 'runuser -u rallar -- env DENO_DIR=/var/lib/rallar-deno deno task'
		fi
		if [[ "${TEST_SCENARIO}" == deploy-success || "${TEST_SCENARIO}" == deploy-initial ]]; then
			grep -Fq 'ConditionPathExists=!/etc/rallar/api-v1.store-failure' /etc/systemd/system/rallar-api-v1.service
			assert_before 'runuser -u rallar -- env DENO_DIR=/var/lib/rallar-deno deno task' 'systemctl enable --now rallar-api-v1.service'
			assert_before 'systemctl enable --now rallar-api-v1.service' 'curl -fsS http://127.0.0.1:8080/api/config'
		else
			assert_before 'runuser -u rallar -- env DENO_DIR=/var/lib/rallar-deno deno task' 'systemctl start rallar-api-v1.service'
			assert_before 'systemctl start rallar-api-v1.service' 'curl -fsS http://127.0.0.1:8080/api/config'
			assert_before 'curl -fsS http://127.0.0.1:8080/api/config' 'jq -n'
			[[ -s /fixture/readiness.json ]]
		fi
		[[ ! -e /etc/rallar/api-v1.store-failure ]]
		;;
	deploy-stop-api-fail | deploy-stop-control-fail | deploy-still-active)
		[[ "${commands}" != *'prisma migrate deploy'* && "${commands}" != *'systemctl enable --now rallar-api-v1.service'* ]]
		[[ "${commands}" != *'curl -fsS http://127.0.0.1:8080/api/config'* ]]
		;;
	deploy-migration-fail | rollout-migration-fail)
		[[ -e /etc/rallar/api-v1.store-failure ]]
		[[ "${commands}" != *'systemctl start rallar-api-v1.service'* && "${commands}" != *'systemctl enable --now rallar-api-v1.service'* ]]
		[[ ! -e /fixture/readiness.json ]]
		;;
	deploy-secret-directory | rollout-secret-directory | rollout-secret-syntax)
		[[ "$(cat /etc/rallar/api-v1.env)" == "${original_api_environment}" ]]
		[[ "$(cat /etc/rallar/control-server.env)" == "${original_control_environment}" ]]
		[[ "${commands}" != *'systemctl stop rallar-api-v1.service'* && "${commands}" != *'prisma migrate deploy'* ]]
		[[ ! -e /fixture/readiness.json ]]
		;;
esac
echo "${TEST_SCENARIO}=passed"
