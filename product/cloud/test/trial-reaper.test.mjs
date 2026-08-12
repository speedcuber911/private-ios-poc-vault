// product/cloud/test/trial-reaper.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { startTestApp, api, signIn, authed } from "./helpers.mjs";

const TRIAL_ENV = { E2B_API_URL: "http://cube.invalid", E2B_API_KEY: "k", TRIAL_TEMPLATE_ID: "relay-trial", TRIAL_TTL_SEC: "10", TRIAL_GRACE_SEC: "5", TUNNEL_SUFFIX: ".tun.test" };
const PAIRING = { pairingId: "11111111-1111-4111-8111-111111111111", pairingSecret: "c2VjcmV0LXNlY3JldC1zZWNyZXQ" };

test("reaper: expiry pauses, grace destroys, idempotent", async () => {
  const paused = [];
  const killed = [];
  const provisioner = {
    async createSandbox() { return { sandboxId: "sbx_1" }; },
    async writeSandboxFile() { return true; },
    async pauseSandbox(id) { paused.push(id); return true; },
    async killSandbox(id) { killed.push(id); return true; },
  };
  const t = await startTestApp({ env: TRIAL_ENV, provisioner });
  try {
    const s = await signIn(t);
    await api(t.baseUrl, "POST", "/v1/trial-nodes", { body: PAIRING, ...authed(s.sessionToken) });
    const trial = t.app.registry.getTrialByAccount(s.accountId);
    t.app.registry.createNode(s.accountId, { id: "node-00112233aabbccdd", kind: "trial", name: "Trial machine", pubkey: "pk", version: null });
    t.app.registry.updateTrial(trial.id, { state: "ready", nodeId: "node-00112233aabbccdd" });

    await t.app.sweepTrials();               // nothing due yet
    assert.deepEqual(paused, []);

    t.clock.t += 11_000;                     // past TTL
    await t.app.sweepTrials();
    assert.deepEqual(paused, ["sbx_1"]);
    assert.equal(t.app.registry.getTrialByAccount(s.accountId).state, "expired");
    const res = await api(t.baseUrl, "GET", "/v1/trial-nodes/current", authed(s.sessionToken));
    assert.equal(res.json.trial.state, "expired");

    await t.app.sweepTrials();               // idempotent within grace
    assert.deepEqual(paused, ["sbx_1"]);
    assert.deepEqual(killed, []);

    t.clock.t += 6_000;                      // past grace
    await t.app.sweepTrials();
    assert.deepEqual(killed, ["sbx_1"]);
    assert.equal(t.app.registry.getTrialByAccount(s.accountId).state, "destroyed");
    assert.equal(t.app.registry.getNode("node-00112233aabbccdd"), null);

    await t.app.sweepTrials();               // idempotent after destroy
    assert.deepEqual(killed, ["sbx_1"]);
  } finally {
    await t.close();
  }
});
