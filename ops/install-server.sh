#!/usr/bin/env bash
set -euo pipefail

CONFIG_FILE="${POC_VAULT_CONFIG:-$HOME/.poc-vault/secrets/config.env}"
if [[ -f "$CONFIG_FILE" ]]; then
  # shellcheck disable=SC1090
  source "$CONFIG_FILE"
fi

VAULT_DOMAIN="${VAULT_DOMAIN:-vault.pocs.example.com}"
POC_WILDCARD_DOMAIN="${POC_WILDCARD_DOMAIN:-*.pocs.example.com}"
DEPLOY_USER="${DEPLOY_USER:-deploy}"
SERVER_ROOT="${SERVER_ROOT:-/srv/poc-vault}"
TLS_DIR="${TLS_DIR:-/etc/poc-vault/tls}"
NGINX_CONF_PATH="${NGINX_CONF_PATH:-/etc/nginx/conf.d/poc-vault.conf}"
NGINX_USER="${NGINX_USER:-www-data}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TEMPLATE_PATH="${NGINX_TEMPLATE_PATH:-${SCRIPT_DIR}/nginx/poc-vault.conf.template}"
if [[ "$POC_WILDCARD_DOMAIN" == \*.* ]]; then
  POC_DOMAIN_SUFFIX="${POC_WILDCARD_DOMAIN#*.}"
else
  POC_DOMAIN_SUFFIX="$POC_WILDCARD_DOMAIN"
fi
POC_DOMAIN_SUFFIX_REGEX="${POC_DOMAIN_SUFFIX//./\\\\.}"

usage() {
  cat <<USAGE
Usage: sudo $(basename "$0")

Installs nginx and prepares server directories for POC Vault. Values can be
overridden in ${CONFIG_FILE}. This script creates bootstrap TLS/client-CA files
only when missing so nginx can start before real certificates are installed.
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
  apt-get install -y nginx openssl ca-certificates curl
fi

require_cmd nginx
require_cmd openssl

if [[ ! -f "$TEMPLATE_PATH" ]]; then
  echo "Missing nginx template: ${TEMPLATE_PATH}" >&2
  exit 1
fi

if ! id -u "$DEPLOY_USER" >/dev/null 2>&1; then
  useradd --system --create-home --shell /bin/bash "$DEPLOY_USER"
fi

install -d -m 0755 -o "$DEPLOY_USER" -g "$DEPLOY_USER" "$SERVER_ROOT"
install -d -m 0755 -o "$DEPLOY_USER" -g "$DEPLOY_USER" "$SERVER_ROOT/manifest"
install -d -m 0755 -o "$DEPLOY_USER" -g "$DEPLOY_USER" "$SERVER_ROOT/pocs"
install -d -m 0755 -o "$DEPLOY_USER" -g "$DEPLOY_USER" "$SERVER_ROOT/releases"
install -d -m 0755 -o root -g root "$TLS_DIR"
install -d -m 0755 -o root -g root "$(dirname "$NGINX_CONF_PATH")"

if [[ ! -f "$SERVER_ROOT/manifest/manifest.json" ]]; then
  install -m 0644 -o "$DEPLOY_USER" -g "$DEPLOY_USER" /dev/null "$SERVER_ROOT/manifest/manifest.json"
  printf '{"pocs":[]}\n' >"$SERVER_ROOT/manifest/manifest.json"
fi

if [[ ! -f "$TLS_DIR/server.key" || ! -f "$TLS_DIR/server.crt" ]]; then
  openssl req -x509 -newkey rsa:2048 -nodes \
    -keyout "$TLS_DIR/server.key" \
    -out "$TLS_DIR/server.crt" \
    -days 7 \
    -subj "/CN=${VAULT_DOMAIN}" \
    -addext "subjectAltName=DNS:${VAULT_DOMAIN},DNS:${POC_WILDCARD_DOMAIN}" >/dev/null 2>&1
  chmod 0640 "$TLS_DIR/server.key"
  chmod 0644 "$TLS_DIR/server.crt"
fi

if [[ ! -f "$TLS_DIR/client-ca.key" || ! -f "$TLS_DIR/client-ca.crt" ]]; then
  openssl req -x509 -newkey rsa:2048 -nodes \
    -keyout "$TLS_DIR/client-ca.key" \
    -out "$TLS_DIR/client-ca.crt" \
    -days 7 \
    -subj "/CN=POC Vault Bootstrap Client CA" >/dev/null 2>&1
  chmod 0600 "$TLS_DIR/client-ca.key"
  chmod 0644 "$TLS_DIR/client-ca.crt"
fi

if [[ ! -f "$TLS_DIR/client-ca.srl" ]]; then
  printf '01\n' >"$TLS_DIR/client-ca.srl"
fi
if [[ ! -f "$TLS_DIR/client-crl.pem" ]]; then
  crl_conf="$(mktemp)"
  cat >"$crl_conf" <<EOF
[ ca ]
default_ca = local_ca
[ local_ca ]
database = ${TLS_DIR}/index.txt
unique_subject = no
default_md = sha256
private_key = ${TLS_DIR}/client-ca.key
certificate = ${TLS_DIR}/client-ca.crt
default_crl_days = 30
crlnumber = ${TLS_DIR}/crlnumber
EOF
  : >"$TLS_DIR/index.txt"
  printf '1000\n' >"$TLS_DIR/crlnumber"
  openssl ca -config "$crl_conf" -gencrl -out "$TLS_DIR/client-crl.pem" >/dev/null 2>&1
  rm -f "$crl_conf"
  chmod 0644 "$TLS_DIR/client-crl.pem"
fi

chown root:"$NGINX_USER" "$TLS_DIR/server.key" || chown root:root "$TLS_DIR/server.key"
chmod 0640 "$TLS_DIR/server.key"

tmp_conf="$(mktemp)"
sed \
  -e "s#__VAULT_DOMAIN__#${VAULT_DOMAIN}#g" \
  -e "s#__POC_WILDCARD_DOMAIN__#${POC_WILDCARD_DOMAIN}#g" \
  -e "s#__POC_DOMAIN_SUFFIX_REGEX__#${POC_DOMAIN_SUFFIX_REGEX}#g" \
  -e "s#__SERVER_ROOT__#${SERVER_ROOT}#g" \
  -e "s#__TLS_DIR__#${TLS_DIR}#g" \
  "$TEMPLATE_PATH" >"$tmp_conf"
install -m 0644 -o root -g root "$tmp_conf" "$NGINX_CONF_PATH"
rm -f "$tmp_conf"

nginx -t
systemctl enable nginx >/dev/null 2>&1 || true
systemctl reload nginx >/dev/null 2>&1 || systemctl restart nginx

cat <<SUMMARY
POC Vault server prepared
  nginx_conf:  ${NGINX_CONF_PATH}
  server_root: ${SERVER_ROOT}
  tls_dir:     ${TLS_DIR}

Replace bootstrap certs with:
  - ${TLS_DIR}/server.crt and ${TLS_DIR}/server.key
  - ${TLS_DIR}/client-ca.crt and ${TLS_DIR}/client-crl.pem
SUMMARY
