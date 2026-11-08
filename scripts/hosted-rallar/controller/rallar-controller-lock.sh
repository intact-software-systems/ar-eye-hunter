#!/usr/bin/env bash

# The flock serializes controller mutations (deploy and rollout).
rallar_lock_controller() {
	local root="${RALLAR_CONTROLLER_LOCK_ROOT:-/var/lib/rallar-controller}"
	mkdir -p "${root}"
	if [[ "${RALLAR_CONTROLLER_LOCK_HELD:-}" == 1 ]]; then
		[[ "$(readlink /proc/self/fd/9)" == "${root}/controller.lock" ]] || return 1
		flock -n 9 || return 1
	else
		exec 9>"${root}/controller.lock"
		flock -n 9 || {
			echo 'Controller mutation already in progress.' >&2
			return 1
		}
		export RALLAR_CONTROLLER_LOCK_HELD=1
	fi
}
