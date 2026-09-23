#!/usr/bin/env bash

rallar_deployment_readiness_fail() {
	echo "$1" >&2
	return 1
}

rallar_deployment_readiness_path() {
	printf '%s' "${RALLAR_DEPLOYMENT_READINESS_PATH:-/var/lib/rallar-black-box-control/deployment-readiness.json}"
}

rallar_deployment_operating_system_id() {
	if [[ -n "${RALLAR_READINESS_OS_ID:-}" ]]; then
		printf '%s' "${RALLAR_READINESS_OS_ID}"
		return 0
	fi

	if [[ ! -r /etc/os-release ]]; then
		rallar_deployment_readiness_fail "Cannot read /etc/os-release for deployment readiness."
		return 1
	fi

	(
		# shellcheck disable=SC1091
		source /etc/os-release
		printf '%s' "${ID:-unknown}"
	)
}

rallar_deployment_operating_system_version() {
	if [[ -n "${RALLAR_READINESS_OS_VERSION:-}" ]]; then
		printf '%s' "${RALLAR_READINESS_OS_VERSION}"
		return 0
	fi

	if [[ ! -r /etc/os-release ]]; then
		rallar_deployment_readiness_fail "Cannot read /etc/os-release for deployment readiness."
		return 1
	fi

	(
		# shellcheck disable=SC1091
		source /etc/os-release
		printf '%s' "${VERSION_ID:-unknown}"
	)
}

rallar_deployment_resolved_commit() {
	local checkout_dir="$1"
	local deployment_ref="$2"
	local resolved=""

	resolved="$(git -C "${checkout_dir}" rev-parse "${deployment_ref}^{commit}" 2>/dev/null || true)"
	if [[ -z "${resolved}" ]]; then
		printf '%s' "${deployment_ref}"
		return 0
	fi

	printf '%s' "${resolved}"
}

rallar_deployment_playwright_version() {
	local checkout_dir="$1"
	local version

	version="$(jq -r '.packages["node_modules/playwright"].version // empty' \
		"${checkout_dir}/package-lock.json")"
	if [[ -z "${version}" ]]; then
		rallar_deployment_readiness_fail "package-lock.json does not contain the Playwright version."
		return 1
	fi

	printf '%s' "${version}"
}

rallar_deployment_package_lock_sha256() {
	local checkout_dir="$1"
	sha256sum "${checkout_dir}/package-lock.json" | awk '{print $1}'
}

write_rallar_deployment_readiness() {
	local checkout_dir="$1"
	local readiness_path readiness_dir temporary_path deployed_commit package_lock_sha playwright_version
	local browser_engine browser_path browser_status operating_system_id operating_system_version
	local api_health_status control_health_status public_health_status verified_at

	readiness_path="$(rallar_deployment_readiness_path)"
	readiness_dir="$(dirname "${readiness_path}")"
	deployed_commit="$(git -C "${checkout_dir}" rev-parse HEAD)"
	package_lock_sha="$(rallar_deployment_package_lock_sha256 "${checkout_dir}")"
	playwright_version="$(rallar_deployment_playwright_version "${checkout_dir}")"
	browser_engine="${RALLAR_BLACK_BOX_BROWSER_ENGINE:?RALLAR_BLACK_BOX_BROWSER_ENGINE is required}"
	browser_path="${RALLAR_PLAYWRIGHT_ROOT:-/var/lib/rallar-playwright}/active"
	browser_status="${RALLAR_DEPLOYMENT_BROWSER_STATUS:?RALLAR_DEPLOYMENT_BROWSER_STATUS is required}"
	operating_system_id="$(rallar_deployment_operating_system_id)"
	operating_system_version="$(rallar_deployment_operating_system_version)"
	api_health_status="${RALLAR_DEPLOYMENT_API_HEALTH_STATUS:?RALLAR_DEPLOYMENT_API_HEALTH_STATUS is required}"
	control_health_status="${RALLAR_DEPLOYMENT_CONTROL_HEALTH_STATUS:?RALLAR_DEPLOYMENT_CONTROL_HEALTH_STATUS is required}"
	public_health_status="${RALLAR_DEPLOYMENT_PUBLIC_HEALTH_STATUS:?RALLAR_DEPLOYMENT_PUBLIC_HEALTH_STATUS is required}"
	verified_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

	install -d -m 0755 "${readiness_dir}"
	temporary_path="$(mktemp "${readiness_dir}/.deployment-readiness.XXXXXX")"
	jq -n \
		--argjson schemaVersion 1 \
		--arg deployedCommit "${deployed_commit}" \
		--arg packageLockSha256 "${package_lock_sha}" \
		--arg playwrightVersion "${playwright_version}" \
		--arg browserEngine "${browser_engine}" \
		--arg browserPath "${browser_path}" \
		--arg browserStatus "${browser_status}" \
		--arg operatingSystemId "${operating_system_id}" \
		--arg operatingSystemVersion "${operating_system_version}" \
		--arg apiHealthStatus "${api_health_status}" \
		--arg controlHealthStatus "${control_health_status}" \
		--arg publicHealthStatus "${public_health_status}" \
		--arg verifiedAt "${verified_at}" \
		'{
      schemaVersion: $schemaVersion,
      deployedCommit: $deployedCommit,
      packageLockSha256: $packageLockSha256,
      playwrightVersion: $playwrightVersion,
      browserEngine: $browserEngine,
      browserPath: $browserPath,
      browserStatus: $browserStatus,
      operatingSystemId: $operatingSystemId,
      operatingSystemVersion: $operatingSystemVersion,
      apiHealthStatus: $apiHealthStatus,
      controlHealthStatus: $controlHealthStatus,
      publicHealthStatus: $publicHealthStatus,
      verifiedAt: $verifiedAt
    }' >"${temporary_path}"
	chmod 0644 "${temporary_path}"
	mv -f "${temporary_path}" "${readiness_path}"
}

