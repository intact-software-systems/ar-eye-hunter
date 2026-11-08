#!/usr/bin/env bash
set -Eeuo pipefail

RALLAR_MIN_BUN_VERSION="${RALLAR_MIN_BUN_VERSION:-1.4.4}"

parse_rallar_bun_semver() {
	local version="${1#bun }"
	version="${version#v}"
	version="${version%% *}"
	version="${version%%-*}"

	if [[ ! "${version}" =~ ^([0-9]+)\.([0-9]+)\.([0-9]+)$ ]]; then
		echo "Unsupported Bun version string: ${1}" >&2
		return 1
	fi

	printf '%s %s %s\n' "${BASH_REMATCH[1]}" "${BASH_REMATCH[2]}" "${BASH_REMATCH[3]}"
}

rallar_bun_version_at_least() {
	local version="$1"
	local minimum="$2"
	local version_major version_minor version_patch
	local minimum_major minimum_minor minimum_patch

	read -r version_major version_minor version_patch < <(parse_rallar_bun_semver "${version}")
	read -r minimum_major minimum_minor minimum_patch < <(parse_rallar_bun_semver "${minimum}")

	if ((version_major != minimum_major)); then
		if ((version_major > minimum_major)); then
			return 0
		fi
		return 1
	fi
	if ((version_minor != minimum_minor)); then
		if ((version_minor > minimum_minor)); then
			return 0
		fi
		return 1
	fi
	if ((version_patch >= minimum_patch)); then
		return 0
	fi
	return 1
}

current_rallar_bun_version() {
	if [[ -n "${RALLAR_BUN_SELF_TEST_VERSION:-}" ]]; then
		printf '%s\n' "${RALLAR_BUN_SELF_TEST_VERSION}"
		return 0
	fi

	local output
	output="$(bun --version)"
	printf '%s\n' "${output%%$'\n'*}"
}

require_rallar_min_bun_version() {
	local minimum="${1:-${RALLAR_MIN_BUN_VERSION}}"
	local version
	version="$(current_rallar_bun_version)"

	if ! rallar_bun_version_at_least "${version}" "${minimum}"; then
		echo "Bun ${minimum} or newer required; found ${version}. Run 01-install-runtime.sh or upgrade Bun." >&2
		return 1
	fi

	echo "Bun ${version} satisfies minimum ${minimum}."
}

run_rallar_bun_runtime_self_test() {
	case "${RALLAR_BUN_RUNTIME_SELF_TEST:-}" in
	version-check)
		require_rallar_min_bun_version >/dev/null
		echo "bunVersionOk=true"
		;;
	*)
		echo "Unknown RALLAR_BUN_RUNTIME_SELF_TEST: ${RALLAR_BUN_RUNTIME_SELF_TEST}" >&2
		return 2
		;;
	esac
}

if [[ "${BASH_SOURCE[0]}" == "$0" && "${RALLAR_BUN_RUNTIME_SELF_TEST:-0}" != "0" ]]; then
	run_rallar_bun_runtime_self_test
fi
