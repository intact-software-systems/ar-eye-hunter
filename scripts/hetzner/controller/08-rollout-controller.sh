#!/usr/bin/env bash
set -Eeuo pipefail

RALLAR_REPO_REF="${RALLAR_REPO_REF:-main}"
RALLAR_CHECKOUT_DIR="${RALLAR_CHECKOUT_DIR:-/opt/rallar/ar-eye-hunter}"
RALLAR_API_HOST="${RALLAR_API_HOST:-api.rallar.intactss.com}"
RALLAR_CONTROL_HOST="${RALLAR_CONTROL_HOST:-control.rallar.intactss.com}"
RALLAR_BLACKBOX_HOST="${RALLAR_BLACKBOX_HOST:-blackbox.rallar.intactss.com}"
RALLAR_INCLUDE_CADDY="${RALLAR_INCLUDE_CADDY:-0}"
RALLAR_INSTALL_PLAYWRIGHT="${RALLAR_INSTALL_PLAYWRIGHT:-0}"
RALLAR_BLACK_BOX_BROWSER_ENGINE="${RALLAR_BLACK_BOX_BROWSER_ENGINE:-chromium}"
RALLAR_ACME_EMAIL="${RALLAR_ACME_EMAIL:-}"
RALLAR_BLACK_BOX_OPERATOR_TOKEN_TTL_MS="${RALLAR_BLACK_BOX_OPERATOR_TOKEN_TTL_MS:-86400000}"
RALLAR_BLACK_BOX_OPERATOR_CLIENT_IDS="${RALLAR_BLACK_BOX_OPERATOR_CLIENT_IDS:-}"
RALLAR_DISTRIBUTED_ARTIFACT_DIR="${RALLAR_DISTRIBUTED_ARTIFACT_DIR:-/tmp/rallar-distributed-runs}"
RALLAR_ROLLOUT_CONTROL_STATE_DIR="${RALLAR_ROLLOUT_CONTROL_STATE_DIR:-/var/lib/rallar-black-box-control}"
RALLAR_ROLLOUT_TMP_DIR="${RALLAR_ROLLOUT_TMP_DIR:-/tmp}"
RALLAR_API_ENV_FILE="${RALLAR_API_ENV_FILE:-/etc/rallar/api-v1.env}"

rallar_user_home() {
	local user="${1:-rallar}"
	local home_dir=""

	if command -v getent >/dev/null 2>&1; then
		home_dir="$(getent passwd "${user}" | cut -d: -f6 || true)"
	fi
	if [[ -z "${home_dir}" ]]; then
		home_dir="$(eval "printf '%s' ~${user}" 2>/dev/null || true)"
	fi
	if [[ -z "${home_dir}" || "${home_dir}" == "~${user}" ]]; then
		return 1
	fi

	printf '%s' "${home_dir}"
}

rollout_npm_cache_dir() {
	if [[ -n "${RALLAR_ROLLOUT_NPM_CACHE_DIR:-}" ]]; then
		printf '%s' "${RALLAR_ROLLOUT_NPM_CACHE_DIR}"
		return 0
	fi

	local home_dir
	home_dir="$(rallar_user_home rallar)" || return 1
	printf '%s/.npm/_cacache' "${home_dir}"
}

rollout_npm_log_dir() {
	if [[ -n "${RALLAR_ROLLOUT_NPM_LOG_DIR:-}" ]]; then
		printf '%s' "${RALLAR_ROLLOUT_NPM_LOG_DIR}"
		return 0
	fi

	local home_dir
	home_dir="$(rallar_user_home rallar)" || return 1
	printf '%s/.npm/_logs' "${home_dir}"
}

rollout_playwright_cache_dir() {
	if [[ -n "${RALLAR_ROLLOUT_PLAYWRIGHT_CACHE_DIR:-}" ]]; then
		printf '%s' "${RALLAR_ROLLOUT_PLAYWRIGHT_CACHE_DIR}"
		return 0
	fi

	local home_dir
	home_dir="$(rallar_user_home rallar)" || return 1
	printf '%s/.cache/ms-playwright' "${home_dir}"
}

