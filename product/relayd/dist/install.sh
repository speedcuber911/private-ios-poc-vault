#!/usr/bin/env bash
# relayd installer — W2-MODULES. Targets Ubuntu/Debian (apt-based) hosts.
#
# What it does:
#   1. sanity checks (root, apt, arch, openssl, git)
#   2. installs a bundled Node 22 runtime under /opt/relayd/node if the
#      system node is missing or too old
#   3. runs as the human who invoked it (RELAYD_RUN_USER overrides; falls back
#      to a `relay` system account), and seeds a workspace jail
#   4. copies the relayd app to /opt/relayd/releases/<version> and points
#      /opt/relayd/current at it, then installs the release public key
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
# The releases/<version> + `current` symlink layout (spec 2026-09-21).
#
# The old installer copied over the LIVE directory, /opt/relayd/app, which is
# why there was never anything to roll back to: an upgrade destroyed the only
# copy of the previous build as its first act. Each release now gets its own
# immutable directory and `current` is what the systemd unit runs, so a flip is
# one rename and a rollback is the same rename in reverse. relayd's own
# self-update (src/update.mjs) expects exactly this shape, and a node installed
# the old way cannot be updated by it at all — so fresh installs adopt it too,
# not just upgrades.
RELAYD_ROOT="/opt/relayd"
RELEASES_DIR="$RELAYD_ROOT/releases"
CURRENT_LINK="$RELAYD_ROOT/current"
LEGACY_APP_DIR="$RELAYD_ROOT/app"
# The public half of the OFFLINE release signing key. update.mjs verifies every
# artifact against this before it unpacks anything, which is what stops a
# compromised control plane from being able to author code a node will run.
RELEASE_PUBKEY_DEST="$RELAYD_ROOT/release-pubkey.pem"
NODE_DIR="/opt/relayd/node"
DATA_DIR="/var/lib/relayd"
JAIL_DIR="/srv/relay-workspaces"
ENV_FILE="/etc/relayd/relayd.env"
# Who relayd runs as.
#
# It used to always be a locked-down `relay` system account with its own empty
# home. That was right when the node was OUR machine running someone else's
# agent. It is wrong for bring-your-own-machine, and wrong in a way that looks
# like four unrelated bugs: the file browser shows one empty folder, the agent
# cannot see any of your code, `codex`/`claude` appear "not logged in" because
# their credentials live in YOUR home, and reading threads fails with EACCES on
# a ~/.codex the daemon may not even traverse.
#
# So it defaults to the human who ran the installer. Set RELAYD_RUN_USER=relay
# to get the old isolated account back (appropriate if you are hosting a node
# for somebody else).
RUN_USER="${RELAYD_RUN_USER:-${SUDO_USER:-relay}}"
if [ "$RUN_USER" = "root" ]; then RUN_USER="relay"; fi
PAIRING_PORT="8788"

log() { printf '[relayd-install] %s\n' "$*"; }
die() { printf '[relayd-install] ERROR: %s\n' "$*" >&2; exit 1; }

# The address this machine believes it is reachable on, used for the QR and
# the TLS SAN list. RELAYD_PUBLIC_HOST in the environment wins, because the
# installer's guess cannot be right on a NATed cloud VM — there the phone
# arrives on a public address this machine never sees on any interface.
#
# `ip route get` asks the kernel which source address it would use to reach the
# internet, which beats `hostname -I` (returns every address, docker0 included,
# in no useful order) and beats `hostname -f` (frequently an unresolvable name).
# Falls back to loopback, which is honest: it pairs over an SSH tunnel and the
# post-install summary says so.
detect_public_host() {
  if [ -n "${RELAYD_PUBLIC_HOST:-}" ]; then
    printf '%s' "$RELAYD_PUBLIC_HOST"
    return
  fi
  local addr=""
  if command -v ip >/dev/null 2>&1; then
    addr="$(ip -4 route get 1.1.1.1 2>/dev/null | sed -n 's/.*[[:space:]]src[[:space:]]\([0-9.]*\).*/\1/p' | head -n1)"
  fi
  if [ -z "$addr" ] && command -v hostname >/dev/null 2>&1; then
    addr="$(hostname -I 2>/dev/null | tr ' ' '\n' | grep -v '^127\.' | head -n1)"
  fi
  printf '%s' "${addr:-127.0.0.1}"
}

