// POST /v1/node/handoffs/:id/fail — the cloud's terminal-failure state for a
// handoff (branch-seam review F7).
//
// Before this route existed, `handoffs.state` was exactly
// pending -> leased -> delivered, `registry.updateHandoff` (the only writer
// of state/reason outside that path) was exported and never called, and
// `reason` was always NULL. relayd genuinely emits `handoff.failed` with a
// reason when a clone/decrypt/import fails, but nothing carried it to this
// row — so `relay status`'s failure branch was dead code and design §10's
// "every failure ends visible" promise had no implementation path. These
// tests pin the fix: a node can report its own handoff as failed, from any
// prior state including `delivered` (ack fires before import, so a crash
// after ack must still be reportable), the reason is drawn from a closed,
// cloud-owned vocabulary rather than accepted as free text, and
// GET /v1/handoffs (what `relay status` reads) shows both.
import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";

import { startTestApp, api, signIn, authed } from "./helpers.mjs";
import { nodeRequestSigningInput } from "../src/nodeauth.js";

const NODE_ID = "node-00112233445566aa";
const HANDOFF_ID = "a1b2c3d4e5f60718";

function nodeIdentity() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  return { pubkeyPem: publicKey.export({ type: "spki", format: "pem" }), privateKey };
}

function nodeHeaders(identity, { method = "GET", pathWithQuery, ts, nodeId = NODE_ID }) {
  const signature = crypto.sign(
    null, nodeRequestSigningInput({ method, pathWithQuery, ts, nodeId }), identity.privateKey,
  );
  return { headers: { "x-relay-node": nodeId, "x-relay-ts": String(ts), "x-relay-signature": signature.toString("base64url") } };
}

async function setup() {
  const t = await startTestApp();
  const session = await signIn(t);
  const identity = nodeIdentity();
  t.app.registry.createNode(session.accountId, { id: NODE_ID, kind: "trial", name: "Trial", pubkey: identity.pubkeyPem });
  await api(t.baseUrl, "POST", "/v1/repos", { body: { fullName: "me/relay" }, ...authed(session.sessionToken) });
  const ping = await api(t.baseUrl, "POST", "/v1/handoffs", {
    body: { handoffId: HANDOFF_ID, repo: "me/relay", branch: "relay/handoff-fix-auth", nodeId: NODE_ID },
    ...authed(session.sessionToken),
  });
  assert.equal(ping.status, 201);
  return { t, session, identity };
}

function failPath(id) {
  return `/v1/node/handoffs/${id}/fail`;
}

async function reportFailure(t, identity, { id = HANDOFF_ID, reason, nodeId = NODE_ID } = {}) {
  const pathWithQuery = failPath(id);
  t.clock.t += 1;
  return api(t.baseUrl, "POST", pathWithQuery, {
    body: reason === undefined ? {} : { reason },
    ...nodeHeaders(identity, { method: "POST", pathWithQuery, ts: t.clock.t, nodeId }),
  });
}

test("a node can report its own pending handoff as failed, with a reason from the closed vocabulary", async () => {
  const { t, session, identity } = await setup();
  try {
    const res = await reportFailure(t, identity, { reason: "clone_failed" });
    assert.equal(res.status, 200);
    assert.equal(res.json.handoff.state, "failed");
    assert.equal(res.json.handoff.reason, "clone_failed");

    // relay status reads this through GET /v1/handoffs.
    const list = await api(t.baseUrl, "GET", "/v1/handoffs?repo=me%2Frelay", { ...authed(session.sessionToken) });
    assert.equal(list.status, 200);
    assert.equal(list.json.handoffs.length, 1);
    assert.equal(list.json.handoffs[0].state, "failed");
    assert.equal(list.json.handoffs[0].reason, "clone_failed");
  } finally { await t.close(); }
});

