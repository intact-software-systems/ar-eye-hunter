#!/usr/bin/env bash
set -Eeuo pipefail

WORKFLOW_NAME="hetzner-distributed-recipe.yml"
REF="main"
ROLLOUT_BEFORE_RUN="true"
INSTALL_PLAYWRIGHT="true"
NPM_CI="false"
WAIT_FOR_AGENTS="true"
READY_TIMEOUT_SECONDS="120"
TERMINAL_TIMEOUT_SECONDS="300"
FAST_MODE="0"
ALLOW_DIAGNOSTIC="0"
RUN_ID=""
MANIFEST_INPUT=""
SECRET_ENVIRONMENT="production"
REQUIRED_GITHUB_SECRETS=(
  HETZNER_HOST
  HETZNER_USER
  HETZNER_SSH_PRIVATE_KEY
  HETZNER_KNOWN_HOSTS
  RALLAR_BLACK_BOX_USERNAME
  RALLAR_BLACK_BOX_PASSWORD
)

usage() {
  cat <<'USAGE'
Usage: scripts/hetzner/dispatch-distributed-recipe.sh <manifest.json> [options]

Options:
  --ref <ref>                    Git ref to dispatch. Default: main.
  --run-id <id>                  Control run id. Default: manifest slug + UTC timestamp.
  --workflow <name>              Workflow file name. Default: hetzner-distributed-recipe.yml.
  --rollout-before-run <bool>    Pass rollout_before_run. Default: true.
  --install-playwright <bool>    Pass install_playwright. Default: true.
  --npm-ci <bool>                Pass npm_ci. Default: false.
  --wait-for-agents <bool>       Pass wait_for_agents. Default: true.
  --ready-timeout-seconds <n>    Pass ready_timeout_seconds. Default: 120.
  --terminal-timeout-seconds <n> Pass terminal_timeout_seconds. Default: 300.
  --fast                         Skip rollout, Playwright install, and npm ci with shorter timeouts.
  --allow-diagnostic            Allow manifests marked as diagnostic.
  -h, --help                    Show this help.
USAGE
}

fail() {
  echo "$1" >&2
  exit 1
}

require_command() {
  if ! command -v "$1" >/dev/null 2>&1; then
    fail "Missing required command: $1"
  fi
}

sanitize_run_id() {
  local value="$1"
  local safe
  safe="$(printf '%s' "${value}" | tr -c 'A-Za-z0-9_.-' '-' | sed -E 's/-+/-/g; s/^-|-$//g')"
  if [[ -z "${safe}" ]]; then
    fail "Could not derive a safe run id from: ${value}"
  fi
  printf '%s' "${safe}"
}

normalize_bool() {
  local key="$1"
  local value="$2"
  case "${value}" in
    true|1|yes|on)
      printf 'true'
      ;;
    false|0|no|off)
      printf 'false'
      ;;
    *)
      fail "${key} must be a boolean: true, false, 1, 0, yes, no, on, or off. Received: ${value}"
      ;;
  esac
}

validate_positive_integer() {
  local key="$1"
  local value="$2"
  if ! [[ "${value}" =~ ^[1-9][0-9]*$ ]]; then
    fail "${key} must be a positive integer. Received: ${value}"
  fi
}

github_secret_names() {
  {
    gh secret list
    gh secret list --env "${SECRET_ENVIRONMENT}" 2>/dev/null || true
  } | awk '{print $1}' | sort -u
}

