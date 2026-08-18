#!/bin/sh

# Xcode Cloud also looks at the repository root. Keep this stub in sync with
# the project-local script next to POCVault.xcodeproj.
set -eu
root="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
exec "$root/ios/POCVault/ci_scripts/ci_post_clone.sh"
