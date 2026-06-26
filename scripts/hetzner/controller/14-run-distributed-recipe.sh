#!/usr/bin/env bash
set -Eeuo pipefail

RALLAR_CONTROL_HTTP_URL="${RALLAR_CONTROL_HTTP_URL:-https://control.rallar.intactss.com}"
RALLAR_DISTRIBUTED_MANIFEST_PATH="${RALLAR_DISTRIBUTED_MANIFEST_PATH:-}"
RALLAR_DISTRIBUTED_ARTIFACT_DIR="${RALLAR_DISTRIBUTED_ARTIFACT_DIR:-/tmp/rallar-distributed-runs}"
RALLAR_DISTRIBUTED_TERMINAL_TIMEOUT_SECONDS="${RALLAR_DISTRIBUTED_TERMINAL_TIMEOUT_SECONDS:-300}"
RALLAR_DISTRIBUTED_READY_TIMEOUT_SECONDS="${RALLAR_DISTRIBUTED_READY_TIMEOUT_SECONDS:-120}"
RALLAR_DISTRIBUTED_RUN_ID="${RALLAR_DISTRIBUTED_RUN_ID:-}"
RALLAR_DISTRIBUTED_CONTROL_RUN_ID="${RALLAR_DISTRIBUTED_CONTROL_RUN_ID:-}"
RALLAR_CONTROL_ENV_FILE="${RALLAR_CONTROL_ENV_FILE:-/etc/rallar/control-server.env}"

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

read_env_value() {
  local env_file="$1"
  local key="$2"
  if [[ ! -r "${env_file}" ]]; then
    return 0
  fi
  grep -E "^${key}=" "${env_file}" | tail -n 1 | cut -d= -f2- || true
}

urlencode() {
  jq -nr --arg value "$1" '$value|@uri'
}

safe_artifact_dir_name() {
  local value="$1"
  local safe="${value//[^A-Za-z0-9_.-]/-}"
  while [[ "${safe}" == *--* ]]; do
    safe="${safe//--/-}"
  done
  safe="${safe#-}"
  safe="${safe%-}"
  if [[ -z "${safe}" ]]; then
    echo "Could not derive a safe artifact directory name from: ${value}" >&2
    return 1
  fi
  printf '%s' "${safe}"
}

