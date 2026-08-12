import test from "node:test";
import assert from "node:assert/strict";

import { createDb } from "../src/db.js";
import { createRegistry } from "../src/registry.js";
import { startTestApp, api, signIn, authed } from "./helpers.mjs";

const start = (t) => api(t.baseUrl, "POST", "/v1/auth/device/start", { body: {} });
const poll = (t, deviceCode) => api(t.baseUrl, "POST", "/v1/auth/device/token", { body: { deviceCode } });
const approve = (t, sessionToken, userCode) =>
  api(t.baseUrl, "POST", "/v1/auth/device/approve", { body: { userCode }, ...authed(sessionToken) });

test("full device-code flow: start, poll pending, approve, poll returns a session", async () => {
  const t = await startTestApp();
  try {
    const started = await start(t);
    assert.equal(started.status, 201);
    assert.match(started.json.deviceCode, /^[A-Za-z0-9_-]{43}$/);
    assert.match(started.json.userCode, /^[BCDFGHJKLMNPQRSTVWXZ2-9]{4}-[BCDFGHJKLMNPQRSTVWXZ2-9]{4}$/);
    assert.equal(started.json.interval, 5);
    assert.ok(started.json.verificationUri.length > 0);

    const pending = await poll(t, started.json.deviceCode);
    assert.equal(pending.status, 400);
    assert.equal(pending.json.error, "authorization_pending");

    const session = await signIn(t);
    assert.equal((await approve(t, session.sessionToken, started.json.userCode.toLowerCase())).status, 200);

    const granted = await poll(t, started.json.deviceCode);
    assert.equal(granted.status, 200);
    assert.equal(granted.json.accountId, session.accountId);
    assert.ok(granted.json.sessionToken.length > 0);
  } finally { await t.close(); }
});

test("a device code is single-use", async () => {
  const t = await startTestApp();
  try {
    const started = await start(t);
    const session = await signIn(t);
    await approve(t, session.sessionToken, started.json.userCode);
    await poll(t, started.json.deviceCode);

    const second = await poll(t, started.json.deviceCode);
    assert.equal(second.status, 400);
    assert.equal(second.json.error, "invalid_grant");
  } finally { await t.close(); }
});

// The atomic `AND consumed_at IS NULL` on the consuming UPDATE is what makes
// single-use race-safe, and nothing tested it: with the guard dropped, or
// with the UPDATE's return value ignored, every concurrent poll on one
// approved code is handed its own session.
test("concurrent polls on one approved code redeem it exactly once", async () => {
  const t = await startTestApp();
  try {
    const started = await start(t);
    const session = await signIn(t);
    await approve(t, session.sessionToken, started.json.userCode);

    const results = await Promise.all(
      Array.from({ length: 12 }, () => poll(t, started.json.deviceCode)),
    );
    const granted = results.filter((r) => r.status === 200);
    assert.equal(granted.length, 1, `${granted.length} concurrent polls were each granted a session`);
    for (const failed of results.filter((r) => r.status !== 200)) {
      assert.equal(failed.json.error, "invalid_grant");
    }
  } finally { await t.close(); }
});

// A redeemed code must report exactly what an unknown one reports. With the
// route's re-use check gone the atomic consume still refuses the redemption,
// but the answer changes to `expired_token` once the row ages out — an oracle
// that separates "this code existed and was used" from "this code never
// existed".
test("a redeemed code stays invalid_grant even after it expires", async () => {
  const t = await startTestApp();
  try {
    const started = await start(t);
    const session = await signIn(t);
    await approve(t, session.sessionToken, started.json.userCode);
    assert.equal((await poll(t, started.json.deviceCode)).status, 200);

    t.clock.t += 16 * 60 * 1000;
    const res = await poll(t, started.json.deviceCode);
    assert.equal(res.json.error, "invalid_grant",
      "a redeemed code reported its expiry, distinguishing it from an unknown code");
  } finally { await t.close(); }
});

test("an expired device code is refused and swept", async () => {
  const t = await startTestApp();
  try {
    const started = await start(t);
    t.clock.t += 16 * 60 * 1000;

    const res = await poll(t, started.json.deviceCode);
    assert.equal(res.status, 400);
    assert.equal(res.json.error, "expired_token");

    t.app.runSweeps();
    const after = await poll(t, started.json.deviceCode);
    assert.equal(after.json.error, "invalid_grant", "swept rows become indistinguishable from unknown codes");
  } finally { await t.close(); }
});

