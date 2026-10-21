import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { freePort, waitForServer } from "./helpers/wait.mjs";

const src = path.resolve(import.meta.dirname, "../src");
async function until(check) {
  for (let i = 0; i < 500; i++) {
    if (check()) return;
    await sleep(10);
  }
  assert.fail("Timed out waiting for the fixture runner");
}

const fake = `#!/usr/bin/env node
import fs from "node:fs";
import readline from "node:readline";
if (process.argv[2] === "--version") { console.log("9.9.9 (Fake Claude Code)"); process.exit(0); }
if (process.argv[2] === "--help") { console.log("--model --effort --permission-mode"); process.exit(0); }
if (process.argv[2] === "auth") { console.log(JSON.stringify({ loggedIn: true, authMethod: "claude.ai" })); process.exit(0); }
const claude = process.env.FAKE_PROVIDER === "claude";
const log = (value) => fs.appendFileSync("calls.jsonl", JSON.stringify(value) + "\\n");
const say = (value) => console.log(JSON.stringify(value));
const note = (method, params) => say({ method, params: { threadId: "thread-1", ...params } });
let turn, sequence = 0;
function complete() {
  if (!turn) return;
  if (claude) say({ type: "result", subtype: "success", result: "Done", is_error: false });
  else note("turn/completed", { turn: { id: turn, status: "completed" } });
  turn = null;
}

const timer = setInterval(() => { if (fs.existsSync("release")) complete(); }, 20);
const lines = readline.createInterface({ input: process.stdin });
for await (const line of lines) {
  const m = JSON.parse(line);
  log(m);
  if (claude) {
    if (m.type === "control_request") {
      complete();
      say({ type: "control_response", response: { subtype: "success", request_id: m.request_id } });
    } else if (m.type === "user") {
      turn = "turn-" + (++sequence);
      say({ type: "system", subtype: "init", session_id: "session-1" });
      say(m); // --replay-user-messages acknowledges provider acceptance
      fs.writeFileSync("ready", "1");
    }
  } else if (m.method === "initialize") say({ id: m.id, result: {} });
  else if (m.method === "thread/start") say({ id: m.id, result: { thread: { id: "thread-1" } } });
  else if (m.method === "turn/start") {
    turn = "turn-" + (++sequence);
    say({ id: m.id, result: { turn: { id: turn } } });
    note("turn/started", { turn: { id: turn } });
    fs.writeFileSync("ready", "1");
  } else if (m.method === "turn/steer") {
    if (m.params.expectedTurnId !== turn) say({ id: m.id, error: { code: -1, message: "wrong turn" } });
    else say({ id: m.id, result: { turnId: turn } });
  }
}
clearInterval(timer);
`;

for (const provider of ["codex", "claude"]) {
  test(`${provider}: queue, promote, acknowledge, resume and finish through the real runner`, async (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "relay-interactive-"));
    const binary = path.join(root, "provider.mjs");
    fs.writeFileSync(binary, fake, { mode: 0o755 });
    const child = spawn(process.execPath, [path.join(src, `${provider}-job-runner.mjs`)], {
      cwd: root,
      env: { ...process.env, FAKE_PROVIDER: provider, RELAY_INTERACTIVE_INPUT: "1",
        RELAY_JOB_ID: "job", RELAY_WORKSPACE_PATH: root, RELAY_RESULT_PATH: path.join(root, "result"),
        RELAY_APPROVAL_DIR: path.join(root, "approvals"), RELAY_TIMELINE_PATH: path.join(root, "timeline"),
        RELAY_CODEX_BIN: binary, RELAY_CLAUDE_BIN: binary, RELAY_RESUME_SESSION_ID: "" },
      stdio: ["pipe", "pipe", "pipe", "ipc"],
    });
    t.after(() => { child.kill("SIGKILL"); fs.rmSync(root, { recursive: true, force: true }); });
    let stderr = "";
    child.stdout.resume();
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    const events = [];
    child.on("message", (event) => events.push(event));
    const exited = new Promise((resolve) => child.once("exit", resolve));
    child.stdin.end("Initial task");
    await until(() => fs.existsSync(path.join(root, "ready")));
    const send = (id, mode, text) => child.send({ type: "input.submit", message: { id, mode, text } });
    send("queued", "queue", "After this turn");
    await until(() => events.some((e) => e.id === "queued" && e.status === "queued"));
    send("urgent", "queue", "Change direction");
    await until(() => events.some((e) => e.id === "urgent" && e.status === "queued"));
    send("urgent", "now", "Change direction");
    await until(() => events.some((e) => e.id === "urgent" && e.status === "sent"));
    send("urgent", "now", "Change direction");
    fs.writeFileSync(path.join(root, "release"), "1");
    assert.equal(await exited, 0, stderr);
    assert.equal(events.filter((e) => e.id === "urgent" && e.status === "sent").length, 1);
    assert.equal(events.filter((e) => e.id === "queued" && e.status === "sent").length, 1);
    const calls = fs.readFileSync(path.join(root, "calls.jsonl"), "utf8").trim().split("\n").map(JSON.parse);
    if (provider === "codex") {
      assert.equal(calls.filter((c) => c.method === "turn/steer").length, 1);
      assert.equal(calls.find((c) => c.method === "turn/steer").params.expectedTurnId, "turn-1");
      assert.deepEqual(calls.filter((c) => c.method === "turn/start").map((c) => c.params.input[0].text), ["Initial task", "After this turn"]);
    } else {
      assert.equal(calls.filter((c) => c.type === "control_request").length, 1);
      assert.equal(calls.find((c) => c.type === "control_request").request.subtype, "interrupt");
      assert.deepEqual(calls.filter((c) => c.type === "user").map((c) => c.message.content), ["Initial task", "Change direction", "After this turn"]);
    }
    const timeline = fs.readFileSync(path.join(root, "timeline"), "utf8").trim().split("\n").map(JSON.parse);
    assert.deepEqual(timeline.filter((e) => e.type === "user" && e.status === "sent").map((e) => e.id), ["urgent", "queued"]);
  });
}

