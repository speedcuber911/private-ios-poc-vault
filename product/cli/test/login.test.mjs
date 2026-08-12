import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const { cmdLogin, fingerprint } = await import("../src/commands/login.mjs");
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

const TRIAL = {
  trial: { id: "t1", state: "ready", nodeId: "node-00112233445566aa", nodeEncPubkey: "a".repeat(43) + "=", sni: "x.tun.test", createdAt: 1, expiresAt: 2 },
};

test("login polls until approval, then pins the sandbox identity", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "relay-cli-login-"));
  let tokenCalls = 0;
  const cloud = fakeCloud({
    "/v1/auth/device/start": { status: 201, json: { deviceCode: "dc", userCode: "ABCD-EFGH", verificationUri: "https://relay.test/cli-login", interval: 5, expiresIn: 900 } },
    "/v1/auth/device/token": () => {
      tokenCalls += 1;
      return tokenCalls < 3
        ? { status: 400, json: { error: "authorization_pending" } }
        : { status: 200, json: { sessionToken: "sess", refreshToken: "ref", accountId: "acct", expiresIn: 900 } };
    },
    "/v1/trial-nodes/current": { status: 200, json: TRIAL },
  });
  const opened = [];
  const lines = [];

  await cmdLogin([], {
    home, baseUrl: "https://cloud.test", fetchImpl: cloud.fetchImpl,
    openBrowser: (url) => opened.push(url), log: (line) => lines.push(line), sleep: async () => {},
  });

  assert.deepEqual(opened, ["https://relay.test/cli-login"]);
  assert.ok(lines.some((line) => line.includes("ABCD-EFGH")), "the user code is shown");
  assert.equal(tokenCalls, 3, "polling continued until approval");

  const stored = readCredentials({ home });
  assert.equal(stored.sessionToken, "sess");
  assert.equal(stored.nodeId, "node-00112233445566aa");
  assert.equal(stored.nodeEncPubkey, TRIAL.trial.nodeEncPubkey);
  assert.ok(!lines.join("\n").includes("sess"), "the session token is never printed");
  assert.ok(!lines.join("\n").includes("dc"), "the device code is never printed");
});

test("login reports plainly when the account has no sandbox yet", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "relay-cli-login-nonode-"));
  const cloud = fakeCloud({
    "/v1/auth/device/start": { status: 201, json: { deviceCode: "dc", userCode: "ABCD-EFGH", verificationUri: "https://relay.test/cli-login", interval: 1, expiresIn: 900 } },
    "/v1/auth/device/token": { status: 200, json: { sessionToken: "sess", refreshToken: "ref", accountId: "acct" } },
    "/v1/trial-nodes/current": { status: 404, json: { error: "no_trial" } },
  });
  const lines = [];

  await cmdLogin([], { home, baseUrl: "https://cloud.test", fetchImpl: cloud.fetchImpl,
    openBrowser: () => {}, log: (line) => lines.push(line), sleep: async () => {} });

  assert.equal(readCredentials({ home }).sessionToken, "sess", "the session is still saved");
  assert.equal(readCredentials({ home }).nodeId, null);
  assert.match(lines.join("\n"), /no machine yet/i);
});

test("an expired device code aborts with a clear message", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "relay-cli-login-exp-"));
  const cloud = fakeCloud({
    "/v1/auth/device/start": { status: 201, json: { deviceCode: "dc", userCode: "ABCD-EFGH", verificationUri: "u", interval: 1, expiresIn: 900 } },
    "/v1/auth/device/token": { status: 400, json: { error: "expired_token" } },
  });

  await assert.rejects(() => cmdLogin([], { home, baseUrl: "https://cloud.test", fetchImpl: cloud.fetchImpl,
    openBrowser: () => {}, log: () => {}, sleep: async () => {} }), /login_expired/);
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
    "/v1/trial-nodes/current": { status: 404, json: { error: "no_trial" } },
  });
  const sleeps = [];

  await cmdLogin([], { home, baseUrl: "https://cloud.test", fetchImpl: cloud.fetchImpl,
    openBrowser: () => {}, log: () => {}, sleep: async (ms) => { sleeps.push(ms); } });

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
      "/v1/trial-nodes/current": { status: 404, json: { error: "no_trial" } },
    });
    const sleeps = [];

    await cmdLogin([], { home, baseUrl: "https://cloud.test", fetchImpl: cloud.fetchImpl,
      openBrowser: () => {}, log: () => {}, sleep: async (ms) => { sleeps.push(ms); } });

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
    openBrowser: () => {}, log: () => {},
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
    openBrowser: () => {}, log: () => {}, sleep: async () => {} }), /login_failed/);
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
