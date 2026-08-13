#!/bin/sh
set -eu

# Relay CLI per-user installer. The stable copy is served by CloudFront while
# versioned archives and checksums live in the private S3 origin.

product_name="Relay CLI"
default_base_url="https://get.relay.ai-rocket-experiments.com"
base_url="${RELAY_INSTALL_BASE_URL:-$default_base_url}"
install_root="${RELAY_INSTALL_ROOT:-${XDG_DATA_HOME:-$HOME/.local/share}/relay}"
bin_dir="${RELAY_BIN_DIR:-$HOME/.local/bin}"

# Relay release-signing trust root. Keep this byte-for-byte aligned with
# dist/release-public-key.pem. A release is not installed unless Node's Ed25519
# verifier accepts the detached signature over the exact archive bytes.
release_public_key='-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAnWhXUnY3p8nP+bHk1ZeKVv0V3o2FVHY5BI1YwblhRLM=
-----END PUBLIC KEY-----'

say() {
  printf '[relay-install] %s\n' "$*"
}

die() {
  printf '[relay-install] %s\n' "$*" >&2
  exit 1
}

need() {
  command -v "$1" >/dev/null 2>&1 || die "Required command not found: $1"
}

download() {
  source_url=$1
  destination=$2
  case "$source_url" in
    https://*)
      curl --proto '=https' --tlsv1.2 -fsSL "$source_url" -o "$destination"
      ;;
    http://*)
      [ "${RELAY_INSTALL_ALLOW_HTTP:-0}" = "1" ] || die "Refusing non-HTTPS download URL"
      curl -fsSL "$source_url" -o "$destination"
      ;;
    *)
      die "Unsupported download URL: $source_url"
      ;;
  esac
}

need curl
need tar
need node
need awk

node_major=$(node -p 'Number(process.versions.node.split(".")[0])' 2>/dev/null || true)
case "$node_major" in
  ''|*[!0-9]*) die "$product_name requires Node.js 20 or newer" ;;
esac
[ "$node_major" -ge 20 ] || die "$product_name requires Node.js 20 or newer (found Node.js $node_major)"

temporary_dir=$(mktemp -d "${TMPDIR:-/tmp}/relay-cli.XXXXXX")
trap 'rm -rf "$temporary_dir"' EXIT HUP INT TERM

version="${RELAY_VERSION:-}"
if [ -z "$version" ]; then
  download "$base_url/latest.txt" "$temporary_dir/latest.txt"
  version=$(tr -d ' \t\r\n' <"$temporary_dir/latest.txt")
fi

case "$version" in
  ''|*[!0-9A-Za-z.+-]*) die "Invalid release version: $version" ;;
esac

archive_name="relay-cli-v${version}.tgz"
release_url="$base_url/releases/v${version}"
archive_path="$temporary_dir/$archive_name"
checksum_path="$temporary_dir/$archive_name.sha256"
signature_path="$temporary_dir/$archive_name.sig"

say "Downloading $product_name $version"
download "$release_url/$archive_name" "$archive_path"
download "$release_url/$archive_name.sha256" "$checksum_path"
download "$release_url/$archive_name.sig" "$signature_path"

if ! RELAY_RELEASE_PUBLIC_KEY="$release_public_key" node - "$archive_path" "$signature_path" <<'NODE'
const crypto = require("node:crypto");
const fs = require("node:fs");

const archivePath = process.argv[2];
const signaturePath = process.argv[3];
const publicKey = process.env.RELAY_RELEASE_PUBLIC_KEY;
const encoded = fs.readFileSync(signaturePath, "utf8").trim();

if (!/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) process.exit(1);
const signature = Buffer.from(encoded, "base64");
if (signature.length !== 64) process.exit(1);

const archive = fs.readFileSync(archivePath);
if (!crypto.verify(null, archive, publicKey, signature)) process.exit(1);
NODE
then
  die "Release signature verification failed"
fi

say "Verified Ed25519 release signature"

expected_checksum=$(awk 'NR == 1 { print $1 }' "$checksum_path")
case "$expected_checksum" in
  ''|*[!0-9a-fA-F]*) die "Release checksum is malformed" ;;
esac
[ "${#expected_checksum}" -eq 64 ] || die "Release checksum is malformed"

if command -v shasum >/dev/null 2>&1; then
  actual_checksum=$(shasum -a 256 "$archive_path" | awk '{ print $1 }')
elif command -v sha256sum >/dev/null 2>&1; then
  actual_checksum=$(sha256sum "$archive_path" | awk '{ print $1 }')
else
  die "A SHA-256 tool is required (shasum or sha256sum)"
fi

[ "$actual_checksum" = "$expected_checksum" ] || die "Checksum verification failed"

# Refuse absolute paths and parent traversal before extracting. Release
# archives are produced by npm pack and therefore normally contain package/*.
if tar -tzf "$archive_path" | awk '
  /^\// { bad = 1 }
  {
    count = split($0, parts, "/")
    for (i = 1; i <= count; i++) if (parts[i] == "..") bad = 1
  }
  END { exit bad ? 0 : 1 }
'; then
  die "Release archive contains an unsafe path"
fi

staging_dir="$temporary_dir/package"
mkdir -p "$staging_dir"
tar -xzf "$archive_path" -C "$staging_dir" --strip-components 1

[ -f "$staging_dir/package.json" ] || die "Release archive has no package.json"
[ -f "$staging_dir/bin/relay" ] || die "Release archive has no relay executable"

actual_version=$(node -e '
  const fs = require("node:fs");
  const pkg = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
  process.stdout.write(String(pkg.version || ""));
' "$staging_dir/package.json")
[ "$actual_version" = "$version" ] || die "Release version mismatch: expected $version, found $actual_version"

versions_dir="$install_root/versions"
version_dir="$versions_dir/$version"
managed_entry="$install_root/current/bin/relay"
relay_bin="$bin_dir/relay"

mkdir -p "$versions_dir" "$bin_dir"

if [ -e "$relay_bin" ] || [ -L "$relay_bin" ]; then
  current_target=$(readlink "$relay_bin" 2>/dev/null || true)
  [ "$current_target" = "$managed_entry" ] || die "$relay_bin already exists and is not managed by this installer"
fi

replacement_dir="$versions_dir/.${version}.new.$$"
mv "$staging_dir" "$replacement_dir"
chmod 0755 "$replacement_dir/bin/relay"

previous_dir=""
if [ -e "$version_dir" ]; then
  previous_dir="$versions_dir/.${version}.old.$$"
  mv "$version_dir" "$previous_dir"
fi
if ! mv "$replacement_dir" "$version_dir"; then
  [ -z "$previous_dir" ] || mv "$previous_dir" "$version_dir"
  die "Could not activate Relay CLI $version"
fi
[ -z "$previous_dir" ] || rm -rf "$previous_dir"

if [ -e "$install_root/current" ] && [ ! -L "$install_root/current" ]; then
  die "$install_root/current exists and is not a managed symlink"
fi
rm -f "$install_root/current"
ln -s "$version_dir" "$install_root/current"

if [ ! -e "$relay_bin" ] && [ ! -L "$relay_bin" ]; then
  ln -s "$managed_entry" "$relay_bin"
fi

installed_version=$("$relay_bin" --version)
[ "$installed_version" = "$version" ] || die "Installed CLI did not report the expected version"

say "Installed $product_name $version at $relay_bin"
case ":${PATH:-}:" in
  *":$bin_dir:"*) ;;
  *) say "Add $bin_dir to PATH, then run: relay login" ;;
esac
