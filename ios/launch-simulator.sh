#!/usr/bin/env bash
#
# Build, install, and launch Relay on an iPhone 17 Pro simulator against the local
# fixture server (ops/serve-simulator-poc-vault).
#
# DEBUG visual-test hooks (compiled out of release builds). `xcrun simctl launch`
# forwards any variable in the *caller's* environment named SIMCTL_CHILD_<NAME> to
# the app as <NAME>, so prefix each hook with SIMCTL_CHILD_ when invoking this
# script — no script changes needed:
#
#   SIMCTL_CHILD_RELAY_UITEST_PATH=/abs/folder   push the file browser to that folder
#   SIMCTL_CHILD_RELAY_UITEST_FILE=/abs/file     push the read-only file viewer route
#   SIMCTL_CHILD_RELAY_UITEST_CHAT=1             open the chat cover (for RELAY_UITEST_PATH's
#                                                folder when set, else the root)
#   SIMCTL_CHILD_RELAY_UITEST_OPEN=library|status  present the Library cover / Status sheet
#   SIMCTL_CHILD_RELAY_UITEST_CREATE_USERNAME=...  create a local simulator account
#   SIMCTL_CHILD_RELAY_UITEST_CREATE_EMAIL=...     email for that local account
#   SIMCTL_CHILD_RELAY_UITEST_CREATE_PASSWORD=...  password for that local account
#   SIMCTL_CHILD_RELAY_UITEST_SKIP_ONBOARDING=1    enter the signed-in app directly
#   (RELAY_SIM_FIXTURE=1 is exported for you — it tells the app the local fixture
#    server counts as its machine, so the signed-in UI is reachable without a trial)
#   RELAY_SIM_SIGNED_OUT=1                         show the sign-in flow instead of the
#                                                  default local preview account
#
#   Chat auto-drive (combine with RELAY_UITEST_CHAT=1):
#   SIMCTL_CHILD_RELAY_UITEST_MODEL=<substr>     pick the model whose id/label contains this
#   SIMCTL_CHILD_RELAY_UITEST_PROMPT=<text>      auto-send a chat prompt (streaming UI)
#   SIMCTL_CHILD_RELAY_UITEST_TASK_PROMPT=<text> auto-submit a task job (job card UI)
#
# Example — screenshot chat streaming in the poc-vault folder:
#   SIMCTL_CHILD_RELAY_UITEST_PATH=/srv/codex-workspaces/poc-vault \
#   SIMCTL_CHILD_RELAY_UITEST_CHAT=1 \
#   SIMCTL_CHILD_RELAY_UITEST_PROMPT='Explain connection pooling' \
#   ios/launch-simulator.sh
#
# Fixture pacing knobs (server side): SIM_CHAT_DELTA_DELAY, SIM_JOB_STREAM_DELAY.
#
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CONFIG_FILE="${POC_VAULT_CONFIG:-$HOME/.poc-vault/secrets/config.env}"
if [[ -f "$CONFIG_FILE" ]]; then
  # shellcheck disable=SC1090
  source "$CONFIG_FILE"
fi

PORT="${POC_VAULT_SIM_PORT:-8787}"
SERVER_LOG="/tmp/poc-vault-simulator-server.log"
SCREEN_NAME="poc-vault-simulator-server-${PORT}"
BUNDLE_ID="${BUNDLE_ID:-${IOS_BUNDLE_ID:-com.parikshit.pocvault}}"
POC_VAULT_MANIFEST_PUBLIC_KEY="${POC_VAULT_MANIFEST_PUBLIC_KEY:-}"
if [[ -z "$POC_VAULT_MANIFEST_PUBLIC_KEY" && -f "${LOCAL_SECRETS_DIR:-$HOME/.poc-vault/secrets}/signing/manifest-ed25519.key" ]]; then
  POC_VAULT_MANIFEST_PUBLIC_KEY="$("$ROOT/ops/manifest-public-key" 2>/dev/null || true)"
fi
OLD_LAUNCH_LABEL="${BUNDLE_ID}.simulator"

server_alive() {
  curl -fsS "http://127.0.0.1:${PORT}/healthz" >/dev/null 2>&1 \
    && curl -fsS "http://127.0.0.1:${PORT}/v1/codex/health" >/dev/null 2>&1 \
    && curl -fsS "http://127.0.0.1:${PORT}/v1/codex/models" >/dev/null 2>&1 \
    && curl -fsS --max-time 15 -N -X POST "http://127.0.0.1:${PORT}/v1/codex/chat" \
      -H "Content-Type: application/json" \
      --data '{"provider":"bedrock","model":"simulator-health","messages":[{"role":"user","content":"ping"}]}' \
      2>/dev/null | grep -q "event: done"
}

stop_existing_simulator_server() {
  launchctl bootout "gui/$(id -u)/${OLD_LAUNCH_LABEL}" >/dev/null 2>&1 || true
  screen -S "$SCREEN_NAME" -X quit >/dev/null 2>&1 || true

  if ! command -v lsof >/dev/null 2>&1; then
    return
  fi

  local pids pid command_text
  pids="$(lsof -tiTCP:"${PORT}" -sTCP:LISTEN 2>/dev/null || true)"
  for pid in $pids; do
    command_text="$(ps -p "$pid" -o command= 2>/dev/null || true)"
    if [[ "$command_text" == *"${ROOT}/ops/serve-simulator-poc-vault"* ]] \
      || [[ "$command_text" == *"ops/serve-simulator-poc-vault"* ]] \
      || [[ "$command_text" == *"serve-simulator-poc-vault"* && "$command_text" == *"--port ${PORT}"* ]]; then
      kill "$pid" >/dev/null 2>&1 || true
    fi
  done

  for _ in {1..20}; do
    pids="$(lsof -tiTCP:"${PORT}" -sTCP:LISTEN 2>/dev/null || true)"
    [[ -z "$pids" ]] && break
    sleep 0.1
  done
}

