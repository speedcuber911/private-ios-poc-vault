import test from "node:test";
import assert from "node:assert/strict";
import { appAccountTokenForAccount } from "../src/app-store.js";
import { startTestApp, api, signIn, authed } from "./helpers.mjs";

const DAY = 24 * 3600 * 1000;
const ENV = {
  E2B_API_URL: "http://cube.invalid",
  E2B_API_KEY: "test-only",
  TRIAL_TEMPLATE_ID: "relay-trial",
  TRIAL_TTL_SEC: "10",
  TRIAL_GRACE_SEC: "5",
  RELAY_ADMIN_EMAILS: "operator@example.test",
};

function provisioner(overrides = {}) {
  return {
    extended: [], resumed: [], paused: [], killed: [],
    async extendSandbox(id, timeout) { this.extended.push({ id, timeout }); return true; },
    async resumeSandbox(id, timeout) { this.resumed.push({ id, timeout }); return true; },
    async pauseSandbox(id) { this.paused.push(id); return true; },
    async killSandbox(id) { this.killed.push(id); return true; },
    ...overrides,
  };
}

function seedTrial(t, accountId, { state = "ready", suffix = "0011223344556677" } = {}) {
  const trial = t.app.registry.createTrialNode({ accountId, enrollTokenHash: "test-enroll", expiresAt: t.clock.t + 10_000 });
  const nodeId = `node-${suffix}`;
  t.app.registry.createNode(accountId, { id: nodeId, kind: "trial", name: "Trial machine", pubkey: "test-pubkey" });
  return t.app.registry.updateTrial(trial.id, { state, nodeId, sandboxId: `sbx_${suffix}` });
}

async function operator(t) {
  const response = await api(t.baseUrl, "POST", "/api/auth/sign-up/email", {
    headers: { origin: t.config.betterAuthBaseURL },
    body: { email: "operator@example.test", username: "operator", name: "Operator", password: "test-correct-horse-battery" },
  });
  assert.equal(response.status, 200);
  return response.headers.get("set-auth-token");
}

function upgrade(t, token, accountId) {
  return api(t.baseUrl, "POST", `/v1/admin/accounts/${accountId}/upgrade`, {
    headers: { origin: t.config.betterAuthBaseURL, authorization: `Bearer ${token}` },
  });
}

test("operator upgrade extends before committing and a stale reaper cannot pause it", async () => {
  let release;
  let started;
  const extending = new Promise((resolve) => { started = resolve; });
  const blocked = new Promise((resolve) => { release = resolve; });
  const platform = provisioner({ async extendSandbox(id, timeout) {
    this.extended.push({ id, timeout }); started(); await blocked; return true;
  } });
  const t = await startTestApp({ env: ENV, provisioner: platform });
  try {
    const session = await signIn(t);
    const admin = await operator(t);
    const trial = seedTrial(t, session.accountId);
    const pending = upgrade(t, admin, session.accountId);
    await extending;
    assert.equal(t.app.registry.getTrialById(trial.id).state, "ready");
    assert.equal(t.app.registry.getEntitlement(session.accountId, "hosted.auto_upgrade"), null);
    t.clock.t += 20_000;
    const reaping = t.app.sweepTrials();
    release();
    assert.equal((await pending).status, 200);
    await reaping;
    assert.equal(t.app.registry.getTrialById(trial.id).state, "upgraded");
    assert.deepEqual(platform.paused, []);
    assert.deepEqual(platform.killed, []);
    assert.equal(platform.extended[0].timeout, t.config.trial.paidSandboxTimeoutSec);
  } finally { release?.(); await t.close(); }
});

test("operator upgrade resumes an expired machine before changing its state", async () => {
  const platform = provisioner();
  const t = await startTestApp({ env: ENV, provisioner: platform });
  try {
    const session = await signIn(t);
    const trial = seedTrial(t, session.accountId, { state: "expired" });
    const response = await upgrade(t, await operator(t), session.accountId);
    assert.equal(response.status, 200);
    assert.equal(t.app.registry.getTrialById(trial.id).state, "upgraded");
    assert.deepEqual(platform.extended, []);
    assert.deepEqual(platform.resumed, [{ id: trial.sandboxId, timeout: t.config.trial.paidSandboxTimeoutSec }]);
  } finally { await t.close(); }
});

