#!/usr/bin/env bash
set -Eeuo pipefail

RALLAR_API_ENV_FILE="${RALLAR_API_ENV_FILE:-/etc/rallar/api-v1.env}"
RALLAR_API_SECRET_FILE="${RALLAR_API_SECRET_FILE:-/etc/rallar/api-v1.secrets.env}"
RALLAR_CONTROL_ENV_FILE="${RALLAR_CONTROL_ENV_FILE:-/etc/rallar/control-server.env}"
RALLAR_BLACK_BOX_SPA_ENV_FILE="${RALLAR_BLACK_BOX_SPA_ENV_FILE:-/etc/rallar/black-box-spa.env}"
RALLAR_API_STORE_FAILURE_FILE="${RALLAR_API_STORE_FAILURE_FILE:-/etc/rallar/api-v1.store-failure}"
RALLAR_CHECKOUT_DIR="${RALLAR_CHECKOUT_DIR:-/opt/rallar/ar-eye-hunter}"
RALLAR_DEPLOYMENT_READINESS_PATH="${RALLAR_DEPLOYMENT_READINESS_PATH:-/var/lib/rallar-black-box-control/deployment-readiness.json}"

inspect_fail() {
	echo "Hosted inspect could not obtain required nonsecret evidence: $1." >&2
	return 1
}

inspect_configuration() {
	local key value status source_file configuration='{}'
	for key in RALLAR_TIMING_LOGS RALLAR_APP_INBOX_PHASE_TIMING \
		RALLAR_RTC_TOPOLOGY_DEGREE_LIMIT RALLAR_RTC_TOPOLOGY_TREE_MIN_SIZE \
		RALLAR_RTC_TOPOLOGY_MESH_MIN_SIZE RALLAR_RTC_TOPOLOGY_MESH_PARAM_K; do
		if value="$(read_rallar_api_effective_env_value "${RALLAR_API_ENV_FILE}" "${key}")"; then
			source_file=environment
			if [[ -e "${RALLAR_API_SECRET_FILE}" || -L "${RALLAR_API_SECRET_FILE}" ]]; then
				if read_rallar_api_file_value "${RALLAR_API_SECRET_FILE}" "${key}" >/dev/null; then
					source_file=secret
				else
					status=$?
					[[ "${status}" == 3 ]] || return "${status}"
				fi
			fi
			case "${key}:${value}" in
			RALLAR_TIMING_LOGS:0 | RALLAR_TIMING_LOGS:1 | RALLAR_APP_INBOX_PHASE_TIMING:true | RALLAR_APP_INBOX_PHASE_TIMING:false) ;;
			RALLAR_RTC_TOPOLOGY_*:*) [[ "${value}" =~ ^[1-9][0-9]*$ ]] || {
				inspect_fail "invalid ${key}"
				return 1
			} ;;
			*)
				inspect_fail "invalid ${key}"
				return 1
				;;
			esac
			configuration="$(jq -cn --argjson prior "${configuration}" --arg key "${key}" --arg value "${value}" \
				--arg source "${source_file}" '$prior + {($key): {present: true, value: $value, source: $source}}')" || return 1
		else
			status=$?
			[[ "${status}" == 3 ]] || return "${status}"
			configuration="$(jq -cn --argjson prior "${configuration}" --arg key "${key}" \
				'$prior + {($key): {present: false, value: null, source: null}}')" || return 1
		fi
	done
	printf '%s' "${configuration}"
}

inspect_operator_settings() {
	local projection key value settings='{}'
	projection="$(read_rallar_public_spa_settings)" || return 1
	while IFS='=' read -r key value; do
		settings="$(jq -cn --argjson prior "${settings}" --arg key "${key}" --arg value "${value}" \
			'$prior + {($key): {present: true, value: $value, source: "spa-environment"}}')" || return 1
	done <<<"${projection}"
	printf '%s' "${settings}"
}

inspect_service_state() {
	local unit="$1" state
	state="$(systemctl is-active "${unit}" 2>/dev/null)" || [[ -n "${state}" ]] || return 1
	case "${state}" in active | inactive | failed | activating | deactivating | reloading | unknown) printf '%s' "${state}" ;;
	*)
		inspect_fail "service state"
		return 1
		;;
	esac
}

