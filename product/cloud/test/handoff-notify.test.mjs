import test from "node:test";
import assert from "node:assert/strict";

import { startTestApp, api, signIn, makeNodeIdentity } from "./helpers.mjs";

const NODE_ID = "node-00112233445566aa";

async function setup() {
  const t = await startTestApp();
  const session = await signIn(t);
  const identity = makeNodeIdentity();
  t.app.registry.createNode(session.accountId, { id: NODE_ID, kind: "trial", name: "Trial", pubkey: identity.pubkeyPem });
  t.app.registry.createDevice(session.accountId, { apnsToken: "a".repeat(64), platform: "ios", name: "iPhone" });
  return { t, identity };
}

async function postEvent(t, identity, type, seq) {
  const body = Buffer.from(JSON.stringify({ v: 1, nodeId: NODE_ID, jobId: null, type, ts: t.clock.t, seq }), "utf8");
  return api(t.baseUrl, "POST", "/v1/node-events", { raw: body, headers: { "x-relay-signature": identity.signBody(body) } });
}

test("handoff.ready is accepted and delivered as an alert push", async () => {
  const { t, identity } = await setup();
  try {
    const res = await postEvent(t, identity, "handoff.ready", 1);
    assert.equal(res.status, 202);
    assert.equal(res.json.kind, "mutable");

    await t.app.notify.drain();
    const request = t.apnsTransport.requests.at(-1);
    assert.equal(request.headers["apns-push-type"], "alert");
    assert.equal(request.body.aps.category, "RELAY_HANDOFF_READY");
  } finally { await t.close(); }
});

test("handoff.failed is a distinct alert category", async () => {
  const { t, identity } = await setup();
  try {
    await postEvent(t, identity, "handoff.failed", 1);
    await t.app.notify.drain();
    assert.equal(t.apnsTransport.requests.at(-1).body.aps.category, "RELAY_HANDOFF_FAILED");
  } finally { await t.close(); }
});

test("the push payload carries no handoff content", async () => {
  const { t, identity } = await setup();
  try {
    await postEvent(t, identity, "handoff.ready", 1);
    await t.app.notify.drain();
    const payload = t.apnsTransport.requests.at(-1).body;
    assert.deepEqual(Object.keys(payload.relay).sort(), ["jobId", "nodeId", "seq", "ts", "type"]);
  } finally { await t.close(); }
});
