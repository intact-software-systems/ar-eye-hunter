#!/usr/bin/env bash
set -Eeuo pipefail

if [[ "$(id -u)" != "0" ]]; then
  echo "Run this script as root." >&2
  exit 1
fi

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/rallar-public-spa-env.sh"

RALLAR_REPO_URL="${RALLAR_REPO_URL:-https://github.com/intact-software-systems/ar-eye-hunter.git}"
RALLAR_REPO_REF="${RALLAR_REPO_REF:-main}"
RALLAR_CHECKOUT_DIR="${RALLAR_CHECKOUT_DIR:-/opt/rallar/ar-eye-hunter}"
RALLAR_API_HOST="${RALLAR_API_HOST:-api.rallar.intactss.com}"
RALLAR_CONTROL_HOST="${RALLAR_CONTROL_HOST:-control.rallar.intactss.com}"
RALLAR_BLACKBOX_HOST="${RALLAR_BLACKBOX_HOST:-blackbox.rallar.intactss.com}"
RALLAR_RETENTION_MAX_RUNS="${RALLAR_RETENTION_MAX_RUNS:-50}"
RALLAR_INSTALL_PLAYWRIGHT="${RALLAR_INSTALL_PLAYWRIGHT:-1}"
RALLAR_ACME_EMAIL="${RALLAR_ACME_EMAIL:-}"
RALLAR_BLACK_BOX_OPERATOR_TOKEN_TTL_MS="${RALLAR_BLACK_BOX_OPERATOR_TOKEN_TTL_MS:-86400000}"
RALLAR_BLACK_BOX_OPERATOR_CLIENT_IDS="${RALLAR_BLACK_BOX_OPERATOR_CLIENT_IDS:-}"

apply_rallar_public_spa_defaults
apply_rallar_public_cors_defaults

require_command() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "Missing required command: $1. Run 01-install-runtime.sh first." >&2
    exit 1
  fi
}

require_command git
require_command npm
require_command deno
require_command caddy
require_command openssl

echo "==> Deploying ${RALLAR_REPO_URL} ref ${RALLAR_REPO_REF}"
if [[ -d "${RALLAR_CHECKOUT_DIR}/.git" ]]; then
  git -C "${RALLAR_CHECKOUT_DIR}" fetch --prune origin
else
  install -d -m 0755 -o rallar -g rallar "$(dirname "${RALLAR_CHECKOUT_DIR}")"
  git clone "${RALLAR_REPO_URL}" "${RALLAR_CHECKOUT_DIR}"
fi

git -C "${RALLAR_CHECKOUT_DIR}" checkout "${RALLAR_REPO_REF}"
git -C "${RALLAR_CHECKOUT_DIR}" pull --ff-only origin "${RALLAR_REPO_REF}" || true
chown -R rallar:rallar "${RALLAR_CHECKOUT_DIR}"

echo "==> Installing npm dependencies"
runuser -u rallar -- npm --prefix "${RALLAR_CHECKOUT_DIR}" ci

echo "==> Warming Deno caches"
runuser -u rallar -- env DENO_DIR=/var/lib/rallar-deno \
  deno cache --config "${RALLAR_CHECKOUT_DIR}/apps/api-v1/deno.json" \
  "${RALLAR_CHECKOUT_DIR}/apps/api-v1/src/main.ts"
runuser -u rallar -- env DENO_DIR=/var/lib/rallar-deno \
  deno cache --config "${RALLAR_CHECKOUT_DIR}/apps/rallar-black-box-control-server/deno.json" \
  "${RALLAR_CHECKOUT_DIR}/apps/rallar-black-box-control-server/src/main.ts"

if [[ "${RALLAR_INSTALL_PLAYWRIGHT}" == "1" || "${RALLAR_INSTALL_PLAYWRIGHT}" == "true" ]]; then
  echo "==> Installing Playwright Chromium and Linux dependencies"
  npm --prefix "${RALLAR_CHECKOUT_DIR}" exec -- playwright install --with-deps chromium
fi

echo "==> Building rallar-black-box SPA"
build_rallar_black_box_spa "${RALLAR_CHECKOUT_DIR}"