test("a node can report failure from `leased`", async () => {
  const { t, identity } = await setup();
  try {
    const pollPath = "/v1/node/handoffs?wait=0";
    const poll = await api(t.baseUrl, "GET", pollPath, nodeHeaders(identity, { pathWithQuery: pollPath, ts: t.clock.t }));
    assert.equal(poll.status, 200);
    assert.equal(t.app.registry.getHandoff(HANDOFF_ID).state, "leased");

    const res = await reportFailure(t, identity, { reason: "decrypt_failed" });
    assert.equal(res.status, 200);
    assert.equal(res.json.handoff.state, "failed");
    assert.equal(res.json.handoff.reason, "decrypt_failed");
  } finally { await t.close(); }
});

// The important one: ackDelivery fires BEFORE import, deliberately, so a
// partitioned poll response still leaves the row redeliverable. That means a
// node that acks and then dies mid-import used to leave the row `delivered`
// forever with nothing anywhere saying so — F7's "delivered is a permanent
// dead end" half. A node must be able to fail a handoff it already acked.
test("a node can report failure from `delivered` — the ack-then-crash case", async () => {
  const { t, identity } = await setup();
  try {
    const pollPath = "/v1/node/handoffs?wait=0";
    const poll = await api(t.baseUrl, "GET", pollPath, nodeHeaders(identity, { pathWithQuery: pollPath, ts: t.clock.t }));
    const lease = poll.json.handoffs[0].lease;

    t.clock.t += 1;
    const ackPath = "/v1/node/handoffs/ack";
    const ack = await api(t.baseUrl, "POST", ackPath, {
      body: { acks: [{ id: HANDOFF_ID, lease }] },
      ...nodeHeaders(identity, { method: "POST", pathWithQuery: ackPath, ts: t.clock.t }),
    });
    assert.equal(ack.status, 200);
    assert.equal(t.app.registry.getHandoff(HANDOFF_ID).state, "delivered");

    const res = await reportFailure(t, identity, { reason: "workspace_failed" });
    assert.equal(res.status, 200, "a handoff that already reached delivered must still be failable");
    assert.equal(res.json.handoff.state, "failed");
    assert.equal(res.json.handoff.reason, "workspace_failed");
  } finally { await t.close(); }
});

test("the reason must come from the closed vocabulary — free text is refused, not stored", async () => {
  const { t, identity } = await setup();
  try {
    const res = await reportFailure(t, identity, { reason: "the user's github token: ghp_LIVE_SECRET" });
    assert.equal(res.status, 400);
    assert.equal(res.json.error, "invalid_reason");

    const row = t.app.registry.getHandoff(HANDOFF_ID);
    assert.equal(row.state, "pending", "an invalid reason must not move the state machine");
    assert.equal(row.reason, null, "an invalid reason must never reach the reason column");
  } finally { await t.close(); }
});

test("an empty, missing, or wrong-typed reason is refused the same way", async () => {
  const { t, identity } = await setup();
  try {
    for (const reason of [undefined, "", "  ", 42, null, ["clone_failed"], "CLONE_FAILED"]) {
      const res = await reportFailure(t, identity, { reason });
      assert.equal(res.status, 400, `reason ${JSON.stringify(reason)} should have been refused`);
      assert.equal(res.json.error, "invalid_reason");
    }
    assert.equal(t.app.registry.getHandoff(HANDOFF_ID).state, "pending");
  } finally { await t.close(); }
});

test("every member of the closed vocabulary is individually accepted", async () => {
  const t = await startTestApp();
  try {
    const session = await signIn(t);
    const identity = nodeIdentity();
    t.app.registry.createNode(session.accountId, { id: NODE_ID, kind: "trial", name: "Trial", pubkey: identity.pubkeyPem });
    await api(t.baseUrl, "POST", "/v1/repos", { body: { fullName: "me/relay" }, ...authed(session.sessionToken) });

    const reasons = ["clone_failed", "decrypt_failed", "manifest_invalid", "workspace_failed", "internal_error"];
    for (const [index, reason] of reasons.entries()) {
      const id = String(index + 1).padStart(16, "a");
      const ping = await api(t.baseUrl, "POST", "/v1/handoffs", {
        body: { handoffId: id, repo: "me/relay", branch: `relay/handoff-${reason}`, nodeId: NODE_ID },
        ...authed(session.sessionToken),
      });
      assert.equal(ping.status, 201);
      const res = await reportFailure(t, identity, { id, reason });
      assert.equal(res.status, 200, `reason ${reason} should be accepted`);
      assert.equal(res.json.handoff.reason, reason);
    }
  } finally { await t.close(); }
});

