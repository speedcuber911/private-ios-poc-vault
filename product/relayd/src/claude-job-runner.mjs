#!/usr/bin/env node
// relayd claude-job-runner.mjs — runs one Claude Code job and records what it does.
//
// The daemon spawns this with the claude argv as its own arguments (built by
// adapters/claude.mjs, `--output-format stream-json` included) and the prompt
// on stdin. It reads the CLI's JSON lines and fans them out to:
//   - the job timeline (RELAY_TIMELINE_PATH), the structured record;
//   - stdout, the assistant's prose as it streams, for phones that only know
//     the log channels;
//   - stderr, one `[relay-step]` line per step, the same vocabulary the Codex
//     runner uses;
//   - the result file (RELAY_RESULT_PATH), the final answer and nothing else;
//   - the error file (RELAY_ERROR_PATH), why the run failed, when it did.
import fs from "node:fs";
import readline from "node:readline";
import { spawn } from "node:child_process";
import crypto from "node:crypto";

import { createTimelineWriter } from "./timeline.mjs";
import { createClaudeStreamMapper, legacyStepLine } from "./timeline-claude.mjs";
import { connectRunnerInput } from "./runner-input.mjs";

const claudeBin = process.env.RELAY_CLAUDE_BIN?.trim() || "claude";
const resultPath = requiredEnv("RELAY_RESULT_PATH");
const sessionPath = process.env.RELAY_SESSION_RESULT_PATH || "";
const errorPath = process.env.RELAY_ERROR_PATH || "";
const claudeArgs = process.argv.slice(2);
const interactiveInput = process.env.RELAY_INTERACTIVE_INPUT === "1";
if (interactiveInput) claudeArgs.push("--input-format", "stream-json", "--replay-user-messages");

const writer = createTimelineWriter();
const mapper = createClaudeStreamMapper();

let stopping = false;
let killTimer = null;
let sessionWritten = false;
let stdoutTextId = "";
let stderrAtLineStart = true;
// Output that was not a JSON line: a CLI too old for stream-json answers in
// plain text, and that text is then the answer.
let plainOutput = "";
let stderrTail = "";
const announced = new Set();
// kind and title by step id: they arrive when a step opens, its input later.
const stepLabels = new Map();
const acknowledgements = new Map();
let turnActive = true;
let interrupting = false;
let interruptedResult;
const inputs = connectRunnerInput({
  onState: (event) => {
    if (event.type === "input.state" && event.status !== "queued") writer.user(event.id, event.text, event.status);
  },
  start: sendUserMessage,
  steer: async (message) => {
    // Claude's explicit interrupt ends the old turn; the follow-up then runs
    // in the same CLI/session. Wait for both acknowledgement and old result.
    interrupting = true;
    const ended = turnActive ? waitForAck("interrupted-result") : Promise.resolve();
    interruptedResult = () => acknowledge("interrupted-result");
    try {
      const id = crypto.randomUUID();
      const accepted = waitForAck(id);
      writeInput({ type: "control_request", request_id: id, request: { subtype: "interrupt" } });
      await Promise.all([accepted, ended]);
      interrupting = false;
      await sendUserMessage(message);
    } catch (error) {
      interrupting = false;
      if (!turnActive) void inputs.turnFinished();
      throw error;
    } finally { interruptedResult = null; }
  },
  finish: () => child.stdin.end(),
});

function writeInput(value) { child.stdin.write(`${JSON.stringify(value)}\n`); }
function waitForAck(id) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      acknowledgements.delete(id);
      reject(new Error("Claude did not confirm delivery. Check the conversation before resending."));
    }, 15_000);
    acknowledgements.set(id, { resolve, reject, timer });
  });
}
function acknowledge(id, error) {
  const pending = acknowledgements.get(id);
  if (!pending) return;
  clearTimeout(pending.timer);
  acknowledgements.delete(id);
  if (error) pending.reject(new Error(error));
  else pending.resolve();
}
async function sendUserMessage(message) {
  const accepted = waitForAck(message.id);
  mapper.startTurn();
  turnActive = true;
  writeInput({ type: "user", uuid: message.id, session_id: mapper.sessionId() || "",
    parent_tool_use_id: null, message: { role: "user", content: message.text } });
  await accepted;
}

const child = spawn(claudeBin, claudeArgs, {
  cwd: process.cwd(),
  env: process.env,
  stdio: ["pipe", "pipe", "pipe"],
  // Its own process group, so stopping the job stops the tools it started too.
  detached: true,
});

function signalChild(signal) {
  if (!child.pid) return;
  try {
    process.kill(-child.pid, signal);
  } catch {
    try {
      child.kill(signal);
    } catch {
      // Already gone.
    }
  }
}

function stop() {
  if (stopping) return;
  stopping = true;
  signalChild("SIGTERM");
  // The daemon escalates to SIGKILL on this runner after five seconds; claude
  // must be gone before then or it would outlive the job.
  killTimer = setTimeout(() => signalChild("SIGKILL"), 3000);
}

for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"]) process.on(signal, stop);
process.once("disconnect", stop);
// The daemon is gone: nobody is reading, so nothing should keep running.
process.stdout.on("error", stop);
process.stderr.on("error", () => {});

child.stdin.on("error", () => {});
process.stdin.on("error", () => {});
if (interactiveInput) {
  let prompt = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => { prompt += chunk; });
  process.stdin.on("end", () => {
    writeInput({ type: "user", uuid: crypto.randomUUID(), session_id: "", parent_tool_use_id: null,
      message: { role: "user", content: prompt } });
    void inputs.activate();
  });
} else process.stdin.pipe(child.stdin);

