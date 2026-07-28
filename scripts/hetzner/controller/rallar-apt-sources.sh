#!/usr/bin/env bash

rallar_apt_fail() {
  echo "$1" >&2
  return 1
}

rallar_apt_require_source() {
  local source_path="$1"
  if [[ ! -r "${source_path}" ]]; then
    rallar_apt_fail "Required apt source file is missing: ${source_path}"
    return 1
  fi
}

rallar_apt_link_source() {
  local source_path="$1"
  local source_parts_dir="$2"
  rallar_apt_require_source "${source_path}" || return 1
  ln -s "${source_path}" "${source_parts_dir}/$(basename "${source_path}")"
}

write_rallar_apt_profile() {
  local profile="$1"
  local config_path="$2"
  local source_parts_dir="${config_path}.d"
  local ubuntu_source="${RALLAR_APT_UBUNTU_SOURCES_FILE:-/etc/apt/sources.list.d/ubuntu.sources}"
  local nodesource_file="${RALLAR_APT_NODESOURCE_FILE:-/etc/apt/sources.list.d/nodesource.list}"
  local caddy_source="${RALLAR_APT_CADDY_SOURCE_FILE:-/etc/apt/sources.list.d/caddy-stable.list}"

  rm -rf -- "${source_parts_dir}"
  mkdir -p -- "${source_parts_dir}"
  rallar_apt_link_source "${ubuntu_source}" "${source_parts_dir}"

  case "${profile}" in
    ubuntu) ;;
    nodesource)
      rallar_apt_link_source "${nodesource_file}" "${source_parts_dir}"
      ;;
    caddy)
      rallar_apt_link_source "${caddy_source}" "${source_parts_dir}"
      ;;
    *)
      rallar_apt_fail "Unknown apt repository profile: ${profile}"
      return 1
      ;;
  esac

  cat >"${config_path}" <<EOF_APT
Dir::Etc::sourcelist "-";
Dir::Etc::sourceparts "${source_parts_dir}";
Acquire::Retries "3";
Acquire::http::Timeout "30";
Acquire::https::Timeout "30";
EOF_APT
}

rallar_apt_sources_self_test() {
  local output_dir="${RALLAR_APT_PROFILE_OUTPUT_DIR:?RALLAR_APT_PROFILE_OUTPUT_DIR is required}"

  case "${RALLAR_APT_SOURCES_SELF_TEST:-}" in
    profiles)
      write_rallar_apt_profile ubuntu "${output_dir}/ubuntu.conf"
      write_rallar_apt_profile nodesource "${output_dir}/nodesource.conf"
      write_rallar_apt_profile caddy "${output_dir}/caddy.conf"
      echo "aptProfiles=valid"
      ;;
    *)
      rallar_apt_fail "Unknown RALLAR_APT_SOURCES_SELF_TEST: ${RALLAR_APT_SOURCES_SELF_TEST:-}"
      return 2
      ;;
  esac
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  set -Eeuo pipefail
  rallar_apt_sources_self_test
fi
