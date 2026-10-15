#!/usr/bin/env bash
set -Eeuo pipefail

# Bounded so the operator artifact stays within the workflow's upload limits: with timing and
# AppInbox phase timing on, the API writes about 9 000 journal lines per 50-agent run.
JOURNAL_LINE_CAP=50000

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"

since=""
output_dir=""

usage() {
	cat <<'EOF_USAGE'
Usage: 17-export-run-journals.sh --since <journalctl since> --output-dir <dir>

Writes api-journal.log and control-journal.log into <dir>: the redacted raw journal of
rallar-api-v1.service and rallar-black-box-control.service since the run phase began,
each capped at its last 50000 lines.
EOF_USAGE
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

mkdir -p "${output_dir}"
export_journal api "${output_dir}/api-journal.log"
export_journal control "${output_dir}/control-journal.log"
echo "Exported the API and control-server journals since ${since} to ${output_dir}."