print_rollout_disk_summary() {
	local label="$1"
	echo "==> Disk usage ${label}"
	df -h "${RALLAR_CHECKOUT_DIR}" /tmp 2>/dev/null || true
}

remove_directory_contents() {
	local dir="$1"
	if [[ -z "${dir}" || "${dir}" == "/" ]]; then
		echo "Refusing unsafe rollout cleanup directory: ${dir:-<empty>}" >&2
		return 1
	fi
	[[ -d "${dir}" ]] || return 0
	find "${dir}" -mindepth 1 -maxdepth 1 -exec rm -rf -- {} +
}

remove_rollout_path() {
	local path="$1"
	if [[ -z "${path}" || "${path}" == "/" ]]; then
		echo "Refusing unsafe rollout cleanup path: ${path:-<empty>}" >&2
		return 1
	fi
	rm -rf -- "${path}"
}

remove_matching_rollout_paths() {
	local dir="$1"
	local pattern="$2"
	if [[ -z "${dir}" || "${dir}" == "/" ]]; then
		echo "Refusing unsafe rollout cleanup match directory: ${dir:-<empty>}" >&2
		return 1
	fi
	[[ -d "${dir}" ]] || return 0
	find "${dir}" -mindepth 1 -maxdepth 1 -name "${pattern}" -exec rm -rf -- {} +
}

cleanup_rollout_npm_transients() {
	local npm_cache_dir npm_log_dir
	npm_cache_dir="$(rollout_npm_cache_dir || true)"
	npm_log_dir="$(rollout_npm_log_dir || true)"

	if [[ -n "${npm_cache_dir}" ]]; then
		remove_rollout_path "${npm_cache_dir}"
	fi
	if [[ -n "${npm_log_dir}" ]]; then
		remove_rollout_path "${npm_log_dir}"
	fi
}

cleanup_rollout_disk_pressure() {
	print_rollout_disk_summary "before rollout cleanup"
	echo "==> Cleaning rollout transient disk pressure"
	remove_rollout_path "${RALLAR_CHECKOUT_DIR}/node_modules"
	remove_rollout_path "${RALLAR_CHECKOUT_DIR}/apps/rallar-black-box/dist"
	remove_rollout_path "${RALLAR_CHECKOUT_DIR}/apps/rallar-black-box-headless/dist"
	remove_rollout_path "${RALLAR_CHECKOUT_DIR}/playwright-report"
	remove_rollout_path "${RALLAR_CHECKOUT_DIR}/test-results"
	remove_directory_contents "${RALLAR_DISTRIBUTED_ARTIFACT_DIR}"
	cleanup_rollout_npm_transients
	remove_matching_rollout_paths "${RALLAR_ROLLOUT_CONTROL_STATE_DIR}" "control-snapshot.json.tmp-*"
	remove_matching_rollout_paths "${RALLAR_ROLLOUT_TMP_DIR}" "playwright_*"
	print_rollout_disk_summary "after rollout cleanup"
}

is_known_rollout_generated_lockfile() {
	case "$1" in
	apps/api-v1/deno.lock | apps/rallar-black-box-control-server/deno.lock)
		return 0
		;;
	*)
		return 1
		;;
	esac
}

is_full_git_sha() {
	[[ "$1" =~ ^[0-9a-fA-F]{40}$ ]]
}

update_rollout_checkout() {
	local checkout_dir="$1"
	local repo_ref="$2"

	git -C "${checkout_dir}" fetch --prune origin
	if is_full_git_sha "${repo_ref}"; then
		git -C "${checkout_dir}" checkout --detach "${repo_ref}"
		return
	fi

	git -C "${checkout_dir}" checkout "${repo_ref}"
	git -C "${checkout_dir}" pull --ff-only origin "${repo_ref}"
}

