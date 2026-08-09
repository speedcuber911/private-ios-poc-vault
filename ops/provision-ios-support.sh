#!/usr/bin/env bash
set -euo pipefail

CONFIG_FILE="${POC_VAULT_CONFIG:-$HOME/.poc-vault/secrets/config.env}"
if [[ -f "$CONFIG_FILE" ]]; then
  # shellcheck disable=SC1090
  source "$CONFIG_FILE"
fi

DEVICE="${DEVICE:-}"
BUNDLE_ID="${BUNDLE_ID:-${IOS_BUNDLE_ID:-com.parikshit.pocvault}}"
LOCAL_SECRETS_DIR="${LOCAL_SECRETS_DIR:-$HOME/.poc-vault/secrets}"
P12_PATH="${IPHONE_P12_PATH:-$LOCAL_SECRETS_DIR/clients/iphone/iphone.p12}"
VAULT_DOMAIN="${VAULT_DOMAIN:-vault.pocs.example.com}"
POC_VAULT_MANIFEST_URL="${POC_VAULT_MANIFEST_URL:-https://${VAULT_DOMAIN}/manifest.json}"
POC_VAULT_SIGNATURE_URL="${POC_VAULT_SIGNATURE_URL:-https://${VAULT_DOMAIN}/manifest.sig.json}"
POC_VAULT_CODEX_BASE_URL="${POC_VAULT_CODEX_BASE_URL:-https://codex.${VAULT_DOMAIN#vault.}}"
POC_VAULT_MANIFEST_PUBLIC_KEY="${POC_VAULT_MANIFEST_PUBLIC_KEY:-${MANIFEST_PUBLIC_KEY:-}}"

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
python3 - "$POC_VAULT_MANIFEST_URL" "$POC_VAULT_SIGNATURE_URL" "$POC_VAULT_CODEX_BASE_URL" "$POC_VAULT_MANIFEST_PUBLIC_KEY" >"$config_json" <<'PY'
import json
import sys

manifest_url, signature_url, codex_base_url, manifest_public_key = sys.argv[1:5]
payload = {
    "codexBaseURL": codex_base_url,
    "manifestURL": manifest_url,
    "signatureURL": signature_url,
}
if manifest_public_key:
    payload["manifestPublicKey"] = manifest_public_key
print(json.dumps(payload, indent=2, sort_keys=True))
PY

support_dir="$tmpdir/support"
mkdir -p "$support_dir"
cp "$P12_PATH" "$support_dir/client.p12"
cp "$config_json" "$support_dir/vault-config.json"

for support_file in client.p12 vault-config.json; do
  xcrun devicectl device copy to \
    --device "$DEVICE" \
    --source "$support_dir/$support_file" \
    --destination "Documents/support/$support_file" \
    --domain-type appDataContainer \
    --domain-identifier "$BUNDLE_ID" \
    --timeout 30
done

echo "Provisioned iOS support files for bundle ${BUNDLE_ID}."
