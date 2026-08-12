import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";

import { createDb } from "../src/db.js";
import { createRegistry } from "../src/registry.js";
import { verifyNodeRequest, nodeRequestSigningInput, createReplayGuard } from "../src/nodeauth.js";

const NODE_ID = "node-00112233445566aa";

function setup() {
  const clock = { t: 1_800_000_000_000 };
  const registry = createRegistry(createDb(":memory:"), { now: () => clock.t });
  const account = registry.createAccount({ appleSub: "apple-1", email: "a@example.com" });
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  registry.createNode(account.id, {
    id: NODE_ID, kind: "trial", name: "Trial",
    pubkey: publicKey.export({ type: "spki", format: "pem" }),
  });
  return { clock, registry, privateKey };
}

function signedRequest({ privateKey, method = "GET", pathWithQuery = "/v1/node/handoffs?wait=5", ts, nodeId = NODE_ID }) {
  const signature = crypto.sign(null, nodeRequestSigningInput({ method, pathWithQuery, ts, nodeId }), privateKey);
  return {
    method,
    headers: {
      "x-relay-node": nodeId,
      "x-relay-ts": String(ts),
      "x-relay-signature": signature.toString("base64url"),
    },
  };
}

test("a correctly signed request resolves to its node", () => {
  const { clock, registry, privateKey } = setup();
  const req = signedRequest({ privateKey, ts: clock.t });
  const result = verifyNodeRequest(req, "/v1/node/handoffs?wait=5", { registry, now: () => clock.t });
  assert.equal(result.node.id, NODE_ID);
});

test("a signature bound to a different path or method is refused", () => {
  const { clock, registry, privateKey } = setup();
  const req = signedRequest({ privateKey, ts: clock.t, pathWithQuery: "/v1/node/handoffs?wait=5" });

  assert.equal(verifyNodeRequest(req, "/v1/node/handoffs?wait=25", { registry, now: () => clock.t }).error, "bad_signature");
  assert.equal(verifyNodeRequest({ ...req, method: "POST" }, "/v1/node/handoffs?wait=5", { registry, now: () => clock.t }).error,
    "bad_signature");
});

test("stale and future timestamps are refused", () => {
  const { clock, registry, privateKey } = setup();
  const stale = signedRequest({ privateKey, ts: clock.t - 11 * 60 * 1000 });
  const future = signedRequest({ privateKey, ts: clock.t + 3 * 60 * 1000 });
  assert.equal(verifyNodeRequest(stale, "/v1/node/handoffs?wait=5", { registry, now: () => clock.t }).error, "bad_ts");
  assert.equal(verifyNodeRequest(future, "/v1/node/handoffs?wait=5", { registry, now: () => clock.t }).error, "bad_ts");
});

test("another node's key cannot sign for this node", () => {
  const { clock, registry } = setup();
  const stranger = crypto.generateKeyPairSync("ed25519").privateKey;
  const req = signedRequest({ privateKey: stranger, ts: clock.t });
  assert.equal(verifyNodeRequest(req, "/v1/node/handoffs?wait=5", { registry, now: () => clock.t }).error, "bad_signature");
});

test("missing headers and unknown nodes are reported distinctly", () => {
  const { clock, registry, privateKey } = setup();
  assert.equal(verifyNodeRequest({ method: "GET", headers: {} }, "/x", { registry, now: () => clock.t }).error,
    "missing_signature");
  const req = signedRequest({ privateKey, ts: clock.t, nodeId: "node-ffffffffffffffff" });
  assert.equal(verifyNodeRequest(req, "/v1/node/handoffs?wait=5", { registry, now: () => clock.t }).error, "unknown_node");
});

// Task 8 review, I-3: a captured (nodeId, ts, signature) triple is otherwise
// a pure bearer credential for the whole 10-minute freshness window. A
// replayGuard makes a byte-identical replay of it fail the second time.
test("a replay guard allows the first use of a signature and rejects an identical replay", () => {
  const { clock, registry, privateKey } = setup();
  const guard = createReplayGuard();
  const req = signedRequest({ privateKey, ts: clock.t });

  const first = verifyNodeRequest(req, "/v1/node/handoffs?wait=5", { registry, now: () => clock.t, replayGuard: guard });
  assert.equal(first.node.id, NODE_ID);

  const replay = verifyNodeRequest(req, "/v1/node/handoffs?wait=5", { registry, now: () => clock.t, replayGuard: guard });
  assert.equal(replay.error, "replayed");
});

// The guard is opt-in per call site: without one, verifyNodeRequest behaves
// exactly as before (a future read-only node-signed GET may choose not to
// pay for replay tracking).
test("without a replayGuard, verifyNodeRequest does not track replays", () => {
  const { clock, registry, privateKey } = setup();
  const req = signedRequest({ privateKey, ts: clock.t });
  assert.equal(verifyNodeRequest(req, "/v1/node/handoffs?wait=5", { registry, now: () => clock.t }).node.id, NODE_ID);
  assert.equal(verifyNodeRequest(req, "/v1/node/handoffs?wait=5", { registry, now: () => clock.t }).node.id, NODE_ID);
});

// A different node id, timestamp, or signature is a distinct claim even if
// one of the three fields matches a previously-seen request.
test("a replay guard's claim is keyed on the full (nodeId, ts, signature) triple", () => {
  const { clock, registry, privateKey } = setup();
  const guard = createReplayGuard();
  const req1 = signedRequest({ privateKey, ts: clock.t });
  assert.equal(verifyNodeRequest(req1, "/v1/node/handoffs?wait=5", { registry, now: () => clock.t, replayGuard: guard }).node.id, NODE_ID);

  const req2 = signedRequest({ privateKey, ts: clock.t + 1 });
  assert.equal(verifyNodeRequest(req2, "/v1/node/handoffs?wait=5", { registry, now: () => clock.t, replayGuard: guard }).node.id, NODE_ID,
    "a different ts (and therefore a different signature) is not a replay");
});
