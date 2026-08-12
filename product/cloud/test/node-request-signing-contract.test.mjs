// Golden-vector pin for the node-request signing string — the wire contract
// between this cloud (nodeauth.js) and relayd's already-shipped
// cloudclient.mjs `signedHeaders`. Both sides independently declare
// NODE_REQUEST_LABEL = "relay-node-req-v1" and build the same five-line
// canonical string; relayd's copy is pinned to a hand-transcribed literal
// (product/relayd/test/cloudclient.test.mjs `SIGNING_LABEL` and the template
// strings that use it) — the cloud's was not.
//
// EVERY OTHER cloud test that touches this string (nodeauth.test.mjs,
// handoff-api.test.mjs, sync-auth tests, ...) builds its expected signature
// by CALLING nodeRequestSigningInput from the implementation under test. That
// makes the test and a drift in that function move together: change the
// label, swap two fields' order, change the separator, add or drop a field —
// every one of those tests keeps signing with the new (wrong) string and
// keeps passing. This is exactly what let the branch-seam review's F3
// through: the label was changed to "relay-node-req-v2-DRIFT" and the cloud
// suite ran 215/215 green while every real node poll and every real ack
// would have started returning 401 in production, silently, forever — a
// `relay handoff` push succeeds at the terminal, the branch lands, the row
// is created, and the node never hears about it.
//
// This file is different on purpose. The expected string below is
// HAND-TRANSCRIBED to match relayd's pinned literal byte for byte, and it
// imports NOTHING from nodeauth.js except the function under test — never
// NODE_REQUEST_LABEL, never any other exported constant that could drift in
// lockstep with the literal. Do not "simplify" this by referencing
// NODE_REQUEST_LABEL or by assembling the expected string from pieces shared
// with the implementation: the whole point is that it stays correct even if
// nodeauth.js is rewritten from scratch.
import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";

import { createDb } from "../src/db.js";
import { createRegistry } from "../src/registry.js";
import { verifyNodeRequest, nodeRequestSigningInput } from "../src/nodeauth.js";

test("nodeRequestSigningInput matches the literal wire contract relayd's cloudclient.mjs also pins (golden vector)", () => {
  const input = nodeRequestSigningInput({
    method: "get", // lower-case on purpose — the function must upper-case it
    pathWithQuery: "/v1/node/handoffs?wait=20",
    ts: 1754700000123,
    nodeId: "node-00112233445566aa",
  });

  // Hand-transcribed literal. Five lines, in this exact order, joined by
  // "\n": the label, the upper-cased method, the path+query, the node id,
  // the timestamp. Nothing else.
  const expected =
    "relay-node-req-v1\n" +
    "GET\n" +
    "/v1/node/handoffs?wait=20\n" +
    "node-00112233445566aa\n" +
    "1754700000123";

  assert.equal(input.toString("utf8"), expected);
});

// Belt and suspenders: the golden vector above pins the BYTES
// nodeRequestSigningInput produces in isolation. This test proves those
// exact bytes are also what the server actually authenticates against — by
// signing the hand-built literal (not the function's output) and checking it
// verifies through the real verifyNodeRequest path. If the function and the
// route it feeds were ever to diverge (the function returns the golden
// string but something else gets signed/verified on the wire), this is what
// would catch it; the test above alone would not.
test("a signature over the hand-built canonical string authenticates through verifyNodeRequest", () => {
  const clock = { t: 1754700000123 };
  const registry = createRegistry(createDb(":memory:"), { now: () => clock.t });
  const account = registry.createAccount({ appleSub: "apple-golden-vector", email: "golden-vector@example.com" });
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  const nodeId = "node-00112233445566aa";
  registry.createNode(account.id, {
    id: nodeId, kind: "trial", name: "Golden",
    pubkey: publicKey.export({ type: "spki", format: "pem" }),
  });

  const pathWithQuery = "/v1/node/handoffs?wait=20";
  const ts = clock.t;
  // Independent of nodeRequestSigningInput — assembled here, by hand, from
  // the same literal five-line template as the test above.
  const canonical = `relay-node-req-v1\nGET\n${pathWithQuery}\n${nodeId}\n${ts}`;
  const signature = crypto.sign(null, Buffer.from(canonical, "utf8"), privateKey);

  const req = {
    method: "GET",
    headers: {
      "x-relay-node": nodeId,
      "x-relay-ts": String(ts),
      "x-relay-signature": signature.toString("base64url"),
    },
  };
  const result = verifyNodeRequest(req, pathWithQuery, { registry, now: () => clock.t, allowReplay: true });
  assert.equal(result.node?.id, nodeId, `hand-built canonical string did not authenticate: ${result.error}`);

  // Cross-check, so a future edit to either test alone still leaves the tie
  // between the literal and the function explicit in this file.
  const viaFunction = nodeRequestSigningInput({ method: "GET", pathWithQuery, ts, nodeId });
  assert.equal(viaFunction.toString("utf8"), canonical);
});
