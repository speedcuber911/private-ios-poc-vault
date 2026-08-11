#!/usr/bin/env bash
# Trial sandbox init: enroll once (idempotent), then run relayd tunneled.
# All configuration arrives as sandbox env vars injected by relay-cloud.
# The enroll token and pairing secret are consumed here and exported to
# nothing else; relayd run does not need them.
set -euo pipefail

export CODEX_DATA_DIR="${CODEX_DATA_DIR:-/var/lib/relayd}"
export RELAYD_IDENTITY_DIR="${RELAYD_IDENTITY_DIR:-/var/lib/relayd/identity}"
export CODEX_WORKSPACE_BROWSE_ROOT="${CODEX_WORKSPACE_BROWSE_ROOT:-/srv/relay-workspaces}"
if [ -z "${CODEX_WORKSPACES:-}" ]; then
  export CODEX_WORKSPACES='[{"id":"welcome","name":"Welcome","path":"/srv/relay-workspaces/welcome"}]'
fi
export CODEX_RUN_HOME="${CODEX_RUN_HOME:-/home/relay}"
export RELAYD_STORE="${RELAYD_STORE:-sqlite}"

ENROLL_MARKER="${CODEX_DATA_DIR}/enrolled"
if [ ! -f "${ENROLL_MARKER}" ]; then
  node /opt/relayd/app/bin/relayd enroll
  touch "${ENROLL_MARKER}"
fi

# The enroll secrets must not leak into the long-running daemon environment.
unset RELAYD_ENROLL_TOKEN RELAYD_ENROLL_PAIRING_ID RELAYD_ENROLL_PAIRING_SECRET

exec node /opt/relayd/app/bin/relayd run --mode tunneled
