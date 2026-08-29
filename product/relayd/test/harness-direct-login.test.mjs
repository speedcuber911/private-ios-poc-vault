// Direct login from the phone (API.md §2.5 additions): paste-back input to
// the login CLI's stdin, the localhost OAuth-callback relay, and cancel.
// Same fake-CLI pattern as harness.test.mjs; the callback tests add a real
// localhost login server (node .cjs) behind the fake codex binary, because
// that is exactly what `codex login` runs.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { freePort, waitForJson, waitForServer, watchChild } from "./helpers/wait.mjs";

const serverEntry = path.join(path.dirname(new URL(import.meta.url).pathname), "..", "src", "index.mjs");

// Hang guard on an orphaned shell, never a bet on poll speed (see
// harness.test.mjs for the full rationale).
const FAKE_CLI_PARK_ITERATIONS = 600; // 600 * 0.1s = 60s

// Distinctive credential-shaped markers. Neither may ever show up in an op's
// public logTail: relayd forwards them and must not echo them anywhere.
const FAKE_PASTE_CODE = "pasteback-9f8e7d6c5b4a#st_0011223344";
const FAKE_AUTH_CODE = "fake-authz-code-a1b2c3d4e5";

// Fake claude login with a paste-back prompt: prints the verification URL,
// then blocks reading one stdin line and records it. EOF (relayd dying takes
// the pipe with it) unblocks `read`, so no park loop is needed here.
const PASTE_LOGIN_CLAUDE = [
  "#!/bin/sh",
  'if [ "$1" = "--version" ]; then echo "fake-claude 1.2.3"; exit 0; fi',
  'if [ "$1" = "--help" ]; then echo "  --model <model>"; exit 0; fi',
  'if [ "$1" = "auth" ] && [ "$2" = "status" ]; then echo \'{"loggedIn":false}\'; exit 0; fi',
  'if [ "$1" = "login" ]; then',
  '  echo "Visit https://provider.example/authorize?flow=paste and paste the code shown there"',
  "  read -r line || exit 1",
  '  printf %s "$line" > "$HOME/received-input"',
  "  exit 0",
  "fi",
  "exit 0",
  "",
].join("\n");

// Fake claude login that parks until killed/cancelled (harness.test.mjs shape).
const PARKED_LOGIN_CLAUDE = [
  "#!/bin/sh",
  'if [ "$1" = "--version" ]; then echo "fake-claude 1.2.3"; exit 0; fi',
  'if [ "$1" = "--help" ]; then echo "  --model <model>"; exit 0; fi',
  'if [ "$1" = "auth" ] && [ "$2" = "status" ]; then echo \'{"loggedIn":false}\'; exit 0; fi',
  'if [ "$1" = "login" ]; then',
  '  echo "Visit https://provider.example/device and enter code WXYZ-2345 to continue"',
  "  i=0",
  `  while [ ! -f "$HOME/login-confirmed" ] && [ $i -lt ${FAKE_CLI_PARK_ITERATIONS} ]; do sleep 0.1; i=$((i+1)); done`,
  '  [ -f "$HOME/login-confirmed" ] && exit 0 || exit 1',
  "fi",
  "exit 0",
  "",
].join("\n");

// The localhost login server `codex login` really runs, in miniature: binds
// the callback listener, THEN prints the browser URL (the real CLI does the
// same — the URL is only usable once the listener exists, and the test takes
// waiting_for_user as "the server is up"), serves /auth/callback (recording
// the query) with a redirect to /success, then exits 0 — success means the
// callback arrived.
const LOGIN_SERVER_CJS = `
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const port = Number(process.env.FAKE_LOGIN_PORT);
const outFile = path.join(process.env.HOME, "codex-callback");
const server = http.createServer((req, res) => {
  const url = new URL(req.url, "http://127.0.0.1:" + port);
  if (url.pathname === "/auth/callback") {
    fs.writeFileSync(outFile, url.search);
    res.writeHead(302, { location: "/success" });
    res.end();
    return;
  }
  if (url.pathname === "/success") {
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("All set");
    server.close(() => process.exit(0));
    return;
  }
  res.writeHead(404);
  res.end();
});
server.listen(port, "127.0.0.1", () => {
  console.log("Open https://auth.example/oauth/authorize?client=fake in your browser to finish signing in");
});
`;