inspect_service_process() {
	local unit="$1" pid
	pid="$(systemctl show --property MainPID --value "${unit}" 2>/dev/null)" || {
		inspect_fail "service process"
		return 1
	}
	[[ "${pid}" =~ ^[0-9]+$ ]] || {
		inspect_fail "service process"
		return 1
	}
	if [[ "${pid}" == 0 ]]; then printf false; else printf true; fi
}

inspect_health_code() {
	local url="$1" code
	local curl_args=(--silent --show-error --output /dev/null --write-out '%{http_code}' --max-time 10)
	if [[ "${url}" == 'http://127.0.0.1:5180/health' ]]; then
		curl_args+=(--header 'x-forwarded-proto: https')
	fi
	code="$(curl "${curl_args[@]}" "${url}" 2>/dev/null)" || {
		inspect_fail "health probe"
		return 1
	}
	[[ "${code}" =~ ^[1-5][0-9][0-9]$ ]] || {
		inspect_fail "health status"
		return 1
	}
	printf '%s' "${code}"
}

inspect_source_state() {
	local deployed_commit dirty package_hash schema_hash migrations='[]'
	local migration_file migration_name migration_hash migration_files checkout_status
	[[ -d "${RALLAR_CHECKOUT_DIR}/.git" ]] || {
		inspect_fail "checkout"
		return 1
	}
	deployed_commit="$(git -C "${RALLAR_CHECKOUT_DIR}" rev-parse --verify HEAD 2>/dev/null)" || {
		inspect_fail "commit"
		return 1
	}
	[[ "${deployed_commit}" =~ ^[0-9a-f]{40}$ ]] || {
		inspect_fail "commit"
		return 1
	}
	checkout_status="$(git --no-optional-locks -C "${RALLAR_CHECKOUT_DIR}" status --porcelain 2>/dev/null)" || {
		inspect_fail "checkout status"
		return 1
	}
	if [[ -n "${checkout_status}" ]]; then dirty=true; else dirty=false; fi
	package_hash="$(sha256sum "${RALLAR_CHECKOUT_DIR}/package-lock.json" 2>/dev/null)" || {
		inspect_fail "package lock"
		return 1
	}
	schema_hash="$(sha256sum "${RALLAR_CHECKOUT_DIR}/apps/api-v1/prisma/schema.prisma" 2>/dev/null)" || {
		inspect_fail "schema"
		return 1
	}
	package_hash="${package_hash%% *}"
	schema_hash="${schema_hash%% *}"
	[[ "${package_hash}" =~ ^[0-9a-f]{64}$ && "${schema_hash}" =~ ^[0-9a-f]{64}$ ]] || {
		inspect_fail "source hash"
		return 1
	}
	migration_files="$(find "${RALLAR_CHECKOUT_DIR}/apps/api-v1/prisma/migrations" -name migration.sql -type f 2>/dev/null | LC_ALL=C sort)" || {
		inspect_fail "migration files"
		return 1
	}
	[[ -n "${migration_files}" ]] || {
		inspect_fail "migration files"
		return 1
	}
	while IFS= read -r migration_file; do
		migration_name="$(basename "$(dirname "${migration_file}")")"
		[[ "${migration_name}" =~ ^[0-9]{14}_[a-z0-9_]+$ ]] || {
			inspect_fail "migration name"
			return 1
		}
		migration_hash="$(sha256sum "${migration_file}" 2>/dev/null)" || {
			inspect_fail "migration hash"
			return 1
		}
		migration_hash="${migration_hash%% *}"
		[[ "${migration_hash}" =~ ^[0-9a-f]{64}$ ]] || {
			inspect_fail "migration hash"
			return 1
		}
		migrations="$(jq -cn --argjson prior "${migrations}" --arg name "${migration_name}" --arg checksum "${migration_hash}" \
			'$prior + [{name: $name, checksum: $checksum}]')" || return 1
	done <<<"${migration_files}"
	jq -cn --arg deployedCommit "${deployed_commit}" --argjson dirty "${dirty}" \
		--arg packageLockSha256 "${package_hash}" --arg prismaSchemaSha256 "${schema_hash}" \
		--argjson sourceMigrations "${migrations}" \
		'{deployedCommit: $deployedCommit, dirty: $dirty, packageLockSha256: $packageLockSha256,
		prismaSchemaSha256: $prismaSchemaSha256, sourceMigrations: $sourceMigrations}'
}

