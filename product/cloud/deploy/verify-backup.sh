#!/usr/bin/env bash
set -euo pipefail

archive="${1:-}"
if [[ -z "$archive" || ! -f "$archive" ]]; then
  echo "Usage: $0 <relay-cloud-backup.sqlite.gz>" >&2
  exit 2
fi
command -v gzip >/dev/null
command -v sqlite3 >/dev/null

checksum_file="$archive.sha256"
if [[ -f "$checksum_file" ]]; then
  (cd "$(dirname "$archive")" && sha256sum -c "$(basename "$checksum_file")")
fi

temporary_dir="$(mktemp -d)"
trap 'rm -rf "$temporary_dir"' EXIT
restored="$temporary_dir/relay-cloud-restored.sqlite"
gzip -dc "$archive" >"$restored"

integrity="$(sqlite3 "$restored" 'PRAGMA integrity_check;')"
if [[ "$integrity" != "ok" ]]; then
  echo "Restored SQLite database failed integrity check." >&2
  exit 1
fi

table_count="$(sqlite3 "$restored" "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table';")"
if [[ ! "$table_count" =~ ^[0-9]+$ || "$table_count" -lt 1 ]]; then
  echo "Restored SQLite database has no tables." >&2
  exit 1
fi

echo "Relay SQLite backup verified: integrity=ok tables=$table_count"
