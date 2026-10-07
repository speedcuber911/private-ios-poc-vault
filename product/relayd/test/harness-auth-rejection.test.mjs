// A provider can refuse credentials its own status command still reports as
// fine: `claude auth status` reads the credentials file and says loggedIn for
// a token Anthropic has revoked. relayd learns it from the first refused run
// and must (a) mark that job "sign in again", (b) stop the harness list
// claiming the provider is connected, (c) refuse new runs with that reason,
// and (d) forget all of it the moment a new sign-in rewrites the credentials.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { freePort, waitForJson, waitForServer, watchChild } from "./helpers/wait.mjs";

const serverEntry = path.join(path.dirname(new URL(import.meta.url).pathname), "..", "src", "index.mjs");

const REVOKED = "Failed to authenticate. API Error: 401 OAuth access token has been revoked.";

// Claude Code with a revoked token, as the stream runner sees it: status says
// signed in; every run ends in an error result naming the 401.
const REVOKED_CLAUDE = [
  "#!/bin/sh",
  'if [ "$1" = "--version" ]; then echo "fake-claude 2.1.226"; exit 0; fi',
  'if [ "$1" = "--help" ]; then echo "  --model <model>  --effort <level>  --permission-mode <mode>"; exit 0; fi',
  'if [ "$1" = "auth" ] && [ "$2" = "status" ]; then echo \'{"loggedIn":true,"authMethod":"claude.ai","apiProvider":"firstParty"}\'; exit 0; fi',
  "cat > /dev/null",
  `echo '{"type":"result","subtype":"success","is_error":true,"result":"${REVOKED}","session_id":"s-1"}'`,
  "exit 1",
  "",
].join("\n");

async function startServer(dir, homeDir, extraEnv = {}) {
  const workspaceDir = path.join(dir, "scratch");
  fs.mkdirSync(workspaceDir, { recursive: true });
  const fakeClaude = path.join(dir, "fake-claude");
  fs.writeFileSync(fakeClaude, REVOKED_CLAUDE, { mode: 0o755 });
  const fakeCodex = path.join(dir, "fake-codex");
  fs.writeFileSync(fakeCodex, '#!/bin/sh\nif [ "$1" = "--version" ]; then echo "fake-codex 9.9.9"; exit 0; fi\nexit 0\n', { mode: 0o755 });

  const port = await freePort();
  const child = spawn(process.execPath, [serverEntry], {
    env: {
      ...process.env,
      CODEX_API_HOST: "127.0.0.1",
      RELAYD_DIRECT_TLS: "false",
      CODEX_API_PORT: String(port),
      CODEX_REQUIRE_MTLS: "false",
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
  const watch = watchChild(child, "relayd(auth-rejection)");
  const baseUrl = `http://127.0.0.1:${port}`;
  await waitForServer(baseUrl, { exited: watch.exited, output: watch.output });
  return {
    baseUrl,
    describe: watch.describe,
    async stop() {
      if (child.exitCode !== null) return;
      child.kill("SIGTERM");
      await new Promise((resolve) => child.once("exit", resolve));
    },
  };
}

async function claudeHarness(server) {
  const { harnesses } = await (await fetch(`${server.baseUrl}/v1/harness`)).json();
  return harnesses.find((entry) => entry.provider === "claude");
}

function createClaudeJob(server) {
  return fetch(`${server.baseUrl}/v1/codex/jobs`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ workspaceId: "scratch", provider: "claude", prompt: "Take a pull on main" }),
  });
}