repair_known_rollout_generated_checkout_changes() {
	local checkout_dir="$1"
	local status line state file repaired_files=()

	status="$(git -C "${checkout_dir}" status --porcelain)"
	[[ -z "${status}" ]] && return 0

	while IFS= read -r line; do
		[[ -z "${line}" ]] && continue
		state="${line:0:2}"
		file="${line:3}"
		if [[ "${state}" == " M" ]] && is_known_rollout_generated_lockfile "${file}"; then
			repaired_files+=("${file}")
			continue
		fi
		return 0
	done <<<"${status}"

	[[ "${#repaired_files[@]}" -gt 0 ]] || return 0

	echo "Repairing rollout-generated Deno lockfile drift before controlled rollout:"
	printf "  %s\n" "${repaired_files[@]}"
	git -C "${checkout_dir}" checkout -- "${repaired_files[@]}"
}

sanitize_api_environment_file() {
	local env_file="$1"
	local tmp_file key line
	local allowed_names="|PORT|CORS_ORIGINS|RALLAR_API_BASE_URL|RALLAR_WS_BASE_URL|"
	allowed_names+="RALLAR_LOGIN_USER_RATE_LIMIT|RALLAR_TIMING_LOGS|"
	allowed_names+="RALLAR_AUTH_CREDENTIAL_SECRET|RALLAR_BLACK_BOX_OPERATOR_TOKEN_SECRET|"
	allowed_names+="RALLAR_BLACK_BOX_OPERATOR_TOKEN_TTL_MS|RALLAR_BLACK_BOX_OPERATOR_CLIENT_IDS|"
	allowed_names+="RALLAR_RTC_TOPOLOGY_DEGREE_LIMIT|RALLAR_RTC_TOPOLOGY_TREE_MIN_SIZE|"
	allowed_names+="RALLAR_RTC_TOPOLOGY_MESH_MIN_SIZE|RALLAR_RTC_TOPOLOGY_MESH_PARAM_K|"
	allowed_names+="RALLAR_RTC_TOPOLOGY_RTT_REBUILD_DEBOUNCE_MS|"

	if [[ ! -f "${env_file}" ]]; then
		echo "Missing ${env_file}. Run 02-deploy-controller.sh first." >&2
		return 1
	fi

	tmp_file="$(mktemp)"
	while IFS= read -r line; do
		key="${line%%=*}"
		if [[ -n "${key}" && "${allowed_names}" == *"|${key}|"* ]]; then
			printf '%s\n' "${line}" >>"${tmp_file}"
		fi
	done <"${env_file}"
	printf 'RALLAR_API_CONFIGURATION_PROFILE=prod-in-memory\n' >>"${tmp_file}"
	install -m 0600 "${tmp_file}" "${env_file}"
	rm -f "${tmp_file}"
}

update_env_value() {
	local env_file="$1"
	local key="$2"
	local value="$3"
	local tmp_file

	if [[ ! -f "${env_file}" ]]; then
		echo "Missing ${env_file}. Run 02-deploy-controller.sh first." >&2
		exit 1
	fi

	tmp_file="$(mktemp)"
	awk -v key="${key}" -v value="${value}" '
    BEGIN { replaced = 0 }
    $0 ~ "^" key "=" {
      if (!replaced && value != "") {
        print key "=" value
        replaced = 1
      }
      next
    }
    { print }
    END {
      if (!replaced && value != "") {
        print key "=" value
      }
    }
  ' "${env_file}" >"${tmp_file}"
	if [[ "$(id -u)" == "0" ]]; then
		install -m 0600 -o root -g root "${tmp_file}" "${env_file}"
	else
		install -m 0600 "${tmp_file}" "${env_file}"
	fi
	rm -f "${tmp_file}"
}

