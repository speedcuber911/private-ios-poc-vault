#!/usr/bin/env bash
# Allow the machine-doctor workflow (.github/workflows/machine-doctor.yml,
# dispatched from main) to assume the CLI publisher role and run SSM
# diagnostics on the three Relay boxes. Run from a machine with the
# operator's AWS credentials (the Mac). Idempotent: re-running changes
# nothing once applied, and the existing release-tag trust entry is kept.
set -euo pipefail

ROLE=relay-cli-github-publisher
ACCOUNT=992203938018
SUB="repo:speedcuber911/private-ios-poc-vault:ref:refs/heads/main"
# From product/STATUS.md "relayd deploy story": personal box, Cube host,
# control plane.
INSTANCES=(i-0364bb0f31f506e7c i-077519030563ae4a8 i-0ce97c38c7fd74825)

echo "== current trust policy =="
TRUST=$(aws iam get-role --role-name "$ROLE" --query 'Role.AssumeRolePolicyDocument' --output json)
echo "$TRUST"

NEW_TRUST=$(TRUST="$TRUST" SUB="$SUB" python3 - <<'PY'
import json, os, sys

doc = json.loads(os.environ["TRUST"])
sub = os.environ["SUB"]
key = "token.actions.githubusercontent.com:sub"
touched = False
for statement in doc.get("Statement", []):
    condition = statement.get("Condition", {})
    for op in ("StringLike", "StringEquals"):
        block = condition.get(op)
        if not isinstance(block, dict) or key not in block:
            continue
        value = block[key]
        values = value if isinstance(value, list) else [value]
        if sub not in values:
            values.append(sub)
        block[key] = values
        touched = True
if not touched:
    sys.exit("no statement carries the GitHub OIDC sub condition — refusing to guess")
print(json.dumps(doc))
PY
)

echo "== updating trust policy (adds main-dispatch, keeps release tags) =="
aws iam update-assume-role-policy --role-name "$ROLE" --policy-document "$NEW_TRUST"

echo "== attaching machine-doctor SSM policy =="
SEND_RESOURCES=""
for iid in "${INSTANCES[@]}"; do
  SEND_RESOURCES+="\"arn:aws:ec2:*:${ACCOUNT}:instance/${iid}\","
done
SEND_RESOURCES=${SEND_RESOURCES%,}
aws iam put-role-policy --role-name "$ROLE" --policy-name machine-doctor-ssm --policy-document "{
  \"Version\": \"2012-10-17\",
  \"Statement\": [
    {\"Effect\": \"Allow\",
     \"Action\": [\"ssm:DescribeInstanceInformation\", \"ssm:GetCommandInvocation\", \"ec2:DescribeInstances\"],
     \"Resource\": \"*\"},
    {\"Effect\": \"Allow\",
     \"Action\": \"ssm:SendCommand\",
     \"Resource\": [${SEND_RESOURCES}, \"arn:aws:ssm:*::document/AWS-RunShellScript\"]}
  ]
}"

echo "done — the Machine doctor workflow on main can now diagnose/restart the boxes."
