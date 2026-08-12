// product/cloud/test/trial-lifecycle.test.mjs
//
// Regressions for the trial sandbox's failure modes: lifecycle enforcement
// surviving the feature's kill switch, sandboxes outliving the rows that name
// them, a hung Cube host stalling the reaper, and a trial machine eating the
// account's only BYO node slot.
import test from "node:test";
import assert from "node:assert/strict";
import { startTestApp, api, signIn, authed, makeNodeIdentity } from "./helpers.mjs";

const TRIAL_ENV = {
  E2B_API_URL: "http://cube.invalid",
  E2B_API_KEY: "k",
  TRIAL_TEMPLATE_ID: "relay-trial",
  TRIAL_TTL_SEC: "10",
  TRIAL_GRACE_SEC: "5",
  TUNNEL_HOST: "broker.test",
  TUNNEL_SUFFIX: ".tun.test",
};
const PAIRING = {
  pairingId: "11111111-1111-4111-8111-111111111111",
  pairingSecret: "c2VjcmV0LXNlY3JldC1zZWNyZXQ",
};

function fakeProvisioner(overrides = {}) {
  return {
    created: [],
    paused: [],
    killed: [],
    async createSandbox(opts) {
      this.created.push(opts);
      return { sandboxId: `sbx_${this.created.length}` };
    },
    async pauseSandbox(id) {
      this.paused.push(id);
      return true;
    },
    async killSandbox(id) {
      this.killed.push(id);
      return true;
    },
    ...overrides,
  };
}

// Drives an account to a `ready` trial with a node row, the state every
// lifecycle test starts from.
async function readyTrial(t, session, { nodeId = "node-00112233aabbccdd" } = {}) {
  const res = await api(t.baseUrl, "POST", "/v1/trial-nodes", {
    body: PAIRING,
    ...authed(session.sessionToken),
  });
  assert.equal(res.status, 201);
  const trial = t.app.registry.getTrialByAccount(session.accountId);
  t.app.registry.createNode(session.accountId, {
    id: nodeId,
    kind: "trial",
    name: "Trial machine",
    pubkey: "pk",
    version: null,
  });
  t.app.registry.updateTrial(trial.id, { state: "ready", nodeId });
  return { trial, nodeId };
}

// ── I6 ─────────────────────────────────────────────────────────────────────
test("reaper keeps enforcing the lifecycle when the trial feature is switched off", async () => {
  // Unsetting E2B_API_URL is the documented kill switch for CREATING trials.
  // It must not also freeze every trial already in the wild: if expiry stopped
  // running, node rows would stay live and users would keep access forever —
  // the opposite of what reaching for a kill switch means.
  const provisioner = fakeProvisioner();
  const t = await startTestApp({ env: TRIAL_ENV, provisioner });
  try {
    const s = await signIn(t);
    const { nodeId } = await readyTrial(t, s);

    // Flip the kill switch exactly as an operator would: unset E2B_API_URL and
    // nothing else, then rebuild the service over the SAME database. The rest
    // of the trial config (TTL, grace) deliberately stays put — the point is
    // that removing the creation flag alone must not disarm the reaper.
    const dark = await startTestApp({
      env: { ...TRIAL_ENV, E2B_API_URL: "" },
      db: t.app.db,
      now: () => t.clock.t,
    });
    assert.equal(dark.app.provisioner, null, "the kill switch must leave no provisioner");
    try {
      // Creating a new trial is still refused — the dark launch must hold.
      const s2 = await signIn(dark, { sub: "apple-sub-2", email: "second@example.com" });
      const blocked = await api(dark.baseUrl, "POST", "/v1/trial-nodes", {
        body: PAIRING,
        ...authed(s2.sessionToken),
      });
      assert.equal(blocked.status, 404);
      assert.equal(blocked.json.error, "trial_unavailable");

      t.clock.t += 11_000; // past TTL
      await dark.app.sweepTrials();
      assert.equal(
        dark.app.registry.getTrialByAccount(s.accountId).state,
        "expired",
        "access must expire even with no provisioner configured",
      );

      t.clock.t += 6_000; // past grace
      await dark.app.sweepTrials();
      const row = dark.app.registry.getTrialByAccount(s.accountId);
      assert.equal(row.state, "destroyed");
      assert.equal(dark.app.registry.getNode(nodeId), null, "the node row must be removed");

      // The sandbox itself could not be destroyed, so it is recorded rather
      // than silently forgotten.
      const orphans = dark.app.registry.listSandboxOrphans();
      assert.equal(orphans.length, 1);
      assert.equal(orphans[0].sandboxId, "sbx_1");
      assert.equal(orphans[0].reason, "trial_past_grace");
    } finally {
      await dark.close();
    }
  } finally {
    await t.close();
  }
});

