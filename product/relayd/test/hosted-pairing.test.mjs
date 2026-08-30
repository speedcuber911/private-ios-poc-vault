import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "relay-hosted-pairing-"));
process.env.CODEX_DATA_DIR = path.join(root, "data");
process.env.RELAYD_IDENTITY_DIR = path.join(root, "identity");
process.env.CODEX_WORKSPACE_BROWSE_ROOT = path.join(root, "workspaces");
process.env.CODEX_WORKSPACES = JSON.stringify([{ id: "test", name: "Test", path: path.join(root, "workspaces", "test") }]);
process.env.CODEX_REQUIRE_MTLS = "true";
process.env.RELAYD_DEVICE_TOKEN_HASH_FILE = path.join(root, "device-token.hash");

const { initIdentity, readEncPublicKeyB64, identityPaths, readNodeId } = await import("../src/identity.mjs");
const { createHostedDeviceStore, hostedDeviceStore } = await import("../src/hosted-device-store.mjs");
const { createHostedPairingWorker } = await import("../src/hosted-pairing.mjs");
const { sealTo } = await import("../src/seal.mjs");
const { authorize } = await import("../src/server.mjs");
const { runTrialPairing } = await import("../src/trialpair.mjs");
const { pairingKeys, blobTag, DEVICE_SLOT } = await import("../src/pairing.mjs");
const { store: identities } = await import("../src/store.mjs");
initIdentity();
const nodeId = readNodeId();
const key = readEncPublicKeyB64();
const hash = (s) => crypto.createHash("sha256").update(s).digest("hex");
const token = (s) => crypto.createHmac("sha256", s).update("relay-device-token-v1").digest("hex");
const auth = (t) => authorize({ headers: { authorization: `Bearer ${t}` } });

function prepared(secret) {
  return { deviceId: crypto.randomUUID(), certSerial: crypto.randomBytes(9).toString("hex").toUpperCase(),
    tokenHash: hash(token(secret)), notAfter: Date.now() + 86_400_000, p12: Buffer.from("encrypted-test-response").toString("base64"), tag: "test-mac" };
}
function request(overrides = {}) {
  const value = { v: 1, nodeId, pairingId: crypto.randomUUID(), expiresAt: Date.now() + 600_000,
    secret: crypto.randomBytes(24).toString("base64url"), ...overrides };
  return { value, wire: { pairingId: value.pairingId, expiresAt: value.expiresAt,
    sealedSecret: sealTo(key, Buffer.from(JSON.stringify(value))).toString("base64") } };
}
function localStore() {
  const dir = fs.mkdtempSync(path.join(root, "store-"));
  return createHostedDeviceStore({ hashFile: path.join(dir, "legacy.hash") });
}

test("two recovered phones retain the existing bearer and have separate revocable identities", async () => {
  const old = "existing-legacy-phone-token";
  fs.writeFileSync(process.env.RELAYD_DEVICE_TOKEN_HASH_FILE, hash(old));
  const deviceStore = hostedDeviceStore();
  let prepareCalls = 0;
  const worker = createHostedPairingWorker({ cloudUrl: "https://cloud.invalid", deviceStore,
    prepare: async ({ secret }) => { prepareCalls++; return prepared(secret); }, post: async () => {} });
  const a = request(), b = request();
  assert.equal(await worker(a.wire), true);
  assert.equal(await worker(b.wire), true);
  assert.equal(await worker(a.wire), true);
  assert.equal(prepareCalls, 2, "replay does not issue another identity");
  assert.equal(auth(old).ok, true);
  assert.equal(auth(token(a.value.secret)).ok, true);
  assert.equal(auth(token(b.value.secret)).ok, true);
  const first = deviceStore.find(hash(token(a.value.secret)));
  identities.addRevocation({ serial: first.certSerial, deviceId: first.deviceId, revokedAt: new Date().toISOString() });
  assert.equal(auth(token(a.value.secret)).status, 401);
  assert.equal(auth(token(b.value.secret)).ok, true);
  assert.equal(auth(old).ok, true);
  assert.equal(auth("unissued-token").status, 401);
});

test("failed delivery leaves old access alone and retries the exact prepared encrypted response", async () => {
  const deviceStore = localStore();
  const r = request();
  let prepares = 0, posts = 0;
  const responses = [];
  const worker = createHostedPairingWorker({ cloudUrl: "https://cloud.invalid", deviceStore,
    prepare: async ({ secret }) => { prepares++; return prepared(secret); },
    post: async ({ prepared: p }) => { responses.push(p); if (++posts === 1) throw new Error("transport failed"); } });
  try {
    await assert.rejects(worker(r.wire), /transport failed/);
    assert.equal(deviceStore.find(hash(token(r.value.secret))), null, "failed upload cannot activate access");
    assert.equal(await worker(r.wire), true);
    assert.equal(prepares, 1);
    assert.deepEqual(responses[0], responses[1]);
    assert.ok(deviceStore.find(hash(token(r.value.secret))));
  } finally { deviceStore.close(); }
});

