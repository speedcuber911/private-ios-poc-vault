#!/usr/bin/env bash
set -euo pipefail

db_path="${CLOUD_DB_PATH:-/var/lib/relay-cloud/relay-cloud.sqlite}"
backup_dir="${BACKUP_LOCAL_DIR:-/var/backups/relay-cloud}"
s3_uri="${BACKUP_S3_URI:-}"

if [[ "$db_path" != /* || "$backup_dir" != /* ]]; then
  echo "Database and backup paths must be absolute." >&2
  exit 2
fi
if [[ ! -f "$db_path" ]]; then
  echo "Relay database does not exist: $db_path" >&2
  exit 1
fi
command -v sqlite3 >/dev/null
command -v gzip >/dev/null
command -v sha256sum >/dev/null

install -d -m 0750 "$backup_dir"
temporary_dir="$(mktemp -d "$backup_dir/.backup.XXXXXX")"
trap 'rm -rf "$temporary_dir"' EXIT

stamp="$(date -u +%Y%m%dT%H%M%SZ)"
backup_name="relay-cloud-$stamp.sqlite"
backup_path="$temporary_dir/$backup_name"

sqlite3 "$db_path" ".timeout 10000" ".backup '$backup_path'"
integrity="$(sqlite3 "$backup_path" 'PRAGMA integrity_check;')"
if [[ "$integrity" != "ok" ]]; then
  echo "SQLite backup failed integrity check." >&2
  exit 1
fi

gzip -n "$backup_path"
archive="$backup_path.gz"
install -m 0640 "$archive" "$backup_dir/$backup_name.gz"
(cd "$backup_dir" && sha256sum "$backup_name.gz" >"$backup_name.gz.sha256")
chmod 0640 "$backup_dir/$backup_name.gz.sha256"

if [[ -n "$s3_uri" ]]; then
  command -v aws >/dev/null
  aws s3 cp "$backup_dir/$backup_name.gz" "${s3_uri%/}/$backup_name.gz" --only-show-errors
  aws s3 cp "$backup_dir/$backup_name.gz.sha256" "${s3_uri%/}/$backup_name.gz.sha256" --only-show-errors
fi

find "$backup_dir" -maxdepth 1 -type f -name 'relay-cloud-*.sqlite.gz' -mtime +7 -delete
find "$backup_dir" -maxdepth 1 -type f -name 'relay-cloud-*.sqlite.gz.sha256' -mtime +7 -delete
echo "Relay SQLite backup completed: $backup_name.gz"
