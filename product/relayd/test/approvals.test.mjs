import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { ApprovalStore, publicApproval } from "../src/approval-store.mjs";

const srcDir = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..", "src");

test("approval records are private, sanitized, and first-decision-wins", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-approval-store-"));
  const store = new ApprovalStore(dir);
  const created = store.create({
    jobId: "job-1",
    provider: "codex",
    kind: "command",
    title: "Run command",
    command: "npm test",
    requestId: 41,
  });
  assert.equal(fs.statSync(dir).mode & 0o777, 0o700);
  assert.equal(fs.statSync(path.join(dir, `${created.id}.request.json`)).mode & 0o777, 0o600);
  const shaped = publicApproval(store.get(created.id));
  assert.equal(shaped.command, "npm test");
  assert.equal("requestId" in shaped, false);
  assert.equal("itemId" in shaped, false);
  assert.equal(store.decide(created.id, "accept").resolution.decision, "accept");
  assert.throws(() => store.decide(created.id, "decline"), /already resolved/);
});

test("Codex app-server job blocks on a real request and resumes with the phone decision", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-codex-approval-"));
  const workspace = path.join(dir, "workspace");
  const approvals = path.join(dir, "approvals");
  const result = path.join(dir, "answer.md");
  const session = path.join(dir, "session-id");
  fs.mkdirSync(workspace);
  const fake = path.join(dir, "fake-codex.mjs");
  fs.writeFileSync(fake, `#!/usr/bin/env node
import readline from "node:readline";
const rl = readline.createInterface({input:process.stdin});
let thread="thread-real-1";
for await (const line of rl) {
 const m=JSON.parse(line);
 if(m.method==="initialize") console.log(JSON.stringify({id:m.id,result:{}}));
 else if(m.method==="thread/start") { if(m.params?.approvalsReviewer!=="user") process.exit(9); console.log(JSON.stringify({id:m.id,result:{thread:{id:thread}}})); }
 else if(m.method==="turn/start") { if(m.params?.approvalsReviewer!=="user") process.exit(10); console.log(JSON.stringify({id:m.id,result:{turn:{id:"turn-1"}}})); console.log(JSON.stringify({id:900,method:"item/commandExecution/requestApproval",params:{threadId:thread,turnId:"turn-1",itemId:"item-1",command:"npm test",cwd:${JSON.stringify(workspace)},availableDecisions:["accept","decline"]}})); }
 else if(m.id===900 && m.result?.decision) { console.log(JSON.stringify({method:"item/completed",params:{item:{type:"agentMessage",text:"approved answer"}}})); console.log(JSON.stringify({method:"turn/completed",params:{turn:{status:"completed"}}})); }
}
`, { mode: 0o755 });

  const child = spawn(process.execPath, [path.join(srcDir, "codex-job-runner.mjs")], {
    cwd: workspace,
    env: {
      ...process.env,
      RELAY_JOB_ID: "job-real-1",
      RELAY_WORKSPACE_PATH: workspace,
      RELAY_RESULT_PATH: result,
      RELAY_SESSION_RESULT_PATH: session,
      RELAY_APPROVAL_DIR: approvals,
      RELAY_CODEX_BIN: fake,
      RELAY_CODEX_APPROVAL_POLICY: "on-request",
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  child.stdin.end("run the tests");
  const store = new ApprovalStore(approvals);
  const pending = await waitFor(() => store.list({ jobId: "job-real-1", status: "pending" })[0]);
  assert.equal(publicApproval(pending).command, "npm test");
  store.decide(pending.id, "accept", { decidedBy: "test-phone" });
  const exit = await new Promise((resolve) => child.once("exit", resolve));
  assert.equal(exit, 0);
  assert.equal(fs.readFileSync(result, "utf8"), "approved answer");
  assert.equal(fs.readFileSync(session, "utf8").trim(), "thread-real-1");
});

test("Codex app-server reports a bubblewrap workspace startup failure as a failed job", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-codex-bwrap-"));
  const workspace = path.join(dir, "workspace");
  const approvals = path.join(dir, "approvals");
  const result = path.join(dir, "answer.md");
  fs.mkdirSync(workspace);
  const fake = path.join(dir, "fake-codex.mjs");
  fs.writeFileSync(fake, `#!/usr/bin/env node
import readline from "node:readline";
const rl = readline.createInterface({input:process.stdin});
for await (const line of rl) {
 const m=JSON.parse(line);
 if(m.method==="initialize") console.log(JSON.stringify({id:m.id,result:{}}));
 else if(m.method==="thread/start") console.log(JSON.stringify({id:m.id,result:{thread:{id:"thread-bwrap-1"}}}));
 else if(m.method==="turn/start") {
  console.log(JSON.stringify({id:m.id,result:{turn:{id:"turn-bwrap-1"}}}));
  console.log(JSON.stringify({method:"item/completed",params:{item:{type:"commandExecution",status:"failed",aggregatedOutput:"bwrap: Can't find source path /srv/relay-workspaces/example: Permission denied",exitCode:1}}}));
  console.log(JSON.stringify({method:"item/completed",params:{item:{type:"agentMessage",text:"Please reopen the workspace."}}}));
  console.log(JSON.stringify({method:"turn/completed",params:{turn:{status:"completed"}}}));
 }
}
`, { mode: 0o755 });

  const child = spawn(process.execPath, [path.join(srcDir, "codex-job-runner.mjs")], {
    cwd: workspace,
    env: {
      ...process.env,
      RELAY_JOB_ID: "job-bwrap-1",
      RELAY_WORKSPACE_PATH: workspace,
      RELAY_RESULT_PATH: result,
      RELAY_APPROVAL_DIR: approvals,
      RELAY_CODEX_BIN: fake,
      RELAY_CODEX_APPROVAL_POLICY: "never",
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  child.stdin.end("inspect the workspace");

  const exit = await new Promise((resolve) => child.once("exit", resolve));
  assert.equal(exit, 1);
  assert.equal(fs.existsSync(result), false);
  assert.match(stderr, /Codex sandbox could not access the workspace/);
});

test("Claude permission MCP waits for and returns the exact phone decision", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-claude-approval-"));
  const approvals = path.join(dir, "approvals");
  const child = spawn(process.execPath, [path.join(srcDir, "claude-permission-mcp.mjs")], {
    env: { ...process.env, RELAY_JOB_ID: "job-claude-1", RELAY_WORKSPACE_PATH: dir, RELAY_APPROVAL_DIR: approvals },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const lines = [];
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => lines.push(...chunk.trim().split("\n").filter(Boolean).map(JSON.parse)));
  child.stdin.write(`${JSON.stringify({jsonrpc:"2.0",id:1,method:"initialize",params:{protocolVersion:"2025-06-18"}})}\n`);
  child.stdin.write(`${JSON.stringify({jsonrpc:"2.0",id:2,method:"tools/call",params:{name:"approve",arguments:{tool_name:"Bash",input:{command:"git status"}}}})}\n`);
  const store = new ApprovalStore(approvals);
  const pending = await waitFor(() => store.list({ jobId: "job-claude-1", status: "pending" })[0]);
  store.decide(pending.id, "decline", { message: "Not now" });
  const response = await waitFor(() => lines.find((line) => line.id === 2));
  const payload = JSON.parse(response.result.content[0].text);
  assert.equal(payload.behavior, "deny");
  assert.equal(payload.message, "Not now");
  const stopped = new Promise((resolve) => child.once("exit", resolve));
  child.kill("SIGTERM");
  await stopped;
});

async function waitFor(read, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = read();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("timed out waiting for condition");
}
