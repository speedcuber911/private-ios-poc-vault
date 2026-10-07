import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { freePort, sleep, waitForJob, waitForJson, waitForServer } from "./helpers/wait.mjs";

// The Claude stream transport, end to end: a daemon started from source, a fake
// `claude` that replays a recorded stream-json run, and the three ways a phone
// reads the result (the SSE stream, the timeline route, thread history).

const here = path.dirname(fileURLToPath(import.meta.url));
const serverEntry = path.join(here, "..", "src", "index.mjs");
const fixtures = path.join(here, "fixtures");
const approvalStoreModule = path.join(here, "..", "src", "approval-store.mjs");

// What the fake does is chosen by a word in the prompt:
//   (none)   replay the recorded run, a line every couple of milliseconds
//   GATE     replay the first part, then wait for a `release` file in the cwd
//   MANY     2,500 prose deltas, to cross the timeline route's page size
//   FAIL     an error result and exit 1
//   APPROVE  ask the phone for an approval the way the MCP permission tool does
//   PLAIN    answer in plain text, as a CLI too old for stream-json would
function writeFakeClaude(dir) {
  const file = path.join(dir, "fake-claude-stream");
  const source = `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);
if (args[0] === "--help") { console.log("  --model <model>  --effort <level>  --permission-mode <mode>"); process.exit(0); }
if (args[0] === "--version") { console.log("9.9.9 (Fake Claude Code)"); process.exit(0); }
const fixtures = ${JSON.stringify(fixtures)};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const out = (object) => process.stdout.write(JSON.stringify(object) + "\\n");
const leave = (code) => process.stdout.write("", () => process.exit(code));
const flag = (name) => { const index = args.indexOf(name); return index === -1 ? "" : args[index + 1]; };
const sessionId = flag("--session-id") || flag("--resume") || "00000000-0000-4000-8000-000000000001";
const retarget = (text) => text.split("00000000-0000-4000-8000-000000000001").join(sessionId).split("/work/demo").join(process.cwd());
process.on("SIGTERM", () => process.exit(143));
let prompt = "";
process.stdin.on("data", (chunk) => { prompt += chunk; });
process.stdin.on("end", async () => {
  fs.writeFileSync(path.join(process.cwd(), "fake-claude-call.json"), JSON.stringify({
    args,
    pid: process.pid,
    prompt,
    env: {
      RELAY_JOB_ID: process.env.RELAY_JOB_ID || "",
      RELAY_APPROVAL_DIR: process.env.RELAY_APPROVAL_DIR || "",
      CLAUDE_CODE_USE_BEDROCK: process.env.CLAUDE_CODE_USE_BEDROCK || "",
    },
  }));
  if (prompt.includes("PLAIN")) { console.log("plain answer from an old CLI"); return leave(0); }
  if (prompt.includes("FAIL")) {
    out({ type: "system", subtype: "init", cwd: process.cwd(), session_id: sessionId });
    out({ type: "result", subtype: "error_during_execution", is_error: true, result: "Credit balance is too low", session_id: sessionId });
    return leave(1);
  }
  if (prompt.includes("MANY")) {
    out({ type: "system", subtype: "init", cwd: process.cwd(), session_id: sessionId });
    out({ type: "stream_event", event: { type: "message_start", message: { id: "msg_many" } }, parent_tool_use_id: null });
    out({ type: "stream_event", event: { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }, parent_tool_use_id: null });
    for (let index = 0; index < 2500; index += 1) {
      out({ type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "w" + index + " " } }, parent_tool_use_id: null });
    }
    out({ type: "result", subtype: "success", is_error: false, result: "many words", session_id: sessionId, usage: { input_tokens: 1, output_tokens: 2500 } });
    return leave(0);
  }
  if (prompt.includes("APPROVE")) {
    const { ApprovalStore } = await import(${JSON.stringify(approvalStoreModule)});
    const store = new ApprovalStore(process.env.RELAY_APPROVAL_DIR);
    out({ type: "system", subtype: "init", cwd: process.cwd(), session_id: sessionId });
    const record = store.create({ jobId: process.env.RELAY_JOB_ID, provider: "claude", kind: "command", title: "Run command", command: "echo hi", cwd: process.cwd(), toolName: "Bash" });
    const resolution = await store.waitForDecision(record.id, { timeoutMs: 30000 });
    out({ type: "result", subtype: "success", is_error: false, result: "decision: " + resolution.decision, session_id: sessionId, usage: { input_tokens: 1, output_tokens: 1 } });
    return leave(0);
  }
  const lines = retarget(fs.readFileSync(path.join(fixtures, "claude-stream-agent.jsonl"), "utf8")).split("\\n").filter(Boolean);
  const gateAt = prompt.includes("GATE") ? 30 : -1;
  for (let index = 0; index < lines.length; index += 1) {
    if (index === gateAt) {
      while (!fs.existsSync(path.join(process.cwd(), "release"))) await sleep(20);
    }
    process.stdout.write(lines[index] + "\\n");
    await sleep(2);
  }
  // Leave the session transcript where Claude Code leaves it.
  const project = path.join(process.env.HOME, ".claude", "projects", "fake-project");
  const from = path.join(fixtures, "claude-transcript");
  fs.mkdirSync(path.join(project, sessionId, "subagents"), { recursive: true });
  fs.writeFileSync(path.join(project, sessionId + ".jsonl"), retarget(fs.readFileSync(path.join(from, "00000000-0000-4000-8000-000000000001.jsonl"), "utf8")));
  for (const name of fs.readdirSync(path.join(from, "00000000-0000-4000-8000-000000000001", "subagents"))) {
    fs.writeFileSync(
      path.join(project, sessionId, "subagents", name),
      retarget(fs.readFileSync(path.join(from, "00000000-0000-4000-8000-000000000001", "subagents", name), "utf8")),
    );
  }
  return leave(0);
});
`;
  fs.writeFileSync(file, source, { mode: 0o755 });
  return file;
}

