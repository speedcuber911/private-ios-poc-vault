#!/usr/bin/env bash
# relayd installer — W2-MODULES. Targets Ubuntu/Debian (apt-based) hosts.
#
# What it does:
#   1. sanity checks (root, apt, arch, openssl, git)
#   2. installs a bundled Node 22 runtime under /opt/relayd/node if the
#      system node is missing or too old
#   3. creates the `relay` runner user, the workspace jail
#      (/srv/relay-workspaces) and a seeded `welcome` workspace
#   4. copies the relayd app to /opt/relayd/app
#   5. writes /etc/relayd/relayd.env (0640 root:relay) with safe defaults
#   6. installs + enables the systemd unit
#   7. prints the pairing code/link via `relayd pair`
#   8. prints a verdict and exits with a status that reflects it
#
# The installer is idempotent: re-running upgrades the app in place and
# leaves data, identity, and config untouched.
#
# Exit codes:
#   0  installed (service active, pairing code printed). The banner states
#      whether the phone can actually REACH the pairing listener: on a default
#      install it is loopback-only, and the banner prints the one remaining
#      step (gateway + RELAYD_PAIRING_ADVERTISE, or an SSH tunnel).
#   1  a prerequisite/install step failed (see the ERROR line)
#   3  installed but NOT paired — the daemon or `relayd pair` needs attention;
#      a retry command is printed on stderr.

set -euo pipefail

NODE_VERSION="22.23.1"
APP_SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP_DIR="/opt/relayd/app"
NODE_DIR="/opt/relayd/node"
DATA_DIR="/var/lib/relayd"
JAIL_DIR="/srv/relay-workspaces"
ENV_FILE="/etc/relayd/relayd.env"
RUN_USER="relay"
PAIRING_PORT="8788"

log() { printf '[relayd-install] %s\n' "$*"; }
die() { printf '[relayd-install] ERROR: %s\n' "$*" >&2; exit 1; }

# --- env-file helpers -------------------------------------------------------
#
# /etc/relayd/relayd.env has two consumers with different parsers:
#   * systemd (EnvironmentFile=) — KEY=VALUE, strips one layer of matching
#     single OR double quotes, no shell expansion.
#   * humans / this installer — `. relayd.env` from a shell.
# Values are therefore written SINGLE-quoted: that is the only quoting style
# both parsers agree on. Double quotes would let a shell eat the inner quotes
# of the CODEX_WORKSPACES JSON; bare values would let it eat them *and* split
# on whitespace.

# env_kv KEY VALUE -> one single-quoted assignment line on stdout.
env_kv() {
  case "$2" in
    *"'"*) die "refusing to write $1: value contains a single quote, which systemd's EnvironmentFile parser cannot escape" ;;
  esac
  printf "%s='%s'\n" "$1" "$2"
}

# load_env_file FILE — export every assignment using systemd's rules.
# Deliberately does NOT source the file: no command substitution, no glob, no
# word splitting, and it copes with legacy unquoted files written by older
# installers as well as the quoted files we write now.
load_env_file() {
  local line key value
  while IFS= read -r line || [ -n "$line" ]; do
    line="${line#"${line%%[![:space:]]*}"}"   # left-trim
    case "$line" in
      ''|'#'*) continue ;;
      *'='*) ;;
      *) continue ;;
    esac
    key="${line%%=*}"
    key="${key%"${key##*[![:space:]]}"}"      # right-trim key
    key="${key#export }"
    value="${line#*=}"
    case "$key" in
      ''|[!A-Za-z_]*|*[!A-Za-z0-9_]*) continue ;;
    esac
    if [ "${#value}" -ge 2 ]; then
      case "$value" in
        "'"*"'") value="${value#\'}"; value="${value%\'}" ;;
        '"'*'"') value="${value#\"}"; value="${value%\"}" ;;
      esac
    fi
    export "$key=$value"
  done < "$1"
}

# env_file_needs_quoting FILE — true (0) if some value is unquoted yet holds a
# character a shell would mangle when sourcing. Used to warn about env files
# written by older, buggy installer versions (we never rewrite user config).
env_file_needs_quoting() {
  local line value
  while IFS= read -r line || [ -n "$line" ]; do
    line="${line#"${line%%[![:space:]]*}"}"
    case "$line" in
      ''|'#'*) continue ;;
      *'='*) ;;
      *) continue ;;
    esac
    value="${line#*=}"
    case "$value" in
      "'"*"'"|'"'*'"') continue ;;
    esac
    case "$value" in
      *[\ \"\'\$\`\(\)\{\}\[\]\|\&\;\<\>\*\?]*) return 0 ;;
    esac
  done < "$1"
  return 1
}