PUBLIC_HOST="$(detect_public_host)"

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
else
  log "running as existing user '$RUN_USER'"
fi
RUN_HOME="$(getent passwd "$RUN_USER" | cut -d: -f6)"
[ -n "$RUN_HOME" ] || RUN_HOME="/home/$RUN_USER"
RUN_GROUP="$(id -gn "$RUN_USER")"

log "creating data dir and workspace jail"
mkdir -p "$DATA_DIR"
chown "$RUN_USER:$RUN_GROUP" "$DATA_DIR"
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
chown -R "$RUN_USER:$RUN_GROUP" "$JAIL_DIR"
chmod 0750 "$JAIL_DIR"

# --- 4. app -----------------------------------------------------------------

# Which version is being installed. build-info.json is written by the
# packaging step and is the authoritative answer; a plain checkout has no such
# file, so package.json's version is the fallback — the same order src/
# version.mjs uses, deliberately, so the directory name and what the daemon
# reports on /healthz can never disagree.
read_app_version() {
  "$NODE_DIR/bin/node" -e '
    const fs = require("node:fs");
    const path = require("node:path");
    const dir = process.argv[1];
    const read = (file) => { try { return JSON.parse(fs.readFileSync(path.join(dir, file), "utf8")); } catch { return null; } };
    const clean = (value) => (typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9.+_-]{0,63}$/.test(value.trim()) ? value.trim() : null);
    const info = read("build-info.json");
    const manifest = read("package.json");
    process.stdout.write(clean(info && info.version) || clean(manifest && manifest.version) || "");
  ' "$1"
}

APP_VERSION="$(read_app_version "$APP_SRC_DIR")"
[ -n "$APP_VERSION" ] || die "cannot determine the relayd version from $APP_SRC_DIR (no usable build-info.json or package.json)"
APP_DIR="$RELEASES_DIR/$APP_VERSION"

log "installing app to $APP_DIR"
mkdir -p "$APP_DIR"
# Copy only what the daemon needs: sources, bin, package manifest, and the
# generated build identity when the artifact carries one.
rm -rf "$APP_DIR/src" "$APP_DIR/bin"
cp -R "$APP_SRC_DIR/src" "$APP_DIR/src"
cp -R "$APP_SRC_DIR/bin" "$APP_DIR/bin"
cp "$APP_SRC_DIR/package.json" "$APP_DIR/package.json"
if [ -f "$APP_SRC_DIR/build-info.json" ]; then
  cp "$APP_SRC_DIR/build-info.json" "$APP_DIR/build-info.json"
fi
chmod 0755 "$APP_DIR/bin/relayd"

# Point `current` at this release. Written as a temp symlink and renamed so a
# reader — including a systemd unit starting at that exact moment — never sees
# a `current` that does not exist. Re-running with the same version is a
# no-op flip, which is what makes this idempotent.
#
# A pre-existing /opt/relayd/app from an older installer is deliberately LEFT
# ALONE rather than deleted: it is the only copy of the build that is running
# right now, and this script is not the place to remove the operator's way
# back.
if [ -e "$CURRENT_LINK" ] && [ ! -L "$CURRENT_LINK" ]; then
  die "$CURRENT_LINK exists and is not a symlink; move it aside and re-run"
fi
CURRENT_TMP="$CURRENT_LINK.install.$$"
ln -sfn "releases/$APP_VERSION" "$CURRENT_TMP"
mv -Tf "$CURRENT_TMP" "$CURRENT_LINK"
if [ -d "$LEGACY_APP_DIR" ]; then
  log "note: the pre-$APP_VERSION copy at $LEGACY_APP_DIR is left in place; nothing runs from it once the unit restarts"
fi

