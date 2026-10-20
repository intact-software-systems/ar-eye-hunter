#!/usr/bin/env bash

# Status 3 means a valid file omitted the key; read and syntax failures use other statuses.
read_rallar_api_file_value() {
	local env_file="$1"
	local key="$2"
	local contents line value="" found=0
	if [[ ! -f "${env_file}" || ! -r "${env_file}" ]]; then
		echo "Cannot read the API secret file or controller environment." >&2
		return 1
	fi
	contents="$(cat -- "${env_file}")" || {
		echo "Cannot read the API secret file or controller environment." >&2
		return 1
	}
	while IFS= read -r line; do
		if [[ "${line}" =~ ^[[:space:]]*(export[[:space:]]+)?${key}[[:space:]]*= ]]; then
			if [[ "${line}" != "${key}="* || "${line}" == *[\'\"\\]* || "${line}" =~ [[:space:]] ]]; then
				echo "Unsupported assignment in the API secret file or controller environment for ${key}." >&2
				return 1
			fi
			value="${line#*=}"
			found=1
		fi
	done <<<"${contents}"
	[[ "${found}" == "1" ]] || return 3
	printf '%s' "${value}"
}

read_rallar_api_effective_env_value() {
	local env_file="$1"
	local key="$2"
	local secret_value status
	if [[ -e "${RALLAR_API_SECRET_FILE}" || -L "${RALLAR_API_SECRET_FILE}" ]]; then
		if secret_value="$(read_rallar_api_file_value "${RALLAR_API_SECRET_FILE}" "${key}")"; then
			printf '%s' "${secret_value}"
			return 0
		else
			status=$?
			[[ "${status}" == "3" ]] || return "${status}"
		fi
	fi
	if secret_value="$(read_rallar_api_file_value "${env_file}" "${key}")"; then
		printf '%s' "${secret_value}"
		return 0
	else
		status=$?
		[[ "${status}" == "3" ]] || return "${status}"
	fi
	return 3
}
