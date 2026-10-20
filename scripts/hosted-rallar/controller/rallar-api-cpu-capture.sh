#!/usr/bin/env bash
set -Eeuo pipefail
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/rallar-controller-lock.sh"
operation="${1:?capture operation required}"
if [[ "${operation}" != begin ]]; then
	directory="${2:?capture directory required}"
	[[ "${directory}" == "${RALLAR_API_CAPTURE_ROOT:-/var/lib/rallar-api-capture}"/api-* && -f "${directory}/configuration.json" ]] || exit 1
	export RALLAR_API_CAPTURE_OWNER="${directory##*/}"
fi
# Finish and the host deadline serialize rather than failing one another's cleanup.
if [[ "${operation}" == finish || "${operation}" == deadline ]]; then
	mkdir -p "${RALLAR_API_CAPTURE_ROOT:-/var/lib/rallar-api-capture}"
	exec 9>"${RALLAR_API_CAPTURE_ROOT:-/var/lib/rallar-api-capture}/controller.lock"
	flock 9
	export RALLAR_CONTROLLER_LOCK_HELD=1
fi
rallar_lock_controller
exec node "${SCRIPT_DIR}/rallar-api-cpu-capture.mjs" "$@"