validate_rallar_deployment_readiness() {
	local checkout_dir="$1"
	local deployment_ref="$2"
	local readiness_path expected_commit package_lock_sha playwright_version browser_engine browser_path
	local operating_system_id operating_system_version

	readiness_path="$(rallar_deployment_readiness_path)"
	if [[ ! -s "${readiness_path}" ]]; then
		rallar_deployment_readiness_fail "Missing deployment readiness stamp: ${readiness_path}"
		return 1
	fi

	expected_commit="$(rallar_deployment_resolved_commit "${checkout_dir}" "${deployment_ref}")"
	package_lock_sha="$(rallar_deployment_package_lock_sha256 "${checkout_dir}")"
	playwright_version="$(rallar_deployment_playwright_version "${checkout_dir}")"
	browser_engine="${RALLAR_BLACK_BOX_BROWSER_ENGINE:?RALLAR_BLACK_BOX_BROWSER_ENGINE is required}"
	browser_path="${RALLAR_PLAYWRIGHT_ROOT:-/var/lib/rallar-playwright}/active"
	operating_system_id="$(rallar_deployment_operating_system_id)"
	operating_system_version="$(rallar_deployment_operating_system_version)"

	if [[ ! -d "${browser_path}" ]]; then
		rallar_deployment_readiness_fail "Active Playwright browser path is missing: ${browser_path}"
		return 1
	fi

	if ! jq -e \
		--argjson schemaVersion 1 \
		--arg deployedCommit "${expected_commit}" \
		--arg packageLockSha256 "${package_lock_sha}" \
		--arg playwrightVersion "${playwright_version}" \
		--arg browserEngine "${browser_engine}" \
		--arg browserPath "${browser_path}" \
		--arg operatingSystemId "${operating_system_id}" \
		--arg operatingSystemVersion "${operating_system_version}" \
		'.schemaVersion == $schemaVersion and
      .deployedCommit == $deployedCommit and
      .packageLockSha256 == $packageLockSha256 and
      .playwrightVersion == $playwrightVersion and
      .browserEngine == $browserEngine and
      .browserPath == $browserPath and
      .browserStatus == "passed" and
      .operatingSystemId == $operatingSystemId and
      .operatingSystemVersion == $operatingSystemVersion and
      .apiHealthStatus == "passed" and
      .controlHealthStatus == "passed" and
      .publicHealthStatus == "passed" and
      (.verifiedAt | type == "string" and length > 0)' \
		"${readiness_path}" >/dev/null; then
		rallar_deployment_readiness_fail \
			"Deployment readiness stamp does not match commit, runtime, browser, or health requirements."
		return 1
	fi
}

rallar_deployment_readiness_self_test() {
	local checkout_dir="${RALLAR_CHECKOUT_DIR:?RALLAR_CHECKOUT_DIR is required}"
	local deployment_ref="${RALLAR_DEPLOYMENT_REF:?RALLAR_DEPLOYMENT_REF is required}"

	case "${RALLAR_DEPLOYMENT_READINESS_SELF_TEST:-}" in
	round-trip)
		RALLAR_DEPLOYMENT_BROWSER_STATUS=passed \
			RALLAR_DEPLOYMENT_API_HEALTH_STATUS=passed \
			RALLAR_DEPLOYMENT_CONTROL_HEALTH_STATUS=passed \
			RALLAR_DEPLOYMENT_PUBLIC_HEALTH_STATUS=passed \
			write_rallar_deployment_readiness "${checkout_dir}"
		validate_rallar_deployment_readiness "${checkout_dir}" "${deployment_ref}"
		echo "deploymentReadiness=valid"
		;;
	validate)
		validate_rallar_deployment_readiness "${checkout_dir}" "${deployment_ref}"
		echo "deploymentReadiness=valid"
		;;
	*)
		rallar_deployment_readiness_fail \
			"Unknown RALLAR_DEPLOYMENT_READINESS_SELF_TEST: ${RALLAR_DEPLOYMENT_READINESS_SELF_TEST:-}"
		return 2
		;;
	esac
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
	set -Eeuo pipefail
	rallar_deployment_readiness_self_test
fi
