import test from "node:test";
import assert from "node:assert/strict";

import { appAccountTokenForAccount, createAppStoreVerifier } from "../src/app-store.js";
import { startTestApp, api, signIn, authed } from "./helpers.mjs";

const PRODUCT_ID = "com.parikshit.pocvault.hosted.monthly";
const YEARLY_PRODUCT_ID = "com.parikshit.pocvault.hosted.yearly";
const TRIAL_ENV = {
  E2B_API_URL: "http://cube.invalid",
  E2B_API_KEY: "k",
  TRIAL_TEMPLATE_ID: "relay-trial",
  TUNNEL_SUFFIX: ".tun.test",
};

function makeProvisioner() {
  return {
    extended: [],
    resumed: [],
    paused: [],
    async extendSandbox(id, timeout) { this.extended.push({ id, timeout }); return true; },
    async resumeSandbox(id, timeout) { this.resumed.push({ id, timeout }); return true; },
    async pauseSandbox(id) { this.paused.push(id); return true; },
    async killSandbox() { return true; },
  };
}

function installReadyTrial(t, accountId) {
  const trial = t.app.registry.createTrialNode({
    accountId,
    enrollTokenHash: "enroll",
    expiresAt: t.clock.t + 7 * 24 * 3600 * 1000,
  });
  t.app.registry.createNode(accountId, {
    id: "node-0011223344556677",
    kind: "trial",
    name: "Trial machine",
    pubkey: "pk",
  });
  t.app.registry.updateTrial(trial.id, {
    state: "ready",
    nodeId: "node-0011223344556677",
    sandboxId: "sbx_paid",
  });
}

test("app account tokens are stable UUIDs and account-specific", () => {
  assert.equal(
    appAccountTokenForAccount("account-a"),
    appAccountTokenForAccount("account-a"),
  );
  assert.notEqual(
    appAccountTokenForAccount("account-a"),
    appAccountTokenForAccount("account-b"),
  );
  assert.match(
    appAccountTokenForAccount("account-a"),
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
  );
});

test("the production verifier loads all checked-in Apple DER roots", () => {
  const verifier = createAppStoreVerifier({
    appStore: {
      bundleId: "com.parikshit.pocvault",
      appAppleId: 6800257362,
      enableOnlineChecks: false,
    },
  });
  assert.equal(typeof verifier.verifyTransaction, "function");
  assert.equal(typeof verifier.verifyNotification, "function");
});

test("a verified yearly purchase activates the same hosted entitlement", async () => {
  let transaction;
  const appStoreVerifier = {
    async verifyTransaction() { return transaction; },
    async verifyNotification() { throw new Error("unused"); },
    async verifyNotificationTransaction() { throw new Error("unused"); },
  };
  const t = await startTestApp({ appStoreVerifier });
  try {
    const session = await signIn(t);
    transaction = {
      productId: YEARLY_PRODUCT_ID,
      originalTransactionId: "original-yearly",
      transactionId: "transaction-yearly",
      appAccountToken: appAccountTokenForAccount(session.accountId),
      environment: "Production",
      expiresDate: t.clock.t + 365 * 24 * 3600 * 1000,
      signedDate: t.clock.t,
    };
    const response = await api(t.baseUrl, "POST", "/v1/subscriptions/apple/verify", {
      body: { signedTransaction: "yearly-jws" },
      ...authed(session.sessionToken),
    });
    assert.equal(response.status, 200);
    assert.equal(response.json.subscription.productId, YEARLY_PRODUCT_ID);
    assert.equal(response.json.subscription.status, "active");
    assert.equal(response.json.trial, null);
  } finally {
    await t.close();
  }
});

test("a verified monthly purchase upgrades the machine and extends its platform timer", async () => {
  const provisioner = makeProvisioner();
  let transaction;
  const appStoreVerifier = {
    async verifyTransaction() { return transaction; },
    async verifyNotification() { throw new Error("unused"); },
    async verifyNotificationTransaction() { throw new Error("unused"); },
  };
  const t = await startTestApp({ env: TRIAL_ENV, provisioner, appStoreVerifier });
  try {
    const session = await signIn(t);
    installReadyTrial(t, session.accountId);
    transaction = {
      productId: PRODUCT_ID,
      originalTransactionId: "original-1",
      transactionId: "transaction-1",
      appAccountToken: appAccountTokenForAccount(session.accountId),
      environment: "Sandbox",
      expiresDate: t.clock.t + 30 * 24 * 3600 * 1000,
      signedDate: t.clock.t,
    };

    const response = await api(t.baseUrl, "POST", "/v1/subscriptions/apple/verify", {
      body: { signedTransaction: "apple-jws" },
      ...authed(session.sessionToken),
    });
    assert.equal(response.status, 200);
    assert.deepEqual(response.json.subscription, {
      productId: PRODUCT_ID,
      status: "active",
      expiresAt: transaction.expiresDate,
    });
    assert.equal(response.json.trial.state, "upgraded");
    assert.equal(t.app.registry.getNode("node-0011223344556677").kind, "managed");
    assert.equal(provisioner.extended.length, 1);
    assert.equal(
      provisioner.extended[0].timeout,
      t.config.trial.paidSandboxTimeoutSec,
    );
  } finally {
    await t.close();
  }
});

