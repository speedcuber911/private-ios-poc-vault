// Trial-node authorize() precedence: JWT grant vs opaque device token.
// Grant verification lives inside the existing bearer branch (spec §3.3).
import assert from "node:assert/strict";
import { generateKeyPairSync, sign as cryptoSign, createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "relayd-grant-auth-"));
process.env.CODEX_DATA_DIR = path.join(tmpRoot, "data");
process.env.RELAYD_IDENTITY_DIR = path.join(tmpRoot, "identity");
process.env.CODEX_WORKSPACE_BROWSE_ROOT = path.join(tmpRoot, "ws");
fs.mkdirSync(path.join(tmpRoot, "ws", "scratch"), { recursive: true });
process.env.CODEX_WORKSPACES = JSON.stringify([
  { id: "scratch", name: "Scratch", path: path.join(tmpRoot, "ws", "scratch") },
]);
process.env.CODEX_REQUIRE_MTLS = "true";

const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const rawPublic = publicKey.export({ type: "spki", format: "der" }).subarray(-32);
process.env.RELAYD_GRANT_PUBLIC_KEY = rawPublic.toString("base64url");
process.env.RELAYD_NODE_ID = "node-a";

const deviceToken = "opaque-device-token-not-a-jwt";
const hashFile = path.join(tmpRoot, "device-token.sha256");
fs.writeFileSync(
  hashFile,
  createHash("sha256").update(deviceToken, "utf8").digest("hex"),
);
process.env.RELAYD_DEVICE_TOKEN_HASH_FILE = hashFile;

const { authorize } = await import("../src/server.mjs");

function mintGrant(claims = {}) {
  const header = Buffer.from(JSON.stringify({ alg: "EdDSA", typ: "JWT" })).toString("base64url");
  const now = Math.floor(Date.now() / 1000);
  const payload = Buffer.from(
    JSON.stringify({
      sub: "acct-1",
      node: "node-a",
      scope: ["jobs.read", "threads.read", "events.read"],
      iat: now,
      exp: now + 900,
      jti: "jti-1",
      ...claims,
    }),
  ).toString("base64url");
  const sig = cryptoSign(null, Buffer.from(`${header}.${payload}`), privateKey).toString("base64url");
  return `${header}.${payload}.${sig}`;
}

function bearer(token) {
  return { headers: { authorization: `Bearer ${token}` } };
}

test("trial node: grant JWT on jobs list is authorized; device token still works", async () => {
  const grantJwt = mintGrant();
  const grant = authorize(bearer(grantJwt), { pathname: "/v1/jobs" });
  assert.equal(grant.ok, true);
  assert.equal(grant.subject, "browser-grant");

  const device = authorize(bearer(deviceToken));
  assert.equal(device.ok, true);
  assert.equal(device.subject, "trial-device");
});

test("trial node: grant for another node is 401 with the device-token error string", async () => {
  const grantJwt = mintGrant({ node: "node-b" });
  const result = authorize(bearer(grantJwt), { pathname: "/v1/jobs" });
  assert.equal(result.ok, false);
  assert.equal(result.status, 401);
  assert.equal(result.error, "device token is not valid");
});

test("trial node: grant is rejected on POST /v1/jobs", async () => {
  const grantJwt = mintGrant();
  const result = authorize(
    { ...bearer(grantJwt), method: "POST" },
    { pathname: "/v1/jobs" },
  );
  assert.equal(result.ok, false);
  assert.equal(result.status, 401);
  assert.equal(result.error, "device token is not valid");
});

test("trial node: grant JWT is authorized on the real list/events paths", async () => {
  const grantJwt = mintGrant();
  for (const pathname of ["/v1/codex/jobs", "/v1/codex/threads", "/v1/events"]) {
    const result = authorize({ ...bearer(grantJwt), method: "GET" }, { pathname });
    assert.equal(result.ok, true, pathname);
    assert.equal(result.subject, "browser-grant", pathname);
  }
});

test("trial node: grant is rejected on fs, export, and pair", async () => {
  const grantJwt = mintGrant();
  for (const [method, pathname] of [
    ["GET", "/v1/codex/fs/list"],
    ["GET", "/v1/export.tar"],
    ["POST", "/v1/pair"],
    ["POST", "/v1/codex/jobs"],
  ]) {
    const result = authorize({ ...bearer(grantJwt), method }, { pathname });
    assert.equal(result.ok, false, `${method} ${pathname}`);
    assert.equal(result.status, 401, `${method} ${pathname}`);
    assert.equal(result.error, "device token is not valid", `${method} ${pathname}`);
  }
});
