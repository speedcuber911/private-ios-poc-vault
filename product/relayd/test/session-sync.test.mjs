import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const bootstrap = fs.mkdtempSync(path.join(os.tmpdir(), "relayd-session-sync-bootstrap-"));
process.env.CODEX_DATA_DIR = path.join(bootstrap, "data");
process.env.CODEX_RUN_HOME = path.join(bootstrap, "run-home");
process.env.CODEX_HOME = path.join(bootstrap, "codex-home");
process.env.CODEX_WORKSPACE_BROWSE_ROOT = path.join(bootstrap, "workspaces");
process.env.CODEX_WORKSPACES = JSON.stringify([{
  id: "bootstrap",
  name: "Bootstrap",
  path: path.join(bootstrap, "workspaces", "bootstrap"),
}]);

const {
  planSessionImports, importCodexSession, createSessionUpload,
  appendSessionUpload, completeSessionUpload, syncStatePath,
} = await import("../src/session-sync.mjs");
const { claudeProjectSlug, cursorWorkspaceHash } = await import("../src/sessionimport.mjs");

const ID = "11111111-2222-4333-8444-555555555555";
const SOURCE_CWD = "/Users/dev/code/relay";

function transcript(extra = "") {
  return Buffer.from([
    JSON.stringify({
      timestamp: "2026-09-17T10:00:00.000Z",
      type: "session_meta",
      payload: { id: ID, cwd: SOURCE_CWD, timestamp: "2026-09-17T10:00:00.000Z", provider: "codex" },
    }),
    JSON.stringify({ type: "response_item", payload: { type: "message", role: "user", content: [{ text: "hello" }] } }),
    extra,
  ].filter(Boolean).join("\n") + "\n", "utf8");
}

function descriptor(bytes) {
  return {
    id: ID,
    sha256: crypto.createHash("sha256").update(bytes).digest("hex"),
    sizeBytes: bytes.length,
    createdAt: "2026-09-17T10:00:00.000Z",
    updatedAt: "2026-09-17T10:05:00.000Z",
  };
}

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "relayd-session-sync-"));
  const workspace = { id: "repo", name: "Repo", path: path.join(root, "workspace") };
  const targetCodexHome = path.join(root, "codex");
  const targetRunHome = path.join(root, "home");
  const baseDir = path.join(root, "data");
  fs.mkdirSync(workspace.path, { recursive: true });
  return {
    root, workspace, targetCodexHome, targetRunHome, baseDir,
    resolveWorkspace: (id) => id === workspace.id ? workspace : null,
  };
}