function makeSandbox() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "relayd-claude-stream-")));
  const workspace = path.join(root, "scratch");
  fs.mkdirSync(workspace, { recursive: true });
  fs.mkdirSync(path.join(root, "home"), { recursive: true });
  return { root, workspace, dataDir: path.join(root, "data"), home: path.join(root, "home"), claude: writeFakeClaude(root) };
}

async function startServer(sandbox, env = {}) {
  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, [serverEntry], {
    cwd: here,
    env: {
      ...process.env,
      CODEX_API_HOST: "127.0.0.1",
      CODEX_API_PORT: String(port),
      RELAYD_DIRECT_TLS: "false",
      RELAYD_PAIRING_ENABLED: "false",
      CODEX_REQUIRE_MTLS: "false",
      CODEX_DATA_DIR: sandbox.dataDir,
      CODEX_RUN_HOME: sandbox.home,
      CODEX_HOME: path.join(sandbox.home, ".codex"),
      CLAUDE_HOME: path.join(sandbox.home, ".claude"),
      CODEX_WORKSPACE_BROWSE_ROOT: sandbox.root,
      CODEX_WORKSPACES: JSON.stringify([{ id: "scratch", name: "Scratch", path: sandbox.workspace }]),
      CLAUDE_BIN: sandbox.claude,
      CODEX_BIN: path.join(sandbox.root, "no-codex"),
      KIMI_BIN: path.join(sandbox.root, "no-kimi"),
      CLAUDE_CODE_USE_BEDROCK: "",
      CLAUDE_AWS_PROFILE: "",
      CLAUDE_DEFAULT_MODEL: "",
      CLAUDE_SONNET_MODEL: "",
      CODEX_JOB_STREAM_HEARTBEAT_MS: "60000",
      RELAYD_CLAUDE_TRANSPORT: "",
      ...env,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  let exited = null;
  const capture = (chunk) => {
    output = (output + chunk).slice(-4000);
  };
  child.stdout.on("data", capture);
  child.stderr.on("data", capture);
  child.once("exit", (code, signal) => {
    exited = { code, signal };
  });
  await waitForServer(baseUrl, { exited: () => exited, output: () => output });
  return {
    baseUrl,
    exited: () => exited,
    output: () => output,
    describe: () => `relayd on ${baseUrl} ${exited ? `EXITED ${JSON.stringify(exited)}` : "running"}; output: ${output.trim()}`,
    async stop() {
      if (child.exitCode !== null) return;
      child.kill("SIGTERM");
      await new Promise((resolve) => child.once("exit", resolve));
    },
  };
}

async function createJob(server, prompt, extra = {}) {
  const response = await fetch(`${server.baseUrl}/v1/codex/jobs`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ workspaceId: "scratch", provider: "claude", prompt, timeoutMs: 60000, ...extra }),
  });
  assert.equal(response.status, 202, await response.clone().text());
  return response.json();
}

