import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

const cliRoot = fileURLToPath(new URL("..", import.meta.url));
const bootstrap = path.join(cliRoot, "deploy", "bootstrap.sh");
const distributionTemplate = path.join(cliRoot, "deploy", "distribution.yml");

test("distribution uses AWS's current managed cache policies", () => {
  const source = fs.readFileSync(distributionTemplate, "utf8");
  assert.match(source, /658327ea-f89d-4fab-a63d-7e88639e58f6/);
  assert.equal(
    source.match(/4135ea2d-6df8-44a3-9df3-4b5a84be39ad/g)?.length,
    2,
  );
  assert.doesNotMatch(source, /413f160b-31d3-4ca6-9dd5-1f56774e25d5/);
});

test("distribution bootstrap refuses the wrong AWS account before CloudFormation", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "relay-cli-bootstrap-"));
  const fakeBin = path.join(root, "bin");
  const calls = path.join(root, "aws-calls");
  fs.mkdirSync(fakeBin);
  fs.writeFileSync(path.join(fakeBin, "aws"), `#!/bin/sh
printf '%s\\n' "$*" >>"$AWS_CALLS"
if [ "$1 $2" = "sts get-caller-identity" ]; then
  printf '%s\\n' '111111111111'
  exit 0
fi
exit 99
`, { mode: 0o755 });

  const result = spawnSync("bash", [bootstrap], {
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${fakeBin}:${process.env.PATH}`,
      AWS_CALLS: calls,
      AWS_REGION: "us-east-1",
      RELAY_CLI_DISTRIBUTION_DOMAIN: "get.relay.example.com",
      RELAY_CLI_EXPECTED_AWS_ACCOUNT_ID: "222222222222",
      RELAY_CLI_GITHUB_OIDC_PROVIDER_ARN: "arn:aws:iam::222222222222:oidc-provider/token.actions.githubusercontent.com",
      RELAY_CLI_HOSTED_ZONE_ID: "Z0123456789",
    },
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /active AWS account is 111111111111, expected 222222222222/);
  const invocations = fs.readFileSync(calls, "utf8").trim().split("\n");
  assert.deepEqual(invocations, ["sts get-caller-identity --query Account --output text"]);
});