inspect_database() {
	local database
	database="$(runuser -u postgres -- psql --no-psqlrc --quiet -At -v ON_ERROR_STOP=1 -d rallar_api_v1 -c "
BEGIN TRANSACTION READ ONLY;
SELECT json_build_object(
  'databaseOid', (SELECT oid::bigint FROM pg_database WHERE datname = 'rallar_api_v1'),
  'roleOid', (SELECT oid::bigint FROM pg_roles WHERE rolname = 'rallar'),
  'runtimeStateTableOid', 'runtime_state_store'::regclass::oid::bigint,
  'totalRows', (SELECT count(*) FROM runtime_state_store),
  'authUserRows', (SELECT count(*) FROM runtime_state_store WHERE store_namespace = 'auth-users:by-username'),
  'groupRows', (SELECT count(*) FROM runtime_state_store WHERE store_namespace = 'group-state:groups'),
  'migrations', (SELECT coalesce(json_agg(json_build_object('name', migration_name, 'checksum', checksum,
    'applied', finished_at IS NOT NULL AND rolled_back_at IS NULL,
    'failed', finished_at IS NULL AND rolled_back_at IS NULL) ORDER BY migration_name), '[]'::json) FROM _prisma_migrations)
);
COMMIT;" 2>/dev/null)" || {
		inspect_fail "database"
		return 1
	}
	database="$(printf '%s\n' "${database}" | jq -ce 'select(type == "object") |
		select(all(.databaseOid, .roleOid, .runtimeStateTableOid, .totalRows, .authUserRows, .groupRows; type == "number" and . >= 0)) |
		select(.migrations | type == "array") |
		select(all(.migrations[]; (.name | test("^[0-9]{14}_[a-z0-9_]+$")) and (.checksum | test("^[0-9a-f]{64}$")) and (.applied | type == "boolean") and (.failed | type == "boolean"))) |
		{databaseOid, roleOid, runtimeStateTableOid, totalRows, authUserRows, groupRows,
		migrations: [.migrations[] | {name, checksum, applied, failed}]}' 2>/dev/null)" || {
		inspect_fail "database projection"
		return 1
	}
	printf '%s' "${database}"
}

inspect_services() {
	local api_state control_state postgres_state caddy_state headless_state
	local api_process control_process headless_process services processes
	api_state="$(inspect_service_state rallar-api-v1.service)" || return 1
	control_state="$(inspect_service_state rallar-black-box-control.service)" || return 1
	postgres_state="$(inspect_service_state postgresql.service)" || return 1
	caddy_state="$(inspect_service_state caddy.service)" || return 1
	headless_state="$(inspect_service_state rallar-black-box-headless-worker.service)" || return 1
	services="$(jq -cn \
		--arg api "${api_state}" --arg control "${control_state}" \
		--arg postgres "${postgres_state}" --arg caddy "${caddy_state}" \
		--arg headless "${headless_state}" \
		'{api: $api, control: $control, postgres: $postgres, caddy: $caddy, headless: $headless}')" || return 1
	api_process="$(inspect_service_process rallar-api-v1.service)" || return 1
	control_process="$(inspect_service_process rallar-black-box-control.service)" || return 1
	headless_process="$(inspect_service_process rallar-black-box-headless-worker.service)" || return 1
	processes="$(jq -cn --argjson api "${api_process}" --argjson control "${control_process}" \
		--argjson headless "${headless_process}" '{api: $api, control: $control, headless: $headless}')" || return 1
	jq -cn --argjson services "${services}" --argjson processes "${processes}" '{services: $services, processes: $processes}'
}

inspect_activity() {
	local jobs rollout_activity recipe_activity
	jobs="$(systemctl list-jobs --no-legend --no-pager 2>/dev/null)" || {
		inspect_fail "system jobs"
		return 1
	}
	jobs="$(printf '%s\n' "${jobs}" | awk '$1 ~ /^[0-9]+$/ { n++ } END { print n+0 }')"
	rollout_activity=false
	recipe_activity=false
	if pgrep -f '[0]8-rollout-controller.sh|[0]2-deploy-controller.sh' >/dev/null 2>&1; then rollout_activity=true; else
		[[ "$?" == 1 ]] || {
			inspect_fail "rollout activity"
			return 1
		}
	fi
	if pgrep -f '[1]4-run-distributed-recipe.sh' >/dev/null 2>&1; then recipe_activity=true; else
		[[ "$?" == 1 ]] || {
			inspect_fail "recipe activity"
			return 1
		}
	fi
	jq -cn --argjson jobCount "${jobs}" --argjson rolloutProcessPresent "${rollout_activity}" \
		--argjson recipeProcessPresent "${recipe_activity}" \
		'{jobCount: $jobCount, activity: {rolloutProcessPresent: $rolloutProcessPresent, recipeProcessPresent: $recipeProcessPresent}}'
}

