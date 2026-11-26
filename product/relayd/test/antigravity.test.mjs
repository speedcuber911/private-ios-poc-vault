// First-class Google Antigravity CLI (`agy`) provider tests:
// adapter, timeline mapper, auth detection (OAuth/ADC & Gemini API key),
// direct phone SSH paste-back login, smoke, runtime `agy models` discovery,
// streaming job execution + resume + auth rejection, and AWS/Bedrock scrubbing.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  createAntigravityStreamMapper,
  describeAntigravityTool,
  legacyAntigravityStepLine,
} from "../src/timeline-antigravity.mjs";
import { freePort, waitForJob, waitForJson, waitForServer, watchChild } from "./helpers/wait.mjs";

// util.mjs transitively imports config.mjs (which initializes CODEX_DATA_DIR at
// import time), so point config at a throwaway sandbox before importing it.
const bootstrapDir = fs.mkdtempSync(path.join(os.tmpdir(), "relayd-agy-unit-"));
process.env.CODEX_DATA_DIR = path.join(bootstrapDir, "data");
process.env.CODEX_RUN_HOME = path.join(bootstrapDir, "home");
process.env.CODEX_HOME = path.join(bootstrapDir, "home", ".codex");
process.env.CODEX_WORKSPACE_BROWSE_ROOT = bootstrapDir;
process.env.KIMI_BIN = path.join(bootstrapDir, "no-kimi");
process.env.ANTIGRAVITY_BIN = path.join(bootstrapDir, "no-agy");
after(() => fs.rmSync(bootstrapDir, { recursive: true, force: true }));

const { buildAntigravityArgs, parseAntigravityModelsOutput } = await import("../src/adapters/antigravity.mjs");
const { parseAntigravityEffortLevels } = await import("../src/provider-help.mjs");
const { mergeRuntimeAntigravityModels, runtimeAntigravityDescriptor } = await import("../src/catalog.mjs");

const here = path.dirname(fileURLToPath(import.meta.url));
const serverEntry = path.join(here, "..", "src", "index.mjs");

const FAKE_OAUTH_CODE = "4/0AeaYSHD_secret_google_oauth_code_998877";
const CONV_UUID = "40007a0f-474f-41fb-a456-465030964bcc";

const AMBIENT_AWS_ENV = {
  AWS_ACCESS_KEY_ID: "AKIAIOSFODNN7EXAMPLE",
  AWS_SECRET_ACCESS_KEY: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
  AWS_SESSION_TOKEN: "ambient-session-token",
  AWS_PROFILE: "ambient-profile",
  AWS_DEFAULT_PROFILE: "ambient-default-profile",
  AWS_REGION: "us-west-2",
  AWS_DEFAULT_REGION: "us-west-2",
  CLAUDE_CODE_USE_BEDROCK: "1",
  CLAUDE_AWS_PROFILE: "sigiq",
};

const REAL_AGY_HELP = [
  "Usage of agy:",
  "  --conversation                  Resume a previous conversation by ID",
  "  --dangerously-skip-permissions  Auto-approve all tool permission requests without prompting",
  "  --disable-slash-commands        Disable slash command and skill expansion in print mode",
  "  --effort                        Reasoning effort for the current CLI session (low|medium|high|xhigh|max)",
  "  -i                              Short alias for --prompt-interactive",
  "  --mode                          Set the agent execution mode for this session (accept-edits, auto, plan)",
  "  --model                         Model for the current CLI session",
  "",
].join("\n");

// --------------------------------------------------------------------------
// Pure unit tests (adapter, timeline mapper, parser, catalog merge)
// --------------------------------------------------------------------------

test("buildAntigravityArgs builds headless stream-json and print invocations", () => {
  const streamArgs = buildAntigravityArgs(
    { model: "gemini-4-neon-high", reasoningEffort: "xhigh", resumeSessionId: CONV_UUID },
    { transport: "stream", dangerousMode: true },
  );
  assert.deepEqual(streamArgs, [
    "--input-format", "stream-json",
    "--output-format", "stream-json",
    "--disable-slash-commands",
    "--dangerously-skip-permissions",
    "--model", "gemini-4-neon-high",
    "--effort", "xhigh",
    "--conversation", CONV_UUID,
  ]);
  assert.equal(streamArgs.includes("-p"), false);
  assert.equal(streamArgs.includes("--print"), false);

  const safeArgs = buildAntigravityArgs({ model: "gemini-4-argon-medium" }, { dangerousMode: false });
  assert.equal(safeArgs.includes("--dangerously-skip-permissions"), false);
  assert.deepEqual(safeArgs, [
    "--input-format", "stream-json",
    "--output-format", "stream-json",
    "--disable-slash-commands",
    "--model", "gemini-4-argon-medium",
  ]);
});