if ! server_alive; then
  stop_existing_simulator_server
  # Keep health-check chat SSE fast; UI pacing can be re-enabled by exporting SIM_CHAT_DELTA_DELAY.
  screen -dmS "$SCREEN_NAME" /bin/zsh -lc "export SIM_CHAT_DELTA_DELAY='${SIM_CHAT_DELTA_DELAY:-0}'; exec '${ROOT}/ops/serve-simulator-poc-vault' --port '${PORT}' >'${SERVER_LOG}' 2>&1"
  for _ in {1..40}; do
    server_alive && break
    sleep 0.25
  done
fi

if ! server_alive; then
  echo "Simulator server did not start. See ${SERVER_LOG}" >&2
  exit 1
fi

if [[ -z "$POC_VAULT_MANIFEST_PUBLIC_KEY" ]]; then
  POC_VAULT_MANIFEST_PUBLIC_KEY="$(python3 -c 'import json, sys; print(json.load(open(sys.argv[1], encoding="utf-8"))["publicKey"])' "$ROOT/build/simulator/manifest.sig.json")"
fi

SIM_ID="${1:-}"
if [[ -z "$SIM_ID" ]]; then
  SIM_ID="$(xcrun simctl list devices available | awk -F '[()]' '/iPhone 17 Pro/ {print $2; exit}')"
fi
if [[ -z "$SIM_ID" ]]; then
  echo "No available iPhone 17 Pro simulator found." >&2
  exit 1
fi

xcrun simctl boot "$SIM_ID" >/dev/null 2>&1 || true
xcrun simctl bootstatus "$SIM_ID" -b >/dev/null
SIMULATOR_APP="$(xcode-select -p)/Applications/Simulator.app"
if [[ -d "$SIMULATOR_APP" ]]; then
  open "$SIMULATOR_APP"
elif [[ -d "/Applications/Simulator.app" ]]; then
  open -a Simulator
else
  # Xcode beta may boot CoreSimulator without a standalone Simulator.app.
  echo "Simulator.app not found; continuing with simctl boot/install/launch." >&2
fi

xcodebuild build \
  -project "$ROOT/ios/POCVault/POCVault.xcodeproj" \
  -target POCVault \
  -configuration Debug \
  -sdk iphonesimulator \
  -arch arm64 \
  PRODUCT_BUNDLE_IDENTIFIER="$BUNDLE_ID" \
  POC_VAULT_CODEX_BASE_URL="${POC_VAULT_SIM_CODEX_BASE_URL:-http://127.0.0.1:${PORT}}" \
  RELAY_AUTH_BASE_URL="${POC_VAULT_SIM_AUTH_BASE_URL:-http://127.0.0.1:${PORT}}" \
  POC_VAULT_MANIFEST_PUBLIC_KEY="$POC_VAULT_MANIFEST_PUBLIC_KEY" \
  CODE_SIGNING_ALLOWED=YES >/tmp/poc-vault-simulator-build.log

APP_PATH="$ROOT/ios/POCVault/build/Debug-iphonesimulator/Relay.app"
xcrun simctl terminate "$SIM_ID" "$BUNDLE_ID" >/dev/null 2>&1 || true
xcrun simctl uninstall "$SIM_ID" "$BUNDLE_ID" >/dev/null 2>&1 || true
xcrun simctl install "$SIM_ID" "$APP_PATH"

# Marks this run as the fixture-backed preview. AppConfiguration.isSimulatorFixtureRun
# reads it, and it is what lets the app treat the local fixture server as a real
# machine. Exported unconditionally — a signed-out preview still needs it the moment
# the user signs in. It must NOT be inferred from "am I a simulator": xcodebuild test
# is a simulator build too, and inferring it there made hasMachine unconditionally
# true and broke TrialPairingTests.
export SIMCTL_CHILD_RELAY_SIM_FIXTURE=1

# The local fixture server owns this preview-only account. Keep the normal one-command
# simulator workflow inside the product instead of dropping back to the sign-in screen
# after every uninstall/install cycle.
if [[ "${RELAY_SIM_SIGNED_OUT:-0}" != "1" ]]; then
  export SIMCTL_CHILD_RELAY_UITEST_CREATE_USERNAME="${SIMCTL_CHILD_RELAY_UITEST_CREATE_USERNAME:-Relay Preview}"
  export SIMCTL_CHILD_RELAY_UITEST_CREATE_EMAIL="${SIMCTL_CHILD_RELAY_UITEST_CREATE_EMAIL:-preview@relay.local}"
  export SIMCTL_CHILD_RELAY_UITEST_CREATE_PASSWORD="${SIMCTL_CHILD_RELAY_UITEST_CREATE_PASSWORD:-relay-local-preview}"
  export SIMCTL_CHILD_RELAY_UITEST_SKIP_ONBOARDING="${SIMCTL_CHILD_RELAY_UITEST_SKIP_ONBOARDING:-1}"
fi

xcrun simctl launch "$SIM_ID" "$BUNDLE_ID"

echo "Launched Relay on simulator ${SIM_ID}"
