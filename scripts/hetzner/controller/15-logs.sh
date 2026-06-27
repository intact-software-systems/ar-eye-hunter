#!/usr/bin/env bash
set -Eeuo pipefail

DEFAULT_LINES=120
DEFAULT_SERVICES="app,headless"

lines="${RALLAR_LOGS_LINES:-${DEFAULT_LINES}}"
follow=0
pager=0
raw=0
browser_filter=0
grep_pattern=""
since=""
service_spec=""

if [[ -t 1 && -z "${NO_COLOR:-}" ]]; then
  color=1
else
  color=0
fi

usage() {
  cat <<'EOF_USAGE'
Usage: rallar-logs [options]

Options:
  -f, --follow              Follow new log lines.
  -n, --lines <count>       Number of recent lines to show. Default: 120.
      --since <time>        Pass a journalctl --since value, e.g. "30 min ago".
      --services <list>     Comma-separated aliases: api,control,headless,browser,caddy,app,all.
      --browser             Show headless browser page logs.
      --grep <pattern>      Keep lines containing this literal text.
      --pager               Pipe through less; follow mode uses less +F.
      --no-color            Disable colored source labels.
      --raw                 Print journalctl short-iso output without jq formatting.
  -h, --help                Show this help.
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
    -f | --follow)
      follow=1
      shift
      ;;
    -n | --lines)
      require_option_value "$@"
      lines="${2:-}"
      shift 2
      ;;
    --since)
      require_option_value "$@"
      since="${2:-}"
      shift 2
      ;;
    --services)
      require_option_value "$@"
      service_spec="${2:-}"
      shift 2
      ;;
    --browser)
      browser_filter=1
      if [[ -z "${service_spec}" ]]; then
        service_spec="browser"
      else
        service_spec="${service_spec},browser"
      fi
      shift
      ;;
    --grep)
      require_option_value "$@"
      grep_pattern="${2:-}"
      shift 2
      ;;
    --pager)
      pager=1
      shift
      ;;
    --no-color)
      color=0
      shift
      ;;
    --raw)
      raw=1
      shift
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

if ! [[ "${lines}" =~ ^[0-9]+$ ]]; then
  echo "--lines must be a non-negative integer. Received: ${lines}" >&2
  exit 2
fi

service_spec="${service_spec:-${DEFAULT_SERVICES}}"
declare -a units=()

add_unit() {
  local unit="$1"
  local existing
  if [[ "${#units[@]}" -gt 0 ]]; then
    for existing in "${units[@]}"; do
      if [[ "${existing}" == "${unit}" ]]; then
        return 0
      fi
    done
  fi
  units+=("${unit}")
}

expand_service() {
  local service="$1"
  case "${service}" in
    api)
      add_unit "rallar-api-v1.service"
      ;;
    control)
      add_unit "rallar-black-box-control.service"
      ;;
    headless)
      add_unit "rallar-black-box-headless-worker.service"
      ;;
    browser)
      browser_filter=1
      add_unit "rallar-black-box-headless-worker.service"
      ;;
    caddy)
      add_unit "caddy.service"
      ;;
    app)
      expand_service api
      expand_service control
      ;;
    all)
      expand_service app
      expand_service headless
      expand_service caddy
      ;;
    "")
      ;;
    *)
      echo "Unknown service alias: ${service}" >&2
      usage >&2
      exit 2
      ;;
  esac
}