# The release trust anchor. Sourced from the artifact (dist/release-pubkey.pem)
# or from the environment, and NEVER overwritten once present: replacing it
# silently would be replacing the one thing that decides which code this
# machine will accept. Rotating it is a deliberate act — remove the file first.
if [ -f "$RELEASE_PUBKEY_DEST" ]; then
  log "release public key already installed at $RELEASE_PUBKEY_DEST — leaving it untouched"
elif [ -n "${RELAYD_RELEASE_PUBKEY:-}" ]; then
  log "installing release public key from RELAYD_RELEASE_PUBKEY"
  printf '%s\n' "$RELAYD_RELEASE_PUBKEY" > "$RELEASE_PUBKEY_DEST"
elif [ -n "${RELAYD_RELEASE_PUBKEY_SRC:-}" ] && [ -f "${RELAYD_RELEASE_PUBKEY_SRC:-}" ]; then
  log "installing release public key from $RELAYD_RELEASE_PUBKEY_SRC"
  cp "$RELAYD_RELEASE_PUBKEY_SRC" "$RELEASE_PUBKEY_DEST"
elif [ -f "$APP_SRC_DIR/dist/release-pubkey.pem" ]; then
  log "installing release public key from the artifact"
  cp "$APP_SRC_DIR/dist/release-pubkey.pem" "$RELEASE_PUBKEY_DEST"
else
  log "WARNING: no release public key available, so $RELEASE_PUBKEY_DEST is absent."
  log "WARNING: relayd will REFUSE every announced update until one is installed"
  log "WARNING: (set RELAYD_RELEASE_PUBKEY or RELAYD_RELEASE_PUBKEY_SRC and re-run)."
  log "WARNING: Everything else works; only self-update is unavailable."