async function startServer({ claudeScript = PARKED_LOGIN_CLAUDE, withLoginServer = false, extraEnv = {} } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "relayd-direct-login-test-"));
  const workspaceDir = path.join(dir, "scratch");
  const homeDir = path.join(dir, "home");
  fs.mkdirSync(workspaceDir, { recursive: true });
  fs.mkdirSync(homeDir, { recursive: true });

  const fakeClaude = path.join(dir, "fake-claude");
  fs.writeFileSync(fakeClaude, claudeScript, { mode: 0o755 });

  let callbackPort = null;
  let codexBody =
    "#!/bin/sh\n" +
    'if [ "$1" = "--version" ]; then echo "fake-codex 9.9.9"; exit 0; fi\n' +
    'if [ "$1" = "login" ] && [ "$2" = "status" ]; then echo "Not logged in" >&2; exit 1; fi\n' +
    'cat > /dev/null\necho "OK"\n';
  if (withLoginServer) {
    callbackPort = await freePort();
    const loginServer = path.join(dir, "fake-login-server.cjs");
    fs.writeFileSync(loginServer, LOGIN_SERVER_CJS);
    codexBody =
      "#!/bin/sh\n" +
      'if [ "$1" = "--version" ]; then echo "fake-codex 9.9.9"; exit 0; fi\n' +
      'if [ "$1" = "login" ] && [ "$2" = "status" ]; then echo "Not logged in" >&2; exit 1; fi\n' +
      `if [ "$1" = "login" ]; then exec "${process.execPath}" "${loginServer}"; fi\n` +
      'cat > /dev/null\necho "OK"\n';
  }
  const fakeCodex = path.join(dir, "fake-codex");
  fs.writeFileSync(fakeCodex, codexBody, { mode: 0o755 });

  const port = await freePort();
  const child = spawn(process.execPath, [serverEntry], {
    env: {
      ...process.env,
      CODEX_API_HOST: "127.0.0.1",
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
      ...(callbackPort
        ? {
            RELAYD_HARNESS_CALLBACK_PORTS: JSON.stringify({ codex: callbackPort }),
            FAKE_LOGIN_PORT: String(callbackPort),
          }
        : {}),
      ...extraEnv,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const watch = watchChild(child, "relayd(direct-login)");
  const baseUrl = `http://127.0.0.1:${port}`;
  await waitForServer(baseUrl, { exited: watch.exited, output: watch.output });
  return {
    baseUrl,
    homeDir,
    callbackPort,
    describe: watch.describe,
    async stop() {
      if (child.exitCode !== null) return;
      child.kill("SIGTERM");
      await new Promise((resolve) => child.once("exit", resolve));
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

async function postJson(baseUrl, pathname, body = null) {
  const response = await fetch(`${baseUrl}${pathname}`, {
    method: "POST",
    headers: body ? { "content-type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try {
    json = await response.json();
  } catch {
    json = null;
  }
  return { status: response.status, json };
}

test("login input: delivers the pasted code to the CLI's stdin and never logs it", async () => {
  const server = await startServer({ claudeScript: PASTE_LOGIN_CLAUDE });
  try {
    const start = await postJson(server.baseUrl, "/v1/harness/claude/login");
    assert.equal(start.status, 202);
    const opId = start.json.op.id;
    const waiting = await pollOp(server, opId, (o) => o.status === "waiting_for_user");
    assert.equal(waiting.verificationUrl, "https://provider.example/authorize?flow=paste");

    // Bad input first: empty text and unknown ops are rejected cleanly.
    let res = await postJson(server.baseUrl, `/v1/harness/ops/${opId}/input`, { text: "   " });
    assert.equal(res.status, 400);
    res = await postJson(server.baseUrl, "/v1/harness/ops/019e46a4-0000-7000-8000-00000000dead/input", { text: "x" });
    assert.equal(res.status, 404);

    // Whitespace is trimmed; the CLI receives exactly one line.
    res = await postJson(server.baseUrl, `/v1/harness/ops/${opId}/input`, { text: `  ${FAKE_PASTE_CODE}\n` });
    assert.equal(res.status, 200);
    assert.equal(res.json.op.id, opId);

    const done = await pollOp(server, opId, (o) => o.status === "succeeded");
    assert.equal(done.error, null);
    assert.equal(fs.readFileSync(path.join(server.homeDir, "received-input"), "utf8"), FAKE_PASTE_CODE);

    // The pasted code is a credential: relayd must not have echoed it into
    // the public log tail.
    assert.ok(!done.logTail.includes(FAKE_PASTE_CODE), "pasted code leaked into logTail");

    // The login is finished — further input is a clean conflict.
    res = await postJson(server.baseUrl, `/v1/harness/ops/${opId}/input`, { text: "again" });
    assert.equal(res.status, 409);
  } finally {
    await server.stop();
  }
});

test("login callback: relays the localhost redirect to the CLI's login server", async () => {
  const server = await startServer({ withLoginServer: true });
  try {
    const start = await postJson(server.baseUrl, "/v1/harness/codex/login");
    assert.equal(start.status, 202);
    const opId = start.json.op.id;
    const waiting = await pollOp(server, opId, (o) => o.status === "waiting_for_user");
    assert.equal(waiting.verificationUrl, "https://auth.example/oauth/authorize?client=fake");

    // Only the provider's own localhost callback shape is relayed.
    const cases = [
      `http://localhost:${server.callbackPort}/other?x=1`, // path not a login callback
      `http://evil.example:${server.callbackPort}/auth/callback?code=x`, // not localhost
      "http://localhost:1/auth/callback?code=x", // wrong port
      "not a url",
    ];
    for (const url of cases) {
      const res = await postJson(server.baseUrl, `/v1/harness/ops/${opId}/callback`, { url });
      assert.equal(res.status, 400, `expected 400 for ${url}`);
    }

    const res = await postJson(server.baseUrl, `/v1/harness/ops/${opId}/callback`, {
      url: `http://localhost:${server.callbackPort}/auth/callback?code=${FAKE_AUTH_CODE}&state=st`,
    });
    assert.equal(res.status, 200);
    // The CLI's callback → /success redirect chain was followed to its end.
    assert.equal(res.json.upstreamStatus, 200);

    const done = await pollOp(server, opId, (o) => o.status === "succeeded");
    const recorded = fs.readFileSync(path.join(server.homeDir, "codex-callback"), "utf8");
    assert.ok(recorded.includes(`code=${FAKE_AUTH_CODE}`), `callback query not delivered: ${recorded}`);

    // The authorization code went to 127.0.0.1 and nowhere else.
    assert.ok(!done.logTail.includes(FAKE_AUTH_CODE), "authorization code leaked into logTail");

    // Finished login rejects further callbacks.
    const after = await postJson(server.baseUrl, `/v1/harness/ops/${opId}/callback`, {
      url: `http://localhost:${server.callbackPort}/auth/callback?code=x`,
    });
    assert.equal(after.status, 409);
  } finally {
    await server.stop();
  }
});

test("login callback: a provider without a local login server is a clean 400", async () => {
  const server = await startServer();
  try {
    const start = await postJson(server.baseUrl, "/v1/harness/claude/login");
    assert.equal(start.status, 202);
    const opId = start.json.op.id;
    await pollOp(server, opId, (o) => o.status === "waiting_for_user");

    const res = await postJson(server.baseUrl, `/v1/harness/ops/${opId}/callback`, {
      url: "http://localhost:1455/auth/callback?code=x",
    });
    assert.equal(res.status, 400);
    assert.match(res.json.error, /does not use a local callback/);

    const cancel = await postJson(server.baseUrl, `/v1/harness/ops/${opId}/cancel`);
    assert.equal(cancel.status, 200);
  } finally {
    await server.stop();
  }
});

test("cancel: ends an active login, frees the provider slot, and is one-shot", async () => {
  const server = await startServer();
  try {
    const start = await postJson(server.baseUrl, "/v1/harness/claude/login");
    assert.equal(start.status, 202);
    const opId = start.json.op.id;
    await pollOp(server, opId, (o) => o.status === "waiting_for_user");

    const cancel = await postJson(server.baseUrl, `/v1/harness/ops/${opId}/cancel`);
    assert.equal(cancel.status, 200);
    assert.equal(cancel.json.op.status, "cancelled");
    assert.ok(cancel.json.op.finishedAt);

    const again = await postJson(server.baseUrl, `/v1/harness/ops/${opId}/cancel`);
    assert.equal(again.status, 409);

    // Input to a cancelled login is the same conflict.
    const input = await postJson(server.baseUrl, `/v1/harness/ops/${opId}/input`, { text: "late" });
    assert.equal(input.status, 409);

    // The provider slot is free again immediately.
    const restart = await postJson(server.baseUrl, "/v1/harness/claude/login");
    assert.equal(restart.status, 202);
    const cleanup = await postJson(server.baseUrl, `/v1/harness/ops/${restart.json.op.id}/cancel`);
    assert.equal(cleanup.status, 200);
  } finally {
    await server.stop();
  }
});