# --- 1. sanity checks -------------------------------------------------------

[ "$(id -u)" -eq 0 ] || die "must run as root (sudo)"
command -v apt-get >/dev/null 2>&1 || die "this installer supports Ubuntu/Debian (apt-get) only"
command -v systemctl >/dev/null 2>&1 || die "systemd is required"

ARCH="$(uname -m)"
case "$ARCH" in
  x86_64) NODE_ARCH="x64" ;;
  aarch64|arm64) NODE_ARCH="arm64" ;;
  *) die "unsupported architecture: $ARCH" ;;
esac

log "installing prerequisites (openssl, git, curl, ca-certificates)"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq openssl git curl ca-certificates xz-utils >/dev/null

# --- 2. runtime -------------------------------------------------------------

need_node=1
if [ -x "$NODE_DIR/bin/node" ]; then
  need_node=0
elif command -v node >/dev/null 2>&1; then
  SYS_MAJOR="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
  if [ "$SYS_MAJOR" -ge 22 ]; then
    # Symlink the system runtime into place so the unit has one stable path.
    mkdir -p "$NODE_DIR/bin"
    ln -sf "$(command -v node)" "$NODE_DIR/bin/node"
    need_node=0
  fi
fi

if [ "$need_node" -eq 1 ]; then
  log "fetching Node ${NODE_VERSION} (${NODE_ARCH})"
  TARBALL="node-v${NODE_VERSION}-linux-${NODE_ARCH}.tar.xz"
  TMP_TARBALL="$(mktemp /tmp/relayd-node.XXXXXX.tar.xz)"
  curl -fsSL "https://nodejs.org/dist/v${NODE_VERSION}/${TARBALL}" -o "$TMP_TARBALL"
  mkdir -p "$NODE_DIR"
  tar -xJf "$TMP_TARBALL" -C "$NODE_DIR" --strip-components=1
  rm -f "$TMP_TARBALL"
fi
"$NODE_DIR/bin/node" --version >/dev/null || die "node runtime failed to install"

# --- 3. runner user + jail --------------------------------------------------

if ! id -u "$RUN_USER" >/dev/null 2>&1; then
  log "creating runner user '$RUN_USER'"
  useradd --system --create-home --home-dir "/home/$RUN_USER" --shell /usr/sbin/nologin "$RUN_USER"
fi

log "creating data dir and workspace jail"
mkdir -p "$DATA_DIR"
chown "$RUN_USER:$RUN_USER" "$DATA_DIR"
chmod 0750 "$DATA_DIR"

mkdir -p "$JAIL_DIR/welcome"
if [ ! -f "$JAIL_DIR/welcome/README.md" ]; then
  cat > "$JAIL_DIR/welcome/README.md" <<'WELCOME'
# Welcome to Relay

This folder is your first workspace. Every agent task you launch from the
phone runs inside a workspace under this directory — the agent cannot read
or write anything outside it.

Things to try from the app:

1. Ask for a summary of this file.
2. Create a new workspace and ask the agent to scaffold a project in it.
3. Browse the files the agent produced, right from the app.
WELCOME
fi
chown -R "$RUN_USER:$RUN_USER" "$JAIL_DIR"
chmod 0750 "$JAIL_DIR"

# --- 4. app -----------------------------------------------------------------

log "installing app to $APP_DIR"
mkdir -p "$APP_DIR"
# Copy only what the daemon needs: sources, bin, package manifest.
rm -rf "$APP_DIR/src" "$APP_DIR/bin"
cp -R "$APP_SRC_DIR/src" "$APP_DIR/src"
cp -R "$APP_SRC_DIR/bin" "$APP_DIR/bin"
cp "$APP_SRC_DIR/package.json" "$APP_DIR/package.json"
chmod 0755 "$APP_DIR/bin/relayd"
chown -R root:root /opt/relayd
chmod -R a+rX /opt/relayd

# --- 5. config --------------------------------------------------------------

