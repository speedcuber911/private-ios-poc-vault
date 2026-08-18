#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { AppServerClient } from "./appserver-client.mjs";
import { ApprovalStore } from "./approval-store.mjs";

const jobId = requiredEnv("RELAY_JOB_ID");
const workspacePath = path.resolve(requiredEnv("RELAY_WORKSPACE_PATH"));
const resultPath = requiredEnv("RELAY_RESULT_PATH");
const sessionPath = process.env.RELAY_SESSION_RESULT_PATH || "";
const approvalStore = new ApprovalStore(requiredEnv("RELAY_APPROVAL_DIR"));
const controller = new AbortController();
let completed = false;
let finalAnswer = "";
let streamedAnswer = "";
let currentThreadId = process.env.RELAY_RESUME_SESSION_ID || "";
let sandboxStartupFailure = null;

const SANDBOX_STARTUP_FAILURES = [
  /bwrap:\s+Can't find source path[^\r\n]*:\s*Permission denied/i,
  /bwrap:\s+Can't chdir to[^\r\n]*:\s*Permission denied/i,
  /bwrap:\s+No permissions to create a new namespace/i,
  /bwrap:\s+Creating new namespace failed/i,
  /bubblewrap is unavailable/i,
  /bubblewrap cannot create user namespaces/i,
];

for (const signal of ["SIGTERM", "SIGINT"]) {
  process.once(signal, () => controller.abort(new Error(`received ${signal}`)));
}

const prompt = await readStdin();
const client = new AppServerClient({
  codexBin: process.env.RELAY_CODEX_BIN || "codex",
  cwd: workspacePath,
  env: process.env,
  experimental: false,
});

client.on("stderr", (line) => process.stderr.write(`${line}\n`));
client.on("protocolWarning", (line) => process.stderr.write(`[app-server] ${line}\n`));
client.on("request", (message) => void handleServerRequest(message));
client.on("notification", (message) => handleNotification(message));
client.on("closed", (error) => {
  if (!completed && !controller.signal.aborted) fail(error);
});
controller.signal.addEventListener("abort", () => {
  client.stop();
  if (!completed) fail(controller.signal.reason || new Error("job cancelled"));
}, { once: true });

try {
  await client.start();
  const threadResult = currentThreadId
    ? await client.request("thread/resume", {
        threadId: currentThreadId,
        cwd: workspacePath,
        approvalPolicy: approvalPolicy(),
        approvalsReviewer: "user",
        sandbox: "workspace-write",
        model: optionalEnv("RELAY_MODEL"),
      })
    : await client.request("thread/start", {
        cwd: workspacePath,
        approvalPolicy: approvalPolicy(),
        // The runner account may prefer Codex auto-review on the laptop. Relay
        // must route these decisions to the phone instead, otherwise the
        // auto-review subagent can approve a sandbox escape before iOS sees it.
        approvalsReviewer: "user",
        sandbox: "workspace-write",
        model: optionalEnv("RELAY_MODEL"),
        serviceName: "relay",
      });
  currentThreadId = threadResult?.thread?.id || currentThreadId;
  if (!currentThreadId) throw new Error("codex app-server did not return a thread id");
  if (sessionPath) fs.writeFileSync(sessionPath, `${currentThreadId}\n`, { encoding: "utf8", mode: 0o600 });

  const input = [{ type: "text", text: prompt }];
  for (const skill of selectedSkillInputs()) input.push(skill);
  const turnParams = {
    threadId: currentThreadId,
    input,
    cwd: workspacePath,
    approvalPolicy: approvalPolicy(),
    approvalsReviewer: "user",
  };
  const model = optionalEnv("RELAY_MODEL");
  const effort = optionalEnv("RELAY_REASONING_EFFORT");
  if (model) turnParams.model = model;
  if (effort) turnParams.effort = effort;
  await client.request("turn/start", turnParams);
} catch (error) {
  fail(error);
}

