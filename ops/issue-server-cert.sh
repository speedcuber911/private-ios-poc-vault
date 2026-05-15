#!/usr/bin/env bash
set -euo pipefail

CONFIG_FILE="${POC_VAULT_CONFIG:-$HOME/.poc-vault/secrets/config.env}"
if [[ -f "$CONFIG_FILE" ]]; then
  # shellcheck disable=SC1090
  source "$CONFIG_FILE"
fi

VAULT_DOMAIN="${VAULT_DOMAIN:-vault.pocs.example.com}"
POC_WILDCARD_DOMAIN="${POC_WILDCARD_DOMAIN:-*.pocs.example.com}"
TLS_DIR="${TLS_DIR:-/etc/poc-vault/tls}"
LE_EMAIL="${LE_EMAIL:-}"
CERTBOT_BIN="${CERTBOT_BIN:-certbot}"
CERT_NAME="${CERT_NAME:-poc-vault}"
STAGING=false
RELOAD_NGINX=true

usage() {
  cat <<USAGE
Usage: sudo $(basename "$0") [--staging] [--no-reload]

Issues or renews a Let's Encrypt certificate for:
  - ${VAULT_DOMAIN}
  - ${POC_WILDCARD_DOMAIN}

Requires certbot with the Route53 DNS plugin on the server. Set LE_EMAIL in
${CONFIG_FILE} or the environment.
USAGE
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --staging)
      STAGING=true
      shift
      ;;
    --no-reload)
      RELOAD_NGINX=false
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown argument: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

if [[ "${EUID}" -ne 0 ]]; then
  echo "Run as root, for example: sudo $0" >&2
  exit 1
fi
if [[ -z "$LE_EMAIL" ]]; then
  echo "Set LE_EMAIL before issuing a public certificate." >&2
  exit 1
fi
if ! command -v "$CERTBOT_BIN" >/dev/null 2>&1; then
  echo "Missing certbot. Install certbot and the python3-certbot-dns-route53 plugin." >&2
  exit 1
fi

install -d -m 0755 -o root -g root "$TLS_DIR"

certbot_args=(
  certonly
  --non-interactive
  --agree-tos
  --dns-route53
  --email "$LE_EMAIL"
  --cert-name "$CERT_NAME"
  -d "$VAULT_DOMAIN"
  -d "$POC_WILDCARD_DOMAIN"
)
if [[ "$STAGING" == "true" ]]; then
  certbot_args+=(--staging)
fi

"$CERTBOT_BIN" "${certbot_args[@]}"

live_dir="/etc/letsencrypt/live/${CERT_NAME}"
if [[ ! -f "$live_dir/fullchain.pem" || ! -f "$live_dir/privkey.pem" ]]; then
  echo "Certbot completed but expected files were not found in ${live_dir}" >&2
  exit 1
fi

install -m 0644 -o root -g root "$live_dir/fullchain.pem" "$TLS_DIR/server.crt"
install -m 0640 -o root -g www-data "$live_dir/privkey.pem" "$TLS_DIR/server.key" 2>/dev/null \
  || install -m 0640 -o root -g root "$live_dir/privkey.pem" "$TLS_DIR/server.key"

if [[ "$RELOAD_NGINX" == "true" ]]; then
  nginx -t
  systemctl reload nginx >/dev/null 2>&1 || nginx -s reload
fi

echo "Installed server certificate at ${TLS_DIR}/server.crt and ${TLS_DIR}/server.key"
