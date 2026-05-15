#!/usr/bin/env bash
set -euo pipefail

CONFIG_FILE="${POC_VAULT_CONFIG:-$HOME/.poc-vault/secrets/config.env}"
if [[ -f "$CONFIG_FILE" ]]; then
  # shellcheck disable=SC1090
  source "$CONFIG_FILE"
fi

DEVICE="${DEVICE:-}"
BUNDLE_ID="${BUNDLE_ID:-${IOS_BUNDLE_ID:-com.example.pocvault}}"
LOCAL_SECRETS_DIR="${LOCAL_SECRETS_DIR:-$HOME/.poc-vault/secrets}"
P12_PATH="${IPHONE_P12_PATH:-$LOCAL_SECRETS_DIR/clients/iphone/iphone.p12}"
VAULT_DOMAIN="${VAULT_DOMAIN:-vault.pocs.example.com}"
POC_VAULT_MANIFEST_URL="${POC_VAULT_MANIFEST_URL:-https://${VAULT_DOMAIN}/manifest.json}"
POC_VAULT_SIGNATURE_URL="${POC_VAULT_SIGNATURE_URL:-https://${VAULT_DOMAIN}/manifest.sig.json}"

usage() {
  cat <<USAGE
Usage: DEVICE=<device-id> $(basename "$0") [--bundle-id <id>] [--p12 <path>]

Copies local iPhone support files into the app data container:
  - Documents/support/client.p12
  - Documents/support/vault-config.json

Values are read from ${CONFIG_FILE}. Open the app Diagnostics screen once first
if the Documents/support directory has not been created yet.
USAGE
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --device)
      DEVICE="${2:-}"
      shift 2
      ;;
    --bundle-id)
      BUNDLE_ID="${2:-}"
      shift 2
      ;;
    --p12)
      P12_PATH="${2:-}"
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

if [[ -z "$DEVICE" ]]; then
  echo "Set DEVICE to the connected iPhone id, or pass --device <id>." >&2
  echo "Find ids with: xcrun devicectl list devices" >&2
  exit 1
fi
if [[ ! -f "$P12_PATH" ]]; then
  echo "Missing client certificate package: ${P12_PATH}" >&2
  exit 1
fi

tmpdir="$(mktemp -d)"
trap 'rm -rf "$tmpdir"' EXIT

config_json="$tmpdir/vault-config.json"
python3 - "$POC_VAULT_MANIFEST_URL" "$POC_VAULT_SIGNATURE_URL" >"$config_json" <<'PY'
import json
import sys

manifest_url, signature_url = sys.argv[1:3]
print(json.dumps({
    "manifestURL": manifest_url,
    "signatureURL": signature_url,
}, indent=2, sort_keys=True))
PY

xcrun devicectl device copy to \
  --device "$DEVICE" \
  --source "$P12_PATH" \
  --destination Documents/support/client.p12 \
  --domain-type appDataContainer \
  --domain-identifier "$BUNDLE_ID" \
  --timeout 30

xcrun devicectl device copy to \
  --device "$DEVICE" \
  --source "$config_json" \
  --destination Documents/support/vault-config.json \
  --domain-type appDataContainer \
  --domain-identifier "$BUNDLE_ID" \
  --timeout 30

echo "Provisioned iOS support files for bundle ${BUNDLE_ID}."
