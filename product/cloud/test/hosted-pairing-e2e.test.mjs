import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "relay-hosted-e2e-"));
process.env.CODEX_DATA_DIR = path.join(root, "data");
process.env.RELAYD_IDENTITY_DIR = path.join(root, "identity");
process.env.CODEX_WORKSPACE_BROWSE_ROOT = path.join(root, "workspaces");
process.env.CODEX_WORKSPACES = JSON.stringify([{ id: "test", name: "Test", path: path.join(root, "workspaces", "test") }]);
process.env.CODEX_REQUIRE_MTLS = "true";
process.env.RELAYD_DEVICE_TOKEN_HASH_FILE = path.join(root, "device-token.hash");

const { startTestApp, signIn, api, authed } = await import("./helpers.mjs");
const { initIdentity, identityPaths, readEncPublicKeyB64, revokeDevice } = await import("../../relayd/src/identity.mjs");
const { createHostedPairingWorker } = await import("../../relayd/src/hosted-pairing.mjs");
const { createCloudClient } = await import("../../relayd/src/cloudclient.mjs");
const { sealTo } = await import("../../relayd/src/seal.mjs");
const { pairingKeys, blobTag, verifyBlobTag, DEVICE_SLOT, NODE_SLOT } = await import("../../relayd/src/pairing.mjs");
const { hostedDeviceStore } = await import("../../relayd/src/hosted-device-store.mjs");
const { authorize } = await import("../../relayd/src/server.mjs");

test("real encrypted cloud-node pairing activates two devices, keeps old token and revokes one independently", async () => {
  const t = await startTestApp({ provisioner: { async extendSandbox() { return true; } } });
  try {
    const account = await signIn(t);
    const identity = initIdentity();
    const paths = identityPaths();
    const publicKey = fs.readFileSync(paths.identityPubPath, "utf8");
    const encPubkey = readEncPublicKeyB64();
    t.app.registry.createNode(account.accountId, { id: identity.nodeId, kind: "managed", pubkey: publicKey, encPubkey });
    const trial = t.app.registry.createTrialNode({ accountId: account.accountId, enrollTokenHash: "spent", expiresAt: Date.now() + 86_400_000 });
    t.app.registry.updateTrial(trial.id, { state: "upgraded", nodeId: identity.nodeId, sandboxId: "abc123" });
    t.app.registry.setEntitlement(account.accountId, "hosted.auto_upgrade", "1");
    const worker = createHostedPairingWorker({ cloudUrl: t.baseUrl });
    const client = createCloudClient({ cloudUrl: t.baseUrl, onDevicePairing: worker });
    await client.pollHandoffs(0); // signed worker capability advertisement
    const legacy = "preexisting-legacy-test-device";
    fs.writeFileSync(process.env.RELAYD_DEVICE_TOKEN_HASH_FILE, crypto.createHash("sha256").update(legacy).digest("hex"));
    const auth = (token) => authorize({ headers: { authorization: `Bearer ${token}` } });
    const tokens = [];
    for (let i = 0; i < 2; i++) {
      const secret = crypto.randomBytes(24).toString("base64url");
      const keys = pairingKeys(secret);
      const session = await api(t.baseUrl, "POST", "/v1/pairing/sessions", {
        ...authed(account.sessionToken), body: { authToken: keys.authToken, kind: "hosted-device" },
      });
      assert.equal(session.status, 201);
      const { pairingId, expiresAt } = session.json;
      const base = `/v1/pairing/sessions/${pairingId}`;
      const deviceBlob = Buffer.from(JSON.stringify({ deviceName: `Fresh iPhone ${i + 1}`, platform: "ios" }));
      assert.equal((await api(t.baseUrl, "POST", `${base}/device-blob`, {
        raw: deviceBlob, headers: { "x-pairing-auth": keys.authToken, "x-pairing-tag": blobTag(keys.macKey, DEVICE_SLOT, deviceBlob) },
      })).status, 204);
      const sealedSecret = sealTo(encPubkey, Buffer.from(JSON.stringify({ v: 1, nodeId: identity.nodeId, pairingId, secret, expiresAt }))).toString("base64");
      assert.equal((await api(t.baseUrl, "POST", `/v1/nodes/${identity.nodeId}/device-pairings`, {
        ...authed(account.sessionToken), body: { pairingId, sealedSecret },
      })).status, 202);
      const bearer = crypto.createHmac("sha256", secret).update("relay-device-token-v1").digest("hex");
      assert.equal(auth(bearer).status, 401);
      await client.pollHandoffs(0); // actual OpenSSL issuance + upload + signed ready ACK
      const collected = await api(t.baseUrl, "GET", `${base}/node-blob`, { headers: { "x-pairing-auth": keys.authToken } });
      assert.equal(collected.status, 200);
      assert.equal(verifyBlobTag(keys.macKey, NODE_SLOT, collected.buf, collected.headers.get("x-pairing-tag")), true);
      assert.equal(auth(bearer).ok, true, "collectible response implies bearer is already activated");
      assert.equal(auth(legacy).ok, true);
      tokens.push(bearer);
    }
    const first = hostedDeviceStore().find(crypto.createHash("sha256").update(tokens[0]).digest("hex"));
    revokeDevice(first.deviceId);
    assert.equal(auth(tokens[0]).status, 401);
    assert.equal(auth(tokens[1]).ok, true);
    assert.equal(auth(legacy).ok, true);
    assert.equal(auth("unissued").status, 401);
    assert.equal(t.app.db.prepare("SELECT count(*) AS n FROM pairing_sessions WHERE closed_at IS NULL").get().n, 0);
  } finally { await t.close(); }
});
