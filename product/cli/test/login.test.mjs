import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const { cmdLogin, fingerprint, qrRenderMode } = await import("../src/commands/login.mjs");
const { readCredentials } = await import("../src/creds.mjs");

function fakeCloud(script) {
  const calls = [];
  return {
    calls,
    fetchImpl: async (url, options = {}) => {
      const pathname = new URL(url).pathname;
      calls.push({ pathname, body: options.body ? JSON.parse(options.body) : null, headers: options.headers || {} });
      const responder = script[pathname];
      const result = typeof responder === "function" ? responder(calls) : responder;
      return {
        status: result.status,
        json: async () => result.json,
      };
    },
  };
}

// Several tests below drive a login for an account with no registered machine
// — they are asserting on the QR/prompt prologue, not on the pin. That login
// now ends with a non-zero exit (a thrown no_machine), which is the behavior
// its own test asserts; here it is expected and swallowed so the assertions
// that follow still run.
async function loginIgnoringNoMachine(args, deps) {
  try {
    await cmdLogin(args, deps);
  } catch (error) {
    if (!/no_machine/.test(error?.message || "")) throw error;
  }
}

const NODE_ENC_PUBKEY = "a".repeat(43) + "=";
const NODES = {
  nodes: [
    { id: "node-00112233445566aa", kind: "byo", name: "workshop", encPubkey: NODE_ENC_PUBKEY, lastSeen: 100, createdAt: 1 },
  ],
};

test("login polls until approval, then pins the machine identity", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "relay-cli-login-"));
  let tokenCalls = 0;
  const cloud = fakeCloud({
    "/v1/auth/device/start": { status: 201, json: { deviceCode: "dc", userCode: "ABCD-EFGH", verificationUri: "https://relay.test/cli-login", verificationUriComplete: "https://relay.test/cli-login#code=ABCD-EFGH", interval: 5, expiresIn: 900 } },
    "/v1/auth/device/token": () => {
      tokenCalls += 1;
      return tokenCalls < 3
        ? { status: 400, json: { error: "authorization_pending" } }
        : { status: 200, json: { sessionToken: "sess", refreshToken: "ref", accountId: "acct", expiresIn: 900 } };
    },
    "/v1/nodes": { status: 200, json: NODES },
  });
  const lines = [];

  await cmdLogin([], {
    home, baseUrl: "https://cloud.test", fetchImpl: cloud.fetchImpl,
    log: (line) => lines.push(line), sleep: async () => {},
    stdout: { isTTY: false, columns: 80 },
  });

  assert.ok(lines.some((line) => line.includes("ABCD-EFGH")), "the user code is shown");
  assert.equal(tokenCalls, 3, "polling continued until approval");
  assert.equal(cloud.calls[0].body.machineName, os.hostname());
  assert.ok(["macos", "linux", "windows", "other"].includes(cloud.calls[0].body.platform));

  const stored = readCredentials({ home });
  assert.equal(stored.sessionToken, "sess");
  assert.equal(stored.nodeId, "node-00112233445566aa");
  assert.equal(stored.nodeEncPubkey, NODE_ENC_PUBKEY);
  assert.ok(!lines.join("\n").includes("sess"), "the session token is never printed");
  assert.ok(!lines.join("\n").includes("dc"), "the device code is never printed");
});

test("login sends machineName and normalized platform, and --no-qr skips the QR", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "relay-cli-login-qr-"));
  const cloud = fakeCloud({
    "/v1/auth/device/start": { status: 201, json: { deviceCode: "dc", userCode: "ABCD-EFGH", verificationUri: "https://relay.test/cli-login", verificationUriComplete: "https://relay.test/cli-login#code=ABCD-EFGH", interval: 1, expiresIn: 900 } },
    "/v1/auth/device/token": { status: 200, json: { sessionToken: "sess", refreshToken: "ref", accountId: "acct" } },
    "/v1/nodes": { status: 200, json: { nodes: [] } },
  });
  const lines = [];

  await loginIgnoringNoMachine(["--no-qr"], {
    home, baseUrl: "https://cloud.test", fetchImpl: cloud.fetchImpl,
    log: (line) => lines.push(line), sleep: async () => {},
    hostname: () => "dev-box.local",
    platform: "darwin",
    stdout: { isTTY: true, columns: 120 },
  });

  assert.deepEqual(cloud.calls[0].body, { machineName: "dev-box.local", platform: "macos" });
  assert.ok(!lines.some((line) => /[█▀▄]/.test(line)), "--no-qr must suppress the QR render");
  assert.ok(lines.some((line) => line.includes("ABCD-EFGH")));
});