test("a purchase cannot be attached to a different Relay account", async () => {
  let transaction;
  const appStoreVerifier = {
    async verifyTransaction() { return transaction; },
    async verifyNotification() { throw new Error("unused"); },
    async verifyNotificationTransaction() { throw new Error("unused"); },
  };
  const t = await startTestApp({ appStoreVerifier });
  try {
    const owner = await signIn(t, { sub: "owner", email: "owner@example.com" });
    const other = await signIn(t, { sub: "other", email: "other@example.com" });
    transaction = {
      productId: PRODUCT_ID,
      originalTransactionId: "original-owner",
      transactionId: "transaction-owner",
      appAccountToken: appAccountTokenForAccount(owner.accountId),
      environment: "Sandbox",
      expiresDate: t.clock.t + 100_000,
      signedDate: t.clock.t,
    };
    const response = await api(t.baseUrl, "POST", "/v1/subscriptions/apple/verify", {
      body: { signedTransaction: "apple-jws" },
      ...authed(other.sessionToken),
    });
    assert.equal(response.status, 403);
    assert.equal(response.json.error, "subscription_account_mismatch");
    assert.equal(t.app.registry.getAppleSubscriptionByAccount(other.accountId), null);
  } finally {
    await t.close();
  }
});

test("a delayed renewal can supersede a local wall-clock expiry sweep", async () => {
  let transaction;
  const appStoreVerifier = {
    async verifyTransaction() { return transaction; },
    async verifyNotification() { throw new Error("unused"); },
    async verifyNotificationTransaction() { throw new Error("unused"); },
  };
  const t = await startTestApp({ appStoreVerifier });
  try {
    const session = await signIn(t);
    const firstSignedAt = t.clock.t;
    transaction = {
      productId: PRODUCT_ID,
      originalTransactionId: "original-delayed-renewal",
      transactionId: "transaction-initial",
      appAccountToken: appAccountTokenForAccount(session.accountId),
      environment: "Production",
      expiresDate: firstSignedAt + 100_000,
      signedDate: firstSignedAt,
    };
    assert.equal((await api(t.baseUrl, "POST", "/v1/subscriptions/apple/verify", {
      body: { signedTransaction: "initial-jws" },
      ...authed(session.sessionToken),
    })).status, 200);

    t.clock.t = firstSignedAt + 200_000;
    t.app.registry.markAppleSubscriptionExpired(session.accountId);
    transaction = {
      ...transaction,
      transactionId: "transaction-renewed",
      expiresDate: firstSignedAt + 30 * 24 * 3600 * 1000,
      // Apple signed this after the prior transaction but before Relay's
      // expiry sweep ran; a delayed notification must still restore access.
      signedDate: firstSignedAt + 150_000,
    };
    const renewed = await api(t.baseUrl, "POST", "/v1/subscriptions/apple/verify", {
      body: { signedTransaction: "renewed-jws" },
      ...authed(session.sessionToken),
    });
    assert.equal(renewed.status, 200);
    assert.equal(renewed.json.subscription.status, "active");
    assert.equal(
      t.app.registry.getAppleSubscriptionByAccount(session.accountId).transactionId,
      "transaction-renewed",
    );
  } finally {
    await t.close();
  }
});

test("an Apple expiry notification pauses the machine and closes access", async () => {
  const provisioner = makeProvisioner();
  let transaction;
  let notification;
  const appStoreVerifier = {
    async verifyTransaction() { return transaction; },
    async verifyNotification() { return notification; },
    async verifyNotificationTransaction() { return transaction; },
  };
  const t = await startTestApp({ env: TRIAL_ENV, provisioner, appStoreVerifier });
  try {
    const session = await signIn(t);
    installReadyTrial(t, session.accountId);
    const expiresDate = t.clock.t + 100_000;
    transaction = {
      productId: PRODUCT_ID,
      originalTransactionId: "original-expiry",
      transactionId: "transaction-buy",
      appAccountToken: appAccountTokenForAccount(session.accountId),
      environment: "Sandbox",
      expiresDate,
      signedDate: t.clock.t,
    };
    assert.equal((await api(t.baseUrl, "POST", "/v1/subscriptions/apple/verify", {
      body: { signedTransaction: "buy-jws" },
      ...authed(session.sessionToken),
    })).status, 200);

    t.clock.t = expiresDate + 1;
    transaction = {
      ...transaction,
      transactionId: "transaction-expired",
      signedDate: t.clock.t,
    };
    notification = {
      notificationType: "EXPIRED",
      data: { status: 2, signedTransactionInfo: "expiry-jws" },
    };
    const expired = await api(
      t.baseUrl,
      "POST",
      "/v1/subscriptions/apple/notifications",
      { body: { signedPayload: "notification-jws" } },
    );
    assert.equal(expired.status, 200);
    assert.equal(t.app.registry.getTrialByAccount(session.accountId).state, "expired");
    assert.equal(t.app.registry.hasActiveAppleSubscription(session.accountId, t.clock.t), false);
    assert.deepEqual(provisioner.paused, ["sbx_paid"]);
  } finally {
    await t.close();
  }
});