// The TTL is configured in SECONDS and stored in MILLISECONDS. A missing
// ×1000 makes every code expire 900 ms after it is minted — indistinguishable
// from a healthy service to a test that only ever checks the far side of the
// expiry. This is the same unit bug the config comment beside these keys warns
// about at length.
test("the device-code TTL is seconds, not milliseconds", async () => {
  const t = await startTestApp();
  try {
    const started = await start(t);
    assert.equal(started.json.expiresIn, 900);

    t.clock.t += 60 * 1000;
    const pending = await poll(t, started.json.deviceCode);
    assert.equal(pending.json.error, "authorization_pending", "a code minted a minute ago had already expired");

    t.clock.t += 840 * 1000;
    assert.equal((await poll(t, started.json.deviceCode)).json.error, "expired_token");
  } finally { await t.close(); }
});

// The sweep must delete EXPIRED rows, not every row: a sweep that clears the
// table on its 60-second tick breaks every login in flight, and does it
// silently.
test("the sweep leaves live pending codes alone", async () => {
  const t = await startTestApp();
  try {
    const started = await start(t);
    t.app.runSweeps();

    const pending = await poll(t, started.json.deviceCode);
    assert.equal(pending.json.error, "authorization_pending", "a live pending code was swept");
  } finally { await t.close(); }
});

test("an unknown device code or user code never reveals which", async () => {
  const t = await startTestApp();
  try {
    const token = await poll(t, "nope");
    assert.equal(token.status, 400);
    assert.equal(token.json.error, "invalid_grant");

    const session = await signIn(t);
    const res = await approve(t, session.sessionToken, "ZZZZ-ZZZZ");
    assert.equal(res.status, 404);
    assert.equal(res.json.error, "unknown_user_code");
  } finally { await t.close(); }
});

// The only "unknown device code" assertion used to run against an EMPTY
// table, so neutering the lookup to `WHERE device_code_hash = ? OR 1=1` was
// invisible: any string redeemed the victim's approved code. The table must be
// populated and the victim's code must be approved and waiting.
test("a wrong device code cannot redeem an approved code that is waiting in the table", async () => {
  const t = await startTestApp();
  try {
    const victim = await start(t);
    await start(t);
    await start(t);
    const session = await signIn(t);
    await approve(t, session.sessionToken, victim.json.userCode);

    for (const wrong of ["TOTALLY-WRONG-DEVICE-CODE", "", "nope", victim.json.deviceCode.slice(0, -1),
      `${victim.json.deviceCode}x`, victim.json.userCode]) {
      const res = await poll(t, wrong);
      assert.equal(res.status, 400, `a wrong device code was accepted: ${JSON.stringify(wrong)}`);
      assert.equal(res.json.error, "invalid_grant");
      assert.equal(res.json.sessionToken, undefined);
    }

    // The victim's own code is still redeemable — the refusals above are the
    // lookup working, not the code having been destroyed.
    const granted = await poll(t, victim.json.deviceCode);
    assert.equal(granted.status, 200);
    assert.equal(granted.json.accountId, session.accountId);
  } finally { await t.close(); }
});

// The same hole on the user-code side: with the lookup neutered, approving a
// nonexistent code approves whichever row comes back first.
test("a wrong user code cannot approve a pending code that is waiting in the table", async () => {
  const t = await startTestApp();
  try {
    const victim = await start(t);
    await start(t);
    const session = await signIn(t);

    // Wrong value, wrong length, and empty — none may touch the pending row.
    for (const wrong of ["ZZZZ-ZZZZ", "BBBB-BBBB", victim.json.userCode.slice(0, 7),
      `${victim.json.userCode}X`, "", "        "]) {
      const res = await approve(t, session.sessionToken, wrong);
      assert.equal(res.status, 404, `a wrong user code was accepted: ${JSON.stringify(wrong)}`);
      assert.equal(res.json.error, "unknown_user_code");
    }

    const stillPending = await poll(t, victim.json.deviceCode);
    assert.equal(stillPending.json.error, "authorization_pending", "a wrong user code approved the pending code");
  } finally { await t.close(); }
});

// Nothing tested that either code is unpredictable: a constant 43-character
// device code and a constant BBBB-BBBB user code both satisfy the shape
// assertions in the happy-path test.
test("each start mints a fresh device code and a fresh user code", async () => {
  const t = await startTestApp();
  try {
    const deviceCodes = new Set();
    const userCodes = new Set();
    for (let i = 0; i < 8; i++) {
      const started = await start(t);
      deviceCodes.add(started.json.deviceCode);
      userCodes.add(started.json.userCode);
    }
    assert.equal(deviceCodes.size, 8, "device codes repeat across starts");
    assert.equal(userCodes.size, 8, "user codes repeat across starts");
  } finally { await t.close(); }
});

test("approving requires a session", async () => {
  const t = await startTestApp();
  try {
    const started = await start(t);
    const res = await api(t.baseUrl, "POST", "/v1/auth/device/approve", { body: { userCode: started.json.userCode } });
    assert.equal(res.status, 401);
  } finally { await t.close(); }
});