test("Terminal.app uses the glyph-free square QR renderer while iTerm stays compact", async () => {
  assert.equal(qrRenderMode({ TERM_PROGRAM: "Apple_Terminal" }), "square");
  assert.equal(qrRenderMode({ TERM_PROGRAM: "iTerm.app" }), "compact");

  const home = fs.mkdtempSync(path.join(os.tmpdir(), "relay-cli-login-terminal-qr-"));
  const cloud = fakeCloud({
    "/v1/auth/device/start": { status: 201, json: { deviceCode: "dc", userCode: "ABCD-EFGH", verificationUri: "https://relay.test/cli-login", verificationUriComplete: "https://relay.test/cli-login#code=ABCD-EFGH", interval: 1, expiresIn: 900 } },
    "/v1/auth/device/token": { status: 200, json: { sessionToken: "sess", refreshToken: "ref", accountId: "acct" } },
    "/v1/nodes": { status: 200, json: { nodes: [] } },
  });
  const lines = [];

  await loginIgnoringNoMachine([], {
    home, baseUrl: "https://cloud.test", fetchImpl: cloud.fetchImpl,
    log: (line) => lines.push(line), sleep: async () => {},
    env: { TERM_PROGRAM: "Apple_Terminal" },
    stdout: { isTTY: true, columns: 120 },
  });

  const output = lines.join("\n");
  assert.match(output, /\x1b\[48;5;16m/);
  assert.match(output, /\x1b\[48;5;231m/);
  assert.doesNotMatch(output, /[█▀▄]/);
});

test("Terminal.app skips a square QR that would wrap in a narrow window", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "relay-cli-login-terminal-narrow-"));
  const cloud = fakeCloud({
    "/v1/auth/device/start": { status: 201, json: { deviceCode: "dc", userCode: "ABCD-EFGH", verificationUri: "https://relay.test/cli-login", verificationUriComplete: "https://relay.test/cli-login#code=ABCD-EFGH", interval: 1, expiresIn: 900 } },
    "/v1/auth/device/token": { status: 200, json: { sessionToken: "sess", refreshToken: "ref", accountId: "acct" } },
    "/v1/nodes": { status: 200, json: { nodes: [] } },
  });
  const lines = [];

  await loginIgnoringNoMachine([], {
    home, baseUrl: "https://cloud.test", fetchImpl: cloud.fetchImpl,
    log: (line) => lines.push(line), sleep: async () => {},
    env: { TERM_PROGRAM: "Apple_Terminal" },
    stdout: { isTTY: true, columns: 60 },
  });

  const output = lines.join("\n");
  assert.doesNotMatch(output, /\x1b\[48;5;(?:16|231)m/);
  assert.match(output, /Your code:\s+ABCD-EFGH/);
  assert.match(output, /Approve at:\s+https:\/\/relay\.test\/cli-login/);
});

test("login exits non-zero, but keeps the session, when the account has no machine", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "relay-cli-login-nonode-"));
  const cloud = fakeCloud({
    "/v1/auth/device/start": { status: 201, json: { deviceCode: "dc", userCode: "ABCD-EFGH", verificationUri: "https://relay.test/cli-login", interval: 1, expiresIn: 900 } },
    "/v1/auth/device/token": { status: 200, json: { sessionToken: "sess", refreshToken: "ref", accountId: "acct" } },
    "/v1/nodes": { status: 200, json: { nodes: [] } },
  });
  const lines = [];

  // bin/relay turns a throw into process.exit(1). Signing in succeeded, so the
  // session must survive; only the PIN is missing, and the user is told exactly
  // what to do about it.
  await assert.rejects(
    () => cmdLogin([], { home, baseUrl: "https://cloud.test", fetchImpl: cloud.fetchImpl,
      log: (line) => lines.push(line), sleep: async () => {} }),
    /no_machine/,
  );

  assert.equal(readCredentials({ home }).sessionToken, "sess", "the session is still saved");
  assert.equal(readCredentials({ home }).nodeId, null);
  assert.match(lines.join("\n"), /No machine is registered/i);
  assert.match(lines.join("\n"), /relayd pair/);
  assert.ok(cloud.calls.some((call) => call.pathname === "/v1/nodes"), "the pin comes from GET /v1/nodes");
});

