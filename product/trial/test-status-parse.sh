#!/usr/bin/env bash
# Exercises build.sh's template-status extraction against every body shape the
# Cube API actually returns during a build.
#
# The case that matters is "no status key yet". Under `set -euo pipefail` the
# original pipeline (`grep … | head -1 | sed …`) exited 1 there, which killed
# build.sh silently on its first poll and reported three successful builds as
# failures. This asserts the extraction is total: it yields a value or an empty
# string, and never takes the script down with it.
#
# Runs the extraction under the SAME shell options build.sh uses — without
# them the bug is invisible.
set -euo pipefail

pass=0
fail=0

# Verbatim the expression from build.sh's poll loop.
extract_status() {
  printf '%s' "$1" \
    | grep -o '"status"[[:space:]]*:[[:space:]]*"[^"]*"' \
    | sed -n '1s/.*"\([^"]*\)"$/\1/p' || true
}

check() {
  local name="$1" body="$2" want="$3" got rc
  set +e
  got=$( set -euo pipefail; extract_status "$body" )
  rc=$?
  set -e
  if [ "$rc" -ne 0 ]; then
    echo "FAIL  ${name}: extraction exited ${rc} (this is what killed build.sh)"
    fail=$(( fail + 1 ))
    return
  fi
  if [ "$got" != "$want" ]; then
    echo "FAIL  ${name}: got '${got}', want '${want}'"
    fail=$(( fail + 1 ))
    return
  fi
  echo "ok    ${name}: '${got:-<empty>}'"
  pass=$(( pass + 1 ))
}

# The regression: immediately after POST /templates the detail response has no
# top-level status. Must yield empty and keep going, not abort the build.
check "no status key (the first poll)" '{"error":"not found"}' ""
check "empty body (transient curl failure)" '' ""

# The real shape: top-level PENDING while the single replica is FAILED. Seen on
# every build here; each one then reached READY. Reading the replica would fail
# every build.
check "top-level PENDING, replica FAILED" \
  '{"templateID":"tpl-x","status":"PENDING","replicas":[{"compat_status":"UNKNOWN","status":"FAILED"}]}' \
  "PENDING"

check "READY, replica READY" \
  '{"templateID":"tpl-x","status":"READY","replicas":[{"compat_status":"OK","status":"READY"}]}' \
  "READY"

# A genuine failure must still be caught — the fix must not make the check
# toothless.
check "top-level FAILED is still reported" \
  '{"templateID":"tpl-x","status":"FAILED","replicas":[{"status":"FAILED"}]}' \
  "FAILED"

# compat_status must not be mistaken for status: the key is a different one and
# a substring match would read it first.
check "compat_status before status does not win" \
  '{"compat_status":"UNKNOWN","status":"READY"}' \
  "READY"

check "whitespace after the colon" '{"status" :   "READY"}' "READY"

# Many replicas: the producer must not be signalled part-way, and the first
# match must still be the top-level one.
big='{"templateID":"tpl-x","status":"PENDING","replicas":['
for _ in $(seq 1 300); do big="${big}{\"status\":\"FAILED\"},"; done
big="${big%,}]}"
check "300 replicas, top level still wins" "$big" "PENDING"

echo
echo "${pass} passed, ${fail} failed"
[ "$fail" -eq 0 ]
