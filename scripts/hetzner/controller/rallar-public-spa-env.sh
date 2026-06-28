#!/usr/bin/env bash

RALLAR_BLACK_BOX_SPA_ENV_FILE="${RALLAR_BLACK_BOX_SPA_ENV_FILE:-/etc/rallar/black-box-spa.env}"

rallar_public_url_origin() {
  local url="${1:-}"
  local scheme rest host

  if [[ "${url}" != http://* && "${url}" != https://* ]]; then
    return 1
  fi

  scheme="${url%%://*}"
  rest="${url#*://}"
  host="${rest%%/*}"
  if [[ -z "${scheme}" || -z "${host}" ]]; then
    return 1
  fi

  printf '%s://%s' "${scheme}" "${host}"
}

rallar_public_control_health_url() {
  local url="${1:-}"
  local scheme rest host

  if [[ "${url}" != http://* && "${url}" != https://* && "${url}" != ws://* && "${url}" != wss://* ]]; then
    return 1
  fi

  scheme="${url%%://*}"
  rest="${url#*://}"
  host="${rest%%/*}"
  if [[ -z "${scheme}" || -z "${host}" ]]; then
    return 1
  fi

  case "${scheme}" in
    ws)
      scheme="http"
      ;;
    wss)
      scheme="https"
      ;;
  esac

  printf '%s://%s/health' "${scheme}" "${host}"
}

rallar_csv_append_unique() {
  local list="${1:-}"
  shift || true

  local value
  for value in "$@"; do
    if [[ -z "${value}" ]]; then
      continue
    fi
    if [[ -z "${list}" ]]; then
      list="${value}"
    elif [[ ",${list}," != *",${value},"* ]]; then
      list="${list},${value}"
    fi
  done

  printf '%s' "${list}"
}

apply_rallar_public_spa_defaults() {
  RALLAR_API_HOST="${RALLAR_API_HOST:-api.rallar.intactss.com}"
  RALLAR_CONTROL_HOST="${RALLAR_CONTROL_HOST:-control.rallar.intactss.com}"
  RALLAR_BLACKBOX_HOST="${RALLAR_BLACKBOX_HOST:-blackbox.rallar.intactss.com}"

  RALLAR_BLACK_BOX_SPA_URL="${RALLAR_BLACK_BOX_SPA_URL:-https://${RALLAR_BLACKBOX_HOST}}"
  RALLAR_BLACK_BOX_CONTROL_URL="${RALLAR_BLACK_BOX_CONTROL_URL:-wss://${RALLAR_CONTROL_HOST}/control}"
  RALLAR_API_BASE_URL="${RALLAR_API_BASE_URL:-https://${RALLAR_API_HOST}}"
  RALLAR_BLACK_BOX_ROOM_ID="${RALLAR_BLACK_BOX_ROOM_ID:-hetzner-headless-room}"
  RALLAR_BLACK_BOX_AGENT_PREFIX="${RALLAR_BLACK_BOX_AGENT_PREFIX:-controller}"
  RALLAR_BLACK_BOX_AGENT_COUNT="${RALLAR_BLACK_BOX_AGENT_COUNT:-1}"
  RALLAR_BLACK_BOX_APPLICATION_ID="${RALLAR_BLACK_BOX_APPLICATION_ID:-${RALLAR_APPLICATION_ID:-rallar-server}}"
  RALLAR_BLACK_BOX_WORKSPACE_ID="${RALLAR_BLACK_BOX_WORKSPACE_ID:-${RALLAR_WORKSPACE_ID:-default}}"
}

apply_rallar_public_cors_defaults() {
  apply_rallar_public_spa_defaults

  local spa_origin api_defaults control_defaults
  spa_origin="$(rallar_public_url_origin "${RALLAR_BLACK_BOX_SPA_URL}" || printf 'https://%s' "${RALLAR_BLACKBOX_HOST}")"
  api_defaults="$(rallar_csv_append_unique \
    "https://${RALLAR_BLACKBOX_HOST},https://ar-eye-hunter.pages.dev,https://relic-hunters-v1.intact-software-systems.workers.dev" \
    "${spa_origin}")"
  control_defaults="${spa_origin}"

  RALLAR_API_CORS_ORIGINS="$(rallar_csv_append_unique "${RALLAR_API_CORS_ORIGINS:-${api_defaults}}" "${spa_origin}")"
  RALLAR_BLACK_BOX_ALLOWED_ORIGINS="$(rallar_csv_append_unique "${RALLAR_BLACK_BOX_ALLOWED_ORIGINS:-${control_defaults}}" "${spa_origin}")"
}

verify_rallar_control_public_cors() {
  apply_rallar_public_cors_defaults

  local spa_origin health_url headers_file body_file http_code allow_origin
  spa_origin="$(rallar_public_url_origin "${RALLAR_BLACK_BOX_SPA_URL}" || printf 'https://%s' "${RALLAR_BLACKBOX_HOST}")"
  health_url="$(rallar_public_control_health_url "${RALLAR_BLACK_BOX_CONTROL_URL}" || printf 'https://%s/health' "${RALLAR_CONTROL_HOST}")"
  headers_file="$(mktemp)"
  body_file="$(mktemp)"

  echo "Checking public control CORS: ${health_url} from ${spa_origin}"
  http_code="$(
    curl -sS \
      -D "${headers_file}" \
      -o "${body_file}" \
      -w '%{http_code}' \
      -H "Origin: ${spa_origin}" \
      "${health_url}" || true
  )"

  allow_origin="$(
    awk '
      BEGIN { value = "" }
      tolower($1) == "access-control-allow-origin:" {
        $1 = ""
        sub(/^[[:space:]]+/, "")
        sub(/\r$/, "")
        value = $0
      }
      END { print value }
    ' "${headers_file}"
  )"

  if [[ "${http_code}" != 2* && "${http_code}" != 3* ]]; then
    echo "Public control health returned HTTP ${http_code}; this usually means Caddy cannot reach rallar-black-box-control." >&2
    echo "Response headers:" >&2
    sed 's/^/  /' "${headers_file}" >&2
    echo "Response body:" >&2
    sed 's/^/  /' "${body_file}" >&2
    rm -f "${headers_file}" "${body_file}"
    return 1
  fi

  if [[ "${allow_origin}" != "${spa_origin}" && "${allow_origin}" != "*" ]]; then
    echo "Public control CORS mismatch for ${health_url}." >&2
    echo "Expected Access-Control-Allow-Origin: ${spa_origin} or *" >&2
    echo "Actual Access-Control-Allow-Origin: ${allow_origin:-<missing>}" >&2
    echo "Configured RALLAR_BLACK_BOX_ALLOWED_ORIGINS=${RALLAR_BLACK_BOX_ALLOWED_ORIGINS}" >&2
    rm -f "${headers_file}" "${body_file}"
    return 1
  fi

  rm -f "${headers_file}" "${body_file}"
  echo "  ok: Access-Control-Allow-Origin=${allow_origin}"
}

