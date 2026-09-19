import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const bootstrap = fs.mkdtempSync(path.join(os.tmpdir(), "relayd-threads-providers-"));
const workspacePath = path.join(bootstrap, "workspaces", "repo");
fs.mkdirSync(workspacePath, { recursive: true });
process.env.CODEX_DATA_DIR = path.join(bootstrap, "data");
process.env.CODEX_RUN_HOME = path.join(bootstrap, "run-home");
process.env.CODEX_HOME = path.join(bootstrap, "codex-home");
process.env.CODEX_WORKSPACE_BROWSE_ROOT = path.join(bootstrap, "workspaces");
process.env.CODEX_WORKSPACES = JSON.stringify([{
  id: "repo",
  name: "Repo",
  path: workspacePath,
}]);

const {
  listWorkspaceSessions,
  listWorkspaceThreads,
  threadDetailResponse,
  cursorWorkspaceHash,
} = await import("../src/threads.mjs");
const { claudeProjectSlug } = await import("../src/sessionimport.mjs");

const CLAUDE_ID = "11111111-aaaa-4bbb-8ccc-222222222222";
const CURSOR_ID = "33333333-aaaa-4bbb-8ccc-444444444444";
const OTHER_ID = "55555555-aaaa-4bbb-8ccc-666666666666";

function writeClaudeSession(cwd, id, prompt) {
  const file = path.join(process.env.CODEX_RUN_HOME, ".claude", "projects", claudeProjectSlug(cwd), `${id}.jsonl`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${[
    { type: "user", cwd, timestamp: "2026-09-19T10:00:00.000Z", message: { content: prompt } },
    { type: "assistant", timestamp: "2026-09-19T10:00:01.000Z", message: { content: [{ type: "text", text: "done" }] } },
  ].map((line) => JSON.stringify(line)).join("\n")}\n`);
  return file;
}

function writeCursorSession(cwd, id, prompt) {
  const sessionDir = path.join(process.env.CODEX_RUN_HOME, ".cursor", "chats", cursorWorkspaceHash(cwd), id);
  fs.mkdirSync(sessionDir, { recursive: true });
  fs.writeFileSync(path.join(sessionDir, "meta.json"), `${JSON.stringify({
    schemaVersion: 1,
    cwd,
    createdAtMs: Date.parse("2026-09-19T11:00:00.000Z"),
    hasConversation: true,
  })}\n`);
  fs.writeFileSync(path.join(sessionDir, "transcript.jsonl"), `${[
    { role: "user", message: { content: [{ type: "text", text: prompt }] } },
    { role: "assistant", message: { content: [{ type: "text", text: "cursor done" }] } },
  ].map((line) => JSON.stringify(line)).join("\n")}\n`);
}

test("native Claude and Cursor transcripts appear in the same workspace session list as Codex", async () => {
  writeClaudeSession(workspacePath, CLAUDE_ID, "Fix the Claude session list");
  writeCursorSession(workspacePath, CURSOR_ID, "Show Cursor history");
  writeClaudeSession("/tmp/other-project", OTHER_ID, "Do not leak this");

  const sessions = listWorkspaceSessions({ workspaceId: "repo", limit: 50, includeSummary: true });
  assert.deepEqual(sessions.map((session) => session.provider).sort(), ["claude", "cursor"]);
  const claude = sessions.find((session) => session.id === CLAUDE_ID);
  const cursor = sessions.find((session) => session.id === CURSOR_ID);
  assert.equal(claude.workspaceId, "repo");
  assert.equal(claude.summary.firstUserPrompt, "Fix the Claude session list");
  assert.equal(cursor.workspaceId, "repo");
  assert.equal(cursor.summary.firstUserPrompt, "Show Cursor history");
  assert.equal(sessions.some((session) => session.id === OTHER_ID), false);

  const claudeOnly = listWorkspaceSessions({ workspaceId: "repo", provider: "claude", limit: 50 });
  assert.deepEqual(claudeOnly.map((session) => session.id), [CLAUDE_ID]);
  const cursorOnly = listWorkspaceSessions({ workspaceId: "repo", provider: "cursor", limit: 50 });
  assert.deepEqual(cursorOnly.map((session) => session.id), [CURSOR_ID]);

  const threads = listWorkspaceThreads({ workspaceId: "repo", limit: 50 });
  assert.deepEqual(new Set(threads.map((thread) => thread.provider)), new Set(["claude", "cursor"]));

  const claudeDetail = await threadDetailResponse(CLAUDE_ID, { provider: "claude" });
  assert.equal(claudeDetail.thread.provider, "claude");
  assert.deepEqual(claudeDetail.messages.map((message) => message.role), ["user", "assistant"]);
  assert.equal(claudeDetail.messages[0].text, "Fix the Claude session list");

  const cursorDetail = await threadDetailResponse(CURSOR_ID);
  assert.equal(cursorDetail.thread.provider, "cursor");
  assert.equal(cursorDetail.messages.at(-1).text, "cursor done");
});
