// POST /v1/nodes and the X25519 key `relay handoff` seals to.
//
// Deleting trial enrolment removed the only writer of nodes.enc_pubkey, which
// silently broke handoff for every node: sealTo() had no recipient and the
// failure surfaced far from its cause. These tests pin the replacement path —
// registration carries the key, every node-returning shape hands it back, and
// a malformed one is refused at registration where the error is diagnosable.

import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { startTestApp, api, authed, signIn, makeNodeIdentity } from "./helpers.mjs";

// Same encoding relayd's seal.mjs produces: raw 32 X25519 bytes, canonical
// base64. Derived here from a real key rather than a fixture so the two sides
// cannot drift into agreeing on something neither actually emits.
function encPubkeyB64() {
  const { publicKey } = crypto.generateKeyPairSync("x25519");
  return publicKey.export({ type: "spki", format: "der" }).subarray(12).toString("base64");
}

test("a node registered with an encPubkey reads it back everywhere a node is returned", async () => {
  const t = await startTestApp();
  try {
    const session = await signIn(t);
    const encPubkey = encPubkeyB64();

    const created = await api(t.baseUrl, "POST", "/v1/nodes", {
      body: { kind: "byo", name: "box", pubkey: makeNodeIdentity().pubkeyPem, encPubkey },
      ...authed(session.sessionToken),
    });
    assert.equal(created.status, 201);
    assert.equal(created.json.node.encPubkey, encPubkey);
    const nodeId = created.json.node.id;

    // The CLI pins the key off the nodes list, so the list shape is the one
    // that actually matters — not just the create response.
    const list = await api(t.baseUrl, "GET", "/v1/nodes", authed(session.sessionToken));
    assert.equal(list.status, 200);
    assert.equal(list.json.nodes.find((n) => n.id === nodeId).encPubkey, encPubkey);

    const one = await api(t.baseUrl, "GET", `/v1/nodes/${nodeId}`, authed(session.sessionToken));
    assert.equal(one.status, 200);
    assert.equal(one.json.node.encPubkey, encPubkey);

    assert.equal(t.app.registry.getNode(nodeId).encPubkey, encPubkey);
  } finally { await t.close(); }
});

test("a node registered without an encPubkey is usable, and reports null rather than pretending", async () => {
  const t = await startTestApp();
  try {
    const session = await signIn(t);
    const created = await api(t.baseUrl, "POST", "/v1/nodes", {
      body: { kind: "byo", name: "unregistered-for-handoff", pubkey: makeNodeIdentity().pubkeyPem },
      ...authed(session.sessionToken),
    });
    assert.equal(created.status, 201, "no encPubkey must not block registration");
    assert.equal(created.json.node.encPubkey, null);

    // Paired-but-not-handoff-capable is a supported state, not an error: the
    // node exists, is addressable, and is exactly one field short of handoff.
    const one = await api(t.baseUrl, "GET", `/v1/nodes/${created.json.node.id}`, authed(session.sessionToken));
    assert.equal(one.status, 200);
    assert.equal(one.json.node.encPubkey, null, "null is how a caller learns handoff is unavailable");
    assert.equal(one.json.node.kind, "byo");

    // An explicit JSON null is the same as omitting the field, not a 400.
    const explicitNull = await api(t.baseUrl, "POST", "/v1/nodes", {
      body: { kind: "byo", pubkey: makeNodeIdentity().pubkeyPem, encPubkey: null },
      ...authed(session.sessionToken),
    });
    assert.equal(explicitNull.status, 403, "still only the entitlement gate, not a validation error");
    assert.equal(explicitNull.json.error, "entitlement_limit");
  } finally { await t.close(); }
});

// seal.mjs (product/relayd/src/seal.mjs, sealTo()) requires a CANONICAL base64
// encoding of exactly 32 bytes — re-encoding the decoded bytes must reproduce
// the given string. Registration adopts the identical rule, or a key that is
// lenient-base64-valid-but-not-canonical sails through and fails much later as
// an opaque seal_bad_public_key at handoff time. Every case below decodes to
// 32 bytes under Node's permissive decoder, so a length-only check would
// accept all of them.
test("a malformed encPubkey is a 400 and creates no node, never a silent null", async () => {
  const t = await startTestApp();
  try {
    const session = await signIn(t);
    const identity = makeNodeIdentity();

    // All-0xFF canonicalizes to a string dense in '+'/'/' and padding, so the
    // variants below genuinely differ from it rather than coincidentally
    // reproducing it.
    const raw = Buffer.alloc(32, 0xff);
    const canonical = raw.toString("base64");
    const cases = {
      base64url: raw.toString("base64url"),
      embedded_whitespace: `${canonical.slice(0, 4)}\n${canonical.slice(4)}`,
      spliced_junk: `${canonical.slice(0, 4)}!${canonical.slice(4)}`,
      // Canonical, but the wrong size: passes canonicality trivially (Node's
      // own encoder produced it), so only the length check catches it.
      canonical_but_16_bytes: crypto.randomBytes(16).toString("base64"),
      canonical_but_33_bytes: crypto.randomBytes(33).toString("base64"),
      // A present-but-wrong-typed value must not normalize to "no key".
      number: 12345,
      object: { a: 1 },
      array: [1, 2, 3],
      empty_string: "",
    };

    for (const [label, encPubkey] of Object.entries(cases)) {
      const res = await api(t.baseUrl, "POST", "/v1/nodes", {
        body: { kind: "byo", name: label, pubkey: identity.pubkeyPem, encPubkey },
        ...authed(session.sessionToken),
      });
      assert.equal(res.status, 400, `${label} must be rejected`);
      assert.equal(res.json.error, "invalid_enc_pubkey", label);
    }

    assert.equal(
      (await api(t.baseUrl, "GET", "/v1/nodes", authed(session.sessionToken))).json.nodes.length,
      0,
      "a refused encPubkey must not leave a node behind",
    );

    // Not a blanket rejection of those bytes — only of their bad encodings.
    const ok = await api(t.baseUrl, "POST", "/v1/nodes", {
      body: { kind: "byo", pubkey: identity.pubkeyPem, encPubkey: canonical },
      ...authed(session.sessionToken),
    });
    assert.equal(ok.status, 201);
    assert.equal(ok.json.node.encPubkey, canonical);
  } finally { await t.close(); }
});