test("failed or missing platform activation never grants an operator upgrade", async () => {
  for (const missing of [false, true]) {
    const platform = provisioner({
      async extendSandbox() { if (missing) return false; throw new Error("platform_unavailable"); },
      async resumeSandbox() { return false; },
    });
    const t = await startTestApp({ env: ENV, provisioner: platform, log: () => {} });
    try {
      const session = await signIn(t);
      const trial = seedTrial(t, session.accountId);
      const response = await upgrade(t, await operator(t), session.accountId);
      assert.equal(response.status, missing ? 409 : 502);
      assert.equal(response.json.error, missing ? "sandbox_missing" : "hosted_activation_failed");
      assert.equal(t.app.registry.getTrialById(trial.id).state, "ready");
      assert.equal(t.app.registry.getNode(trial.nodeId).kind, "trial");
      assert.equal(t.app.registry.getEntitlement(session.accountId, "hosted.auto_upgrade"), null);
    } finally { await t.close(); }
  }
});

test("upgraded operator leases renew daily and retry transient failures without downgrading", async () => {
  let fail = false;
  const warnings = [];
  const platform = provisioner({ async extendSandbox(id, timeout) {
    this.extended.push({ id, timeout }); if (fail) throw new Error("timeout"); return true;
  } });
  const t = await startTestApp({ env: ENV, provisioner: platform, log: (message) => warnings.push(message) });
  try {
    const session = await signIn(t);
    const trial = seedTrial(t, session.accountId, { state: "upgraded" });
    t.app.registry.setEntitlement(session.accountId, "hosted.auto_upgrade", "1");
    await t.app.sweepHostedSandboxes();
    await t.app.sweepHostedSandboxes();
    t.clock.t += 60_000;
    await t.app.sweepHostedSandboxes();
    assert.equal(platform.extended.length, 1, "the 60-second sweep must not renew every tick");
    t.clock.t += DAY;
    fail = true;
    await t.app.sweepHostedSandboxes();
    assert.equal(platform.extended.length, 2);
    assert.equal(t.app.registry.getTrialById(trial.id).state, "upgraded");
    assert.ok(t.app.registry.getNode(trial.nodeId));
    t.clock.t += 60_000;
    await t.app.sweepHostedSandboxes();
    assert.equal(platform.extended.length, 2, "failure retries must be bounded too");
    t.clock.t += 4 * 60_000;
    fail = false;
    await t.app.sweepHostedSandboxes();
    assert.equal(platform.extended.length, 3);
    assert.equal(warnings.length, 1);
    assert.deepEqual(platform.resumed, []);
  } finally { await t.close(); }
});

test("maintenance skips unentitled, expired, failed, and destroyed rows", async () => {
  const platform = provisioner();
  const t = await startTestApp({ env: ENV, provisioner: platform });
  try {
    for (const [index, state] of ["upgraded", "expired", "failed", "destroyed"].entries()) {
      const session = await signIn(t, { sub: `state-${index}`, email: `state-${index}@example.test` });
      seedTrial(t, session.accountId, { state, suffix: `001122334455660${index}` });
      if (state !== "upgraded") t.app.registry.setEntitlement(session.accountId, "hosted.auto_upgrade", "1");
    }
    await t.app.sweepHostedSandboxes();
    assert.deepEqual(platform.extended, []);
    assert.deepEqual(platform.resumed, []);
  } finally { await t.close(); }
});

test("pending credential-collection activation survives a control-plane restart", async () => {
  const platform = provisioner();
  const first = await startTestApp({ env: ENV, provisioner: platform });
  const session = await signIn(first);
  const trial = seedTrial(first, session.accountId);
  first.app.registry.setEntitlement(session.accountId, "hosted.auto_upgrade", "1");
  first.app.registry.setEntitlement(session.accountId, "hosted.activation_pending_trial", `${trial.id}:${trial.sandboxId}`);
  await first.close();
  const second = await startTestApp({ env: ENV, provisioner: platform, db: first.app.db, now: () => first.clock.t });
  try {
    await second.app.sweepHostedSandboxes();
    assert.equal(second.app.registry.getTrialById(trial.id).state, "upgraded");
    assert.equal(second.app.registry.getEntitlement(session.accountId, "hosted.activation_pending_trial"), "");
    assert.equal(platform.extended.length, 1);
  } finally { await second.close(); }
});

