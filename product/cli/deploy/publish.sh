#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cli_root="$(cd "$script_dir/.." && pwd)"
stack_name="${RELAY_CLI_STACK_NAME:-relay-cli-distribution}"
aws_region="${AWS_REGION:-${AWS_DEFAULT_REGION:-us-east-1}}"

if [[ "${RELAY_SKIP_TESTS:-0}" != "1" ]]; then
  (cd "$cli_root" && npm test)
fi

temporary_dir="$(mktemp -d "${TMPDIR:-/tmp}/relay-cli-publish.XXXXXX")"
trap 'rm -rf "$temporary_dir"' EXIT
"$cli_root/scripts/build-release.sh" "$temporary_dir" >/dev/null

version="$(tr -d ' \t\r\n' <"$temporary_dir/latest.txt")"
artifact_name="relay-cli-v${version}.tgz"
artifact_path="$temporary_dir/$artifact_name"
checksum_path="$artifact_path.sha256"
checksum="$(awk 'NR == 1 { print $1 }' "$checksum_path")"
signature_path="$artifact_path.sig"
"$cli_root/scripts/sign-release.mjs" "$artifact_path" "$signature_path" >/dev/null

stack_output() {
  local key=$1
  aws cloudformation describe-stacks \
    --region "$aws_region" \
    --stack-name "$stack_name" \
    --query "Stacks[0].Outputs[?OutputKey=='$key'].OutputValue | [0]" \
    --output text
}

bucket="$(stack_output DistributionBucketName)"
distribution_id="$(stack_output DistributionId)"
install_url="$(stack_output InstallUrl)"
release_prefix="releases/v${version}"
release_key="$release_prefix/$artifact_name"

remote_checksum="$(aws s3api head-object \
  --region "$aws_region" \
  --bucket "$bucket" \
  --key "$release_key" \
  --query 'Metadata.sha256' \
  --output text 2>/dev/null || true)"
remote_signature_exists="$(aws s3api head-object \
  --region "$aws_region" \
  --bucket "$bucket" \
  --key "$release_key.sig" \
  --query 'ContentLength' \
  --output text 2>/dev/null || true)"

if [[ -n "$remote_checksum" && "$remote_checksum" != "None" && "$remote_checksum" != "$checksum" ]]; then
  echo "Refusing to replace immutable release v${version}: checksum differs" >&2
  exit 1
fi

if [[ "$remote_checksum" != "$checksum" ]]; then
  aws s3 cp "$artifact_path" "s3://$bucket/$release_key" \
    --region "$aws_region" \
    --only-show-errors \
    --content-type application/gzip \
    --cache-control 'public,max-age=31536000,immutable' \
    --metadata "sha256=$checksum"
fi

if [[ "$remote_checksum" != "$checksum" || -z "$remote_signature_exists" || "$remote_signature_exists" == "None" ]]; then
  aws s3 cp "$checksum_path" "s3://$bucket/$release_key.sha256" \
    --region "$aws_region" \
    --only-show-errors \
    --content-type text/plain \
    --cache-control 'public,max-age=31536000,immutable'
  aws s3 cp "$signature_path" "s3://$bucket/$release_key.sig" \
    --region "$aws_region" \
    --only-show-errors \
    --content-type text/plain \
    --cache-control 'public,max-age=31536000,immutable'
fi

aws s3 cp "$temporary_dir/latest.txt" "s3://$bucket/latest.txt" \
  --region "$aws_region" \
  --only-show-errors \
  --content-type text/plain \
  --cache-control 'no-cache,no-store,must-revalidate'

aws cloudfront create-invalidation \
  --distribution-id "$distribution_id" \
  --paths /latest.txt \
  >/dev/null

printf 'Published Relay CLI %s\n' "$version"
printf 'Install: curl --proto "=https" --tlsv1.2 -fsSL %s | sh\n' "$install_url"