test("direct session sync imports a native Codex rollout and updates it incrementally", () => {
  const f = fixture();
  const first = transcript();
  const plan = planSessionImports({ v: 1, workspaceId: "repo", sessions: [descriptor(first)] }, f);
  assert.deepEqual(plan.sessions, [{ id: ID, status: "upload", reason: null }]);

  const imported = importCodexSession({
    v: 1,
    workspaceId: "repo",
    sourceCwd: SOURCE_CWD,
    session: { ...descriptor(first), transcript: first.toString("base64") },
  }, f);
  assert.equal(imported.status, "imported");
  const sessionDir = path.join(f.targetCodexHome, "sessions");
  const files = fs.readdirSync(sessionDir);
  assert.equal(files.length, 1);
  assert.match(files[0], new RegExp(`${ID}\\.jsonl$`));
  const installed = fs.readFileSync(path.join(sessionDir, files[0]), "utf8");
  assert.match(installed, new RegExp(f.workspace.path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.doesNotMatch(installed, /\/Users\/dev\/code\/relay/);
  assert.equal(fs.statSync(syncStatePath(f.baseDir)).mode & 0o777, 0o600);

  const current = planSessionImports({ v: 1, workspaceId: "repo", sessions: [descriptor(first)] }, f);
  assert.equal(current.sessions[0].status, "current");

  const second = transcript(JSON.stringify({
    type: "response_item",
    payload: { type: "message", role: "assistant", content: [{ text: "continued locally" }] },
  }));
  assert.equal(planSessionImports({ v: 1, workspaceId: "repo", sessions: [descriptor(second)] }, f).sessions[0].status, "upload");
  const updated = importCodexSession({
    v: 1,
    workspaceId: "repo",
    sourceCwd: SOURCE_CWD,
    session: { ...descriptor(second), transcript: second.toString("base64") },
  }, f);
  assert.equal(updated.status, "updated");
  assert.equal(fs.readdirSync(sessionDir).length, 1, "an update must replace the same native rollout");
  assert.match(fs.readFileSync(path.join(sessionDir, files[0]), "utf8"), /continued locally/);
});

test("direct session sync rematerializes a dynamic workspace from its validated path", () => {
  const f = fixture();
  const workspace = { ...f.workspace, id: "dir-projects-private-ios-poc-vault", dynamic: true };
  let materialized = false;
  const options = {
    ...f,
    resolveWorkspace: () => null,
    browseWorkspace: (workspacePath, { materialize } = {}) => {
      assert.equal(workspacePath, workspace.path);
      materialized = materialize;
      return workspace;
    },
  };
  const bytes = transcript();
  const plan = planSessionImports({
    v: 1,
    workspaceId: workspace.id,
    workspacePath: workspace.path,
    sessions: [descriptor(bytes)],
  }, options);
  assert.equal(materialized, true);
  assert.equal(plan.workspaceId, workspace.id);
  assert.equal(plan.sessions[0].status, "upload");

  assert.throws(() => planSessionImports({
    v: 1,
    workspaceId: "dir-different-repo",
    workspacePath: workspace.path,
    sessions: [descriptor(bytes)],
  }, options), (error) => error.status === 400 && error.message === "unknown workspaceId");
});

test("a current transcript accepts a renamed native Codex title without reuploading", () => {
  const f = fixture();
  const bytes = transcript();
  importCodexSession({
    v: 1,
    workspaceId: "repo",
    sourceCwd: SOURCE_CWD,
    session: { ...descriptor(bytes), title: "Old title", transcript: bytes.toString("base64") },
  }, f);

  const plan = planSessionImports({
    v: 1,
    workspaceId: "repo",
    sessions: [{ ...descriptor(bytes), title: "Improve iOS chat screen UX" }],
  }, f);

  assert.equal(plan.sessions[0].status, "current");
  const state = JSON.parse(fs.readFileSync(syncStatePath(f.baseDir), "utf8"));
  assert.equal(state.sessions[`repo:${ID}`].title, "Improve iOS chat screen UX");
});

test("direct session sync never overwrites a session continued on the Relay machine", () => {
  const f = fixture();
  const first = transcript();
  importCodexSession({
    v: 1,
    workspaceId: "repo",
    sourceCwd: SOURCE_CWD,
    session: { ...descriptor(first), transcript: first.toString("base64") },
  }, f);
  const sessionDir = path.join(f.targetCodexHome, "sessions");
  const installed = path.join(sessionDir, fs.readdirSync(sessionDir)[0]);
  fs.appendFileSync(installed, `${JSON.stringify({ type: "response_item", payload: { type: "message", role: "assistant", content: [{ text: "remote turn" }] } })}\n`);

  const newerLocal = transcript(JSON.stringify({ type: "response_item", payload: { type: "message", role: "user", content: [{ text: "local turn" }] } }));
  const plan = planSessionImports({ v: 1, workspaceId: "repo", sessions: [descriptor(newerLocal)] }, f);
  assert.deepEqual(plan.sessions, [{ id: ID, status: "conflict", reason: "remote_session_changed" }]);
  assert.throws(() => importCodexSession({
    v: 1,
    workspaceId: "repo",
    sourceCwd: SOURCE_CWD,
    session: { ...descriptor(newerLocal), transcript: newerLocal.toString("base64") },
  }, f), (error) => error.status === 409 && error.message === "remote_session_changed");
  assert.match(fs.readFileSync(installed, "utf8"), /remote turn/);
  assert.doesNotMatch(fs.readFileSync(installed, "utf8"), /local turn/);
});

test("direct session sync imports Claude and Cursor transcripts into native runner homes", () => {
  const f = fixture();
  const claudeId = "aaaaaaaa-1111-4222-8333-bbbbbbbbbbbb";
  const cursorId = "cccccccc-1111-4222-8333-dddddddddddd";
  const claudeBytes = Buffer.from(`${JSON.stringify({
    type: "user",
    cwd: SOURCE_CWD,
    message: { content: "Fix Claude history" },
  })}\n`, "utf8");
  const cursorBytes = Buffer.from(`${JSON.stringify({
    role: "user",
    message: { content: [{ type: "text", text: "Show Cursor history" }] },
  })}\n`, "utf8");

  const claude = importCodexSession({
    v: 1,
    workspaceId: "repo",
    sourceCwd: SOURCE_CWD,
    session: {
      id: claudeId,
      harness: "claude",
      sessionFormat: "claude-jsonl",
      sha256: crypto.createHash("sha256").update(claudeBytes).digest("hex"),
      sizeBytes: claudeBytes.length,
      transcript: claudeBytes.toString("base64"),
    },
  }, f);
  const cursor = importCodexSession({
    v: 1,
    workspaceId: "repo",
    sourceCwd: SOURCE_CWD,
    session: {
      id: cursorId,
      harness: "cursor",
      sessionFormat: "cursor-jsonl",
      sha256: crypto.createHash("sha256").update(cursorBytes).digest("hex"),
      sizeBytes: cursorBytes.length,
      transcript: cursorBytes.toString("base64"),
    },
  }, f);
  assert.equal(claude.status, "imported");
  assert.equal(cursor.status, "imported");

  const claudeFile = path.join(f.targetRunHome, ".claude", "projects", claudeProjectSlug(f.workspace.path), `${claudeId}.jsonl`);
  const cursorFile = path.join(
    f.targetRunHome, ".cursor", "chats", cursorWorkspaceHash(f.workspace.path), cursorId, "transcript.jsonl",
  );
  assert.match(fs.readFileSync(claudeFile, "utf8"), /Fix Claude history/);
  assert.match(fs.readFileSync(claudeFile, "utf8"), new RegExp(f.workspace.path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(fs.readFileSync(cursorFile, "utf8"), /Show Cursor history/);
  assert.equal(
    JSON.parse(fs.readFileSync(path.join(path.dirname(cursorFile), "meta.json"), "utf8")).cwd,
    f.workspace.path,
  );
});

test("direct session sync rejects transcript identity and cwd mismatches", () => {
  const f = fixture();
  const bytes = transcript();
  assert.throws(() => importCodexSession({
    v: 1,
    workspaceId: "repo",
    sourceCwd: "/different/repo",
    session: { ...descriptor(bytes), transcript: bytes.toString("base64") },
  }, f), /sourceCwd does not match transcript/);

  const wrong = Buffer.from(transcript().toString("utf8").replace(ID, "22222222-2222-4333-8444-555555555555"));
  assert.throws(() => importCodexSession({
    v: 1,
    workspaceId: "repo",
    sourceCwd: SOURCE_CWD,
    session: { ...descriptor(wrong), id: ID, transcript: wrong.toString("base64") },
  }, f), /session id does not match transcript/);
});

test("chunked uploads enforce offsets and complete through the same native importer", () => {
  const f = fixture();
  const bytes = transcript(JSON.stringify({
    type: "response_item",
    payload: { type: "message", role: "assistant", content: [{ text: "chunked" }] },
  }));
  const started = createSessionUpload({
    v: 1,
    workspaceId: "repo",
    sourceCwd: SOURCE_CWD,
    session: descriptor(bytes),
  }, f);
  assert.equal(started.status, "upload");
  const split = Math.floor(bytes.length / 2);
  const first = bytes.subarray(0, split);
  const second = bytes.subarray(split);
  assert.deepEqual(
    appendSessionUpload(started.uploadId, { offset: 0, data: first.toString("base64") }),
    { status: "uploading", uploadId: started.uploadId, received: first.length, sizeBytes: bytes.length },
  );
  assert.throws(
    () => appendSessionUpload(started.uploadId, { offset: 0, data: second.toString("base64") }),
    (error) => error.status === 409 && /offset/.test(error.message),
  );
  appendSessionUpload(started.uploadId, { offset: first.length, data: second.toString("base64") });
  assert.equal(completeSessionUpload(started.uploadId).status, "imported");
  assert.match(fs.readFileSync(path.join(f.targetCodexHome, "sessions", fs.readdirSync(path.join(f.targetCodexHome, "sessions"))[0]), "utf8"), /chunked/);
  assert.throws(() => completeSessionUpload(started.uploadId), (error) => error.status === 404);
});
