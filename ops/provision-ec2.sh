#!/usr/bin/env bash
set -euo pipefail

CONFIG_FILE="${POC_VAULT_CONFIG:-$HOME/.poc-vault/secrets/config.env}"
if [[ -f "$CONFIG_FILE" ]]; then
  # shellcheck disable=SC1090
  source "$CONFIG_FILE"
fi

AWS_REGION="${AWS_REGION:-ap-south-1}"
VAULT_DOMAIN="${VAULT_DOMAIN:-vault.pocs.example.com}"
POC_WILDCARD_DOMAIN="${POC_WILDCARD_DOMAIN:-*.pocs.example.com}"
INSTANCE_NAME="${INSTANCE_NAME:-poc-vault}"
INSTANCE_TYPE="${INSTANCE_TYPE:-t3.micro}"
KEY_NAME="${KEY_NAME:-poc-vault}"
SECURITY_GROUP_NAME="${SECURITY_GROUP_NAME:-poc-vault-nginx-mtls}"
ADMIN_CIDR="${ADMIN_CIDR:-}"
HOSTED_ZONE_ID="${HOSTED_ZONE_ID:-}"
SSH_PUBLIC_KEY_PATH="${SSH_PUBLIC_KEY_PATH:-$HOME/.ssh/${KEY_NAME}.pub}"
ALLOCATE_EIP="${ALLOCATE_EIP:-true}"
ENABLE_HTTP="${ENABLE_HTTP:-false}"
AMI_ID="${AMI_ID:-}"
VPC_ID="${VPC_ID:-}"
SUBNET_ID="${SUBNET_ID:-}"

usage() {
  cat <<USAGE
Usage: $(basename "$0") [--dry-run]

Creates or checks the EC2 pieces for POC Vault in ${AWS_REGION}:
  - key pair ${KEY_NAME} (imports ${SSH_PUBLIC_KEY_PATH} if missing)
  - security group ${SECURITY_GROUP_NAME}
  - EC2 instance tagged Name=${INSTANCE_NAME}
  - optional Elastic IP and Route53 records for ${VAULT_DOMAIN} and ${POC_WILDCARD_DOMAIN}

Set values in ${CONFIG_FILE}. No private keys or secrets are embedded in this script.
USAGE
}

DRY_RUN=false
while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run)
      DRY_RUN=true
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown argument: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || {
    echo "Missing required command: $1" >&2
    exit 1
  }
}

aws_cmd() {
  aws --region "$AWS_REGION" "$@"
}

run_aws() {
  if [[ "$DRY_RUN" == "true" ]]; then
    printf 'DRY-RUN aws --region %q' "$AWS_REGION"
    printf ' %q' "$@"
    printf '\n'
  else
    aws_cmd "$@"
  fi
}

require_cmd aws

if [[ "$ENABLE_HTTP" != "true" && "$ENABLE_HTTP" != "false" ]]; then
  echo "ENABLE_HTTP must be true or false" >&2
  exit 1
fi

if [[ -z "$VPC_ID" ]]; then
  VPC_ID="$(aws_cmd ec2 describe-vpcs \
    --filters Name=isDefault,Values=true \
    --query 'Vpcs[0].VpcId' \
    --output text)"
fi
if [[ -z "$VPC_ID" || "$VPC_ID" == "None" ]]; then
  echo "No VPC_ID configured and no default VPC found" >&2
  exit 1
fi

if [[ -z "$SUBNET_ID" ]]; then
  SUBNET_ID="$(aws_cmd ec2 describe-subnets \
    --filters "Name=vpc-id,Values=${VPC_ID}" Name=default-for-az,Values=true \
    --query 'Subnets[0].SubnetId' \
    --output text)"
fi
if [[ -z "$SUBNET_ID" || "$SUBNET_ID" == "None" ]]; then
  echo "No SUBNET_ID configured and no default subnet found in ${VPC_ID}" >&2
  exit 1
fi