async function getJson(server, pathname) {
  const response = await fetch(`${server.baseUrl}${pathname}`);
  return { status: response.status, json: await response.json() };
}

// One SSE message per block: its event name, its `id:` line if any, its data.
function parseSse(text) {
  const messages = [];
  for (const block of text.split("\n\n")) {
    if (!block.trim() || block.startsWith(":")) continue;
    const message = { event: "", id: null, data: null, raw: block };
    for (const line of block.split("\n")) {
      if (line.startsWith("event: ")) message.event = line.slice(7);
      else if (line.startsWith("id: ")) message.id = line.slice(4);
      else if (line.startsWith("data: ")) message.data = JSON.parse(line.slice(6));
    }
    if (message.event) messages.push(message);
  }
  return messages;
}

async function readStream(server, pathname) {
  const response = await fetch(`${server.baseUrl}${pathname}`);
  assert.equal(response.status, 200);
  const text = await response.text();
  return { text, messages: parseSse(text) };
}

function reduceTimeline(entries) {
  const prose = new Map();
  const steps = new Map();
  for (const { event } of entries) {
    if (event.type === "text") prose.set(event.id, (prose.get(event.id) || "") + event.delta);
    else if (event.type === "step") steps.set(event.id, { ...(steps.get(event.id) || {}), ...event });
  }
  return { prose, steps };
}

const FINAL_ANSWER = "The probe echoed successfully, and checklist.txt lists a 3-step relay release process "
  + "(run tests, bump version, tag). The sub-agent found that facts.txt reports the codename as \"ember\".";
const FIRST_PROSE = "I'll run the command, read the checklist, and then delegate the facts.txt lookup.";

