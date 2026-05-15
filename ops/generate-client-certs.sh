#!/usr/bin/env bash
set -euo pipefail

CONFIG_FILE="${POC_VAULT_CONFIG:-$HOME/.poc-vault/secrets/config.env}"
if [[ -f "$CONFIG_FILE" ]]; then
  # shellcheck disable=SC1090
  source "$CONFIG_FILE"
fi

LOCAL_SECRETS_DIR="${LOCAL_SECRETS_DIR:-$HOME/.poc-vault/secrets}"
CLIENT_NAME="${1:-default}"
CLIENT_CERT_DAYS="${CLIENT_CERT_DAYS:-825}"
CLIENT_CA_DAYS="${CLIENT_CA_DAYS:-3650}"
umask 077

usage() {
  cat <<USAGE
Usage: $(basename "$0") [client-name]

Creates or reuses a local POC Vault client CA under ${LOCAL_SECRETS_DIR}, then
issues a client certificate and updates the CRL. Copy client-ca.crt and
client-crl.pem to /etc/poc-vault/tls on the server.
USAGE
}

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  usage
  exit 0
fi

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || {
    echo "Missing required command: $1" >&2
    exit 1
  }
}
require_cmd openssl

safe_name="$(printf '%s' "$CLIENT_NAME" | tr -c 'A-Za-z0-9_.@-' '_')"
if [[ -z "$safe_name" || "$safe_name" == "_" ]]; then
  echo "Invalid client name: ${CLIENT_NAME}" >&2
  exit 1
fi

pki_dir="$LOCAL_SECRETS_DIR/client-pki"
client_dir="$LOCAL_SECRETS_DIR/clients/$safe_name"
ca_key="$LOCAL_SECRETS_DIR/client-ca.key"
ca_crt="$LOCAL_SECRETS_DIR/client-ca.crt"
crl="$LOCAL_SECRETS_DIR/client-crl.pem"
ca_conf="$pki_dir/openssl-ca.cnf"

install -d -m 0700 "$LOCAL_SECRETS_DIR" "$pki_dir" "$pki_dir/newcerts" "$LOCAL_SECRETS_DIR/clients" "$client_dir"
touch "$pki_dir/index.txt"
[[ -f "$pki_dir/serial" ]] || printf '1000\n' >"$pki_dir/serial"
[[ -f "$pki_dir/crlnumber" ]] || printf '1000\n' >"$pki_dir/crlnumber"

cat >"$ca_conf" <<EOF
[ ca ]
default_ca = local_ca

[ local_ca ]
dir = ${pki_dir}
database = ${pki_dir}/index.txt
new_certs_dir = ${pki_dir}/newcerts
certificate = ${ca_crt}
serial = ${pki_dir}/serial
crlnumber = ${pki_dir}/crlnumber
private_key = ${ca_key}
default_md = sha256
default_days = ${CLIENT_CERT_DAYS}
default_crl_days = 30
policy = policy_any
email_in_dn = no
copy_extensions = copy
unique_subject = no

[ policy_any ]
commonName = supplied

[ req ]
default_bits = 2048
prompt = no
distinguished_name = req_dn
default_md = sha256

[ req_dn ]
CN = ${safe_name}

[ usr_cert ]
basicConstraints = CA:FALSE
keyUsage = digitalSignature, keyEncipherment
extendedKeyUsage = clientAuth
subjectKeyIdentifier = hash
authorityKeyIdentifier = keyid,issuer
EOF

if [[ ! -f "$ca_key" || ! -f "$ca_crt" ]]; then
  openssl req -x509 -newkey rsa:4096 -nodes \
    -keyout "$ca_key" \
    -out "$ca_crt" \
    -days "$CLIENT_CA_DAYS" \
    -subj "/CN=POC Vault Client CA" \
    -addext "basicConstraints=critical,CA:TRUE,pathlen:0" \
    -addext "keyUsage=critical,keyCertSign,cRLSign" >/dev/null 2>&1
  chmod 0600 "$ca_key"
  chmod 0644 "$ca_crt"
fi

client_key="$client_dir/${safe_name}.key"
client_csr="$client_dir/${safe_name}.csr"
client_crt="$client_dir/${safe_name}.crt"
client_p12="$client_dir/${safe_name}.p12"

if [[ -f "$client_crt" ]]; then
  echo "Client certificate already exists: ${client_crt}" >&2
  echo "Revoke it first or choose a different client name." >&2
  exit 1
fi

openssl req -new -newkey rsa:2048 -nodes \
  -keyout "$client_key" \
  -out "$client_csr" \
  -subj "/CN=${safe_name}" >/dev/null 2>&1
openssl ca -batch \
  -config "$ca_conf" \
  -extensions usr_cert \
  -days "$CLIENT_CERT_DAYS" \
  -in "$client_csr" \
  -out "$client_crt" >/dev/null 2>&1
openssl ca -config "$ca_conf" -gencrl -out "$crl" >/dev/null 2>&1
openssl pkcs12 -export \
  -inkey "$client_key" \
  -in "$client_crt" \
  -certfile "$ca_crt" \
  -out "$client_p12" \
  -passout pass: >/dev/null 2>&1

chmod 0600 "$client_key" "$client_p12"
chmod 0644 "$client_crt" "$ca_crt" "$crl"

cat <<SUMMARY
Generated POC Vault client certificate
  client:       ${safe_name}
  ca_cert:      ${ca_crt}
  crl:          ${crl}
  client_cert:  ${client_crt}
  client_key:   ${client_key}
  ios_p12:      ${client_p12}
SUMMARY