test("a recorded orphan is destroyed once a provisioner is available again", async () => {
  const provisioner = fakeProvisioner();
  const t = await startTestApp({ env: TRIAL_ENV, provisioner });
  try {
    const s = await signIn(t);
    await readyTrial(t, s);
    t.app.registry.recordSandboxOrphan({ sandboxId: "sbx_stranded", reason: "trial_past_grace" });

    await t.app.sweepTrials();
    assert.deepEqual(provisioner.killed, ["sbx_stranded"]);
    assert.deepEqual(t.app.registry.listSandboxOrphans(), []);
  } finally {
    await t.close();
  }
});

// ── C5 ─────────────────────────────────────────────────────────────────────
test("deleting the account destroys the trial sandbox", async () => {
  // deleteAccount drops the trial_nodes row, after which nothing can map the
  // account back to a live microVM: listTrialsDue/listTrialsPastGrace can
  // never see it, countActiveTrials under-counts, and the machine keeps
  // holding the user's files indefinitely.
  const provisioner = fakeProvisioner();
  const t = await startTestApp({ env: TRIAL_ENV, provisioner });
  const origin = t.config.betterAuthBaseURL;
  try {
    const signup = await api(t.baseUrl, "POST", "/api/auth/sign-up/email", {
      headers: { origin },
      body: {
        email: "trial-user@example.com",
        name: "Trial User",
        username: "trial_user",
        password: "correct-horse-battery",
      },
    });
    assert.equal(signup.status, 200);
    const token = signup.headers.get("set-auth-token");

    const created = await api(t.baseUrl, "POST", "/v1/trial-nodes", {
      body: PAIRING,
      headers: { origin, authorization: `Bearer ${token}` },
    });
    assert.equal(created.status, 201);

    const deleted = await api(t.baseUrl, "POST", "/api/auth/delete-user", {
      headers: { origin, authorization: `Bearer ${token}` },
      body: { password: "correct-horse-battery" },
    });
    assert.equal(deleted.status, 200);

    assert.deepEqual(provisioner.killed, ["sbx_1"], "the sandbox must be destroyed with the account");
    assert.equal(t.app.db.prepare("SELECT COUNT(*) AS n FROM trial_nodes").get().n, 0);
    assert.deepEqual(t.app.registry.listSandboxOrphans(), [], "a successful destroy leaves no orphan");
  } finally {
    await t.close();
  }
});

test("account deletion still succeeds when the sandbox cannot be destroyed, and records the orphan", async () => {
  const provisioner = fakeProvisioner({
    async killSandbox() {
      throw new Error("provisioner_http_500");
    },
  });
  const t = await startTestApp({ env: TRIAL_ENV, provisioner });
  const origin = t.config.betterAuthBaseURL;
  try {
    const signup = await api(t.baseUrl, "POST", "/api/auth/sign-up/email", {
      headers: { origin },
      body: {
        email: "trial-user2@example.com",
        name: "Trial User Two",
        username: "trial_user2",
        password: "correct-horse-battery",
      },
    });
    const token = signup.headers.get("set-auth-token");
    await api(t.baseUrl, "POST", "/v1/trial-nodes", {
      body: PAIRING,
      headers: { origin, authorization: `Bearer ${token}` },
    });

    const deleted = await api(t.baseUrl, "POST", "/api/auth/delete-user", {
      headers: { origin, authorization: `Bearer ${token}` },
      body: { password: "correct-horse-battery" },
    });
    assert.equal(deleted.status, 200, "an unreachable Cube host must not make an account undeletable");
    assert.equal(t.app.registry.findAccountByEmail("trial-user2@example.com"), null);

    const orphans = t.app.registry.listSandboxOrphans();
    assert.equal(orphans.length, 1);
    assert.equal(orphans[0].sandboxId, "sbx_1");
    assert.equal(orphans[0].reason, "account_deleted");
  } finally {
    await t.close();
  }
});

