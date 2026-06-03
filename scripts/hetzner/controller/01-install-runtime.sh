#!/usr/bin/env bash
set -Eeuo pipefail

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
apt update
apt upgrade -y
apt install -y \
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
curl -fsSL https://deb.nodesource.com/setup_24.x | bash -
apt install -y nodejs

echo "==> Installing Deno into /usr/local/bin"
export DENO_INSTALL=/usr/local
curl -fsSL https://deno.land/install.sh | sh

echo "==> Installing Caddy from the official stable apt repository"
curl -1sLf "https://dl.cloudsmith.io/public/caddy/stable/gpg.key" \
  | gpg --dearmor --yes -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf "https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt" \
  | tee /etc/apt/sources.list.d/caddy-stable.list >/dev/null
chmod o+r /usr/share/keyrings/caddy-stable-archive-keyring.gpg
chmod o+r /etc/apt/sources.list.d/caddy-stable.list
apt update
apt install -y caddy

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