// ── T5-I2: approval is a one-time transition ──────────────────────────────
//
// `approveDeviceCode` was an unconditional UPDATE, so a second account could
// silently rebind an already-approved code and the victim's CLI would receive
// a session for the ATTACKER's account. Every subsequent `relay handoff` then
// targets the attacker's node, and `relay sync-auth` seals the victim's GitHub
// token and harness credentials to the attacker's node key and delivers them
// to the attacker's sandbox. One missing clause, full credential compromise.
test("an approved code cannot be rebound to a second account", async () => {
  const t = await startTestApp();
  try {
    const started = await start(t);
    const victim = await signIn(t, { sub: "victim", email: "victim@example.com" });
    const attacker = await signIn(t, { sub: "attacker", email: "attacker@example.com" });

    assert.equal((await approve(t, victim.sessionToken, started.json.userCode)).status, 200);

    const reapprove = await approve(t, attacker.sessionToken, started.json.userCode);
    assert.equal(reapprove.status, 404, "a second account silently rebound an approved code");
    assert.equal(reapprove.json.error, "unknown_user_code");

    const granted = await poll(t, started.json.deviceCode);
    assert.equal(granted.status, 200);
    assert.equal(granted.json.accountId, victim.accountId, "the CLI received a session for the wrong account");
    assert.notEqual(granted.json.accountId, attacker.accountId);
  } finally { await t.close(); }
});

// Re-approval by the SAME account must fail too: an approval is a transition,
// not an idempotent write, and "who approved it" must not decide whether the
// second write lands.
test("even the approving account cannot approve the same code twice", async () => {
  const t = await startTestApp();
  try {
    const started = await start(t);
    const session = await signIn(t);
    assert.equal((await approve(t, session.sessionToken, started.json.userCode)).status, 200);
    assert.equal((await approve(t, session.sessionToken, started.json.userCode)).status, 404);
  } finally { await t.close(); }
});

test("an expired code cannot be approved", async () => {
  // A short code TTL rather than a long clock jump, so what expires is the
  // device code and not the approver's own session.
  const t = await startTestApp({ env: { DEVICE_CODE_TTL_SEC: "1" } });
  try {
    const started = await start(t);
    const session = await signIn(t);
    t.clock.t += 2000;

    const res = await approve(t, session.sessionToken, started.json.userCode);
    assert.equal(res.status, 404, "an expired code was approved");
    assert.equal(res.json.error, "unknown_user_code");
  } finally { await t.close(); }
});

test("a redeemed code cannot be approved again", async () => {
  const t = await startTestApp();
  try {
    const started = await start(t);
    const victim = await signIn(t, { sub: "victim", email: "victim@example.com" });
    await approve(t, victim.sessionToken, started.json.userCode);
    assert.equal((await poll(t, started.json.deviceCode)).status, 200);

    const attacker = await signIn(t, { sub: "attacker", email: "attacker@example.com" });
    const res = await approve(t, attacker.sessionToken, started.json.userCode);
    assert.equal(res.status, 404);
    assert.equal((await poll(t, started.json.deviceCode)).json.error, "invalid_grant");
  } finally { await t.close(); }
});

// ── T5-I1: the poll lookup must be indexed, and starts must be bounded ────
//
// `device_code_hash` is read on EVERY poll. Unindexed it is a full table
// scan, and `node:sqlite` is synchronous, so at 500k rows that is ~11.6 ms of
// blocked event loop per poll — on a table any unauthenticated caller can
// grow for free.
test("the device-code poll lookup is index-backed, not a table scan", () => {
  const db = createDb(":memory:");
  const plan = (sql) => db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all().map((r) => r.detail).join(" ");

  const byHash = plan("SELECT * FROM device_codes WHERE device_code_hash = ?");
  assert.ok(byHash.includes("USING INDEX"), `poll lookup is not indexed: ${byHash}`);
  assert.ok(!byHash.includes("SCAN"), `poll lookup scans the table: ${byHash}`);

  const byUserCode = plan("SELECT * FROM device_codes WHERE user_code = ?");
  assert.ok(byUserCode.includes("USING INDEX"), `approve lookup is not indexed: ${byUserCode}`);
});

test("unauthenticated callers cannot grow the device-code table without bound", async () => {
  const t = await startTestApp({ env: { DEVICE_CODE_MAX_LIVE: "5" } });
  try {
    for (let i = 0; i < 5; i++) assert.equal((await start(t)).status, 201);

    const refused = await start(t);
    assert.equal(refused.status, 429, "the live-code ceiling did not hold");
    assert.equal(refused.json.error, "slow_down");
    assert.equal(refused.json.deviceCode, undefined);

    // Capacity that has genuinely expired is reclaimed on the next start, so
    // the ceiling cannot be pinned shut by a burst that has aged out.
    t.clock.t += 16 * 60 * 1000;
    assert.equal((await start(t)).status, 201);
  } finally { await t.close(); }
});