// ── I2 ─────────────────────────────────────────────────────────────────────
test("a trial node does not consume the account's BYO node slot", async () => {
  // nodes.max defaults to 1. The trial node is created by the enroll route
  // bypassing the entitlement gate, so counting it would 403 the user's own
  // box for the whole 7+3 days — blocking the documented upgrade path.
  const provisioner = fakeProvisioner();
  const t = await startTestApp({ env: TRIAL_ENV, provisioner });
  try {
    const s = await signIn(t);
    const identity = makeNodeIdentity();
    await readyTrial(t, s);

    const res = await api(t.baseUrl, "POST", "/v1/nodes", {
      body: { kind: "byo", name: "My box", pubkey: identity.pubkeyPem },
      ...authed(s.sessionToken),
    });
    assert.equal(res.status, 201, `a trial user must still be able to register their own node (got ${JSON.stringify(res.json)})`);

    // The BYO node itself still counts: a second one hits the limit.
    const second = await api(t.baseUrl, "POST", "/v1/nodes", {
      body: { kind: "byo", name: "Another box", pubkey: makeNodeIdentity().pubkeyPem },
      ...authed(s.sessionToken),
    });
    assert.equal(second.status, 403);
    assert.equal(second.json.error, "entitlement_limit");
  } finally {
    await t.close();
  }
});

// ── I4 ─────────────────────────────────────────────────────────────────────
test("one trial's provisioner failure does not abort the rest of the sweep", async () => {
  const provisioner = fakeProvisioner({
    async pauseSandbox(id) {
      this.paused.push(id);
      if (id === "sbx_1") throw new Error("provisioner_http_500");
      return true;
    },
  });
  const t = await startTestApp({ env: TRIAL_ENV, provisioner });
  try {
    const a = await signIn(t);
    await readyTrial(t, a, { nodeId: "node-aaaaaaaaaaaaaaaa" });
    const b = await signIn(t, { sub: "apple-sub-2", email: "second@example.com" });
    await readyTrial(t, b, { nodeId: "node-bbbbbbbbbbbbbbbb" });

    t.clock.t += 11_000;
    await t.app.sweepTrials();

    // Both rows expire even though the first sandbox's pause threw.
    assert.equal(t.app.registry.getTrialByAccount(a.accountId).state, "expired");
    assert.equal(
      t.app.registry.getTrialByAccount(b.accountId).state,
      "expired",
      "a failure on the first trial must not strand every trial behind it",
    );
    assert.deepEqual(provisioner.paused, ["sbx_1", "sbx_2"]);
  } finally {
    await t.close();
  }
});

// ── M8 ─────────────────────────────────────────────────────────────────────
test("overlapping sweeps do not double-issue destroy work", async () => {
  // runSweeps fires sweepTrials without awaiting on a 60 s timer, so a pass
  // slowed by an unresponsive provisioner would otherwise be re-entered by the
  // next tick and kill/deleteNode the same rows twice.
  let release;
  const gate = new Promise((resolve) => (release = resolve));
  const provisioner = fakeProvisioner({
    async killSandbox(id) {
      this.killed.push(id);
      await gate;
      return true;
    },
  });
  const t = await startTestApp({ env: TRIAL_ENV, provisioner });
  try {
    const s = await signIn(t);
    await readyTrial(t, s);

    t.clock.t += 11_000;
    await t.app.sweepTrials(); // expire
    t.clock.t += 6_000;

    const first = t.app.sweepTrials(); // blocks inside killSandbox
    const second = t.app.sweepTrials(); // must be a no-op, not a second kill
    await second;
    release();
    await first;

    assert.deepEqual(provisioner.killed, ["sbx_1"], "the sandbox must be killed exactly once");
  } finally {
    await t.close();
  }
});
