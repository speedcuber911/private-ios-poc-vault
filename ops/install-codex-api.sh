#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CONFIG_FILE="${POC_VAULT_CONFIG:-$HOME/.poc-vault/secrets/config.env}"
if [[ -f "$CONFIG_FILE" ]]; then
  # shellcheck disable=SC1090
  source "$CONFIG_FILE"
fi

INSTALL_DIR="${CODEX_API_INSTALL_DIR:-/opt/codex-api}"
ENV_PATH="${CODEX_API_ENV_PATH:-/etc/codex-api.env}"
NGINX_CONF_PATH="${CODEX_API_NGINX_CONF_PATH:-/etc/nginx/conf.d/codex-api.conf}"
SERVICE_PATH="${CODEX_API_SERVICE_PATH:-/etc/systemd/system/codex-api.service}"
RUNNER_USER="${CODEX_RUNNER_USER:-codex-runner}"
DATA_DIR="${CODEX_DATA_DIR:-/var/lib/codex-api}"
WORKSPACE_ROOT="${CODEX_WORKSPACE_ROOT:-/srv/codex-workspaces}"
TLS_DIR="${TLS_DIR:-/etc/poc-vault/tls}"
CODEX_MTLS_DIR="${CODEX_MTLS_DIR:-/etc/codex-api/mtls}"
TMP_RENDER_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_RENDER_DIR"' EXIT

usage() {
  cat <<USAGE
Usage: sudo $(basename "$0")

Installs the Codex async job API on an EC2 host from this checkout:
  - renders /etc/codex-api.env from ${CONFIG_FILE}
  - renders nginx config from the owner-specific Codex domain and subjects
  - installs server.mjs and systemd unit
  - prepares codex-runner, data directories, workspaces, and mTLS CA files

Run ops/install-server.sh first so ${TLS_DIR} exists.
USAGE
}

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  usage
  exit 0
fi

if [[ "${EUID}" -ne 0 ]]; then
  echo "Run as root, for example: sudo $0" >&2
  exit 1
fi

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || {
    echo "Missing required command: $1" >&2
    exit 1
  }
}

if command -v apt-get >/dev/null 2>&1; then
  export DEBIAN_FRONTEND=noninteractive
  apt-get update
  apt-get install -y nginx ca-certificates curl nodejs
fi

require_cmd node
require_cmd nginx
require_cmd python3

if ! id -u "$RUNNER_USER" >/dev/null 2>&1; then
  useradd --system --create-home --home-dir "$DATA_DIR/run-home" --shell /bin/bash "$RUNNER_USER"
fi

install -d -m 0755 -o root -g root "$INSTALL_DIR" "$INSTALL_DIR/helpers" "$(dirname "$ENV_PATH")" "$(dirname "$NGINX_CONF_PATH")"
install -d -m 0750 -o "$RUNNER_USER" -g "$RUNNER_USER" "$DATA_DIR" "$DATA_DIR/jobs" "$DATA_DIR/logs" "$DATA_DIR/approvals" "$DATA_DIR/run-home"
install -d -m 0755 -o "$RUNNER_USER" -g "$RUNNER_USER" "$WORKSPACE_ROOT" "$WORKSPACE_ROOT/scratch" "$WORKSPACE_ROOT/poc-vault" "$WORKSPACE_ROOT/sigiq"
install -d -m 0755 -o root -g root "$CODEX_MTLS_DIR"

if [[ -f "$TLS_DIR/client-ca.crt" ]]; then
  install -m 0644 -o root -g root "$TLS_DIR/client-ca.crt" "$CODEX_MTLS_DIR/client-ca.crt"
else
  echo "WARN missing ${TLS_DIR}/client-ca.crt; Codex mTLS will not pass until installed." >&2
fi
if [[ -f "$TLS_DIR/client-crl.pem" ]]; then
  install -m 0644 -o root -g root "$TLS_DIR/client-crl.pem" "$CODEX_MTLS_DIR/client-crl.pem"
else
  echo "WARN missing ${TLS_DIR}/client-crl.pem; Codex mTLS will not pass until installed." >&2
fi

python3 "$ROOT/ops/render-codex-api-config" --config "$CONFIG_FILE" --output-dir "$TMP_RENDER_DIR"

install -m 0644 -o root -g root "$ROOT/relay-server/codex-api-deploy/server.mjs" "$INSTALL_DIR/server.mjs"
for helper in approval-store.mjs appserver-client.mjs codex-job-runner.mjs claude-permission-mcp.mjs terminals.mjs; do
  install -m 0644 -o root -g root "$ROOT/product/relayd/src/$helper" "$INSTALL_DIR/helpers/$helper"
done
install -m 0644 -o root -g root "$ROOT/relay-server/codex-api-deploy/codex-api.service" "$SERVICE_PATH"
install -m 0600 -o root -g root "$TMP_RENDER_DIR/codex-api.env" "$ENV_PATH"
install -m 0644 -o root -g root "$TMP_RENDER_DIR/codex-api.nginx.conf" "$NGINX_CONF_PATH"

if [[ ! -x "${CODEX_BIN:-/usr/bin/codex}" && ! -x /usr/bin/codex ]]; then
  echo "WARN codex CLI was not found. Install/login Codex for ${RUNNER_USER} before running jobs." >&2
fi
if [[ ! -x "${CLAUDE_BIN:-/usr/bin/claude}" && ! -x /usr/bin/claude ]]; then
  echo "WARN Claude Code CLI was not found. Install/login Claude Code for ${RUNNER_USER} before running jobs." >&2
fi
if [[ ! -x "${CURSOR_BIN:-${DATA_DIR}/run-home/.local/bin/cursor-agent}" ]]; then
  echo "WARN Cursor Agent CLI was not found. Install/login Cursor for ${RUNNER_USER} before running jobs." >&2
fi
if [[ ! -x "${KIMI_BIN:-${DATA_DIR}/run-home/.local/bin/kimi}" ]]; then
  echo "WARN Kimi Code CLI was not found. Install it and run kimi login for ${RUNNER_USER} before running Kimi K3 jobs." >&2
fi

nginx -t
systemctl daemon-reload
systemctl enable codex-api >/dev/null 2>&1 || true
systemctl restart codex-api
systemctl reload nginx >/dev/null 2>&1 || systemctl restart nginx

cat <<SUMMARY
Codex API installed
  install_dir: ${INSTALL_DIR}
  env:         ${ENV_PATH}
  nginx_conf:  ${NGINX_CONF_PATH}
  service:     ${SERVICE_PATH}
  runner_user: ${RUNNER_USER}

Next:
  - put Codex auth at ${DATA_DIR}/run-home/.codex/auth.json for ${RUNNER_USER}
  - connect Cursor with cursor-agent login and Kimi K3 with kimi login as ${RUNNER_USER}
  - verify with curl against https://${CODEX_DOMAIN:-codex.pocs.example.com}/healthz
SUMMARY
