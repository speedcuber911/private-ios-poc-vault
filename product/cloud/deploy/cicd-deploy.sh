#!/usr/bin/env bash
set -euo pipefail

required=(TARGET_INSTANCE_ID RELEASE_BUCKET PUBLIC_BASE_URL BACKUP_S3_URI DEPLOY_SHA AWS_DEFAULT_REGION)
for name in "${required[@]}"; do
  if [[ -z "${!name:-}" ]]; then
    echo "Missing required CI/CD variable: $name" >&2
    exit 2
  fi
done
if [[ ! "$DEPLOY_SHA" =~ ^[0-9a-f]{40}$ ]]; then
  echo "DEPLOY_SHA must be a full Git commit SHA." >&2
  exit 2
fi
if [[ ! "$PUBLIC_BASE_URL" =~ ^https://[^/]+$ ]]; then
  echo "PUBLIC_BASE_URL must be an HTTPS origin without a path." >&2
  exit 2
fi

archive="/tmp/relay-cloud-$DEPLOY_SHA.tar.gz"
object_uri="s3://${RELEASE_BUCKET}/releases/${DEPLOY_SHA}/relay-cloud.tar.gz"
tar \
  --exclude='./node_modules' \
  --exclude='./relay-cloud.sqlite*' \
  --exclude='./deploy/__pycache__' \
  -czf "$archive" .
aws s3 cp "$archive" "$object_uri" --only-show-errors

remote_command="$(printf '%s' \
  "set -eu; " \
  "release_root=\$(mktemp -d /tmp/relay-cloud-release.XXXXXX); " \
  "trap 'rm -rf \"\$release_root\"' EXIT; " \
  "aws s3 cp '$object_uri' \"\$release_root/relay-cloud.tar.gz\" --only-show-errors; " \
  "mkdir \"\$release_root/source\"; " \
  "tar -xzf \"\$release_root/relay-cloud.tar.gz\" -C \"\$release_root/source\"; " \
  "RELAY_PUBLIC_BASE_URL='$PUBLIC_BASE_URL' " \
  "RELAY_CLOUD_BIND_HOST='127.0.0.1' " \
  "RELAY_CLOUD_PORT='8790' " \
  "RELAY_BACKUP_S3_URI='$BACKUP_S3_URI' " \
  "RELAY_RELEASE_ID='$DEPLOY_SHA' " \
  "bash \"\$release_root/source/deploy/install.sh\" \"\$release_root/source\"; " \
  "systemctl is-active --quiet relay-cloud; " \
  "curl -fsS http://127.0.0.1:8790/healthz >/dev/null")"

parameters="$(REMOTE_COMMAND="$remote_command" python3 -c 'import json, os; print(json.dumps({"commands": [os.environ["REMOTE_COMMAND"]]}))')"
command_id="$(aws ssm send-command \
  --region "$AWS_DEFAULT_REGION" \
  --instance-ids "$TARGET_INSTANCE_ID" \
  --document-name AWS-RunShellScript \
  --comment "Relay cloud deploy $DEPLOY_SHA" \
  --parameters "$parameters" \
  --query 'Command.CommandId' \
  --output text)"

status="Pending"
for _ in $(seq 1 120); do
  status="$(aws ssm get-command-invocation \
    --region "$AWS_DEFAULT_REGION" \
    --command-id "$command_id" \
    --instance-id "$TARGET_INSTANCE_ID" \
    --query Status \
    --output text 2>/dev/null || true)"
  case "$status" in
    Success) break ;;
    Failed|Cancelled|TimedOut|Cancelling)
      aws ssm get-command-invocation \
        --region "$AWS_DEFAULT_REGION" \
        --command-id "$command_id" \
        --instance-id "$TARGET_INSTANCE_ID" \
        --query '{Status:Status,Output:StandardOutputContent,Error:StandardErrorContent}' \
        --output json || true
      exit 1
      ;;
  esac
  sleep 5
done
if [[ "$status" != "Success" ]]; then
  echo "SSM deploy did not finish successfully: $status" >&2
  exit 1
fi

aws ssm get-command-invocation \
  --region "$AWS_DEFAULT_REGION" \
  --command-id "$command_id" \
  --instance-id "$TARGET_INSTANCE_ID" \
  --query '{Status:Status,Output:StandardOutputContent,Error:StandardErrorContent}' \
  --output json

curl --fail --silent --show-error --retry 12 --retry-delay 5 \
  "$PUBLIC_BASE_URL/healthz" >/dev/null
echo "Relay cloud $DEPLOY_SHA deployed and publicly healthy."