run_rollout_self_test() {
	case "${RALLAR_ROLLOUT_SCRIPT_SELF_TEST:-}" in
	checkout-ref)
		update_rollout_checkout "${RALLAR_CHECKOUT_DIR}" "${RALLAR_REPO_REF}"
		printf 'checkoutHead=%s\n' "$(git -C "${RALLAR_CHECKOUT_DIR}" rev-parse HEAD)"
		printf 'checkoutBranch=%s\n' "$(git -C "${RALLAR_CHECKOUT_DIR}" symbolic-ref --short -q HEAD || echo HEAD)"
		;;
	repair-known-drift)
		repair_known_rollout_generated_checkout_changes "${RALLAR_CHECKOUT_DIR}"
		if [[ -n "$(git -C "${RALLAR_CHECKOUT_DIR}" status --porcelain)" ]]; then
			git -C "${RALLAR_CHECKOUT_DIR}" status --short >&2
			return 1
		fi
		echo "repairedKnownDenoLockDrift=true"
		;;
	cleanup-disk-pressure)
		cleanup_rollout_disk_pressure
		echo "cleanedRolloutDiskPressure=true"
		;;
	normalize-api-environment)
		sanitize_api_environment_file "${RALLAR_API_ENV_FILE}"
		echo "normalizedApiEnvironment=true"
		;;
	write-api-optional-environment)
		local name
		local names=(
			RALLAR_BLACK_BOX_OPERATOR_CLIENT_IDS
			RALLAR_RTC_TOPOLOGY_DEGREE_LIMIT
			RALLAR_RTC_TOPOLOGY_TREE_MIN_SIZE
			RALLAR_RTC_TOPOLOGY_MESH_MIN_SIZE
			RALLAR_RTC_TOPOLOGY_MESH_PARAM_K
			RALLAR_RTC_TOPOLOGY_RTT_REBUILD_DEBOUNCE_MS
		)
		for name in "${names[@]}"; do
			update_env_value "${RALLAR_API_ENV_FILE}" "${name}" "${!name:-}"
		done
		echo "wroteApiOptionalEnvironment=true"
		;;
	*)
		echo "Unknown RALLAR_ROLLOUT_SCRIPT_SELF_TEST: ${RALLAR_ROLLOUT_SCRIPT_SELF_TEST}" >&2
		return 2
		;;
	esac
}

if [[ "${RALLAR_ROLLOUT_SCRIPT_SELF_TEST:-0}" != "0" ]]; then
	run_rollout_self_test
	exit 0
fi

if [[ "$(id -u)" != "0" ]]; then
	echo "Run this script as root." >&2
	exit 1
fi

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/rallar-deno-runtime.sh"
source "${SCRIPT_DIR}/rallar-public-spa-env.sh"
source "${SCRIPT_DIR}/rallar-playwright-install.sh"
source "${SCRIPT_DIR}/rallar-deployment-readiness.sh"
apply_rallar_public_spa_defaults
apply_rallar_public_cors_defaults

services=(rallar-api-v1.service rallar-black-box-control.service)

if [[ "${RALLAR_INCLUDE_CADDY}" == "1" || "${RALLAR_INCLUDE_CADDY}" == "true" ]]; then
	services+=(caddy.service)
fi

require_command() {
	if ! command -v "$1" >/dev/null 2>&1; then
		echo "Missing required command: $1. Run 01-install-runtime.sh first." >&2
		exit 1
	fi
}

run_with_heartbeat() {
	local label="$1"
	shift

	local interval="${RALLAR_LONG_COMMAND_HEARTBEAT_SECONDS:-30}"
	if ! [[ "${interval}" =~ ^[1-9][0-9]*$ ]]; then
		interval="30"
	fi

	"$@" &
	local pid=$!

	while kill -0 "${pid}" 2>/dev/null; do
		local elapsed=0
		while [[ "${elapsed}" -lt "${interval}" ]]; do
			sleep 1
			if ! kill -0 "${pid}" 2>/dev/null; then
				break 2
			fi
			elapsed=$((elapsed + 1))
		done
		echo "  ${label} still running at $(date -u +%Y-%m-%dT%H:%M:%SZ)"
	done

	local status
	set +e
	wait "${pid}"
	status=$?
	set -e
	return "${status}"
}