if [ ! -f "$ENV_FILE" ]; then
  log "writing $ENV_FILE"
  mkdir -p /etc/relayd
  # Write to a temp file first so a failure never leaves a half-written config.
  ENV_TMP="$(mktemp /etc/relayd/.relayd.env.XXXXXX)"
  # env_kv die()s on a value it cannot quote, and die() exits immediately —
  # without this trap that path left a .relayd.env.XXXXXX behind in /etc/relayd
  # every time, because the mv below is never reached.
  trap 'rm -f "$ENV_TMP"' EXIT
  {
    printf '%s\n' \
      '# relayd environment — see dist/relayd.config.example.json for all knobs.' \
      '# mTLS stays ON: the data path requires a device client certificate.' \
      '#' \
      '# Every value is single-quoted so that this file is valid BOTH for' \
      "# systemd's EnvironmentFile= parser and for \`. $ENV_FILE\` in a shell." \
      '# Keep it that way when you edit: unquoted values with spaces, quotes or' \
      '# JSON get mangled the moment anything sources this file.'
    env_kv CODEX_API_HOST 127.0.0.1
    env_kv CODEX_API_PORT 8787
    env_kv CODEX_REQUIRE_MTLS true
    printf '%s\n' \
      '# Allowed client-cert subject DNs (filled by pairing/gateway setup —' \
      '# placeholders only, never commit real subjects).' \
      '#' \
      '# USE THE JSON-ARRAY FORM. An RFC 2253 DN CONTAINS commas, so a' \
      '# comma-separated list cannot express one: pasting' \
      '#     CN=device,OU=Devices,O=Relay' \
      '# is read as three fragments, none of which matches anything, and that' \
      '# device is refused with 403 forever. The array form is the only one that' \
      '# survives a multi-RDN DN on a single line, and it is quoted correctly' \
      '# both here and by systemd:' \
      "#     CODEX_ALLOWED_CERT_SUBJECTS='[\"CN=device,OU=Devices,O=Relay\"]'" \
      '# One complete DN per line also works. Comma-separated is legacy, kept' \
      '# only for the single-RDN values already deployed.' \
      '# RELAYD_ALLOWED_CERT_SUBJECTS, if set, takes precedence over this key.'
    env_kv CODEX_ALLOWED_CERT_SUBJECTS ''
    env_kv CODEX_DATA_DIR "$DATA_DIR"
    env_kv RELAYD_IDENTITY_DIR "$DATA_DIR/identity"
    env_kv RELAYD_STORE json
    env_kv CODEX_WORKSPACE_BROWSE_ROOT "$JAIL_DIR"
    env_kv CODEX_WORKSPACES "[{\"id\":\"welcome\",\"name\":\"Welcome\",\"path\":\"$JAIL_DIR/welcome\"}]"
    env_kv CODEX_RUN_HOME "/home/$RUN_USER"
    env_kv RELAYD_WORKTREE_MODE false
    printf '%s\n' \
      '# Pairing listener. It is a SECOND listener, separate from the data port,' \
      '# it speaks plain HTTP and it MINTS device certificates — so it is bound' \
      '# to loopback and these keys are written explicitly: relayd binds no' \
      '# address you did not name here. To let the phone reach it, front it with' \
      '# your TLS gateway (and set RELAYD_PAIRING_ADVERTISE to the public URL) or' \
      '# use an SSH tunnel. Only move RELAYD_PAIRING_HOST off 127.0.0.1 if you' \
      '# accept an unauthenticated cert-minting endpoint on that interface.'
    env_kv RELAYD_PAIRING_ENABLED true
    env_kv RELAYD_PAIRING_HOST 127.0.0.1
    env_kv RELAYD_PAIRING_PORT "$PAIRING_PORT"
  } > "$ENV_TMP"
  chown "root:$RUN_USER" "$ENV_TMP"
  chmod 0640 "$ENV_TMP"
  mv -f "$ENV_TMP" "$ENV_FILE"
  trap - EXIT
else
  log "$ENV_FILE exists — leaving it untouched"
  if env_file_needs_quoting "$ENV_FILE"; then
    log "WARNING: $ENV_FILE has unquoted values containing shell metacharacters."
    log "WARNING: systemd reads them fine, but sourcing the file in a shell will"
    log "WARNING: mangle them (JSON loses its quotes). Wrap those values in single"
    log "WARNING: quotes, e.g.  CODEX_WORKSPACES='[{\"id\":\"welcome\", ...}]'"
  fi
fi

# --- 6. systemd unit --------------------------------------------------------

log "installing systemd unit"
cp "$APP_SRC_DIR/dist/relayd.service" /etc/systemd/system/relayd.service
systemctl daemon-reload
systemctl enable relayd.service >/dev/null
systemctl restart relayd.service

# Outbound reachability check (broker/tunnel prerequisite) — informational.
if curl -fsS -m 5 https://nodejs.org >/dev/null 2>&1; then
  log "outbound HTTPS: ok"