test("the daemon accepts a phone follow-up and reports native delivery on the same job", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "relay-phone-input-"));
  const workspace = path.join(root, "workspace");
  const home = path.join(root, "home");
  fs.mkdirSync(workspace);
  fs.mkdirSync(home);
  const binary = path.join(root, "provider.mjs");
  fs.writeFileSync(binary, fake, { mode: 0o755 });
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const server = spawn(process.execPath, [path.join(src, "index.mjs")], {
    env: { ...process.env, FAKE_PROVIDER: "claude", CODEX_API_HOST: "127.0.0.1", CODEX_API_PORT: String(port),
      RELAYD_DIRECT_TLS: "false", RELAYD_PAIRING_ENABLED: "false", CODEX_REQUIRE_MTLS: "false",
      CODEX_DATA_DIR: path.join(root, "data"), CODEX_RUN_HOME: home, CODEX_HOME: path.join(home, ".codex"),
      CODEX_WORKSPACE_BROWSE_ROOT: root, CODEX_WORKSPACES: JSON.stringify([{ id: "scratch", name: "Scratch", path: workspace }]),
      CLAUDE_BIN: binary, CODEX_BIN: path.join(root, "no-codex"), KIMI_BIN: path.join(root, "no-kimi"),
      CLAUDE_CODE_USE_BEDROCK: "", CLAUDE_AWS_PROFILE: "", RELAYD_CLAUDE_TRANSPORT: "stream" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  server.stdout.on("data", (chunk) => { output += chunk; });
  server.stderr.on("data", (chunk) => { output += chunk; });
  const exited = new Promise((resolve) => server.once("exit", resolve));
  t.after(async () => { server.kill("SIGTERM"); await exited; fs.rmSync(root, { recursive: true, force: true }); });
  await waitForServer(base, { exited: () => server.exitCode, output: () => output });
  const post = (route, body) => fetch(base + route, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const created = await post("/v1/codex/jobs", { workspaceId: "scratch", provider: "claude", prompt: "Initial task" });
  assert.equal(created.status, 202, await created.clone().text());
  const { id } = await created.json();
  await until(() => fs.existsSync(path.join(workspace, "ready")));
  const message = { id: "phone-input", text: "Change direction", mode: "queue" };
  const queued = await post(`/v1/codex/jobs/${id}/messages`, message);
  assert.equal(queued.status, 202);
  assert.equal((await queued.json()).inputMessages[0].status, "queued");
  assert.equal((await post(`/v1/codex/jobs/${id}/messages`, { ...message, mode: "now" })).status, 202);
  let job;
  for (let attempt = 0; attempt < 100; attempt++) {
    job = await (await fetch(`${base}/v1/codex/jobs/${id}`)).json();
    if (job.inputMessages[0]?.status === "sent") break;
    await sleep(20);
  }
  assert.equal(job.inputMessages[0].status, "sent", JSON.stringify(job.inputMessages));
  assert.equal(job.id, id);
  fs.writeFileSync(path.join(workspace, "release"), "1");
  for (let attempt = 0; attempt < 100; attempt++) {
    job = await (await fetch(`${base}/v1/codex/jobs/${id}`)).json();
    if (job.status === "succeeded") break;
    await sleep(20);
  }
  assert.equal(job.status, "succeeded");
  assert.equal(job.acceptsInput, false);
  assert.equal(job.inputMessages.length, 1);
  const timeline = await (await fetch(`${base}/v1/codex/jobs/${id}/timeline`)).json();
  assert.ok(timeline.events.some(({ event }) => event.type === "user" && event.text === message.text && event.status === "sent"));
});
