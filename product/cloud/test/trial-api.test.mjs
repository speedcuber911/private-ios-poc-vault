// product/cloud/test/trial-api.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { startTestApp, api, signIn, authed } from "./helpers.mjs";

export function makeFakeProvisioner() {
  const created = [];
  return {
    created,
    failNext: false,
    async createSandbox(opts) {
      if (this.failNext) throw new Error("provisioner_http_500");
      created.push(opts);
      return { sandboxId: `sbx_${created.length}` };
    },
    // The real delivery path: Cube restores sandboxes from a template
    // snapshot, so the boot script never sees create-time envVars and is
    // configured by this file instead.
    writes: [],
    async writeSandboxFile(sandboxId, filePath, content) {
      this.writes.push({ sandboxId, filePath, content });
      return true;
    },
    killed: [],
    async killSandbox(id) { this.killed.push(id); return true; },
    paused: [],
    async pauseSandbox(id) { this.paused.push(id); return true; },
  };
}

const TRIAL_ENV = { E2B_API_URL: "http://cube.invalid", E2B_API_KEY: "k", TRIAL_TEMPLATE_ID: "relay-trial", TUNNEL_HOST: "broker.test", TUNNEL_PORT: "80", TUNNEL_SUFFIX: ".tun.test" };
const PAIRING = { pairingId: "11111111-1111-4111-8111-111111111111", pairingSecret: "c2VjcmV0LXNlY3JldC1zZWNyZXQ" };

test("trial create: 201, sandbox env carries enroll+pairing+tunnel, poll shows creating", async () => {
  const provisioner = makeFakeProvisioner();
  const t = await startTestApp({ env: TRIAL_ENV, provisioner });
  try {
    const session = await signIn(t);
    let res = await api(t.baseUrl, "POST", "/v1/trial-nodes", { body: PAIRING, ...authed(session.sessionToken) });
    assert.equal(res.status, 201);
    assert.equal(res.json.trial.state, "creating");
    assert.equal(res.json.trial.nodeId, null);
    assert.equal(res.json.trial.sni, null);
    assert.ok(!("enrollTokenHash" in res.json.trial));
    assert.ok(!("sandboxId" in res.json.trial));

    const env = provisioner.created[0].envVars;
    assert.equal(env.RELAYD_ENROLL_PAIRING_ID, PAIRING.pairingId);
    assert.equal(env.RELAYD_ENROLL_PAIRING_SECRET, PAIRING.pairingSecret);
    assert.equal(env.RELAYD_TUNNEL_HOST, "broker.test");
    assert.equal(env.RELAYD_TUNNEL_PORT, "80");
    assert.equal(env.RELAYD_TUNNEL_SUFFIX, ".tun.test");
    assert.match(env.RELAYD_ENROLL_TOKEN, /^[A-Za-z0-9_-]{43}$/);
    assert.match(env.RELAYD_ENROLL_URL, /^http:\/\/127\.0\.0\.1:\d+$/);

    res = await api(t.baseUrl, "GET", "/v1/trial-nodes/current", authed(session.sessionToken));
    assert.equal(res.status, 200);
    assert.equal(res.json.trial.state, "creating");
  } finally {
    await t.close();
  }
});

// The envVars asserted above are a fallback for a directly-booted node. On
// Cube the sandbox is RESTORED from a snapshot of the template's running
// machine, so its init process is already up with a frozen environment and
// never observes them — a live sandbox ran ten minutes with the enroll token
// set at create and the control plane saw zero enroll attempts. This file,
// written through envd after the sandbox exists, is what actually configures
// it, so it carries the same contract the boot script reads.
test("trial create delivers enroll.json into the running sandbox", async () => {
  const provisioner = makeFakeProvisioner();
  const t = await startTestApp({ env: TRIAL_ENV, provisioner });
  try {
    const session = await signIn(t);
    const res = await api(t.baseUrl, "POST", "/v1/trial-nodes", { body: PAIRING, ...authed(session.sessionToken) });
    assert.equal(res.status, 201);

    assert.equal(provisioner.writes.length, 1);
    const write = provisioner.writes[0];
    assert.equal(write.sandboxId, "sbx_1");
    assert.equal(write.filePath, "/var/lib/relayd/enroll.json");

    const cfg = JSON.parse(write.content);
    assert.equal(cfg.pairingId, PAIRING.pairingId);
    assert.equal(cfg.pairingSecret, PAIRING.pairingSecret);
    assert.equal(cfg.tunnelHost, "broker.test");
    assert.equal(cfg.tunnelPort, "80");
    assert.equal(cfg.tunnelSuffix, ".tun.test");
    assert.match(cfg.token, /^[A-Za-z0-9_-]{43}$/);
    assert.match(cfg.cloudUrl, /^http:\/\/127\.0\.0\.1:\d+$/);
  } finally {
    await t.close();
  }
});

