#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cli_root="$(cd "$script_dir/.." && pwd)"

stack_name="${RELAY_CLI_STACK_NAME:-relay-cli-distribution}"
aws_region="${AWS_REGION:-${AWS_DEFAULT_REGION:-us-east-1}}"
distribution_domain="${RELAY_CLI_DISTRIBUTION_DOMAIN:-}"
hosted_zone_id="${RELAY_CLI_HOSTED_ZONE_ID:-}"
github_repository="${RELAY_CLI_GITHUB_REPOSITORY:-speedcuber911/private-ios-poc-vault}"
github_oidc_provider_arn="${RELAY_CLI_GITHUB_OIDC_PROVIDER_ARN:-}"
expected_aws_account_id="${RELAY_CLI_EXPECTED_AWS_ACCOUNT_ID:-}"

required=(distribution_domain hosted_zone_id github_oidc_provider_arn expected_aws_account_id)
for name in "${required[@]}"; do
  if [[ -z "${!name}" ]]; then
    echo "Missing required deployment setting: $name" >&2
    exit 2
  fi
done
if [[ "$aws_region" != "us-east-1" ]]; then
  echo "CloudFront ACM certificates must be provisioned from us-east-1." >&2
  exit 2
fi
if [[ ! "$expected_aws_account_id" =~ ^[0-9]{12}$ ]]; then
  echo "RELAY_CLI_EXPECTED_AWS_ACCOUNT_ID must be a 12-digit AWS account id." >&2
  exit 2
fi

actual_aws_account_id="$(aws sts get-caller-identity --query Account --output text)"
if [[ "$actual_aws_account_id" != "$expected_aws_account_id" ]]; then
  echo "Refusing deployment: active AWS account is $actual_aws_account_id, expected $expected_aws_account_id." >&2
  exit 1
fi
if [[ "$github_oidc_provider_arn" != "arn:aws:iam::${expected_aws_account_id}:oidc-provider/token.actions.githubusercontent.com" ]]; then
  echo "GitHub OIDC provider ARN does not belong to the expected account." >&2
  exit 2
fi

aws cloudformation deploy \
  --region "$aws_region" \
  --stack-name "$stack_name" \
  --template-file "$script_dir/distribution.yml" \
  --parameter-overrides \
    "DistributionDomain=$distribution_domain" \
    "HostedZoneId=$hosted_zone_id" \
    "GitHubRepository=$github_repository" \
    "GitHubOidcProviderArn=$github_oidc_provider_arn" \
  --capabilities CAPABILITY_NAMED_IAM \
  --no-fail-on-empty-changeset

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
publisher_role="$(stack_output GitHubPublisherRoleArn)"
install_url="$(stack_output InstallUrl)"

# The tag-scoped publisher role deliberately cannot overwrite the bootstrap
# installer or pinned public key. These trust-root objects are an explicit
# infrastructure-owner operation.
aws s3 cp "$cli_root/dist/install.sh" "s3://$bucket/install.sh" \
  --region "$aws_region" \
  --only-show-errors \
  --content-type text/x-shellscript \
  --cache-control 'no-cache,no-store,must-revalidate'
aws s3 cp "$cli_root/dist/release-public-key.pem" "s3://$bucket/release-public-key.pem" \
  --region "$aws_region" \
  --only-show-errors \
  --content-type application/x-pem-file \
  --cache-control 'public,max-age=31536000,immutable'
aws cloudfront create-invalidation \
  --distribution-id "$distribution_id" \
  --paths /install.sh /release-public-key.pem \
  >/dev/null

printf 'Installer: %s\n' "$install_url"
printf 'GitHub Actions variable RELAY_CLI_PUBLISH_ROLE_ARN=%s\n' "$publisher_role"
printf 'GitHub Actions variable RELAY_CLI_AWS_REGION=%s\n' "$aws_region"
