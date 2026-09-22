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
} = await import("../src/jobs.mjs");

const sessionId = "019e46a5-0000-7000-8000-000000000001";

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
