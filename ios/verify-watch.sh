#!/usr/bin/env bash
set -euo pipefail

if [[ "${1:-}" == "--help" ]]; then
  echo 'Usage: ios/verify-watch.sh "platform=iOS Simulator,id=<simulator-UDID>"'
  echo 'Builds RelayWatch and runs RelayWatchTests in the existing iPhone test target.'
  exit 0
fi
if [[ "$(uname -s)" != Darwin ]] || ! command -v xcodebuild >/dev/null 2>&1; then
  echo 'Relay watch builds and native tests require a Mac with full Xcode and the watchOS SDK.' >&2
  exit 2
fi
if [[ $# -ne 1 ]]; then
  echo 'Pass an iOS Simulator destination. Find one with:' >&2
  echo 'xcodebuild -project ios/POCVault/POCVault.xcodeproj -scheme POCVault -showdestinations' >&2
  exit 2
fi

relay_repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
relay_project="$relay_repo_root/ios/POCVault/POCVault.xcodeproj"
relay_derived_data="$relay_repo_root/build/watch-validation"

xcodebuild -project "$relay_project" -scheme RelayWatch \
  -configuration Debug -destination 'generic/platform=watchOS Simulator' \
  -derivedDataPath "$relay_derived_data" CODE_SIGNING_ALLOWED=NO build

xcodebuild -project "$relay_project" -scheme POCVault \
  -configuration Debug -destination "$1" \
  -derivedDataPath "$relay_derived_data" CODE_SIGNING_ALLOWED=NO \
  -only-testing:POCVaultTests/RelayWatchTests test