// Failing after the sandbox exists is the dangerous case: the reaper's
// due-list covers only `creating` and `ready`, so a `failed` row that still
// held a sandbox id would never be revisited and the machine would run to its
// platform timeout — days of a stranded VM per failed signup.
test("a failed config delivery destroys the sandbox instead of stranding it", async () => {
  const provisioner = makeFakeProvisioner();
  provisioner.writeSandboxFile = async function () {
    throw new Error("provisioner_http_502");
  };
  const t = await startTestApp({ env: TRIAL_ENV, provisioner });
  try {
    const session = await signIn(t);
    let res = await api(t.baseUrl, "POST", "/v1/trial-nodes", { body: PAIRING, ...authed(session.sessionToken) });
    assert.equal(res.status, 502);
    assert.equal(res.json.error, "provision_failed");

    assert.deepEqual(provisioner.killed, ["sbx_1"]);

    res = await api(t.baseUrl, "GET", "/v1/trial-nodes/current", authed(session.sessionToken));
    assert.equal(res.status, 200);
    assert.equal(res.json.trial.state, "failed");
  } finally {
    await t.close();
  }
});


test("trial create: lifetime one per account (409), capacity 503, disabled 404, failure 502", async () => {
  const provisioner = makeFakeProvisioner();
  const t = await startTestApp({ env: { ...TRIAL_ENV, TRIAL_MAX_ACTIVE: "1" }, provisioner });
  try {
    const s1 = await signIn(t);
    let res = await api(t.baseUrl, "POST", "/v1/trial-nodes", { body: PAIRING, ...authed(s1.sessionToken) });
    assert.equal(res.status, 201);
    res = await api(t.baseUrl, "POST", "/v1/trial-nodes", { body: PAIRING, ...authed(s1.sessionToken) });
    assert.equal(res.status, 409);
    assert.equal(res.json.error, "trial_already_used");
  } finally {
    await t.close();
  }

  // capacity: second ACCOUNT hits the global active cap
  const prov2 = makeFakeProvisioner();
  const t2 = await startTestApp({ env: { ...TRIAL_ENV, TRIAL_MAX_ACTIVE: "1" }, provisioner: prov2 });
  try {
    const a = await signIn(t2);
    await api(t2.baseUrl, "POST", "/v1/trial-nodes", { body: PAIRING, ...authed(a.sessionToken) });
    const b = await signIn(t2, { sub: "apple-sub-2", email: "second@example.com" });
    const res = await api(t2.baseUrl, "POST", "/v1/trial-nodes", { body: PAIRING, ...authed(b.sessionToken) });
    assert.equal(res.status, 503);
    assert.equal(res.json.error, "trial_capacity");
  } finally {
    await t2.close();
  }

  // disabled: no E2B endpoint configured
  const t3 = await startTestApp();
  try {
    const s = await signIn(t3);
    const res = await api(t3.baseUrl, "POST", "/v1/trial-nodes", { body: PAIRING, ...authed(s.sessionToken) });
    assert.equal(res.status, 404);
    assert.equal(res.json.error, "trial_unavailable");
  } finally {
    await t3.close();
  }

  // provision failure: row lands in failed, response 502
  const prov4 = makeFakeProvisioner();
  prov4.failNext = true;
  const t4 = await startTestApp({ env: TRIAL_ENV, provisioner: prov4 });
  try {
    const s = await signIn(t4);
    const res = await api(t4.baseUrl, "POST", "/v1/trial-nodes", { body: PAIRING, ...authed(s.sessionToken) });
    assert.equal(res.status, 502);
    assert.equal(res.json.error, "provision_failed");
    const row = t4.app.registry.getTrialByAccount(s.accountId);
    assert.equal(row.state, "failed");
  } finally {
    await t4.close();
  }
});