else
  log "WARNING: outbound HTTPS check failed — the tunnel needs outbound 443"
fi

# --- 7. pairing printout ----------------------------------------------------

# The bundled runtime is NOT on the relay user's PATH and bin/relayd's shebang
# resolves a bare `node`, so relayd must always be invoked as
# `<node-dir>/bin/node <app-dir>/bin/relayd ...`, never as `bin/relayd` alone.
PAIR_CMD="sudo sh -c 'set -a; . $ENV_FILE; set +a; HOME=/home/$RUN_USER PATH=$NODE_DIR/bin:\$PATH exec runuser --preserve-environment -u $RUN_USER -- $NODE_DIR/bin/node $APP_DIR/bin/relayd pair'"

log "generating pairing code"
pair_ok=0
if (
  load_env_file "$ENV_FILE"
  # runuser --preserve-environment keeps our exported env but also keeps root's
  # HOME, so pin HOME/PATH to the runner user explicitly.
  export HOME="/home/$RUN_USER"
  export PATH="$NODE_DIR/bin:$PATH"
  runuser --preserve-environment -u "$RUN_USER" -- \
    "$NODE_DIR/bin/node" "$APP_DIR/bin/relayd" pair
); then
  pair_ok=1
fi

# --- 8. verdict -------------------------------------------------------------

svc_ok=0
if systemctl is-active --quiet relayd.service; then svc_ok=1; fi

# Ask relayd's OWN config whether the phone can reach the pairing listener —
# the same predicate `relayd pair` prints its NOTE from. On a default install
# the answer is "loopback", so a banner that said "READY" was contradicting the
# note printed four lines above it: the last mile was missing.
# Prints two lines: "loopback"|"reachable" and the endpoint URL.
pairing_reachability() {
  (
    load_env_file "$ENV_FILE"
    export HOME="/home/$RUN_USER"
    export PATH="$NODE_DIR/bin:$PATH"
    export RELAYD_CONFIG_URL="file://$APP_DIR/src/config.mjs"
    runuser --preserve-environment -u "$RUN_USER" -- \
      "$NODE_DIR/bin/node" --input-type=module -e \
      'const c = await import(process.env.RELAYD_CONFIG_URL);
       console.log(c.pairingEnabled && c.pairingIsLoopbackOnly() ? "loopback" : "reachable");
       console.log(c.pairingEndpointUrl());'
  ) 2>/dev/null
}

reach_state=""
reach_url=""
if reach_out="$(pairing_reachability)"; then
  { IFS= read -r reach_state || true; IFS= read -r reach_url || true; } <<REACH
$reach_out
REACH
fi

if [ "$pair_ok" -eq 1 ] && [ "$svc_ok" -eq 1 ]; then
  log "==========================================================="
  if [ "$reach_state" = "loopback" ]; then
    log " INSTALLED — ONE STEP LEFT before the phone can pair."
    log " The pairing listener is on loopback (${reach_url:-http://127.0.0.1:$PAIRING_PORT/v1/pair}),"
    log " so the phone cannot reach it yet. It mints device certificates over"
    log " plain HTTP — do NOT simply expose it. Pick one:"
    log "   * front it with your TLS gateway, then set RELAYD_PAIRING_ADVERTISE"
    log "     to the public URL in $ENV_FILE and restart relayd"
    log "   * ssh -L $PAIRING_PORT:127.0.0.1:$PAIRING_PORT <this-host>  (tunnel, then pair)"
    log " Then pair the phone with the code above (re-run pairing if it expires):"
    log "   $PAIR_CMD"
  else
    log " INSTALLED AND READY — pair the phone with the code above."
    log " Pair at: ${reach_url:-see \`relayd pair\` output}"
  fi
  log " status: systemctl status relayd"
  log "==========================================================="
  exit 0
fi

{
  printf '\n'
  printf '[relayd-install] ###########################################################\n'
  printf '[relayd-install] # INSTALLED BUT NOT PAIRED — the node is NOT usable yet.  #\n'
  printf '[relayd-install] ###########################################################\n'
  [ "$svc_ok" -eq 1 ] || printf '[relayd-install] relayd.service is not active. Inspect: journalctl -u relayd -n 50 --no-pager\n'
  [ "$pair_ok" -eq 1 ] || printf '[relayd-install] `relayd pair` failed — no pairing code was printed.\n'
  [ "$pair_ok" -eq 1 ] || printf '[relayd-install] Retry with:\n\n  %s\n\n' "$PAIR_CMD"
} >&2
exit 3
