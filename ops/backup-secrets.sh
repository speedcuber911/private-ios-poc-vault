#!/usr/bin/env bash
set -euo pipefail

CONFIG_FILE="${POC_VAULT_CONFIG:-$HOME/.poc-vault/secrets/config.env}"
if [[ -f "$CONFIG_FILE" ]]; then
  # shellcheck disable=SC1090
  source "$CONFIG_FILE"
fi

LOCAL_SECRETS_DIR="${LOCAL_SECRETS_DIR:-$HOME/.poc-vault/secrets}"
BACKUP_DIR="${BACKUP_DIR:-$HOME/.poc-vault/backups}"
BACKUP_GPG_RECIPIENT="${BACKUP_GPG_RECIPIENT:-}"
timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
archive_base="poc-vault-secrets-${timestamp}.tar.gz"
archive_path="$BACKUP_DIR/$archive_base"

usage() {
  cat <<USAGE
Usage: $(basename "$0")

Backs up ${LOCAL_SECRETS_DIR} into ${BACKUP_DIR}. If BACKUP_GPG_RECIPIENT is
set and gpg is installed, the tarball is encrypted and the plaintext tarball is
removed after encryption.
USAGE
}

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  usage
  exit 0
fi

if [[ ! -d "$LOCAL_SECRETS_DIR" ]]; then
  echo "Secrets directory does not exist: ${LOCAL_SECRETS_DIR}" >&2
  exit 1
fi

install -d -m 0700 "$BACKUP_DIR"
tar --exclude='./backups' -C "$(dirname "$LOCAL_SECRETS_DIR")" -czf "$archive_path" "$(basename "$LOCAL_SECRETS_DIR")"
chmod 0600 "$archive_path"

final_path="$archive_path"
if [[ -n "$BACKUP_GPG_RECIPIENT" ]]; then
  if ! command -v gpg >/dev/null 2>&1; then
    echo "BACKUP_GPG_RECIPIENT is set but gpg is not installed" >&2
    exit 1
  fi
  gpg --batch --yes --encrypt --recipient "$BACKUP_GPG_RECIPIENT" --output "${archive_path}.gpg" "$archive_path"
  chmod 0600 "${archive_path}.gpg"
  rm -f "$archive_path"
  final_path="${archive_path}.gpg"
fi

if command -v shasum >/dev/null 2>&1; then
  shasum -a 256 "$final_path" >"${final_path}.sha256"
elif command -v sha256sum >/dev/null 2>&1; then
  sha256sum "$final_path" >"${final_path}.sha256"
fi
chmod 0600 "${final_path}.sha256" 2>/dev/null || true

echo "Created backup: ${final_path}"