child.stderr.setEncoding("utf8");
child.stderr.on("data", (chunk) => {
  stderrTail = (stderrTail + chunk).slice(-8192);
  writeStderr(chunk);
});

const lines = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
const linesDone = new Promise((resolve) => lines.once("close", resolve));
lines.on("line", (raw) => {
  if (!raw.trim()) return;
  let line;
  try {
    line = JSON.parse(raw);
  } catch {
    line = null;
  }
  if (!line || typeof line !== "object") {
    plainOutput += `${raw}\n`;
    process.stdout.write(`${raw}\n`);
    return;
  }
  if (line.type === "control_response") {
    const response = line.response || {};
    acknowledge(response.request_id, response.subtype === "error" ? response.error || "Claude refused the interrupt." : null);
    return;
  }
  if (line.type === "user" && !line.parent_tool_use_id && line.uuid) acknowledge(line.uuid);
  if (interactiveInput && line.type === "result") {
    turnActive = false;
    if (interrupting) {
      interruptedResult?.();
      return;
    }
    // Error results end the job; queued messages must not keep retrying a
    // provider that has rejected authentication or exhausted its budget.
    if (line.is_error) child.stdin.end();
    else void inputs.turnFinished();
  }
  let events;
  try {
    events = mapper.push(line);
  } catch (error) {
    // One line the mapper cannot read must not end the run.
    writeStderr(`[relay-runner] ${error?.message || error}\n`);
    return;
  }
  if (!sessionWritten && sessionPath && mapper.sessionId()) {
    sessionWritten = true;
    try {
      fs.writeFileSync(sessionPath, `${mapper.sessionId()}\n`, { encoding: "utf8", mode: 0o600 });
    } catch {
      // The daemon already knows the id it asked for.
    }
  }
  for (const event of events) record(event);
});

const exit = await new Promise((resolve) => {
  child.once("error", (error) => resolve({ code: null, signal: null, error }));
  child.once("close", (code, signal) => resolve({ code, signal, error: null }));
});
for (const id of acknowledgements.keys()) acknowledge(id, "Claude exited before confirming delivery.");
await Promise.race([linesDone, new Promise((resolve) => setTimeout(resolve, 2000))]);
clearTimeout(killTimer);
writer.close();
await finish(exit);

function record(event) {
  if (event.type === "text") {
    writer.text(event.id, event.delta);
    if (stdoutTextId && stdoutTextId !== event.id) process.stdout.write("\n\n");
    stdoutTextId = event.id;
    process.stdout.write(event.delta);
    return;
  }
  if (event.type === "step") {
    const { type: _type, ...fields } = event;
    writer.step(fields);
    if (fields.kind) stepLabels.set(fields.id, { kind: fields.kind, title: fields.title });
    if (fields.input && !announced.has(fields.id)) {
      announced.add(fields.id);
      const text = legacyStepLine({ ...stepLabels.get(fields.id), input: fields.input });
      if (text) writeStderr(`${stderrAtLineStart ? "" : "\n"}[relay-step] ${text.replace(/\s+/g, " ").slice(0, 400)}\n`);
    }
    return;
  }
  if (event.type === "step.delta") {
    writer.stepDelta(event.id, event.output);
    return;
  }
  if (event.type === "usage") {
    const { type: _type, ...fields } = event;
    writer.usage(fields);
  }
}

// A pipe write can still be queued when the process is told to exit; the last
// prose and the failure reason must not be lost that way.
async function leave(exitCode) {
  await Promise.all([process.stdout, process.stderr].map((stream) => new Promise((resolve) => {
    try {
      stream.write("", () => resolve());
    } catch {
      resolve();
    }
    setTimeout(resolve, 2000).unref();
  })));
  process.exit(exitCode);
}

async function finish({ code, signal, error }) {
  const outcome = mapper.outcome();
  if (stopping) {
    return leave(code && code !== 0 ? code : 143);
  }
  if (error) {
    return fail(`Could not start Claude Code: ${error.message}`, 127);
  }
  if (code === 0 && !(outcome && outcome.isError)) {
    const answer = (outcome ? outcome.text : "").trim() || mapper.lastProse().trim() || plainOutput.trim();
    fs.writeFileSync(resultPath, answer, { encoding: "utf8", mode: 0o600 });
    return leave(0);
  }
  if (outcome && outcome.isError) {
    return fail(outcome.text.trim() || `Claude Code ended with ${outcome.subtype || "an error"}.`, code || 1);
  }
  const detail = stderrTail.trim() || plainOutput.trim();
  // What the CLI printed is already on stderr; repeat nothing, only keep it.
  return fail(detail || `claude exited with code ${code}${signal ? ` and signal ${signal}` : ""}`, code || 1, { echo: !detail });
}

function fail(message, exitCode, { echo = true } = {}) {
  if (errorPath) {
    try {
      fs.writeFileSync(errorPath, message, { encoding: "utf8", mode: 0o600 });
    } catch {
      // stderr still carries it.
    }
  }
  if (echo) writeStderr(`${stderrAtLineStart ? "" : "\n"}${message}\n`);
  return leave(exitCode);
}

function writeStderr(text) {
  if (!text) return;
  stderrAtLineStart = text.endsWith("\n");
  process.stderr.write(text);
}

function requiredEnv(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}
