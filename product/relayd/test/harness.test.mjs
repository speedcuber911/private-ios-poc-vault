// W2-MODULES harness tests: CLI detection, smoke ops, and the device-code
// login orchestration skeleton — all against fake CLI scripts, matching the
// conformance suite's fake-binary pattern.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { freePort, waitForJson, waitForServer, watchChild } from "./helpers/wait.mjs";

const serverEntry = path.join(path.dirname(new URL(import.meta.url).pathname), "..", "src", "index.mjs");

// The fake login CLIs below park until the daemon that spawned them is killed.
// Their loop bound is a HANG GUARD on an orphaned shell, never a bet on how
// fast the test can poll: the previous 10 s / 3 s bounds made the fake CLI exit
// (and the op fail or succeed early) before a saturated box had gotten around
// to reading the op, which is the test's own clock deciding the outcome.
const FAKE_CLI_PARK_ITERATIONS = 600; // 600 * 0.1s = 60s

async function startServer(extraEnv = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "relayd-harness-test-"));
  const workspaceDir = path.join(dir, "scratch");
  const homeDir = path.join(dir, "home");
  fs.mkdirSync(workspaceDir, { recursive: true });
  fs.mkdirSync(homeDir, { recursive: true });

  // Fake codex: supports --version and the exec smoke shape.
  const fakeCodex = path.join(dir, "fake-codex");
  fs.writeFileSync(
    fakeCodex,
    `#!/bin/sh\nif [ "$1" = "--version" ]; then echo "fake-codex 9.9.9"; exit 0; fi\nif [ "$1" = "login" ] && [ "$2" = "status" ]; then echo "Logged in using ChatGPT"; exit 0; fi\ncat > /dev/null\necho "OK"\n`,
    { mode: 0o755 },
  );

  // Fake claude login CLI: prints a device-code URL + user code, then waits
  // for $HOME/login-confirmed to appear before exiting 0. The iteration bound
  // only stops an orphaned shell from outliving the run; the test decides the
  // outcome by creating the file, never by elapsed time.
  const fakeClaude = path.join(dir, "fake-claude");
  fs.writeFileSync(
    fakeClaude,
    `#!/bin/sh\nif [ "$1" = "--version" ]; then echo "fake-claude 1.2.3"; exit 0; fi\nif [ "$1" = "--help" ]; then echo "  --model <model>  --effort <level>  --permission-mode <mode>"; exit 0; fi\nif [ "$1" = "auth" ] && [ "$2" = "status" ]; then echo '{"loggedIn":true,"authMethod":"claude.ai","apiProvider":"firstParty"}'; exit 0; fi\nif [ "$1" = "login" ]; then\n  echo "Visit https://provider.example/device and enter code WXYZ-2345 to continue"\n  i=0\n  while [ ! -f "$HOME/login-confirmed" ] && [ $i -lt ${FAKE_CLI_PARK_ITERATIONS} ]; do sleep 0.1; i=$((i+1)); done\n  [ -f "$HOME/login-confirmed" ] && exit 0 || exit 1\nfi\nexit 0\n`,
    { mode: 0o755 },
  );

  const port = await freePort();
  const child = spawn(process.execPath, [serverEntry], {
    env: {
      ...process.env,
      CODEX_API_HOST: "127.0.0.1",
      CODEX_API_PORT: String(port),
      CODEX_REQUIRE_MTLS: "false",
      // freePort() reserves ONE port; these daemons never exercise pairing, so
      // they bind exactly one listener and cannot squat on a port another test
      // was just handed.
      RELAYD_PAIRING_ENABLED: "false",
      CODEX_RUN_HOME: homeDir,
      CODEX_DATA_DIR: path.join(dir, "data"),
      CODEX_WORKSPACE_BROWSE_ROOT: dir,
      CODEX_WORKSPACES: JSON.stringify([{ id: "scratch", name: "Scratch", path: workspaceDir }]),
      CODEX_BIN: fakeCodex,
      CLAUDE_BIN: fakeClaude,
      CURSOR_BIN: path.join(dir, "missing-cursor"),
      KIMI_BIN: path.join(dir, "missing-kimi"),
      ...extraEnv,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  // Capture output and race readiness against the child's exit: a daemon that
  // died (a port clash used to do this) must say why, not time out with the
  // uninformative "server did not start". The readiness ceiling is a hang
  // detector (60 s, test/helpers/wait.mjs), not a bet on how fast a loaded box
  // can fork node.
  const watch = watchChild(child, "relayd(harness)");
  const baseUrl = `http://127.0.0.1:${port}`;
  await waitForServer(baseUrl, { exited: watch.exited, output: watch.output });
  return {
    baseUrl,
    homeDir,
    describe: watch.describe,
    async stop() {
      if (child.exitCode !== null) return;
      child.kill("SIGTERM");
      await new Promise((resolve) => child.once("exit", resolve));
    },
  };
}

// Polls one harness op until `predicate(op)` holds, over unpooled connections,
// with a hang-detector ceiling. Failures name the daemon and its output.
async function pollOp(server, opId, predicate) {
  const { op } = await waitForJson(
    server,
    `/v1/harness/ops/${opId}`,
    (body) => Boolean(body?.op) && predicate(body.op),
    `harness op ${opId}`,
  );
  return op;
}

test("GET /v1/harness detects installed CLIs with versions and capability flags", async () => {
  const server = await startServer();
  try {
    const response = await fetch(`${server.baseUrl}/v1/harness`);
    assert.equal(response.status, 200);
    const { harnesses } = await response.json();
    const byProvider = Object.fromEntries(harnesses.map((entry) => [entry.provider, entry]));

    assert.equal(byProvider.codex.installed, true);
    assert.equal(byProvider.codex.version, "fake-codex 9.9.9");
    assert.equal(byProvider.codex.loggedIn, true);
    assert.equal(byProvider.codex.authKind, "subscription");
    assert.equal(byProvider.codex.supportsChat, true);
    assert.equal(byProvider.codex.supportsApprovals, true);
    assert.equal(byProvider.codex.taskControls.reasoningEffort, true);
    assert.deepEqual(byProvider.codex.taskControls.approvalPolicies, ["untrusted", "on-failure", "on-request", "never"]);
    assert.equal(byProvider.claude.installed, true);
    assert.equal(byProvider.claude.version, "fake-claude 1.2.3");
    assert.equal(byProvider.claude.loggedIn, true);
    assert.equal(byProvider.claude.supportsApprovals, true);
    assert.deepEqual(byProvider.claude.taskControls.permissionModes, ["manual", "acceptEdits", "plan", "dontAsk", "auto"]);
    assert.equal(byProvider.cursor.installed, false);
    assert.equal(byProvider.cursor.version, null);
    assert.equal(byProvider.cursor.loggedIn, false);
    assert.equal(byProvider.cursor.lastSmoke, null);
    assert.equal(byProvider.kimi.installed, false);
    assert.equal(byProvider.kimi.loggedIn, false);
    assert.equal(byProvider.kimi.taskControls.model, true);
    assert.equal(byProvider.kimi.taskControls.reasoningEffort, false);
  } finally {
    await server.stop();
  }
});

test("confirmed signed-out Codex is visible and jobs fail before entering the queue", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "relayd-harness-signed-out-"));
  const signedOutCodex = writeFakeCli(
    dir,
    "signed-out-codex",
    [
      "#!/bin/sh",
      "if [ \"$1\" = \"--version\" ]; then echo \"fake-codex 9.9.9\"; exit 0; fi",
      "if [ \"$1\" = \"login\" ] && [ \"$2\" = \"status\" ]; then echo \"Not logged in\" >&2; exit 1; fi",
      "echo \"job must not start\" >&2",
      "exit 9",
      "",
    ].join("\n"),
  );
  const server = await startServer({ CODEX_BIN: signedOutCodex });
  try {
    const harnessResponse = await fetch(`${server.baseUrl}/v1/harness`);
    assert.equal(harnessResponse.status, 200);
    const codex = (await harnessResponse.json()).harnesses.find((entry) => entry.provider === "codex");
    assert.equal(codex.loggedIn, false);

    const create = await fetch(`${server.baseUrl}/v1/codex/jobs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ workspaceId: "scratch", provider: "codex", prompt: "Hello" }),
    });
    assert.equal(create.status, 503);
    assert.match((await create.json()).error, /Codex is not connected.*relay sync-auth/);

    const jobs = await (await fetch(`${server.baseUrl}/v1/codex/jobs`)).json();
    assert.deepEqual(jobs.jobs, []);
  } finally {
    await server.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("login op: captures verification URL + user code, confirms on completion", async () => {
  const server = await startServer();
  try {
    const start = await fetch(`${server.baseUrl}/v1/harness/claude/login`, { method: "POST" });
    assert.equal(start.status, 202);
    const { op } = await start.json();
    assert.equal(op.provider, "claude");
    assert.equal(op.action, "login");

    // The op surfaces the provider's public device-code artifacts.
    const waiting = await pollOp(server, op.id, (o) => o.status === "waiting_for_user");
    assert.equal(waiting.verificationUrl, "https://provider.example/device");
    assert.equal(waiting.userCode, "WXYZ-2345");
    assert.ok(waiting.expiresAt);
    assert.match(waiting.logTail, /enter code/);

    // A second login for the same provider while one is active → 409.
    const dup = await fetch(`${server.baseUrl}/v1/harness/claude/login`, { method: "POST" });
    assert.equal(dup.status, 409);
    assert.match((await dup.json()).error, /already running/);

    // User completes the flow (the fake CLI exits 0 once confirmed).
    fs.writeFileSync(path.join(server.homeDir, "login-confirmed"), "yes");
    const done = await pollOp(server, op.id, (o) => o.status === "succeeded");
    assert.equal(done.error, null);
    assert.ok(done.finishedAt);

    // Ops list includes it.
    const list = await fetch(`${server.baseUrl}/v1/harness/ops`);
    const { ops } = await list.json();
    assert.ok(ops.some((entry) => entry.id === op.id));
  } finally {
    await server.stop();
  }
});

test("smoke op: succeeds with output, updates lastSmoke; unknown provider is 400", async () => {
  const server = await startServer();
  try {
    const start = await fetch(`${server.baseUrl}/v1/harness/codex/smoke`, { method: "POST" });
    assert.equal(start.status, 202);
    const { op } = await start.json();
    const done = await pollOp(server, op.id, (o) => ["succeeded", "failed", "expired"].includes(o.status));
    assert.equal(done.status, "succeeded");
    assert.match(done.logTail, /OK/);

    const harness = await (await fetch(`${server.baseUrl}/v1/harness`)).json();
    const codex = harness.harnesses.find((entry) => entry.provider === "codex");
    assert.equal(codex.lastSmoke.status, "succeeded");
    assert.equal(codex.lastSmoke.opId, op.id);

    const bad = await fetch(`${server.baseUrl}/v1/harness/gemini/smoke`, { method: "POST" });
    assert.equal(bad.status, 400);
    assert.match((await bad.json()).error, /provider must be codex, claude, cursor, or kimi/);

    // Smoke against a missing binary fails but doesn't wedge the op.
    const missing = await fetch(`${server.baseUrl}/v1/harness/cursor/smoke`, { method: "POST" });
    assert.equal(missing.status, 202);
    const missingOp = (await missing.json()).op;
    const failed = await pollOp(server, missingOp.id, (o) => ["failed", "expired"].includes(o.status));
    assert.equal(failed.status, "failed");
  } finally {
    await server.stop();
  }
});

// --------------------------------------------------------------------------
// logTail redaction
// --------------------------------------------------------------------------

const FAKE_SK = "sk-abcdef0123456789ABCDEFxyz";
const FAKE_PEM_BODY = "MIIBOgIBAAJBAKfakefakefakefakefakefakekeyMATERIAL0123456789+/==";
const FAKE_BEARER = "eyJhbGciOiJIUzI1NiJ9.ZmFrZXBheWxvYWQ.c2lnbmF0dXJl";

function writeFakeCli(dir, name, body) {
  const file = path.join(dir, name);
  fs.writeFileSync(file, body, { mode: 0o755 });
  return file;
}

test("redactSecrets scrubs known credential shapes and leaves device-code artifacts intact", async () => {
  // config.mjs (a transitive import) provisions its data dir at load time —
  // point it at a temp dir so an in-process import is side-effect free.
  const unitDir = fs.mkdtempSync(path.join(os.tmpdir(), "relayd-harness-unit-"));
  process.env.CODEX_DATA_DIR = path.join(unitDir, "data");
  process.env.CODEX_WORKSPACE_BROWSE_ROOT = unitDir;
  process.env.CODEX_WORKSPACES = JSON.stringify([{ id: "scratch", name: "Scratch", path: path.join(unitDir, "scratch") }]);
  const { redactSecrets } = await import("../src/harness.mjs");

  const cases = [
    `key=${FAKE_SK}`,
    "token=ghp_abcdefghijklmnopqrstuvwxyz0123",
    "token=gho_abcdefghijklmnopqrstuvwxyz0123",
    "token=github_pat_11ABCDEFG0abcdefghijklmnop",
    "token=xoxb-1234567890-abcdefghij",
    "aws=AKIAIOSFODNN7EXAMPLE",
    `Authorization: Bearer ${FAKE_BEARER}`,
    `authorization: bearer ${FAKE_BEARER}`,
    `-----BEGIN RSA PRIVATE KEY-----\n${FAKE_PEM_BODY}\n-----END RSA PRIVATE KEY-----`,
    "-----BEGIN OPENSSH PRIVATE KEY-----\nc2VjcmV0\n-----END OPENSSH PRIVATE KEY-----",
  ];
  for (const input of cases) {
    const output = redactSecrets(input);
    assert.match(output, /\[redacted\]/, `not redacted: ${input}`);
    assert.doesNotMatch(output, /sk-abcdef|ghp_abcd|gho_abcd|github_pat_11|xoxb-1234|AKIAIOSF|eyJhbGci|MIIBOgIB|c2VjcmV0/);
  }

  // Device-code UX must survive verbatim.
  const loginText = "Visit https://provider.example/device?flow=abc-123 and enter code WXYZ-2345";
  assert.equal(redactSecrets(loginText), loginText);
  assert.equal(redactSecrets(""), "");
  assert.equal(redactSecrets(null), "");
});

test("login op logTail redacts leaked tokens and PEM keys while keeping URL + code", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "relayd-harness-leaky-"));
  const leaky = writeFakeCli(
    dir,
    "leaky-claude",
    `#!/bin/sh\nif [ "$1" = "--version" ]; then echo "leaky 0.0.1"; exit 0; fi\n` +
      `echo "debug: using api key ${FAKE_SK}"\n` +
      `echo "-----BEGIN RSA PRIVATE KEY-----"\necho "${FAKE_PEM_BODY}"\necho "-----END RSA PRIVATE KEY-----"\n` +
      `echo "Visit https://provider.example/device and enter code WXYZ-2345 to continue"\n` +
      // Parks instead of exiting after 3 s: this test asserts on the
      // waiting_for_user op, and a CLI that exits on its own clock decides that
      // status by elapsed time. Killed with the daemon at the end of the test.
      `i=0\nwhile [ ! -f "$HOME/login-abort" ] && [ $i -lt ${FAKE_CLI_PARK_ITERATIONS} ]; do sleep 0.1; i=$((i+1)); done\nexit 1\n`,
  );
  const server = await startServer({ CLAUDE_BIN: leaky });
  try {
    const start = await fetch(`${server.baseUrl}/v1/harness/claude/login`, { method: "POST" });
    assert.equal(start.status, 202);
    const { op } = await start.json();
    const waiting = await pollOp(server, op.id, (o) => o.status === "waiting_for_user");

    // Device-code parsing is unaffected by redaction.
    assert.equal(waiting.verificationUrl, "https://provider.example/device");
    assert.equal(waiting.userCode, "WXYZ-2345");

    assert.match(waiting.logTail, /\[redacted\]/);
    assert.ok(!waiting.logTail.includes(FAKE_SK), "sk- token leaked into logTail");
    assert.ok(!waiting.logTail.includes(FAKE_PEM_BODY), "PEM body leaked into logTail");
    assert.ok(!waiting.logTail.includes("BEGIN RSA PRIVATE KEY"), "PEM header leaked into logTail");

    // The ops list uses the same public shape.
    const { ops } = await (await fetch(`${server.baseUrl}/v1/harness/ops`)).json();
    const listed = ops.find((entry) => entry.id === op.id);
    assert.ok(!listed.logTail.includes(FAKE_SK));
  } finally {
    await server.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("smoke op logTail redacts a bearer token", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "relayd-harness-leaky-smoke-"));
  const leaky = writeFakeCli(
    dir,
    "leaky-codex",
    `#!/bin/sh\nif [ "$1" = "--version" ]; then echo "leaky 0.0.1"; exit 0; fi\ncat > /dev/null\n` +
      `echo "request header Authorization: Bearer ${FAKE_BEARER}" >&2\necho "OK"\n`,
  );
  const server = await startServer({ CODEX_BIN: leaky });
  try {
    const start = await fetch(`${server.baseUrl}/v1/harness/codex/smoke`, { method: "POST" });
    assert.equal(start.status, 202);
    const { op } = await start.json();
    const done = await pollOp(server, op.id, (o) => ["succeeded", "failed", "expired"].includes(o.status));
    assert.equal(done.status, "succeeded");
    assert.match(done.logTail, /OK/);
    assert.match(done.logTail, /\[redacted\]/);
    assert.ok(!done.logTail.includes(FAKE_BEARER), "bearer token leaked into logTail");
  } finally {
    await server.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("unknown op id is 404", async () => {
  const server = await startServer();
  try {
    const response = await fetch(`${server.baseUrl}/v1/harness/ops/019e46a4-0000-7000-8000-00000000dead`);
    assert.equal(response.status, 404);
  } finally {
    await server.stop();
  }
});