test("a Claude job streams a timeline, keeps the legacy channels, and answers with the final text only", async (t) => {
  const sandbox = makeSandbox();
  let server = await startServer(sandbox);
  t.after(() => server.stop());

  const created = await createJob(server, "run the recorded job", { model: "sonnet", reasoningEffort: "high" });
  const live = await readStream(server, `/v1/codex/jobs/${created.id}/stream?timeline=0`);
  const job = await waitForJob(server, created.id);
  const timeline = live.messages.filter((message) => message.event === "timeline");
  const total = timeline.length;

  await t.test("the stream interleaves every timeline event, in order, before done", () => {
    assert.ok(total > 20, `expected a real timeline, got ${total} events`);
    assert.deepEqual(timeline.map((message) => message.data.seq), Array.from({ length: total }, (_, index) => index + 1));
    assert.equal(live.messages.at(-1).event, "done");
    assert.equal(live.messages.filter((message) => message.event === "done").length, 1);
    // Timeline messages carry no id; every other message keeps its three-part id.
    for (const message of live.messages) {
      if (message.event === "timeline") assert.equal(message.id, null);
      else assert.match(message.id, /^\d+:\d+:\d+$/);
    }
    const ids = live.messages.filter((message) => message.id).map((message) => Number(message.id.split(":")[2]));
    assert.deepEqual(ids, Array.from({ length: ids.length }, (_, index) => index + 1));

    const { prose, steps } = reduceTimeline(timeline.map((message) => message.data));
    assert.equal(prose.get("t1"), FIRST_PROSE);
    assert.equal(prose.get("t2"), FINAL_ANSWER);
    assert.equal(steps.get("s1").kind, "command");
    assert.equal(steps.get("s1").status, "done");
    assert.equal(steps.get("s1").output, "relay-timeline-probe");
    assert.equal(steps.get("s1").input.cwd, sandbox.workspace);
    assert.equal(steps.get("a1").kind, "agent");
    assert.equal(steps.get("a1").status, "done");
    assert.equal(steps.get("a1").output, "The codename is **ember**.");
    assert.equal(steps.get("s3").parent, "a1");
    assert.equal(timeline.at(-1).data.event.type, "usage");
  });

  await t.test("the job result is the final answer, and the legacy channels carry prose and steps", () => {
    assert.equal(job.status, "succeeded");
    assert.equal(job.result, FINAL_ANSWER);
    assert.equal(job.error, "");
    assert.equal(job.timelineEvents, total);
    assert.equal(job.stdout, `${FIRST_PROSE}\n\n${FINAL_ANSWER}`);
    assert.doesNotMatch(job.stdout, /stream_event|tool_use/);
    assert.match(job.stderr, /^\[relay-step\] Running echo relay-timeline-probe$/m);
    assert.match(job.stderr, /^\[relay-step\] Reading checklist\.txt$/m);
    assert.match(job.stderr, /^\[relay-step\] Agent: Look up codename in facts\.txt$/m);
    assert.equal(job.sessionId, created.sessionId);
    assert.equal(job.execution.transport, "cli");
    const done = live.messages.at(-1).data;
    assert.equal(done.result, FINAL_ANSWER);
    assert.equal(done.timelineEvents, total);
  });

  await t.test("the runner launches claude with the adapter's flags plus stream-json", () => {
    const call = JSON.parse(fs.readFileSync(path.join(sandbox.workspace, "fake-claude-call.json"), "utf8"));
    assert.deepEqual(call.args.slice(0, 5), ["--print", "--output-format", "stream-json", "--verbose", "--include-partial-messages"]);
    const value = (name) => call.args[call.args.indexOf(name) + 1];
    assert.equal(value("--model"), "sonnet");
    assert.equal(value("--effort"), "high");
    assert.equal(value("--permission-mode"), "manual");
    assert.equal(value("--permission-prompt-tool"), "mcp__relay_approvals__approve");
    assert.equal(value("--session-id"), created.sessionId);
    assert.ok(call.args.includes("--strict-mcp-config"));
    assert.match(value("--mcp-config"), /claude-permission-mcp\.mjs/);
    assert.equal(call.prompt, "run the recorded job");
    assert.equal(call.env.RELAY_JOB_ID, created.id);
    assert.ok(call.env.RELAY_APPROVAL_DIR);
    assert.equal(call.env.CLAUDE_CODE_USE_BEDROCK, "");
  });

  await t.test("a stream without the parameter is the legacy stream, byte for byte", async () => {
    const plain = await readStream(server, `/v1/codex/jobs/${created.id}/stream`);
    assert.equal(plain.messages.some((message) => message.event === "timeline"), false);
    assert.deepEqual(
      [...new Set(plain.messages.map((message) => message.event))].sort(),
      ["done", "status", "stderr", "stdout"],
    );
    // Replaying the finished job with the parameter differs only by the
    // timeline messages themselves.
    const withTimeline = await readStream(server, `/v1/codex/jobs/${created.id}/stream?timeline=0`);
    const stripped = withTimeline.text.split("\n\n").filter((block) => !block.startsWith("event: timeline\n")).join("\n\n");
    assert.equal(stripped, plain.text);
    assert.equal(withTimeline.messages.filter((message) => message.event === "timeline").length, total);
  });

  await t.test("the stream resumes after the events a client already holds", async () => {
    const resumed = await readStream(server, `/v1/codex/jobs/${created.id}/stream?timeline=${total - 4}`);
    assert.deepEqual(
      resumed.messages.filter((message) => message.event === "timeline").map((message) => message.data.seq),
      [total - 3, total - 2, total - 1, total],
    );
    const caughtUp = await readStream(server, `/v1/codex/jobs/${created.id}/stream?timeline=${total}`);
    assert.equal(caughtUp.messages.some((message) => message.event === "timeline"), false);
    assert.equal((await fetch(`${server.baseUrl}/v1/codex/jobs/${created.id}/stream?timeline=-1`)).status, 400);
    assert.equal((await fetch(`${server.baseUrl}/v1/codex/jobs/${created.id}/stream?timeline=abc`)).status, 400);
  });

  await t.test("the timeline route returns the same events, from any cursor", async () => {
    const all = await getJson(server, `/v1/codex/jobs/${created.id}/timeline`);
    assert.equal(all.status, 200);
    assert.deepEqual(Object.keys(all.json).sort(), ["complete", "events", "jobId", "next"]);
    assert.equal(all.json.jobId, created.id);
    assert.equal(all.json.next, total);
    assert.equal(all.json.complete, true);
    assert.deepEqual(all.json.events, timeline.map((message) => message.data));

    const tail = await getJson(server, `/v1/codex/jobs/${created.id}/timeline?since=${total - 2}`);
    assert.deepEqual(tail.json.events.map((entry) => entry.seq), [total - 1, total]);
    const none = await getJson(server, `/v1/codex/jobs/${created.id}/timeline?since=${total}`);
    assert.deepEqual(none.json, { jobId: created.id, events: [], next: total, complete: true });
    const beyond = await getJson(server, `/v1/codex/jobs/${created.id}/timeline?since=${total + 50}`);
    assert.deepEqual(beyond.json, { jobId: created.id, events: [], next: total, complete: true });

    assert.equal((await getJson(server, `/v1/codex/jobs/${created.id}/timeline?since=-3`)).status, 400);
    assert.equal((await getJson(server, "/v1/codex/jobs/00000000-0000-4000-8000-00000000dead/timeline")).status, 404);
  });

  await t.test("every job shape reports timelineEvents", async () => {
    const full = await getJson(server, `/v1/codex/jobs/${created.id}?logs=full`);
    assert.equal(full.json.timelineEvents, total);
    const list = await getJson(server, "/v1/codex/jobs");
    assert.equal(list.json.jobs.find((item) => item.id === created.id).timelineEvents, total);
  });

  await t.test("thread history carries steps, with the sub-agent's nested under it", async () => {
    const detail = await getJson(server, `/v1/codex/threads/${created.sessionId}`);
    assert.equal(detail.status, 200);
    assert.equal(detail.json.jobs[0].timelineEvents, total);
    assert.equal(detail.json.trailingSteps, undefined);

    const [prompt, first, last] = detail.json.messages;
    assert.deepEqual(detail.json.messages.map((message) => message.role), ["user", "assistant", "assistant"]);
    // Existing fields are untouched, and a message with nothing before it has no `steps`.
    assert.deepEqual(Object.keys(prompt).sort(), ["attachments", "role", "text", "timestamp"]);
    assert.equal(first.text, FIRST_PROSE);
    assert.deepEqual(first.steps.map((step) => step.kind), ["reasoning"]);
    assert.equal(last.text, FINAL_ANSWER);
    assert.deepEqual(
      last.steps.map((step) => [step.kind, step.status, Boolean(step.parent)]),
      [
        ["command", "done", false],
        ["read", "done", false],
        ["reasoning", "done", false],
        ["agent", "done", false],
        ["read", "done", true],
      ],
    );
    const agent = last.steps.find((step) => step.kind === "agent");
    assert.equal(last.steps.at(-1).parent, agent.id);
    assert.equal(agent.output, "The codename is **ember**.");
    assert.equal(last.steps[0].input.cwd, sandbox.workspace);
    for (const step of last.steps) assert.equal(step.type, "step");
  });

  await t.test("timelineEvents and the timeline survive a daemon restart", async () => {
    await server.stop();
    // Restarted on the other transport: a finished job's answer and timeline
    // must not depend on the current setting.
    server = await startServer(sandbox, { RELAYD_CLAUDE_TRANSPORT: "print" });
    const after = await getJson(server, `/v1/codex/jobs/${created.id}`);
    assert.equal(after.json.status, "succeeded");
    assert.equal(after.json.timelineEvents, total);
    assert.equal(after.json.result, FINAL_ANSWER);
    const page = await getJson(server, `/v1/codex/jobs/${created.id}/timeline?since=0`);
    assert.equal(page.json.events.length, total);
    assert.equal(page.json.complete, true);
  });

  await t.test("deleting the thread deletes the timeline file with the logs", async () => {
    const file = path.join(sandbox.dataDir, "logs", `${created.id}.timeline.ndjson`);
    assert.equal(fs.existsSync(file), true);
    const response = await fetch(`${server.baseUrl}/v1/codex/threads/${created.sessionId}`, { method: "DELETE" });
    assert.equal(response.status, 200);
    assert.equal(fs.existsSync(file), false);
    assert.equal(fs.existsSync(path.join(sandbox.dataDir, "logs", `${created.id}.stdout.log`)), false);
    assert.equal((await getJson(server, `/v1/codex/jobs/${created.id}/timeline`)).status, 404);
  });
});

