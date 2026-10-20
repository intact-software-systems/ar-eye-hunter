#!/usr/bin/env bash

# The same flock covers controller mutations and every capture lifecycle invocation.
rallar_lock_controller() {
	local root="${RALLAR_API_CAPTURE_ROOT:-/var/lib/rallar-api-capture}"
	mkdir -p "${root}"
	if [[ "${RALLAR_CONTROLLER_LOCK_HELD:-}" == 1 ]]; then
		[[ "$(readlink /proc/self/fd/9)" == "${root}/controller.lock" ]] || return 1
		flock -n 9 || return 1
	else
		exec 9>"${root}/controller.lock"
		flock -n 9 || { echo 'Controller mutation/capture already in progress.' >&2; return 1; }
		export RALLAR_CONTROLLER_LOCK_HELD=1
	fi
	if [[ -f "${root}/active" && "${RALLAR_API_CAPTURE_OWNER:-}" != "$(cat "${root}/active")" ]]; then
		echo 'Controller is owned by an active API capture; finish its restoration first.' >&2
		return 1
	fi
}