write_rallar_controller_caddyfile() {
  apply_rallar_public_spa_defaults

  local caddyfile caddy_dir tmp_file spa_origin
  caddyfile="${RALLAR_CADDYFILE:-/etc/caddy/Caddyfile}"
  caddy_dir="${caddyfile%/*}"
  if [[ "${caddy_dir}" == "${caddyfile}" ]]; then
    caddy_dir="."
  fi
  spa_origin="$(rallar_public_url_origin "${RALLAR_BLACK_BOX_SPA_URL}" || printf 'https://%s' "${RALLAR_BLACKBOX_HOST}")"
  tmp_file="$(mktemp)"

  if [[ -n "${RALLAR_ACME_EMAIL:-}" ]]; then
    cat >"${tmp_file}" <<EOF
{
	email ${RALLAR_ACME_EMAIL}
}

${RALLAR_API_HOST} {
	reverse_proxy 127.0.0.1:8080
}

${RALLAR_CONTROL_HOST} {
	reverse_proxy 127.0.0.1:5180
	handle_errors {
		header Access-Control-Allow-Origin "${spa_origin}"
		header Access-Control-Allow-Methods "GET,POST,DELETE,OPTIONS"
		header Access-Control-Allow-Headers "Content-Type,Authorization,X-Rallar-Run-Token"
		header Vary "Origin"
		respond "Rallar Black Box control upstream unavailable" 502
	}
}

${RALLAR_BLACKBOX_HOST} {
	root * /var/www/rallar-black-box
	try_files {path} /index.html
	file_server
}
EOF
  else
    cat >"${tmp_file}" <<EOF
${RALLAR_API_HOST} {
	reverse_proxy 127.0.0.1:8080
}

${RALLAR_CONTROL_HOST} {
	reverse_proxy 127.0.0.1:5180
	handle_errors {
		header Access-Control-Allow-Origin "${spa_origin}"
		header Access-Control-Allow-Methods "GET,POST,DELETE,OPTIONS"
		header Access-Control-Allow-Headers "Content-Type,Authorization,X-Rallar-Run-Token"
		header Vary "Origin"
		respond "Rallar Black Box control upstream unavailable" 502
	}
}

${RALLAR_BLACKBOX_HOST} {
	root * /var/www/rallar-black-box
	try_files {path} /index.html
	file_server
}
EOF
  fi

  if ! caddy fmt --overwrite "${tmp_file}"; then
    rm -f "${tmp_file}"
    return 1
  fi
  if ! caddy validate --config "${tmp_file}" --adapter caddyfile; then
    rm -f "${tmp_file}"
    return 1
  fi

  install -d -m 0755 "${caddy_dir}"
  install -m 0644 "${tmp_file}" "${caddyfile}"
  rm -f "${tmp_file}"
}

