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
const { compareJobsForList } = await import("../src/jobs.mjs");
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

test("Cursor chats in an unregistered nested folder appear in the unfiltered thread list", () => {
  const nested = path.join(process.env.CODEX_WORKSPACE_BROWSE_ROOT, "sidecar");
  fs.mkdirSync(nested, { recursive: true });
  const nestedId = "77777777-aaaa-4bbb-8ccc-888888888888";
  writeCursorSession(nested, nestedId, "Continue the sidecar work");

  const sessions = listWorkspaceSessions({ limit: 50 });
  const found = sessions.find((session) => session.id === nestedId);
  assert.ok(found, "a Cursor chat whose folder was never selected still lists");
  assert.equal(found.provider, "cursor");
  assert.equal(found.cwd, nested);
  assert.equal(found.workspaceId, "dir-sidecar");
});

test("a live Cursor transcript in a hashed project folder stays visible and fresh", async () => {
  const liveRoot = path.join(process.env.CODEX_WORKSPACE_BROWSE_ROOT, "live-cursor");
  fs.mkdirSync(liveRoot, { recursive: true });
  const canonicalRoot = fs.realpathSync(liveRoot);
  const slug = canonicalRoot.replace(/^\/+/, "").replaceAll("/", "-");
  const prefix = slug.slice(0, slug.length - 6);
  const hashedName = `${prefix}-abc1234`;
  const decoyName = `${prefix}-def5678`;
  const freshId = "99999999-aaaa-4bbb-8ccc-aaaaaaaaaaaa";
  const hashedOnlyId = "12121212-aaaa-4bbb-8ccc-343434343434";
  const decoyId = "56565656-aaaa-4bbb-8ccc-787878787878";

  writeCursorSession(liveRoot, freshId, "Started earlier");
  const projectRoot = path.join(process.env.CODEX_RUN_HOME, ".cursor", "projects", hashedName);
  const transcript = path.join(projectRoot, "agent-transcripts", freshId, `${freshId}.jsonl`);
  fs.mkdirSync(path.dirname(transcript), { recursive: true });
  fs.writeFileSync(transcript, `${JSON.stringify({
    role: "user",
    message: { content: [{ type: "text", text: "Still running in Cursor" }] },
  })}\n`);
  const freshAt = new Date(Date.now() + 60_000);
  fs.utimesSync(transcript, freshAt, freshAt);
  fs.writeFileSync(path.join(projectRoot, "worker.log"), `boot workspacePath=${canonicalRoot} ready\n`);

  const onlyDir = path.join(projectRoot, "agent-transcripts", hashedOnlyId);
  fs.mkdirSync(onlyDir, { recursive: true });
  fs.writeFileSync(path.join(onlyDir, `${hashedOnlyId}.jsonl`), `${JSON.stringify({
    role: "user",
    message: { content: [{ type: "text", text: "Hashed folder only" }] },
  })}\n`);

  const decoyRoot = path.join(process.env.CODEX_RUN_HOME, ".cursor", "projects", decoyName);
  fs.mkdirSync(path.join(decoyRoot, "agent-transcripts", decoyId), { recursive: true });
  fs.writeFileSync(path.join(decoyRoot, "agent-transcripts", decoyId, `${decoyId}.jsonl`), "{}\n");
  fs.writeFileSync(path.join(decoyRoot, "worker.log"), "workspacePath=/tmp/not-this-repo\n");

  const sessions = listWorkspaceSessions({ provider: "cursor", limit: 50 });
  const refreshed = sessions.find((session) => session.id === freshId);
  const hashedOnly = sessions.find((session) => session.id === hashedOnlyId);
  assert.ok(refreshed, "the chat discovered from meta.json is still listed");
  assert.equal(refreshed.updatedAt, fs.statSync(transcript).mtime.toISOString());
  assert.ok(hashedOnly, "a transcript that lives only in the hashed project folder is listed");
  assert.equal(hashedOnly.cwd, canonicalRoot);
  assert.equal(sessions.some((session) => session.id === decoyId), false);

  const threads = listWorkspaceThreads({ workspaceId: hashedOnly.workspaceId, limit: 50 });
  const liveThread = threads.find((thread) => thread.id === hashedOnlyId);
  const freshest = threads.find((thread) => thread.id === freshId);
  assert.equal(liveThread.provider, "cursor");
  assert.equal(liveThread.live, true);
  assert.equal(freshest.live, true);
  assert.equal(threads[0].id, freshId);

  const detail = await threadDetailResponse(hashedOnlyId, { provider: "cursor" });
  assert.equal(detail.thread.cwd, canonicalRoot);
  assert.equal(detail.messages[0].text, "Hashed folder only");
});

test("job lists keep an older running job ahead of newer finished jobs", () => {
  const running = { id: "running", status: "running", createdAt: "2026-09-01T00:00:00.000Z", updatedAt: "2026-09-01T00:00:00.000Z" };
  const finished = { id: "finished", status: "succeeded", createdAt: "2026-09-22T00:00:00.000Z", updatedAt: "2026-09-22T00:00:00.000Z" };
  assert.deepEqual([finished, running].sort(compareJobsForList).map((job) => job.id), ["running", "finished"]);
});