test("parseAntigravityModelsOutput handles spinner carriage returns and ANSI codes", () => {
  const raw =
    "\r\x1B[36m⠋ Fetching available models...\x1B[0m" +
    "\r⠙ Fetching available models..." +
    "\rgemini-4-neon-high             Gemini 4 Neon (High)\n" +
    "gemini-4-carbon-medium         Gemini 4 Carbon (Medium)\n" +
    "gemini-4-neon-high             Duplicate Should Be Ignored\n" +
    "Error:  Not a model slug\n" +
    "gemini-3.8-flash-high          Gemini 3.8 Flash (High)\n";
  assert.deepEqual(parseAntigravityModelsOutput(raw), [
    { slug: "gemini-4-neon-high", label: "Gemini 4 Neon (High)" },
    { slug: "gemini-4-carbon-medium", label: "Gemini 4 Carbon (Medium)" },
    { slug: "gemini-3.8-flash-high", label: "Gemini 3.8 Flash (High)" },
  ]);
});

test("describeAntigravityTool maps all built-in tool categories and legacy step lines", () => {
  const cases = [
    ["run_command", { CommandLine: "npm test", toolSummary: "Run tests" }, "command", "Running npm test"],
    ["view_file", { Path: "/work/app/src/index.mjs", StartLine: 1, EndLine: 40 }, "read", "Reading /work/app/src/index.mjs"],
    ["read_file", { Path: "/work/app/README.md" }, "read", "Reading /work/app/README.md"],
    ["replace_file_content", { Path: "/work/a.js", TargetContent: "old", ReplacementContent: "new" }, "edit", "Editing /work/a.js"],
    ["multi_replace_file_content", { Path: "/work/b.js", ReplacementChunks: [{ TargetContent: "a", ReplacementContent: "b" }] }, "edit", "Editing /work/b.js"],
    ["edit_file", { Path: "/work/c.js", Target: "x", Replacement: "y" }, "edit", "Editing /work/c.js"],
    ["sed_file", { Path: "/work/d.js" }, "edit", "Editing /work/d.js"],
    ["write_to_file", { Path: "/work/new.js", Content: "hi" }, "write", "Writing /work/new.js"],
    ["write_file", { Path: "/work/new2.js", Content: "hi" }, "write", "Writing /work/new2.js"],
    ["grep_search", { Query: "relayd", SearchPath: "/work" }, "search", "Searching relayd"],
    ["find_by_name", { Pattern: "*.mjs", SearchDirectory: "/work" }, "search", "Searching *.mjs"],
    ["list_dir", { DirectoryPath: "/work/src" }, "search", "Searching /work/src"],
    ["search_web", { query: "antigravity cli" }, "fetch", "Fetching antigravity cli"],
    ["read_url_content", { Url: "https://example.com/docs" }, "fetch", "Fetching https://example.com/docs"],
    ["open_browser_url", { Url: "https://example.com/app" }, "fetch", "Fetching https://example.com/app"],
    ["invoke_subagent", { Role: "Code Reviewer", TypeName: "research", Prompt: "Check diff" }, "agent", "Agent: Code Reviewer"],
    ["custom_mcp_tool", { foo: "bar" }, "tool", "Using Custom Mcp Tool"],
  ];
  for (const [name, params, expectedKind, expectedLegacy] of cases) {
    const detail = describeAntigravityTool(name, params, { cwd: "/work" });
    assert.equal(detail.kind, expectedKind, `tool ${name} kind`);
    assert.equal(legacyAntigravityStepLine(detail), expectedLegacy, `tool ${name} legacy line`);
  }
});