if [[ -z "$AMI_ID" ]]; then
  AMI_ID="$(aws_cmd ssm get-parameter \
    --name /aws/service/canonical/ubuntu/server/24.04/stable/current/amd64/hvm/ebs-gp3/ami-id \
    --query 'Parameter.Value' \
    --output text)"
fi

key_exists="$(aws_cmd ec2 describe-key-pairs \
  --key-names "$KEY_NAME" \
  --query 'KeyPairs[0].KeyName' \
  --output text 2>/dev/null || true)"
if [[ "$key_exists" != "$KEY_NAME" ]]; then
  if [[ ! -f "$SSH_PUBLIC_KEY_PATH" ]]; then
    echo "Key pair ${KEY_NAME} is missing and ${SSH_PUBLIC_KEY_PATH} was not found." >&2
    echo "Create a local SSH key and set SSH_PUBLIC_KEY_PATH, or create the key pair manually." >&2
    exit 1
  fi
  run_aws ec2 import-key-pair \
    --key-name "$KEY_NAME" \
    --public-key-material "fileb://${SSH_PUBLIC_KEY_PATH}" >/dev/null
fi

security_group_id="$(aws_cmd ec2 describe-security-groups \
  --filters "Name=vpc-id,Values=${VPC_ID}" "Name=group-name,Values=${SECURITY_GROUP_NAME}" \
  --query 'SecurityGroups[0].GroupId' \
  --output text 2>/dev/null || true)"
if [[ -z "$security_group_id" || "$security_group_id" == "None" ]]; then
  security_group_id="$(run_aws ec2 create-security-group \
    --group-name "$SECURITY_GROUP_NAME" \
    --description "POC Vault nginx mTLS ingress" \
    --vpc-id "$VPC_ID" \
    --query 'GroupId' \
    --output text)"
  run_aws ec2 create-tags \
    --resources "$security_group_id" \
    --tags "Key=Name,Value=${SECURITY_GROUP_NAME}" "Key=App,Value=poc-vault" >/dev/null
fi

authorize_ingress() {
  local protocol="$1"
  local port="$2"
  local cidr="$3"
  if [[ "$DRY_RUN" == "true" ]]; then
    run_aws ec2 authorize-security-group-ingress \
      --group-id "$security_group_id" \
      --ip-permissions "IpProtocol=${protocol},FromPort=${port},ToPort=${port},IpRanges=[{CidrIp=${cidr}}]" >/dev/null
    return
  fi
  aws_cmd ec2 authorize-security-group-ingress \
    --group-id "$security_group_id" \
    --ip-permissions "IpProtocol=${protocol},FromPort=${port},ToPort=${port},IpRanges=[{CidrIp=${cidr}}]" >/dev/null 2>&1 || true
}

authorize_ingress tcp 443 0.0.0.0/0
if [[ "$ENABLE_HTTP" == "true" ]]; then
  authorize_ingress tcp 80 0.0.0.0/0
fi
if [[ -n "$ADMIN_CIDR" ]]; then
  authorize_ingress tcp 22 "$ADMIN_CIDR"
else
  echo "ADMIN_CIDR is empty; SSH ingress was not opened."
fi

instance_id="$(aws_cmd ec2 describe-instances \
  --filters "Name=tag:Name,Values=${INSTANCE_NAME}" "Name=instance-state-name,Values=pending,running,stopping,stopped" \
  --query 'Reservations[0].Instances[0].InstanceId' \
  --output text 2>/dev/null || true)"

if [[ -z "$instance_id" || "$instance_id" == "None" ]]; then
  instance_id="$(run_aws ec2 run-instances \
    --image-id "$AMI_ID" \
    --instance-type "$INSTANCE_TYPE" \
    --key-name "$KEY_NAME" \
    --subnet-id "$SUBNET_ID" \
    --security-group-ids "$security_group_id" \
    --block-device-mappings 'DeviceName=/dev/sda1,Ebs={VolumeSize=20,VolumeType=gp3,DeleteOnTermination=true,Encrypted=true}' \
    --tag-specifications "ResourceType=instance,Tags=[{Key=Name,Value=${INSTANCE_NAME}},{Key=App,Value=poc-vault}]" \
    --query 'Instances[0].InstanceId' \
    --output text)"