safe_bundle_file_name() {
  local value="$1"
  case "${value}" in
    ""|*/*|*\\*|*..*|$'.'*|*$'\n'*|*$'\r'*) return 1 ;;
  esac
  if [[ "${value}" =~ ^[A-Za-z0-9_.-]+$ ]]; then
    printf '%s' "${value}"
    return 0
  fi
  return 1
}

control_url() {
  local path="$1"
  printf '%s/%s' "${RALLAR_CONTROL_HTTP_URL%/}" "${path#/}"
}

curl_args=()
admin_token="${RALLAR_BLACK_BOX_ADMIN_TOKEN:-$(read_env_value "${RALLAR_CONTROL_ENV_FILE}" "RALLAR_BLACK_BOX_ADMIN_TOKEN")}"
if [[ -n "${admin_token}" ]]; then
  curl_args=(-H "Authorization: Bearer ${admin_token}")
fi

control_get() {
  local path="$1"
  if ((${#curl_args[@]} > 0)); then
    curl -fsS "${curl_args[@]}" "$(control_url "${path}")"
  else
    curl -fsS "$(control_url "${path}")"
  fi
}

control_post() {
  local path="$1"
  local body="${2:-}"
  local response_file http_code curl_status
  local post_args
  response_file="$(mktemp /tmp/rallar-control-post.XXXXXX.json)"
  post_args=(-sS -o "${response_file}" -w "%{http_code}" -H "Content-Type: application/json" -X POST)
  if [[ -n "${body}" ]]; then
    post_args+=(--data-binary "${body}")
  fi

  set +e
  if ((${#curl_args[@]} > 0)); then
    http_code="$(curl "${curl_args[@]}" "${post_args[@]}" "$(control_url "${path}")")"
  else
    http_code="$(curl "${post_args[@]}" "$(control_url "${path}")")"
  fi
  curl_status=$?
  set -e

  if [[ -s "${response_file}" ]]; then
    cat "${response_file}"
  fi

  if [[ "${curl_status}" -ne 0 ]]; then
    echo "POST ${path} failed before receiving an HTTP response (curl exit ${curl_status})." >&2
    if [[ -s "${response_file}" ]]; then
      echo "Response body:" >&2
      cat "${response_file}" >&2
      echo >&2
    fi
    rm -f "${response_file}"
    return "${curl_status}"
  fi

  if [[ ! "${http_code}" =~ ^[0-9][0-9][0-9]$ ]]; then
    echo "POST ${path} returned an invalid HTTP status: ${http_code}" >&2
    rm -f "${response_file}"
    return 22
  fi

  if [[ "${http_code}" != 2* ]]; then
    echo "POST ${path} failed with HTTP ${http_code}." >&2
    if [[ -s "${response_file}" ]]; then
      echo "Response body:" >&2
      cat "${response_file}" >&2
      echo >&2
    fi
    rm -f "${response_file}"
    return 22
  fi

  rm -f "${response_file}"
}

terminal_state() {
  case "$1" in
    passed|failed|cancelled|timed-out) return 0 ;;
    *) return 1 ;;
  esac
}

wait_for_state() {
  local distributed_run_id="$1"
  local distributed_run_path_id="$2"
  local timeout_seconds="$3"
  local mode="$4"
  local snapshot state

  for _ in $(seq 1 "${timeout_seconds}"); do
    snapshot="$(control_get "/distributed-runs/${distributed_run_path_id}")"
    state="$(jq -r '.state // "unknown"' <<<"${snapshot}")"
    printf '%s\n' "${snapshot}" >"${run_artifact_dir}/distributed-run.json"

    if [[ "${mode}" == "ready" ]]; then
      if [[ "${state}" == "ready" || "${state}" == "running" ]] || terminal_state "${state}"; then
        echo "${state}"
        return 0
      fi
    else
      if terminal_state "${state}"; then
        echo "${state}"
        return 0
      fi
    fi
    sleep 1
  done

  echo "Timed out waiting for distributed run ${distributed_run_id} (${mode})." >&2
  return 1
}

write_bundle_files() {
  local bundle_file="$1"
  if [[ ! -s "${bundle_file}" ]]; then
    return 0
  fi
  jq -r '.files | keys[]' "${bundle_file}" | while IFS= read -r file_name; do
    if ! safe_name="$(safe_bundle_file_name "${file_name}")"; then
      echo "Skipping unsafe bundle file name: ${file_name}" >&2
      continue
    fi
    jq -r --arg fileName "${file_name}" '.files[$fileName]' "${bundle_file}" >"${run_artifact_dir}/${safe_name}"
  done
}

export_artifacts() {
  local distributed_run_id="$1"
  local control_run_id="$2"
  local distributed_run_path_id="$3"
  local control_run_path_id="$4"

  control_get "/distributed-runs/${distributed_run_path_id}" >"${run_artifact_dir}/distributed-run.json" || true
  control_get "/distributed-runs/${distributed_run_path_id}/artifacts" >"${run_artifact_dir}/distributed-artifact-bundle.json" || true
  write_bundle_files "${run_artifact_dir}/distributed-artifact-bundle.json"

  if [[ -n "${control_run_id}" ]]; then
    control_get "/runs/${control_run_path_id}/events.jsonl" >"${run_artifact_dir}/events.jsonl" || true
    control_get "/runs/${control_run_path_id}/results.jsonl" >"${run_artifact_dir}/results.jsonl" || true
    control_get "/runs/${control_run_path_id}/failure-bundle" >"${run_artifact_dir}/failures.json" || true
    control_get "/runs/${control_run_path_id}" >"${run_artifact_dir}/control-run.json" || true
  fi

  control_get "/fleet/reports/${distributed_run_path_id}" >"${run_artifact_dir}/fleet-report.json" || true
  control_get "/fleet/reports/${distributed_run_path_id}/artifacts" >"${run_artifact_dir}/fleet-report-artifact-bundle.json" || true
  if [[ -s "${run_artifact_dir}/fleet-report-artifact-bundle.json" ]]; then
    jq -r '.files["summary.md"] // empty' "${run_artifact_dir}/fleet-report-artifact-bundle.json" \
      >"${run_artifact_dir}/fleet-report-summary.md" || true
  fi
}

build_create_body() {
  local source_manifest_file="$1"
  jq -n -c --slurpfile manifest "${source_manifest_file}" '{manifest: $manifest[0]}'
}

run_self_test() {
  require_command jq

  case "${RALLAR_DISTRIBUTED_SCRIPT_SELF_TEST}" in
    create-body)
      if [[ -z "${RALLAR_DISTRIBUTED_MANIFEST_PATH}" ]]; then
        echo "Missing RALLAR_DISTRIBUTED_MANIFEST_PATH for create-body self-test." >&2
        return 1
      fi
      if [[ ! -r "${RALLAR_DISTRIBUTED_MANIFEST_PATH}" ]]; then
        echo "Distributed manifest not found: ${RALLAR_DISTRIBUTED_MANIFEST_PATH}" >&2
        return 1
      fi
      build_create_body "${RALLAR_DISTRIBUTED_MANIFEST_PATH}"
      return 0
      ;;
    post-failure)
      local output_file="${RALLAR_DISTRIBUTED_SELF_TEST_OUTPUT_FILE:-/tmp/rallar-control-post-self-test.json}"
      if control_post "/distributed-runs" '{"manifest":{}}' >"${output_file}"; then
        echo "Expected control_post to fail." >&2
        return 1
      fi
      printf 'saved_body=%s\n' "$(cat "${output_file}")"
      return 0
      ;;
  esac

  local encoded safe_artifact safe_bundle unsafe_bundle
  encoded="$(urlencode "run/with space")"
  safe_artifact="$(safe_artifact_dir_name "dist/run with space")"
  safe_bundle="$(safe_bundle_file_name "events.jsonl")"
  if safe_bundle_file_name "../secret.json" >/dev/null 2>&1; then
    unsafe_bundle="accepted"
  else
    unsafe_bundle="rejected"
  fi

  printf 'encoded=%s\n' "${encoded}"
  printf 'safe_artifact=%s\n' "${safe_artifact}"
  printf 'safe_bundle=%s\n' "${safe_bundle}"
  printf 'unsafe_bundle=%s\n' "${unsafe_bundle}"
}

if [[ "${RALLAR_DISTRIBUTED_SCRIPT_SELF_TEST:-0}" != "0" ]]; then
  run_self_test
  exit 0
fi

if [[ "$(id -u)" != "0" ]]; then
  echo "Run this script as root." >&2
  exit 1
fi

require_command curl
require_command jq

if [[ -z "${RALLAR_DISTRIBUTED_MANIFEST_PATH}" ]]; then
  echo "Missing RALLAR_DISTRIBUTED_MANIFEST_PATH." >&2
  exit 1
fi
if [[ ! -r "${RALLAR_DISTRIBUTED_MANIFEST_PATH}" ]]; then
  echo "Distributed manifest not found: ${RALLAR_DISTRIBUTED_MANIFEST_PATH}" >&2
  exit 1
fi

validate_positive_integer RALLAR_DISTRIBUTED_READY_TIMEOUT_SECONDS "${RALLAR_DISTRIBUTED_READY_TIMEOUT_SECONDS}"
validate_positive_integer RALLAR_DISTRIBUTED_TERMINAL_TIMEOUT_SECONDS "${RALLAR_DISTRIBUTED_TERMINAL_TIMEOUT_SECONDS}"

manifest_file="$(mktemp /tmp/rallar-distributed-manifest.XXXXXX.json)"
trap 'rm -f "${manifest_file}"' EXIT
if [[ -n "${RALLAR_DISTRIBUTED_RUN_ID}" ]]; then
  jq \
    --arg runId "${RALLAR_DISTRIBUTED_RUN_ID}" \
    --arg controlRunId "${RALLAR_DISTRIBUTED_CONTROL_RUN_ID}" \
    '.distributedRunId = $runId | .controlRunId = (if $controlRunId == "" then (.controlRunId // $runId) else $controlRunId end)' \
    "${RALLAR_DISTRIBUTED_MANIFEST_PATH}" >"${manifest_file}"
else
  jq \
    --arg controlRunId "${RALLAR_DISTRIBUTED_CONTROL_RUN_ID}" \
    '.controlRunId = (if $controlRunId == "" then (.controlRunId // .distributedRunId) else $controlRunId end)' \
    "${RALLAR_DISTRIBUTED_MANIFEST_PATH}" >"${manifest_file}"
fi

distributed_run_id="$(jq -r '.distributedRunId // empty' "${manifest_file}")"
control_run_id="$(jq -r '.controlRunId // .distributedRunId // empty' "${manifest_file}")"
if [[ -z "${distributed_run_id}" ]]; then
  echo "Distributed manifest must contain distributedRunId, or set RALLAR_DISTRIBUTED_RUN_ID." >&2
  exit 1
fi

distributed_run_path_id="$(urlencode "${distributed_run_id}")"
control_run_path_id="$(urlencode "${control_run_id}")"
run_artifact_name="$(safe_artifact_dir_name "${distributed_run_id}")"
run_artifact_dir="${RALLAR_DISTRIBUTED_ARTIFACT_DIR%/}/${run_artifact_name}"
mkdir -p "${run_artifact_dir}"
cp "${manifest_file}" "${run_artifact_dir}/manifest.json"

echo "==> Creating distributed run ${distributed_run_id}"
create_body="$(build_create_body "${manifest_file}")"
control_post "/distributed-runs" "${create_body}" >"${run_artifact_dir}/distributed-run.json"

echo "==> Staging distributed run ${distributed_run_id}"
control_post "/distributed-runs/${distributed_run_path_id}/stage" "{}" >"${run_artifact_dir}/distributed-run.json"

if ! ready_state="$(wait_for_state "${distributed_run_id}" "${distributed_run_path_id}" "${RALLAR_DISTRIBUTED_READY_TIMEOUT_SECONDS}" ready)"; then
  ready_state="timed-out"
fi
echo "Ready state: ${ready_state}"

if terminal_state "${ready_state}"; then
  final_state="${ready_state}"
else
  echo "==> Starting distributed run ${distributed_run_id}"
  control_post "/distributed-runs/${distributed_run_path_id}/start" "{}" >"${run_artifact_dir}/distributed-run.json"
  if ! final_state="$(wait_for_state "${distributed_run_id}" "${distributed_run_path_id}" "${RALLAR_DISTRIBUTED_TERMINAL_TIMEOUT_SECONDS}" terminal)"; then
    final_state="timed-out"
  fi
fi

echo "Final state: ${final_state}"
export_artifacts "${distributed_run_id}" "${control_run_id}" "${distributed_run_path_id}" "${control_run_path_id}"

jq -n \
  --arg distributedRunId "${distributed_run_id}" \
  --arg controlRunId "${control_run_id}" \
  --arg state "${final_state}" \
  --arg artifactDir "${run_artifact_dir}" \
  '{
    distributedRunId: $distributedRunId,
    controlRunId: $controlRunId,
    state: $state,
    ok: ($state == "passed"),
    artifactDir: $artifactDir
  }' >"${run_artifact_dir}/runner-summary.json"

echo "Artifacts: ${run_artifact_dir}"
if [[ "${final_state}" != "passed" ]]; then
  exit 1
fi
