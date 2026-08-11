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
