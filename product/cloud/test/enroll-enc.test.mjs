import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";

import { startTestApp, api, signIn, authed, makeNodeIdentity } from "./helpers.mjs";
import { makeFakeProvisioner } from "./trial-api.test.mjs";

const TRIAL_ENV = {
  E2B_API_URL: "http://cube.invalid", E2B_API_KEY: "k", TRIAL_TEMPLATE_ID: "relay-trial",
  TUNNEL_HOST: "broker.test", TUNNEL_PORT: "80", TUNNEL_SUFFIX: ".tun.test",
};
const PAIRING = {
  pairingId: "11111111-1111-4111-8111-111111111111",
  pairingSecret: "c2VjcmV0LXNlY3JldC1zZWNyZXQ",
};
const NODE_ID = "node-00112233445566aa";

function encPubkeyB64() {
  const { publicKey } = crypto.generateKeyPairSync("x25519");
  return publicKey.export({ type: "spki", format: "der" }).subarray(12).toString("base64");
}

async function createTrial(t) {
  const session = await signIn(t);
  const res = await api(t.baseUrl, "POST", "/v1/trial-nodes", { body: PAIRING, ...authed(session.sessionToken) });
  assert.equal(res.status, 201);
  return session;
}

test("enroll stores the node encryption key and current exposes it", async () => {
  const provisioner = makeFakeProvisioner();
  const t = await startTestApp({ env: TRIAL_ENV, provisioner });
  try {
    const session = await createTrial(t);
    const token = provisioner.created[0].envVars.RELAYD_ENROLL_TOKEN;
    const identity = makeNodeIdentity();
    const encPubkey = encPubkeyB64();

    const enroll = await api(t.baseUrl, "POST", "/v1/trial-nodes/enroll", {
      body: { token, nodeId: NODE_ID, pubkey: identity.pubkeyPem, encPubkey, version: "0.1.0" },
    });
    assert.equal(enroll.status, 200);

    const current = await api(t.baseUrl, "GET", "/v1/trial-nodes/current", authed(session.sessionToken));
    assert.equal(current.json.trial.state, "ready");
    assert.equal(current.json.trial.nodeEncPubkey, encPubkey);
    assert.equal(t.app.registry.getNode(NODE_ID).encPubkey, encPubkey);
  } finally { await t.close(); }
});

test("a malformed encryption key is rejected and no node is created", async () => {
  const provisioner = makeFakeProvisioner();
  const t = await startTestApp({ env: TRIAL_ENV, provisioner });
  try {
    await createTrial(t);
    const token = provisioner.created[0].envVars.RELAYD_ENROLL_TOKEN;
    const identity = makeNodeIdentity();

    const res = await api(t.baseUrl, "POST", "/v1/trial-nodes/enroll", {
      body: { token, nodeId: NODE_ID, pubkey: identity.pubkeyPem, encPubkey: "not-32-bytes" },
    });

    assert.equal(res.status, 400);
    assert.equal(res.json.error, "invalid_enc_pubkey");
    assert.equal(t.app.registry.getNode(NODE_ID), null);
  } finally { await t.close(); }
});

test("enroll without an encryption key still succeeds and reports null", async () => {
  const provisioner = makeFakeProvisioner();
  const t = await startTestApp({ env: TRIAL_ENV, provisioner });
  try {
    const session = await createTrial(t);
    const token = provisioner.created[0].envVars.RELAYD_ENROLL_TOKEN;
    const identity = makeNodeIdentity();

    const enroll = await api(t.baseUrl, "POST", "/v1/trial-nodes/enroll", {
      body: { token, nodeId: NODE_ID, pubkey: identity.pubkeyPem },
    });
    assert.equal(enroll.status, 200);

    const current = await api(t.baseUrl, "GET", "/v1/trial-nodes/current", authed(session.sessionToken));
    assert.equal(current.json.trial.nodeEncPubkey, null);
  } finally { await t.close(); }
});

