import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { createDb } from "../src/db.js";
import { createRegistry } from "../src/registry.js";
import { startTestApp, api, signIn, authed } from "./helpers.mjs";
import { mintUserCode, USER_CODE_ALPHABET } from "../src/server.js";

const start = (t) => api(t.baseUrl, "POST", "/v1/auth/device/start", { body: {} });
const poll = (t, deviceCode) => api(t.baseUrl, "POST", "/v1/auth/device/token", { body: { deviceCode } });
const approve = (t, sessionToken, userCode) =>
  api(t.baseUrl, "POST", "/v1/auth/device/approve", { body: { userCode }, ...authed(sessionToken) });
const linkedComputer = (t, sessionToken) =>
  api(t.baseUrl, "GET", "/v1/auth/device/link", authed(sessionToken));
const disconnectComputer = (t, sessionToken) =>
  api(t.baseUrl, "DELETE", "/v1/auth/device/link", authed(sessionToken));

test("full device-code flow: start, poll pending, approve, poll returns a session", async () => {
  const t = await startTestApp();
  try {
    // `.toLowerCase()` below is meant to prove approval is case-insensitive,
    // but USER_CODE_ALPHABET mixes 20 letters and 8 digits — if the minted
    // code happens to be all digits (~0.0037% of draws), toLowerCase() is
    // the identity function and the approve() call is byte-identical to the
    // already-covered exact-case path, never touching normalizeUserCode's
    // case fold at all. Retry with a fresh start() until the code contains a
    // letter, and assert the premise so a stuck loop fails loudly.
    //
    // The same loop also waits for deviceCode (base64url of randomBytes(32))
    // to need a -/_ substitution character: the shape assertion below can't
    // tell a base64url spelling from a std-base64-stripped regression on the
    // ~26.4% of draws where the two are byte-identical. Nothing downstream
    // alphabet-validates deviceCode the way the cloud's AUTH_TOKEN_RE does
    // for a pairing authToken, so this is lower stakes than finding 2 — but
    // it is free to fold into the retry already needed for userCode above.
    let started = null;
    for (let attempt = 0; attempt < 64; attempt++) {
      const candidate = await start(t);
      assert.equal(candidate.status, 201);
      if (/[A-Z]/.test(candidate.json.userCode) && /[-_]/.test(candidate.json.deviceCode)) { started = candidate; break; }
    }
    assert.ok(started,
      "could not mint a userCode with a letter and a deviceCode needing a base64url substitution character " +
      "after 64 attempts — the test premise is broken, not the code under test");
    assert.match(started.json.deviceCode, /^[A-Za-z0-9_-]{43}$/);
    assert.match(started.json.userCode, /^[BCDFGHJKLMNPQRSTVWXZ2-9]{4}-[BCDFGHJKLMNPQRSTVWXZ2-9]{4}$/);
    assert.equal(started.json.interval, 5);
    assert.ok(started.json.verificationUri.length > 0);

    const pending = await poll(t, started.json.deviceCode);
    assert.equal(pending.status, 400);
    assert.equal(pending.json.error, "authorization_pending");

    const session = await signIn(t);
    assert.notEqual(started.json.userCode, started.json.userCode.toLowerCase(),
      "sanity: this fixture must actually contain a letter to exercise the case fold");
    assert.equal((await approve(t, session.sessionToken, started.json.userCode.toLowerCase())).status, 200);

    const connecting = await linkedComputer(t, session.sessionToken);
    assert.equal(connecting.status, 200);
    assert.equal(connecting.json.computer.status, "connecting");

    const granted = await poll(t, started.json.deviceCode);
    assert.equal(granted.status, 200);
    assert.equal(granted.json.accountId, session.accountId);
    assert.ok(granted.json.sessionToken.length > 0);

    const connected = await linkedComputer(t, session.sessionToken);
    assert.equal(connected.json.computer.status, "connected");
    assert.equal(typeof connected.json.computer.connectedAt, "number");
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
test("an account with a reserved computer slot cannot approve another code", async () => {
  const t = await startTestApp();
  try {
    const started = await start(t);
    const session = await signIn(t);
    assert.equal((await approve(t, session.sessionToken, started.json.userCode)).status, 200);
    const second = await start(t);
    const refused = await approve(t, session.sessionToken, second.json.userCode);
    assert.equal(refused.status, 409);
    assert.equal(refused.json.error, "computer_already_linked");
    assert.equal((await poll(t, second.json.deviceCode)).json.error, "authorization_pending");
  } finally { await t.close(); }
});

test("disconnect revokes the linked computer and frees the one-computer slot", async () => {
  const t = await startTestApp();
  try {
    const phone = await signIn(t);
    const first = await start(t);
    assert.equal((await approve(t, phone.sessionToken, first.json.userCode)).status, 200);
    const cli = await poll(t, first.json.deviceCode);
    assert.equal(cli.status, 200);

    assert.equal((await api(t.baseUrl, "GET", "/v1/account", authed(cli.json.sessionToken))).status, 200);
    const removed = await disconnectComputer(t, phone.sessionToken);
    assert.equal(removed.status, 200);
    assert.equal(removed.json.disconnected.status, "connected");
    assert.equal((await linkedComputer(t, phone.sessionToken)).json.computer, null);

    assert.equal(
      (await api(t.baseUrl, "GET", "/v1/account", authed(cli.json.sessionToken))).status,
      401,
      "disconnect left the computer's live session usable",
    );
    const refreshed = await api(t.baseUrl, "POST", "/v1/auth/refresh", {
      body: { refreshToken: cli.json.refreshToken },
    });
    assert.equal(refreshed.status, 401, "disconnect left the computer's refresh token usable");

    const replacement = await start(t);
    assert.equal((await approve(t, phone.sessionToken, replacement.json.userCode)).status, 200);
    assert.equal((await poll(t, replacement.json.deviceCode)).status, 200);
  } finally { await t.close(); }
});

test("disconnecting a pending approval prevents its computer from redeeming", async () => {
  const t = await startTestApp();
  try {
    const phone = await signIn(t);
    const started = await start(t);
    assert.equal((await approve(t, phone.sessionToken, started.json.userCode)).status, 200);
    assert.equal((await linkedComputer(t, phone.sessionToken)).json.computer.status, "connecting");

    assert.equal((await disconnectComputer(t, phone.sessionToken)).status, 200);
    const denied = await poll(t, started.json.deviceCode);
    assert.equal(denied.status, 400);
    assert.equal(denied.json.error, "invalid_grant");
  } finally { await t.close(); }
});

test("an expired pending approval frees the computer slot", async () => {
  const t = await startTestApp({ env: { DEVICE_CODE_TTL_SEC: "1" } });
  try {
    const phone = await signIn(t);
    const started = await start(t);
    assert.equal((await approve(t, phone.sessionToken, started.json.userCode)).status, 200);
    assert.equal((await linkedComputer(t, phone.sessionToken)).json.computer.status, "connecting");

    t.clock.t += 2_000;
    t.app.runSweeps();
    assert.equal((await linkedComputer(t, phone.sessionToken)).json.computer, null);

    const replacement = await start(t);
    assert.equal((await approve(t, phone.sessionToken, replacement.json.userCode)).status, 200);
  } finally { await t.close(); }
});

test("replaying a CLI refresh token disconnects only that computer", async () => {
  const t = await startTestApp();
  try {
    const phone = await signIn(t);
    const started = await start(t);
    await approve(t, phone.sessionToken, started.json.userCode);
    const cli = await poll(t, started.json.deviceCode);
    const rotated = await api(t.baseUrl, "POST", "/v1/auth/refresh", {
      body: { refreshToken: cli.json.refreshToken },
    });
    assert.equal(rotated.status, 200);

    const replayed = await api(t.baseUrl, "POST", "/v1/auth/refresh", {
      body: { refreshToken: cli.json.refreshToken },
    });
    assert.equal(replayed.status, 401);
    assert.equal((await linkedComputer(t, phone.sessionToken)).json.computer, null);
    assert.equal((await api(t.baseUrl, "GET", "/v1/account", authed(phone.sessionToken))).status, 200);
    assert.equal((await api(t.baseUrl, "GET", "/v1/account", authed(rotated.json.sessionToken))).status, 401);
    assert.equal(
      (await api(t.baseUrl, "POST", "/v1/auth/refresh", {
        body: { refreshToken: rotated.json.refreshToken },
      })).status,
      401,
    );
  } finally { await t.close(); }
});

test("replaying an old computer token cannot disconnect its replacement", async () => {
  const t = await startTestApp();
  try {
    const phone = await signIn(t);
    const first = await start(t);
    await approve(t, phone.sessionToken, first.json.userCode);
    const oldCli = await poll(t, first.json.deviceCode);
    await disconnectComputer(t, phone.sessionToken);

    const second = await start(t);
    await approve(t, phone.sessionToken, second.json.userCode);
    const replacement = await poll(t, second.json.deviceCode);
    const current = await linkedComputer(t, phone.sessionToken);
    assert.equal(current.json.computer.status, "connected");

    assert.equal(
      (await api(t.baseUrl, "POST", "/v1/auth/refresh", {
        body: { refreshToken: oldCli.json.refreshToken },
      })).status,
      401,
    );
    assert.equal((await linkedComputer(t, phone.sessionToken)).json.computer.id, current.json.computer.id);
    assert.equal((await api(t.baseUrl, "GET", "/v1/account", authed(replacement.json.sessionToken))).status, 200);
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

// Correction to a previously accepted residual: the global ceiling alone
// bounds the TABLE but not who fills it. An attacker holding
// DEVICE_CODE_MAX_LIVE codes could deny every other caller a code for the
// rest of the TTL window. nginx sets `X-Real-IP $remote_addr`
// (deploy/relay-cloud.nginx.conf.template) and the app binds 127.0.0.1, so
// nginx is the only possible peer and the header is a trustworthy per-IP
// signal — this test presents it exactly as nginx would, over the app's own
// HTTP surface, the same trust boundary as production.
test("a per-IP ceiling stops one caller from denying every other caller a code", async () => {
  const t = await startTestApp({ env: { DEVICE_CODE_MAX_LIVE: "50", DEVICE_CODE_MAX_LIVE_PER_IP: "3" } });
  try {
    const startFrom = (ip) => api(t.baseUrl, "POST", "/v1/auth/device/start", { body: {}, headers: { "x-real-ip": ip } });

    for (let i = 0; i < 3; i++) assert.equal((await startFrom("203.0.113.5")).status, 201);
    const refused = await startFrom("203.0.113.5");
    assert.equal(refused.status, 429, "the per-IP ceiling did not hold");
    assert.equal(refused.json.error, "slow_down");
    assert.equal(refused.json.deviceCode, undefined);

    // The whole point: a DIFFERENT IP is unaffected by the first one's usage.
    const other = await startFrom("198.51.100.9");
    assert.equal(other.status, 201, "a different IP must not be denied by another IP's usage");

    // Reclaim applies per-IP too, exactly like the global ceiling above.
    t.clock.t += 16 * 60 * 1000;
    assert.equal((await startFrom("203.0.113.5")).status, 201);
  } finally { await t.close(); }
});

// A caller with no trusted X-Real-IP (direct-to-app, no proxy in front —
// exactly this test harness) must not be denied by the per-IP ceiling: a
// null IP counts against nothing, and the global ceiling remains the
// backstop for that case. Proves the per-IP check is additive, not a
// replacement that could fail closed for every signal-less caller.
test("a per-IP ceiling of 0 does not block callers with no trusted IP signal", async () => {
  const t = await startTestApp({ env: { DEVICE_CODE_MAX_LIVE_PER_IP: "0" } });
  try {
    assert.equal((await start(t)).status, 201, "no X-Real-IP header must not be denied by the per-IP ceiling");
  } finally { await t.close(); }
});

// Finding 6 (review): mintUserCode's rejection sampling was untested —
// dropping `if (byte >= USER_CODE_MAX_UNBIASED) continue;` (keeping the
// plain modulo) survives the suite. A statistical test of the real entropy
// source would need a large sample to detect a ~1.14x bias reliably, which
// is either flaky (small sample) or slow (large sample) — exactly the shape
// of test this project keeps having to fix. `mintUserCode` instead takes an
// injectable byte source (test-only; every real call site uses the
// default), so this is deterministic: a full 8-byte batch entirely OUT of
// range (252-255, all >= USER_CODE_MAX_UNBIASED=252) must be skipped in its
// entirety rather than folded in via modulo, forcing a second draw.
test("mintUserCode's rejection sampling skips out-of-range bytes instead of folding them in", () => {
  let calls = 0;
  const scripted = [
    Buffer.from([252, 253, 254, 255, 252, 253, 254, 255]), // every byte out of range
    Buffer.from([0, 1, 2, 3, 4, 5, 6, 7]), // every byte in range, deterministic
  ];
  const fakeRandomBytes = (n) => {
    assert.equal(n, 8, "mintUserCode must keep asking for 8 bytes at a time");
    return scripted[calls++];
  };
  const code = mintUserCode(fakeRandomBytes);

  assert.equal(calls, 2,
    "an all-out-of-range batch produced a character — the rejection guard is not filtering, it's folding via modulo");
  const expected = USER_CODE_ALPHABET.slice(0, 8);
  assert.equal(code, `${expected.slice(0, 4)}-${expected.slice(4)}`);
});

// ── registry-level invariants ─────────────────────────────────────────────

test("deleting an account destroys its device codes", () => {
  const clock = { t: 1_800_000_000_000 };
  const registry = createRegistry(createDb(":memory:"), { now: () => clock.t });
  const account = registry.createAccount({ appleSub: "apple-1", email: "a@example.com" });
  const record = registry.createDeviceCode({
    deviceCodeHash: "a".repeat(64), userCode: "BCDF-GHJK", expiresAt: clock.t + 900_000,
  });
  assert.equal(registry.approveDeviceCodeForCliLink(record.id, account.id).status, "approved");
  assert.equal(registry.getDeviceCodeByHash("a".repeat(64)).accountId, account.id);
  assert.notEqual(registry.getCliComputerLink(account.id), null);

  registry.deleteAccount(account.id);
  assert.equal(registry.getDeviceCodeByHash("a".repeat(64)), null);
  assert.equal(registry.getCliComputerLink(account.id), null);
});

test("approveDeviceCodeForCliLink binds one code to one account", () => {
  const clock = { t: 1_800_000_000_000 };
  const registry = createRegistry(createDb(":memory:"), { now: () => clock.t });
  const first = registry.createAccount({ appleSub: "apple-1", email: "a@example.com" });
  const second = registry.createAccount({ appleSub: "apple-2", email: "b@example.com" });
  const record = registry.createDeviceCode({
    deviceCodeHash: "b".repeat(64), userCode: "BCDF-GHJK", expiresAt: clock.t + 900_000,
  });

  assert.equal(registry.approveDeviceCodeForCliLink(record.id, first.id).status, "approved");
  assert.equal(
    registry.approveDeviceCodeForCliLink(record.id, second.id).status,
    "invalid_code",
    "a second approval overwrote the first",
  );
  assert.equal(registry.getDeviceCodeByHash("b".repeat(64)).accountId, first.id);
});

// Redemption is single-use in the WRITE, not in the read that precedes it.
// The route's re-use check makes this invisible over HTTP — the server is
// single-threaded and nothing awaits between the read and the consume — so
// the property has to be pinned where it actually lives.
test("connectCliComputer is a one-time transition", () => {
  const clock = { t: 1_800_000_000_000 };
  const registry = createRegistry(createDb(":memory:"), { now: () => clock.t });
  const account = registry.createAccount({ appleSub: "apple-1", email: "a@example.com" });
  const record = registry.createDeviceCode({
    deviceCodeHash: "e".repeat(64), userCode: "BCDF-GHJK", expiresAt: clock.t + 900_000,
  });
  registry.approveDeviceCodeForCliLink(record.id, account.id);

  assert.notEqual(registry.connectCliComputer(record.id), null);
  assert.equal(registry.connectCliComputer(record.id), null, "a device code was redeemed twice");
  assert.equal(registry.connectCliComputer(record.id), null);
});

test("a disconnected pending code cannot be redeemed or approved", () => {
  const clock = { t: 1_800_000_000_000 };
  const registry = createRegistry(createDb(":memory:"), { now: () => clock.t });
  const account = registry.createAccount({ appleSub: "apple-1", email: "a@example.com" });
  const record = registry.createDeviceCode({
    deviceCodeHash: "f".repeat(64), userCode: "BCDF-GHJK", expiresAt: clock.t + 900_000,
  });
  assert.equal(registry.approveDeviceCodeForCliLink(record.id, account.id).status, "approved");
  registry.disconnectCliComputer(account.id);
  assert.equal(registry.connectCliComputer(record.id), null);
  assert.equal(registry.getDeviceCodeByHash("f".repeat(64)), null);
});

test("a consumed device code does not linger past the next sweep", () => {
  const clock = { t: 1_800_000_000_000 };
  const registry = createRegistry(createDb(":memory:"), { now: () => clock.t });
  const account = registry.createAccount({ appleSub: "apple-1", email: "a@example.com" });
  const record = registry.createDeviceCode({
    deviceCodeHash: "c".repeat(64), userCode: "BCDF-GHJK", expiresAt: clock.t + 900_000,
  });
  registry.approveDeviceCodeForCliLink(record.id, account.id);
  assert.notEqual(registry.connectCliComputer(record.id), null);

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

test("createDeviceCode persists client=web and defaults omitted client to cli", () => {
  const dir = mkdtempSync(join(tmpdir(), "relay-dc-"));
  const db = createDb(join(dir, "t.sqlite"));
  const registry = createRegistry(db);
  const web = registry.createDeviceCode({
    deviceCodeHash: "a".repeat(64),
    userCode: "ABCD-EFGH",
    expiresAt: Date.now() + 60_000,
    client: "web",
  });
  assert.equal(web.client, "web");
  const cli = registry.createDeviceCode({
    deviceCodeHash: "b".repeat(64),
    userCode: "IJKL-MNOP",
    expiresAt: Date.now() + 60_000,
  });
  assert.equal(cli.client, "cli");
  rmSync(dir, { recursive: true, force: true });
});

test("createDb adds CLI link columns to a pre-existing database idempotently", () => {
  const dir = mkdtempSync(join(tmpdir(), "relay-cli-link-migration-"));
  const file = join(dir, "relay.db");
  try {
    const legacy = new DatabaseSync(file);
    legacy.exec(`
      CREATE TABLE refresh_tokens (
        id TEXT PRIMARY KEY, account_id TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE,
        expires_at INTEGER NOT NULL, revoked_at INTEGER, created_at INTEGER NOT NULL
      );
      CREATE TABLE device_codes (
        id TEXT PRIMARY KEY, device_code_hash TEXT NOT NULL, user_code TEXT NOT NULL,
        account_id TEXT, approved_at INTEGER, consumed_at INTEGER, expires_at INTEGER NOT NULL,
        created_at INTEGER NOT NULL, client_ip TEXT, machine_name TEXT, platform TEXT
      );
    `);
    legacy.close();

    for (let open = 0; open < 2; open++) {
      const migrated = createDb(file);
      const refreshColumns = migrated.prepare("PRAGMA table_info(refresh_tokens)").all().map((c) => c.name);
      const deviceCodeColumns = migrated.prepare("PRAGMA table_info(device_codes)").all().map((c) => c.name);
      assert.equal(refreshColumns.filter((name) => name === "cli_link_id").length, 1);
      assert.equal(deviceCodeColumns.filter((name) => name === "cli_link_id").length, 1);
      assert.equal(
        migrated.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'cli_computer_links'").get().name,
        "cli_computer_links",
      );
      migrated.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("single-computer upgrade revokes untracked legacy CLI credentials exactly once", () => {
  const clock = { t: 1_800_000_000_000 };
  const db = createDb(":memory:");
  db.prepare(
    "INSERT INTO accounts (id, apple_sub, email, created_at) VALUES (?, ?, ?, ?)",
  ).run("account-1", "apple-1", "a@example.com", clock.t - 10_000);
  db.prepare(
    `INSERT INTO refresh_tokens
       (id, account_id, token_hash, cli_link_id, expires_at, revoked_at, created_at)
     VALUES (?, ?, ?, NULL, ?, NULL, ?)`,
  ).run("refresh-1", "account-1", "a".repeat(64), clock.t + 900_000, clock.t - 5_000);
  db.prepare(
    `INSERT INTO device_codes
       (id, device_code_hash, user_code, account_id, cli_link_id, approved_at,
        consumed_at, expires_at, created_at, client_ip, machine_name, platform)
     VALUES (?, ?, ?, ?, NULL, ?, NULL, ?, ?, NULL, ?, ?)`,
  ).run(
    "code-1", "b".repeat(64), "BCDF-GHJK", "account-1", clock.t - 4_000,
    clock.t + 900_000, clock.t - 5_000, "old-mac", "macos",
  );

  createRegistry(db, { now: () => clock.t });
  assert.equal(db.prepare("SELECT revoked_at FROM refresh_tokens WHERE id = 'refresh-1'").get().revoked_at, clock.t);
  assert.equal(db.prepare("SELECT session_epoch FROM account_security WHERE account_id = 'account-1'").get().session_epoch, 1);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM device_codes WHERE id = 'code-1'").get().n, 0);

  clock.t += 10_000;
  createRegistry(db, { now: () => clock.t });
  assert.equal(db.prepare("SELECT revoked_at FROM refresh_tokens WHERE id = 'refresh-1'").get().revoked_at, 1_800_000_000_000);
  assert.equal(db.prepare("SELECT session_epoch FROM account_security WHERE account_id = 'account-1'").get().session_epoch, 1);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM relay_migrations WHERE name = 'single_cli_computer_v1'").get().n, 1);
});

// ── QR CLI auth handoff: machine metadata + inspect ───────────────────────

const inspect = (t, sessionToken, userCode) =>
  api(t.baseUrl, "POST", "/v1/auth/device/inspect", { body: { userCode }, ...authed(sessionToken) });

test("device/start stores sanitized machineName and normalized platform, and returns verificationUriComplete", async () => {
  const t = await startTestApp();
  try {
    const res = await api(t.baseUrl, "POST", "/v1/auth/device/start", {
      body: {
        machineName: "  Mac\u0000Book\u0007 Pro  ",
        platform: "darwin",
      },
    });
    assert.equal(res.status, 201);
    assert.match(res.json.userCode, /^[BCDFGHJKLMNPQRSTVWXZ2-9]{4}-[BCDFGHJKLMNPQRSTVWXZ2-9]{4}$/);
    assert.equal(
      res.json.verificationUriComplete,
      `${res.json.verificationUri}#code=${res.json.userCode}`,
    );

    const session = await signIn(t);
    const looked = await inspect(t, session.sessionToken, res.json.userCode);
    assert.equal(looked.status, 200);
    assert.equal(looked.json.machineName, "MacBook Pro");
    assert.equal(looked.json.platform, "other", "unrecognized platform values normalize to other");
    assert.equal(typeof looked.json.createdAt, "number");
    assert.equal(typeof looked.json.expiresAt, "number");
    assert.equal(looked.json.deviceCode, undefined);
  } finally { await t.close(); }
});

test("device/start truncates machineName to 64 chars and accepts known platforms", async () => {
  const t = await startTestApp();
  try {
    const long = "x".repeat(80);
    const res = await api(t.baseUrl, "POST", "/v1/auth/device/start", {
      body: { machineName: long, platform: "macos" },
    });
    assert.equal(res.status, 201);
    const session = await signIn(t);
    const looked = await inspect(t, session.sessionToken, res.json.userCode);
    assert.equal(looked.json.machineName, "x".repeat(64));
    assert.equal(looked.json.platform, "macos");

    for (const [raw, expected] of [
      ["linux", "linux"],
      ["windows", "windows"],
      ["other", "other"],
      ["FreeBSD", "other"],
      ["", null],
    ]) {
      const started = await api(t.baseUrl, "POST", "/v1/auth/device/start", {
        body: { platform: raw },
      });
      const info = await inspect(t, session.sessionToken, started.json.userCode);
      assert.equal(info.json.platform, expected, `platform ${JSON.stringify(raw)}`);
    }
  } finally { await t.close(); }
});

test("device/inspect returns machine metadata for a pending code", async () => {
  const t = await startTestApp();
  try {
    const started = await api(t.baseUrl, "POST", "/v1/auth/device/start", {
      body: { machineName: "dev-box", platform: "linux" },
    });
    const session = await signIn(t);
    const looked = await inspect(t, session.sessionToken, started.json.userCode.toLowerCase());
    assert.equal(looked.status, 200);
    assert.deepEqual(
      { machineName: looked.json.machineName, platform: looked.json.platform },
      { machineName: "dev-box", platform: "linux" },
    );
  } finally { await t.close(); }
});

test("device/inspect hides invalid codes and reports an occupied computer slot", async () => {
  // Short code TTL so expiry does not also kill the approver's session.
  const t = await startTestApp({ env: { DEVICE_CODE_TTL_SEC: "1" } });
  try {
    const session = await signIn(t);
    const unknown = await inspect(t, session.sessionToken, "ZZZZ-ZZZZ");
    assert.equal(unknown.status, 404);
    assert.equal(JSON.stringify(unknown.json), JSON.stringify({ error: "unknown_user_code" }));

    const toExpire = await start(t);
    t.clock.t += 2000;
    const expired = await inspect(t, session.sessionToken, toExpire.json.userCode);
    assert.equal(expired.status, 404);
    assert.equal(JSON.stringify(expired.json), JSON.stringify(unknown.json));
    assert.equal(expired.buf.toString("utf8"), unknown.buf.toString("utf8"));

    const live = await start(t);
    assert.equal((await approve(t, session.sessionToken, live.json.userCode)).status, 200);
    const approved = await inspect(t, session.sessionToken, live.json.userCode);
    assert.equal(approved.status, 404);
    assert.equal(JSON.stringify(approved.json), JSON.stringify({ error: "unknown_user_code" }));

    // Once the owner disconnects, the pending approved code is destroyed and
    // becomes indistinguishable from a code that never existed.
    assert.equal((await disconnectComputer(t, session.sessionToken)).status, 200);
    const afterDisconnect = await inspect(t, session.sessionToken, live.json.userCode);
    assert.equal(afterDisconnect.status, 404);
    assert.equal(afterDisconnect.buf.toString("utf8"), unknown.buf.toString("utf8"));

    // The unique slot is now free for a replacement.
    const again = await start(t);
    assert.equal((await approve(t, session.sessionToken, again.json.userCode)).status, 200);
    assert.equal((await approve(t, session.sessionToken, again.json.userCode)).status, 409);
  } finally { await t.close(); }
});

test("device/inspect is rate-capped per account at 30/min", async () => {
  const t = await startTestApp();
  try {
    const started = await start(t);
    const session = await signIn(t);
    for (let i = 0; i < 30; i++) {
      const ok = await inspect(t, session.sessionToken, started.json.userCode);
      assert.equal(ok.status, 200, `request ${i + 1} should be allowed`);
    }
    const limited = await inspect(t, session.sessionToken, started.json.userCode);
    assert.equal(limited.status, 429);
    assert.equal(limited.json.error, "rate_limited");

    // A different account has its own budget.
    const other = await signIn(t, { sub: "other", email: "other@example.com" });
    assert.equal((await inspect(t, other.sessionToken, started.json.userCode)).status, 200);
  } finally { await t.close(); }
});

test("device/inspect requires a session", async () => {
  const t = await startTestApp();
  try {
    const started = await start(t);
    const res = await api(t.baseUrl, "POST", "/v1/auth/device/inspect", { body: { userCode: started.json.userCode } });
    assert.equal(res.status, 401);
  } finally { await t.close(); }
});

// ── client=web: session cookie without occupying the CLI computer slot ────
//
// Apple signIn cannot create a Better Auth user row, so the web-token cookie
// path signs up through /api/auth/sign-up/email (password/Better Auth).

test("web device code does not create a cli computer link", async () => {
  const t = await startTestApp();
  try {
    const started = await api(t.baseUrl, "POST", "/v1/auth/device/start", {
      body: { client: "web", machineName: "This browser", platform: "web" },
    });
    assert.equal(started.status, 201);
    const signup = await api(t.baseUrl, "POST", "/api/auth/sign-up/email", {
      headers: { origin: t.config.betterAuthBaseURL },
      body: {
        email: "web-device@example.com",
        name: "Web User",
        username: "web_device",
        password: "correct-horse-battery",
      },
    });
    assert.equal(signup.status, 200);
    const sessionToken = signup.headers.get("set-auth-token");
    const inspected = await api(t.baseUrl, "POST", "/v1/auth/device/inspect", {
      body: { userCode: started.json.userCode },
      ...authed(sessionToken),
    });
    assert.equal(inspected.status, 200);
    assert.equal(inspected.json.client, "web");
    assert.equal((await approve(t, sessionToken, started.json.userCode)).status, 200);
    const link = await api(t.baseUrl, "GET", "/v1/auth/device/link", authed(sessionToken));
    assert.equal(link.status, 200);
    assert.equal(link.json.computer, null);
    const granted = await poll(t, started.json.deviceCode);
    assert.equal(granted.status, 200);
    assert.equal(granted.json.cliLinkId, undefined);
    const setCookie = granted.headers.get("set-cookie") || "";
    const cookie = setCookie.split(";")[0];
    assert.match(cookie, /better-auth|session/i);
    const me = await api(t.baseUrl, "GET", "/v1/account", {
      headers: { cookie },
    });
    assert.equal(me.status, 200);
    assert.equal(me.json.account.email, "web-device@example.com");
    assert.equal(me.json.account.id, granted.json.accountId);
  } finally { await t.close(); }
});

test("Apple-only web token mints a Better Auth cookie for the same account", async () => {
  const t = await startTestApp();
  try {
    const session = await signIn(t, { sub: "apple-web-qr", email: "apple-web-qr@example.com" });
    const started = await api(t.baseUrl, "POST", "/v1/auth/device/start", {
      body: { client: "web", platform: "web" },
    });
    assert.equal((await approve(t, session.sessionToken, started.json.userCode)).status, 200);
    const granted = await poll(t, started.json.deviceCode);
    assert.equal(granted.status, 200);
    assert.equal(granted.json.accountId, session.accountId);
    const cookie = (granted.headers.get("set-cookie") || "").split(";")[0];
    assert.match(cookie, /better-auth|session/i);
    const me = await api(t.baseUrl, "GET", "/v1/account", { headers: { cookie } });
    assert.equal(me.status, 200);
    assert.equal(me.json.account.id, session.accountId);
    assert.equal(me.json.account.email, "apple-web-qr@example.com");
  } finally { await t.close(); }
});

test("inspect and approve of a web code succeed when a CLI computer is already linked", async () => {
  const t = await startTestApp();
  try {
    const session = await signIn(t);
    const cli = await api(t.baseUrl, "POST", "/v1/auth/device/start", { body: { machineName: "mbp" } });
    assert.equal((await approve(t, session.sessionToken, cli.json.userCode)).status, 200);
    assert.equal((await poll(t, cli.json.deviceCode)).status, 200);

    const web = await api(t.baseUrl, "POST", "/v1/auth/device/start", {
      body: { client: "web", platform: "web" },
    });
    const inspected = await api(t.baseUrl, "POST", "/v1/auth/device/inspect", {
      body: { userCode: web.json.userCode },
      ...authed(session.sessionToken),
    });
    assert.equal(inspected.status, 200);
    assert.equal(inspected.json.client, "web");
    assert.equal((await approve(t, session.sessionToken, web.json.userCode)).status, 200);
  } finally { await t.close(); }
});

test("cli inspect still 409s computer_already_linked when the slot is taken", async () => {
  const t = await startTestApp();
  try {
    const session = await signIn(t);
    const first = await api(t.baseUrl, "POST", "/v1/auth/device/start", { body: {} });
    assert.equal((await approve(t, session.sessionToken, first.json.userCode)).status, 200);
    const second = await api(t.baseUrl, "POST", "/v1/auth/device/start", { body: {} });
    const inspected = await api(t.baseUrl, "POST", "/v1/auth/device/inspect", {
      body: { userCode: second.json.userCode },
      ...authed(session.sessionToken),
    });
    assert.equal(inspected.status, 409);
    assert.equal(inspected.json.error, "computer_already_linked");
  } finally { await t.close(); }
});
