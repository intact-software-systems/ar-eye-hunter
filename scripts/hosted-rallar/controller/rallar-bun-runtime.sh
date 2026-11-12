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

# The Bun version a commit pins for its hosts, read from this file as that commit carries it.
read_rallar_bun_version_at_commit() {
	local checkout_dir="$1"
	local commit="$2"
	local pin

	pin="$(git -C "${checkout_dir}" show "${commit}:scripts/hosted-rallar/controller/rallar-bun-runtime.sh" 2>/dev/null |
		grep -m 1 -E '^RALLAR_MIN_BUN_VERSION=')" || return 1
	[[ "${pin}" =~ :-([0-9]+[.][0-9]+[.][0-9]+)[}]\"$ ]] || return 1
	printf '%s\n' "${BASH_REMATCH[1]}"
}

# Refuses a commit that the installed Bun and the units this file writes cannot run: it must carry the lockfile
# npm ci installs from, each app's Bun entry point without the Deno configuration of pre-Bun source, and pin a Bun
# no newer than this host's.
require_rallar_bun_runnable_commit() {
	local checkout_dir="$1"
	local commit="$2"
	shift 2
	local app_dir pinned_version installed_version

	if ! git -C "${checkout_dir}" cat-file -e "${commit}:package-lock.json" 2>/dev/null; then
		echo "Refusing ${commit}: it has no package-lock.json for npm ci." >&2
		return 1
	fi
	for app_dir in "$@"; do
		if git -C "${checkout_dir}" cat-file -e "${commit}:${app_dir}/deno.json" 2>/dev/null; then
			echo "Refusing ${commit}: ${app_dir} is pre-Bun source (deno.json); its Bun unit cannot run it." >&2
			return 1
		fi
		if ! git -C "${checkout_dir}" cat-file -e "${commit}:${app_dir}/src/main.ts" 2>/dev/null; then
			echo "Refusing ${commit}: ${app_dir} has no src/main.ts for its Bun unit to run." >&2
			return 1
		fi
	done
	if ! pinned_version="$(read_rallar_bun_version_at_commit "${checkout_dir}" "${commit}")"; then
		echo "Refusing ${commit}: it pins no Bun version in rallar-bun-runtime.sh." >&2
		return 1
	fi
	installed_version="$(current_rallar_bun_version)"
	if ! rallar_bun_version_at_least "${installed_version}" "${pinned_version}"; then
		echo "Refusing ${commit}: it needs Bun ${pinned_version}; this host has ${installed_version}. Run that revision's 01-install-runtime.sh first." >&2
		return 1
	fi
}

# Moves the checkout to the ref only once the ref proves runnable by the role's Bun units, so a refused ref leaves
# the checkout and every service as they were. A branch follows the remote exactly: a rebased branch no longer
# fast-forwards.
update_rallar_bun_checkout() {
	local checkout_dir="$1"
	local repo_ref="$2"
	local app_dirs=() app_dir commit

	while IFS= read -r app_dir; do
		app_dirs+=("${app_dir}")
	done < <(rallar_role_app_dirs)
	if ((${#app_dirs[@]} == 0)); then
		echo "No app directories for role ${RALLAR_CONTROLLER_ROLE:-unset}; refusing the checkout." >&2
		return 1
	fi

	git -C "${checkout_dir}" fetch --prune origin
	if [[ "${repo_ref}" =~ ^[0-9a-fA-F]{40}$ ]]; then
		commit="${repo_ref}"
	else
		commit="$(git -C "${checkout_dir}" rev-parse --verify "origin/${repo_ref}^{commit}")"
	fi
	require_rallar_bun_runnable_commit "${checkout_dir}" "${commit}" "${app_dirs[@]}"
	if [[ "${commit}" == "${repo_ref}" ]]; then
		git -C "${checkout_dir}" checkout --detach "${commit}"
	else
		git -C "${checkout_dir}" checkout -B "${repo_ref}" "origin/${repo_ref}"
	fi
}

# The sandbox every Bun server unit runs in, in place of Deno's --allow-net/--allow-env/--allow-read: the system,
# the checkout and the service user's home are read-only, devices, kernel and cgroup settings are out of reach, no
# privilege can be gained, and only IP and UNIX sockets open. Each argument is a directory the service writes; the
# transpiler cache would write under the read-only home, so it is off.
# One number bounds a Bun server's stop: the server exits 1 at this deadline, and systemd's SIGKILL comes after it.
RALLAR_BUN_SHUTDOWN_DEADLINE_SECONDS="${RALLAR_BUN_SHUTDOWN_DEADLINE_SECONDS:-60}"
RALLAR_BUN_SHUTDOWN_KILL_MARGIN_SECONDS=10

print_rallar_bun_service_hardening() {
	printf 'Environment=RALLAR_SHUTDOWN_DEADLINE_MS=%s\n' "$((RALLAR_BUN_SHUTDOWN_DEADLINE_SECONDS * 1000))"
	printf 'TimeoutStopSec=%s\n' "$((RALLAR_BUN_SHUTDOWN_DEADLINE_SECONDS + RALLAR_BUN_SHUTDOWN_KILL_MARGIN_SECONDS))"
	cat <<'EOF'
Environment=BUN_RUNTIME_TRANSPILER_CACHE_PATH=0
NoNewPrivileges=true
PrivateTmp=true
PrivateDevices=true
ProtectSystem=strict
ProtectHome=true
ProtectKernelTunables=true
ProtectKernelModules=true
ProtectControlGroups=true
RestrictSUIDSGID=true
LockPersonality=true
RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6
CapabilityBoundingSet=
EOF
	local writable_dir
	for writable_dir in "$@"; do
		printf 'ReadWritePaths=%s\n' "${writable_dir}"
	done
}

write_rallar_control_server_unit() {
	local checkout_dir="$1"
	local storage_dir="$2"

	cat >"${RALLAR_SYSTEMD_UNIT_DIR:-/etc/systemd/system}/rallar-black-box-control.service" <<EOF
[Unit]
Description=Rallar Black Box control server
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=rallar
Group=rallar
WorkingDirectory=${checkout_dir}/apps/rallar-black-box-control-server
EnvironmentFile=/etc/rallar/control-server.env
ExecStart=/usr/local/bin/bun run src/main.ts
Restart=always
RestartSec=5
$(print_rallar_bun_service_hardening "${storage_dir}")

[Install]
WantedBy=multi-user.target
EOF
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