// relayd's seal.mjs (product/relayd/src/seal.mjs, sealTo()) enforces that a
// recipient X25519 key is *canonical* base64 — re-encoding the decoded bytes
// must reproduce the exact string it was given — and rejects anything that
// merely decodes to 32 bytes. Enrollment must adopt the identical rule, or a
// key that is lenient-base64-valid-but-not-canonical sails through here and
// only fails much later, as an opaque seal_bad_public_key/decrypt failure at
// handoff time. Every case below decodes to exactly 32 bytes under Node's
// permissive base64 decoder, so a length-only check (the pre-fix behavior)
// would accept all three; the canonicality rule must reject all three.
test("encPubkey must be canonical base64 — seal.mjs's exact rule, not merely 32 decodable bytes", async () => {
  const provisioner = makeFakeProvisioner();
  const t = await startTestApp({ env: TRIAL_ENV, provisioner });
  try {
    await createTrial(t);
    const token = provisioner.created[0].envVars.RELAYD_ENROLL_TOKEN;
    const identity = makeNodeIdentity();

    // All-0xFF bytes canonicalize to a string dense in '+'/'/' and padding,
    // which guarantees the base64url and whitespace/junk variants below
    // actually differ from the canonical string (not just coincidentally
    // reproduce it).
    const raw = Buffer.alloc(32, 0xff);
    const canonical = raw.toString("base64");
    const cases = {
      base64url: raw.toString("base64url"),
      embedded_whitespace: `${canonical.slice(0, 4)}\n${canonical.slice(4)}`,
      spliced_junk: `${canonical.slice(0, 4)}!${canonical.slice(4)}`,
    };

    for (const [label, malformed] of Object.entries(cases)) {
      assert.equal(
        Buffer.from(malformed, "base64").length,
        32,
        `${label} fixture must still lenient-decode to 32 bytes (otherwise this isn't testing canonicality)`,
      );
      assert.notEqual(malformed, canonical, `${label} fixture must actually differ from the canonical string`);

      const res = await api(t.baseUrl, "POST", "/v1/trial-nodes/enroll", {
        body: { token, nodeId: NODE_ID, pubkey: identity.pubkeyPem, encPubkey: malformed },
      });
      assert.equal(res.status, 400, `${label} must be rejected`);
      assert.equal(res.json.error, "invalid_enc_pubkey", label);
      assert.equal(t.app.registry.getNode(NODE_ID), null, `${label} must not create a node`);
    }

    // The canonical encoding of the exact same bytes is accepted — this is
    // not a blanket rejection of the fixture's byte content, only of its
    // non-canonical encodings.
    const ok = await api(t.baseUrl, "POST", "/v1/trial-nodes/enroll", {
      body: { token, nodeId: NODE_ID, pubkey: identity.pubkeyPem, encPubkey: canonical },
    });
    assert.equal(ok.status, 200);
    assert.equal(t.app.registry.getNode(NODE_ID).encPubkey, canonical);
  } finally { await t.close(); }
});

// Finding 5 (review): the `raw.length !== 32` half of the check was
// untested — dropping it (keeping only the canonicality half) survives the
// suite. A canonical base64 string of the WRONG length passes canonicality
// trivially (Node's own encoder produced it, so it round-trips), so only
// the length check catches it. Without it, a wrong-sized string is stored
// as an X25519 recipient key and fails opaquely at seal time — the exact
// failure mode ae0db9e was written to prevent (see the comment above this
// check in server.js).
test("encPubkey of the wrong length is rejected even when canonically encoded", async () => {
  const provisioner = makeFakeProvisioner();
  const t = await startTestApp({ env: TRIAL_ENV, provisioner });
  try {
    await createTrial(t);
    const token = provisioner.created[0].envVars.RELAYD_ENROLL_TOKEN;
    const identity = makeNodeIdentity();

    for (const length of [16, 31, 33, 64]) {
      const raw = crypto.randomBytes(length);
      const canonical = raw.toString("base64");
      assert.equal(
        Buffer.from(canonical, "base64").toString("base64"), canonical,
        `${length}-byte fixture must be canonical (otherwise this isn't testing the length check specifically)`,
      );
      const res = await api(t.baseUrl, "POST", "/v1/trial-nodes/enroll", {
        body: { token, nodeId: NODE_ID, pubkey: identity.pubkeyPem, encPubkey: canonical },
      });
      assert.equal(res.status, 400, `a canonical ${length}-byte encPubkey must be rejected`);
      assert.equal(res.json.error, "invalid_enc_pubkey");
      assert.equal(t.app.registry.getNode(NODE_ID), null, `a wrong-length key must not create a node (length ${length})`);
    }
  } finally { await t.close(); }
});

// A present-but-wrong-typed encPubkey must be a 400, never a silent null.
// strOrNull() previously turned anything non-string into null, so a client
// bug that sent a number/object/array/JSON-null for encPubkey would enroll
// the node successfully with no encryption key at all — permanently unable
// to receive a sealed handoff, with no error ever surfaced to explain why.
test("a non-string encPubkey is rejected with 400, not silently dropped to null", async () => {
  const provisioner = makeFakeProvisioner();
  const t = await startTestApp({ env: TRIAL_ENV, provisioner });
  try {
    await createTrial(t);
    const token = provisioner.created[0].envVars.RELAYD_ENROLL_TOKEN;
    const identity = makeNodeIdentity();

    const cases = { number: 12345, object: { a: 1 }, array: [1, 2, 3], null: null };
    for (const [label, value] of Object.entries(cases)) {
      const res = await api(t.baseUrl, "POST", "/v1/trial-nodes/enroll", {
        body: { token, nodeId: NODE_ID, pubkey: identity.pubkeyPem, encPubkey: value },
      });
      assert.equal(res.status, 400, `${label} must be rejected`);
      assert.equal(res.json.error, "invalid_enc_pubkey", label);
      assert.equal(t.app.registry.getNode(NODE_ID), null, `${label} must not create a node`);
    }
  } finally { await t.close(); }
});
