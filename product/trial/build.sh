#!/usr/bin/env bash
# Build the relay-trial template. Run ON the Cube host (or wherever the
# e2b-compatible CLI is authenticated against it). Copies relayd source in
# fresh so the image always matches the checked-out tree.
set -euo pipefail
cd "$(dirname "$0")"
trap 'rm -rf relayd' EXIT
rm -rf relayd
mkdir -p relayd
cp -R ../relayd/src ../relayd/bin ../relayd/package.json relayd/
e2b template build --name relay-trial
echo "template relay-trial built"