test("a live stream resumes with timeline=<n> without duplicates, and cancel takes claude down", async (t) => {
  const sandbox = makeSandbox();
  const server = await startServer(sandbox);
  t.after(() => server.stop());

  const created = await createJob(server, "GATE then finish");

  // First connection: read until some timeline events have arrived, then drop.
  const controller = new AbortController();
  const response = await fetch(`${server.baseUrl}/v1/codex/jobs/${created.id}/stream?timeline=0`, { signal: controller.signal });
  let text = "";
  const decoder = new TextDecoder();
  const reader = response.body.getReader();
  let held = [];
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    text += decoder.decode(value, { stream: true });
    held = parseSse(text.slice(0, text.lastIndexOf("\n\n") + 2)).filter((message) => message.event === "timeline");
    if (held.length >= 5) break;
  }
  controller.abort();
  assert.ok(held.length >= 5);
  assert.deepEqual(held.map((message) => message.data.seq), Array.from({ length: held.length }, (_, index) => index + 1));

  // While it runs, the job already reports a growing count and an open page.
  const running = await getJson(server, `/v1/codex/jobs/${created.id}`);
  assert.equal(running.json.status, "running");
  assert.ok(running.json.timelineEvents >= held.length);
  const openPage = await getJson(server, `/v1/codex/jobs/${created.id}/timeline?since=0`);
  assert.equal(openPage.json.complete, false);

  // Second connection picks up after what the first delivered; the job is
  // released only once it is attached, so the rest arrives live.
  const cursor = held.length;
  const second = fetch(`${server.baseUrl}/v1/codex/jobs/${created.id}/stream?timeline=${cursor}`).then((res) => res.text());
  await sleep(200);
  fs.writeFileSync(path.join(sandbox.workspace, "release"), "");
  const rest = parseSse(await second);
  const restTimeline = rest.filter((message) => message.event === "timeline");
  const job = await waitForJob(server, created.id);
  assert.equal(job.status, "succeeded");
  assert.equal(rest.at(-1).event, "done");
  assert.deepEqual(
    restTimeline.map((message) => message.data.seq),
    Array.from({ length: job.timelineEvents - cursor }, (_, index) => cursor + index + 1),
  );
  assert.ok(restTimeline.length > 0);
  const { prose, steps } = reduceTimeline([...held, ...restTimeline].map((message) => message.data));
  assert.equal(prose.get("t2"), FINAL_ANSWER);
  assert.equal(steps.get("a1").status, "done");

  await t.test("cancelling a running job stops the runner and claude", async () => {
    fs.rmSync(path.join(sandbox.workspace, "release"));
    const hanging = await createJob(server, "GATE and never finish");
    await waitForJson(
      server,
      `/v1/codex/jobs/${hanging.id}`,
      (candidate) => (candidate.timelineEvents || 0) >= 5,
      "the gated job to produce timeline events",
    );
    const { pid } = JSON.parse(fs.readFileSync(path.join(sandbox.workspace, "fake-claude-call.json"), "utf8"));
    const cancel = await fetch(`${server.baseUrl}/v1/codex/jobs/${hanging.id}/cancel`, { method: "POST" });
    assert.equal(cancel.status, 202);
    const cancelled = await waitForJob(server, hanging.id);
    assert.equal(cancelled.status, "cancelled");
    assert.equal(cancelled.result, "");
    assert.ok(cancelled.timelineEvents >= 5);
    let alive = true;
    for (let attempt = 0; attempt < 200 && alive; attempt += 1) {
      try {
        process.kill(pid, 0);
        await sleep(25);
      } catch {
        alive = false;
      }
    }
    assert.equal(alive, false, "the fake claude process should be gone after cancel");
    // A step left open by the cancel stays `running` in the file; readers
    // treat it as cancelled (spec 1.1).
    const page = await getJson(server, `/v1/codex/jobs/${hanging.id}/timeline`);
    assert.equal(page.json.complete, true);
  });
});