else
  state="$(aws_cmd ec2 describe-instances \
    --instance-ids "$instance_id" \
    --query 'Reservations[0].Instances[0].State.Name' \
    --output text)"
  if [[ "$state" == "stopped" ]]; then
    run_aws ec2 start-instances --instance-ids "$instance_id" >/dev/null
  fi
fi

if [[ "$DRY_RUN" != "true" ]]; then
  aws_cmd ec2 wait instance-running --instance-ids "$instance_id"
fi

public_ip="$(aws_cmd ec2 describe-instances \
  --instance-ids "$instance_id" \
  --query 'Reservations[0].Instances[0].PublicIpAddress' \
  --output text 2>/dev/null || true)"

if [[ "$ALLOCATE_EIP" == "true" && "$DRY_RUN" != "true" ]]; then
  allocation_id="$(aws_cmd ec2 describe-addresses \
    --filters "Name=tag:Name,Values=${INSTANCE_NAME}" \
    --query 'Addresses[0].AllocationId' \
    --output text 2>/dev/null || true)"
  if [[ -z "$allocation_id" || "$allocation_id" == "None" ]]; then
    allocation_id="$(aws_cmd ec2 allocate-address \
      --domain vpc \
      --tag-specifications "ResourceType=elastic-ip,Tags=[{Key=Name,Value=${INSTANCE_NAME}},{Key=App,Value=poc-vault}]" \
      --query 'AllocationId' \
      --output text)"
  fi
  associated_instance="$(aws_cmd ec2 describe-addresses \
    --allocation-ids "$allocation_id" \
    --query 'Addresses[0].InstanceId' \
    --output text 2>/dev/null || true)"
  if [[ "$associated_instance" != "$instance_id" ]]; then
    aws_cmd ec2 associate-address --instance-id "$instance_id" --allocation-id "$allocation_id" >/dev/null
  fi
  public_ip="$(aws_cmd ec2 describe-addresses \
    --allocation-ids "$allocation_id" \
    --query 'Addresses[0].PublicIp' \
    --output text)"
fi

if [[ -n "$HOSTED_ZONE_ID" && -n "$public_ip" && "$public_ip" != "None" && "$DRY_RUN" != "true" ]]; then
  change_batch="$(mktemp)"
  cat >"$change_batch" <<JSON
{
  "Comment": "POC Vault DNS",
  "Changes": [
    {
      "Action": "UPSERT",
      "ResourceRecordSet": {
        "Name": "${VAULT_DOMAIN}",
        "Type": "A",
        "TTL": 60,
        "ResourceRecords": [{ "Value": "${public_ip}" }]
      }
    },
    {
      "Action": "UPSERT",
      "ResourceRecordSet": {
        "Name": "${POC_WILDCARD_DOMAIN}",
        "Type": "A",
        "TTL": 60,
        "ResourceRecords": [{ "Value": "${public_ip}" }]
      }
    }
  ]
}
JSON
  aws route53 change-resource-record-sets \
    --hosted-zone-id "$HOSTED_ZONE_ID" \
    --change-batch "file://${change_batch}" >/dev/null
  rm -f "$change_batch"
elif [[ -z "$HOSTED_ZONE_ID" ]]; then
  echo "HOSTED_ZONE_ID is empty; Route53 records were not updated."
fi

cat <<SUMMARY
POC Vault EC2 target
  region:          ${AWS_REGION}
  instance_id:     ${instance_id}
  public_ip:       ${public_ip:-unknown}
  security_group:  ${security_group_id}
  vault_domain:    ${VAULT_DOMAIN}
  wildcard_domain: ${POC_WILDCARD_DOMAIN}
SUMMARY
