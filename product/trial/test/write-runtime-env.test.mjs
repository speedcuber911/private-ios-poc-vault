import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const writerPath = fileURLToPath(new URL("../src/write-runtime-env.mjs", import.meta.url));

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "relay-runtime-env-"));
}

function writeEnroll(dir, cfg) {
  const enrollPath = path.join(dir, "enroll.json");
  fs.writeFileSync(enrollPath, JSON.stringify(cfg));
  return enrollPath;
}

function runWriter(enrollPath, outPath, nodeIdPath) {
  const args = [writerPath, enrollPath, outPath];
  if (nodeIdPath !== undefined) args.push(nodeIdPath);
  return spawnSync(process.execPath, args, { encoding: "utf8" });
}

function envFile(outPath) {
  return fs.readFileSync(outPath, "utf8");
}

test("writes RELAYD_GRANT_PUBLIC_KEY from enroll.json into a 0600 env file and does not print it", () => {
  const dir = tmpDir();
  const grantPublicKey = "dGVzdC1ncmFudC1wdWIta2V5LTMyYnl0ZXMh";
  const enrollPath = writeEnroll(dir, {
    cloudUrl: "https://cloud.example",
    grantPublicKey,
  });
  const outPath = path.join(dir, "runtime.env");
  const result = runWriter(enrollPath, outPath);

  assert.equal(result.status, 0, result.stderr);
  const body = envFile(outPath);
  assert.match(body, /^RELAYD_GRANT_PUBLIC_KEY='dGVzdC1ncmFudC1wdWIta2V5LTMyYnl0ZXMh'$/m);
  assert.equal(fs.statSync(outPath).mode & 0o777, 0o600);
  assert.equal(result.stdout.includes(grantPublicKey), false);
  assert.equal(result.stderr.includes(grantPublicKey), false);
});

test("omits RELAYD_GRANT_PUBLIC_KEY when grantPublicKey is absent", () => {
  const dir = tmpDir();
  const enrollPath = writeEnroll(dir, { cloudUrl: "https://cloud.example" });
  const outPath = path.join(dir, "runtime.env");
  const result = runWriter(enrollPath, outPath, path.join(dir, "missing-node-id"));

  assert.equal(result.status, 0, result.stderr);
  const body = envFile(outPath);
  assert.equal(body.includes("RELAYD_GRANT_PUBLIC_KEY"), false);
  assert.equal(body.includes("RELAYD_NODE_ID"), false);
  assert.match(body, /^RELAYD_CLOUD_URL='https:\/\/cloud\.example'$/m);
});

test("exports RELAYD_NODE_ID from a node-id file", () => {
  const dir = tmpDir();
  const enrollPath = writeEnroll(dir, { cloudUrl: "https://cloud.example" });
  const outPath = path.join(dir, "runtime.env");
  const nodeIdPath = path.join(dir, "node-id");
  fs.writeFileSync(nodeIdPath, "node-abcdef0123456789\n");
  const result = runWriter(enrollPath, outPath, nodeIdPath);

  assert.equal(result.status, 0, result.stderr);
  const body = envFile(outPath);
  assert.match(body, /^RELAYD_NODE_ID='node-abcdef0123456789'$/m);
  assert.equal(result.stdout.includes("node-abcdef0123456789"), false);
  assert.equal(result.stderr.includes("node-abcdef0123456789"), false);
});