build_rallar_black_box_spa() {
  local checkout_dir="$1"

  apply_rallar_public_spa_defaults
  runuser -u rallar -- env \
    VITE_RALLAR_PROVIDER=browser-rallar \
    VITE_RALLAR_API_BASE_URL="${RALLAR_API_BASE_URL}" \
    VITE_RALLAR_CONTROL_URL="${RALLAR_BLACK_BOX_CONTROL_URL}" \
    VITE_RALLAR_ROOM_ID="${RALLAR_BLACK_BOX_ROOM_ID}" \
    VITE_RALLAR_APPLICATION_ID="${RALLAR_BLACK_BOX_APPLICATION_ID}" \
    VITE_RALLAR_WORKSPACE_ID="${RALLAR_BLACK_BOX_WORKSPACE_ID}" \
    VITE_RALLAR_RUNNER_AGENT_PREFIX="${RALLAR_BLACK_BOX_AGENT_PREFIX}" \
    VITE_RALLAR_RUNNER_AGENT_COUNT="${RALLAR_BLACK_BOX_AGENT_COUNT}" \
    npm --prefix "${checkout_dir}" --workspace rallar-black-box run build

  runuser -u rallar -- env \
    VITE_RALLAR_PROVIDER=browser-rallar \
    VITE_RALLAR_API_BASE_URL="${RALLAR_API_BASE_URL}" \
    VITE_RALLAR_CONTROL_URL="${RALLAR_BLACK_BOX_CONTROL_URL}" \
    VITE_RALLAR_ROOM_ID="${RALLAR_BLACK_BOX_ROOM_ID}" \
    VITE_RALLAR_APPLICATION_ID="${RALLAR_BLACK_BOX_APPLICATION_ID}" \
    VITE_RALLAR_WORKSPACE_ID="${RALLAR_BLACK_BOX_WORKSPACE_ID}" \
    VITE_RALLAR_RUNNER_AGENT_PREFIX="${RALLAR_BLACK_BOX_AGENT_PREFIX}" \
    VITE_RALLAR_RUNNER_AGENT_COUNT="${RALLAR_BLACK_BOX_AGENT_COUNT}" \
    npm --prefix "${checkout_dir}" --workspace rallar-black-box-headless run build
}

write_rallar_black_box_spa_env_file() {
  apply_rallar_public_cors_defaults

  local env_file="${RALLAR_BLACK_BOX_SPA_ENV_FILE}"
  local tmp_env_file

  install -d -m 0700 -o root -g root "$(dirname "${env_file}")"
  tmp_env_file="$(mktemp "$(dirname "${env_file}")/.black-box-spa.env.XXXXXX")"
  chmod 0644 "${tmp_env_file}"
  {
    printf '# Written by scripts/hetzner/controller/rallar-public-spa-env.sh.\n'
    printf '# Public, non-secret values baked into the rallar-black-box SPA build.\n'
    printf 'RALLAR_BLACK_BOX_SPA_URL=%s\n' "${RALLAR_BLACK_BOX_SPA_URL}"
    printf 'RALLAR_BLACK_BOX_CONTROL_URL=%s\n' "${RALLAR_BLACK_BOX_CONTROL_URL}"
    printf 'RALLAR_API_BASE_URL=%s\n' "${RALLAR_API_BASE_URL}"
    printf 'RALLAR_API_CORS_ORIGINS=%s\n' "${RALLAR_API_CORS_ORIGINS}"
    printf 'RALLAR_BLACK_BOX_ALLOWED_ORIGINS=%s\n' "${RALLAR_BLACK_BOX_ALLOWED_ORIGINS}"
    printf 'RALLAR_BLACK_BOX_ROOM_ID=%s\n' "${RALLAR_BLACK_BOX_ROOM_ID}"
    printf 'RALLAR_BLACK_BOX_AGENT_PREFIX=%s\n' "${RALLAR_BLACK_BOX_AGENT_PREFIX}"
    printf 'RALLAR_BLACK_BOX_AGENT_COUNT=%s\n' "${RALLAR_BLACK_BOX_AGENT_COUNT}"
    printf 'VITE_RALLAR_PROVIDER=browser-rallar\n'
    printf 'VITE_RALLAR_API_BASE_URL=%s\n' "${RALLAR_API_BASE_URL}"
    printf 'VITE_RALLAR_CONTROL_URL=%s\n' "${RALLAR_BLACK_BOX_CONTROL_URL}"
    printf 'VITE_RALLAR_ROOM_ID=%s\n' "${RALLAR_BLACK_BOX_ROOM_ID}"
    printf 'VITE_RALLAR_APPLICATION_ID=%s\n' "${RALLAR_BLACK_BOX_APPLICATION_ID}"
    printf 'VITE_RALLAR_WORKSPACE_ID=%s\n' "${RALLAR_BLACK_BOX_WORKSPACE_ID}"
    printf 'VITE_RALLAR_RUNNER_AGENT_PREFIX=%s\n' "${RALLAR_BLACK_BOX_AGENT_PREFIX}"
    printf 'VITE_RALLAR_RUNNER_AGENT_COUNT=%s\n' "${RALLAR_BLACK_BOX_AGENT_COUNT}"
  } >"${tmp_env_file}"
  install -m 0644 -o root -g root "${tmp_env_file}" "${env_file}"
  rm -f "${tmp_env_file}"
}
