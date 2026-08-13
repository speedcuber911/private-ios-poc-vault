// What a user actually reads on the lock screen.
//
// Before this existed every mutable push carried
// `alert: {"loc-key":"RELAY_EVENT"}` on the assumption that a Notification
// Service Extension would rewrite it. There is no such extension in the app
// and iOS renders an unresolvable loc-key verbatim, so every notification any
// user had ever received read "RELAY_EVENT". These tests hold the banner to
// three things: it says which handoff it is about, it never says more than
// repo + branch + a closed-vocabulary reason, and it degrades to real words
// rather than an identifier when it cannot identify the handoff.

import test from "node:test";
import assert from "node:assert/strict";

import { startTestApp, api, signIn, makeNodeIdentity } from "./helpers.mjs";

const NODE_ID = "node-00112233445566aa";
const REPO = "acme/widgets";
const BRANCH = "relay/handoff-da52e7226d99";

async function setup() {
  const t = await startTestApp();
  const session = await signIn(t);
  const identity = makeNodeIdentity();
  t.app.registry.createNode(session.accountId, {
    id: NODE_ID, kind: "trial", name: "Trial", pubkey: identity.pubkeyPem,
  });
  t.app.registry.createDevice(session.accountId, {
    apnsToken: "a".repeat(64), platform: "ios", name: "iPhone",
  });
  return { t, identity, accountId: session.accountId };
}

// A handoff row in the state its node has just reported, which is what the
// banner looks up. Mirrors the real order: the node PUTs ready/fail and awaits
// it, then posts the content-free event.
function handoffIn(t, accountId, state, { id = "da52e7226d99aabb", repo = REPO, branch = BRANCH, reason = null } = {}) {
  t.app.registry.createHandoff({ id, accountId, nodeId: NODE_ID, repo, branch });
  if (state === "ready") t.app.registry.readyHandoff(NODE_ID, id);
  if (state === "failed") t.app.registry.failHandoff(NODE_ID, id, reason ?? "internal_error");
  return id;
}

async function postEvent(t, identity, type, seq) {
  const body = Buffer.from(
    JSON.stringify({ v: 1, nodeId: NODE_ID, jobId: null, type, ts: t.clock.t, seq }),
    "utf8",
  );
  return api(t.baseUrl, "POST", "/v1/node-events", {
    raw: body,
    headers: { "x-relay-signature": identity.signBody(body) },
  });
}

async function bannerAfter(t, identity, type, seq = 1) {
  const res = await postEvent(t, identity, type, seq);
  assert.equal(res.status, 202);
  await t.app.notify.drain();
  return t.apnsTransport.requests.at(-1).body.aps.alert;
}

test("a ready banner names the repo and the branch", async () => {
  const { t, identity, accountId } = await setup();
  try {
    handoffIn(t, accountId, "ready");
    assert.deepEqual(await bannerAfter(t, identity, "handoff.ready"), {
      title: "Session ready",
      body: `${REPO} · ${BRANCH}`,
    });
  } finally { await t.close(); }
});

test("a failed banner names the handoff and says why, in words", async () => {
  const { t, identity, accountId } = await setup();
  try {
    handoffIn(t, accountId, "failed", { reason: "clone_failed" });
    assert.deepEqual(await bannerAfter(t, identity, "handoff.failed"), {
      title: "Handoff failed",
      body: `${REPO} · ${BRANCH} — couldn't clone the branch`,
    });
  } finally { await t.close(); }
});

// The five codes POST /v1/node/handoffs/{id}/fail accepts. A code that reaches
// the banner without a phrase would put a bare identifier on a lock screen.
test("every accepted failure reason has banner wording", async () => {
  const reasons = ["clone_failed", "decrypt_failed", "manifest_invalid", "workspace_failed", "internal_error"];
  for (const [i, reason] of reasons.entries()) {
    const { t, identity, accountId } = await setup();
    try {
      handoffIn(t, accountId, "failed", { id: `da52e7226d99aa${String(i).padStart(2, "0")}`, reason });
      const alert = await bannerAfter(t, identity, "handoff.failed");
      assert.ok(alert.body.includes(" — "), `${reason} produced no explanation: ${alert.body}`);
      assert.ok(
        !alert.body.includes(reason),
        `${reason} reached the banner as a raw code: ${alert.body}`,
      );
    } finally { await t.close(); }
  }
});

test("the banner picks the handoff the event is about, not an older one", async () => {
  const { t, identity, accountId } = await setup();
  try {
    handoffIn(t, accountId, "ready", { id: "aaaaaaaaaaaaaaa1", branch: "relay/handoff-old000000000" });
    t.clock.t += 60_000;
    handoffIn(t, accountId, "ready", { id: "aaaaaaaaaaaaaaa2", branch: "relay/handoff-new000000000" });
    const alert = await bannerAfter(t, identity, "handoff.ready");
    assert.ok(alert.body.includes("relay/handoff-new000000000"), alert.body);
    assert.ok(!alert.body.includes("old"), alert.body);
  } finally { await t.close(); }
});