fi

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
    printf '%s\n' \
      '# The data listener. It is reachable on every interface because the' \
      '# phone is not on this machine — that is the entire point of the' \
      '# product. It is not unauthenticated: relayd terminates TLS itself with' \
      '# a certificate signed by its own CA, and every request needs either a' \
      '# paired device bearer token or a client certificate this node issued.' \
      '# An unauthenticated request gets 401 before it reaches any handler.' \
      '#' \
      '# Set RELAYD_DIRECT_TLS=false only if you are putting your own proxy in' \
      '# front; relayd then serves plain HTTP and trusts the X-SSL-Client-*' \
      '# headers your proxy sets, which is safe ONLY when nothing else can' \
      '# reach the port.'
    env_kv CODEX_API_HOST 0.0.0.0
    env_kv CODEX_API_PORT 8787
    env_kv CODEX_REQUIRE_MTLS true
    env_kv RELAYD_DIRECT_TLS true
    printf '%s\n' \
      '# The address the phone reaches this machine on. It goes into the QR' \
      '# code and into the TLS certificate SAN list, so the two always agree.' \
      '#' \
      '# THE DETECTED VALUE IS OFTEN WRONG ON A CLOUD VM: this is the address' \
      '# the machine sees on itself, which on EC2/GCE/Hetzner is the private' \
      '# one, while the phone arrives on the public address. If pairing fails' \
      '# with a certificate or hostname error, this is why. Set it to the' \
      '# address or hostname you actually reach, then restart relayd — the' \
      '# certificate is reissued automatically when this value changes.' \
      '# Bare IPv4 and IPv6 literals are fine; they become IP SANs.'
    env_kv RELAYD_PUBLIC_HOST "$PUBLIC_HOST"
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
    printf '%s\n' \
      '# What the phone can browse. The default is the whole machine, because' \
      '# that is what "bring your own machine" means: the agent works on your' \
      '# code, where your code already is. Narrow it to a directory if you want' \
      '# a smaller blast radius, e.g.' \
      "#     CODEX_WORKSPACE_BROWSE_ROOT='$RUN_HOME'"
    env_kv CODEX_WORKSPACE_BROWSE_ROOT "/"
    env_kv CODEX_WORKSPACES "[{\"id\":\"home\",\"name\":\"Home\",\"path\":\"$RUN_HOME\"},{\"id\":\"machine\",\"name\":\"Whole machine\",\"path\":\"/\"}]"
    env_kv CODEX_RUN_HOME "$RUN_HOME"
    env_kv RELAYD_WORKTREE_MODE false
    printf '%s\n' \
      '# Pairing listener. Still a SECOND listener, separate from the data' \
      '# port, and it still mints device credentials — but it is now reachable,' \
      '# because a phone that cannot reach it cannot pair.' \
      '#' \
      '# What makes that acceptable, and what changed: it speaks TLS from the' \
      '# node CA rather than plain HTTP, it only ever answers a single-use' \
      '# token that `relayd pair` printed on this machine less than 15 minutes' \
      '# ago, blind guesses are rate-limited per source address, and the QR' \
      '# carries a fingerprint of the CA so the phone refuses to talk to' \
      '# anything else. An attacker who cannot see your terminal has nothing to' \
      '# present.' \
      '#' \
      '# It is idle between pairings: with no live session, every request is' \
      '# refused. Set RELAYD_PAIRING_HOST=127.0.0.1 to close it off entirely' \
      '# and pair over an SSH tunnel instead.'
    env_kv RELAYD_PAIRING_ENABLED true
    env_kv RELAYD_PAIRING_HOST 0.0.0.0
    env_kv RELAYD_PAIRING_PORT "$PAIRING_PORT"
    printf '%s\n' \
      '# Self-update (spec 2026-09-21). The control plane ANNOUNCES a version' \
      '# on the long-poll this node already holds open; the node downloads the' \
      '# artifact, verifies a detached Ed25519 signature against' \
      "#     $RELEASE_PUBKEY_DEST" \
      '# stages it under releases/<version>, waits until no job or terminal is' \
      '# live, flips the `current` symlink, restarts, and rolls back if the' \
      '# new build does not report itself healthy.' \
      '#' \
      '# The signing key is offline and is NOT on the control-plane host, so a' \
      '# compromised control plane can withhold or delay an update but cannot' \
      '# author code this machine will run.' \
      '#' \
      '# RELAYD_AUTO_UPDATE=0 keeps the version reporting and the announcement' \
      '# but applies nothing until you run `relayd update`.' \
      '# RELAYD_RELEASE_CHANNEL is stable or beta. Put the machine you cannot' \
      '# afford to break on stable, and pin it with `relayd update --pin`.'
    env_kv RELAYD_AUTO_UPDATE 1
    env_kv RELAYD_RELEASE_CHANNEL stable
  } > "$ENV_TMP"
  chown "root:$RUN_USER" "$ENV_TMP"
  chmod 0640 "$ENV_TMP"
  mv -f "$ENV_TMP" "$ENV_FILE"
  trap - EXIT
else
  log "$ENV_FILE exists — leaving it untouched"
  # Except for keys that did not exist when it was written. An upgrade must not
  # rewrite the operator's config, but a node upgraded into a build that has a
  # release channel should say which channel it is on rather than leave it
  # implicit — "which machines are on beta" is the question the whole
  # subscription exists to make answerable. Append-if-absent only: an existing
  # value, including one the operator changed, is never touched, which is what
  # keeps re-running this idempotent.
  for pair in "RELAYD_AUTO_UPDATE 1" "RELAYD_RELEASE_CHANNEL stable"; do
    key="${pair%% *}"
    value="${pair##* }"
    if ! grep -qE "^[[:space:]]*(export[[:space:]]+)?$key=" "$ENV_FILE"; then
      log "adding $key to $ENV_FILE (new in this version)"
      env_kv "$key" "$value" >> "$ENV_FILE"
    fi
  done
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
# The unit ships with the historical `relay` account; point it at whoever this
# install actually runs as.
sed -i "s/^User=.*/User=$RUN_USER/; s/^Group=.*/Group=$RUN_GROUP/" /etc/systemd/system/relayd.service
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
#
# Invoked through `current` rather than through the release directory this run
# happens to have created: that is what the unit runs, so it is what an
# operator copying this line out of the log should run too.
PAIR_CMD="sudo sh -c 'set -a; . $ENV_FILE; set +a; HOME=/home/$RUN_USER PATH=$NODE_DIR/bin:\$PATH exec runuser --preserve-environment -u $RUN_USER -- $NODE_DIR/bin/node $CURRENT_LINK/bin/relayd pair'"

