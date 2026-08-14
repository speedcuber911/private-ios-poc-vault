#!/usr/bin/env bash
set -euo pipefail

if [[ "${EUID}" -ne 0 ]]; then
  echo "Run this installer as root." >&2
  exit 1
fi

SOURCE_DIR="${1:-}"
PUBLIC_BASE_URL="${RELAY_PUBLIC_BASE_URL:-}"
BIND_HOST="${RELAY_CLOUD_BIND_HOST:-127.0.0.1}"
BIND_PORT="${RELAY_CLOUD_PORT:-8790}"
BACKUP_S3_URI="${RELAY_BACKUP_S3_URI:-}"
NODE_ROOT="${RELAY_NODE_ROOT:-/opt/relay-cloud/node}"
if [[ -z "$SOURCE_DIR" || ! -f "$SOURCE_DIR/package-lock.json" ]]; then
  echo "Usage: RELAY_PUBLIC_BASE_URL=https://api.example.com $0 <release-source>" >&2
  exit 2
fi
if [[ ! "$PUBLIC_BASE_URL" =~ ^https://[^/]+$ ]]; then
  echo "RELAY_PUBLIC_BASE_URL must be an HTTPS origin without a path." >&2
  exit 2
fi

command -v curl >/dev/null
command -v openssl >/dev/null
command -v sha256sum >/dev/null
command -v tar >/dev/null

case "$(uname -m)" in
  x86_64) node_arch=x64 ;;
  aarch64|arm64) node_arch=arm64 ;;
  *) echo "Unsupported architecture: $(uname -m)" >&2; exit 2 ;;
esac

install -d -m 0755 -o root -g root /opt/relay-cloud

install_node() {
  local metadata archive checksum version_dir temporary_dir
  metadata="$(mktemp)"
  temporary_dir="$(mktemp -d)"
  trap 'rm -f "$metadata"; rm -rf "$temporary_dir"' RETURN
  curl -fsSLo "$metadata" https://nodejs.org/dist/latest-v22.x/SHASUMS256.txt
  archive="$(awk -v suffix="linux-${node_arch}.tar.xz" '$2 ~ suffix "$" { print $2; exit }' "$metadata")"
  checksum="$(awk -v archive="$archive" '$2 == archive { print $1; exit }' "$metadata")"
  if [[ -z "$archive" || -z "$checksum" ]]; then
    echo "Could not resolve the current Node 22 archive for ${node_arch}." >&2
    exit 1
  fi
  version_dir="/opt/relay-cloud/${archive%.tar.xz}"
  if [[ ! -x "$version_dir/bin/node" ]]; then
    curl -fsSLo "$temporary_dir/$archive" "https://nodejs.org/dist/latest-v22.x/$archive"
    printf '%s  %s\n' "$checksum" "$temporary_dir/$archive" | sha256sum -c -
    install -d -m 0755 -o root -g root "$version_dir"
    tar -xJf "$temporary_dir/$archive" --strip-components=1 -C "$version_dir"
    chown -R root:root "$version_dir"
  fi
  ln -sfn "$version_dir" "$NODE_ROOT"
}

install_node
NODE_BIN="$NODE_ROOT/bin/node"
NPM_BIN="$NODE_ROOT/bin/npm"
"$NODE_BIN" -e 'const major=Number(process.versions.node.split(".")[0]); if (major !== 22) process.exit(1)'

if ! id relaycloud >/dev/null 2>&1; then
  useradd --system --home-dir /var/lib/relay-cloud --shell /usr/sbin/nologin relaycloud
fi

release_id="${RELAY_RELEASE_ID:-$(date -u +%Y%m%dT%H%M%SZ)}"
if [[ ! "$release_id" =~ ^[A-Za-z0-9._-]+$ ]]; then
  echo "RELAY_RELEASE_ID contains unsupported characters." >&2
  exit 2
fi
release_dir="/opt/relay-cloud/releases/$release_id"
if [[ -e "$release_dir" ]]; then
  if [[ ! -f "$release_dir/.relay-release-ready" ]]; then
    echo "Incomplete release directory already exists: $release_dir" >&2
    exit 1
  fi
  reuse_release=true
else
  reuse_release=false