wait_for_url() {
	local label="$1"
	local url="$2"
	shift 2
	local attempts=30
	local delay_seconds=1

	echo "Waiting for ${label}: ${url}"
	for _ in $(seq 1 "${attempts}"); do
		if curl -fsS "$@" "${url}" >/dev/null; then
			echo "  ok"
			return 0
		fi
		sleep "${delay_seconds}"
	done

	echo "Timed out waiting for ${label}." >&2
	return 1
}

normalize_api_environment_allowlist() {
	sanitize_api_environment_file "${RALLAR_API_ENV_FILE}"
	chown root:root "${RALLAR_API_ENV_FILE}"
}

read_env_value() {
	local env_file="$1"
	local key="$2"

	if [[ ! -r "${env_file}" ]]; then
		return 0
	fi

	grep -E "^${key}=" "${env_file}" |
		tail -n 1 |
		cut -d= -f2- || true
}

ensure_operator_token_secret() {
	local secret="${RALLAR_BLACK_BOX_OPERATOR_TOKEN_SECRET:-}"

	if [[ -z "${secret}" ]]; then
		secret="$(read_env_value "${RALLAR_API_ENV_FILE}" "RALLAR_BLACK_BOX_OPERATOR_TOKEN_SECRET")"
	fi
	if [[ -z "${secret}" ]]; then
		secret="$(read_env_value "/etc/rallar/control-server.env" "RALLAR_BLACK_BOX_OPERATOR_TOKEN_SECRET")"
	fi
	if [[ -z "${secret}" ]]; then
		secret="$(openssl rand -hex 32)"
	fi

	update_env_value "${RALLAR_API_ENV_FILE}" "RALLAR_BLACK_BOX_OPERATOR_TOKEN_SECRET" "${secret}"
	update_env_value "${RALLAR_API_ENV_FILE}" "RALLAR_BLACK_BOX_OPERATOR_TOKEN_TTL_MS" "${RALLAR_BLACK_BOX_OPERATOR_TOKEN_TTL_MS}"
	update_env_value "${RALLAR_API_ENV_FILE}" "RALLAR_BLACK_BOX_OPERATOR_CLIENT_IDS" "${RALLAR_BLACK_BOX_OPERATOR_CLIENT_IDS}"
	update_env_value "/etc/rallar/control-server.env" "RALLAR_BLACK_BOX_OPERATOR_TOKEN_SECRET" "${secret}"
}

