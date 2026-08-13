// One row per (account, push token).
//
// The app calls POST /v1/devices on every launch, and the handler inserted
// unconditionally — so one phone accumulated one row per launch and the fanout
// sent one push PER ROW. A single handoff arrived as four identical "Session
// ready" banners. At the point this was found, production held 42 device rows
// across 3 distinct tokens: 34 rows / 2 tokens on one account, and 8 rows for a
// single token on another, six of them created within nine minutes.

import test from "node:test";
import assert from "node:assert/strict";

import { startTestApp, api, authed, signIn, makeNodeIdentity } from "./helpers.mjs";

const NODE_ID = "node-00112233445566aa";
const TOKEN = "a".repeat(64);

async function register(t, session, overrides = {}) {
  const res = await api(t.baseUrl, "POST", "/v1/devices", {
    body: { name: "iPhone", platform: "ios", apnsToken: TOKEN, ...overrides },
    ...authed(session.sessionToken),
  });
  assert.equal(res.status, 201, JSON.stringify(res.json));
  return res.json.device;
}

test("re-registering the same token updates the row instead of adding one", async () => {
  const t = await startTestApp();
  try {
    const session = await signIn(t);
    const first = await register(t, session);
    const second = await register(t, session, { name: "iPhone renamed" });

    assert.equal(second.id, first.id, "the same device must keep its identity");
    assert.equal(second.name, "iPhone renamed", "later registrations still refresh the row");
    assert.equal(t.app.registry.listPushDevices(session.accountId).length, 1);
  } finally { await t.close(); }
});

// The observed shape: an app that registers on every launch.
test("ten launches produce one row, not ten", async () => {
  const t = await startTestApp();
  try {
    const session = await signIn(t);
    for (let i = 0; i < 10; i += 1) await register(t, session);
    assert.equal(t.app.registry.listPushDevices(session.accountId).length, 1);
  } finally { await t.close(); }
});

// The user-visible symptom, stated as a test: one push per handoff, not four.
test("one handoff produces exactly one push per physical device", async () => {
  const t = await startTestApp();
  try {
    const session = await signIn(t);
    const identity = makeNodeIdentity();
    t.app.registry.createNode(session.accountId, {
      id: NODE_ID, kind: "trial", name: "Trial", pubkey: identity.pubkeyPem,
    });
    for (let i = 0; i < 4; i += 1) await register(t, session);

    const body = Buffer.from(
      JSON.stringify({ v: 1, nodeId: NODE_ID, jobId: null, type: "handoff.ready", ts: t.clock.t, seq: 1 }),
      "utf8",
    );
    await api(t.baseUrl, "POST", "/v1/node-events", {
      raw: body, headers: { "x-relay-signature": identity.signBody(body) },
    });
    await t.app.notify.drain();

    assert.equal(
      t.apnsTransport.requests.length, 1,
      "four registrations of one phone must not become four banners",
    );
  } finally { await t.close(); }
});

// Two genuinely different phones are two rows.
test("distinct tokens remain distinct devices", async () => {
  const t = await startTestApp();
  try {
    const session = await signIn(t);
    await register(t, session);
    await register(t, session, { apnsToken: "b".repeat(64), name: "iPad" });
    assert.equal(t.app.registry.listPushDevices(session.accountId).length, 2);
  } finally { await t.close(); }
});

// The same physical device signed into two accounts is genuinely two rows —
// the key is (account, token), not token alone.
test("the same token on two accounts stays two rows", async () => {
  const t = await startTestApp();
  try {
    const a = await signIn(t);
    const b = await signIn(t, { sub: "apple-second", email: "second@example.test" });
    await register(t, a);
    await register(t, b);
    assert.equal(t.app.registry.listPushDevices(a.accountId).length, 1);
    assert.equal(t.app.registry.listPushDevices(b.accountId).length, 1);
  } finally { await t.close(); }
});

// A device registering before it has a token (permission not yet granted) must
// still work, and must not be collapsed with any other tokenless row.
test("rows without a token are untouched by the uniqueness rule", async () => {
  const t = await startTestApp();
  try {
    const session = await signIn(t);
    for (const name of ["mac-cli", "other-cli"]) {
      const res = await api(t.baseUrl, "POST", "/v1/devices", {
        body: { name, platform: "macos", apnsToken: null },
        ...authed(session.sessionToken),
      });
      assert.equal(res.status, 201);
    }
    assert.equal(t.app.registry.listDevices(session.accountId).length, 2);
    assert.equal(t.app.registry.listPushDevices(session.accountId).length, 0);
  } finally { await t.close(); }
});

// The migration has to collapse rows that already exist, since production is
// where they accumulated. Keep the newest; nothing unique is lost because every
// dropped row addressed the same device.
test("existing duplicate rows are collapsed on open, keeping the newest", async () => {
  const t = await startTestApp();
  try {
    const session = await signIn(t);
    // Simulate a database from before the index existed. Dropping it is the
    // only way to write the duplicates production actually accumulated — which
    // is itself the proof that the index makes them unrepresentable now.
    t.app.db.exec("DROP INDEX IF EXISTS idx_devices_account_token");
    for (let i = 0; i < 5; i += 1) {
      t.app.db.prepare(
        "INSERT INTO devices (id, account_id, apns_token, platform, name, cert_serials, created_at, updated_at) " +
        "VALUES (?, ?, ?, 'ios', ?, '[]', ?, ?)",
      ).run(`dup-${i}`, session.accountId, TOKEN, `launch-${i}`, 1000 + i, 1000 + i);
    }
    assert.equal(t.app.registry.listPushDevices(session.accountId).length, 5);

    // Re-open the same database: migrations run again.
    const reopened = await startTestApp({ db: t.app.db });
    try {
      const rows = reopened.app.registry.listPushDevices(session.accountId);
      assert.equal(rows.length, 1, "duplicates collapse");
      assert.equal(rows[0].name, "launch-4", "the newest row survives");
    } finally { await reopened.close(); }
  } finally { await t.close(); }
});
