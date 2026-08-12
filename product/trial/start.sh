#!/usr/bin/env bash
# Trial sandbox init: wait for config, enroll once (idempotent), pair
# best-effort, then run relayd tunneled. Configuration is delivered by
# relay-cloud as a JSON file written through envd AFTER the sandbox exists —
# not as container env, which a snapshot-restored sandbox can never see (see
# the enrollment section). Runs as PID 1 with no supervisor to recover from a
# bad exit, so nothing but a genuinely unrecoverable state may abort it.
set -euo pipefail

export CODEX_DATA_DIR="${CODEX_DATA_DIR:-/var/lib/relayd}"
export RELAYD_IDENTITY_DIR="${RELAYD_IDENTITY_DIR:-/var/lib/relayd/identity}"
export CODEX_WORKSPACE_BROWSE_ROOT="${CODEX_WORKSPACE_BROWSE_ROOT:-/srv/relay-workspaces}"
if [ -z "${CODEX_WORKSPACES:-}" ]; then
  export CODEX_WORKSPACES='[{"id":"welcome","name":"Welcome","path":"/srv/relay-workspaces/welcome"}]'
fi
export CODEX_RUN_HOME="${CODEX_RUN_HOME:-/home/relay}"
export RELAYD_STORE="${RELAYD_STORE:-sqlite}"

RELAYD_BIN=/opt/relayd/app/bin/relayd
# Device-token authentication for this machine. Pairing derives the token from
# the pairing secret and writes only its SHA-256 here; relayd then requires a
# bearer token on every request instead of a client certificate, which iOS
# cannot supply to a machine whose certificate it did not itself anchor. Until
# pairing writes the file, every request is rejected — the machine is never
# open.
export RELAYD_DEVICE_TOKEN_HASH_FILE="${CODEX_DATA_DIR}/device-token.hash"
ENROLL_MARKER="${CODEX_DATA_DIR}/enrolled"
PAIR_MARKER="${CODEX_DATA_DIR}/paired"
# Written into the running sandbox by relay-cloud through envd's file API.
ENROLL_CONFIG="${CODEX_DATA_DIR}/enroll.json"

mkdir -p "${CODEX_DATA_DIR}"

# ── enrollment ───────────────────────────────────────────────────────────────
# Once-only and must succeed. The cloud burns the single-use token and flips
# the trial row to `ready` on the FIRST call, so a second attempt can only
# 401 — and with the row already `ready`, POST /v1/trial-nodes 409s forever,
# so neither the user nor the reaper could issue a replacement before the
# 7-day TTL. That makes a re-run a permanent brick, which is why the marker is
# written the instant enrollment returns 0 and strictly BEFORE pairing is
# attempted. Pairing must never be able to send the next boot back through an
# already-spent token.
#
# Cube does NOT boot this image per sandbox. It boots it once to build the
# template — snapshotting the running machine, this script included — and then
# RESTORES every sandbox from that snapshot. So by the time the control plane
# knows which trial a sandbox belongs to, this script is already running and
# its environment is frozen: create-time `envVars` never reach it (proven — a
# sandbox ran for ten minutes with RELAYD_ENROLL_TOKEN set at create and the
# control plane logged zero enroll attempts).
#
# Configuration therefore arrives the only way into a running sandbox: written
# as a file through envd, the in-container daemon Cube reaches on :49983. This
# script waits for that file. Waiting is also what keeps the template build
# working — the base entrypoint runs envd in the background and this script in
# the FOREGROUND, so exiting here kills the container and envd with it, and
# CubeMaster's readiness probe fails with `connection refused`.
if [ ! -f "${ENROLL_MARKER}" ]; then
  echo "relay: waiting for enrollment config at ${ENROLL_CONFIG}" >&2
  while [ ! -f "${ENROLL_CONFIG}" ]; do
    sleep 2
  done
  echo "relay: enrollment config received" >&2

  # The token and pairing secret are read by relayd straight out of the file
  # and are deliberately NEVER exported, so nothing the daemon later spawns
  # can inherit them.
  RELAYD_ENROLL_CONFIG="${ENROLL_CONFIG}" node "${RELAYD_BIN}" enroll --no-pair
  touch "${ENROLL_MARKER}"
fi

