// Pairing rendezvous tests — protocol v2.
//
// The cloud's job is to relay two opaque blobs and their sender-computed MAC
// tags without ever possessing the pairing secret. These tests assert exactly
// that, including the substitution attack that v1 permitted.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { startTestApp, api, authed, signIn } from "./helpers.mjs";
import { ENTITLEMENT_HOSTED_AUTO_UPGRADE } from "../src/registry.js";

// ── the peer-side derivation, implemented here from the spec ──────────────
// Deliberately a second, independent implementation: if relayd's derivation
// ever drifts from the documented one, these tests keep the contract honest.

function pairingSecret() {
  return randomBytes(24).toString("base64url");
}

function authTokenFor(secret) {
  return createHash("sha256")
    .update(Buffer.concat([Buffer.from("relay-pair-auth-v1", "utf8"), Buffer.from([0]), Buffer.from(secret, "utf8")]))
    .digest("base64url");
}

function macKeyFor(secret) {
  return createHmac("sha256", Buffer.from(secret, "utf8")).update("relay-pair-mac-v1").digest();
}

function tagFor(macKey, slotName, blob) {
  return createHmac("sha256", macKey)
    .update(Buffer.concat([Buffer.from(slotName, "utf8"), Buffer.from([0]), blob]))
    .digest("base64");
}

function tagIsValid(macKey, slotName, blob, tag) {
  const expected = Buffer.from(tagFor(macKey, slotName, blob), "base64");
  const presented = Buffer.from(String(tag || ""), "base64");
  return presented.length === expected.length && timingSafeEqual(presented, expected);
}

async function createSession(t, sessionToken, authToken) {
  return api(t.baseUrl, "POST", "/v1/pairing/sessions", {
    body: { authToken },
    ...authed(sessionToken),
  });
}

test("credential collection upgrades only operator-entitled hosted accounts", async () => {
  for (const entitled of [false, true]) {
    const extended = [];
    const t = await startTestApp({ provisioner: {
      async extendSandbox(id, timeout) { extended.push({ id, timeout }); return true; },
      async resumeSandbox() { return true; },
    } });
    try {
      const session = await signIn(t);
      const secret = pairingSecret();
      const authToken = authTokenFor(secret);
      const macKey = macKeyFor(secret);
      const created = await createSession(t, session.sessionToken, authToken);
      const { pairingId } = created.json;
      const trial = t.app.registry.createTrialNode({
        accountId: session.accountId,
        enrollTokenHash: "enroll-hash",
        expiresAt: Date.now() + 86_400_000,
      });
      const nodeId = entitled ? "node-aaaaaaaaaaaaaaaa" : "node-bbbbbbbbbbbbbbbb";
      t.app.registry.createNode(session.accountId, {
        id: nodeId,
        kind: "trial",
        name: "Trial machine",
        pubkey: "pk",
        version: null,
      });
      t.app.registry.updateTrial(trial.id, { state: "ready", nodeId, sandboxId: "sbx_pairing" });
      if (entitled) {
        t.app.registry.setEntitlement(session.accountId, ENTITLEMENT_HOSTED_AUTO_UPGRADE, "1");
      }

      const nodeBlob = randomBytes(128);
      let res = await api(t.baseUrl, "POST", `/v1/pairing/sessions/${pairingId}/node-blob`, {
        raw: nodeBlob,
        headers: {
          "x-pairing-auth": authToken,
          "x-pairing-tag": tagFor(macKey, "node-blob", nodeBlob),
        },
      });
      assert.equal(res.status, 204);
      res = await api(t.baseUrl, "GET", `/v1/pairing/sessions/${pairingId}/node-blob`, {
        headers: { "x-pairing-auth": authToken },
      });
      assert.equal(res.status, 200);

      const current = t.app.registry.getTrialByAccount(session.accountId);
      const node = t.app.registry.getNode(nodeId);
      assert.equal(current.state, entitled ? "upgraded" : "ready");
      assert.equal(node.kind, entitled ? "byo" : "trial");
      assert.equal(node.name, entitled ? "Machine" : "Trial machine");
      assert.equal(extended.length, entitled ? 1 : 0);
      if (entitled) assert.equal(extended[0].timeout, t.config.trial.paidSandboxTimeoutSec);
    } finally {
      await t.close();
    }
  }
});

