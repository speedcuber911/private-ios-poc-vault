#!/usr/bin/env bash
# The dev-ec2-idle-autostop Lambda in the Relay AWS account.
#
#   deploy/idle-autostop/deploy.sh               # operator: role, policy, function, 15-min schedule
#   deploy/idle-autostop/deploy.sh --code-only   # pipeline: function code and settings only
#   DRY_RUN=true deploy/idle-autostop/deploy.sh  # only logs what it would stop
#
# The pipeline never touches IAM or the schedule: its role may update this one
# function and nothing else, so a push cannot widen what the Lambda may do.
# A machine opts out with the tag AutoStopEnabled=false, which the Relay app's
# "Auto-stop when idle" switch writes through the control plane. A new machine
# needs its id in TARGET_INSTANCE_IDS here and in permissions-policy.json.
set -euo pipefail

REGION="${REGION:-ap-south-1}"
NAME=dev-ec2-idle-autostop
ROLE="$NAME-role"
RULE="$NAME-schedule"
DRY_RUN="${DRY_RUN:-false}"
TARGET_INSTANCE_IDS="${TARGET_INSTANCE_IDS:-i-0364bb0f31f506e7c,i-05863951ad0263c8e}"
CODE_ONLY=false
[[ "${1:-}" == "--code-only" ]] && CODE_ONLY=true
here="$(cd "$(dirname "$0")" && pwd)"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

ENVIRONMENT="Variables={TARGET_REGION=$REGION,TARGET_INSTANCE_IDS=${TARGET_INSTANCE_IDS//,/\\,},CPU_THRESHOLD_PERCENT=5,NETWORK_THRESHOLD_BYTES_PER_PERIOD=10000000,IDLE_WINDOW_MINUTES=120,DRY_RUN=$DRY_RUN}"
(cd "$here" && zip -qj "$work/function.zip" lambda_function.py)

if [[ "$CODE_ONLY" == true ]]; then
  aws lambda update-function-code --function-name "$NAME" --region "$REGION" \
    --zip-file "fileb://$work/function.zip" >/dev/null
  aws lambda wait function-updated --function-name "$NAME" --region "$REGION"
  aws lambda update-function-configuration --function-name "$NAME" --region "$REGION" \
    --environment "$ENVIRONMENT" >/dev/null
  aws lambda wait function-updated --function-name "$NAME" --region "$REGION"
  echo "$NAME code and settings updated (DRY_RUN=$DRY_RUN)"
  exit 0
fi

ACCOUNT="$(aws sts get-caller-identity --query Account --output text)"
if ! aws iam get-role --role-name "$ROLE" >/dev/null 2>&1; then
  aws iam create-role --role-name "$ROLE" \
    --assume-role-policy-document "file://$here/trust-policy.json" >/dev/null
  sleep 10
fi
aws iam put-role-policy --role-name "$ROLE" --policy-name "$NAME-policy" \
  --policy-document "file://$here/permissions-policy.json"

if aws lambda get-function --function-name "$NAME" --region "$REGION" >/dev/null 2>&1; then
  aws lambda update-function-code --function-name "$NAME" --region "$REGION" \
    --zip-file "fileb://$work/function.zip" >/dev/null
  aws lambda wait function-updated --function-name "$NAME" --region "$REGION"
  aws lambda update-function-configuration --function-name "$NAME" --region "$REGION" \
    --environment "$ENVIRONMENT" >/dev/null
else
  aws lambda create-function --function-name "$NAME" --region "$REGION" \
    --runtime python3.12 --handler lambda_function.lambda_handler \
    --role "arn:aws:iam::$ACCOUNT:role/$ROLE" --timeout 60 --memory-size 128 \
    --zip-file "fileb://$work/function.zip" --environment "$ENVIRONMENT" >/dev/null
fi
aws lambda wait function-updated --function-name "$NAME" --region "$REGION"

rule_arn="$(aws events put-rule --name "$RULE" --region "$REGION" \
  --schedule-expression "rate(15 minutes)" --state ENABLED --query RuleArn --output text)"
aws lambda add-permission --function-name "$NAME" --region "$REGION" \
  --statement-id AllowEventBridgeInvoke --action lambda:InvokeFunction \
  --principal events.amazonaws.com --source-arn "$rule_arn" >/dev/null 2>&1 || true
aws events put-targets --rule "$RULE" --region "$REGION" \
  --targets "Id=1,Arn=arn:aws:lambda:$REGION:$ACCOUNT:function:$NAME" >/dev/null

echo "$NAME deployed (DRY_RUN=$DRY_RUN, targets $TARGET_INSTANCE_IDS)"
