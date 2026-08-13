#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cli_root="$(cd "$script_dir/.." && pwd)"
output_dir="${1:-}"

if [[ -z "$output_dir" ]]; then
  echo "Usage: $0 <output-directory>" >&2
  exit 2
fi

mkdir -p "$output_dir"
output_dir="$(cd "$output_dir" && pwd)"
version="$(node -p 'require(process.argv[1]).version' "$cli_root/package.json")"
if [[ ! "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+([-.+][0-9A-Za-z.-]+)?$ ]]; then
  echo "Unsupported package version: $version" >&2
  exit 2
fi

temporary_dir="$(mktemp -d "${TMPDIR:-/tmp}/relay-cli-release.XXXXXX")"
trap 'rm -rf "$temporary_dir"' EXIT

packed_name="$(cd "$cli_root" && npm pack --ignore-scripts --silent --pack-destination "$temporary_dir" | tail -n 1)"
packed_path="$temporary_dir/$packed_name"
artifact_name="relay-cli-v${version}.tgz"
artifact_path="$output_dir/$artifact_name"

[[ -f "$packed_path" ]] || { echo "npm pack did not produce an archive" >&2; exit 1; }
mv "$packed_path" "$artifact_path"

if command -v shasum >/dev/null 2>&1; then
  checksum="$(shasum -a 256 "$artifact_path" | awk '{ print $1 }')"
else
  checksum="$(sha256sum "$artifact_path" | awk '{ print $1 }')"
fi

printf '%s  %s\n' "$checksum" "$artifact_name" >"$artifact_path.sha256"
printf '%s\n' "$version" >"$output_dir/latest.txt"
printf '%s\n' "$artifact_path"