test("trial create: retry after failed provision reuses the row instead of burning the lifetime trial", async () => {
  const provisioner = makeFakeProvisioner();
  const t = await startTestApp({ env: TRIAL_ENV, provisioner });
  try {
    const s = await signIn(t);

    provisioner.failNext = true;
    let res = await api(t.baseUrl, "POST", "/v1/trial-nodes", { body: PAIRING, ...authed(s.sessionToken) });
    assert.equal(res.status, 502);
    assert.equal(res.json.error, "provision_failed");
    const failedRow = t.app.registry.getTrialByAccount(s.accountId);
    assert.equal(failedRow.state, "failed");
    assert.equal(failedRow.enrollTokenHash, null);

    provisioner.failNext = false;
    res = await api(t.baseUrl, "POST", "/v1/trial-nodes", { body: PAIRING, ...authed(s.sessionToken) });
    assert.equal(res.status, 201);
    assert.equal(res.json.trial.state, "creating");
    assert.equal(res.json.trial.id, failedRow.id, "must reuse the same row, not insert a second one");
    assert.ok(!("enrollTokenHash" in res.json.trial));
    assert.ok(!("sandboxId" in res.json.trial));

    const reused = t.app.registry.getTrialByAccount(s.accountId);
    assert.equal(reused.id, failedRow.id);
    assert.equal(reused.state, "creating");
    assert.notEqual(reused.enrollTokenHash, failedRow.enrollTokenHash);
    assert.ok(reused.enrollTokenHash, "must have a freshly generated enroll token hash");
  } finally {
    await t.close();
  }
});

test("trial create: 400 pairing_required on missing/invalid pairingId or pairingSecret", async () => {
  const provisioner = makeFakeProvisioner();
  const t = await startTestApp({ env: TRIAL_ENV, provisioner });
  try {
    const s = await signIn(t);

    let res = await api(t.baseUrl, "POST", "/v1/trial-nodes", { body: {}, ...authed(s.sessionToken) });
    assert.equal(res.status, 400);
    assert.equal(res.json.error, "pairing_required");

    res = await api(t.baseUrl, "POST", "/v1/trial-nodes", {
      body: { pairingId: "not-a-uuid", pairingSecret: PAIRING.pairingSecret },
      ...authed(s.sessionToken),
    });
    assert.equal(res.status, 400);
    assert.equal(res.json.error, "pairing_required");

    res = await api(t.baseUrl, "POST", "/v1/trial-nodes", {
      body: { pairingId: PAIRING.pairingId, pairingSecret: "short" },
      ...authed(s.sessionToken),
    });
    assert.equal(res.status, 400);
    assert.equal(res.json.error, "pairing_required");

    assert.equal(provisioner.created.length, 0);
  } finally {
    await t.close();
  }
});

test("trial current: 404 no_trial when the account has never had a trial", async () => {
  const provisioner = makeFakeProvisioner();
  const t = await startTestApp({ env: TRIAL_ENV, provisioner });
  try {
    const s = await signIn(t);
    const res = await api(t.baseUrl, "GET", "/v1/trial-nodes/current", authed(s.sessionToken));
    assert.equal(res.status, 404);
    assert.equal(res.json.error, "no_trial");
  } finally {
    await t.close();
  }
});

test("trial delete: 404 no_trial when the account has never had a trial", async () => {
  const provisioner = makeFakeProvisioner();
  const t = await startTestApp({ env: TRIAL_ENV, provisioner });
  try {
    const s = await signIn(t);
    const res = await api(t.baseUrl, "DELETE", "/v1/trial-nodes/current", authed(s.sessionToken));
    assert.equal(res.status, 404);
    assert.equal(res.json.error, "no_trial");
  } finally {
    await t.close();
  }
});

test("trial delete: kills sandbox, removes node row, marks destroyed", async () => {
  const provisioner = makeFakeProvisioner();
  const t = await startTestApp({ env: TRIAL_ENV, provisioner });
  try {
    const s = await signIn(t);
    await api(t.baseUrl, "POST", "/v1/trial-nodes", { body: PAIRING, ...authed(s.sessionToken) });
    // Simulate a completed enroll so a node row exists.
    const trial = t.app.registry.getTrialByAccount(s.accountId);
    t.app.registry.createNode(s.accountId, { id: "node-00112233aabbccdd", kind: "trial", name: "Trial machine", pubkey: "pk", version: null });
    t.app.registry.updateTrial(trial.id, { state: "ready", nodeId: "node-00112233aabbccdd", sandboxId: "sbx_1" });

    const res = await api(t.baseUrl, "DELETE", "/v1/trial-nodes/current", authed(s.sessionToken));
    assert.equal(res.status, 204);
    assert.deepEqual(provisioner.killed, ["sbx_1"]);
    assert.equal(t.app.registry.getNode("node-00112233aabbccdd"), null);
    assert.equal(t.app.registry.getTrialByAccount(s.accountId).state, "destroyed");
  } finally {
    await t.close();
  }
});
