// POST /v1/node/handoffs/:id/ready — the cloud's terminal SUCCESS state for a
// handoff, and the twin of the fail route next door.
//
// Failure had a terminal state and success did not. `delivered` is written when
// the node acks the lease, which happens BEFORE the import runs, so it only
// ever meant "the node took this row" — never "the import worked". A handoff
// whose clone/decrypt/stage succeeded looked exactly like one whose import had
// hung, and `relay status` had no way to tell them apart. That is the same
// asymmetry that let a failed import sit at `delivered` forever until the fail
// route was wired up; this is the other half.
import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";

import { startTestApp, api, signIn, authed } from "./helpers.mjs";
import { nodeRequestSigningInput } from "../src/nodeauth.js";

const NODE_ID = "node-00112233445566aa";
const OTHER_NODE_ID = "node-99887766554433bb";
const HANDOFF_ID = "a1b2c3d4e5f60718";

function nodeIdentity() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  return { pubkeyPem: publicKey.export({ type: "spki", format: "pem" }), privateKey };
}

function nodeHeaders(identity, { method = "POST", pathWithQuery, ts, nodeId = NODE_ID }) {
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

const readyPath = (id) => `/v1/node/handoffs/${id}/ready`;
const failPath = (id) => `/v1/node/handoffs/${id}/fail`;

async function reportReady(t, identity, { id = HANDOFF_ID, nodeId = NODE_ID } = {}) {
  const pathWithQuery = readyPath(id);
  t.clock.t += 1;
  return api(t.baseUrl, "POST", pathWithQuery, {
    body: {},
    ...nodeHeaders(identity, { method: "POST", pathWithQuery, ts: t.clock.t, nodeId }),
  });
}

test("a node can report its own handoff ready, and relay status sees it", async () => {
  const { t, session, identity } = await setup();
  try {
    const res = await reportReady(t, identity);
    assert.equal(res.status, 200);
    assert.equal(res.json.handoff.state, "ready");

    // `relay status` reads this list, and it is the whole point of the route.
    const list = await api(t.baseUrl, "GET", "/v1/handoffs?repo=me%2Frelay", { ...authed(session.sessionToken) });
    assert.equal(list.status, 200);
    const row = list.json.handoffs.find((h) => h.id === HANDOFF_ID);
    assert.equal(row.state, "ready");
    assert.equal(row.reason ?? null, null);
  } finally {
    await t.close();
  }
});

// The ack fires before the import runs, so `delivered` is the state a real
// success arrives from.
test("ready is reachable from delivered", async () => {
  const { t, identity } = await setup();
  try {
    t.app.registry.leaseHandoffs([HANDOFF_ID], NODE_ID, 60_000);
    const leased = t.app.registry.getHandoff(HANDOFF_ID);
    t.app.registry.confirmHandoffDelivery(NODE_ID, [{ id: HANDOFF_ID, lease: leased.leaseToken }]);
    assert.equal(t.app.registry.getHandoff(HANDOFF_ID).state, "delivered");

    const res = await reportReady(t, identity);
    assert.equal(res.status, 200);
    assert.equal(res.json.handoff.state, "ready");
  } finally {
    await t.close();
  }
});

// `failed` is terminal in the other direction too: a node that already
// reported a failure must not be able to walk the row back to success, or a
// crash-loop would flap the state the user is reading.
test("a failed handoff cannot be resurrected as ready", async () => {
  const { t, identity } = await setup();
  try {
    const pathWithQuery = failPath(HANDOFF_ID);
    t.clock.t += 1;
    const failed = await api(t.baseUrl, "POST", pathWithQuery, {
      body: { reason: "clone_failed" },
      ...nodeHeaders(identity, { method: "POST", pathWithQuery, ts: t.clock.t }),
    });
    assert.equal(failed.json.handoff.state, "failed");

    const res = await reportReady(t, identity);
    assert.equal(res.status, 200, "the call is accepted…");
    assert.equal(res.json.handoff.state, "failed", "…but the terminal failure stands");
    assert.equal(res.json.handoff.reason, "clone_failed", "and its reason is not cleared");
  } finally {
    await t.close();
  }
});

test("an unsigned or wrongly-signed request is rejected", async () => {
  const { t } = await setup();
  try {
    const bare = await api(t.baseUrl, "POST", readyPath(HANDOFF_ID), { body: {} });
    assert.equal(bare.status, 401);

    const stranger = nodeIdentity();
    const pathWithQuery = readyPath(HANDOFF_ID);
    t.clock.t += 1;
    const forged = await api(t.baseUrl, "POST", pathWithQuery, {
      body: {},
      ...nodeHeaders(stranger, { method: "POST", pathWithQuery, ts: t.clock.t }),
    });
    assert.equal(forged.status, 401);
  } finally {
    await t.close();
  }
});

// A node has no business learning whether an id it does not own exists, so an
// unknown id and someone else's id must be indistinguishable.
test("another node's handoff is a 404, identical to an unknown id", async () => {
  const { t, session, identity } = await setup();
  try {
    const other = nodeIdentity();
    t.app.registry.createNode(session.accountId, {
      id: OTHER_NODE_ID, kind: "trial", name: "Other", pubkey: other.pubkeyPem,
    });

    const pathWithQuery = readyPath(HANDOFF_ID);
    t.clock.t += 1;
    const foreign = await api(t.baseUrl, "POST", pathWithQuery, {
      body: {},
      ...nodeHeaders(other, { method: "POST", pathWithQuery, ts: t.clock.t, nodeId: OTHER_NODE_ID }),
    });
    assert.equal(foreign.status, 404);
    assert.deepEqual(foreign.json, { error: "unknown_handoff" });

    const unknown = await reportReady(t, identity, { id: "ffffffffffffffff" });
    assert.equal(unknown.status, 404);
    assert.deepEqual(unknown.json, foreign.json, "the two must be indistinguishable");

    // And the real row is untouched by either attempt.
    assert.equal(t.app.registry.getHandoff(HANDOFF_ID).state, "pending");
  } finally {
    await t.close();
  }
});

test("a malformed handoff id is rejected before any lookup", async () => {
  const { t, identity } = await setup();
  try {
    const res = await reportReady(t, identity, { id: "not-a-handoff-id" });
    assert.equal(res.status, 400);
    assert.deepEqual(res.json, { error: "invalid_handoff" });
  } finally {
    await t.close();
  }
});
