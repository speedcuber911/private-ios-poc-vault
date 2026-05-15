#!/usr/bin/env bash
set -euo pipefail

CONFIG_FILE="${POC_VAULT_CONFIG:-$HOME/.poc-vault/secrets/config.env}"
if [[ -f "$CONFIG_FILE" ]]; then
  # shellcheck disable=SC1090
  source "$CONFIG_FILE"
fi

VAULT_DOMAIN="${VAULT_DOMAIN:-vault.pocs.example.com}"
POC_VERIFY_HOST="${POC_VERIFY_HOST:-smoke-test.pocs.example.com}"
MANIFEST_PATH="${MANIFEST_PATH:-/manifest.json}"
POC_VERIFY_PATH="${POC_VERIFY_PATH:-/}"
LOCAL_SECRETS_DIR="${LOCAL_SECRETS_DIR:-$HOME/.poc-vault/secrets}"
CURL_EXTRA_ARGS=()

usage() {
  cat <<USAGE
Usage: $(basename "$0") [--resolve-ip <ip>]

Runs curl checks:
  - /healthz on ${VAULT_DOMAIN} should work without a client cert
  - manifest should be blocked without a client cert
  - manifest and ${POC_VERIFY_HOST} should work with a client cert when present
USAGE
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --resolve-ip)
      if [[ -z "${2:-}" ]]; then
        echo "--resolve-ip requires an IP" >&2
        exit 2
      fi
      CURL_EXTRA_ARGS+=(--resolve "${VAULT_DOMAIN}:443:${2}" --resolve "${POC_VERIFY_HOST}:443:${2}")
      shift 2
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

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || {
    echo "Missing required command: $1" >&2
    exit 1
  }
}
require_cmd curl

curl_status() {
  local url="$1"
  shift
  curl -sS -o /dev/null -w '%{http_code}' "${CURL_EXTRA_ARGS[@]}" "$@" "$url"
}

expect_status() {
  local label="$1"
  local expected="$2"
  local url="$3"
  shift 3
  local status
  status="$(curl_status "$url" "$@")"
  if [[ ! "$status" =~ $expected ]]; then
    echo "FAIL ${label}: got HTTP ${status}, expected ${expected}" >&2
    return 1
  fi
  echo "OK   ${label}: HTTP ${status}"
}

find_client_pair() {
  local cert key candidate name
  if [[ -f "$LOCAL_SECRETS_DIR/clients/default/default.crt" && -f "$LOCAL_SECRETS_DIR/clients/default/default.key" ]]; then
    printf '%s\n%s\n' "$LOCAL_SECRETS_DIR/clients/default/default.crt" "$LOCAL_SECRETS_DIR/clients/default/default.key"
    return 0
  fi
  while IFS= read -r candidate; do
    name="$(basename "$candidate" .crt)"
    key="$(dirname "$candidate")/${name}.key"
    if [[ -f "$key" ]]; then
      cert="$candidate"
      printf '%s\n%s\n' "$cert" "$key"
      return 0
    fi
  done < <(find "$LOCAL_SECRETS_DIR/clients" -type f -name '*.crt' 2>/dev/null | sort)
  return 1
}

health_url="https://${VAULT_DOMAIN}/healthz"
manifest_url="https://${VAULT_DOMAIN}${MANIFEST_PATH}"
poc_url="https://${POC_VERIFY_HOST}${POC_VERIFY_PATH}"

expect_status "health without client cert" '^2[0-9][0-9]$' "$health_url"
expect_status "manifest blocked without client cert" '^(400|401|403|495|496)$' "$manifest_url" || true

if mapfile -t client_pair < <(find_client_pair); then
  client_cert="${client_pair[0]}"
  client_key="${client_pair[1]}"
  tls_args=(--cert "$client_cert" --key "$client_key")
  expect_status "manifest with client cert" '^2[0-9][0-9]$' "$manifest_url" "${tls_args[@]}"
  expect_status "poc origin with client cert" '^2[0-9][0-9]$' "$poc_url" "${tls_args[@]}"
else
  echo "SKIP client-auth success checks: no client cert/key found under ${LOCAL_SECRETS_DIR}/clients"
fi
