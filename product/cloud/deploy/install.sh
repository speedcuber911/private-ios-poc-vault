#!/usr/bin/env bash
set -euo pipefail

if [[ "${EUID}" -ne 0 ]]; then
  echo "Run this installer as root." >&2
  exit 1
fi

SOURCE_DIR="${1:-}"
PUBLIC_BASE_URL="${RELAY_PUBLIC_BASE_URL:-}"
if [[ -z "$SOURCE_DIR" || ! -f "$SOURCE_DIR/package-lock.json" ]]; then
  echo "Usage: RELAY_PUBLIC_BASE_URL=https://api.example.com $0 <release-source>" >&2
  exit 2
fi
if [[ ! "$PUBLIC_BASE_URL" =~ ^https://[^/]+$ ]]; then
  echo "RELAY_PUBLIC_BASE_URL must be an HTTPS origin without a path." >&2
  exit 2
fi

command -v node >/dev/null
command -v npm >/dev/null
command -v openssl >/dev/null

if ! id relaycloud >/dev/null 2>&1; then
  useradd --system --home-dir /var/lib/relay-cloud --shell /usr/sbin/nologin relaycloud
fi

release_id="$(date -u +%Y%m%dT%H%M%SZ)"
release_dir="/opt/relay-cloud/releases/$release_id"
install -d -m 0755 -o root -g root "$release_dir"
cp -a "$SOURCE_DIR"/. "$release_dir"/
(
  cd "$release_dir"
  npm ci --omit=dev --ignore-scripts --no-audit --no-fund
)
chown -R root:root "$release_dir"

install -d -m 0755 -o root -g root /opt/relay-cloud/releases
ln -sfn "$release_dir" /opt/relay-cloud/current
install -d -m 0750 -o relaycloud -g relaycloud /var/lib/relay-cloud
install -d -m 0750 -o root -g relaycloud /etc/relay-cloud

env_path=/etc/relay-cloud/env
if [[ ! -f "$env_path" ]]; then
  host_ip="$(hostname -I | tr ' ' '\n' | awk '/^(10\.|172\.|192\.168\.)/{print; exit}')"
  if [[ -z "$host_ip" ]]; then
    echo "Could not determine the host private IP." >&2
    exit 1
  fi
  session_secret="$(openssl rand -hex 32)"
  better_auth_secret="$(openssl rand -hex 32)"
  umask 0077
  {
    printf 'HOST=%s\n' "$host_ip"
    printf 'PORT=8790\n'
    printf 'CLOUD_DB_PATH=/var/lib/relay-cloud/relay-cloud.sqlite\n'
    printf 'SESSION_SECRET=%s\n' "$session_secret"
    printf 'BETTER_AUTH_SECRET=%s\n' "$better_auth_secret"
    printf 'BETTER_AUTH_URL=%s\n' "$PUBLIC_BASE_URL"
    printf 'APPLE_CLIENT_IDS=com.parikshit.pocvault\n'
    printf 'APPLE_CLIENT_SECRET=\n'
    printf 'DEFAULT_MAX_NODES=1\n'
    printf 'MAGIC_LINK_BASE_URL=%s/auth/confirm\n' "$PUBLIC_BASE_URL"
  } >"$env_path"
  chown root:relaycloud "$env_path"
  chmod 0640 "$env_path"
fi

install -m 0644 "$release_dir/deploy/relay-cloud.service" /etc/systemd/system/relay-cloud.service
systemctl daemon-reload
systemctl enable relay-cloud >/dev/null
systemctl restart relay-cloud

host_ip="$(awk -F= '$1 == "HOST" {print $2}' "$env_path")"
for attempt in {1..20}; do
  if curl -fsS "http://$host_ip:8790/healthz" >/dev/null; then
    echo "relay-cloud installed and healthy"
    exit 0
  fi
  sleep 1
done

systemctl status relay-cloud --no-pager >&2 || true
exit 1