test("createAntigravityStreamMapper maps init, step_update (prose, tool, subagent), and result", () => {
  const mapper = createAntigravityStreamMapper({ now: () => "2026-11-26T04:00:00.000Z" });
  const events = [];
  const push = (obj) => events.push(...mapper.push(obj));

  push({ event: "init", conversation_id: CONV_UUID, init: { model: "gemini-4-neon-high", cwd: "/work/app" } });
  assert.equal(mapper.sessionId(), CONV_UUID);

  push({ event: "step_update", step_update: { conversation_id: CONV_UUID, step_index: 0, state: "DONE", step_type: "user_input" } });
  push({ event: "step_update", step_update: { conversation_id: CONV_UUID, step_index: 1, state: "ACTIVE", step_type: "agent_response", text_delta: "Checking " } });
  push({ event: "step_update", step_update: { conversation_id: CONV_UUID, step_index: 1, state: "DONE", step_type: "agent_response", text_delta: "the repo." } });
  push({
    event: "step_update",
    step_update: {
      conversation_id: CONV_UUID,
      step_index: 2,
      state: "ACTIVE",
      step_type: "tool",
      tool_name: "run_command",
      tool_info: { name: "run_command", parameters: { CommandLine: "echo hi", toolSummary: "Echo greeting" } },
    },
  });
  push({
    event: "step_update",
    step_update: {
      conversation_id: CONV_UUID,
      step_index: 2,
      state: "DONE",
      step_type: "tool",
      tool_name: "run_command",
      tool_info: { name: "run_command", parameters: { CommandLine: "echo hi" }, output: "hi\n" },
    },
  });
  push({
    event: "step_update",
    step_update: {
      conversation_id: CONV_UUID,
      step_index: 3,
      state: "DONE",
      step_type: "tool",
      tool_name: "invoke_subagent",
      tool_info: { name: "invoke_subagent", parameters: { Role: "Researcher", TypeName: "research", Prompt: "Scan files" }, output: "All clear" },
      subagent_info: { subagents: [{ conversation_id: "sub-1", role: "Researcher", status: "completed" }] },
    },
  });
  push({ event: "step_update", step_update: { conversation_id: CONV_UUID, step_index: 4, state: "DONE", step_type: "checkpoint" } });
  push({ event: "step_update", step_update: { conversation_id: CONV_UUID, step_index: 5, state: "DONE", step_type: "agent_response", text_delta: "All done!" } });
  push({
    event: "result",
    result: {
      conversation_id: CONV_UUID,
      status: "SUCCESS",
      response: "All done!",
      duration_seconds: 1.5,
      num_turns: 1,
      usage: { input_tokens: 1200, output_tokens: 300, thinking_tokens: 50, cache_read_tokens: 400, total_tokens: 1550 },
    },
  });

  assert.equal(mapper.finalAnswer(), "All done!");
  assert.equal(mapper.outcome().isError, false);

  const textEvents = events.filter((e) => e.type === "text");
  assert.deepEqual(textEvents, [
    { type: "text", id: "t1", delta: "Checking " },
    { type: "text", id: "t1", delta: "the repo." },
    { type: "text", id: "t2", delta: "All done!" },
  ]);

  const cmdOpen = events.find((e) => e.type === "step" && e.id === "s1" && e.status === "running");
  assert.equal(cmdOpen.kind, "command");
  assert.equal(cmdOpen.input.command, "echo hi");
  assert.equal(cmdOpen.input.cwd, "/work/app");

  const cmdDone = events.find((e) => e.type === "step" && e.id === "s1" && e.status === "done");
  assert.equal(cmdDone.output, "hi\n");
  assert.equal(cmdDone.exitCode, 0);

  const agentStep = events.find((e) => e.type === "step" && e.id === "a1");
  assert.equal(agentStep.kind, "agent");
  assert.equal(agentStep.status, "done");
  assert.equal(agentStep.agent.id, "sub-1");
  assert.equal(agentStep.agent.status, "done");

  const usage = events.find((e) => e.type === "usage");
  assert.deepEqual(usage, { type: "usage", inputTokens: 1200, outputTokens: 350 });
});

test("parseAntigravityEffortLevels & mergeRuntimeAntigravityModels", () => {
  assert.deepEqual(parseAntigravityEffortLevels(REAL_AGY_HELP), ["low", "medium", "high", "xhigh", "max"]);
  assert.equal(parseAntigravityEffortLevels("  --effort   Reasoning effort\n  --mode   Mode (low|high)\n"), null);
  assert.equal(parseAntigravityEffortLevels("  --model   Model only\n"), null);

  const configured = [
    { id: "codex-cli", label: "Codex", provider: "codex", modes: ["task"] },
    { id: "antigravity-cli", label: "Antigravity", provider: "antigravity", modes: ["task"], effortLevels: ["low", "high"] },
    { id: "antigravity-old", label: "Old", provider: "antigravity", modes: ["task"], taskModel: "old-model", effortLevels: ["low", "high"] },
    { id: "claude-code", label: "Claude", provider: "claude", modes: ["task"] },
  ];
  const runtime = [runtimeAntigravityDescriptor({ slug: "gemini-4-neon-high", label: "Gemini 4 Neon (High)" })];
  const merged = mergeRuntimeAntigravityModels(configured, runtime);
  assert.deepEqual(merged.map((m) => m.id), ["codex-cli", "antigravity-cli", "antigravity-gemini-4-neon-high", "claude-code"]);
});

// --------------------------------------------------------------------------
// End-to-end daemon tests with fake `agy` binary
// --------------------------------------------------------------------------

