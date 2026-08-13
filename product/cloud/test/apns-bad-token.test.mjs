// A wrong APNS_HOST must not destroy the account's push tokens.
//
// Apple returns `400 BadDeviceToken` for two different things: a token that is
// genuinely not a device token, and a perfectly good token that belongs to the
// OTHER APNs environment. Treating the second as the first means one wrong
// APNS_HOST permanently deletes every token of every account.
//
// That is not hypothetical. On 2026-08-13 APNS_HOST was left at
// api.sandbox.push.apple.com, the owner installed a TestFlight (production)
// build, and the token was deleted on the first push after each of two
// registrations four minutes apart — so no notification could ever arrive, and
// each reinstall silently re-armed the same trap.

import test from "node:test";
import assert from "node:assert/strict";

import { startTestApp, api, signIn, makeNodeIdentity } from "./helpers.mjs";
import { APNS_OUTCOME } from "../src/apns.js";

const NODE_ID = "node-00112233445566aa";

async function setup(t, tokens = ["a".repeat(64)]) {
  const session = await signIn(t);
  const identity = makeNodeIdentity();
  t.app.registry.createNode(session.accountId, {
    id: NODE_ID, kind: "trial", name: "Trial", pubkey: identity.pubkeyPem,
  });
  for (const [i, apnsToken] of tokens.entries()) {
    t.app.registry.createDevice(session.accountId, {
      apnsToken, platform: "ios", name: `iPhone-${i}`,
    });
  }
  return { identity, accountId: session.accountId };
}

function tokensLeft(t, accountId) {
  return t.app.registry.listPushDevices(accountId).length;
}

async function postEvent(t, identity, type, seq) {
  const body = Buffer.from(
    JSON.stringify({ v: 1, nodeId: NODE_ID, jobId: null, type, ts: t.clock.t, seq }),
    "utf8",
  );
  const res = await api(t.baseUrl, "POST", "/v1/node-events", {
    raw: body, headers: { "x-relay-signature": identity.signBody(body) },
  });
  await t.app.notify.drain();
  return res;
}

test("a production token refused by the sandbox host is NOT deleted", async () => {
  const t = await startTestApp();
  try {
    const { identity, accountId } = await setup(t);
    assert.equal(tokensLeft(t, accountId), 1);

    t.apnsTransport.respondWith({ status: 400, body: { reason: "BadDeviceToken" } });
    await postEvent(t, identity, "handoff.ready", 1);

    assert.equal(
      tokensLeft(t, accountId), 1,
      "BadDeviceToken is ambiguous — it must never cost the user their token",
    );
    assert.equal(t.app.notify.stats().badToken, 1);
    assert.equal(t.app.notify.stats().tokensDropped, 0);
  } finally { await t.close(); }
});

test("DeviceTokenNotForTopic is equally ambiguous and equally non-fatal", async () => {
  const t = await startTestApp();
  try {
    const { identity, accountId } = await setup(t);
    t.apnsTransport.respondWith({ status: 400, body: { reason: "DeviceTokenNotForTopic" } });
    await postEvent(t, identity, "handoff.ready", 1);

    assert.equal(tokensLeft(t, accountId), 1);
    assert.equal(t.app.notify.stats().tokensDropped, 0);
  } finally { await t.close(); }
});

// The other half of the rule: a genuinely uninstalled app must still be cleaned
// up, or every event retries a dead token forever.
test("410 still deletes the token", async () => {
  const t = await startTestApp();
  try {
    const { identity, accountId } = await setup(t);
    t.apnsTransport.respondWith({ status: 410, body: { reason: "Unregistered" } });
    await postEvent(t, identity, "handoff.ready", 1);

    assert.equal(tokensLeft(t, accountId), 0, "410 is unambiguous — the app is gone");
    assert.equal(t.app.notify.stats().tokensDropped, 1);
  } finally { await t.close(); }
});

test("a 400 that literally says Unregistered still deletes", async () => {
  const t = await startTestApp();
  try {
    const { identity, accountId } = await setup(t);
    t.apnsTransport.respondWith({ status: 400, body: { reason: "Unregistered" } });
    await postEvent(t, identity, "handoff.ready", 1);
    assert.equal(tokensLeft(t, accountId), 0);
  } finally { await t.close(); }
});

// The signature of the real incident: every device refused at once. Nothing
// should be deleted, and the operator must be told which host is in play.
test("a whole-account refusal costs no tokens and names the host", async () => {
  const lines = [];
  const t = await startTestApp({ log: (msg) => lines.push(msg) });
  try {
    const { identity, accountId } = await setup(
      t, Array.from({ length: 5 }, (_, i) => String(i).repeat(64)),
    );
    assert.equal(tokensLeft(t, accountId), 5);

    t.apnsTransport.respondWith({ status: 400, body: { reason: "BadDeviceToken" } });
    await postEvent(t, identity, "handoff.ready", 1);

    assert.equal(tokensLeft(t, accountId), 5, "all five survive");
    const warning = lines.find((l) => l.includes("apns refused a device token"));
    assert.ok(warning, `no operator warning was logged: ${JSON.stringify(lines)}`);
    assert.ok(warning.includes("host="), warning);
    assert.ok(warning.includes("APNS_HOST"), warning);
  } finally { await t.close(); }
});

test("BAD_TOKEN is its own outcome, distinct from unregistered", () => {
  assert.equal(APNS_OUTCOME.BAD_TOKEN, "bad_token");
  assert.notEqual(APNS_OUTCOME.BAD_TOKEN, APNS_OUTCOME.UNREGISTERED);
});

// The fanout summary is the only per-event diagnostic an operator gets. It used
// to be computed by diffing the process-wide `stats` across the await, and
// fanouts overlap — so each reported the other's outcomes too, and a 27-device
// fanout logged "delivered=43". Numbers that cannot describe the send are worse
// than no numbers.
test("concurrent fanouts do not contaminate each other's summary counts", async () => {
  const lines = [];
  const t = await startTestApp({ log: (msg) => lines.push(msg) });
  try {
    const { identity } = await setup(
      t, Array.from({ length: 3 }, (_, i) => String(i).repeat(64)),
    );

    // Two events in flight at once — ingest does not await the fanout.
    await Promise.all([
      postEvent(t, identity, "handoff.ready", 1),
      postEvent(t, identity, "job.completed", 2),
    ]);
    await t.app.notify.drain();

    const summaries = lines.filter((l) => l.startsWith("apns fanout:"));
    assert.ok(summaries.length >= 2, `expected a line per fanout: ${JSON.stringify(lines)}`);
    for (const line of summaries) {
      const devices = Number(/devices=(\d+)/.exec(line)?.[1]);
      const counted = [...line.matchAll(/\b(?!devices)(\w+)=(\d+)/g)]
        .filter(([, key]) => key !== "tokensDropped")
        .reduce((sum, [, , n]) => sum + Number(n), 0);
      assert.ok(
        counted <= devices,
        `a fanout reported more outcomes than it had devices: ${line}`,
      );
    }
  } finally { await t.close(); }
});
