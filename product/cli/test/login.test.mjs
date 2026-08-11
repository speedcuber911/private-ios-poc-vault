import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const { cmdLogin } = await import("../src/commands/login.mjs");
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
