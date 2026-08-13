// Per-device APNs environment routing.
//
// A device token is only valid against the environment of the build that
// minted it: a TestFlight/App Store token against api.push.apple.com, a
// development build's against api.sandbox.push.apple.com. Sent to the wrong
// one, Apple answers 400 BadDeviceToken — indistinguishable from a dead token.
//
// With a single global APNS_HOST an account could not hold both kinds. On
// 2026-08-13 that cost the owner every push token they had: APNS_HOST was
// sandbox, a TestFlight build registered, and BadDeviceToken was being treated
// as "the app is gone". Flipping the host to production then broke every
// remaining development token instead — 27 of them, refused on every push.
// One global host cannot be right for both, so the host is now chosen per
// device from what the app reported at registration.

import test from "node:test";
import assert from "node:assert/strict";

import { startTestApp, api, authed, signIn, makeNodeIdentity } from "./helpers.mjs";

const NODE_ID = "node-00112233445566aa";
const PROD_HOST = "api.push.apple.com";
const SANDBOX_HOST = "api.sandbox.push.apple.com";

async function setup(t) {
  const session = await signIn(t);
  const identity = makeNodeIdentity();
  t.app.registry.createNode(session.accountId, {
    id: NODE_ID, kind: "trial", name: "Trial", pubkey: identity.pubkeyPem,
  });
  return { session, identity };
}

async function registerDevice(t, session, { name, apnsToken, apnsEnvironment }) {
  const res = await api(t.baseUrl, "POST", "/v1/devices", {
    body: { name, platform: "ios", apnsToken, ...(apnsEnvironment !== undefined ? { apnsEnvironment } : {}) },
    ...authed(session.sessionToken),
  });
  assert.equal(res.status, 201, JSON.stringify(res.json));
  return res.json.device;
}

async function fanout(t, identity, seq = 1) {
  const body = Buffer.from(
    JSON.stringify({ v: 1, nodeId: NODE_ID, jobId: null, type: "handoff.ready", ts: t.clock.t, seq }),
    "utf8",
  );
  const res = await api(t.baseUrl, "POST", "/v1/node-events", {
    raw: body, headers: { "x-relay-signature": identity.signBody(body) },
  });
  assert.equal(res.status, 202);
  await t.app.notify.drain();
  return t.apnsTransport.requests;
}

test("each device is pushed to the host its token belongs to", async () => {
  const t = await startTestApp();
  try {
    const { session, identity } = await setup(t);
    await registerDevice(t, session, { name: "testflight", apnsToken: "a".repeat(64), apnsEnvironment: "production" });
    await registerDevice(t, session, { name: "xcode", apnsToken: "b".repeat(64), apnsEnvironment: "development" });

    const sent = await fanout(t, identity);
    assert.equal(sent.length, 2);

    const byToken = new Map(sent.map((r) => [r.path.split("/").pop(), r.host]));
    assert.equal(byToken.get("a".repeat(64)), PROD_HOST, "a TestFlight token must go to production");
    assert.equal(byToken.get("b".repeat(64)), SANDBOX_HOST, "a dev-build token must go to sandbox");
  } finally { await t.close(); }
});

// The regression in one test: both kinds on one account, at once. This is the
// case a single global host cannot serve, and the reason 27 tokens were being
// refused on every push.
test("a mixed-environment account reaches both devices", async () => {
  const t = await startTestApp();
  try {
    const { session, identity } = await setup(t);
    for (let i = 0; i < 3; i += 1) {
      await registerDevice(t, session, { name: `prod-${i}`, apnsToken: `p${i}`.padEnd(64, "0"), apnsEnvironment: "production" });
      await registerDevice(t, session, { name: `dev-${i}`, apnsToken: `d${i}`.padEnd(64, "0"), apnsEnvironment: "development" });
    }

    const sent = await fanout(t, identity);
    assert.equal(sent.length, 6);
    assert.equal(sent.filter((r) => r.host === PROD_HOST).length, 3);
    assert.equal(sent.filter((r) => r.host === SANDBOX_HOST).length, 3);
  } finally { await t.close(); }
});

