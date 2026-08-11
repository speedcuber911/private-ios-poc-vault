// product/cloud/test/trial-enroll.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { startTestApp, api, signIn, authed, makeNodeIdentity } from "./helpers.mjs";

const TRIAL_ENV = { E2B_API_URL: "http://cube.invalid", E2B_API_KEY: "k", TRIAL_TEMPLATE_ID: "relay-trial", TUNNEL_SUFFIX: ".tun.test" };
const PAIRING = { pairingId: "11111111-1111-4111-8111-111111111111", pairingSecret: "c2VjcmV0LXNlY3JldC1zZWNyZXQ" };

async function createTrial(t) {
  const provisioner = t.provisionerRef;
  const session = await signIn(t);
  const res = await api(t.baseUrl, "POST", "/v1/trial-nodes", { body: PAIRING, ...authed(session.sessionToken) });
  assert.equal(res.status, 201);
  return { session, enrollToken: provisioner.created.at(-1).envVars.RELAYD_ENROLL_TOKEN };
}

function fakeProvisioner() {
  const created = [];
  return { created, async createSandbox(o) { created.push(o); return { sandboxId: "sbx_1" }; }, async killSandbox() { return true; }, async pauseSandbox() { return true; } };
}

test("enroll: valid token registers the node and burns the token", async () => {
  const provisioner = fakeProvisioner();
  const t = await startTestApp({ env: TRIAL_ENV, provisioner });
  t.provisionerRef = provisioner;
  try {
    const { session, enrollToken } = await createTrial(t);
    const identity = makeNodeIdentity();
    const nodeId = "node-00112233aabbccdd";
    let res = await api(t.baseUrl, "POST", "/v1/trial-nodes/enroll", {
      body: { token: enrollToken, nodeId, pubkey: identity.pubkeyPem, version: "0.1.0" },
    });
    assert.equal(res.status, 200);
    assert.equal(res.json.ok, true);
    assert.equal(res.json.sni, `${nodeId}.tun.test`);

    // Node row exists, owned by the trial account, kind trial.
    const node = t.app.registry.getNode(nodeId);
    assert.equal(node.accountId, session.accountId);
    assert.equal(node.kind, "trial");

    // Trial is ready and visible to the account.
    res = await api(t.baseUrl, "GET", "/v1/trial-nodes/current", authed(session.sessionToken));
    assert.equal(res.json.trial.state, "ready");
    assert.equal(res.json.trial.sni, `${nodeId}.tun.test`);

    // Token is single-use.
    res = await api(t.baseUrl, "POST", "/v1/trial-nodes/enroll", {
      body: { token: enrollToken, nodeId: "node-ffffffffffffffff", pubkey: identity.pubkeyPem, version: null },
    });
    assert.equal(res.status, 401);

    // Broker hook resolves the trial node.
    res = await api(t.baseUrl, "GET", `/v1/tunnel/nodes/${nodeId}`, { headers: { authorization: "Bearer test-broker-token-0123456789abcdef" } });
    assert.equal(res.status, 200);
    assert.equal(res.json.kind, "trial");
    assert.equal(res.json.pubkey, identity.pubkeyPem);
  } finally {
    await t.close();
  }
});

test("enroll: bad token 401, bad node id 400, bad pubkey 400", async () => {
  const provisioner = fakeProvisioner();
  const t = await startTestApp({ env: TRIAL_ENV, provisioner });
  t.provisionerRef = provisioner;
  try {
    const { enrollToken } = await createTrial(t);
    const identity = makeNodeIdentity();
    let res = await api(t.baseUrl, "POST", "/v1/trial-nodes/enroll", { body: { token: "wrong", nodeId: "node-00112233aabbccdd", pubkey: identity.pubkeyPem } });
    assert.equal(res.status, 401);
    res = await api(t.baseUrl, "POST", "/v1/trial-nodes/enroll", { body: { token: enrollToken, nodeId: "NODE-UPPER", pubkey: identity.pubkeyPem } });
    assert.equal(res.status, 400);
    assert.equal(res.json.error, "invalid_node_id");
    res = await api(t.baseUrl, "POST", "/v1/trial-nodes/enroll", { body: { token: enrollToken, nodeId: "node-00112233aabbccdd", pubkey: "not-a-key" } });
    assert.equal(res.status, 400);
    assert.equal(res.json.error, "invalid_pubkey");
  } finally {
    await t.close();
  }
});
