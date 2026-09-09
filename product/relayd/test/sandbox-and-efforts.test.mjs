import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { ApprovalStore } from "../src/approval-store.mjs";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "relayd-sandbox-efforts-"));
const workspace = path.join(dir, "workspace");
fs.mkdirSync(workspace, { recursive: true });

process.env.CODEX_DATA_DIR = path.join(dir, "data");
process.env.CODEX_RUN_HOME = path.join(dir, "home");
process.env.CODEX_HOME = path.join(dir, "home", ".codex");
process.env.CODEX_WORKSPACE_BROWSE_ROOT = dir;
process.env.CODEX_WORKSPACES = JSON.stringify([{ id: "scratch", name: "Scratch", path: workspace }]);
process.env.RELAYD_CODEX_TRANSPORT = "app-server";

const {
  cleanOptionalCodexSandbox,
  buildJobEnv,
  buildExecutionReceipt,
  publicExecutionReceipt,
} = await import("../src/jobs.mjs");
const { buildCodexArgs } = await import("../src/adapters/codex.mjs");

const catalogSource = fs.readFileSync(new URL("../src/catalog.mjs", import.meta.url), "utf8");

test("sandbox validation accepts exactly the three Codex values and rejects others", () => {
  assert.equal(cleanOptionalCodexSandbox(undefined), "workspace-write");
  assert.equal(cleanOptionalCodexSandbox(null), "workspace-write");
  assert.equal(cleanOptionalCodexSandbox(""), "workspace-write");
  assert.equal(cleanOptionalCodexSandbox("read-only"), "read-only");
  assert.equal(cleanOptionalCodexSandbox("workspace-write"), "workspace-write");
  assert.equal(cleanOptionalCodexSandbox("danger-full-access"), "danger-full-access");
  assert.throws(() => cleanOptionalCodexSandbox("full"), /sandbox must be/);
  assert.throws(() => cleanOptionalCodexSandbox("danger"), /sandbox must be/);
  assert.throws(() => cleanOptionalCodexSandbox(12), /sandbox must be/);
});

test("danger-full-access is opt-in and workspace-write remains the built-in default", () => {
  const envDefault = buildJobEnv({
    id: "job-sandbox-default",
    provider: "codex",
    workspacePath: workspace,
    resultPath: path.join(dir, "answer-default.md"),
    approvalPolicy: "on-request",
  });
  assert.equal(envDefault.RELAY_CODEX_SANDBOX, "workspace-write");

  const envFull = buildJobEnv({
    id: "job-sandbox-full",
    provider: "codex",
    workspacePath: workspace,
    resultPath: path.join(dir, "answer-full.md"),
    approvalPolicy: "never",
    sandbox: "danger-full-access",
  });
  assert.equal(envFull.RELAY_CODEX_SANDBOX, "danger-full-access");

  const args = buildCodexArgs({
    approvalPolicy: "never",
    sandbox: "danger-full-access",
    workspacePath: workspace,
    resultPath: path.join(dir, "answer-args.md"),
  });
  assert.equal(args[args.indexOf("--sandbox") + 1], "danger-full-access");

  const receipt = buildExecutionReceipt({
    provider: "codex",
    sandbox: "danger-full-access",
    approvalPolicy: "never",
    skills: [],
  });
  assert.equal(receipt.sandbox, "danger-full-access");
  assert.equal(publicExecutionReceipt(receipt).sandbox, "danger-full-access");
});

test("max and ultra survive catalog discovery allowlists", () => {
  assert.match(catalogSource, /\["low", "medium", "high", "xhigh", "max", "ultra"\]/);
  assert.equal(
    (catalogSource.match(/\["low", "medium", "high", "xhigh", "max", "ultra"\]/g) || []).length >= 2,
    true,
  );
});

test("waitForDecision times out with an approval-named error", async () => {
  const approvals = fs.mkdtempSync(path.join(os.tmpdir(), "relay-approval-timeout-"));
  const store = new ApprovalStore(approvals);
  const record = store.create({
    jobId: "job-timeout",
    provider: "codex",
    kind: "command",
    title: "Run command",
    command: "true",
  });
  await assert.rejects(
    () => store.waitForDecision(record.id, { timeoutMs: 50, pollMs: 10 }),
    (error) => {
      assert.match(error.message, /Timed out waiting for an approval decision from Relay/);
      assert.equal(error.code, "approval_timeout");
      return true;
    },
  );
});
