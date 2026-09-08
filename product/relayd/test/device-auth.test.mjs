// authorize() with QR pairing and client certificates on ONE node.
//
// Token mode used to be switched on by the mere presence of the legacy
// RELAYD_DEVICE_TOKEN_HASH_FILE, which meant adopting QR pairing would have
// turned certificate auth off for an existing install (and vice versa). The
// branch is now chosen by what the request actually carries, so a QR-paired
// phone (bearer) and a desktop with a client certificate both work against the
// same daemon.
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "relayd-device-auth-"));
process.env.CODEX_DATA_DIR = path.join(tmpRoot, "data");
process.env.RELAYD_IDENTITY_DIR = path.join(tmpRoot, "identity");
process.env.CODEX_WORKSPACE_BROWSE_ROOT = path.join(tmpRoot, "ws");
fs.mkdirSync(path.join(tmpRoot, "ws", "scratch"), { recursive: true });
process.env.CODEX_WORKSPACES = JSON.stringify([
  { id: "scratch", name: "Scratch", path: path.join(tmpRoot, "ws", "scratch") },
]);
process.env.CODEX_REQUIRE_MTLS = "true";
process.env.CODEX_ALLOWED_CERT_SUBJECTS = "CN=desktop-device";
// No RELAYD_DEVICE_TOKEN_HASH_FILE: this is a BYO node, not a legacy managed one.
delete process.env.RELAYD_DEVICE_TOKEN_HASH_FILE;

const { authorize } = await import("../src/server.mjs");
const { deviceTokenStore } = await import("../src/device-tokens.mjs");

const PAIRED_TOKEN = "a".repeat(64);
const deviceId = crypto.randomUUID();
deviceTokenStore().registerDevice({
  pairingId: crypto.randomUUID(),
  deviceId,
  tokenHash: crypto.createHash("sha256").update(PAIRED_TOKEN, "utf8").digest("hex"),
  certSerial: "0ABCDEF123",
  notAfter: Date.now() + 86_400_000,
});

const bearer = (token) => ({ headers: { authorization: `Bearer ${token}` } });
const clientCert = (subject) => ({
  headers: { "x-ssl-client-verify": "SUCCESS", "x-ssl-client-s-dn": subject },
});

test("a bearer matching a paired device is authorized as that device", () => {
  const result = authorize(bearer(PAIRED_TOKEN), { pathname: "/v1/codex/jobs" });
  assert.equal(result.ok, true);
  assert.equal(result.deviceId, deviceId);
  assert.equal(result.subject, `device:${deviceId}`);
});

test("an unknown bearer is refused, and says nothing about why", () => {
  const result = authorize(bearer("b".repeat(64)), { pathname: "/v1/codex/jobs" });
  assert.equal(result.ok, false);
  assert.equal(result.status, 401);
  assert.equal(result.error, "device token is not valid");
});

test("mTLS still works on the same node when no bearer is sent", () => {
  const allowed = authorize(clientCert("CN=desktop-device"), { pathname: "/v1/codex/jobs" });
  assert.equal(allowed.ok, true);
  assert.equal(allowed.subject, "CN=desktop-device");

  const stranger = authorize(clientCert("CN=someone-else"), { pathname: "/v1/codex/jobs" });
  assert.equal(stranger.ok, false);
  assert.equal(stranger.status, 403);

  const naked = authorize({ headers: {} }, { pathname: "/v1/codex/jobs" });
  assert.equal(naked.ok, false);
  assert.equal(naked.status, 401);
  assert.equal(naked.error, "client certificate is required");
});

test("a revoked device certificate kills its bearer token too", () => {
  const revokedId = crypto.randomUUID();
  const token = "c".repeat(64);
  deviceTokenStore().registerDevice({
    pairingId: crypto.randomUUID(),
    deviceId: revokedId,
    tokenHash: crypto.createHash("sha256").update(token, "utf8").digest("hex"),
    certSerial: "0FEDCBA987",
    notAfter: Date.now() + 86_400_000,
  });
  assert.equal(authorize(bearer(token), { pathname: "/v1/codex/jobs" }).ok, true);

  // identity.mjs owns the CRL; the store mirrors it on demand.
  deviceTokenStore().reclaimRevoked((serial) => serial === "0FEDCBA987");
  const result = authorize(bearer(token), { pathname: "/v1/codex/jobs" });
  assert.equal(result.ok, false);
  assert.equal(result.status, 401);

  // The device that was NOT revoked is untouched — one phone signing out must
  // never sign another one out.
  assert.equal(authorize(bearer(PAIRED_TOKEN), { pathname: "/v1/codex/jobs" }).ok, true);
});

test("a bearer that once belonged to a device can never fall back to the legacy hash", () => {
  // The tombstone: after a per-device row is gone, its token must not become
  // acceptable again just because a legacy single-hash file happens to match.
  const store = deviceTokenStore();
  assert.equal(
    store.wasRegisteredLegacy(crypto.createHash("sha256").update(PAIRED_TOKEN, "utf8").digest("hex")),
    true,
  );
  assert.equal(store.wasRegisteredLegacy("0".repeat(64)), false);
});
