#!/usr/bin/env node
// relayd antigravity-job-runner.mjs — runs one Google Antigravity CLI (`agy`)
// job and records its structured timeline, session id, answer, and errors.
//
// The daemon spawns this with the agy argv as its own arguments (built by
// adapters/antigravity.mjs, including `--input-format stream-json
// --output-format stream-json`) and the prompt on stdin. It wraps the prompt
// into `{"event":"user","message":{"content":prompt}}\n` on child stdin,
// closes child stdin, and fans NDJSON events out to:
//   - RELAY_TIMELINE_PATH: structured timeline NDJSON;
//   - RELAY_SESSION_RESULT_PATH: agy conversation UUID as soon as init arrives;
//   - stdout: assistant prose as it streams;
//   - stderr: `[relay-step]` progress lines + CLI stderr;
//   - RELAY_RESULT_PATH: final answer;
//   - RELAY_ERROR_PATH: failure reason.
import fs from "node:fs";
import readline from "node:readline";
import { spawn } from "node:child_process";

import { createTimelineWriter } from "./timeline.mjs";
import { createAntigravityStreamMapper, legacyAntigravityStepLine } from "./timeline-antigravity.mjs";

const antigravityBin = process.env.RELAY_ANTIGRAVITY_BIN?.trim() || "agy";
const resultPath = requiredEnv("RELAY_RESULT_PATH");
const sessionPath = process.env.RELAY_SESSION_RESULT_PATH || "";
const errorPath = process.env.RELAY_ERROR_PATH || "";
const antigravityArgs = process.argv.slice(2);

const writer = createTimelineWriter();
const mapper = createAntigravityStreamMapper();

let stopping = false;
let killTimer = null;
let sessionWritten = false;
let stdoutTextId = "";
let stderrAtLineStart = true;
// Output that was not a JSON line: falls back cleanly if a fake/older CLI
// prints plain text.
let plainOutput = "";
let stderrTail = "";
const announced = new Set();
const stepLabels = new Map();

const child = spawn(antigravityBin, antigravityArgs, {
  cwd: process.cwd(),
  env: process.env,
  stdio: ["pipe", "pipe", "pipe"],
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
  killTimer = setTimeout(() => signalChild("SIGKILL"), 3000);
}

for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"]) process.on(signal, stop);
process.once("disconnect", stop);
process.stdout.on("error", stop);
process.stderr.on("error", () => {});

child.stdin.on("error", () => {});
process.stdin.on("error", () => {});

let prompt = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { prompt += chunk; });
process.stdin.on("end", () => {
  if (child.stdin.destroyed || !child.stdin.writable) return;
  try {
    child.stdin.write(`${JSON.stringify({ event: "user", message: { content: prompt } })}\n`);
    child.stdin.end();
  } catch {
    // Child exited before prompt write landed; exit handler reports failure.
  }
});

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
  let events;
  try {
    events = mapper.push(line);
  } catch (error) {
    writeStderr(`[relay-runner] ${error?.message || error}\n`);
    return;
  }
  persistSessionId();
  for (const event of events) record(event);
});

const exit = await new Promise((resolve) => {
  child.once("error", (error) => resolve({ code: null, signal: null, error }));
  child.once("close", (code, signal) => resolve({ code, signal, error: null }));
});
await Promise.race([linesDone, new Promise((resolve) => setTimeout(resolve, 2000))]);
clearTimeout(killTimer);
persistSessionId();
writer.close();
await finish(exit);

function persistSessionId() {
  if (sessionWritten || !sessionPath || !mapper.sessionId()) return;
  sessionWritten = true;
  try {
    fs.writeFileSync(sessionPath, `${mapper.sessionId()}\n`, { encoding: "utf8", mode: 0o600 });
  } catch {
    // Best-effort; daemon also checks result / resume id.
  }
}

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
      const text = legacyAntigravityStepLine({ ...stepLabels.get(fields.id), input: fields.input });
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
    return fail(`Could not start Antigravity: ${error.message}`, 127);
  }
  if (code === 0 && !(outcome && outcome.isError)) {
    const answer = (outcome ? outcome.text : "").trim() || mapper.lastProse().trim() || plainOutput.trim();
    fs.writeFileSync(resultPath, answer, { encoding: "utf8", mode: 0o600 });
    return leave(0);
  }
  if (outcome && outcome.isError) {
    return fail(outcome.text.trim() || `Antigravity ended with ${outcome.status || "an error"}.`, code || 1);
  }
  const detail = stderrTail.trim() || plainOutput.trim();
  return fail(detail || `agy exited with code ${code}${signal ? ` and signal ${signal}` : ""}`, code || 1, { echo: !detail });
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