test("a handoff that does not exist and a handoff owned by another node both 404 identically", async () => {
  const { t, session, identity } = await setup();
  try {
    const missing = await reportFailure(t, identity, { id: "f".repeat(16), reason: "clone_failed" });
    assert.equal(missing.status, 404);
    assert.equal(missing.json.error, "unknown_handoff");

    // A second node, same account, gets its own handoff — the first node must
    // not be able to fail it.
    const otherIdentity = nodeIdentity();
    const otherNodeId = "node-ffffffffffffffff";
    t.app.registry.createNode(session.accountId, { id: otherNodeId, kind: "trial", name: "Other", pubkey: otherIdentity.pubkeyPem });
    const otherId = "b".repeat(16);
    const ping = await api(t.baseUrl, "POST", "/v1/handoffs", {
      body: { handoffId: otherId, repo: "me/relay", branch: "relay/handoff-other", nodeId: otherNodeId },
      ...authed(session.sessionToken),
    });
    assert.equal(ping.status, 201);

    const stolen = await reportFailure(t, identity, { id: otherId, reason: "clone_failed" });
    assert.equal(stolen.status, 404, "a node reported failure on a handoff it does not own");
    assert.equal(stolen.json.error, "unknown_handoff");
    assert.equal(t.app.registry.getHandoff(otherId).state, "pending", "the other node's handoff must be untouched");
  } finally { await t.close(); }
});

test("the first recorded reason wins — a second report does not overwrite it", async () => {
  const { t, identity } = await setup();
  try {
    const first = await reportFailure(t, identity, { reason: "clone_failed" });
    assert.equal(first.status, 200);

    const second = await reportFailure(t, identity, { reason: "internal_error" });
    assert.equal(second.status, 200, "a retry of a failure report must not itself error");
    assert.equal(second.json.handoff.reason, "clone_failed", "the first reason must not be overwritten");
    assert.equal(t.app.registry.getHandoff(HANDOFF_ID).reason, "clone_failed");
  } finally { await t.close(); }
});

test("an unsigned or badly signed failure report is refused, same as the other node-authed routes", async () => {
  const { t } = await setup();
  try {
    const res = await api(t.baseUrl, "POST", failPath(HANDOFF_ID), { body: { reason: "clone_failed" } });
    assert.equal(res.status, 401);
    assert.equal(t.app.registry.getHandoff(HANDOFF_ID).state, "pending");
  } finally { await t.close(); }
});

test("a byte-identical replay of a failure report is refused by the shared handoff replay guard", async () => {
  const { t, identity } = await setup();
  try {
    const pathWithQuery = failPath(HANDOFF_ID);
    const ts = t.clock.t;
    const req = nodeHeaders(identity, { method: "POST", pathWithQuery, ts });
    const first = await api(t.baseUrl, "POST", pathWithQuery, { body: { reason: "clone_failed" }, ...req });
    assert.equal(first.status, 200);

    const replay = await api(t.baseUrl, "POST", pathWithQuery, { body: { reason: "clone_failed" }, ...req });
    assert.equal(replay.status, 401, "a byte-identical replay must not authenticate a second time");
  } finally { await t.close(); }
});

test("an invalid handoff id shape is rejected before any lookup", async () => {
  const { t, identity } = await setup();
  try {
    const res = await reportFailure(t, identity, { id: "not-hex!!", reason: "clone_failed" });
    assert.equal(res.status, 400);
    assert.equal(res.json.error, "invalid_handoff");
  } finally { await t.close(); }
});