// Every row written before the column existed has no environment. Those must
// behave exactly as before — the configured APNS_HOST — not silently move.
test("a device that never reported an environment uses the configured host", async () => {
  const t = await startTestApp({ env: { APNS_HOST: SANDBOX_HOST } });
  try {
    const { session, identity } = await setup(t);
    await registerDevice(t, session, { name: "legacy", apnsToken: "c".repeat(64) });

    const sent = await fanout(t, identity);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].host, SANDBOX_HOST, "unknown must fall back to the configured default, unchanged");
  } finally { await t.close(); }
});

test("the configured default is honoured for unknown even when it is production", async () => {
  const t = await startTestApp({ env: { APNS_HOST: PROD_HOST } });
  try {
    const { session, identity } = await setup(t);
    await registerDevice(t, session, { name: "legacy", apnsToken: "c".repeat(64) });
    const sent = await fanout(t, identity);
    assert.equal(sent[0].host, PROD_HOST);
  } finally { await t.close(); }
});

// Anything outside Apple's two names is stored as unknown rather than refused:
// an app that cannot determine its own environment must still be able to
// register for pushes at all.
test("a junk environment registers as unknown instead of failing", async () => {
  const t = await startTestApp({ env: { APNS_HOST: PROD_HOST } });
  try {
    const { session, identity } = await setup(t);
    const device = await registerDevice(t, session, {
      name: "confused", apnsToken: "e".repeat(64), apnsEnvironment: "PRODUCTION-ish; drop table",
    });
    assert.equal(device.apnsEnvironment, null);

    const sent = await fanout(t, identity);
    assert.equal(sent[0].host, PROD_HOST);
  } finally { await t.close(); }
});

test("environment matching is case- and whitespace-insensitive", async () => {
  const t = await startTestApp();
  try {
    const { session, identity } = await setup(t);
    const device = await registerDevice(t, session, {
      name: "shouty", apnsToken: "f".repeat(64), apnsEnvironment: "  Production  ",
    });
    assert.equal(device.apnsEnvironment, "production");
    const sent = await fanout(t, identity);
    assert.equal(sent[0].host, PROD_HOST);
  } finally { await t.close(); }
});

// A device that moves between builds (dev build replaced by TestFlight) must
// be able to correct itself without re-registering from scratch.
test("PATCH can correct a device's environment", async () => {
  const t = await startTestApp();
  try {
    const { session, identity } = await setup(t);
    const device = await registerDevice(t, session, {
      name: "was-dev", apnsToken: "g".repeat(64), apnsEnvironment: "development",
    });

    const patched = await api(t.baseUrl, "PATCH", `/v1/devices/${device.id}`, {
      body: { apnsEnvironment: "production" },
      ...authed(session.sessionToken),
    });
    assert.equal(patched.status, 200, JSON.stringify(patched.json));

    const sent = await fanout(t, identity);
    assert.equal(sent[0].host, PROD_HOST);
  } finally { await t.close(); }
});

// The column is added by migration to databases that predate it. A row written
// the old way must still be readable and pushable.
test("a pre-existing device row survives the migration", async () => {
  const t = await startTestApp();
  try {
    const { session, identity } = await setup(t);
    // Write the row the way the old code did — no environment column value.
    t.app.db.prepare(
      "INSERT INTO devices (id, account_id, apns_token, platform, name, cert_serials, created_at, updated_at) " +
      "VALUES ('legacy-1', ?, ?, 'ios', 'old', '[]', 1, 1)",
    ).run(session.accountId, "h".repeat(64));

    const listed = t.app.registry.listPushDevices(session.accountId);
    assert.equal(listed.length, 1);
    assert.equal(listed[0].apnsEnvironment, null);

    const sent = await fanout(t, identity);
    assert.equal(sent.length, 1);
  } finally { await t.close(); }
});