test("a failed auto-upgrade still delivers credentials and retries durable activation", async () => {
  let unavailable = true;
  const t = await startTestApp({ provisioner: {
    async extendSandbox() { if (unavailable) throw new Error("platform_unavailable"); return true; },
    async resumeSandbox() { return true; },
  }, log: () => {} });
  try {
    const session = await signIn(t);
    const secret = pairingSecret();
    const authToken = authTokenFor(secret);
    const created = await createSession(t, session.sessionToken, authToken);
    const trial = t.app.registry.createTrialNode({ accountId: session.accountId, enrollTokenHash: "test-enroll", expiresAt: t.clock.t + 86_400_000 });
    const nodeId = "node-cccccccccccccccc";
    t.app.registry.createNode(session.accountId, { id: nodeId, kind: "trial", name: "Trial machine", pubkey: "pk" });
    t.app.registry.updateTrial(trial.id, { state: "ready", nodeId, sandboxId: "sbx_deferred" });
    t.app.registry.setEntitlement(session.accountId, ENTITLEMENT_HOSTED_AUTO_UPGRADE, "1");
    const blob = randomBytes(128);
    const endpoint = `/v1/pairing/sessions/${created.json.pairingId}/node-blob`;
    assert.equal((await api(t.baseUrl, "POST", endpoint, {
      raw: blob, headers: { "x-pairing-auth": authToken, "x-pairing-tag": tagFor(macKeyFor(secret), "node-blob", blob) },
    })).status, 204);
    const response = await api(t.baseUrl, "GET", endpoint, { headers: { "x-pairing-auth": authToken } });
    assert.equal(response.status, 200);
    assert.ok(response.buf.equals(blob));
    assert.equal(t.app.registry.getTrialById(trial.id).state, "ready");
    assert.equal(t.app.registry.getEntitlement(session.accountId, "hosted.activation_pending_trial"), `${trial.id}:sbx_deferred`);
    unavailable = false;
    await t.app.sweepHostedSandboxes();
    assert.equal(t.app.registry.getTrialById(trial.id).state, "upgraded");
    assert.equal(t.app.registry.getEntitlement(session.accountId, "hosted.activation_pending_trial"), "");
  } finally { await t.close(); }
});

test("rendezvous: relays opaque blobs with their tags in both directions", async () => {
  const t = await startTestApp();
  try {
    const session = await signIn(t);
    const secret = pairingSecret();
    const authToken = authTokenFor(secret);
    const macKey = macKeyFor(secret);

    const created = await createSession(t, session.sessionToken, authToken);
    assert.equal(created.status, 201);
    const { pairingId } = created.json;
    assert.ok(pairingId && created.json.expiresAt);

    // The device posts an opaque blob (a CSR, but the cloud must not care):
    // random bytes prove nothing is parsed.
    const csrBlob = randomBytes(1024);
    const csrTag = tagFor(macKey, "device-blob", csrBlob);
    let res = await api(t.baseUrl, "POST", `/v1/pairing/sessions/${pairingId}/device-blob`, {
      raw: csrBlob,
      headers: { "x-pairing-auth": authToken, "x-pairing-tag": csrTag },
    });
    assert.equal(res.status, 204);

    // The node fetches it byte-identically, with the tag it can verify.
    res = await api(t.baseUrl, "GET", `/v1/pairing/sessions/${pairingId}/device-blob`, {
      headers: { "x-pairing-auth": authToken },
    });
    assert.equal(res.status, 200);
    assert.ok(res.buf.equals(csrBlob));
    assert.equal(res.headers.get("x-pairing-tag"), csrTag);
    assert.ok(tagIsValid(macKey, "device-blob", res.buf, res.headers.get("x-pairing-tag")));

    // The node posts the issued-cert blob; the device fetches it.
    const certBlob = randomBytes(2048);
    const certTag = tagFor(macKey, "node-blob", certBlob);
    res = await api(t.baseUrl, "POST", `/v1/pairing/sessions/${pairingId}/node-blob`, {
      raw: certBlob,
      headers: { "x-pairing-auth": authToken, "x-pairing-tag": certTag },
    });
    assert.equal(res.status, 204);
    res = await api(t.baseUrl, "GET", `/v1/pairing/sessions/${pairingId}/node-blob`, {
      headers: { "x-pairing-auth": authToken },
    });
    assert.equal(res.status, 200);
    assert.ok(res.buf.equals(certBlob));
    assert.ok(tagIsValid(macKey, "node-blob", res.buf, res.headers.get("x-pairing-tag")));

    // Fetching a slot that has not been posted → 404.
    const otherSecret = pairingSecret();
    const other = await createSession(t, session.sessionToken, authTokenFor(otherSecret));
    res = await api(t.baseUrl, "GET", `/v1/pairing/sessions/${other.json.pairingId}/node-blob`, {
      headers: { "x-pairing-auth": authTokenFor(otherSecret) },
    });
    assert.equal(res.status, 404);
  } finally {
    await t.close();
  }
});