test("the timeline route pages at 2,000 events", async (t) => {
  const sandbox = makeSandbox();
  const server = await startServer(sandbox);
  t.after(() => server.stop());

  const created = await createJob(server, "MANY words please");
  const job = await waitForJob(server, created.id);
  assert.equal(job.status, "succeeded");
  assert.equal(job.result, "many words");
  assert.equal(job.timelineEvents, 2501);

  const first = await getJson(server, `/v1/codex/jobs/${created.id}/timeline?since=0`);
  assert.equal(first.json.events.length, 2000);
  assert.equal(first.json.next, 2000);
  assert.equal(first.json.complete, false);
  const second = await getJson(server, `/v1/codex/jobs/${created.id}/timeline?since=${first.json.next}`);
  assert.equal(second.json.events.length, 501);
  assert.equal(second.json.events[0].seq, 2001);
  assert.equal(second.json.next, 2501);
  assert.equal(second.json.complete, true);
  const text = [...first.json.events, ...second.json.events]
    .filter((entry) => entry.event.type === "text")
    .map((entry) => entry.event.delta)
    .join("");
  assert.ok(text.startsWith("w0 w1 w2 "));
  assert.ok(text.endsWith("w2499 "));

  // The live stream has no page size: one connection delivers all of it.
  const stream = await readStream(server, `/v1/codex/jobs/${created.id}/stream?timeline=0`);
  assert.equal(stream.messages.filter((message) => message.event === "timeline").length, 2501);
});