test("a recreated sandbox does not inherit an old pending credential-collection activation", async () => {
  const platform = provisioner();
  const t = await startTestApp({ env: ENV, provisioner: platform });
  try {
    const session = await signIn(t);
    const trial = seedTrial(t, session.accountId);
    t.app.registry.setEntitlement(session.accountId, "hosted.auto_upgrade", "1");
    t.app.registry.setEntitlement(session.accountId, "hosted.activation_pending_trial", `${trial.id}:${trial.sandboxId}`);
    // The trial row is reused after deletion, but its replacement machine
    // must wait for its own credential collection before automatic activation.
    t.app.registry.updateTrial(trial.id, { state: "destroyed" });
    t.app.registry.updateTrial(trial.id, { state: "ready", sandboxId: "sbx_replacement" });
    await t.app.sweepHostedSandboxes();
    assert.equal(t.app.registry.getTrialById(trial.id).state, "ready");
    assert.deepEqual(platform.extended, []);
    assert.deepEqual(platform.resumed, []);
  } finally { await t.close(); }
});

test("Apple expiration does not revoke an independent operator grant", async () => {
  let transaction;
  const platform = provisioner();
  const t = await startTestApp({ env: ENV, provisioner: platform, appStoreVerifier: {
    async verifyTransaction() { return transaction; },
    async verifyNotification() { return { notificationType: "EXPIRED", data: { status: 2, signedTransactionInfo: "test-expiry" } }; },
    async verifyNotificationTransaction() { return transaction; },
  } });
  try {
    const session = await signIn(t);
    const trial = seedTrial(t, session.accountId, { state: "upgraded" });
    t.app.registry.setEntitlement(session.accountId, "hosted.auto_upgrade", "1");
    transaction = {
      productId: t.config.appStore.monthlyProductId,
      originalTransactionId: "operator-sandbox-subscription",
      transactionId: "operator-expired",
      appAccountToken: appAccountTokenForAccount(session.accountId),
      environment: "Sandbox",
      expiresDate: t.clock.t + 1_000,
      signedDate: t.clock.t,
    };
    const response = await api(t.baseUrl, "POST", "/v1/subscriptions/apple/verify", {
      body: { signedTransaction: "test-transaction" }, ...authed(session.sessionToken),
    });
    assert.equal(response.status, 200);
    t.clock.t += 2_000;
    transaction = { ...transaction, transactionId: "operator-expiry-event", signedDate: t.clock.t };
    assert.equal((await api(t.baseUrl, "POST", "/v1/subscriptions/apple/notifications", {
      body: { signedPayload: "test-notification" },
    })).status, 200);
    assert.equal(t.app.registry.getAppleSubscriptionByAccount(session.accountId).status, "expired");
    assert.equal(t.app.registry.getTrialById(trial.id).state, "upgraded");
    assert.deepEqual(platform.paused, []);
  } finally { await t.close(); }
});

test("renewal sweeps do not overlap or restart after server shutdown", async () => {
  let release;
  let started;
  const entered = new Promise((resolve) => { started = resolve; });
  const blocked = new Promise((resolve) => { release = resolve; });
  const platform = provisioner({ async extendSandbox(id, timeout) {
    this.extended.push({ id, timeout }); started(); await blocked; return true;
  } });
  const t = await startTestApp({ env: ENV, provisioner: platform });
  const session = await signIn(t);
  seedTrial(t, session.accountId, { state: "upgraded" });
  t.app.registry.setEntitlement(session.accountId, "hosted.auto_upgrade", "1");
  const pending = t.app.sweepHostedSandboxes();
  await entered;
  await t.app.sweepHostedSandboxes();
  assert.equal(platform.extended.length, 1);
  await t.close();
  release();
  await pending;
  t.clock.t += 2 * DAY;
  await t.app.sweepHostedSandboxes();
  t.app.runSweeps();
  assert.equal(platform.extended.length, 1);
});