function writeFakeAgy(dir) {
  const file = path.join(dir, "fake-agy");
  const source = `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const readline = require("node:readline");

const args = process.argv.slice(2);
const stateDir = process.env.FAKE_AGY_STATE_DIR;
const mode = () => {
  try { return fs.readFileSync(path.join(stateDir, "mode"), "utf8").trim(); } catch { return "signed-in"; }
};
const envSnapshot = () => ({
  SSH_CONNECTION: process.env.SSH_CONNECTION || null,
  SSH_CLIENT: process.env.SSH_CLIENT || null,
  BROWSER: process.env.BROWSER || null,
  DISPLAY: process.env.DISPLAY === undefined ? null : process.env.DISPLAY,
  AWS_ACCESS_KEY_ID: process.env.AWS_ACCESS_KEY_ID || null,
  AWS_SECRET_ACCESS_KEY: process.env.AWS_SECRET_ACCESS_KEY || null,
  AWS_SESSION_TOKEN: process.env.AWS_SESSION_TOKEN || null,
  AWS_PROFILE: process.env.AWS_PROFILE || null,
  AWS_DEFAULT_PROFILE: process.env.AWS_DEFAULT_PROFILE || null,
  AWS_REGION: process.env.AWS_REGION || null,
  AWS_DEFAULT_REGION: process.env.AWS_DEFAULT_REGION || null,
  CLAUDE_CODE_USE_BEDROCK: process.env.CLAUDE_CODE_USE_BEDROCK || null,
  CLAUDE_AWS_PROFILE: process.env.CLAUDE_AWS_PROFILE || null,
  ANTIGRAVITY_HOME: process.env.ANTIGRAVITY_HOME || null,
});

if (args[0] === "--version") {
  console.log("1.5.12");
  process.exit(0);
}
if (args[0] === "--help") {
  process.stdout.write(${JSON.stringify(REAL_AGY_HELP)});
  process.exit(0);
}
if (args[0] === "models") {
  fs.writeFileSync(path.join(stateDir, "models-call.json"), JSON.stringify({ args, env: envSnapshot() }));
  if (mode() === "signed-out") {
    process.stderr.write("Error: authentication required. Run agy to sign in.\\n");
    process.exit(1);
  }
  if (mode() === "models-error") {
    process.stderr.write("transient models error\\n");
    process.exit(1);
  }
  process.stdout.write(
    "\\r⠋ Fetching available models...\\r⠙ Fetching available models..." +
    "\\rgemini-4-neon-high             Gemini 4 Neon (High)\\n" +
    "gemini-4-custom-live           Gemini 4 Custom Live\\n"
  );
  process.exit(0);
}

// Bare \`agy\` with no args => Remote SSH OAuth paste-back login flow.
if (args.length === 0) {
  fs.writeFileSync(path.join(stateDir, "login-call.json"), JSON.stringify({ args, env: envSnapshot() }));
  console.log("Open this URL to sign in: https://accounts.google.com/o/oauth2/v2/auth?client_id=fake-agy&redirect_uri=urn:ietf:wg:oauth:2.0:oob");
  console.log("Paste the authorization code here:");
  const rl = readline.createInterface({ input: process.stdin });
  rl.once("line", (line) => {
    fs.writeFileSync(path.join(stateDir, "login-code.txt"), line);
    fs.writeFileSync(path.join(stateDir, "mode"), "signed-in");
    console.log("Signed in successfully.");
    rl.close();
    process.exit(0);
  });
  return;
}

// Smoke op: --print <prompt> --output-format stream-json --disable-slash-commands --print-timeout 90s
if (args[0] === "--print") {
  fs.writeFileSync(path.join(stateDir, "smoke-call.json"), JSON.stringify({ args, env: envSnapshot() }));
  console.log(JSON.stringify({
    event: "result",
    result: { conversation_id: ${JSON.stringify(CONV_UUID)}, status: "SUCCESS", response: "OK" },
  }));
  process.exit(0);
}

// Streaming job: --input-format stream-json --output-format stream-json ...
if (args.includes("--input-format")) {
  let raw = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => { raw += chunk; });
  process.stdin.on("end", () => {
    const firstLine = raw.trim().split("\\n")[0] || "";
    let parsedInput = null;
    try { parsedInput = JSON.parse(firstLine); } catch {}
    const prompt = parsedInput?.message?.content || "";
    const convIdx = args.indexOf("--conversation");
    const convId = convIdx !== -1 ? args[convIdx + 1] : ${JSON.stringify(CONV_UUID)};
    fs.writeFileSync(path.join(stateDir, "job-call.json"), JSON.stringify({
      args,
      rawStdin: raw,
      parsedInput,
      env: envSnapshot(),
    }));

    const out = (obj) => process.stdout.write(JSON.stringify(obj) + "\\n");

    if (prompt.includes("AUTH_FAIL")) {
      out({ event: "init", conversation_id: convId, init: { model: "gemini-4-neon-high", cwd: process.cwd() } });
      out({
        event: "result",
        result: {
          conversation_id: convId,
          status: "ERROR",
          error: "Authentication required: OAuth token expired (401)",
          num_turns: 1,
        },
      });
      process.exit(1);
    }

    if (prompt.includes("PLAIN_TEXT")) {
      console.log("Plain text fallback answer");
      process.exit(0);
    }

    out({ event: "init", conversation_id: convId, init: { model: "gemini-4-neon-high", cwd: process.cwd() } });
    out({ event: "step_update", step_update: { conversation_id: convId, step_index: 0, state: "DONE", step_type: "user_input" } });
    out({ event: "step_update", step_update: { conversation_id: convId, step_index: 1, state: "ACTIVE", step_type: "agent_response", text_delta: "Let me check " } });
    out({ event: "step_update", step_update: { conversation_id: convId, step_index: 1, state: "DONE", step_type: "agent_response", text_delta: "the workspace." } });
    out({
      event: "step_update",
      step_update: {
        conversation_id: convId,
        step_index: 2,
        state: "ACTIVE",
        step_type: "tool",
        tool_name: "run_command",
        tool_info: { name: "run_command", parameters: { CommandLine: "echo agy-probe", toolSummary: "Probe echo" } },
      },
    });
    out({
      event: "step_update",
      step_update: {
        conversation_id: convId,
        step_index: 2,
        state: "DONE",
        step_type: "tool",
        tool_name: "run_command",
        tool_info: { name: "run_command", parameters: { CommandLine: "echo agy-probe" }, output: "agy-probe\\n" },
      },
    });
    const answer = convIdx !== -1 ? "Resumed conversation " + convId : "Antigravity finished cleanly.";
    out({ event: "step_update", step_update: { conversation_id: convId, step_index: 3, state: "DONE", step_type: "agent_response", text_delta: answer } });
    out({
      event: "result",
      result: {
        conversation_id: convId,
        status: "SUCCESS",
        response: answer,
        duration_seconds: 0.4,
        num_turns: 1,
        usage: { input_tokens: 500, output_tokens: 120, thinking_tokens: 30, cache_read_tokens: 100, total_tokens: 650 },
      },
    });
    process.exit(0);
  });
  return;
}

process.stderr.write("unexpected args: " + JSON.stringify(args) + "\\n");
process.exit(2);
`;
  fs.writeFileSync(file, source, { mode: 0o755 });
  return file;
}