IFS=',' read -r -a service_entries <<<"${service_spec}"
for service_entry in "${service_entries[@]}"; do
  service_entry="${service_entry#"${service_entry%%[![:space:]]*}"}"
  service_entry="${service_entry%"${service_entry##*[![:space:]]}"}"
  expand_service "${service_entry}"
done

if [[ "${#units[@]}" -eq 0 ]]; then
  echo "No services selected." >&2
  exit 2
fi

join_by_comma() {
  local joined=""
  local value
  for value in "$@"; do
    if [[ -n "${joined}" ]]; then
      joined+=","
    fi
    joined+="${value}"
  done
  printf '%s' "${joined}"
}

if [[ "${RALLAR_LOGS_SELF_TEST:-0}" == "1" ]]; then
  echo "mode=dry-run"
  echo "units=$(join_by_comma "${units[@]}")"
  echo "lines=${lines}"
  echo "follow=${follow}"
  echo "pager=${pager}"
  echo "browser_filter=${browser_filter}"
  echo "color=${color}"
  echo "raw=${raw}"
  echo "since=${since}"
  echo "grep=${grep_pattern}"
  exit 0
fi

if ! command -v journalctl >/dev/null 2>&1; then
  echo "Missing required command: journalctl." >&2
  exit 1
fi

jq_available=0
if command -v jq >/dev/null 2>&1; then
  jq_available=1
fi

journal_args=(--no-pager)
if [[ "${raw}" == "1" || "${jq_available}" == "0" ]]; then
  journal_args+=(-o short-iso)
else
  journal_args+=(-o json)
fi
for unit in "${units[@]}"; do
  journal_args+=(-u "${unit}")
done
if [[ "${lines}" != "0" ]]; then
  journal_args+=(-n "${lines}")
fi
if [[ -n "${since}" ]]; then
  journal_args+=(--since "${since}")
fi
if [[ "${follow}" == "1" ]]; then
  journal_args+=(-f)
fi

redact_stream() {
  sed -E \
    -e 's/Bearer[[:space:]]+[A-Za-z0-9._~+\/=-]+/Bearer [REDACTED]/g' \
    -e 's/([?&]?(adminToken|controlToken|token|password|secret)=)[^&[:space:]]+/\1[REDACTED]/Ig' \
    -e 's/RALLAR_[A-Z0-9_]*(TOKEN|PASSWORD|SECRET)[A-Z0-9_]*=[^[:space:]]+/RALLAR_SECRET=[REDACTED]/g'
}

filter_text_stream() {
  if [[ -n "${grep_pattern}" ]]; then
    grep --line-buffered -F "${grep_pattern}" || true
  else
    cat
  fi
}

filter_browser_stream() {
  if [[ "${browser_filter}" == "1" ]]; then
    # Stable browser log topics: browser.console, browser.pageerror, browser.requestfailed.
    grep --line-buffered -E 'browser\.(console|pageerror|requestfailed)|console\.(warning|error)|pageerror' || true
  else
    cat
  fi
}

run_raw_stream() {
  journalctl "${journal_args[@]}" | redact_stream | filter_browser_stream | filter_text_stream
}

run_formatted_stream() {
  journalctl "${journal_args[@]}" | jq -r --unbuffered \
    --arg grep "${grep_pattern}" \
    --argjson browserFilter "${browser_filter}" \
    --argjson color "${color}" '
      def unit_label($unit):
        if $unit == "rallar-api-v1.service" then "api"
        elif $unit == "rallar-black-box-control.service" then "control"
        elif $unit == "rallar-black-box-headless-worker.service" then "headless"
        elif $unit == "caddy.service" then "caddy"
        else $unit
        end;

      def decorate($label):
        if $color == 1 then
          if $label == "api" then "\u001b[36m[\($label)]\u001b[0m"
          elif $label == "control" then "\u001b[35m[\($label)]\u001b[0m"
          elif $label == "headless" then "\u001b[32m[\($label)]\u001b[0m"
          elif $label == "browser" then "\u001b[33m[\($label)]\u001b[0m"
          elif $label == "caddy" then "\u001b[34m[\($label)]\u001b[0m"
          else "[\($label)]"
          end
        else "[\($label)]"
        end;

      def redact:
        gsub("Bearer[[:space:]]+[A-Za-z0-9._~+/=-]+"; "Bearer [REDACTED]")
        | gsub("([?&]?(adminToken|controlToken|token|password|secret)=)[^&[:space:]]+"; "token=[REDACTED]"; "i")
        | gsub("RALLAR_[A-Z0-9_]*(TOKEN|PASSWORD|SECRET)[A-Z0-9_]*=[^[:space:]]+"; "RALLAR_SECRET=[REDACTED]");

      (.__REALTIME_TIMESTAMP // "0" | tonumber? // 0 | . / 1000000 | strftime("%Y-%m-%dT%H:%M:%S%z")) as $ts
      | (._SYSTEMD_UNIT // .SYSLOG_IDENTIFIER // "journal") as $unit
      | (.MESSAGE // "") as $message
      | ($message | test("browser\\.(console|pageerror|requestfailed)|console\\.(warning|error)|pageerror"; "i")) as $isBrowser
      | select(($browserFilter == 0) or $isBrowser)
      | ($message | redact) as $redacted
      | select(($grep == "") or ($redacted | contains($grep)))
      | (if $isBrowser then "browser" else unit_label($unit) end) as $label
      | "\($ts) \(decorate($label)) \($redacted)"
    '
}

run_stream() {
  if [[ "${raw}" == "1" || "${jq_available}" == "0" ]]; then
    run_raw_stream
  else
    run_formatted_stream
  fi
}

less_available=0
if command -v less >/dev/null 2>&1; then
  less_available=1
fi

if [[ "${pager}" == "1" && -t 1 && -t 0 && "${less_available}" == "1" ]]; then
  if [[ "${follow}" == "1" ]]; then
    run_stream | less +F -R
  else
    run_stream | less -R
  fi
else
  run_stream
fi
