#!/usr/bin/env bash
set -euo pipefail

CONFIG_FILE="${POC_VAULT_CONFIG:-$HOME/.poc-vault/secrets/config.env}"
if [[ -f "$CONFIG_FILE" ]]; then
  # shellcheck disable=SC1090
  source "$CONFIG_FILE"
fi

LOCAL_SECRETS_DIR="${LOCAL_SECRETS_DIR:-$HOME/.poc-vault/secrets}"
CLIENT_NAME_OR_CERT="${1:-}"
CLIENT_CERT_DAYS="${CLIENT_CERT_DAYS:-825}"

usage() {
  cat <<USAGE
Usage: $(basename "$0") <client-name|path-to-client.crt>

Revokes a locally issued client certificate and refreshes:
  ${LOCAL_SECRETS_DIR}/client-crl.pem

Copy the refreshed CRL to /etc/poc-vault/tls/client-crl.pem on the server and
reload nginx.
USAGE
}

if [[ -z "$CLIENT_NAME_OR_CERT" || "$CLIENT_NAME_OR_CERT" == "-h" || "$CLIENT_NAME_OR_CERT" == "--help" ]]; then
  usage
  [[ -z "$CLIENT_NAME_OR_CERT" ]] && exit 2 || exit 0
fi

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || {
    echo "Missing required command: $1" >&2
    exit 1
  }
}
require_cmd openssl

pki_dir="$LOCAL_SECRETS_DIR/client-pki"
ca_key="$LOCAL_SECRETS_DIR/client-ca.key"
ca_crt="$LOCAL_SECRETS_DIR/client-ca.crt"
crl="$LOCAL_SECRETS_DIR/client-crl.pem"
ca_conf="$pki_dir/openssl-ca.cnf"

if [[ -f "$CLIENT_NAME_OR_CERT" ]]; then
  cert_path="$CLIENT_NAME_OR_CERT"
else
  safe_name="$(printf '%s' "$CLIENT_NAME_OR_CERT" | tr -c 'A-Za-z0-9_.@-' '_')"
  cert_path="$LOCAL_SECRETS_DIR/clients/$safe_name/${safe_name}.crt"
fi

if [[ ! -f "$cert_path" ]]; then
  echo "Client certificate not found: ${cert_path}" >&2
  exit 1
fi
if [[ ! -f "$ca_key" || ! -f "$ca_crt" || ! -f "$ca_conf" ]]; then
  echo "Client CA files are missing under ${LOCAL_SECRETS_DIR}. Generate a client cert first." >&2
  exit 1
fi

openssl ca -batch -config "$ca_conf" -revoke "$cert_path" >/dev/null 2>&1
openssl ca -config "$ca_conf" -gencrl -out "$crl" >/dev/null 2>&1
chmod 0644 "$crl"

echo "Revoked ${cert_path}"
echo "Updated CRL: ${crl}"