require_github_secrets() {
  local available_names secret
  local missing=()

  available_names="$(github_secret_names)"
  for secret in "${REQUIRED_GITHUB_SECRETS[@]}"; do
    if ! grep -qx "${secret}" <<<"${available_names}"; then
      missing+=("${secret}")
    fi
  done

  if ((${#missing[@]} > 0)); then
    local joined
    printf -v joined '%s, ' "${missing[@]}"
    joined="${joined%, }"
    fail "Missing required GitHub secret(s): ${joined}. Set them as repository secrets or ${SECRET_ENVIRONMENT} environment secrets before dispatching ${WORKFLOW_NAME}."
  fi
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --ref)
      [[ $# -ge 2 ]] || fail "--ref requires a value."
      REF="$2"
      shift 2
      ;;
    --run-id)
      [[ $# -ge 2 ]] || fail "--run-id requires a value."
      RUN_ID="$2"
      shift 2
      ;;
    --workflow)
      [[ $# -ge 2 ]] || fail "--workflow requires a value."
      WORKFLOW_NAME="$2"
      shift 2
      ;;
    --rollout-before-run)
      [[ $# -ge 2 ]] || fail "--rollout-before-run requires a value."
      ROLLOUT_BEFORE_RUN="$2"
      shift 2
      ;;
    --install-playwright)
      [[ $# -ge 2 ]] || fail "--install-playwright requires a value."
      INSTALL_PLAYWRIGHT="$2"
      shift 2
      ;;
    --npm-ci)
      [[ $# -ge 2 ]] || fail "--npm-ci requires a value."
      NPM_CI="$2"
      shift 2
      ;;
    --wait-for-agents)
      [[ $# -ge 2 ]] || fail "--wait-for-agents requires a value."
      WAIT_FOR_AGENTS="$2"
      shift 2
      ;;
    --ready-timeout-seconds)
      [[ $# -ge 2 ]] || fail "--ready-timeout-seconds requires a value."
      READY_TIMEOUT_SECONDS="$2"
      shift 2
      ;;
    --terminal-timeout-seconds)
      [[ $# -ge 2 ]] || fail "--terminal-timeout-seconds requires a value."
      TERMINAL_TIMEOUT_SECONDS="$2"
      shift 2
      ;;
    --fast)
      FAST_MODE="1"
      ROLLOUT_BEFORE_RUN="false"
      INSTALL_PLAYWRIGHT="false"
      NPM_CI="false"
      WAIT_FOR_AGENTS="true"
      READY_TIMEOUT_SECONDS="60"
      TERMINAL_TIMEOUT_SECONDS="180"
      shift
      ;;
    --allow-diagnostic)
      ALLOW_DIAGNOSTIC="1"
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    -*)
      fail "Unknown option: $1"
      ;;
    *)
      if [[ -n "${MANIFEST_INPUT}" ]]; then
        fail "Only one manifest path can be supplied."
      fi
      MANIFEST_INPUT="$1"
      shift
      ;;
  esac
done

ROLLOUT_BEFORE_RUN="$(normalize_bool rollout_before_run "${ROLLOUT_BEFORE_RUN}")"
INSTALL_PLAYWRIGHT="$(normalize_bool install_playwright "${INSTALL_PLAYWRIGHT}")"
NPM_CI="$(normalize_bool npm_ci "${NPM_CI}")"
WAIT_FOR_AGENTS="$(normalize_bool wait_for_agents "${WAIT_FOR_AGENTS}")"
validate_positive_integer ready_timeout_seconds "${READY_TIMEOUT_SECONDS}"
validate_positive_integer terminal_timeout_seconds "${TERMINAL_TIMEOUT_SECONDS}"

[[ -n "${MANIFEST_INPUT}" ]] || {
  usage >&2
  exit 1
}

require_command git
require_command jq

repo_root="$(git rev-parse --show-toplevel)"

if [[ -r "${MANIFEST_INPUT}" ]]; then
  manifest_absolute="$(cd "$(dirname "${MANIFEST_INPUT}")" && pwd -P)/$(basename "${MANIFEST_INPUT}")"
elif [[ -r "${repo_root}/${MANIFEST_INPUT}" ]]; then
  manifest_absolute="$(cd "$(dirname "${repo_root}/${MANIFEST_INPUT}")" && pwd -P)/$(basename "${MANIFEST_INPUT}")"
else
  fail "Manifest path does not exist: ${MANIFEST_INPUT}"
fi

case "${manifest_absolute}" in
  "${repo_root}"/*) manifest_path="${manifest_absolute#"${repo_root}/"}" ;;
  *) fail "Manifest must be inside the current git repository: ${MANIFEST_INPUT}" ;;
esac

agent_count="$(jq -r '.targetPolicy.expectedParticipantCount // empty' "${manifest_absolute}")"
if ! [[ "${agent_count}" =~ ^[1-9][0-9]*$ ]]; then
  fail "Manifest targetPolicy.expectedParticipantCount must be a positive integer: ${manifest_path}"
fi

room_id="$(jq -r '.group.groupId // empty' "${manifest_absolute}")"
application_id="$(jq -r '.group.applicationId // empty' "${manifest_absolute}")"
workspace_id="$(jq -r '.group.workspaceId // empty' "${manifest_absolute}")"
[[ -n "${room_id}" ]] || fail "Manifest group.groupId is required: ${manifest_path}"
[[ -n "${application_id}" ]] || fail "Manifest group.applicationId is required: ${manifest_path}"
[[ -n "${workspace_id}" ]] || fail "Manifest group.workspaceId is required: ${manifest_path}"

diagnostic="$(jq -r '((.metadata.diagnostic == true) or (.metadata.expectedFailure == true)) | tostring' "${manifest_absolute}")"
if [[ "${manifest_path}" == */diagnostic/* || "${diagnostic}" == "true" ]]; then
  if [[ "${ALLOW_DIAGNOSTIC}" != "1" ]]; then
    fail "Refusing to dispatch diagnostic manifest without --allow-diagnostic: ${manifest_path}"
  fi
fi

require_command gh
require_github_secrets

if [[ -z "${RUN_ID}" ]]; then
  manifest_slug="$(basename "${manifest_path}" .json)"
  RUN_ID="${manifest_slug}-$(date -u +%Y%m%dT%H%M%SZ)"
fi
safe_run_id="$(sanitize_run_id "${RUN_ID}")"

mode="custom"
if [[ "${ROLLOUT_BEFORE_RUN}" == "true" ]]; then
  mode="rollout"
elif [[ "${FAST_MODE}" == "1" &&
  "${INSTALL_PLAYWRIGHT}" == "false" &&
  "${NPM_CI}" == "false" &&
  "${WAIT_FOR_AGENTS}" == "true" &&
  "${READY_TIMEOUT_SECONDS}" == "60" &&
  "${TERMINAL_TIMEOUT_SECONDS}" == "180" ]]; then
  mode="fast"
fi

echo "Dispatching ${WORKFLOW_NAME}"
echo "Manifest : ${manifest_path}"
echo "Ref      : ${REF}"
echo "Mode     : ${mode}"
echo "Run ID   : ${safe_run_id}"
echo "Agents   : ${agent_count}"
echo "Room     : ${room_id}"

gh workflow run "${WORKFLOW_NAME}" \
  --ref "${REF}" \
  -f "manifest_path=${manifest_path}" \
  -f "agent_count=${agent_count}" \
  -f "room_id=${room_id}" \
  -f "application_id=${application_id}" \
  -f "workspace_id=${workspace_id}" \
  -f "rollout_before_run=${ROLLOUT_BEFORE_RUN}" \
  -f "install_playwright=${INSTALL_PLAYWRIGHT}" \
  -f "npm_ci=${NPM_CI}" \
  -f "wait_for_agents=${WAIT_FOR_AGENTS}" \
  -f "ready_timeout_seconds=${READY_TIMEOUT_SECONDS}" \
  -f "terminal_timeout_seconds=${TERMINAL_TIMEOUT_SECONDS}" \
  -f "ref=${REF}" \
  -f "run_id=${safe_run_id}"

echo "Dispatched ${WORKFLOW_NAME}"
