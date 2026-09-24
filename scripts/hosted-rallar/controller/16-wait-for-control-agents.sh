#!/usr/bin/env bash
set -Eeuo pipefail

RALLAR_BLACK_BOX_CONTROL_URL="${RALLAR_BLACK_BOX_CONTROL_URL:-wss://control.rallar.intactss.com/control}"
RALLAR_BLACK_BOX_RUN_ID="${RALLAR_BLACK_BOX_RUN_ID:-}"
RALLAR_BLACK_BOX_AGENT_PREFIX="${RALLAR_BLACK_BOX_AGENT_PREFIX:-controller}"
RALLAR_BLACK_BOX_AGENT_COUNT="${RALLAR_BLACK_BOX_AGENT_COUNT:-1}"
RALLAR_BLACK_BOX_AGENT_START_INDEX="${RALLAR_BLACK_BOX_AGENT_START_INDEX:-1}"
RALLAR_HEADLESS_READY_TIMEOUT_SECONDS="${RALLAR_HEADLESS_READY_TIMEOUT_SECONDS:-120}"

require_command() {
	if ! command -v "$1" >/dev/null 2>&1; then
		echo "Missing required command: $1. Run 01-install-runtime.sh first." >&2
		exit 1
	fi
}

validate_positive_integer() {
	local key="$1"
	local value="$2"
	if ! [[ "${value}" =~ ^[1-9][0-9]*$ ]]; then
		echo "${key} must be a positive integer. Received: ${value}" >&2
		exit 1
	fi
}

validate_required_value() {
	local key="$1"
	local value="${!key-}"
	if [[ -z "${value}" ]]; then
		echo "Missing required value: ${key}" >&2
		exit 1
	fi
}

control_run_snapshot_url() {
	local control_url="$1"
	local run_id="$2"
	local scheme rest host encoded_run_id

	if [[ "${control_url}" == ws://* ]]; then
		scheme="http"
		rest="${control_url#ws://}"
	elif [[ "${control_url}" == wss://* ]]; then
		scheme="https"
		rest="${control_url#wss://}"
	elif [[ "${control_url}" == http://* ]]; then
		scheme="http"
		rest="${control_url#http://}"
	elif [[ "${control_url}" == https://* ]]; then
		scheme="https"
		rest="${control_url#https://}"
	else
		echo "Unsupported control URL: ${control_url}" >&2
		return 1
	fi

	host="${rest%%/*}"
	encoded_run_id="$(jq -nr --arg v "${run_id}" '$v|@uri')"
	printf '%s://%s/runs/%s' "${scheme}" "${host}" "${encoded_run_id}"
}

connected_agent_count() {
	local snapshot="$1"
	local prefix="$2"
	local agent_start="$3"
	local agent_end="$4"

	jq \
		--arg prefix "${prefix}" \
		--argjson start "${agent_start}" \
		--argjson end "${agent_end}" \
		'[.agents[]? | select(
      .connected == true and
      (.agentId | startswith($prefix)) and
      ((.agentId[$prefix | length:] | tonumber?) as $ordinal |
        ($ordinal != null and $ordinal >= $start and $ordinal <= $end))
    )] | length' <<<"${snapshot}" 2>/dev/null || echo 0
}

require_command curl
require_command jq

validate_required_value RALLAR_BLACK_BOX_CONTROL_URL
validate_required_value RALLAR_BLACK_BOX_RUN_ID
validate_required_value RALLAR_BLACK_BOX_AGENT_PREFIX
validate_positive_integer RALLAR_BLACK_BOX_AGENT_COUNT "${RALLAR_BLACK_BOX_AGENT_COUNT}"
validate_positive_integer RALLAR_BLACK_BOX_AGENT_START_INDEX "${RALLAR_BLACK_BOX_AGENT_START_INDEX}"
validate_positive_integer RALLAR_HEADLESS_READY_TIMEOUT_SECONDS "${RALLAR_HEADLESS_READY_TIMEOUT_SECONDS}"

snapshot_url="$(control_run_snapshot_url "${RALLAR_BLACK_BOX_CONTROL_URL}" "${RALLAR_BLACK_BOX_RUN_ID}")"
expected="${RALLAR_BLACK_BOX_AGENT_COUNT}"
prefix="${RALLAR_BLACK_BOX_AGENT_PREFIX}-"
agent_start="${RALLAR_BLACK_BOX_AGENT_START_INDEX}"
agent_end="$((agent_start + expected - 1))"
last_state="no snapshot yet"
RALLAR_BLACK_BOX_CONTROL_READ_TOKEN="${RALLAR_BLACK_BOX_CONTROL_READ_TOKEN:-${RALLAR_BLACK_BOX_CONTROL_TOKEN:-}}"
curl_args=(-fsS)
if [[ -n "${RALLAR_BLACK_BOX_CONTROL_READ_TOKEN:-}" ]]; then
	curl_args+=(-H "Authorization: Bearer ${RALLAR_BLACK_BOX_CONTROL_READ_TOKEN}")
fi

echo "==> Waiting for ${expected} external control agent(s) ${prefix}${agent_start}..${prefix}${agent_end} in ${snapshot_url}"
for _ in $(seq 1 "${RALLAR_HEADLESS_READY_TIMEOUT_SECONDS}"); do
	snapshot="$(curl "${curl_args[@]}" "${snapshot_url}" 2>/dev/null || true)"
	if [[ -n "${snapshot}" ]]; then
		connected="$(connected_agent_count "${snapshot}" "${prefix}" "${agent_start}" "${agent_end}")"
		total="$(jq '[.agents[]?] | length' <<<"${snapshot}" 2>/dev/null || echo 0)"
		last_state="connected=${connected}/${expected}, totalAgents=${total}"
		if [[ "${connected}" -ge "${expected}" ]]; then
			echo "  ok (${last_state})"
			exit 0
		fi
	fi
	sleep 1
done

echo "Timed out waiting for external control agents. Last state: ${last_state}" >&2
exit 1
