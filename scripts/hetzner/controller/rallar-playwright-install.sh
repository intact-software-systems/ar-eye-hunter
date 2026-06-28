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

rallar_playwright_run_user_command_in_checkout() {
  local user="$1"
  local checkout_dir="$2"
  shift 2

  local home_dir
  home_dir="$(rallar_playwright_user_home "${user}")"

  (
    cd -- "${checkout_dir}"
    runuser -u "${user}" -- env HOME="${home_dir}" "$@"
  )
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

rallar_playwright_bool_enabled() {
  case "${1:-}" in
    true | TRUE | yes | YES | on | ON | 1) return 0 ;;
    false | FALSE | no | NO | off | OFF | 0 | "") return 1 ;;
    *) return 1 ;;
  esac
}

rallar_playwright_active_installer_stale_seconds() {
  local stale_seconds="${RALLAR_PLAYWRIGHT_ACTIVE_INSTALLER_STALE_SECONDS:-${RALLAR_PLAYWRIGHT_LOCK_STALE_SECONDS:-600}}"
  if ! [[ "${stale_seconds}" =~ ^[0-9]+$ ]]; then
    rallar_playwright_fail "RALLAR_PLAYWRIGHT_ACTIVE_INSTALLER_STALE_SECONDS must be a non-negative integer. Received: ${stale_seconds}"
    return 1
  fi
  printf '%s' "${stale_seconds}"
}

rallar_playwright_process_list() {
  local user="$1"
  local uid

  if [[ -n "${RALLAR_PLAYWRIGHT_PROCESS_LIST_FILE:-}" ]]; then
    cat "${RALLAR_PLAYWRIGHT_PROCESS_LIST_FILE}"
    return 0
  fi

  uid="$(id -u "${user}" 2>/dev/null)" || return 1
  ps -u "${uid}" -o pid=,etimes=,args= 2>/dev/null || true
}

rallar_playwright_is_installer_command() {
  local args="$1"

  [[ "${args}" == *"install-deps"* ]] && return 1

  case "${args}" in
    *"playwright install"* | *"playwright/cli"*".js install"* | *"playwright-core/cli"*".js install"*)
      return 0
      ;;
    *)
      return 1
      ;;
  esac
}

rallar_playwright_installer_processes() {
  local user="$1"
  local line pid age args

  while IFS= read -r line; do
    [[ -z "${line}" ]] && continue
    read -r pid age args <<<"${line}"
    [[ "${pid}" =~ ^[0-9]+$ ]] || continue
    [[ "${age}" =~ ^[0-9]+$ ]] || continue
    [[ "${pid}" == "$$" || "${pid}" == "${BASHPID:-}" ]] && continue

    if rallar_playwright_is_installer_command "${args}"; then
      printf '%s\t%s\t%s\n' "${pid}" "${age}" "${args}"
    fi
  done < <(rallar_playwright_process_list "${user}")
}

rallar_playwright_active_installer_exists() {
  local user="$1"
  local processes

  processes="$(rallar_playwright_installer_processes "${user}")"
  [[ -n "${processes}" ]]
}

rallar_playwright_terminate_stale_installer() {
  local pid="$1"
  local age="$2"
  local args="$3"
  local wait_seconds="${RALLAR_PLAYWRIGHT_STALE_INSTALLER_TERM_WAIT_SECONDS:-15}"
  local waited=0
  local kill_waited=0

  if ! [[ "${wait_seconds}" =~ ^[0-9]+$ ]]; then
    rallar_playwright_fail "RALLAR_PLAYWRIGHT_STALE_INSTALLER_TERM_WAIT_SECONDS must be a non-negative integer. Received: ${wait_seconds}"
    return 1
  fi

  echo "Terminating stale Playwright installer: pid=${pid} age=${age}s command=${args}"

  if [[ -n "${RALLAR_PLAYWRIGHT_PROCESS_LIST_FILE:-}" ]]; then
    return 0
  fi

  if ! kill "${pid}" 2>/dev/null; then
    if kill -0 "${pid}" 2>/dev/null; then
      rallar_playwright_fail "Could not signal stale Playwright installer: pid=${pid}"
      return 1
    fi
    return 0
  fi

  while kill -0 "${pid}" 2>/dev/null && [[ "${waited}" -lt "${wait_seconds}" ]]; do
    sleep 1
    waited=$((waited + 1))
  done

  if kill -0 "${pid}" 2>/dev/null; then
    echo "Stale Playwright installer did not stop after ${wait_seconds}s; sending SIGKILL: pid=${pid}"
    kill -KILL "${pid}" 2>/dev/null || true
    while kill -0 "${pid}" 2>/dev/null && [[ "${kill_waited}" -lt 5 ]]; do
      sleep 1
      kill_waited=$((kill_waited + 1))
    done
    if kill -0 "${pid}" 2>/dev/null; then
      rallar_playwright_fail "Stale Playwright installer is still running after SIGKILL: pid=${pid}"
      return 1
    fi
  fi
}

