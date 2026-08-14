#!/usr/bin/env bash
# Sync product/web/dist to the app.openrelay.sh CloudFront origin.
set -euo pipefail

stack_name="${RELAY_WEB_STACK_NAME:-relay-web-app}"
aws_region="${AWS_REGION:-${AWS_DEFAULT_REGION:-us-east-1}}"
aws_profile="${AWS_PROFILE:-cut-personal}"
web_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
aws_cmd=(aws --profile "$aws_profile" --region "$aws_region")

if [[ ! -d "$web_root/dist" ]]; then
  echo "Missing $web_root/dist. Run npm run build first." >&2
  exit 2
fi

stack_output() {
  local key=$1
  "${aws_cmd[@]}" cloudformation describe-stacks \
    --stack-name "$stack_name" \
    --query "Stacks[0].Outputs[?OutputKey=='$key'].OutputValue | [0]" \
    --output text
}

bucket="$(stack_output DistributionBucketName)"
distribution_id="$(stack_output DistributionId)"
if [[ -z "$bucket" || "$bucket" == "None" || -z "$distribution_id" || "$distribution_id" == "None" ]]; then
  echo "Stack $stack_name is missing CloudFront outputs." >&2
  exit 1
fi

"${aws_cmd[@]}" s3 sync "$web_root/dist/" "s3://$bucket/" \
  --delete \
  --only-show-errors \
  --cache-control 'public,max-age=31536000,immutable' \
  --exclude index.html \
  --exclude '*.html'

"${aws_cmd[@]}" s3 cp "$web_root/dist/index.html" "s3://$bucket/index.html" \
  --only-show-errors \
  --content-type text/html \
  --cache-control 'no-cache,no-store,must-revalidate'

"${aws_cmd[@]}" cloudfront create-invalidation \
  --distribution-id "$distribution_id" \
  --paths '/*' \
  --query 'Invalidation.Id' \
  --output text