ensure_api_auth_credential_secret() {
	local secret="${RALLAR_AUTH_CREDENTIAL_SECRET:-}"

	if [[ -z "${secret}" ]]; then
		secret="$(read_env_value "${RALLAR_API_ENV_FILE}" "RALLAR_AUTH_CREDENTIAL_SECRET")"
	fi
	if [[ -z "${secret}" ]]; then
		secret="$(openssl rand -hex 32)"
	fi
	if ((${#secret} < 32)); then
		echo "RALLAR_AUTH_CREDENTIAL_SECRET must contain at least 32 characters." >&2
		exit 1
	fi

	update_env_value "${RALLAR_API_ENV_FILE}" "RALLAR_AUTH_CREDENTIAL_SECRET" "${secret}"
}

update_api_cors_origins() {
	apply_rallar_public_cors_defaults
	update_env_value "${RALLAR_API_ENV_FILE}" "CORS_ORIGINS" "${RALLAR_API_CORS_ORIGINS}"
}

update_api_rtc_topology_env() {
	local key
	local keys=(
		RALLAR_RTC_TOPOLOGY_DEGREE_LIMIT
		RALLAR_RTC_TOPOLOGY_TREE_MIN_SIZE
		RALLAR_RTC_TOPOLOGY_MESH_MIN_SIZE
		RALLAR_RTC_TOPOLOGY_MESH_PARAM_K
		RALLAR_RTC_TOPOLOGY_RTT_REBUILD_DEBOUNCE_MS
	)

	for key in "${keys[@]}"; do
		if [[ "${!key+x}" == "x" ]]; then
			update_env_value "/etc/rallar/api-v1.env" "${key}" "${!key}"
		fi
	done
}

update_control_allowed_origins() {
	apply_rallar_public_cors_defaults
	update_env_value "/etc/rallar/control-server.env" "RALLAR_BLACK_BOX_ALLOWED_ORIGINS" "${RALLAR_BLACK_BOX_ALLOWED_ORIGINS}"
}

require_command git
require_command npm
require_command deno
require_rallar_min_deno_version
require_command rsync
require_command curl
require_command openssl
require_command caddy

if [[ ! -d "${RALLAR_CHECKOUT_DIR}/.git" ]]; then
	echo "Missing git checkout at ${RALLAR_CHECKOUT_DIR}. Run 02-deploy-controller.sh first." >&2
	exit 1
fi

repair_known_rollout_generated_checkout_changes "${RALLAR_CHECKOUT_DIR}"

if [[ -n "$(git -C "${RALLAR_CHECKOUT_DIR}" status --porcelain)" ]]; then
	echo "Checkout has local changes; refusing controlled rollout:" >&2
	git -C "${RALLAR_CHECKOUT_DIR}" status --short >&2
	exit 1
fi

previous_revision="$(git -C "${RALLAR_CHECKOUT_DIR}" rev-parse --short HEAD)"
stopped_services=0

restart_stopped_services_on_error() {
	local exit_code="$?"
	if [[ "${stopped_services}" == "1" ]]; then
		echo
		echo "Rollout failed after services were stopped. Attempting to start controller services again." >&2
		systemctl start rallar-api-v1.service || true
		systemctl start rallar-black-box-control.service || true
		if [[ "${RALLAR_INCLUDE_CADDY}" == "1" || "${RALLAR_INCLUDE_CADDY}" == "true" ]]; then
			systemctl start caddy.service || true
		else
			systemctl reload caddy.service || systemctl restart caddy.service || true
		fi
	fi
	exit "${exit_code}"
}

echo "==> Controlled rollout from ${previous_revision} to ${RALLAR_REPO_REF}"
echo "Checkout: ${RALLAR_CHECKOUT_DIR}"
echo "Services:"
printf "  %s\n" "${services[@]}"
echo
echo "Note: stopping rallar-api-v1 resets its pglite-memory data."

trap restart_stopped_services_on_error ERR

echo "==> Updating git checkout"
rallar_playwright_operation_stage "rollout-checkout"
update_rollout_checkout "${RALLAR_CHECKOUT_DIR}" "${RALLAR_REPO_REF}"
chown -R rallar:rallar "${RALLAR_CHECKOUT_DIR}"

current_revision="$(git -C "${RALLAR_CHECKOUT_DIR}" rev-parse --short HEAD)"
echo "Updated ${previous_revision} -> ${current_revision}"

cleanup_rollout_disk_pressure

echo "==> Installing npm dependencies"
rallar_playwright_operation_stage "rollout-npm-dependencies"
runuser -u rallar -- npm --prefix "${RALLAR_CHECKOUT_DIR}" ci
cleanup_rollout_npm_transients
print_rollout_disk_summary "after npm dependency cleanup"

echo "==> Warming Deno caches"
rallar_playwright_operation_stage "rollout-deno-cache"
runuser -u rallar -- env DENO_DIR=/var/lib/rallar-deno \
	deno cache --frozen --config "${RALLAR_CHECKOUT_DIR}/apps/api-v1/deno.json" \
	"${RALLAR_CHECKOUT_DIR}/apps/api-v1/src/main.ts"
runuser -u rallar -- env DENO_DIR=/var/lib/rallar-deno \
	deno cache --frozen --config "${RALLAR_CHECKOUT_DIR}/apps/rallar-black-box-control-server/deno.json" \
	"${RALLAR_CHECKOUT_DIR}/apps/rallar-black-box-control-server/src/main.ts"

if [[ "${RALLAR_INSTALL_PLAYWRIGHT}" == "1" || "${RALLAR_INSTALL_PLAYWRIGHT}" == "true" ]]; then
	install_rallar_playwright_browser "${RALLAR_CHECKOUT_DIR}" "${RALLAR_BLACK_BOX_BROWSER_ENGINE}"
fi

echo "==> Building rallar-black-box SPA"
rallar_playwright_operation_stage "rollout-spa-build"
build_rallar_black_box_spa "${RALLAR_CHECKOUT_DIR}"

echo "==> Stopping services for publish/start"
stopped_services=1
for service in "${services[@]}"; do
	systemctl stop "${service}"
done

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
remove_rollout_path "${RALLAR_CHECKOUT_DIR}/apps/rallar-black-box/dist"
remove_rollout_path "${RALLAR_CHECKOUT_DIR}/apps/rallar-black-box-headless/dist"
print_rollout_disk_summary "after publishing SPA cleanup"

echo "==> Writing SPA public env audit"
write_rallar_black_box_spa_env_file

echo "==> Normalizing API environment allowlist"
normalize_api_environment_allowlist

echo "==> Updating API CORS origins"
update_api_cors_origins

echo "==> Updating API RTC topology env"
update_api_rtc_topology_env

echo "==> Updating control-server browser origins"
update_control_allowed_origins

echo "==> Ensuring black-box operator token broker secret"
ensure_operator_token_secret

echo "==> Ensuring stable API auth credential secret"
ensure_api_auth_credential_secret

echo "==> Writing Caddyfile"
write_rallar_controller_caddyfile

echo "==> Starting services"
rallar_playwright_operation_stage "rollout-service-start"
systemctl daemon-reload
systemctl start rallar-api-v1.service
systemctl start rallar-black-box-control.service

if [[ "${RALLAR_INCLUDE_CADDY}" == "1" || "${RALLAR_INCLUDE_CADDY}" == "true" ]]; then
	systemctl start caddy.service
else
	systemctl reload caddy.service || systemctl restart caddy.service
fi
stopped_services=0
trap - ERR

rallar_playwright_operation_stage "rollout-service-health"
wait_for_url "API-v1 config" "http://127.0.0.1:8080/api/config"
wait_for_url "API-v1 docs" "http://127.0.0.1:8080/api/docs"
wait_for_url "control health" "http://127.0.0.1:5180/health" -H "x-forwarded-proto: https"
verify_rallar_control_public_cors

deployment_browser_status="not-verified"
if verify_rallar_playwright_browser \
	"${RALLAR_CHECKOUT_DIR}" "${RALLAR_BLACK_BOX_BROWSER_ENGINE}"; then
	deployment_browser_status="passed"
elif [[ "${RALLAR_INSTALL_PLAYWRIGHT}" == "1" || "${RALLAR_INSTALL_PLAYWRIGHT}" == "true" ]]; then
	echo "Playwright browser verification failed after an explicit install." >&2
	exit 1
else
	echo "Playwright browser is not verified for this deployment; run-only Hetzner recipes will be rejected." >&2
fi

rallar_playwright_operation_stage "deployment-readiness"
RALLAR_DEPLOYMENT_BROWSER_STATUS="${deployment_browser_status}" \
	RALLAR_DEPLOYMENT_API_HEALTH_STATUS=passed \
	RALLAR_DEPLOYMENT_CONTROL_HEALTH_STATUS=passed \
	RALLAR_DEPLOYMENT_PUBLIC_HEALTH_STATUS=passed \
	write_rallar_deployment_readiness "${RALLAR_CHECKOUT_DIR}"

echo
"${SCRIPT_DIR}/07-status-controller.sh"

echo
echo "Rollout complete: ${previous_revision} -> ${current_revision}"
