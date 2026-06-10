#!/usr/bin/env bash
set -Eeuo pipefail

if [[ "$(id -u)" != "0" ]]; then
  echo "Run this script as root." >&2
  exit 1
fi

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"

# Reuse the existing /etc/rallar/headless-worker.env by default. To change
# run id, credentials, or agent count, call 09-start-headless-workers.sh with
# RALLAR_WRITE_HEADLESS_ENV=1 and the desired env values instead.
export RALLAR_WRITE_HEADLESS_ENV="${RALLAR_WRITE_HEADLESS_ENV:-0}"
"${SCRIPT_DIR}/09-start-headless-workers.sh"
