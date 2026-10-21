import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "relayd-thread-continue-"));
const workspace = path.join(dir, "workspace");
fs.mkdirSync(workspace, { recursive: true });

process.env.CODEX_DATA_DIR = path.join(dir, "data");
process.env.CODEX_RUN_HOME = path.join(dir, "home");
process.env.CODEX_HOME = path.join(dir, "home", ".codex");
process.env.CODEX_WORKSPACE_BROWSE_ROOT = dir;
process.env.CODEX_WORKSPACES = JSON.stringify([{ id: "scratch", name: "Scratch", path: workspace }]);
process.env.RELAYD_CODEX_TRANSPORT = "app-server";

const {
  continueUnfinishedThreadPrompt,
  applyDiscoveredSessionId,
  createJob,
} = await import("../src/jobs.mjs");
const { maxTimeoutMs } = await import("../src/config.mjs");

test("phone-length agent jobs may run for four hours before the stuck-job cap", () => {
  assert.equal(maxTimeoutMs, 4 * 60 * 60 * 1000);
});

const sessionId = "019e46a5-0000-7000-8000-000000000001";

test("a phone cannot start a competing writer on a live Claude Desktop conversation", async (t) => {
  const project = path.join(process.env.CODEX_RUN_HOME, ".claude", "projects", "test");
  const registry = path.join(process.env.CODEX_RUN_HOME, ".claude", "sessions");
  fs.mkdirSync(project, { recursive: true });
  fs.mkdirSync(registry, { recursive: true });
  fs.writeFileSync(path.join(project, `${sessionId}.jsonl`), JSON.stringify({
    type: "user", cwd: workspace, sessionId, message: { content: "An existing conversation" },
  }) + "\n");
  const record = path.join(registry, `${process.pid}.json`);
  fs.writeFileSync(record, JSON.stringify({
    pid: process.pid, sessionId, cwd: workspace, startedAt: Date.now() - process.uptime() * 1000,
    ...(process.platform === "linux" ? { procStart: fs.readFileSync(`/proc/${process.pid}/stat`, "utf8").split(") ")[1].split(" ")[19] } : {}),
    entrypoint: "claude-desktop", status: "idle",
  }));
  t.after(() => fs.rmSync(record, { force: true }));
  assert.throws(() => createJob({ workspaceId: "scratch", provider: "claude", prompt: "Continue here", resumeSessionId: sessionId }),
    (error) => error.status === 409 && /Claude Desktop/.test(error.message));
});

test("follow-up after a cancelled turn keeps the unfinished instruction on the runner prompt", () => {
  const jobs = [
    {
      provider: "codex",
      status: "cancelled",
      prompt: "finish the booking and send the QR screenshot",
      sessionId,
      createdAt: "2026-09-22T04:24:00.000Z",
    },
  ];
  const prompt = continueUnfinishedThreadPrompt(sessionId, "Go on", jobs);
  assert.match(prompt, /finish the booking and send the QR screenshot/);
  assert.match(prompt, /Go on/);
  assert.equal(
    continueUnfinishedThreadPrompt(sessionId, "Go on", [
      { provider: "codex", status: "succeeded", prompt: "done", sessionId, createdAt: "2026-09-22T04:20:00.000Z" },
    ]),
    "Go on",
  );
});

test("a discovered app-server thread id is adopted only when it is resumable", () => {
  const job = { provider: "codex", sessionId: null };
  assert.equal(applyDiscoveredSessionId(job, "not-a-session"), false);
  assert.equal(job.sessionId, null);
  assert.equal(applyDiscoveredSessionId(job, sessionId), true);
  assert.equal(job.sessionId, sessionId);
  assert.equal(applyDiscoveredSessionId(job, sessionId), false);
});