test("with several machines, login pins the most recently seen and names it", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "relay-cli-login-multi-"));
  const cloud = fakeCloud({
    "/v1/auth/device/start": { status: 201, json: { deviceCode: "dc", userCode: "ABCD-EFGH", verificationUri: "u", interval: 1, expiresIn: 900 } },
    "/v1/auth/device/token": { status: 200, json: { sessionToken: "sess", refreshToken: "ref", accountId: "acct" } },
    "/v1/nodes": { status: 200, json: { nodes: [
      { id: "node-old", kind: "byo", name: "attic", encPubkey: null, lastSeen: 10, createdAt: 1 },
      { id: "node-new", kind: "byo", name: "workshop", encPubkey: NODE_ENC_PUBKEY, lastSeen: 900, createdAt: 2 },
      { id: "node-never", kind: "byo", name: "spare", encPubkey: null, lastSeen: null, createdAt: 3 },
    ] } },
  });
  const lines = [];

  await cmdLogin([], { home, baseUrl: "https://cloud.test", fetchImpl: cloud.fetchImpl,
    log: (line) => lines.push(line), sleep: async () => {} });

  assert.equal(readCredentials({ home }).nodeId, "node-new");
  assert.equal(readCredentials({ home }).nodeEncPubkey, NODE_ENC_PUBKEY);
  const output = lines.join("\n");
  assert.match(output, /3 machines on this account/);
  assert.match(output, /workshop \(node-new\)/, "the chosen machine is named, not silently picked");
});

test("an expired device code aborts with a clear message", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "relay-cli-login-exp-"));
  const cloud = fakeCloud({
    "/v1/auth/device/start": { status: 201, json: { deviceCode: "dc", userCode: "ABCD-EFGH", verificationUri: "u", interval: 1, expiresIn: 900 } },
    "/v1/auth/device/token": { status: 400, json: { error: "expired_token" } },
  });

  await assert.rejects(() => cmdLogin([], { home, baseUrl: "https://cloud.test", fetchImpl: cloud.fetchImpl,
    log: () => {}, sleep: async () => {} }), /login_expired/);
  assert.equal(readCredentials({ home }), null);
});

test("a hostile negative poll interval from the server is clamped, never passed straight to sleep", async () => {
  // Node clamps a negative setTimeout delay to 0, which would spin the poll
  // loop hot against the auth server. `interval: -1` is truthy so a bare
  // `interval || 5` fallback does not catch it — only a lower-bound clamp does.
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "relay-cli-login-negint-"));
  const cloud = fakeCloud({
    "/v1/auth/device/start": { status: 201, json: { deviceCode: "dc", userCode: "ABCD-EFGH", verificationUri: "u", interval: -1, expiresIn: 900 } },
    "/v1/auth/device/token": { status: 200, json: { sessionToken: "sess", refreshToken: "ref", accountId: "acct" } },
    "/v1/nodes": { status: 200, json: { nodes: [] } },
  });
  const sleeps = [];

  await loginIgnoringNoMachine([], { home, baseUrl: "https://cloud.test", fetchImpl: cloud.fetchImpl,
    log: () => {}, sleep: async (ms) => { sleeps.push(ms); } });

  assert.ok(sleeps.length > 0, "the loop must have slept at least once");
  assert.ok(sleeps.every((ms) => ms >= 1000), `every sleep must be clamped to >= 1000ms, got ${JSON.stringify(sleeps)}`);
});