async function startDaemon({ initialMode = "signed-in", extraEnv = {} } = {}) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "relayd-agy-e2e-")));
  const workspaceDir = path.join(dir, "scratch");
  const homeDir = path.join(dir, "home");
  const agyHome = path.join(homeDir, ".gemini", "antigravity-cli");
  const stateDir = path.join(dir, "state");
  fs.mkdirSync(workspaceDir, { recursive: true });
  fs.mkdirSync(agyHome, { recursive: true });
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(path.join(stateDir, "mode"), initialMode);

  const fakeAgy = writeFakeAgy(dir);
  const port = await freePort();
  const env = {
    ...process.env,
    ...AMBIENT_AWS_ENV,
    DISPLAY: ":99",
    CODEX_API_HOST: "127.0.0.1",
    RELAYD_DIRECT_TLS: "false",
    CODEX_API_PORT: String(port),
    CODEX_REQUIRE_MTLS: "false",
    RELAYD_PAIRING_ENABLED: "false",
    CODEX_RUN_HOME: homeDir,
    CODEX_DATA_DIR: path.join(dir, "data"),
    CODEX_WORKSPACE_BROWSE_ROOT: dir,
    CODEX_WORKSPACES: JSON.stringify([{ id: "scratch", name: "Scratch", path: workspaceDir }]),
    CODEX_BIN: path.join(dir, "missing-codex"),
    CLAUDE_BIN: path.join(dir, "missing-claude"),
    KIMI_BIN: path.join(dir, "missing-kimi"),
    ANTIGRAVITY_BIN: fakeAgy,
    ANTIGRAVITY_HOME: agyHome,
    FAKE_AGY_STATE_DIR: stateDir,
    ...extraEnv,
  };
  delete env.CODEX_MODEL_CATALOG;

  const child = spawn(process.execPath, [serverEntry], { env, stdio: ["ignore", "pipe", "pipe"] });
  const watch = watchChild(child, "relayd(antigravity)");
  const baseUrl = `http://127.0.0.1:${port}`;
  await waitForServer(baseUrl, { exited: watch.exited, output: watch.output });

  return {
    baseUrl,
    dir,
    homeDir,
    agyHome,
    stateDir,
    workspaceDir,
    describe: watch.describe,
    setMode(next) {
      fs.writeFileSync(path.join(stateDir, "mode"), next);
    },
    readStateJson(name) {
      return JSON.parse(fs.readFileSync(path.join(stateDir, name), "utf8"));
    },
    async stop() {
      if (child.exitCode === null) {
        child.kill("SIGTERM");
        await new Promise((resolve) => child.once("exit", resolve));
      }
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

async function pollOp(server, opId, predicate) {
  const { op } = await waitForJson(
    server,
    `/v1/harness/ops/${opId}`,
    (body) => Boolean(body?.op) && predicate(body.op),
    `harness op ${opId}`,
  );
  return op;
}

test("GET /v1/harness detects signed-in, signed-out, and Gemini API-key Antigravity modes", async () => {
  const server = await startDaemon({ initialMode: "signed-in" });
  try {
    // 1. Signed-in OAuth/ADC mode.
    let { harnesses } = await (await fetch(`${server.baseUrl}/v1/harness`)).json();
    let agy = harnesses.find((entry) => entry.provider === "antigravity");
    assert.equal(agy.installed, true);
    assert.equal(agy.version, "1.5.12");
    assert.equal(agy.loggedIn, true);
    assert.equal(agy.authKind, "subscription");
    assert.equal(agy.supportsApprovals, false);
    assert.equal(agy.supportsResume, true);
    assert.equal(agy.supportsChat, false);
    assert.equal(agy.taskControls.model, true);
    assert.equal(agy.taskControls.reasoningEffort, true);

    // Verify AWS/Bedrock env was stripped during the `agy models` auth probe.
    const probeCall = server.readStateJson("models-call.json");
    for (const key of Object.keys(AMBIENT_AWS_ENV)) {
      assert.equal(probeCall.env[key], null, `${key} leaked to agy models`);
    }

    // 2. Signed-out OAuth mode -> harness reports loggedIn: false and job creation is 503.
    server.setMode("signed-out");
    ({ harnesses } = await (await fetch(`${server.baseUrl}/v1/harness`)).json());
    agy = harnesses.find((entry) => entry.provider === "antigravity");
    assert.equal(agy.installed, true);
    assert.equal(agy.loggedIn, false);
    assert.equal(agy.authKind, "unknown");

    const blocked = await fetch(`${server.baseUrl}/v1/codex/jobs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ workspaceId: "scratch", provider: "antigravity", prompt: "Hello" }),
    });
    assert.equal(blocked.status, 503);
    assert.match((await blocked.json()).error, /Antigravity is not connected/);

    // 3. Gemini API key mode without GEMINI_API_KEY -> loggedIn: false, authKind: "api".
    fs.writeFileSync(path.join(server.agyHome, "settings.json"), JSON.stringify({ modelProvider: "gemini" }));
    ({ harnesses } = await (await fetch(`${server.baseUrl}/v1/harness`)).json());
    agy = harnesses.find((entry) => entry.provider === "antigravity");
    assert.equal(agy.loggedIn, false);
    assert.equal(agy.authKind, "api");
  } finally {
    await server.stop();
  }

  // 4. Gemini API key mode WITH GEMINI_API_KEY -> loggedIn: true, authKind: "api".
  const apiServer = await startDaemon({
    initialMode: "signed-out",
    extraEnv: { GEMINI_API_KEY: "AIza-fake-test-key" },
  });
  try {
    fs.writeFileSync(path.join(apiServer.agyHome, "settings.json"), JSON.stringify({ modelProvider: "gemini" }));
    const { harnesses } = await (await fetch(`${apiServer.baseUrl}/v1/harness`)).json();
    const agy = harnesses.find((entry) => entry.provider === "antigravity");
    assert.equal(agy.installed, true);
    assert.equal(agy.loggedIn, true);
    assert.equal(agy.authKind, "api");
  } finally {
    await apiServer.stop();
  }
});

test("direct phone sign-in uses bare agy in SSH paste-back mode, strips AWS vars, and never leaks code", async () => {
  const server = await startDaemon({ initialMode: "signed-out" });
  try {
    const start = await fetch(`${server.baseUrl}/v1/harness/antigravity/login`, { method: "POST" });
    assert.equal(start.status, 202);
    const { op } = await start.json();
    assert.equal(op.provider, "antigravity");
    assert.equal(op.action, "login");

    const waiting = await pollOp(server, op.id, (o) => o.status === "waiting_for_user");
    assert.match(waiting.verificationUrl, /^https:\/\/accounts\.google\.com\/o\/oauth2\/v2\/auth/);

    // Verify bare `agy` (no subcommand), SSH paste-back env, DISPLAY removed, AWS stripped.
    const loginCall = server.readStateJson("login-call.json");
    assert.deepEqual(loginCall.args, []);
    assert.ok(loginCall.env.SSH_CONNECTION, "SSH_CONNECTION must be set for Remote SSH OAuth mode");
    assert.ok(loginCall.env.SSH_CLIENT, "SSH_CLIENT must be set for Remote SSH OAuth mode");
    assert.equal(loginCall.env.BROWSER, "false");
    assert.equal(loginCall.env.DISPLAY, null);
    for (const key of Object.keys(AMBIENT_AWS_ENV)) {
      assert.equal(loginCall.env[key], null, `${key} leaked into agy login`);
    }

    // Deliver authorization code via paste-back endpoint.
    const send = await fetch(`${server.baseUrl}/v1/harness/ops/${op.id}/input`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: `  ${FAKE_OAUTH_CODE}\n` }),
    });
    assert.equal(send.status, 200);

    const done = await pollOp(server, op.id, (o) => o.status === "succeeded");
    assert.equal(done.error, null);
    assert.equal(fs.readFileSync(path.join(server.stateDir, "login-code.txt"), "utf8"), FAKE_OAUTH_CODE);
    assert.equal(done.logTail.includes(FAKE_OAUTH_CODE), false, "OAuth code must never leak into logTail");

    // Harness now reports signed-in.
    const { harnesses } = await (await fetch(`${server.baseUrl}/v1/harness`)).json();
    const agy = harnesses.find((entry) => entry.provider === "antigravity");
    assert.equal(agy.loggedIn, true);
    assert.equal(agy.authKind, "subscription");
  } finally {
    await server.stop();
  }
});

test("smoke op runs agy --print with stream-json, closed stdin, and updates lastSmoke", async () => {
  const server = await startDaemon({ initialMode: "signed-in" });
  try {
    const start = await fetch(`${server.baseUrl}/v1/harness/antigravity/smoke`, { method: "POST" });
    assert.equal(start.status, 202);
    const { op } = await start.json();
    const done = await pollOp(server, op.id, (o) => ["succeeded", "failed", "expired"].includes(o.status));
    assert.equal(done.status, "succeeded");

    const smokeCall = server.readStateJson("smoke-call.json");
    assert.deepEqual(smokeCall.args, [
      "--print", "Reply with exactly: OK",
      "--output-format", "stream-json",
      "--disable-slash-commands",
      "--print-timeout", "90s",
    ]);
    for (const key of Object.keys(AMBIENT_AWS_ENV)) {
      assert.equal(smokeCall.env[key], null, `${key} leaked into agy smoke`);
    }

    const { harnesses } = await (await fetch(`${server.baseUrl}/v1/harness`)).json();
    const agy = harnesses.find((entry) => entry.provider === "antigravity");
    assert.equal(agy.lastSmoke.status, "succeeded");
    assert.equal(agy.lastSmoke.opId, op.id);
  } finally {
    await server.stop();
  }
});

test("GET /v1/codex/models discovers runtime agy models and falls back cleanly on error", async () => {
  // Live runtime discovery.
  const server = await startDaemon({ initialMode: "signed-in" });
  try {
    const { models } = await (await fetch(`${server.baseUrl}/v1/codex/models`)).json();
    const agyModels = models.filter((m) => m.provider === "antigravity");
    assert.deepEqual(agyModels.map((m) => m.id), [
      "antigravity-cli",
      "antigravity-gemini-4-neon-high",
      "antigravity-gemini-4-custom-live",
    ]);
    assert.equal(agyModels[0].taskModel, undefined);
    assert.equal(agyModels[2].taskModel, "gemini-4-custom-live");
    assert.equal(agyModels[2].label, "Antigravity · Gemini 4 Custom Live");
    assert.deepEqual(agyModels[2].effortLevels, ["low", "medium", "high", "xhigh", "max"]);
  } finally {
    await server.stop();
  }

  // Fallback when `agy models` fails.
  const fallbackServer = await startDaemon({ initialMode: "models-error" });
  try {
    const { models } = await (await fetch(`${fallbackServer.baseUrl}/v1/codex/models`)).json();
    const agyModels = models.filter((m) => m.provider === "antigravity");
    assert.deepEqual(agyModels.map((m) => m.id), [
      "antigravity-cli",
      "antigravity-gemini-4-neon-high",
      "antigravity-gemini-4-carbon-medium",
      "antigravity-gemini-4-argon-medium",
      "antigravity-gemini-3.8-flash-high",
    ]);
  } finally {
    await fallbackServer.stop();
  }
});

test("POST /v1/codex/jobs runs Antigravity stream runner, emits timeline, attaches session, resumes, and flags auth rejection", async () => {
  const server = await startDaemon({ initialMode: "signed-in" });
  try {
    // Verify skill discovery for antigravity.
    const skillDir = path.join(server.workspaceDir, ".agents", "skills", "deploy-check");
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(path.join(skillDir, "SKILL.md"), "---\nname: deploy-check\ndescription: Verify deploy\n---\nAlways check logs.\n");
    const skillsRes = await (await fetch(`${server.baseUrl}/v1/codex/skills?provider=antigravity&workspaceId=scratch`)).json();
    assert.equal(skillsRes.provider, "antigravity");
    assert.ok(skillsRes.skills.some((s) => s.id === "deploy-check"));

    // 1. Run a full streaming Antigravity job with model + effort + skill.
    const createRes = await fetch(`${server.baseUrl}/v1/codex/jobs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        workspaceId: "scratch",
        provider: "antigravity",
        model: "gemini-4-neon-high",
        reasoningEffort: "high",
        skills: ["deploy-check"],
        prompt: "Inspect the workspace",
      }),
    });
    assert.equal(createRes.status, 202, await createRes.clone().text());
    const created = await createRes.json();
    const job = await waitForJob(server, created.id);

    assert.equal(job.status, "succeeded");
    assert.equal(job.provider, "antigravity");
    assert.equal(job.model, "gemini-4-neon-high");
    assert.equal(job.reasoningEffort, "high");
    assert.equal(job.result, "Antigravity finished cleanly.");
    assert.equal(job.sessionId, CONV_UUID);
    assert.equal(job.execution.binary, "fake-agy");
    assert.equal(job.execution.binaryVersion, "1.5.12");
    assert.match(job.stderr, /^\[relay-step\] Running echo agy-probe$/m);
    assert.ok(job.timelineEvents > 0);

    // Check child invocation: NDJSON stdin, proper flags, NO -p/--print, NO AWS/Bedrock env.
    const call = server.readStateJson("job-call.json");
    assert.deepEqual(call.args, [
      "--input-format", "stream-json",
      "--output-format", "stream-json",
      "--disable-slash-commands",
      "--dangerously-skip-permissions",
      "--model", "gemini-4-neon-high",
      "--effort", "high",
    ]);
    assert.equal(call.parsedInput.event, "user");
    assert.match(call.parsedInput.message.content, /Selected Antigravity skills/);
    assert.match(call.parsedInput.message.content, /Inspect the workspace/);
    for (const key of Object.keys(AMBIENT_AWS_ENV)) {
      assert.equal(call.env[key], null, `${key} leaked into antigravity job env`);
    }

    // Check structured timeline endpoint.
    const timeline = await (await fetch(`${server.baseUrl}/v1/codex/jobs/${created.id}/timeline`)).json();
    assert.equal(timeline.complete, true);
    const events = timeline.events.map((e) => e.event);
    assert.ok(events.some((e) => e.type === "step" && e.kind === "command" && e.status === "running"));
    assert.ok(events.some((e) => e.type === "step" && e.status === "done" && e.output === "agy-probe\n"));
    assert.ok(events.some((e) => e.type === "text" && e.delta === "Antigravity finished cleanly."));
    assert.ok(events.some((e) => e.type === "usage" && e.inputTokens === 500 && e.outputTokens === 150));

    // Check thread listing and detail.
    const detailRes = await fetch(`${server.baseUrl}/v1/codex/threads/${CONV_UUID}?provider=antigravity`);
    assert.equal(detailRes.status, 200);
    assert.equal((await detailRes.json()).thread.provider, "antigravity");

    // 2. Resume the session -> passes --conversation <uuid>.
    const resumeRes = await fetch(`${server.baseUrl}/v1/codex/jobs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        workspaceId: "scratch",
        provider: "antigravity",
        model: "gemini-4-neon-high",
        resumeSessionId: CONV_UUID,
        prompt: "Continue from earlier",
      }),
    });
    assert.equal(resumeRes.status, 202, await resumeRes.clone().text());
    const resumed = await waitForJob(server, (await resumeRes.json()).id);
    assert.equal(resumed.status, "succeeded");
    assert.equal(resumed.result, `Resumed conversation ${CONV_UUID}`);
    assert.equal(resumed.sessionId, CONV_UUID);
    const resumeCall = server.readStateJson("job-call.json");
    assert.equal(resumeCall.args[resumeCall.args.indexOf("--conversation") + 1], CONV_UUID);

    // 3. Plain-text fallback from older/non-JSON CLI still succeeds cleanly.
    const plainRes = await fetch(`${server.baseUrl}/v1/codex/jobs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ workspaceId: "scratch", provider: "antigravity", prompt: "PLAIN_TEXT check" }),
    });
    assert.equal(plainRes.status, 202);
    const plainJob = await waitForJob(server, (await plainRes.json()).id);
    assert.equal(plainJob.status, "succeeded");
    assert.equal(plainJob.result, "Plain text fallback answer");

    // 4. Auth failure during job execution marks signInRequired: true, flips harness, blocks next job.
    const failRes = await fetch(`${server.baseUrl}/v1/codex/jobs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ workspaceId: "scratch", provider: "antigravity", prompt: "AUTH_FAIL now" }),
    });
    assert.equal(failRes.status, 202);
    const failedJob = await waitForJob(server, (await failRes.json()).id);
    assert.equal(failedJob.status, "failed");
    assert.equal(failedJob.signInRequired, true);
    assert.match(failedJob.error, /Authentication required/);

    const { harnesses } = await (await fetch(`${server.baseUrl}/v1/harness`)).json();
    const agyHarness = harnesses.find((h) => h.provider === "antigravity");
    assert.equal(agyHarness.loggedIn, false);
    assert.match(agyHarness.authRejected.reason, /Authentication required/);

    const rejectedCreate = await fetch(`${server.baseUrl}/v1/codex/jobs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ workspaceId: "scratch", provider: "antigravity", prompt: "Try again" }),
    });
    assert.equal(rejectedCreate.status, 503);
    assert.match((await rejectedCreate.json()).error, /Sign in again/);
  } finally {
    await server.stop();
  }
});
