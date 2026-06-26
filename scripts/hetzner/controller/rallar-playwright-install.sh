#!/usr/bin/env bash

rallar_playwright_fail() {
  echo "$1" >&2
  return 1
}

rallar_playwright_run_with_heartbeat() {
  local label="$1"
  shift

  local interval="${RALLAR_LONG_COMMAND_HEARTBEAT_SECONDS:-30}"
  if ! [[ "${interval}" =~ ^[1-9][0-9]*$ ]]; then
    interval="30"
  fi

  "$@" &
  local pid=$!

  while kill -0 "${pid}" 2>/dev/null; do
    local elapsed=0
    while [[ "${elapsed}" -lt "${interval}" ]]; do
      sleep 1
      if ! kill -0 "${pid}" 2>/dev/null; then
        break 2
      fi
      elapsed=$((elapsed + 1))
    done
    echo "  ${label} still running at $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  done

  local status
  set +e
  wait "${pid}"
  status=$?
  set -e
  return "${status}"
}

rallar_playwright_user_home() {
  local user="$1"
  local home_dir=""

  if command -v getent >/dev/null 2>&1; then
    home_dir="$(getent passwd "${user}" | cut -d: -f6 || true)"
  fi
  if [[ -z "${home_dir}" ]]; then
    home_dir="$(eval "printf '%s' ~${user}" 2>/dev/null || true)"
  fi
  if [[ -z "${home_dir}" || "${home_dir}" == "~${user}" ]]; then
    rallar_playwright_fail "Could not resolve home directory for Playwright user: ${user}"
    return 1
  fi

  printf '%s' "${home_dir}"
}

rallar_playwright_cache_dir() {
  if [[ -n "${RALLAR_PLAYWRIGHT_CACHE_DIR:-}" ]]; then
    printf '%s' "${RALLAR_PLAYWRIGHT_CACHE_DIR}"
    return 0
  fi

  local user="${RALLAR_PLAYWRIGHT_USER:-rallar}"
  local home_dir
  home_dir="$(rallar_playwright_user_home "${user}")"
  printf '%s/.cache/ms-playwright' "${home_dir}"
}

rallar_playwright_lock_path() {
  local cache_dir
  cache_dir="$(rallar_playwright_cache_dir)"
  printf '%s/__dirlock' "${cache_dir}"
}

rallar_playwright_stat_mtime() {
  local path="$1"
  if stat -c %Y "${path}" >/dev/null 2>&1; then
    stat -c %Y "${path}"
    return 0
  fi
  stat -f %m "${path}"
}

rallar_playwright_lock_age_seconds() {
  local lock_path="$1"
  local modified now
  modified="$(rallar_playwright_stat_mtime "${lock_path}")"
  now="$(date +%s)"
  echo $((now - modified))
}

rallar_playwright_active_installer_exists() {
  local user="$1"
  local uid

  uid="$(id -u "${user}" 2>/dev/null)" || return 1
  if ! command -v pgrep >/dev/null 2>&1; then
    return 1
  fi

  pgrep -u "${uid}" -af '(playwright.*install|npm.*playwright|npm.*exec.*playwright|node.*playwright.*install)' >/dev/null 2>&1
}

rallar_playwright_remove_stale_lock_if_safe() {
  local user="${RALLAR_PLAYWRIGHT_USER:-rallar}"
  local lock_path stale_seconds wait_seconds age waited

  lock_path="$(rallar_playwright_lock_path)"
  stale_seconds="${RALLAR_PLAYWRIGHT_LOCK_STALE_SECONDS:-600}"
  wait_seconds="${RALLAR_PLAYWRIGHT_LOCK_WAIT_SECONDS:-60}"

  if ! [[ "${stale_seconds}" =~ ^[0-9]+$ ]]; then
    rallar_playwright_fail "RALLAR_PLAYWRIGHT_LOCK_STALE_SECONDS must be a non-negative integer. Received: ${stale_seconds}"
    return 1
  fi
  if ! [[ "${wait_seconds}" =~ ^[0-9]+$ ]]; then
    rallar_playwright_fail "RALLAR_PLAYWRIGHT_LOCK_WAIT_SECONDS must be a non-negative integer. Received: ${wait_seconds}"
    return 1
  fi

  if [[ ! -e "${lock_path}" ]]; then
    return 0
  fi

  if rallar_playwright_active_installer_exists "${user}"; then
    rallar_playwright_fail "Active Playwright installer detected for ${user}; refusing to remove ${lock_path}."
    return 1
  fi

  waited=0
  while [[ -e "${lock_path}" && "${waited}" -lt "${wait_seconds}" ]]; do
    age="$(rallar_playwright_lock_age_seconds "${lock_path}")"
    if [[ "${age}" -ge "${stale_seconds}" ]]; then
      break
    fi
    sleep 1
    waited=$((waited + 1))
  done

  if [[ ! -e "${lock_path}" ]]; then
    return 0
  fi

  if rallar_playwright_active_installer_exists "${user}"; then
    rallar_playwright_fail "Active Playwright installer detected for ${user}; refusing to remove ${lock_path}."
    return 1
  fi

  age="$(rallar_playwright_lock_age_seconds "${lock_path}")"
  if [[ "${age}" -lt "${stale_seconds}" ]]; then
    rallar_playwright_fail "Playwright lock is not stale yet: ${lock_path} age=${age}s staleAfter=${stale_seconds}s."
    return 1
  fi

  case "${lock_path}" in
    */ms-playwright/__dirlock) ;;
    *)
      rallar_playwright_fail "Refusing to remove unexpected Playwright lock path: ${lock_path}"
      return 1
      ;;
  esac

  rm -rf -- "${lock_path}"
  echo "removed stale Playwright lock: ${lock_path}"
}

install_rallar_playwright_chromium() {
  local checkout_dir="$1"
  local user="${RALLAR_PLAYWRIGHT_USER:-rallar}"

  echo "==> Installing Playwright Chromium system dependencies"
  rallar_playwright_run_with_heartbeat \
    "Playwright Chromium dependency install" \
    npm --prefix "${checkout_dir}" exec -- playwright install-deps chromium

  rallar_playwright_remove_stale_lock_if_safe

  echo "==> Installing Playwright Chromium for the ${user} user"
  rallar_playwright_run_with_heartbeat \
    "Playwright Chromium install for ${user}" \
    runuser -u "${user}" -- npm --prefix "${checkout_dir}" exec -- playwright install chromium
}

rallar_playwright_self_test() {
  case "${RALLAR_PLAYWRIGHT_INSTALL_SELF_TEST:-}" in
    lock-check)
      rallar_playwright_remove_stale_lock_if_safe
      ;;
    "")
      rallar_playwright_fail "Source this file from a controller script, or set RALLAR_PLAYWRIGHT_INSTALL_SELF_TEST."
      return 2
      ;;
    *)
      rallar_playwright_fail "Unknown RALLAR_PLAYWRIGHT_INSTALL_SELF_TEST: ${RALLAR_PLAYWRIGHT_INSTALL_SELF_TEST}"
      return 2
      ;;
  esac
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  set -Eeuo pipefail
  rallar_playwright_self_test
fi