test("a huge or Infinity poll interval from the server is capped, never overflowing Node's setTimeout limit", async () => {
  // Math.max(1, ...) floors a hostile interval but does nothing to cap it.
  // Node's setTimeout silently clamps any delay above 2147483647ms (~24.8
  // days) to 1ms, which reproduces the exact unthrottled hot loop this
  // clamp was meant to prevent in the first place — just triggered by a
  // huge/Infinity value instead of a negative one. A sane upper bound must
  // be enforced before the value ever reaches sleep().
  for (const hostileInterval of [1e20, Infinity]) {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "relay-cli-login-hugeint-"));
    const cloud = fakeCloud({
      "/v1/auth/device/start": { status: 201, json: { deviceCode: "dc", userCode: "ABCD-EFGH", verificationUri: "u", interval: hostileInterval, expiresIn: 900 } },
      "/v1/auth/device/token": { status: 200, json: { sessionToken: "sess", refreshToken: "ref", accountId: "acct" } },
      "/v1/nodes": { status: 200, json: { nodes: [] } },
    });
    const sleeps = [];

    await loginIgnoringNoMachine([], { home, baseUrl: "https://cloud.test", fetchImpl: cloud.fetchImpl,
      log: () => {}, sleep: async (ms) => { sleeps.push(ms); } });

    assert.ok(sleeps.length > 0, "the loop must have slept at least once");
    assert.ok(
      sleeps.every((ms) => ms <= 300_000),
      `every sleep must be capped to a sane maximum, got ${JSON.stringify(sleeps)} for interval=${hostileInterval}`,
    );
  }
});

test("polling stops with login_expired once the server's expiresIn budget elapses, even if the server keeps saying pending", async () => {
  // A partition or server bug that keeps returning authorization_pending forever
  // must not hang `relay login` forever — the client tracks its own deadline
  // from start.json.expiresIn and gives up once it passes, regardless of what
  // the server says on the next poll.
  //
  // node:test's per-test `timeout` only marks a hung test cancelled; it does
  // not stop a still-running async loop underneath, which would keep spinning
  // (and, via fakeCloud's growing `calls` log, keep allocating) in the
  // background against an unfixed implementation. So this test bounds itself
  // with a hard sleep-call guard instead of trusting the runner's timeout.
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "relay-cli-login-budget-"));
  let clock = 0;
  let sleepCalls = 0;
  const cloud = fakeCloud({
    "/v1/auth/device/start": { status: 201, json: { deviceCode: "dc", userCode: "ABCD-EFGH", verificationUri: "u", interval: 1, expiresIn: 2 } },
    "/v1/auth/device/token": { status: 400, json: { error: "authorization_pending" } },
  });

  await assert.rejects(() => cmdLogin([], {
    home, baseUrl: "https://cloud.test", fetchImpl: cloud.fetchImpl,
    log: () => {},
    sleep: async () => {
      sleepCalls += 1;
      if (sleepCalls > 10) throw new Error("test_guard_exceeded: the poll loop did not stop at the expiresIn deadline");
      clock += 1000;
    },
    now: () => clock,
  }), /login_expired/);
  assert.equal(readCredentials({ home }), null, "a login that never completed must not leave a session behind");
});

test("a 200 response with an unparseable body fails cleanly, not with a raw TypeError", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "relay-cli-login-badbody-"));
  const cloud = fakeCloud({
    "/v1/auth/device/start": { status: 201, json: { deviceCode: "dc", userCode: "ABCD-EFGH", verificationUri: "u", interval: 1, expiresIn: 900 } },
    "/v1/auth/device/token": { status: 200, json: null },
  });

  await assert.rejects(() => cmdLogin([], { home, baseUrl: "https://cloud.test", fetchImpl: cloud.fetchImpl,
    log: () => {}, sleep: async () => {} }), /login_failed/);
});

test("fingerprint pins the SHA-256-over-decoded-bytes derivation to a literal value", () => {
  const key = "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8="; // 32 bytes: 0x00..0x1f
  assert.equal(fingerprint(key), "630dcd2966c43366");
});

test("two different base64 encodings of the same 32 bytes produce the same fingerprint", () => {
  const canonical = "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=";
  // Differs from `canonical` only in the base64 don't-care bits of the final
  // sextet ('8' -> '9'); both strings decode to the identical 32 bytes.
  const altEncoding = "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh9=";

  assert.notEqual(canonical, altEncoding, "sanity: the base64 text really is different");
  assert.ok(
    Buffer.from(canonical, "base64").equals(Buffer.from(altEncoding, "base64")),
    "sanity: both encodings decode to the same 32 bytes",
  );
  assert.equal(fingerprint(canonical), fingerprint(altEncoding));
});