async function handleServerRequest(message) {
  const method = String(message.method || "");
  if (method !== "item/commandExecution/requestApproval" && method !== "item/fileChange/requestApproval") {
    client.respondError(message.id, -32601, `Relay does not handle ${method}`);
    return;
  }
  const params = message.params || {};
  const command = Array.isArray(params.command) ? params.command.join(" ") : params.command;
  const kind = method.includes("fileChange") ? "file_change" : params.networkApprovalContext ? "network" : "command";
  const title = kind === "file_change" ? "Apply file changes" : kind === "network" ? "Allow network access" : "Run command";
  let record;
  try {
    record = approvalStore.create({
      jobId,
      provider: "codex",
      kind,
      title,
      reason: params.reason,
      command: command || networkLabel(params.networkApprovalContext),
      cwd: params.cwd || workspacePath,
      itemId: params.itemId,
      threadId: params.threadId || currentThreadId,
      turnId: params.turnId,
      requestId: message.id,
      availableDecisions: params.availableDecisions,
    });
    step(`Waiting for approval: ${record.title}${record.command ? ` — ${record.command}` : ""}`);
    const resolution = await approvalStore.waitForDecision(record.id, { signal: controller.signal });
    client.respond(message.id, { decision: resolution.decision });
    step(resolution.decision.startsWith("accept") ? "Approved from Relay" : "Denied from Relay");
  } catch (error) {
    client.respond(message.id, { decision: "cancel" });
    process.stderr.write(`[approval] ${error.message}\n`);
  }
}

function handleNotification(message) {
  const method = String(message.method || "");
  const params = message.params || {};
  const item = params.item || {};
  if (method === "item/started") {
    if (item.type === "commandExecution") step(`Running ${displayCommand(item.command)}`);
    else if (item.type === "fileChange") step(`Editing ${fileChangePaths(item)}`);
    else if (item.type === "webSearch") step(`Searching ${item.query || "the web"}`);
    return;
  }
  if (method === "item/commandExecution/outputDelta" && params.delta) {
    process.stdout.write(params.delta);
    return;
  }
  if (method === "item/reasoning/summaryTextDelta" && params.delta) {
    process.stderr.write(params.delta);
    return;
  }
  if (method === "item/agentMessage/delta" && params.delta) {
    streamedAnswer += params.delta;
    process.stdout.write(params.delta);
    return;
  }
  if (method === "item/completed") {
    if (item.type === "agentMessage" && typeof item.text === "string") finalAnswer = item.text;
    if (item.type === "exitedReviewMode" && typeof item.review === "string") finalAnswer = item.review;
    if (item.type === "commandExecution" && item.status === "failed") {
      const output = typeof item.aggregatedOutput === "string" ? item.aggregatedOutput : "";
      if (SANDBOX_STARTUP_FAILURES.some((pattern) => pattern.test(output))) {
        sandboxStartupFailure = new Error(
          "Codex sandbox could not access the workspace. The Relay runner needs repair before this job can run.",
        );
      }
    }
    return;
  }
  if (method === "turn/completed") {
    const turn = params.turn || {};
    if (turn.status === "completed" && sandboxStartupFailure) fail(sandboxStartupFailure);
    else if (turn.status === "completed") succeed();
    else fail(new Error(turn.error?.message || `Codex turn ended with ${turn.status || "unknown status"}`));
  }
}

function succeed() {
  if (completed) return;
  completed = true;
  fs.writeFileSync(resultPath, (finalAnswer || streamedAnswer).trim(), { encoding: "utf8", mode: 0o600 });
  client.stop();
  setTimeout(() => process.exit(0), 30);
}

function fail(error) {
  if (completed) return;
  completed = true;
  approvalStore.cancelPendingForJob(jobId, error?.message || "Codex job stopped.");
  process.stderr.write(`${error?.stack || error?.message || String(error)}\n`);
  try { client.stop(); } catch {}
  setTimeout(() => process.exit(1), 30);
}

function selectedSkillInputs() {
  let records = [];
  try { records = JSON.parse(process.env.RELAY_CODEX_SKILL_INPUTS || "[]"); } catch {}
  if (!Array.isArray(records)) return [];
  return records
    .filter((record) => record && record.kind !== "command" && typeof record.name === "string" && typeof record.path === "string")
    .map((record) => ({ type: "skill", name: record.name, path: record.path }));
}

function approvalPolicy() {
  const value = process.env.RELAY_CODEX_APPROVAL_POLICY;
  return ["untrusted", "on-failure", "on-request", "never"].includes(value) ? value : "on-request";
}

function optionalEnv(name) { return process.env[name]?.trim() || null; }
function requiredEnv(name) {
  const value = optionalEnv(name);
  if (!value) throw new Error(`${name} is required`);
  return value;
}
function step(text) { process.stderr.write(`\n[relay-step] ${text}\n`); }
function displayCommand(value) { return Array.isArray(value) ? value.join(" ") : String(value || "command"); }
function fileChangePaths(item) {
  const paths = Array.isArray(item.changes) ? item.changes.map((change) => change?.path).filter(Boolean) : [];
  return paths.slice(0, 6).join(", ") || "workspace files";
}
function networkLabel(context) {
  if (!context || typeof context !== "object") return "";
  return [context.protocol, context.host, context.port].filter((part) => part !== null && part !== undefined && part !== "").join(" ");
}
async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString("utf8");
}
