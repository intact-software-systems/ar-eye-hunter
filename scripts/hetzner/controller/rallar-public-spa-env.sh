#!/usr/bin/env bash

RALLAR_BLACK_BOX_SPA_ENV_FILE="${RALLAR_BLACK_BOX_SPA_ENV_FILE:-/etc/rallar/black-box-spa.env}"

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
}

write_rallar_black_box_spa_env_file() {
  apply_rallar_public_spa_defaults

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
