import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { startTestApp, signIn, api, authed, makeNodeIdentity } from "./helpers.mjs";
import { nodeRequestSigningInput } from "../src/nodeauth.js";
import { generateEncKeyPair, sealTo } from "../../relayd/src/seal.mjs";

async function fixture() {
  const t = await startTestApp();
  const account = await signIn(t);
  const other = await signIn(t, { sub: "other", email: "other@example.com" });
  const identity = makeNodeIdentity();
  const encryption = generateEncKeyPair();
  const nodeId = "node-0123456789abcdef";
  const node = t.app.registry.createNode(account.accountId, {
    id: nodeId, kind: "managed", pubkey: identity.pubkeyPem, encPubkey: encryption.publicKeyB64,
  });
  const trial = t.app.registry.createTrialNode({ accountId: account.accountId, enrollTokenHash: "spent", expiresAt: t.clock.t + 86_400_000 });
  t.app.registry.updateTrial(trial.id, { nodeId, sandboxId: "abc123", state: "upgraded" });
  t.app.registry.setEntitlement(account.accountId, "hosted.auto_upgrade", "1");
  function signed(method, route) {
    const ts = ++t.clock.t;
    return { headers: { "x-relay-node": nodeId, "x-relay-ts": String(ts), "x-relay-signature": crypto.sign(null,
      nodeRequestSigningInput({ method, pathWithQuery: route, ts, nodeId }), identity.privateKey).toString("base64url") } };
  }
  async function poll(capable = true) {
    const route = `/v1/node/handoffs?wait=0${capable ? "&hostedPairing=1" : ""}`;
    return api(t.baseUrl, "GET", route, signed("GET", route));
  }
  function request(owner = account.accountId, kind = "hosted-device") {
    const authToken = crypto.randomBytes(32).toString("base64url");
    const session = t.app.pairing.createSession({ accountId: owner, authToken, kind });
    assert.equal(typeof session, "object");
    const secret = crypto.randomBytes(24).toString("base64url");
    const sealedSecret = sealTo(encryption.publicKeyB64, Buffer.from(JSON.stringify({
      v: 1, nodeId, pairingId: session.pairingId, secret, expiresAt: session.expiresAt,
    }))).toString("base64");
    return { ...session, authToken, secret, sealedSecret, body: { pairingId: session.pairingId, sealedSecret } };
  }
  const submit = (r, owner = account) => api(t.baseUrl, "POST", `/v1/nodes/${nodeId}/device-pairings`, {
    ...authed(owner.sessionToken), body: r.body,
  });
  return { t, account, other, node, nodeId, trial, signed, poll, request, submit };
}

