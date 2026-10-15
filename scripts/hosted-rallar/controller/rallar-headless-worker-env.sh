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

write_rallar_headless_worker_env_line() {
	local destination="$1"
	local key="$2"
	local value="$3"
	local quoted_value
	quoted_value="$(to_rallar_headless_worker_env_value "${value}")" || return $?
	printf '%s=%s\n' "${key}" "${quoted_value}" >>"${destination}" || return $?
}

write_rallar_headless_worker_env_var() {
	local destination="$1"
	local key="$2"
	local value="${!key-}"
	if [[ -n "${value}" || ("${key}" == RALLAR_BLACK_BOX_ROUTINE_BROWSER_DIAGNOSTICS && "${!key+x}" == x) ]]; then
		write_rallar_headless_worker_env_line "${destination}" "${key}" "${value}" || return $?
	fi
}

rallar_headless_worker_registers_agents() {
	local register
	register="$(printf '%s' "${RALLAR_BLACK_BOX_REGISTER-}" | tr '[:upper:]' '[:lower:]')"
	[[ "${register}" == 1 || "${register}" == true || "${register}" == yes || "${register}" == on ]]
}

# A registered run gives every agent its own user, named after its agent id, so no
# two agents share one principal's connect-time snapshot fan-out.
write_rallar_headless_worker_registered_agent_credentials() {
	local destination="$1"
	if [[ -z "${RALLAR_BLACK_BOX_PASSWORD-}" ]]; then
		echo "RALLAR_BLACK_BOX_REGISTER needs RALLAR_BLACK_BOX_PASSWORD for the per-agent users." >&2
		return 1
	fi

	local local_index agent_id
	for ((local_index = 1; local_index <= RALLAR_BLACK_BOX_AGENT_COUNT; local_index += 1)); do
		agent_id="${RALLAR_BLACK_BOX_AGENT_PREFIX}-$(printf '%02d' "$((RALLAR_BLACK_BOX_AGENT_START_INDEX + local_index - 1))")"
		write_rallar_headless_worker_env_line "${destination}" "RALLAR_BLACK_BOX_AGENT_${local_index}_USERNAME" "${agent_id}" || return $?
		write_rallar_headless_worker_env_line "${destination}" "RALLAR_BLACK_BOX_AGENT_${local_index}_PASSWORD" "${RALLAR_BLACK_BOX_PASSWORD}" || return $?
	done
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
		RALLAR_BLACK_BOX_ROUTINE_BROWSER_DIAGNOSTICS
		RALLAR_BLACK_BOX_EVENT_HISTORY RALLAR_BLACK_BOX_EVENT_HISTORY_MAX_EVENTS
	)

	local key
	for key in "${required_vars[@]}" "${optional_vars[@]}"; do
		write_rallar_headless_worker_env_var "${tmp_env_file}" "${key}" || exit $?
	done

	local per_agent_pattern
	if rallar_headless_worker_registers_agents; then
		write_rallar_headless_worker_registered_agent_credentials "${tmp_env_file}" || exit $?
		per_agent_pattern='^RALLAR_BLACK_BOX_AGENT_[0-9]+_CONTROL_TOKEN$'
	else
		write_rallar_headless_worker_env_var "${tmp_env_file}" RALLAR_BLACK_BOX_USERNAME || exit $?
		write_rallar_headless_worker_env_var "${tmp_env_file}" RALLAR_BLACK_BOX_PASSWORD || exit $?
		per_agent_pattern='^RALLAR_BLACK_BOX_AGENT_[0-9]+_(USERNAME|PASSWORD|CONTROL_TOKEN)$'
	fi

	while IFS= read -r key; do
		write_rallar_headless_worker_env_var "${tmp_env_file}" "${key}" || exit $?
	done < <(compgen -e | grep -E "${per_agent_pattern}" | sort || true)

	mv "${tmp_env_file}" "${destination}" || exit $?
	chmod 0600 "${destination}" || exit $?
)
