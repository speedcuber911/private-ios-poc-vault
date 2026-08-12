import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const { createCloudApi, decodeJwtPayload, sessionExpiringSoon } = await import("../src/cloud.mjs");
const { readCredentials, writeCredentials } = await import("../src/creds.mjs");

function b64url(obj) {
  return Buffer.from(JSON.stringify(obj)).toString("base64url");
}

function mintJwt({ exp, sub = "acct" } = {}) {
  return `${b64url({ alg: "none" })}.${b64url({ sub, exp })}.sig`;
}

function fakeFetch(script) {
  const calls = [];
  return {
    calls,
    fetchImpl: async (url, options = {}) => {
      const pathname = new URL(url).pathname;
      calls.push({
        pathname,
        method: options.method,
        body: options.body && options.headers?.["content-type"] === "application/json"
          ? JSON.parse(options.body)
          : options.body ?? null,
        authorization: options.headers?.authorization || null,
      });
      const responder = script[pathname];
      const result = typeof responder === "function" ? responder(calls) : responder;
      return {
        status: result.status,
        json: async () => result.json,
      };
    },
  };
}

test("decodeJwtPayload reads the middle segment without verifying the signature", () => {
  const token = mintJwt({ exp: 1_700_000_000, sub: "a1" });
  assert.deepEqual(decodeJwtPayload(token), { sub: "a1", exp: 1_700_000_000 });
  assert.equal(decodeJwtPayload("not-a-jwt"), null);
});

test("proactive refresh fires when session exp is within 60 seconds", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "relay-cli-refresh-pro-"));
  const nowMs = 1_700_000_000_000;
  const sessionToken = mintJwt({ exp: Math.floor(nowMs / 1000) + 30 });
  writeCredentials({
    sessionToken,
    refreshToken: "refresh-old",
    accountId: "acct",
    nodeId: "node-1",
  }, { home });

  const cloud = fakeFetch({
    "/v1/auth/refresh": {
      status: 200,
      json: { sessionToken: mintJwt({ exp: Math.floor(nowMs / 1000) + 900 }), refreshToken: "refresh-new", accountId: "acct" },
    },
    "/v1/trial-nodes/current": { status: 200, json: { trial: { nodeId: "node-1" } } },
  });

  const api = createCloudApi({
    baseUrl: "https://cloud.test",
    sessionToken,
    refreshToken: "refresh-old",
    home,
    fetchImpl: cloud.fetchImpl,
    now: () => nowMs,
  });
  const res = await api.currentTrial();
  assert.equal(res.status, 200);
  assert.equal(cloud.calls[0].pathname, "/v1/auth/refresh");
  assert.equal(cloud.calls[0].body.refreshToken, "refresh-old");
  assert.equal(cloud.calls[1].pathname, "/v1/trial-nodes/current");
  assert.match(cloud.calls[1].authorization, /^Bearer /);
  assert.notEqual(cloud.calls[1].authorization, `Bearer ${sessionToken}`);

  const stored = readCredentials({ home });
  assert.equal(stored.refreshToken, "refresh-new");
  assert.equal(stored.nodeId, "node-1", "rotation must not drop pinned node fields");
});

test("a 401 triggers refresh once and retries the original request exactly once", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "relay-cli-refresh-401-"));
  const nowMs = 1_700_000_000_000;
  // Far from expiry so proactive refresh does not fire — only the 401 path.
  const sessionToken = mintJwt({ exp: Math.floor(nowMs / 1000) + 900 });
  writeCredentials({ sessionToken, refreshToken: "refresh-old", accountId: "acct" }, { home });

  let trialHits = 0;
  const freshSession = mintJwt({ exp: Math.floor(nowMs / 1000) + 1800 });
  const cloud = fakeFetch({
    "/v1/auth/refresh": {
      status: 200,
      json: { sessionToken: freshSession, refreshToken: "refresh-new", accountId: "acct" },
    },
    "/v1/trial-nodes/current": () => {
      trialHits += 1;
      if (trialHits === 1) return { status: 401, json: { error: "unauthorized" } };
      return { status: 200, json: { trial: { nodeId: "node-1" } } };
    },
  });

  const api = createCloudApi({
    baseUrl: "https://cloud.test",
    sessionToken,
    refreshToken: "refresh-old",
    home,
    fetchImpl: cloud.fetchImpl,
    now: () => nowMs,
  });
  const res = await api.currentTrial();
  assert.equal(res.status, 200);
  assert.deepEqual(
    cloud.calls.map((c) => c.pathname),
    ["/v1/trial-nodes/current", "/v1/auth/refresh", "/v1/trial-nodes/current"],
  );
  assert.equal(cloud.calls[2].authorization, `Bearer ${freshSession}`);
  assert.equal(readCredentials({ home }).refreshToken, "refresh-new");
});

test("refresh failure prints a friendly hint, exits non-zero, and leaves creds in place", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "relay-cli-refresh-fail-"));
  const nowMs = 1_700_000_000_000;
  const sessionToken = mintJwt({ exp: Math.floor(nowMs / 1000) + 30 });
  writeCredentials({ sessionToken, refreshToken: "refresh-old", accountId: "acct" }, { home });

  const cloud = fakeFetch({
    "/v1/auth/refresh": { status: 401, json: { error: "invalid_refresh_token" } },
  });
  const logs = [];
  let exitCode = null;

  const api = createCloudApi({
    baseUrl: "https://cloud.test",
    sessionToken,
    refreshToken: "refresh-old",
    home,
    fetchImpl: cloud.fetchImpl,
    now: () => nowMs,
    logError: (line) => logs.push(String(line)),
    exit: (code) => { exitCode = code; throw new Error(`exit_${code}`); },
  });

  await assert.rejects(() => api.currentTrial(), /exit_1|session_expired/);
  assert.equal(exitCode, 1);
  assert.equal(logs.join("\n"), "Session expired — run `relay login`");
  assert.equal(readCredentials({ home }).refreshToken, "refresh-old", "creds must remain on disk");
  assert.ok(!logs.join("\n").includes("Error"), "no stack / Error noise on this path");
});

test("token rotation uses an atomic write (temp + rename) at mode 0600", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "relay-cli-refresh-atomic-"));
  writeCredentials({ sessionToken: "a", refreshToken: "b", accountId: "c" }, { home });
  const filePath = path.join(home, ".relay", "credentials.json");
  const mode = fs.statSync(filePath).mode & 0o777;
  assert.equal(mode, 0o600);
  // No leftover temp files from the write.
  const leftovers = fs.readdirSync(path.join(home, ".relay")).filter((name) => name.includes(".tmp"));
  assert.deepEqual(leftovers, []);
});

test("sessionExpiringSoon is true inside the 60s skew and false well before", () => {
  const nowMs = 1_000_000_000_000;
  assert.equal(sessionExpiringSoon(mintJwt({ exp: Math.floor(nowMs / 1000) + 30 }), nowMs), true);
  assert.equal(sessionExpiringSoon(mintJwt({ exp: Math.floor(nowMs / 1000) + 120 }), nowMs), false);
});