test("a failed Claude run fails the job with the CLI's reason", async (t) => {
  const sandbox = makeSandbox();
  const server = await startServer(sandbox);
  t.after(() => server.stop());

  const created = await createJob(server, "FAIL please");
  const job = await waitForJob(server, created.id);
  assert.equal(job.status, "failed");
  assert.equal(job.error, "Credit balance is too low");
  assert.equal(job.result, "");
  assert.equal(job.exitCode, 1);
  assert.equal(job.timelineEvents, undefined);

  await t.test("plain-text output from an older CLI is still the answer", async () => {
    const plain = await waitForJob(server, (await createJob(server, "PLAIN please")).id);
    assert.equal(plain.status, "succeeded");
    assert.equal(plain.result, "plain answer from an old CLI");
  });
});

test("approvals pause and resume a streamed Claude job", async (t) => {
  const sandbox = makeSandbox();
  const server = await startServer(sandbox);
  t.after(() => server.stop());

  const created = await createJob(server, "APPROVE this");
  await waitForJson(
    server,
    `/v1/codex/jobs/${created.id}`,
    (candidate) => candidate.status === "waiting_for_approval",
    "the job to wait for approval",
  );
  const approvals = await getJson(server, `/v1/codex/approvals?jobId=${created.id}&status=pending`);
  assert.equal(approvals.json.approvals.length, 1);
  const decision = await fetch(`${server.baseUrl}/v1/codex/approvals/${approvals.json.approvals[0].id}/decision`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ decision: "accept" }),
  });
  assert.equal(decision.status, 200, await decision.clone().text());
  const job = await waitForJob(server, created.id);
  assert.equal(job.status, "succeeded");
  assert.equal(job.result, "decision: accept");
});