test("rendezvous: the cloud never receives or stores the plaintext pairing secret", async () => {
  const t = await startTestApp();
  try {
    const session = await signIn(t);
    const secret = pairingSecret();
    const authToken = authTokenFor(secret);
    const macKey = macKeyFor(secret);

    const created = await createSession(t, session.sessionToken, authToken);
    assert.equal(created.status, 201);
    const { pairingId } = created.json;

    // Nothing secret comes back: no `secret` field, and the response bytes
    // contain neither the secret nor the MAC key.
    const createdText = created.buf.toString("utf8");
    assert.equal(created.json.secret, undefined);
    assert.ok(!createdText.includes(secret), "session response leaked the secret");
    assert.ok(!createdText.includes(macKey.toString("base64")), "session response leaked the MAC key");
    assert.deepEqual(Object.keys(created.json).sort(), ["expiresAt", "pairingId"]);

    const blob = randomBytes(256);
    const tag = tagFor(macKey, "device-blob", blob);
    let res = await api(t.baseUrl, "POST", `/v1/pairing/sessions/${pairingId}/device-blob`, {
      raw: blob,
      headers: { "x-pairing-auth": authToken, "x-pairing-tag": tag },
    });
    assert.equal(res.status, 204);
    res = await api(t.baseUrl, "GET", `/v1/pairing/sessions/${pairingId}/device-blob`, {
      headers: { "x-pairing-auth": authToken },
    });
    assert.equal(res.status, 200);

    // Grep the stored row: the secret must appear nowhere, and neither must
    // the authToken in plaintext (only its sha256 is retained).
    const row = t.app.db
      .prepare("SELECT * FROM pairing_sessions WHERE id = ?")
      .get(pairingId);
    const rowText = JSON.stringify(row);
    assert.ok(!rowText.includes(secret), "stored row leaked the pairing secret");
    assert.ok(!rowText.includes(authToken), "stored row kept the authToken in plaintext");
    assert.ok(!rowText.includes(macKey.toString("base64")), "stored row leaked the MAC key");
    assert.equal(
      row.auth_token_hash,
      createHash("sha256").update(authToken).digest("hex"),
      "only sha256(authToken) is stored at rest",
    );
    // The pairing_sessions table has no column that could hold a secret.
    const columns = t.app.db.prepare("PRAGMA table_info(pairing_sessions)").all().map((c) => c.name);
    assert.ok(!columns.includes("secret_hash"), "v1 secret_hash column still present");
    assert.ok(!columns.some((name) => /secret|token(?!_hash)/.test(name)));
  } finally {
    await t.close();
  }
});

