#!/usr/bin/env bash
# Trial sandbox init: enroll once (idempotent), pair best-effort, then run
# relayd tunneled. All configuration arrives as sandbox env vars injected by
# relay-cloud. Runs as PID 1 — there is no supervisor to recover from a bad
# exit, so nothing but a genuinely unrecoverable state may abort this script.
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
ENROLL_MARKER="${CODEX_DATA_DIR}/enrolled"
PAIR_MARKER="${CODEX_DATA_DIR}/paired"

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
if [ ! -f "${ENROLL_MARKER}" ]; then
  # Cube boots this image with NO enrollment environment twice over: once to
  # build the template, where CubeMaster probes envd at :49983/health before
  # marking it READY. The base entrypoint runs envd in the background and this
  # script in the FOREGROUND, so when this script exits the container exits and
  # envd goes with it — the probe then gets `connection refused` and template
  # creation fails outright (observed: "Get http://<ip>:49983/health: connect:
  # connection refused"). There is nothing to enroll against on such a boot, so
  # hold the container open instead of exiting. A real trial sandbox always
  # arrives with RELAYD_ENROLL_TOKEN injected and takes the branch below.
  if [ -z "${RELAYD_ENROLL_TOKEN:-}" ]; then
    echo "relay: no enrollment token in the environment (template probe or bare boot); idling so envd stays reachable" >&2
    exec sleep infinity
  fi
  node "${RELAYD_BIN}" enroll --no-pair
  touch "${ENROLL_MARKER}"
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
# not yet paired. The subshell is forked BEFORE the unset below, so it keeps
# its own copy of the pairing env; the parent's unset cannot race it.
#
# The marker is written only on success, so a failure leaves the next boot to
# retry — and `relayd enroll --pair-only` re-runs it by hand against the
# already-enrolled, already-running node.
if [ -n "${RELAYD_ENROLL_PAIRING_ID:-}" ] && [ ! -f "${PAIR_MARKER}" ]; then
  (
    # `if` guards the command so `set -e` cannot turn a failed pairing into a
    # failed boot.
    if node "${RELAYD_BIN}" enroll --pair-only; then
      touch "${PAIR_MARKER}"
    else
      echo "relay: trial pairing did not complete; the node is up and will retry on next boot (or run: relayd enroll --pair-only)" >&2
    fi
  ) &
fi

# ── secret hygiene ───────────────────────────────────────────────────────────
# Clears the enroll token and pairing secret from THIS process, and therefore
# from `relayd run` and every process the daemon spawns. It cannot clear the
# sandbox-level environment Cube/E2B injects, so a shell started directly by
# envd may still see them — see product/trial/README.md, which states the real
# guarantee rather than a broader one. Both values are single-use and already
# spent by this point: the enroll token is burned server-side and the pairing
# slots are put-once.
unset RELAYD_ENROLL_TOKEN RELAYD_ENROLL_PAIRING_ID RELAYD_ENROLL_PAIRING_SECRET

exec node "${RELAYD_BIN}" run --mode tunneled