test("hosted recovery is ownership-bound, capability-gated, encrypted, idempotent and node-ready-gated", async () => {
  const f = await fixture();
  const { t } = f;
  try {
    const r = f.request();
    assert.equal((await f.submit(r)).json.error, "hosted_pairing_upgrade_required");
    assert.equal((await f.submit(r, f.other)).status, 404);
    assert.equal((await api(t.baseUrl, "POST", `/v1/nodes/${f.nodeId}/device-pairings`, { body: r.body })).status, 401);
    await f.poll();
    assert.equal((await f.submit(r)).status, 202);
    assert.equal((await f.submit(r)).status, 202);
    assert.equal((await f.submit({ body: { ...r.body, sealedSecret: sealTo(generateEncKeyPair().publicKeyB64, Buffer.from("changed")).toString("base64") } })).json.error, "pairing_conflict");
    const oldPoll = await f.poll(false);
    assert.equal(oldPoll.json.devicePairings, undefined, "old workers never consume requests");
    const delivered = await f.poll();
    assert.equal(delivered.json.devicePairings[0].sealedSecret, r.sealedSecret);
    assert.equal(JSON.stringify(t.app.db.prepare("SELECT * FROM hosted_device_pairings").all()).includes(r.secret), false);
    const nodeRoute = `/v1/pairing/sessions/${r.pairingId}/node-blob`;
    const headers = { "x-pairing-auth": r.authToken, "x-pairing-tag": Buffer.alloc(32).toString("base64") };
    assert.equal((await api(t.baseUrl, "POST", nodeRoute, { headers, raw: "encrypted-p12" })).status, 204);
    assert.equal((await api(t.baseUrl, "POST", nodeRoute, { headers, raw: "encrypted-p12" })).status, 204, "same response retry is idempotent");
    assert.equal((await api(t.baseUrl, "POST", nodeRoute, { headers, raw: "replacement" })).status, 409);
    assert.equal((await api(t.baseUrl, "GET", nodeRoute, { headers })).status, 404, "uploaded is not yet activated");
    assert.equal((await api(t.baseUrl, "GET", nodeRoute, { headers: { "x-pairing-auth": "wrong" } })).status, 401);
    const readyRoute = `/v1/node/device-pairings/${r.pairingId}/ready`;
    assert.equal((await api(t.baseUrl, "POST", readyRoute, authed(f.account.sessionToken))).status, 401);
    const readyAuth = f.signed("POST", readyRoute);
    assert.equal((await api(t.baseUrl, "POST", readyRoute, readyAuth)).status, 200);
    assert.equal((await api(t.baseUrl, "POST", readyRoute, readyAuth)).status, 401, "node request replay rejected");
    assert.equal((await api(t.baseUrl, "GET", nodeRoute, { headers })).status, 200);
    t.app.registry.closePairingSession(r.pairingId);
    assert.deepEqual((await f.poll()).json.devicePairings, []);
    t.app.runSweeps();
    assert.equal(t.app.db.prepare("SELECT sealed_secret FROM hosted_device_pairings").get().sealed_secret, "");
  } finally { await t.close(); }
});

test("recovery rejects wrong session ownership/kind, raw secrets, expired access and expired envelopes", async () => {
  const f = await fixture();
  try {
    await f.poll();
    assert.equal((await f.submit(f.request(f.other.accountId))).json.error, "pairing_unavailable");
    assert.equal((await f.submit(f.request(f.account.accountId, "pair"))).json.error, "pairing_unavailable");
    const r = f.request();
    assert.equal((await f.submit({ body: { ...r.body, secret: r.secret } })).status, 400);
    f.t.app.registry.updateTrial(f.trial.id, { state: "expired" });
    assert.equal((await f.submit(r)).status, 403);
    f.t.app.registry.updateTrial(f.trial.id, { state: "upgraded" });
    f.t.app.db.prepare("UPDATE pairing_sessions SET expires_at=? WHERE id=?").run(f.t.clock.t - 1, r.pairingId);
    assert.equal((await f.submit(r)).json.error, "pairing_unavailable");
  } finally { await f.t.close(); }
});

test("completed requests still count toward the hourly limit and node deletion cascades", async () => {
  const f = await fixture();
  try {
    await f.poll();
    for (let i = 0; i < 20; i++) {
      const r = f.request();
      assert.equal((await f.submit(r)).status, 202);
      f.t.app.registry.closePairingSession(r.pairingId);
    }
    assert.equal((await f.submit(f.request())).json.error, "too_many_device_pairings");
    f.t.app.registry.deleteNode(f.account.accountId, f.nodeId);
    assert.equal(f.t.app.db.prepare("SELECT count(*) AS n FROM hosted_device_pairings").get().n, 0);
  } finally { await f.t.close(); }
});

test("five pending requests bound a hosted node queue", async () => {
  const f = await fixture();
  try {
    await f.poll();
    for (let i = 0; i < 5; i++) assert.equal((await f.submit(f.request())).status, 202);
    // Session quota independently blocks a sixth before it can fill the queue.
    assert.equal(f.t.app.pairing.createSession({ accountId: f.account.accountId, authToken: "x".repeat(43), kind: "hosted-device" }), "too_many_sessions");
    assert.equal((await f.poll()).json.devicePairings.length, 5);
  } finally { await f.t.close(); }
});