// Two handoffs back to back is ordinary use. The one that just became ready is
// the one the event is about — not whichever row was created most recently.
test("a newer handoff still in flight is not named by a ready event", async () => {
  const { t, identity, accountId } = await setup();
  try {
    handoffIn(t, accountId, "ready", { id: "bbbbbbbbbbbbbbb1", branch: "relay/handoff-done00000000" });
    t.clock.t += 1_000;
    handoffIn(t, accountId, "pending", { id: "bbbbbbbbbbbbbbb2", branch: "relay/handoff-inflight0000" });
    const alert = await bannerAfter(t, identity, "handoff.ready");
    assert.ok(alert.body.includes("relay/handoff-done00000000"), alert.body);
    assert.ok(!alert.body.includes("inflight"), alert.body);
  } finally { await t.close(); }
});

// Both of the node's report calls are best-effort (relayd's safeReportReady /
// safeReportFailure swallow errors), so the event can arrive with no row in a
// terminal state. Naming whatever stale handoff is newest would be worse than
// saying nothing specific.
test("a stale handoff is never named — the banner goes generic instead", async () => {
  const { t, identity, accountId } = await setup();
  try {
    handoffIn(t, accountId, "ready");
    t.clock.t += 6 * 60 * 1000; // past BANNER_LOOKUP_WINDOW_MS
    const alert = await bannerAfter(t, identity, "handoff.ready");
    assert.equal(alert.title, "Session ready");
    assert.ok(!alert.body.includes(REPO), alert.body);
    assert.ok(!alert.body.includes(BRANCH), alert.body);
    assert.ok(alert.body.length > 0);
  } finally { await t.close(); }
});

test("no matching row at all still produces readable words", async () => {
  const { t, identity } = await setup();
  try {
    const alert = await bannerAfter(t, identity, "handoff.ready");
    assert.deepEqual(alert, {
      title: "Session ready",
      body: "A handed-off session is ready to pick up.",
    });
  } finally { await t.close(); }
});

// The regression this whole file exists for.
test("no banner is ever a loc-key or the string RELAY_EVENT", async () => {
  const types = [
    ["handoff.ready", 1],
    ["handoff.failed", 2],
    ["job.needs_input", 3],
    ["job.completed", 4],
    ["job.failed", 5],
    ["credentials.failed", 6],
  ];
  const { t, identity } = await setup();
  try {
    for (const [type, seq] of types) {
      const alert = await bannerAfter(t, identity, type, seq);
      assert.equal(typeof alert.title, "string");
      assert.ok(alert.title.length > 0, `${type} has no title`);
      assert.ok(!("loc-key" in alert), `${type} still sends a loc-key`);
      assert.ok(
        !JSON.stringify(alert).includes("RELAY_EVENT"),
        `${type} banner reads as an identifier: ${JSON.stringify(alert)}`,
      );
      // The category — which the app routes on and the user never sees — is
      // unaffected by any of this.
      assert.ok(t.apnsTransport.requests.at(-1).body.aps.category.startsWith("RELAY_"));
    }
  } finally { await t.close(); }
});

test("a silent push gains no banner", async () => {
  const { t, identity } = await setup();
  try {
    const res = await postEvent(t, identity, "job.state", 1);
    assert.equal(res.json.kind, "silent");
    await t.app.notify.drain();
    const aps = t.apnsTransport.requests.at(-1).body.aps;
    assert.deepEqual(Object.keys(aps), ["content-available"]);
  } finally { await t.close(); }
});

// The banner is the only text in the push, so it is the only place a stored
// string could carry something that renders as more than a name. repo and
// branch are charset-validated on the way in; this proves the banner does not
// depend on that having happened.
test("a control character in a stored name cannot reach the banner", async () => {
  const { t, identity, accountId } = await setup();
  try {
    const id = "da52e7226d99aabb";
    t.app.registry.createHandoff({ id, accountId, nodeId: NODE_ID, repo: REPO, branch: BRANCH });
    t.app.registry.readyHandoff(NODE_ID, id);
    t.app.db.prepare("UPDATE handoffs SET repo = ?, branch = ? WHERE id = ?")
      .run("acme/wid\ngets ", `${"x".repeat(400)}`, id);

    const alert = await bannerAfter(t, identity, "handoff.ready");
    assert.ok(!alert.body.includes("\n"), JSON.stringify(alert.body));
    assert.ok(!alert.body.includes(" "), JSON.stringify(alert.body));
    assert.ok(alert.body.length < 200, `banner not bounded: ${alert.body.length}`);
  } finally { await t.close(); }
});

// Two accounts, two nodes: a banner must never describe someone else's work.
test("the lookup is scoped to the node the event came from", async () => {
  const { t, identity, accountId } = await setup();
  try {
    const other = await signIn(t, { sub: "apple-other-account", email: "other@example.test" });
    const otherIdentity = makeNodeIdentity();
    t.app.registry.createNode(other.accountId, {
      id: "node-ffffffffffffffff", kind: "byo", name: "Theirs", pubkey: otherIdentity.pubkeyPem,
    });
    t.app.registry.createHandoff({
      id: "ffffffffffffffff", accountId: other.accountId, nodeId: "node-ffffffffffffffff",
      repo: "other/private", branch: "relay/handoff-secret000000",
    });
    t.app.registry.readyHandoff("node-ffffffffffffffff", "ffffffffffffffff");

    handoffIn(t, accountId, "ready");
    const alert = await bannerAfter(t, identity, "handoff.ready");
    assert.ok(!alert.body.includes("other/private"), alert.body);
    assert.ok(alert.body.includes(REPO), alert.body);
  } finally { await t.close(); }
});
