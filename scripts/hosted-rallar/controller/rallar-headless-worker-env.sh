#!/usr/bin/env bash

to_rallar_headless_worker_env_value() {
	local value="$1"
	if [[ "${value}" == *$'\n'* || "${value}" == *$'\r'* ]]; then
		echo "Environment values may not contain newlines." >&2
		exit 1
	fi
	value="${value//\\/\\\\}"
	value="${value//\"/\\\"}"
	value="${value//\$/\\\$}"
	value="${value//\`/\\\`}"
	printf '"%s"' "${value}"
}

write_rallar_headless_worker_env_var() {
	local destination="$1"
	local key="$2"
	local value="${!key-}"
	if [[ -n "${value}" ]]; then
		local quoted_value
		quoted_value="$(to_rallar_headless_worker_env_value "${value}")" || return $?
		printf '%s=%s\n' "${key}" "${quoted_value}" >>"${destination}" || return $?
	fi
}

write_rallar_headless_worker_env_file() (
	local destination="$1"
	tmp_env_file="$(mktemp "$(dirname "${destination}")/.headless-worker.env.XXXXXX")" || exit $?
	trap 'rm -f "${tmp_env_file}"' EXIT
	chmod 0600 "${tmp_env_file}" || exit $?

	cat >"${tmp_env_file}" <<EOF_ENV || exit $?
# Written by scripts/hosted-rallar/controller/09-start-headless-workers.sh.
# Contains credentials; keep this file root-readable only.
EOF_ENV

	local required_vars=(
		RALLAR_BLACK_BOX_SPA_URL RALLAR_BLACK_BOX_CONTROL_URL
		RALLAR_API_BASE_URL RALLAR_BLACK_BOX_RUN_ID
		RALLAR_BLACK_BOX_ROOM_ID RALLAR_BLACK_BOX_AGENT_PREFIX
		RALLAR_BLACK_BOX_AGENT_COUNT RALLAR_BLACK_BOX_AGENT_START_INDEX
		PLAYWRIGHT_BROWSERS_PATH
	)
	local optional_vars=(
		RALLAR_BLACK_BOX_USERNAME RALLAR_BLACK_BOX_PASSWORD
		RALLAR_BLACK_BOX_CONTROL_TOKEN RALLAR_BLACK_BOX_CONTROL_READ_TOKEN
		RALLAR_BLACK_BOX_REPORT_UPLOAD_URL RALLAR_BLACK_BOX_ENVIRONMENT
		RALLAR_BLACK_BOX_TRANSPORT RALLAR_BLACK_BOX_STATS_INTERVAL_MS
		RALLAR_BLACK_BOX_HEARTBEAT_INTERVAL_MS RALLAR_APPLICATION_ID
		RALLAR_BLACK_BOX_APPLICATION_ID RALLAR_WORKSPACE_ID
		RALLAR_BLACK_BOX_WORKSPACE_ID RALLAR_BLACK_BOX_REGISTER
		RALLAR_BLACK_BOX_RESTORE_SESSION RALLAR_BLACK_BOX_LOGOUT_ON_CLOSE
		RALLAR_BLACK_BOX_LEAVE_ROOM_ON_CLOSE RALLAR_BLACK_BOX_HEADLESS_ENTRY
		RALLAR_BLACK_BOX_BROWSER_LOG_LEVEL RALLAR_BLACK_BOX_BROWSER_ENGINE
		RALLAR_BLACK_BOX_HEADLESS RALLAR_BLACK_BOX_LAUNCH_TIMEOUT_MS
		RALLAR_BLACK_BOX_READY_TIMEOUT_MS RALLAR_BLACK_BOX_RTC_CAPTURE_MODE
	)

	local key
	for key in "${required_vars[@]}" "${optional_vars[@]}"; do
		write_rallar_headless_worker_env_var "${tmp_env_file}" "${key}" || exit $?
	done

	while IFS= read -r key; do
		write_rallar_headless_worker_env_var "${tmp_env_file}" "${key}" || exit $?
	done < <(compgen -e | grep -E '^RALLAR_BLACK_BOX_AGENT_[0-9]+_(USERNAME|PASSWORD|CONTROL_TOKEN)$' | sort || true)

	mv "${tmp_env_file}" "${destination}" || exit $?
	chmod 0600 "${destination}" || exit $?
)