# Tunnel settings are frozen in the snapshot for the same reason, so they come
# from the same file. These are not secrets (broker address and SNI suffix),
# but they still must not be word-split or re-interpreted by the shell — node
# emits them single-quoted so a value can never break out into a command.
if [ -f "${ENROLL_CONFIG}" ]; then
  node -e '
    const fs = require("node:fs");
    const cfg = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    const q = (v) => "'"'"'" + String(v).replace(/'"'"'/g, "'"'"'\\'"'"''"'"'") + "'"'"'";
    const out = [];
    if (cfg.tunnelHost) out.push("RELAYD_TUNNEL_HOST=" + q(cfg.tunnelHost));
    if (cfg.tunnelPort) out.push("RELAYD_TUNNEL_PORT=" + q(cfg.tunnelPort));
    if (cfg.tunnelSuffix) out.push("RELAYD_TUNNEL_SUFFIX=" + q(cfg.tunnelSuffix));
    fs.writeFileSync(process.argv[2], out.join("\n") + "\n", { mode: 0o600 });
  ' "${ENROLL_CONFIG}" "${CODEX_DATA_DIR}/tunnel.env"
  set -a
  # shellcheck disable=SC1090
  . "${CODEX_DATA_DIR}/tunnel.env"
  set +a
fi

# ── server TLS material ──────────────────────────────────────────────────────
# The control plane may supply a publicly-trusted certificate for this node's
# name. relayd prefers it over signing its own, because a phone that has to
# override server trust gets no client-certificate challenge from iOS at all,
# and mTLS to this node then cannot complete.
#
# Written by node rather than the shell so the PEMs survive verbatim; the key
# is created 0600 before anything is written into it, and both are removed if
# either is missing so relayd never starts on half a pair.
TLS_DIR="${CODEX_DATA_DIR}/tls"
mkdir -p "${TLS_DIR}"
chmod 700 "${TLS_DIR}"
if node -e '
  const fs = require("node:fs");
  const cfg = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
  if (!cfg.tlsCert || !cfg.tlsKey) process.exit(1);
  fs.writeFileSync(process.argv[2], cfg.tlsCert, { mode: 0o644 });
  fs.writeFileSync(process.argv[3], cfg.tlsKey, { mode: 0o600 });
' "${ENROLL_CONFIG}" "${TLS_DIR}/server.cert.pem" "${TLS_DIR}/server.key.pem" 2>/dev/null; then
  export RELAYD_TLS_CERT_FILE="${TLS_DIR}/server.cert.pem"
  export RELAYD_TLS_KEY_FILE="${TLS_DIR}/server.key.pem"
  echo "relay: using control-plane server certificate" >&2
else
  rm -f "${TLS_DIR}/server.cert.pem" "${TLS_DIR}/server.key.pem"
  echo "relay: no server certificate supplied; relayd will sign its own" >&2
fi

# ── device pairing ───────────────────────────────────────────────────────────
# Best-effort, and deliberately NOT part of the boot's success condition.
# Pairing polls the cloud rendezvous for the phone's device blob with a 120 s
# deadline; the phone typically posts that blob before this sandbox has even
# booted, so losing that single POST is enough to time it out. That is a
# recoverable, retryable condition — not a reason to leave the user with a
# machine that never starts.
#
# It runs in the background because it talks only to the cloud, never to the
# local daemon: there is nothing for it to wait on, and blocking `relayd run`
# behind it would delay the tunnel by up to two minutes on every boot that has
# not yet paired. It reads its credentials from ENROLL_CONFIG, so it is
# unaffected by anything this shell does to its own environment afterwards.
#
# The marker is written only on success, so a failure leaves the next boot to
# retry — and `relayd enroll --pair-only` re-runs it by hand against the
# already-enrolled, already-running node.
if grep -q '"pairingId"' "${ENROLL_CONFIG}" 2>/dev/null && [ ! -f "${PAIR_MARKER}" ]; then
  (
    # `if` guards the command so `set -e` cannot turn a failed pairing into a
    # failed boot.
    if RELAYD_ENROLL_CONFIG="${ENROLL_CONFIG}" node "${RELAYD_BIN}" enroll --pair-only; then
      touch "${PAIR_MARKER}"
    else
      echo "relay: trial pairing did not complete; the node is up and will retry on next boot (or run: relayd enroll --pair-only)" >&2
    fi
  ) &
fi

# ── secret hygiene ───────────────────────────────────────────────────────────
# The enroll token and pairing secret live in ENROLL_CONFIG and are read
# directly out of it by relayd, so they were never in this shell's environment
# and cannot be inherited by `relayd run` or anything the daemon spawns. The
# unset below is kept for a node launched the older, env-driven way.
#
# The file itself is left in place ONLY while pairing may still need it: the
# pairing subshell above runs concurrently, so deleting it here would race a
# retry. Both values are single-use and already spent by this point — the
# enroll token is burned server-side and the pairing slots are put-once — so
# what remains is a spent credential in a 0600 file inside the user's own
# machine, not a live one.
unset RELAYD_ENROLL_TOKEN RELAYD_ENROLL_PAIRING_ID RELAYD_ENROLL_PAIRING_SECRET

exec node "${RELAYD_BIN}" run --mode tunneled