// ---------------------------------------------------------------------------
// Node id claiming.
//
// A node signs its cloud requests with `x-relay-node: <its own id>`, and
// nodeauth resolves that header through registry.getNode(). So the row must
// carry the id relayd minted for itself, not one the cloud invented — a node
// registered under a generated UUID can never authenticate, and its handoff
// long-poll fails forever with nothing to show for it.
//
// Trial enrolment used to pass the id through. When that route was deleted
// nothing did, and the phone had no way to say which machine it had paired
// with. These pin the replacement.
// ---------------------------------------------------------------------------

test("a node registers under the id it minted for itself", async () => {
  const t = await startTestApp();
  try {
    const session = await signIn(t);
    const id = "node-0123456789abcdef";

    const created = await api(t.baseUrl, "POST", "/v1/nodes", {
      body: { id, kind: "byo", name: "My VM", pubkey: makeNodeIdentity().pubkeyPem },
      ...authed(session.sessionToken),
    });
    assert.equal(created.status, 201);
    assert.equal(created.json.node.id, id, "the cloud must not substitute an id of its own");

    const fetched = await api(t.baseUrl, "GET", `/v1/nodes/${id}`, authed(session.sessionToken));
    assert.equal(fetched.status, 200);
    assert.equal(fetched.json.node.id, id);
  } finally {
    await t.close();
  }
});

test("a malformed node id is refused rather than silently replaced", async () => {
  const t = await startTestApp();
  try {
    const session = await signIn(t);
    // Substituting a generated id for a bad one would be the worst outcome:
    // registration appears to succeed and the node never authenticates.
    for (const id of [
      "nope",
      "node-XYZ",
      "node-0123456789ABCDEF",
      "node-0123456789abcde",
      "../etc/passwd",
      "",
      42,
    ]) {
      const res = await api(t.baseUrl, "POST", "/v1/nodes", {
        body: { id, kind: "byo", pubkey: makeNodeIdentity().pubkeyPem },
        ...authed(session.sessionToken),
      });
      assert.equal(res.status, 400, `expected 400 for id ${JSON.stringify(id)}`);
      assert.equal(res.json.error, "invalid_node_id");
    }
    const list = await api(t.baseUrl, "GET", "/v1/nodes", authed(session.sessionToken));
    assert.equal(list.json.nodes.length, 0, "a refused registration must leave no node behind");
  } finally {
    await t.close();
  }
});

test("an already-registered node id is refused, including one owned by someone else", async () => {
  const t = await startTestApp();
  try {
    const owner = await signIn(t, { sub: "owner", email: "owner@example.com" });
    const stranger = await signIn(t, { sub: "stranger", email: "stranger@example.com" });
    const id = "node-abcdef0123456789";
    const body = { id, kind: "byo", pubkey: makeNodeIdentity().pubkeyPem };

    assert.equal((await api(t.baseUrl, "POST", "/v1/nodes", { body, ...authed(owner.sessionToken) })).status, 201);

    // Same error for the owner's duplicate and a stranger's attempt, so this
    // is not an oracle for which machine ids exist.
    const again = await api(t.baseUrl, "POST", "/v1/nodes", { body, ...authed(owner.sessionToken) });
    assert.equal(again.status, 409);
    assert.equal(again.json.error, "node_already_registered");

    const hijack = await api(t.baseUrl, "POST", "/v1/nodes", { body, ...authed(stranger.sessionToken) });
    assert.equal(hijack.status, 409);
    assert.equal(hijack.json.error, "node_already_registered");

    const strangerNodes = await api(t.baseUrl, "GET", "/v1/nodes", authed(stranger.sessionToken));
    assert.equal(strangerNodes.json.nodes.length, 0, "a refused claim must not attach the node to the claimant");
  } finally {
    await t.close();
  }
});
