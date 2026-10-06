import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { ApprovalStore } from "../src/approval-store.mjs";
import { readTimeline } from "../src/timeline.mjs";

const srcDir = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..", "src");

// A fake `codex app-server` that plays one turn in the shapes codex-cli 0.159.2
// sends: prose, reasoning, a command behind an approval, a file change behind a
// second approval, a web search, the answer and the usage.
const FAKE_APP_SERVER = `#!/usr/bin/env node
import readline from "node:readline";
const rl = readline.createInterface({ input: process.stdin });
const say = (message) => console.log(JSON.stringify(message));
const note = (method, params) => say({ method, params: { threadId: "thread-1", turnId: "turn-1", ...params } });
const command = { type: "commandExecution", id: "c1", command: "/bin/zsh -lc 'npm test'", cwd: "/w", commandActions: [{ type: "unknown", command: "npm test" }] };
const change = { type: "fileChange", id: "f1", changes: [{ path: "/w/a.txt", kind: { type: "update", move_path: null }, diff: "@@ -1 +1 @@\\n-a\\n+b\\n" }] };
for await (const line of rl) {
  const m = JSON.parse(line);
  if (m.method === "initialize") say({ id: m.id, result: {} });
  else if (m.method === "thread/start") say({ id: m.id, result: { thread: { id: "thread-1" } } });
  else if (m.method === "turn/start") {
    say({ id: m.id, result: { turn: { id: "turn-1" } } });
    note("turn/started", { turn: { id: "turn-1", status: "inProgress" } });
    note("item/started", { item: { type: "agentMessage", id: "m1", text: "" }, startedAtMs: 1791271900000 });
    note("item/agentMessage/delta", { itemId: "m1", delta: "Checking. " });
    note("item/completed", { item: { type: "agentMessage", id: "m1", text: "Checking. ", phase: "commentary" }, completedAtMs: 1791271900500 });
    note("item/started", { item: { type: "reasoning", id: "r1", summary: [], content: [] }, startedAtMs: 1791271901000 });
    note("item/reasoning/summaryTextDelta", { itemId: "r1", summaryIndex: 0, delta: "Plan it" });
    note("item/completed", { item: { type: "reasoning", id: "r1", summary: ["Plan it"], content: [] }, completedAtMs: 1791271902000 });
    note("item/started", { item: { ...command, status: "inProgress", aggregatedOutput: null, exitCode: null }, startedAtMs: 1791271903000 });
    say({ id: 900, method: "item/commandExecution/requestApproval", params: { threadId: "thread-1", turnId: "turn-1", itemId: "c1", command: command.command, cwd: "/w", availableDecisions: ["accept", "cancel"] } });
  } else if (m.id === 900 && m.result) {
    note("item/commandExecution/outputDelta", { itemId: "c1", delta: "12 passing\\n" });
    note("item/completed", { item: { ...command, status: "completed", aggregatedOutput: "12 passing\\n", exitCode: 0, durationMs: 900 }, completedAtMs: 1791271904000 });
    note("item/started", { item: { ...change, status: "inProgress" }, startedAtMs: 1791271905000 });
    say({ id: 901, method: "item/fileChange/requestApproval", params: { threadId: "thread-1", turnId: "turn-1", itemId: "f1", reason: null } });
  } else if (m.id === 901 && m.result) {
    note("item/completed", { item: { ...change, status: m.result.decision === "accept" ? "completed" : "declined" }, completedAtMs: 1791271906000 });
    note("item/started", { item: { type: "webSearch", id: "w1", query: "relay", action: { type: "search", query: "relay" } }, startedAtMs: 1791271907000 });
    note("item/completed", { item: { type: "webSearch", id: "w1", query: "relay", action: { type: "search", query: "relay" } }, completedAtMs: 1791271908000 });
    note("item/started", { item: { type: "agentMessage", id: "m2", text: "" }, startedAtMs: 1791271909000 });
    note("item/agentMessage/delta", { itemId: "m2", delta: "Done." });
    note("item/completed", { item: { type: "agentMessage", id: "m2", text: "Done.", phase: "final_answer" }, completedAtMs: 1791271909500 });
    note("thread/tokenUsage/updated", { tokenUsage: { total: { totalTokens: 130 }, last: { totalTokens: 130, inputTokens: 120, outputTokens: 10, cachedInputTokens: 100, reasoningOutputTokens: 3 } } });
    note("turn/completed", { turn: { id: "turn-1", status: "completed" } });
  }
}
`;

// The legacy channels, byte for byte, as they were before the timeline existed.
const LEGACY_STDOUT = "Checking. 12 passing\nDone.";
const LEGACY_STDERR = [
  "Plan it",
  "\n[relay-step] Running /bin/zsh -lc 'npm test'\n",
  "\n[relay-step] Waiting for approval: Run command — /bin/zsh -lc 'npm test'\n",
  "\n[relay-step] Approved from Relay\n",
  "\n[relay-step] Editing /w/a.txt\n",
  "\n[relay-step] Waiting for approval: Apply file changes\n",
  "\n[relay-step] Denied from Relay\n",
  "\n[relay-step] Searching relay\n",
].join("");

