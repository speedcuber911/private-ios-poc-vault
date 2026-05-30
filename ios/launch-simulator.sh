#!/usr/bin/env bash
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
    && curl -fsS --max-time 2 -N -X POST "http://127.0.0.1:${PORT}/v1/codex/chat" \
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
  screen -dmS "$SCREEN_NAME" /bin/zsh -lc "exec '${ROOT}/ops/serve-simulator-poc-vault' --port '${PORT}' >'${SERVER_LOG}' 2>&1"
  for _ in {1..40}; do
    server_alive && break
    sleep 0.25
  done
fi

if ! server_alive; then
  echo "Simulator server did not start. See ${SERVER_LOG}" >&2
  exit 1
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
open -a Simulator

xcodebuild build \
  -project "$ROOT/ios/POCVault/POCVault.xcodeproj" \
  -target POCVault \
  -configuration Debug \
  -sdk iphonesimulator26.5 \
  -arch arm64 \
  PRODUCT_BUNDLE_IDENTIFIER="$BUNDLE_ID" \
  POC_VAULT_CODEX_BASE_URL="${POC_VAULT_SIM_CODEX_BASE_URL:-http://127.0.0.1:${PORT}}" \
  POC_VAULT_MANIFEST_PUBLIC_KEY="$POC_VAULT_MANIFEST_PUBLIC_KEY" \
  CODE_SIGNING_ALLOWED=NO >/tmp/poc-vault-simulator-build.log

APP_PATH="$ROOT/ios/POCVault/build/Debug-iphonesimulator/Relay.app"
xcrun simctl terminate "$SIM_ID" "$BUNDLE_ID" >/dev/null 2>&1 || true
xcrun simctl uninstall "$SIM_ID" "$BUNDLE_ID" >/dev/null 2>&1 || true
xcrun simctl install "$SIM_ID" "$APP_PATH"
xcrun simctl launch "$SIM_ID" "$BUNDLE_ID"

echo "Launched Relay on simulator ${SIM_ID}"
