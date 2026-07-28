#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
RALLAR_MIN_DENO_VERSION="${RALLAR_MIN_DENO_VERSION:-2.9.0}"
source "${SCRIPT_DIR}/rallar-deno-runtime.sh"
source "${SCRIPT_DIR}/rallar-apt-sources.sh"

RALLAR_APT_PROFILE_DIR="$(mktemp -d "${TMPDIR:-/tmp}/rallar-apt-profiles.XXXXXX")"
trap 'rm -rf -- "${RALLAR_APT_PROFILE_DIR}"' EXIT
ubuntu_apt_config="${RALLAR_APT_PROFILE_DIR}/ubuntu.conf"
nodesource_apt_config="${RALLAR_APT_PROFILE_DIR}/nodesource.conf"
caddy_apt_config="${RALLAR_APT_PROFILE_DIR}/caddy.conf"

if [[ "$(id -u)" != "0" ]]; then
  echo "Run this script as root." >&2
  exit 1
fi

export DEBIAN_FRONTEND=noninteractive

if [[ -r /etc/os-release ]]; then
  # shellcheck disable=SC1091
  source /etc/os-release
  if [[ "${ID:-}" != "ubuntu" || "${VERSION_ID:-}" != "24.04" ]]; then
    echo "Warning: expected Ubuntu 24.04, got ${PRETTY_NAME:-unknown}." >&2
  fi
fi

echo "==> Updating base system"
write_rallar_apt_profile ubuntu "${ubuntu_apt_config}"
env APT_CONFIG="${ubuntu_apt_config}" apt update
env APT_CONFIG="${ubuntu_apt_config}" apt upgrade -y
env APT_CONFIG="${ubuntu_apt_config}" apt install -y \
  apt-transport-https \
  build-essential \
  ca-certificates \
  curl \
  debian-archive-keyring \
  debian-keyring \
  git \
  gnupg \
  jq \
  lsb-release \
  openssl \
  rsync \
  unzip

echo "==> Installing Node.js 24.x from NodeSource"
curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key \
  | gpg --dearmor --yes -o /usr/share/keyrings/nodesource.gpg
printf 'deb [arch=%s signed-by=/usr/share/keyrings/nodesource.gpg] https://deb.nodesource.com/node_24.x nodistro main\n' \
  "$(dpkg --print-architecture)" \
  >/etc/apt/sources.list.d/nodesource.list
write_rallar_apt_profile nodesource "${nodesource_apt_config}"
env APT_CONFIG="${nodesource_apt_config}" apt update
env APT_CONFIG="${nodesource_apt_config}" apt install -y nodejs

echo "==> Installing Deno >= ${RALLAR_MIN_DENO_VERSION} into /usr/local/bin"
export DENO_INSTALL=/usr/local
curl -fsSL https://deno.land/install.sh | sh
hash -r
require_rallar_min_deno_version

echo "==> Installing Caddy from the official stable apt repository"
curl -1sLf "https://dl.cloudsmith.io/public/caddy/stable/gpg.key" \
  | gpg --dearmor --yes -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf "https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt" \
  | tee /etc/apt/sources.list.d/caddy-stable.list >/dev/null
chmod o+r /usr/share/keyrings/caddy-stable-archive-keyring.gpg
chmod o+r /etc/apt/sources.list.d/caddy-stable.list
write_rallar_apt_profile caddy "${caddy_apt_config}"
env APT_CONFIG="${caddy_apt_config}" apt update
env APT_CONFIG="${caddy_apt_config}" apt install -y caddy

echo "==> Creating Rallar service user and directories"
if ! id rallar >/dev/null 2>&1; then
  useradd --system --home /opt/rallar --shell /usr/sbin/nologin rallar
fi

install -d -m 0755 -o rallar -g rallar /opt/rallar
install -d -m 0700 -o root -g root /etc/rallar
install -d -m 0755 -o rallar -g rallar /var/lib/rallar-deno
install -d -m 0755 -o rallar -g rallar /var/lib/rallar-black-box-control
install -d -m 0755 -o caddy -g caddy /var/www/rallar-black-box

echo "==> Versions"
node -v
npm -v
deno --version
caddy version

echo "Runtime installation complete."