test("rendezvous: slots are put-once — a second write is 409, never an overwrite", async () => {
  const t = await startTestApp();
  try {
    const session = await signIn(t);
    const secret = pairingSecret();
    const authToken = authTokenFor(secret);
    const macKey = macKeyFor(secret);
    const created = await createSession(t, session.sessionToken, authToken);
    const { pairingId } = created.json;

    const honest = Buffer.from("honest device blob", "utf8");
    let res = await api(t.baseUrl, "POST", `/v1/pairing/sessions/${pairingId}/device-blob`, {
      raw: honest,
      headers: { "x-pairing-auth": authToken, "x-pairing-tag": tagFor(macKey, "device-blob", honest) },
    });
    assert.equal(res.status, 204);

    // Second write to the filled slot: rejected, and the stored bytes are
    // unchanged.
    const attacker = Buffer.from("attacker device blob", "utf8");
    res = await api(t.baseUrl, "POST", `/v1/pairing/sessions/${pairingId}/device-blob`, {
      raw: attacker,
      headers: { "x-pairing-auth": authToken, "x-pairing-tag": tagFor(macKey, "device-blob", attacker) },
    });
    assert.equal(res.status, 409);
    assert.equal(res.json.error, "slot_already_written");

    res = await api(t.baseUrl, "GET", `/v1/pairing/sessions/${pairingId}/device-blob`, {
      headers: { "x-pairing-auth": authToken },
    });
    assert.ok(res.buf.equals(honest));

    // The other slot is independent and still writable exactly once.
    const nodeBlob = Buffer.from("node blob", "utf8");
    res = await api(t.baseUrl, "POST", `/v1/pairing/sessions/${pairingId}/node-blob`, {
      raw: nodeBlob,
      headers: { "x-pairing-auth": authToken, "x-pairing-tag": tagFor(macKey, "node-blob", nodeBlob) },
    });
    assert.equal(res.status, 204);
  } finally {
    await t.close();
  }
});

test("rendezvous: session is closed and blobs deleted once both slots have been read", async () => {
  const t = await startTestApp();
  try {
    const session = await signIn(t);
    const secret = pairingSecret();
    const authToken = authTokenFor(secret);
    const macKey = macKeyFor(secret);
    const created = await createSession(t, session.sessionToken, authToken);
    const { pairingId } = created.json;

    const deviceBlob = randomBytes(64);
    const nodeBlob = randomBytes(64);
    for (const [slot, blob] of [["device-blob", deviceBlob], ["node-blob", nodeBlob]]) {
      const res = await api(t.baseUrl, "POST", `/v1/pairing/sessions/${pairingId}/${slot}`, {
        raw: blob,
        headers: { "x-pairing-auth": authToken, "x-pairing-tag": tagFor(macKey, slot, blob) },
      });
      assert.equal(res.status, 204);
    }

    // First read: still open.
    let res = await api(t.baseUrl, "GET", `/v1/pairing/sessions/${pairingId}/device-blob`, {
      headers: { "x-pairing-auth": authToken },
    });
    assert.equal(res.status, 200);
    assert.equal(t.app.registry.getPairingSession(pairingId).closedAt, null);

    // Second read completes the exchange → session closed, bytes gone.
    res = await api(t.baseUrl, "GET", `/v1/pairing/sessions/${pairingId}/node-blob`, {
      headers: { "x-pairing-auth": authToken },
    });
    assert.equal(res.status, 200);
    assert.ok(res.buf.equals(nodeBlob));

    const closed = t.app.registry.getPairingSession(pairingId);
    assert.notEqual(closed.closedAt, null);
    assert.equal(closed.deviceBlob, null);
    assert.equal(closed.nodeBlob, null);
    assert.equal(closed.deviceTag, null);
    assert.equal(closed.nodeTag, null);

    // A closed session is not writable or readable for the rest of the TTL.
    res = await api(t.baseUrl, "GET", `/v1/pairing/sessions/${pairingId}/node-blob`, {
      headers: { "x-pairing-auth": authToken },
    });
    assert.equal(res.status, 401);
    const late = randomBytes(32);
    res = await api(t.baseUrl, "POST", `/v1/pairing/sessions/${pairingId}/node-blob`, {
      raw: late,
      headers: { "x-pairing-auth": authToken, "x-pairing-tag": tagFor(macKey, "node-blob", late) },
    });
    assert.equal(res.status, 401);
  } finally {
    await t.close();
  }
});

