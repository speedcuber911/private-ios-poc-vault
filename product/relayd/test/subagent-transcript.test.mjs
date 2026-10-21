import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "relayd-subagents-"));
const workspace = path.join(root, "workspaces", "repo");
fs.mkdirSync(workspace, { recursive: true });
Object.assign(process.env, {
  CODEX_DATA_DIR: path.join(root, "data"), CODEX_RUN_HOME: path.join(root, "home"),
  CODEX_HOME: path.join(root, "codex"), CODEX_WORKSPACE_BROWSE_ROOT: path.join(root, "workspaces"),
  CODEX_WORKSPACES: JSON.stringify([{ id: "repo", name: "Repo", path: workspace }]),
  CODEX_REQUIRE_MTLS: "true", CODEX_ALLOWED_CERT_SUBJECTS: "CN=iphone",
  RELAYD_PAIRING_ENABLED: "false", RELAYD_DIRECT_TLS: "false",
});
const { subagentThreadDetailResponse, readSessionTranscript } = await import("../src/threads.mjs");
after(() => fs.rmSync(root, { recursive: true, force: true }));

const parent = "11111111-1111-4111-8111-111111111111";
const child = "22222222-2222-4222-8222-222222222222";
const nested = "33333333-3333-4333-8333-333333333333";
const unrelated = "44444444-4444-4444-8444-444444444444";
function write(file, entries) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, entries.map(JSON.stringify).join("\n") + "\n");
  return file;
}
function codex(id, parentId) {
  return write(path.join(process.env.CODEX_HOME, "sessions", `rollout-${id}.jsonl`), [
    { type: "session_meta", payload: { id, cwd: workspace,
      ...(parentId ? { source: { subagent: { spawn: { parent_thread_id: parentId } } } } : {}) } },
    { type: "event_msg", payload: { type: "user_message", message: "Inspect the feature" } },
    { type: "event_msg", payload: { type: "agent_message", message: "The native child reply" } },
  ]);
}
codex(parent); codex(child, parent); codex(nested, child); codex(unrelated);
const claudeParent = write(path.join(process.env.CODEX_RUN_HOME, ".claude", "projects", "repo", `${parent}.jsonl`), [
  { type: "user", sessionId: parent, cwd: workspace, message: { content: "Review the feature" } },
]);
const sidechain = path.join(path.dirname(claudeParent), parent, "subagents", "agent-native-child.jsonl");
const childEntries = [
  { type: "user", message: { content: "Check this file" } },
  { type: "assistant", message: { content: [{ type: "text", text: "Reading it now." }] } },
  { type: "assistant", message: { content: [{ type: "tool_use", id: "read-1", name: "Read", input: { file_path: `${workspace}/example.txt` } }] } },
  { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "read-1", content: "file contents" }] } },
  { type: "assistant", message: { content: [{ type: "text", text: "The file looks correct." }] } },
].map((entry) => ({ ...entry, sessionId: parent, agentId: "native-child", cwd: workspace, isSidechain: true }));
write(sidechain, childEntries);

test("Codex native children and grandchildren open through their ancestor", async () => {
  for (const id of [child, nested]) {
    const detail = await subagentThreadDetailResponse(parent, id, { provider: "codex" });
    assert.equal(detail.thread.sessionId, id);
    assert.deepEqual(detail.messages.map((message) => message.text), ["Inspect the feature", "The native child reply"]);
    assert.deepEqual(detail.jobs, [], "opening a child does not create an independent Relay run");
  }
});

test("unrelated children, providers, cycles and unsafe ids are refused", async () => {
  for (const id of [parent, unrelated, "../native-child", "native-child/../../file", ""]) {
    assert.equal(await subagentThreadDetailResponse(parent, id, { provider: "codex" }), null);
  }
  assert.equal(await subagentThreadDetailResponse(parent, child, { provider: "claude" }), null);
  assert.equal(await subagentThreadDetailResponse(parent, child, { provider: "azure" }), null);
  codex(unrelated, unrelated);
  assert.equal(await subagentThreadDetailResponse(parent, unrelated, { provider: "codex" }), null);
});

test("Claude child prose and tools open without leaking inline sidechains into the parent", async () => {
  const detail = await subagentThreadDetailResponse(parent, "native-child", { provider: "claude" });
  assert.deepEqual(detail.messages.map((message) => message.text), ["Check this file", "Reading it now.", "The file looks correct."]);
  assert.equal(detail.messages.at(-1).steps[0].kind, "read");
  const inline = write(path.join(root, "inline.jsonl"), [
    { type: "user", message: { content: "Parent prompt" } }, ...childEntries,
    { type: "assistant", message: { content: "Parent answer" } },
  ]);
  assert.deepEqual((await readSessionTranscript(inline)).messages.map((message) => message.text), ["Parent prompt", "Parent answer"]);
});

test("Claude sidechains cannot follow symlinks or escape an unknown parent", async () => {
  const link = path.join(path.dirname(sidechain), "agent-linked.jsonl");
  fs.symlinkSync(sidechain, link);
  assert.equal(await subagentThreadDetailResponse(parent, "linked", { provider: "claude" }), null);
  assert.equal(await subagentThreadDetailResponse(unrelated, "native-child", { provider: "claude" }), null);
  const saved = path.join(root, "saved-sidechains");
  fs.renameSync(path.dirname(sidechain), saved);
  fs.symlinkSync(saved, path.dirname(sidechain));
  try { assert.equal(await subagentThreadDetailResponse(parent, "native-child", { provider: "claude" }), null); }
  finally { fs.unlinkSync(path.dirname(sidechain)); fs.renameSync(saved, path.dirname(sidechain)); }
});

test("the child conversation route requires the same authentication as the parent", async (t) => {
  const { routeRequest } = await import("../src/server.mjs");
  const server = http.createServer((req, res) => routeRequest(req, res).catch(() => {
    res.writeHead(500); res.end();
  }));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const url = `http://127.0.0.1:${server.address().port}/v1/codex/threads/${parent}/subagents/${child}?provider=codex`;
  assert.equal((await fetch(url)).status, 401);
  const response = await fetch(url, { headers: { "x-ssl-client-verify": "SUCCESS", "x-ssl-client-s-dn": "CN=iphone" } });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).thread.sessionId, child);
  assert.equal((await fetch(url.replace(child, unrelated), { headers: { "x-ssl-client-verify": "SUCCESS", "x-ssl-client-s-dn": "CN=iphone" } })).status, 404);
});