inspect_health() {
	local operator_settings="$1" api_loopback control_loopback api_public control_public
	local api_base_url control_url control_host control_scheme
	api_loopback="$(inspect_health_code http://127.0.0.1:8080/api/config)" || return 1
	control_loopback="$(inspect_health_code http://127.0.0.1:5180/health)" || return 1
	api_base_url="$(printf '%s' "${operator_settings}" | jq -r '.RALLAR_API_BASE_URL.value')" || return 1
	control_url="$(printf '%s' "${operator_settings}" | jq -r '.RALLAR_BLACK_BOX_CONTROL_URL.value')" || return 1
	control_scheme=https
	if [[ "${control_url}" == ws://* ]]; then control_scheme=http; fi
	control_host="${control_url#*://}"
	control_host="${control_host%%/*}"
	api_public="$(inspect_health_code "${api_base_url%/}/api/config")" || return 1
	control_public="$(inspect_health_code "${control_scheme}://${control_host}/health")" || return 1
	jq -cn \
		--arg apiLoopback "${api_loopback}" --arg controlLoopback "${control_loopback}" \
		--arg apiPublic "${api_public}" --arg controlPublic "${control_public}" \
		'{apiLoopback: $apiLoopback, controlLoopback: $controlLoopback, apiPublic: $apiPublic, controlPublic: $controlPublic}'
}

inspect_hosted_controller() {
	local configuration operator_settings operator_settings_sha256 source_state readiness database services activity health
	configuration="$(inspect_configuration)" || return 1
	operator_settings="$(inspect_operator_settings)" || return 1
	operator_settings_sha256="$(printf '%s' "${operator_settings}" | jq -cS 'with_entries(.value = .value.value)' | sha256sum)" || {
		inspect_fail 'public settings fingerprint'
		return 1
	}
	operator_settings_sha256="${operator_settings_sha256%% *}"
	[[ "${operator_settings_sha256}" =~ ^[0-9a-f]{64}$ ]] || {
		inspect_fail 'public settings fingerprint'
		return 1
	}
	source_state="$(inspect_source_state)" || return 1
	readiness="$(jq -ce '{deployedCommit, apiHealthStatus, controlHealthStatus, publicHealthStatus} |
		select(.deployedCommit | test("^[0-9a-f]{40}$")) |
		select(all(.apiHealthStatus, .controlHealthStatus, .publicHealthStatus; . == "passed" or . == "failed"))' \
		"${RALLAR_DEPLOYMENT_READINESS_PATH}" 2>/dev/null)" || {
		inspect_fail "readiness"
		return 1
	}
	database="$(inspect_database)" || return 1
	services="$(inspect_services)" || return 1
	activity="$(inspect_activity)" || return 1
	health="$(inspect_health "${operator_settings}")" || return 1
	jq -cn --argjson source "${source_state}" \
		--argjson configuration "${configuration}" --argjson operatorSettings "${operator_settings}" \
		--arg operatorSettingsSha256 "${operator_settings_sha256}" \
		--argjson readiness "${readiness}" --argjson database "${database}" \
		--argjson services "${services}" --argjson activity "${activity}" --argjson health "${health}" \
		--argjson failureFence "$([[ -e "${RALLAR_API_STORE_FAILURE_FILE}" || -L "${RALLAR_API_STORE_FAILURE_FILE}" ]] && echo true || echo false)" \
		'$source + {configuration: $configuration, operatorSettings: $operatorSettings, operatorSettingsSha256: $operatorSettingsSha256, readiness: $readiness,
		database: $database, failureFence: $failureFence, health: $health} + $services + $activity'
}

if [[ "${1:-}" == "--inspect" ]]; then
	if ! declare -F read_rallar_api_effective_env_value >/dev/null; then
		# Normal local invocation; the workflow streams this same reader before this script.
		SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
		source "${SCRIPT_DIR}/rallar-api-effective-env.sh"
	fi
	if ! declare -F read_rallar_public_spa_settings >/dev/null; then
		SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
		source "${SCRIPT_DIR}/rallar-public-spa-env.sh"
	fi
	inspect_hosted_controller
	exit
fi

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