test("substitution attack: a compromised control plane cannot forge a tag for its own blob", async () => {
  const t = await startTestApp();
  try {
    const session = await signIn(t);
    const secret = pairingSecret();
    const authToken = authTokenFor(secret);
    const macKey = macKeyFor(secret);
    const created = await createSession(t, session.sessionToken, authToken);
    const { pairingId } = created.json;

    // 1. Honest exchange: the device posts its real CSR blob.
    const honestCsr = Buffer.from("-----BEGIN CERTIFICATE REQUEST-----honest", "utf8");
    const honestTag = tagFor(macKey, "device-blob", honestCsr);
    let res = await api(t.baseUrl, "POST", `/v1/pairing/sessions/${pairingId}/device-blob`, {
      raw: honestCsr,
      headers: { "x-pairing-auth": authToken, "x-pairing-tag": honestTag },
    });
    assert.equal(res.status, 204);

    // 2. The control plane is compromised. Put-once already denies it the API
    //    route, so it reaches straight past its own API into the database —
    //    the strongest form of the attack.
    const attackerCsr = Buffer.from("-----BEGIN CERTIFICATE REQUEST-----attacker", "utf8");
    t.app.db
      .prepare("UPDATE pairing_sessions SET device_blob = ? WHERE id = ?")
      .run(attackerCsr.toString("base64"), pairingId);

    // 3. The node fetches the slot and verifies the tag it was given.
    res = await api(t.baseUrl, "GET", `/v1/pairing/sessions/${pairingId}/device-blob`, {
      headers: { "x-pairing-auth": authToken },
    });
    assert.equal(res.status, 200);
    assert.ok(res.buf.equals(attackerCsr), "the cloud did serve the substituted bytes");
    assert.equal(
      tagIsValid(macKey, "device-blob", res.buf, res.headers.get("x-pairing-tag")),
      false,
      "substituted blob must fail the peer's MAC check",
    );

    // 4. The cloud cannot repair the tag either: forging one needs macKey,
    //    which is derived from a secret the cloud was never given.
    const forged = createHmac("sha256", Buffer.from(authToken, "utf8"))
      .update(Buffer.concat([Buffer.from("device-blob", "utf8"), Buffer.from([0]), attackerCsr]))
      .digest("base64");
    assert.equal(tagIsValid(macKey, "device-blob", attackerCsr, forged), false);
  } finally {
    await t.close();
  }
});