async function runJob({ timeline }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-codex-timeline-"));
  const workspace = path.join(dir, "workspace");
  const approvals = path.join(dir, "approvals");
  const result = path.join(dir, "answer.md");
  const timelinePath = path.join(dir, "job.timeline.ndjson");
  fs.mkdirSync(workspace);
  const fake = path.join(dir, "fake-codex.mjs");
  fs.writeFileSync(fake, FAKE_APP_SERVER, { mode: 0o755 });

  const env = {
    ...process.env,
    RELAY_JOB_ID: "job-timeline-1",
    RELAY_WORKSPACE_PATH: workspace,
    RELAY_RESULT_PATH: result,
    RELAY_APPROVAL_DIR: approvals,
    RELAY_CODEX_BIN: fake,
    RELAY_CODEX_APPROVAL_POLICY: "on-request",
  };
  delete env.RELAY_TIMELINE_PATH;
  delete env.RELAY_RESUME_SESSION_ID;
  if (timeline) env.RELAY_TIMELINE_PATH = timelinePath;

  const child = spawn(process.execPath, [path.join(srcDir, "codex-job-runner.mjs")], { cwd: workspace, env, stdio: ["pipe", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
  child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
  const exited = new Promise((resolve) => child.once("close", resolve));
  child.stdin.end("run the tests");

  const store = new ApprovalStore(approvals);
  const first = await waitFor(() => store.list({ jobId: "job-timeline-1", status: "pending" })[0], () => stderr);
  // While the runner blocks on the approval, the step it is about is already
  // in the timeline, and still running.
  const whileBlocked = timeline ? readTimeline(timelinePath).events.map((entry) => entry.event) : [];
  store.decide(first.id, "accept", { decidedBy: "test-phone" });
  const second = await waitFor(() => store.list({ jobId: "job-timeline-1", status: "pending" })[0], () => stderr);
  store.decide(second.id, "decline", { decidedBy: "test-phone" });
  const exitCode = await exited;
  return {
    exitCode,
    stdout,
    stderr,
    result: fs.readFileSync(result, "utf8"),
    whileBlocked,
    timelineExists: fs.existsSync(timelinePath),
    events: timeline ? readTimeline(timelinePath).events.map((entry) => entry.event) : [],
  };
}

test("the Codex runner writes a timeline beside unchanged legacy channels", async () => {
  const [plain, recorded] = await Promise.all([runJob({ timeline: false }), runJob({ timeline: true })]);

  for (const run of [plain, recorded]) {
    assert.equal(run.exitCode, 0, run.stderr);
    assert.equal(run.result, "Done.");
    assert.equal(run.stdout, LEGACY_STDOUT);
    assert.equal(run.stderr, LEGACY_STDERR);
  }
  assert.equal(plain.timelineExists, false);

  const blocked = recorded.whileBlocked.filter((event) => event.id === "c1");
  assert.deepEqual(blocked.map((event) => `${event.type}:${event.status}`), ["step:running"]);

  assert.deepEqual(recorded.events, [
    { type: "text", id: "m1", delta: "Checking. " },
    { type: "step", id: "r1", kind: "reasoning", title: "Thinking", status: "running", startedAt: "2026-10-06T07:31:41.000Z" },
    { type: "step.delta", id: "r1", output: "Plan it" },
    { type: "step", id: "r1", status: "done", endedAt: "2026-10-06T07:31:42.000Z", output: "Plan it" },
    {
      type: "step", id: "c1", kind: "command", title: "Bash", summary: "npm test", status: "running",
      startedAt: "2026-10-06T07:31:43.000Z", input: { command: "npm test", cwd: "/w" },
    },
    { type: "step.delta", id: "c1", output: "12 passing\n" },
    { type: "step", id: "c1", status: "done", endedAt: "2026-10-06T07:31:44.000Z", exitCode: 0, output: "12 passing\n" },
    {
      type: "step", id: "f1", kind: "edit", title: "Edit", summary: "a.txt", status: "running",
      startedAt: "2026-10-06T07:31:45.000Z", input: { path: "/w/a.txt", diff: "@@ -1 +1 @@\n-a\n+b\n" },
    },
    // Declined on the phone: closed once, by the decision, not again by Codex.
    { type: "step", id: "f1", status: "cancelled", endedAt: recorded.events[8]?.endedAt, error: "Declined" },
    {
      type: "step", id: "w1", kind: "fetch", title: "Web Search", summary: "relay", status: "running",
      startedAt: "2026-10-06T07:31:47.000Z", input: { query: "relay" },
    },
    { type: "step", id: "w1", status: "done", endedAt: "2026-10-06T07:31:48.000Z" },
    { type: "text", id: "m2", delta: "Done." },
    { type: "usage", inputTokens: 120, outputTokens: 10, cachedInputTokens: 100, reasoningOutputTokens: 3, totalTokens: 130 },
  ]);
  assert.match(recorded.events[8].endedAt, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
});

// A deadline here is a hang detector, not a pass criterion: it returns the
// moment the condition holds and reports the runner's output when it does not.
async function waitFor(read, detail, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = read();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`timed out waiting for condition; runner stderr so far:\n${detail()}`);
}