test("a revoked Claude sign-in flags the job, flips the harness, blocks runs, and clears on a new sign-in", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "relayd-auth-rejection-"));
  const homeDir = path.join(dir, "home");
  const credentials = path.join(homeDir, ".claude", ".credentials.json");
  fs.mkdirSync(path.dirname(credentials), { recursive: true });
  fs.writeFileSync(credentials, '{"claudeAiOauth":{"accessToken":"revoked"}}');
  let server = await startServer(dir, homeDir);
  try {
    // Before any run, the status command is all there is to go on.
    const before = await claudeHarness(server);
    assert.equal(before.loggedIn, true);
    assert.equal(before.authRejected, null);

    const create = await createClaudeJob(server);
    assert.equal(create.status, 202, await create.clone().text());
    const job = await create.json();
    const failed = await waitForJson(
      server,
      `/v1/codex/jobs/${job.id}`,
      (body) => body?.status === "failed",
      `job ${job.id} failure`,
    );
    assert.match(failed.error, /OAuth access token has been revoked/);
    assert.equal(failed.signInRequired, true);

    const after = await claudeHarness(server);
    assert.equal(after.loggedIn, false);
    assert.match(after.authRejected.reason, /OAuth access token has been revoked/);
    assert.ok(after.authRejected.at);

    const blocked = await createClaudeJob(server);
    assert.equal(blocked.status, 503);
    assert.match((await blocked.json()).error, /sign-in on this computer was refused.*Sign in again/);

    // relayd restarts every time the machine wakes; the rejection must outlive it.
    await server.stop();
    server = await startServer(dir, homeDir);
    assert.equal((await claudeHarness(server)).loggedIn, false);

    // A new sign-in from anywhere (phone, terminal, sync-auth) rewrites the
    // credentials file, which is all it takes to trust the status again.
    fs.writeFileSync(credentials, '{"claudeAiOauth":{"accessToken":"fresh-and-longer"}}');
    const cleared = await claudeHarness(server);
    assert.equal(cleared.loggedIn, true);
    assert.equal(cleared.authRejected, null);
  } finally {
    await server.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("authFailureReason reads the CLI's own refusal, not an agent quoting a 401", async () => {
  const unitDir = fs.mkdtempSync(path.join(os.tmpdir(), "relayd-auth-rejection-unit-"));
  process.env.CODEX_DATA_DIR = path.join(unitDir, "data");
  process.env.CODEX_WORKSPACE_BROWSE_ROOT = unitDir;
  process.env.CODEX_WORKSPACES = JSON.stringify([{ id: "scratch", name: "Scratch", path: path.join(unitDir, "scratch") }]);
  const { authFailureReason } = await import("../src/harness.mjs");

  assert.equal(authFailureReason("claude", REVOKED), REVOKED);
  assert.equal(
    authFailureReason("claude", "Failed to authenticate: OAuth session expired and could not be refreshed"),
    "Failed to authenticate: OAuth session expired and could not be refreshed",
  );
  assert.equal(
    authFailureReason("claude", "Not logged in · Please run /login"),
    "Not logged in · Please run /login",
  );
  assert.equal(
    authFailureReason("codex", "stream error: unexpected status 401 Unauthorized: token_expired"),
    "stream error: unexpected status 401 Unauthorized: token_expired",
  );
  // A long answer that mentions a 401 deep inside is the agent's prose.
  assert.equal(authFailureReason("claude", `${"I checked the deploy. ".repeat(40)}It returned API Error: 401 OAuth token has expired.`), null);
  assert.equal(authFailureReason("claude", "Claude Code ended with error_max_turns."), null);
  assert.equal(authFailureReason("kimi", REVOKED), null);
  assert.equal(authFailureReason("claude", ""), null);
});

// cursor-agent with tokens on disk that Cursor no longer accepts: status still
// says authenticated, and only its message gives it away.
const STALE_CURSOR = [
  "#!/bin/sh",
  'if [ "$1" = "--version" ]; then echo "2026.09.18-9a7762b"; exit 0; fi',
  'if [ "$1" = "status" ]; then echo \'{"status":"authenticated","isAuthenticated":true,"hasAccessToken":true,"hasRefreshToken":true,"message":"Logged in (unable to fetch user details)"}\'; exit 0; fi',
  'echo "job must not start" >&2',
  "exit 9",
  "",
].join("\n");

test("cursor-agent that cannot load its account reads as signed out, not connected", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "relayd-auth-rejection-cursor-"));
  const homeDir = path.join(dir, "home");
  fs.mkdirSync(homeDir, { recursive: true });
  const fakeCursor = path.join(dir, "stale-cursor");
  fs.writeFileSync(fakeCursor, STALE_CURSOR, { mode: 0o755 });
  const server = await startServer(dir, homeDir, { CURSOR_BIN: fakeCursor });
  try {
    const { harnesses } = await (await fetch(`${server.baseUrl}/v1/harness`)).json();
    const cursor = harnesses.find((entry) => entry.provider === "cursor");
    assert.equal(cursor.installed, true);
    assert.equal(cursor.loggedIn, false);
    assert.match(cursor.authRejected.reason, /could not load the signed-in account/);

    const create = await fetch(`${server.baseUrl}/v1/codex/jobs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ workspaceId: "scratch", provider: "cursor", prompt: "Hello" }),
    });
    assert.equal(create.status, 503);
    assert.match((await create.json()).error, /Cursor's sign-in on this computer was refused.*Sign in again/);
  } finally {
    await server.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