rallar_playwright_handle_active_installers() {
  local user="$1"
  local stale_seconds
  local processes pid age args

  stale_seconds="$(rallar_playwright_active_installer_stale_seconds)"
  processes="$(rallar_playwright_installer_processes "${user}")"
  [[ -z "${processes}" ]] && return 0

  while IFS=$'\t' read -r pid age args; do
    [[ -z "${pid}" ]] && continue
    if [[ "${age}" -lt "${stale_seconds}" ]]; then
      rallar_playwright_fail "Active Playwright installer detected for ${user}: pid=${pid} age=${age}s staleAfter=${stale_seconds}s; refusing to remove Playwright lock."
      return 1
    fi

    if ! rallar_playwright_bool_enabled "${RALLAR_PLAYWRIGHT_TERMINATE_STALE_INSTALLER:-true}"; then
      rallar_playwright_fail "Stale Playwright installer detected for ${user}: pid=${pid} age=${age}s staleAfter=${stale_seconds}s; termination disabled."
      return 1
    fi

    rallar_playwright_terminate_stale_installer "${pid}" "${age}" "${args}" || return 1
  done <<<"${processes}"
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

  rallar_playwright_handle_active_installers "${user}" || return 1

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

  rallar_playwright_handle_active_installers "${user}" || return 1

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

rallar_playwright_normalize_browser() {
  case "${1:-chromium}" in
    chromium | firefox | webkit)
      printf '%s' "$1"
      ;;
    *)
      rallar_playwright_fail "Playwright browser must be chromium, firefox, or webkit. Received: ${1:-}"
      return 1
      ;;
  esac
}

install_rallar_playwright_browser() {
  local checkout_dir="$1"
  local user="${RALLAR_PLAYWRIGHT_USER:-rallar}"
  local browser_name
  browser_name="$(rallar_playwright_normalize_browser "${2:-chromium}")"

  echo "==> Installing Playwright ${browser_name} system dependencies"
  rallar_playwright_run_with_heartbeat \
    "Playwright ${browser_name} dependency install" \
    npm --prefix "${checkout_dir}" exec -- playwright install-deps "${browser_name}"

  rallar_playwright_remove_stale_lock_if_safe

  echo "==> Installing Playwright ${browser_name} for the ${user} user"
  rallar_playwright_run_with_heartbeat \
    "Playwright ${browser_name} install for ${user}" \
    rallar_playwright_run_user_command_in_checkout \
      "${user}" \
      "${checkout_dir}" \
      npm --prefix "${checkout_dir}" exec -- playwright install "${browser_name}"
}

install_rallar_playwright_chromium() {
  install_rallar_playwright_browser "$1" chromium
}

rallar_playwright_self_test() {
  case "${RALLAR_PLAYWRIGHT_INSTALL_SELF_TEST:-}" in
    install-command)
      if [[ -z "${RALLAR_PLAYWRIGHT_SELF_TEST_CHECKOUT_DIR:-}" ]]; then
        rallar_playwright_fail "RALLAR_PLAYWRIGHT_SELF_TEST_CHECKOUT_DIR is required for install-command self-test."
        return 2
      fi
      install_rallar_playwright_chromium "${RALLAR_PLAYWRIGHT_SELF_TEST_CHECKOUT_DIR}"
      echo "selfTestInstall=ok"
      ;;
    lock-check)
      rallar_playwright_remove_stale_lock_if_safe
      ;;
    process-check)
      local user="${RALLAR_PLAYWRIGHT_USER:-rallar}"
      local stale_seconds processes pid age args active="false"
      stale_seconds="$(rallar_playwright_active_installer_stale_seconds)"
      processes="$(rallar_playwright_installer_processes "${user}")"
      if [[ -n "${processes}" ]]; then
        active="true"
      fi
      echo "activeInstaller=${active}"
      while IFS=$'\t' read -r pid age args; do
        [[ -z "${pid}" ]] && continue
        if [[ "${age}" -ge "${stale_seconds}" ]]; then
          echo "staleInstaller=${pid}"
        fi
      done <<<"${processes}"
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