echo "==> Publishing SPA static files"
rm -rf /var/www/rallar-black-box/*
rsync -a --delete \
  "${RALLAR_CHECKOUT_DIR}/apps/rallar-black-box/dist/" \
  /var/www/rallar-black-box/
chown -R caddy:caddy /var/www/rallar-black-box

echo "==> Writing environment files"
install -d -m 0700 -o root -g root /etc/rallar
install -d -m 0755 -o rallar -g rallar /var/lib/rallar-black-box-control
install -d -m 0755 -o rallar -g rallar /var/lib/rallar-deno
write_rallar_black_box_spa_env_file

if [[ -z "${RALLAR_BLACK_BOX_OPERATOR_TOKEN_SECRET:-}" && -r /etc/rallar/api-v1.env ]]; then
  RALLAR_BLACK_BOX_OPERATOR_TOKEN_SECRET="$(
    grep -E "^RALLAR_BLACK_BOX_OPERATOR_TOKEN_SECRET=" /etc/rallar/api-v1.env \
      | tail -n 1 \
      | cut -d= -f2- || true
  )"
fi
if [[ -z "${RALLAR_BLACK_BOX_OPERATOR_TOKEN_SECRET:-}" && -r /etc/rallar/control-server.env ]]; then
  RALLAR_BLACK_BOX_OPERATOR_TOKEN_SECRET="$(
    grep -E "^RALLAR_BLACK_BOX_OPERATOR_TOKEN_SECRET=" /etc/rallar/control-server.env \
      | tail -n 1 \
      | cut -d= -f2- || true
  )"
fi
if [[ -z "${RALLAR_BLACK_BOX_OPERATOR_TOKEN_SECRET:-}" ]]; then
  RALLAR_BLACK_BOX_OPERATOR_TOKEN_SECRET="$(openssl rand -hex 32)"
fi

cat >/etc/rallar/api-v1.env <<EOF
PORT=8080
CORS_ORIGINS=${RALLAR_API_CORS_ORIGINS}
RALLAR_API_BASE_URL=https://${RALLAR_API_HOST}
RALLAR_WS_BASE_URL=wss://${RALLAR_API_HOST}
RALLAR_SQL_BACKEND=pglite-memory
RALLAR_PGLITE_DATA_DIR=memory://
RALLAR_PGLITE_SCHEMA_INIT=auto
RALLAR_DB_PUBSUB=local
RALLAR_ICE_MODE=local
RALLAR_LOGIN_USER_RATE_LIMIT=100
RALLAR_TIMING_LOGS=0
RALLAR_BLACK_BOX_OPERATOR_TOKEN_SECRET=${RALLAR_BLACK_BOX_OPERATOR_TOKEN_SECRET}
RALLAR_BLACK_BOX_OPERATOR_TOKEN_TTL_MS=${RALLAR_BLACK_BOX_OPERATOR_TOKEN_TTL_MS}
RALLAR_BLACK_BOX_OPERATOR_CLIENT_IDS=${RALLAR_BLACK_BOX_OPERATOR_CLIENT_IDS}
EOF
chmod 0600 /etc/rallar/api-v1.env
echo "WARNING: API-v1 is configured with RALLAR_SQL_BACKEND=pglite-memory; restarting rallar-api-v1 resets auth sessions and runtime state."

if [[ -z "${RALLAR_CONTROL_ADMIN_TOKEN:-}" && -r /etc/rallar/control-server.env ]]; then
  RALLAR_CONTROL_ADMIN_TOKEN="$(
    grep -E "^RALLAR_BLACK_BOX_ADMIN_TOKEN=" /etc/rallar/control-server.env \
      | tail -n 1 \
      | cut -d= -f2- || true
  )"
fi
if [[ -z "${RALLAR_CONTROL_ADMIN_TOKEN:-}" ]]; then
  RALLAR_CONTROL_ADMIN_TOKEN="$(openssl rand -hex 32)"
fi

cat >/etc/rallar/control-server.env <<EOF
PORT=5180
RALLAR_BLACK_BOX_ADMIN_TOKEN=${RALLAR_CONTROL_ADMIN_TOKEN}
RALLAR_BLACK_BOX_OPERATOR_TOKEN_SECRET=${RALLAR_BLACK_BOX_OPERATOR_TOKEN_SECRET}
RALLAR_BLACK_BOX_REQUIRE_TLS=1
RALLAR_BLACK_BOX_ALLOWED_ORIGINS=${RALLAR_BLACK_BOX_ALLOWED_ORIGINS}
RALLAR_BLACK_BOX_HTTP_ALLOWED_HOSTS=${RALLAR_API_HOST}
RALLAR_BLACK_BOX_WS_ALLOWED_HOSTS=${RALLAR_API_HOST},${RALLAR_CONTROL_HOST}
RALLAR_BLACK_BOX_STORAGE_DIR=/var/lib/rallar-black-box-control
RALLAR_BLACK_BOX_RETENTION_MAX_RUNS=${RALLAR_RETENTION_MAX_RUNS}
EOF
chmod 0600 /etc/rallar/control-server.env

echo "==> Writing systemd services"
cat >/etc/systemd/system/rallar-api-v1.service <<EOF
[Unit]
Description=Rallar API-v1 memory controller
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=rallar
Group=rallar
WorkingDirectory=${RALLAR_CHECKOUT_DIR}/apps/api-v1
Environment=DENO_DIR=/var/lib/rallar-deno
EnvironmentFile=/etc/rallar/api-v1.env
EnvironmentFile=-/etc/rallar/api-v1.secrets.env
ExecStart=/usr/local/bin/deno run --config ${RALLAR_CHECKOUT_DIR}/apps/api-v1/deno.json --allow-net --allow-env --allow-read ${RALLAR_CHECKOUT_DIR}/apps/api-v1/src/main.ts
Restart=always
RestartSec=5
NoNewPrivileges=true
PrivateTmp=true

[Install]
WantedBy=multi-user.target
EOF

cat >/etc/systemd/system/rallar-black-box-control.service <<EOF
[Unit]
Description=Rallar Black Box control server
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=rallar
Group=rallar
WorkingDirectory=${RALLAR_CHECKOUT_DIR}/apps/rallar-black-box-control-server
Environment=DENO_DIR=/var/lib/rallar-deno
EnvironmentFile=/etc/rallar/control-server.env
ExecStart=/usr/local/bin/deno run --config ${RALLAR_CHECKOUT_DIR}/apps/rallar-black-box-control-server/deno.json --allow-net --allow-env --allow-read --allow-write ${RALLAR_CHECKOUT_DIR}/apps/rallar-black-box-control-server/src/main.ts
Restart=always
RestartSec=5
NoNewPrivileges=true
PrivateTmp=true

[Install]
WantedBy=multi-user.target
EOF

echo "==> Writing Caddyfile"
if [[ -n "${RALLAR_ACME_EMAIL}" ]]; then
  cat >/etc/caddy/Caddyfile <<EOF
{
	email ${RALLAR_ACME_EMAIL}
}

${RALLAR_API_HOST} {
	reverse_proxy 127.0.0.1:8080
}

${RALLAR_CONTROL_HOST} {
	reverse_proxy 127.0.0.1:5180
}

${RALLAR_BLACKBOX_HOST} {
	root * /var/www/rallar-black-box
	try_files {path} /index.html
	file_server
}
EOF
else
  cat >/etc/caddy/Caddyfile <<EOF
${RALLAR_API_HOST} {
	reverse_proxy 127.0.0.1:8080
}

${RALLAR_CONTROL_HOST} {
	reverse_proxy 127.0.0.1:5180
}

${RALLAR_BLACKBOX_HOST} {
	root * /var/www/rallar-black-box
	try_files {path} /index.html
	file_server
}
EOF
fi

caddy fmt --overwrite /etc/caddy/Caddyfile
caddy validate --config /etc/caddy/Caddyfile

echo "==> Starting services"
systemctl daemon-reload
systemctl enable --now rallar-api-v1.service
systemctl enable --now rallar-black-box-control.service
systemctl restart rallar-api-v1.service
systemctl restart rallar-black-box-control.service
systemctl reload caddy || systemctl restart caddy

echo "==> Local health checks"
curl -fsS http://127.0.0.1:8080/api/config >/dev/null
curl -fsS http://127.0.0.1:8080/api/docs >/dev/null
curl -fsS -H "x-forwarded-proto: https" http://127.0.0.1:5180/health >/dev/null

echo "Deployment complete."
echo "Public checks:"
echo "  https://${RALLAR_API_HOST}/api/config"
echo "  https://${RALLAR_API_HOST}/api/docs"
echo "  https://${RALLAR_CONTROL_HOST}/health"
echo "  https://${RALLAR_BLACKBOX_HOST}/"
echo "Control admin token is stored in /etc/rallar/control-server.env"