// ── registry-level invariants ─────────────────────────────────────────────

test("deleting an account destroys its device codes", () => {
  const clock = { t: 1_800_000_000_000 };
  const registry = createRegistry(createDb(":memory:"), { now: () => clock.t });
  const account = registry.createAccount({ appleSub: "apple-1", email: "a@example.com" });
  const record = registry.createDeviceCode({
    deviceCodeHash: "a".repeat(64), userCode: "BCDF-GHJK", expiresAt: clock.t + 900_000,
  });
  assert.notEqual(registry.approveDeviceCode(record.id, account.id), null);
  assert.equal(registry.getDeviceCodeByHash("a".repeat(64)).accountId, account.id);

  registry.deleteAccount(account.id);
  assert.equal(registry.getDeviceCodeByHash("a".repeat(64)), null);
});

test("approveDeviceCode reports whether the transition happened", () => {
  const clock = { t: 1_800_000_000_000 };
  const registry = createRegistry(createDb(":memory:"), { now: () => clock.t });
  const first = registry.createAccount({ appleSub: "apple-1", email: "a@example.com" });
  const second = registry.createAccount({ appleSub: "apple-2", email: "b@example.com" });
  const record = registry.createDeviceCode({
    deviceCodeHash: "b".repeat(64), userCode: "BCDF-GHJK", expiresAt: clock.t + 900_000,
  });

  assert.equal(registry.approveDeviceCode(record.id, first.id).accountId, first.id);
  assert.equal(registry.approveDeviceCode(record.id, second.id), null, "a second approval overwrote the first");
  assert.equal(registry.getDeviceCodeByHash("b".repeat(64)).accountId, first.id);
});

// Redemption is single-use in the WRITE, not in the read that precedes it.
// The route's re-use check makes this invisible over HTTP — the server is
// single-threaded and nothing awaits between the read and the consume — so
// the property has to be pinned where it actually lives.
test("consumeDeviceCode is a one-time transition", () => {
  const clock = { t: 1_800_000_000_000 };
  const registry = createRegistry(createDb(":memory:"), { now: () => clock.t });
  const account = registry.createAccount({ appleSub: "apple-1", email: "a@example.com" });
  const record = registry.createDeviceCode({
    deviceCodeHash: "e".repeat(64), userCode: "BCDF-GHJK", expiresAt: clock.t + 900_000,
  });
  registry.approveDeviceCode(record.id, account.id);

  assert.equal(registry.consumeDeviceCode(record.id), true);
  assert.equal(registry.consumeDeviceCode(record.id), false, "a device code was redeemed twice");
  assert.equal(registry.consumeDeviceCode(record.id), false);
});

test("a redeemed code cannot be approved, whoever asks", () => {
  const clock = { t: 1_800_000_000_000 };
  const registry = createRegistry(createDb(":memory:"), { now: () => clock.t });
  const account = registry.createAccount({ appleSub: "apple-1", email: "a@example.com" });
  const record = registry.createDeviceCode({
    deviceCodeHash: "f".repeat(64), userCode: "BCDF-GHJK", expiresAt: clock.t + 900_000,
  });
  assert.equal(registry.consumeDeviceCode(record.id), true);
  assert.equal(registry.approveDeviceCode(record.id, account.id), null, "a redeemed code was approved");
  assert.equal(registry.getDeviceCodeByHash("f".repeat(64)).accountId, null);
});

test("a consumed device code does not linger past the next sweep", () => {
  const clock = { t: 1_800_000_000_000 };
  const registry = createRegistry(createDb(":memory:"), { now: () => clock.t });
  const account = registry.createAccount({ appleSub: "apple-1", email: "a@example.com" });
  const record = registry.createDeviceCode({
    deviceCodeHash: "c".repeat(64), userCode: "BCDF-GHJK", expiresAt: clock.t + 900_000,
  });
  registry.approveDeviceCode(record.id, account.id);
  assert.equal(registry.consumeDeviceCode(record.id), true);

  registry.sweepDeviceCodes(clock.t);
  assert.equal(registry.getDeviceCodeByUserCode("BCDF-GHJK"), null, "a redeemed row pinned its user_code");
});

test("mapDeviceCode returns numbers for the integer columns", () => {
  const clock = { t: 1_800_000_000_000 };
  const registry = createRegistry(createDb(":memory:"), { now: () => clock.t });
  const record = registry.createDeviceCode({
    deviceCodeHash: "d".repeat(64), userCode: "BCDF-GHJK", expiresAt: clock.t + 900_000,
  });
  assert.equal(typeof record.expiresAt, "number");
  assert.equal(typeof record.createdAt, "number");
  assert.equal(record.accountId, null);
  assert.equal(record.approvedAt, null);
  assert.equal(record.consumedAt, null);
});