log "generating pairing code"
pair_ok=0
if (
  load_env_file "$ENV_FILE"
  # runuser --preserve-environment keeps our exported env but also keeps root's
  # HOME, so pin HOME/PATH to the runner user explicitly.
  export HOME="/home/$RUN_USER"
  export PATH="$NODE_DIR/bin:$PATH"
  runuser --preserve-environment -u "$RUN_USER" -- \
    "$NODE_DIR/bin/node" "$CURRENT_LINK/bin/relayd" pair
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
    export RELAYD_CONFIG_URL="file://$CURRENT_LINK/src/config.mjs"
    runuser --preserve-environment -u "$RUN_USER" -- \
      "$NODE_DIR/bin/node" --input-type=module -e \
      'const c = await import(process.env.RELAYD_CONFIG_URL);
       console.log(c.pairingEnabled && c.pairingIsLoopbackOnly() ? "loopback" : "reachable");
       console.log(c.pairingEndpointUrl());
       console.log(c.publicHost || "");
       console.log(String(c.port || ""));
       console.log(String(c.pairingPort || ""));'
  ) 2>/dev/null
}

# These come from the EFFECTIVE config, never from this script's own guesses.
# When /etc/relayd/relayd.env already exists the installer leaves it untouched,
# so $PUBLIC_HOST and $PAIRING_PORT here are what a fresh install WOULD have
# used — not what the daemon is actually running with. Printing those in the
# summary tells the operator to open the wrong ports and names an address the
# node never advertises, which is worse than saying nothing, because it is
# wrong exactly when someone is trying to work out why pairing failed.
reach_state=""
reach_url=""
reach_host=""
reach_port=""
reach_pair_port=""
if reach_out="$(pairing_reachability)"; then
  { IFS= read -r reach_state || true
    IFS= read -r reach_url || true
    IFS= read -r reach_host || true
    IFS= read -r reach_port || true
    IFS= read -r reach_pair_port || true; } <<REACH
$reach_out
REACH
fi

if [ "$pair_ok" -eq 1 ] && [ "$svc_ok" -eq 1 ]; then
  log "==========================================================="
  if [ "$reach_state" = "loopback" ]; then
    log " INSTALLED — ONE STEP LEFT before the phone can pair."
    log " The pairing listener came up on loopback, so the phone cannot reach"
    log " it. That is not the default; something in $ENV_FILE"
    log " set RELAYD_PAIRING_HOST back to 127.0.0.1. Either set it to 0.0.0.0"
    log " and restart, or pair over a tunnel:"
    log "   ssh -L $PAIRING_PORT:127.0.0.1:$PAIRING_PORT <this-host>"
    log " Then re-run pairing (codes expire after 15 minutes):"
    log "   $PAIR_CMD"
  else
    log " INSTALLED AND READY — scan the QR code above with the Relay app."
    log " Pair at: ${reach_url:-see \`relayd pair\` output}"
    log ""
    log " This machine advertises itself as ${reach_host:-$PUBLIC_HOST}."
    log " IF PAIRING FAILS WITH A CERTIFICATE OR HOSTNAME ERROR, that is why:"
    log " on a cloud VM the address the machine sees is the private one, and"
    log " your phone arrives on the public address. Set RELAYD_PUBLIC_HOST in"
    log " $ENV_FILE to the address you actually reach, restart"
    log " relayd, and run \`relayd pair\` again for a fresh QR."
    log ""
    log " Open port ${reach_pair_port:-$PAIRING_PORT} (pairing) and ${reach_port:-8787} (data) to your phone."
    log " Check what is advertised and whether it matches: relayd doctor"
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
