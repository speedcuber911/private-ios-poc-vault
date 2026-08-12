#!/usr/bin/env bash
# Build the relay-trial template and register it with Cube.
#
# Run this ON the Cube host. It needs the local Docker daemon and the local
# image registry, neither of which is reachable from anywhere else.
#
# NOTE ON TOOLING: Cube is E2B-API-compatible but ships NO `e2b` CLI. An
# earlier version of this script called `e2b template build`, which cannot
# work here — there is no such binary on the host. The real path is:
#   docker build -> push to the local registry -> POST /templates -> poll.
# `cubemastercli template create-from-image` is an equivalent CLI entry point;
# this script uses the HTTP API so it works unchanged against a remote,
# API-key-gated endpoint too.
#
# Template IDs are ALWAYS generated server-side with a `tpl-` prefix. The
# `templateID` request field is deprecated and ignored, so the caller must
# consume the returned id — never assume a name like "relay-trial" resolves.
set -euo pipefail
cd "$(dirname "$0")"

REGISTRY="${CUBE_REGISTRY:-127.0.0.1:5000}"
IMAGE_REPO="${CUBE_IMAGE_REPO:-relay/relay-trial}"
IMAGE_TAG="${IMAGE_TAG:-$(date -u +%Y%m%d%H%M%S)}"
CUBE_API_URL="${CUBE_API_URL:-http://127.0.0.1:3000}"
IMAGE="${REGISTRY}/${IMAGE_REPO}:${IMAGE_TAG}"

# Resource spec lives in e2b.toml so the manifest stays the single source of
# truth. `cpu` crosses the wire in MILLICORES (2000 == 2 vCPU); memory in MiB.
cpu_count=$(sed -n 's/^cpu_count *= *\([0-9]*\).*/\1/p' e2b.toml | head -1)
memory_mb=$(sed -n 's/^memory_mb *= *\([0-9]*\).*/\1/p' e2b.toml | head -1)
writable_layer_size=$(sed -n 's/^writable_layer_size *= *"\([^"]*\)".*/\1/p' e2b.toml | head -1)
: "${cpu_count:?cpu_count missing from e2b.toml}"
: "${memory_mb:?memory_mb missing from e2b.toml}"
# Required by CubeMaster despite being optional in the API schema: omitting it
# fails creation with `writable_layer_size is required`.
: "${writable_layer_size:?writable_layer_size missing from e2b.toml}"
cpu_millicores=$((cpu_count * 1000))

# Optional API key, for when this runs against the gated endpoint rather than
# loopback. Read from the environment only — never passed on a command line,
# where it would be visible in `ps` to every user on the box.
auth_args=()
if [ -n "${CUBE_API_KEY:-}" ]; then
  auth_args=(-H "X-API-Key: ${CUBE_API_KEY}")
fi

# relayd ships as plain source (stdlib-only, no npm install by design). Copy it
# in fresh on every build so the image can never drift from the checked-out
# tree, and clean up regardless of how this script exits.
trap 'rm -rf relayd' EXIT
rm -rf relayd
mkdir -p relayd
cp -R ../relayd/src ../relayd/bin ../relayd/package.json relayd/

echo "==> docker build ${IMAGE}"
docker build -t "${IMAGE}" .

echo "==> docker push ${IMAGE}"
docker push "${IMAGE}"

# Pin by digest: a mutable tag would let the template's contents change out
# from under an already-registered template.
digest=$(docker inspect --format='{{index .RepoDigests 0}}' "${IMAGE}" 2>/dev/null || true)
image_ref="${digest:-${IMAGE}}"
echo "==> registering template for ${image_ref}"

# No `command` override: the base image's ENTRYPOINT (cube-entrypoint.sh)
# must stay in place so envd starts, and it already honors the image's CMD
# (/opt/relayd/start.sh). Setting `command` here replaced the entrypoint AND
# was echoed into `args`, so the container tried to exec start.sh with itself
# as its own argument. Cube's own working templates leave `command` null.
#
# The probe is envd's own health endpoint. Without `probePort`/`probePath` the
# template has no readiness signal, and without exposing 49983 nothing can
# reach envd — which is how Cube performs init, exec and file operations.
request=$(cat <<JSON
{
  "image": "${image_ref}",
  "cpu": ${cpu_millicores},
  "memory": ${memory_mb},
  "writableLayerSize": "${writable_layer_size}",
  "allowInternetAccess": true,
  "exposedPorts": [49983],
  "probePort": 49983,
  "probePath": "/health"
}
JSON
)

response=$(curl -sS -X POST "${CUBE_API_URL}/templates" \
  -H 'content-type: application/json' \
  "${auth_args[@]}" \
  --data "${request}")

template_id=$(printf '%s' "${response}" | sed -n 's/.*"templateID"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p')
job_id=$(printf '%s' "${response}" | sed -n 's/.*"jobID"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p')

if [ -z "${template_id}" ]; then
  echo "template creation did not return a templateID; response: ${response}" >&2
  exit 1
fi
echo "==> templateID=${template_id} jobID=${job_id}"

# The build is asynchronous (202 Accepted). A template that is not READY will
# fail every sandbox create, so wait rather than reporting a premature success.
echo "==> waiting for template to become READY"
deadline=$(( $(date +%s) + 1800 ))
while :; do
  # The response is a single line carrying MANY "status" keys — per-replica
  # status, compat_status, artifact_status, template_status. A greedy
  # `sed 's/.*"status"...'` matches the LAST of them and misreports the
  # template as FAILED while it is in fact READY (observed). The top-level
  # status is the first occurrence, so match non-greedily and take head -1.
  status=$(curl -sS "${CUBE_API_URL}/templates/${template_id}" "${auth_args[@]}" \
    | grep -o '"status"[[:space:]]*:[[:space:]]*"[^"]*"' \
    | head -1 \
    | sed 's/.*"\([^"]*\)"$/\1/')
  case "${status}" in
    READY)
      echo "template ${template_id} is READY"
      echo "${template_id}"
      exit 0
      ;;
    FAILED|ERROR)
      echo "template ${template_id} build FAILED (status=${status})" >&2
      exit 1
      ;;
  esac
  if [ "$(date +%s)" -ge "${deadline}" ]; then
    echo "timed out after 30m waiting for template ${template_id} (last status: ${status:-unknown})" >&2
    exit 1
  fi
  sleep 10
done