test("RELAYD_CLAUDE_TRANSPORT=print runs plain claude --print with no timeline", async (t) => {
  const sandbox = makeSandbox();
  const server = await startServer(sandbox, { RELAYD_CLAUDE_TRANSPORT: "print" });
  t.after(() => server.stop());

  const created = await createJob(server, "PLAIN please", { model: "sonnet" });
  const job = await waitForJob(server, created.id);
  assert.equal(job.status, "succeeded");
  assert.equal(job.result, "plain answer from an old CLI");
  assert.equal(job.stdout, "plain answer from an old CLI\n");
  assert.equal("timelineEvents" in job, false);

  const call = JSON.parse(fs.readFileSync(path.join(sandbox.workspace, "fake-claude-call.json"), "utf8"));
  assert.equal(call.args[0], "--print");
  assert.equal(call.args.includes("--output-format"), false);
  assert.equal(call.args.includes("--include-partial-messages"), false);
  assert.deepEqual(call.args.slice(1, 3), ["--model", "sonnet"]);

  assert.equal(fs.existsSync(path.join(sandbox.dataDir, "logs", `${created.id}.timeline.ndjson`)), false);
  const page = await getJson(server, `/v1/codex/jobs/${created.id}/timeline`);
  assert.deepEqual(page.json, { jobId: created.id, events: [], next: 0, complete: true });
  const stream = await readStream(server, `/v1/codex/jobs/${created.id}/stream?timeline=0`);
  assert.equal(stream.messages.some((message) => message.event === "timeline"), false);
  assert.equal(stream.messages.at(-1).event, "done");
});

test("the timeline route sits behind the same gate as the other job routes", async (t) => {
  const sandbox = makeSandbox();
  const server = await startServer(sandbox, { CODEX_REQUIRE_MTLS: "true", CODEX_ALLOWED_CERT_SUBJECTS: "CN=allowed" });
  t.after(() => server.stop());

  const pathname = "/v1/codex/jobs/00000000-0000-4000-8000-00000000dead/timeline";
  const bare = await fetch(`${server.baseUrl}${pathname}`);
  const jobRoute = await fetch(`${server.baseUrl}/v1/codex/jobs`);
  assert.equal(bare.status, jobRoute.status);
  assert.ok([401, 403].includes(bare.status), `expected the gate, got ${bare.status}`);
  const allowed = await fetch(`${server.baseUrl}${pathname}`, {
    headers: { "X-SSL-Client-Verify": "SUCCESS", "X-SSL-Client-S-DN": "CN=allowed" },
  });
  assert.equal(allowed.status, 404);
});

test("an unknown RELAYD_CLAUDE_TRANSPORT stops the daemon at startup", async () => {
  const sandbox = makeSandbox();
  const child = spawn(process.execPath, [serverEntry], {
    cwd: here,
    env: {
      ...process.env,
      CODEX_API_HOST: "127.0.0.1",
      CODEX_API_PORT: String(await freePort()),
      RELAYD_DIRECT_TLS: "false",
      RELAYD_PAIRING_ENABLED: "false",
      CODEX_REQUIRE_MTLS: "false",
      CODEX_DATA_DIR: sandbox.dataDir,
      CODEX_WORKSPACE_BROWSE_ROOT: sandbox.root,
      CODEX_WORKSPACES: JSON.stringify([{ id: "scratch", name: "Scratch", path: sandbox.workspace }]),
      RELAYD_CLAUDE_TRANSPORT: "sideways",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  const exit = await new Promise((resolve) => child.once("exit", (code, signal) => resolve({ code, signal })));
  assert.notEqual(exit.code, 0);
  assert.match(stderr, /RELAYD_CLAUDE_TRANSPORT must be one of: stream, print/);
});
