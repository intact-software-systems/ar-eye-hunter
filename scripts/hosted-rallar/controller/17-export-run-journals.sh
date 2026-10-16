#!/usr/bin/env bash
set -Eeuo pipefail

# Bounded so the operator artifact stays within the workflow's upload limits: with timing and
# AppInbox phase timing on, the API writes on the order of 10 000 journal lines per 50-agent run.
JOURNAL_LINE_CAP=50000
# The agents disconnect after the recipe reports its terminal state; the API journal is complete for
# the run once every WS connect it logged since the run start has its disconnect. A retried or
# rejected item logs one handler line per attempt, so connections count by distinct request id.
# Only an instrumented API writes handler lines; an uninstrumented one gives no teardown signal.
APP_INBOX_HANDLER='"component":"app-inbox-handler"'
DEFAULT_TEARDOWN_TIMEOUT_SECONDS=120
DEFAULT_TEARDOWN_POLL_SECONDS=5
WS_CONNECT_HANDLER='"component":"app-inbox-handler","operation":"CLIENT_AUTHORISED_WS_CONNECT"'
WS_DISCONNECT_HANDLER='"component":"app-inbox-handler","operation":"CLIENT_AUTHORISED_WS_DISCONNECT"'

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"

since=""
output_dir=""
teardown_timeout_seconds="${DEFAULT_TEARDOWN_TIMEOUT_SECONDS}"
teardown_poll_seconds="${DEFAULT_TEARDOWN_POLL_SECONDS}"

usage() {
	cat <<'EOF_USAGE'
Usage: 17-export-run-journals.sh --since <journalctl since> --output-dir <dir>
         [--teardown-timeout-seconds <n>] [--teardown-poll-seconds <n>]

Writes api-journal.log and control-journal.log into <dir>: the redacted raw journal of
rallar-api-v1.service and rallar-black-box-control.service since the run phase began,
each capped at its last 50000 lines. The API journal is re-exported every poll until every
WS connect it logged since the run start has its disconnect (the run's teardown), or the
timeout passes (default 120 s, polled every 5 s). An API journal without AppInbox handler
lines, an uninstrumented API, is exported once and reported as having no teardown balance.
EOF_USAGE
}

require_seconds_value() {
	local option="$1"
	local value="$2"
	if ! [[ "${value}" =~ ^[0-9]+$ ]]; then
		echo "${option} must be a non-negative integer number of seconds. Received: ${value}" >&2
		usage >&2
		exit 2
	fi
}

require_option_value() {
	local option="$1"
	if [[ "$#" -lt 2 || -z "${2:-}" ]]; then
		echo "${option} requires a value." >&2
		usage >&2
		exit 2
	fi
}

while [[ $# -gt 0 ]]; do
	case "$1" in
	--since)
		require_option_value "$@"
		since="${2:-}"
		shift 2
		;;
	--output-dir)
		require_option_value "$@"
		output_dir="${2:-}"
		shift 2
		;;
	--teardown-timeout-seconds)
		require_option_value "$@"
		require_seconds_value "$1" "${2:-}"
		teardown_timeout_seconds="${2:-}"
		shift 2
		;;
	--teardown-poll-seconds)
		require_option_value "$@"
		require_seconds_value "$1" "${2:-}"
		teardown_poll_seconds="${2:-}"
		shift 2
		;;
	-h | --help)
		usage
		exit 0
		;;
	*)
		echo "Unknown option: $1" >&2
		usage >&2
		exit 2
		;;
	esac
done

for required in since output_dir; do
	if [[ -z "${!required}" ]]; then
		echo "Missing required option: --${required//_/-}" >&2
		usage >&2
		exit 2
	fi
done

export_journal() {
	local service="$1"
	local output_file="$2"
	"${SCRIPT_DIR}/15-logs.sh" \
		--raw \
		--no-color \
		--services "${service}" \
		--lines "${JOURNAL_LINE_CAP}" \
		--since "${since}" >"${output_file}"
}

count_journal_request_ids() {
	local pattern="$1"
	local journal_file="$2"
	{ grep -F "${pattern}" "${journal_file}" || true; } |
		{ grep -o -E '"requestId":"[^"]*"' || true; } |
		sort -u |
		wc -l |
		tr -d ' '
}

# Re-exports the API journal until its WS connects balance its disconnects or the timeout passes.
export_api_journal_after_teardown() {
	local api_journal="$1"
	local waited_seconds=0
	local connects disconnects
	export_journal api "${api_journal}"
	if ! grep -q -F "${APP_INBOX_HANDLER}" "${api_journal}"; then
		echo "API uninstrumented; teardown balance unavailable: exported without waiting for the WS teardown."
		return 0
	fi
	connects="$(count_journal_request_ids "${WS_CONNECT_HANDLER}" "${api_journal}")"
	disconnects="$(count_journal_request_ids "${WS_DISCONNECT_HANDLER}" "${api_journal}")"
	while ((connects > disconnects && waited_seconds < teardown_timeout_seconds)); do
		sleep "${teardown_poll_seconds}"
		waited_seconds=$((waited_seconds + teardown_poll_seconds))
		export_journal api "${api_journal}"
		connects="$(count_journal_request_ids "${WS_CONNECT_HANDLER}" "${api_journal}")"
		disconnects="$(count_journal_request_ids "${WS_DISCONNECT_HANDLER}" "${api_journal}")"
	done
	if ((connects > disconnects)); then
		echo "WS teardown incomplete: ${disconnects} of ${connects} connections disconnected after ${waited_seconds} s; exporting anyway."
	else
		echo "WS teardown complete: ${disconnects} of ${connects} connections disconnected after ${waited_seconds} s."
	fi
}

if ((teardown_poll_seconds == 0 && teardown_timeout_seconds > 0)); then
	echo "--teardown-poll-seconds must be positive when a teardown timeout is set." >&2
	exit 2
fi

mkdir -p "${output_dir}"
export_api_journal_after_teardown "${output_dir}/api-journal.log"
export_journal control "${output_dir}/control-journal.log"
echo "Exported the API and control-server journals since ${since} to ${output_dir}."