test("rendezvous: creation requires auth + an authToken; bad auth and oversize blobs rejected", async () => {
  const t = await startTestApp();
  try {
    // Creation requires a session.
    let res = await api(t.baseUrl, "POST", "/v1/pairing/sessions", { body: {} });
    assert.equal(res.status, 401);

    const session = await signIn(t);

    // …and an authToken. The cloud will not invent one.
    res = await createSession(t, session.sessionToken, undefined);
    assert.equal(res.status, 400);
    assert.equal(res.json.error, "auth_token_required");
    res = await createSession(t, session.sessionToken, "short");
    assert.equal(res.status, 400);

    const secret = pairingSecret();
    const authToken = authTokenFor(secret);
    const macKey = macKeyFor(secret);
    const created = await createSession(t, session.sessionToken, authToken);
    const { pairingId } = created.json;

    // Wrong authToken → 401 for both put and get.
    const blob = randomBytes(64);
    const tag = tagFor(macKey, "node-blob", blob);
    const wrong = authTokenFor(pairingSecret());
    res = await api(t.baseUrl, "POST", `/v1/pairing/sessions/${pairingId}/node-blob`, {
      raw: blob,
      headers: { "x-pairing-auth": wrong, "x-pairing-tag": tag },
    });
    assert.equal(res.status, 401);
    res = await api(t.baseUrl, "GET", `/v1/pairing/sessions/${pairingId}/node-blob`, {
      headers: { "x-pairing-auth": wrong },
    });
    assert.equal(res.status, 401);

    // Unknown session id → 401 (indistinguishable from a bad authToken).
    res = await api(t.baseUrl, "GET", "/v1/pairing/sessions/nonexistent/node-blob", {
      headers: { "x-pairing-auth": authToken },
    });
    assert.equal(res.status, 401);

    // A missing or malformed tag is refused before anything is stored.
    res = await api(t.baseUrl, "POST", `/v1/pairing/sessions/${pairingId}/node-blob`, {
      raw: blob,
      headers: { "x-pairing-auth": authToken },
    });
    assert.equal(res.status, 400);
    assert.equal(res.json.error, "invalid_blob");
    assert.equal(t.app.registry.getPairingSession(pairingId).nodeBlob, null);

    // Oversized blob → 413 (bounded endpoint).
    const huge = randomBytes(t.config.pairingBlobMaxBytes + 1);
    res = await api(t.baseUrl, "POST", `/v1/pairing/sessions/${pairingId}/node-blob`, {
      raw: huge,
      headers: { "x-pairing-auth": authToken, "x-pairing-tag": tagFor(macKey, "node-blob", huge) },
    });
    assert.equal(res.status, 413);
  } finally {
    await t.close();
  }
});

test("rendezvous: per-account session cap bounds how many rows one caller can pin", async () => {
  const t = await startTestApp();
  try {
    const session = await signIn(t);
    const cap = t.app.pairing.maxPerAccount;
    assert.ok(cap > 0 && cap < 100);

    for (let i = 0; i < cap; i += 1) {
      const res = await createSession(t, session.sessionToken, authTokenFor(pairingSecret()));
      assert.equal(res.status, 201, `session ${i} should be allowed`);
    }
    const overflow = await createSession(t, session.sessionToken, authTokenFor(pairingSecret()));
    assert.equal(overflow.status, 429);
    assert.equal(overflow.json.error, "too_many_pairing_sessions");

    // Expiry frees the budget again. (The control-plane session JWT has the
    // same TTL, so a fresh sign-in is part of the scenario.)
    t.clock.t += (t.config.pairingTtlSec + 5) * 1000;
    const renewed = await api(t.baseUrl, "POST", "/v1/auth/refresh", {
      body: { refreshToken: session.refreshToken },
    });
    assert.equal(renewed.status, 200);
    const afterExpiry = await createSession(t, renewed.json.sessionToken, authTokenFor(pairingSecret()));
    assert.equal(afterExpiry.status, 201);
  } finally {
    await t.close();
  }
});

test("rendezvous: TTL sweep expires sessions", async () => {
  const t = await startTestApp();
  try {
    const session = await signIn(t);
    const secret = pairingSecret();
    const authToken = authTokenFor(secret);
    const macKey = macKeyFor(secret);
    const created = await createSession(t, session.sessionToken, authToken);
    const { pairingId } = created.json;
    const blob = randomBytes(128);
    let res = await api(t.baseUrl, "POST", `/v1/pairing/sessions/${pairingId}/node-blob`, {
      raw: blob,
      headers: { "x-pairing-auth": authToken, "x-pairing-tag": tagFor(macKey, "node-blob", blob) },
    });
    assert.equal(res.status, 204);

    // Past TTL: even with the right authToken, the session is dead — first via
    // the expiry check, then physically removed by the sweep.
    t.clock.t += (t.config.pairingTtlSec + 5) * 1000;
    res = await api(t.baseUrl, "GET", `/v1/pairing/sessions/${pairingId}/node-blob`, {
      headers: { "x-pairing-auth": authToken },
    });
    assert.equal(res.status, 401);

    t.app.runSweeps();
    assert.equal(t.app.registry.getPairingSession(pairingId), null);
  } finally {
    await t.close();
  }
});