fi
if [[ "$reuse_release" == false ]]; then
  install -d -m 0755 -o root -g root "$release_dir"
  cp -a "$SOURCE_DIR"/. "$release_dir"/
  (
    cd "$release_dir"
    PATH="$NODE_ROOT/bin:/usr/bin:/bin" "$NPM_BIN" ci --omit=dev --ignore-scripts --no-audit --no-fund
  )
  touch "$release_dir/.relay-release-ready"
  chown -R root:root "$release_dir"
  # Host umask 0077 (and `cp -a` of a mktemp source) can leave the tree
  # 0700/0600 root:root. Directories-only chmod makes systemd CHDIR succeed
  # and then node fails opening main.js as relaycloud. a+rX: everyone can
  # read; execute only on dirs and files that already have an execute bit.
  chmod -R a+rX "$release_dir"
fi

install -d -m 0755 -o root -g root /opt/relay-cloud/releases
previous_release="$(readlink -f /opt/relay-cloud/current 2>/dev/null || true)"
ln -sfn "$release_dir" /opt/relay-cloud/current
install -d -m 0750 -o relaycloud -g relaycloud /var/lib/relay-cloud
install -d -m 0750 -o root -g relaycloud /etc/relay-cloud
install -d -m 0750 -o root -g root /var/backups/relay-cloud

env_path=/etc/relay-cloud/env
if [[ ! -f "$env_path" ]]; then
  session_secret="$(openssl rand -hex 32)"
  better_auth_secret="$(openssl rand -hex 32)"
  admin_token="$(openssl rand -hex 32)"
  broker_token="$(openssl rand -hex 32)"
  umask 0077
  {
    printf 'HOST=%s\n' "$BIND_HOST"
    printf 'PORT=%s\n' "$BIND_PORT"
    printf 'CLOUD_DB_PATH=/var/lib/relay-cloud/relay-cloud.sqlite\n'
    printf 'SESSION_SECRET=%s\n' "$session_secret"
    printf 'BETTER_AUTH_SECRET=%s\n' "$better_auth_secret"
    printf 'BETTER_AUTH_URL=%s\n' "$PUBLIC_BASE_URL"
    printf 'APPLE_CLIENT_IDS=com.parikshit.pocvault\n'
    printf 'APPLE_CLIENT_SECRET=\n'
    printf 'DEFAULT_MAX_NODES=1\n'
    printf 'MAGIC_LINK_BASE_URL=%s/auth/confirm\n' "$PUBLIC_BASE_URL"
    printf 'ADMIN_TOKEN=%s\n' "$admin_token"
    printf 'BROKER_TOKEN=%s\n' "$broker_token"
    if [[ -n "$BACKUP_S3_URI" ]]; then
      printf 'BACKUP_S3_URI=%s\n' "$BACKUP_S3_URI"
    fi
  } >"$env_path"
  chown root:relaycloud "$env_path"
  chmod 0640 "$env_path"
fi

install -m 0644 "$release_dir/deploy/relay-cloud.service" /etc/systemd/system/relay-cloud.service
if [[ -f "$release_dir/deploy/relay-cloud-backup.service" ]]; then
  install -m 0644 "$release_dir/deploy/relay-cloud-backup.service" /etc/systemd/system/relay-cloud-backup.service
  install -m 0644 "$release_dir/deploy/relay-cloud-backup.timer" /etc/systemd/system/relay-cloud-backup.timer
  chmod 0750 "$release_dir/deploy/backup-sqlite.sh"
  chmod 0750 "$release_dir/deploy/verify-backup.sh"
fi
systemctl daemon-reload
systemctl enable relay-cloud >/dev/null
if [[ -f /etc/systemd/system/relay-cloud-backup.timer ]]; then
  systemctl enable --now relay-cloud-backup.timer >/dev/null
fi
systemctl restart relay-cloud

host_ip="$(awk -F= '$1 == "HOST" {print $2}' "$env_path")"
host_port="$(awk -F= '$1 == "PORT" {print $2}' "$env_path")"
for attempt in {1..20}; do
  if curl -fsS "http://$host_ip:$host_port/healthz" >/dev/null; then
    find /var/lib/relay-cloud -maxdepth 1 -type f -name 'relay-cloud.sqlite*' \
      -exec chown relaycloud:relaycloud {} + \
      -exec chmod 0600 {} +
    echo "relay-cloud release $release_id installed and healthy"
    exit 0
  fi
  sleep 1
done

systemctl status relay-cloud --no-pager >&2 || true
if [[ -n "$previous_release" && -d "$previous_release" ]]; then
  echo "Health check failed; restoring previous release." >&2
  ln -sfn "$previous_release" /opt/relay-cloud/current
  systemctl restart relay-cloud || true
fi
exit 1