test("decryption, node/session binding, expiry, and concurrent claim checks precede issuance", async () => {
  const deviceStore = localStore();
  let prepares = 0;
  let finish;
  const pending = new Promise((resolve) => { finish = resolve; });
  const worker = createHostedPairingWorker({ cloudUrl: "https://cloud.invalid", deviceStore,
    prepare: async ({ secret }) => { prepares++; await pending; return prepared(secret); }, post: async () => {} });
  try {
    for (const invalid of [request({ nodeId: "node-ffffffffffffffff" }).wire,
      request({ expiresAt: Date.now() - 1 }).wire,
      { ...request().wire, pairingId: crypto.randomUUID() },
      { ...request().wire, sealedSecret: Buffer.from("tampered").toString("base64") }]) {
      await assert.rejects(worker(invalid), /hosted_pairing_invalid/);
    }
    assert.equal(prepares, 0);
    const r = request();
    const first = worker(r.wire);
    assert.equal(await worker(r.wire), false, "a second worker cannot issue the same request concurrently");
    finish();
    assert.equal(await first, true);
    assert.equal(prepares, 1);
  } finally { finish(); deviceStore.close(); }
});

test("expired and revoked initial tokens cannot resurrect via legacy fallback after garbage collection", () => {
  const deviceStore = hostedDeviceStore();
  for (const reason of ["expired", "revoked"]) {
    const secret = crypto.randomBytes(24).toString("base64url");
    const initial = prepared(secret);
    deviceStore.addInitial(crypto.randomUUID(), initial);
    fs.writeFileSync(process.env.RELAYD_DEVICE_TOKEN_HASH_FILE, hash(token(secret)));
    assert.equal(auth(token(secret)).ok, true);
    if (reason === "expired") {
      const db = new DatabaseSync(`${process.env.RELAYD_DEVICE_TOKEN_HASH_FILE}.devices/devices.sqlite`);
      db.prepare("UPDATE devices SET not_after=0 WHERE token_hash=?").run(initial.tokenHash);
      db.close();
    } else {
      identities.addRevocation({ serial: initial.certSerial, deviceId: initial.deviceId, revokedAt: new Date().toISOString() });
      deviceStore.reclaimRevoked((serial) => serial === initial.certSerial);
    }
    assert.equal(auth(token(secret)).status, 401);
    const id = crypto.randomUUID();
    const claim = deviceStore.claim(id, "fixture", Date.now() + 600_000);
    deviceStore.release(id, claim.owner);
    assert.equal(deviceStore.find(initial.tokenHash), null, "expired/revoked identity was collected");
    assert.equal(deviceStore.wasRegisteredLegacy(initial.tokenHash), true, "denial tombstone survives");
    assert.equal(auth(token(secret)).status, 401, `${reason} bearer is still denied after collection`);
  }
});

test("revoking devices reclaims the bounded active-device slots without dropping legacy tombstones", () => {
  const deviceStore = localStore();
  const records = [];
  try {
    for (let i = 0; i < 32; i++) {
      const p = prepared(`fixture-secret-${i}`); records.push(p);
      deviceStore.addInitial(crypto.randomUUID(), p);
    }
    assert.throws(() => deviceStore.claim(crypto.randomUUID(), "new", Date.now() + 60_000), /hosted_device_limit/);
    deviceStore.reclaimRevoked((serial) => serial === records[0].certSerial);
    assert.ok(deviceStore.claim(crypto.randomUUID(), "new", Date.now() + 60_000));
    assert.equal(deviceStore.wasRegisteredLegacy(records[0].tokenHash), true);
  } finally { deviceStore.close(); }
});

test("credential database refuses symlink destinations and keeps restrictive permissions", () => {
  const dir = fs.mkdtempSync(path.join(root, "symlink-"));
  const hashFile = path.join(dir, "hash");
  fs.symlinkSync(root, `${hashFile}.devices`);
  assert.throws(() => createHostedDeviceStore({ hashFile }), /hosted_device_store_unsafe/);
  const permissions = fs.statSync(`${process.env.RELAYD_DEVICE_TOKEN_HASH_FILE}.devices/devices.sqlite`).mode & 0o777;
  assert.equal(permissions, 0o600);
});

test("initial pairing retries a lost upload acknowledgement with the same leaf identity and response", async () => {
  const secret = crypto.randomBytes(24).toString("base64url");
  const keys = pairingKeys(secret);
  const deviceBlob = Buffer.from(JSON.stringify({ deviceName: "Initial test phone", platform: "ios" }));
  const pairingId = crypto.randomUUID();
  const responses = [];
  let fetches = 0;
  const options = { cloudUrl: "https://cloud.invalid", pairingId, secret,
    fetchImpl: async (_url, init) => {
      fetches++;
      if (!init.method || init.method === "GET") return new Response(deviceBlob, {
        status: 200, headers: { "x-pairing-tag": blobTag(keys.macKey, DEVICE_SLOT, deviceBlob) },
      });
      responses.push(Buffer.from(init.body));
      if (responses.length === 1) throw new Error("lost upload acknowledgement");
      return new Response(null, { status: 204 });
    } };
  await assert.rejects(runTrialPairing(options), /lost upload acknowledgement/);
  const issued = await runTrialPairing(options);
  assert.deepEqual(responses[0], responses[1], "retry cannot deliver a different leaf certificate");
  const bound = hostedDeviceStore().find(hash(token(secret)));
  assert.equal(bound.certSerial, issued.certSerial);
  assert.equal(auth(token(secret)).ok, true);
  identities.addRevocation({ serial: issued.certSerial, deviceId: issued.deviceId, revokedAt: new Date().toISOString() });
  assert.equal(auth(token(secret)).status, 401);
  const beforeRetry = fetches;
  assert.deepEqual(await runTrialPairing(options), issued);
  assert.equal(fetches, beforeRetry, "completed initial setup is a no-op, not credential rotation");
  assert.equal(auth(token(secret)).status, 401);
});
