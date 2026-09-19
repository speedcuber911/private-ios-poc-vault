import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";

import { startTestApp, api, signIn, authed, makeNodeIdentity } from "./helpers.mjs";
import { nodeRequestSigningInput } from "../src/nodeauth.js";
import { UNREACHABLE_AFTER_MS } from "../src/notify.js";

async function setup() {
  const t = await startTestApp();
  const session = await signIn(t);
  const identity = makeNodeIdentity();
  const nodeId = "node-watchdog00112233";
  t.app.registry.createNode(session.accountId, {
    id: nodeId,
    kind: "byo",
    name: "box-1",
    pubkey: identity.pubkeyPem,
  });
  const device = await api(t.baseUrl, "POST", "/v1/devices", {
    body: { apnsToken: "a".repeat(64), platform: "ios", name: "Phone" },
    ...authed(session.sessionToken),
  });
  assert.equal(device.status, 201);
  return { t, identity, nodeId };
}

function heartbeatHeaders(identity, nodeId, ts) {
  const pathWithQuery = "/v1/node/heartbeat";
  const signature = crypto.sign(
    null,
    nodeRequestSigningInput({ method: "POST", pathWithQuery, ts, nodeId }),
    identity.privateKey,
  );
  return {
    "x-relay-node": nodeId,
    "x-relay-ts": String(ts),
    "x-relay-signature": signature.toString("base64url"),
  };
}

test("POST /v1/node/heartbeat updates last_seen and does not push", async () => {
  const { t, identity, nodeId } = await setup();
  try {
    const res = await api(t.baseUrl, "POST", "/v1/node/heartbeat", {
      raw: Buffer.from("{}"),
      headers: heartbeatHeaders(identity, nodeId, t.clock.t),
    });
    assert.equal(res.status, 200);
    assert.equal(res.json.ok, true);
    const node = t.app.registry.getNode(nodeId);
    assert.equal(node.lastSeen, t.clock.t);
    await t.app.notify.drain();
    assert.equal(t.apnsTransport.requests.length, 0);
  } finally {
    await t.close();
  }
});

test("a heartbeat with a bad signature is 401 and does not touch last_seen", async () => {
  const { t, nodeId } = await setup();
  try {
    const res = await api(t.baseUrl, "POST", "/v1/node/heartbeat", {
      raw: Buffer.from("{}"),
      headers: {
        "x-relay-node": nodeId,
        "x-relay-ts": String(t.clock.t),
        "x-relay-signature": "not-a-signature",
      },
    });
    assert.equal(res.status, 401);
    assert.equal(t.app.registry.getNode(nodeId).lastSeen, null);
  } finally {
    await t.close();
  }
});

test("watchdog pages unreachable only after a live node goes quiet, then recovered", async () => {
  const { t, identity, nodeId } = await setup();
  try {
    const first = await api(t.baseUrl, "POST", "/v1/node/heartbeat", {
      raw: Buffer.from("{}"),
      headers: heartbeatHeaders(identity, nodeId, t.clock.t),
    });
    assert.equal(first.status, 200);

    t.app.notify.sweepWatchdog();
    await t.app.notify.drain();
    assert.equal(t.apnsTransport.requests.length, 0, "first live observation is silent");

    t.clock.t += UNREACHABLE_AFTER_MS + 1;
    t.app.notify.sweepWatchdog();
    await t.app.notify.drain();
    assert.equal(t.apnsTransport.requests.length, 1);
    const down = t.apnsTransport.requests[0].body;
    assert.equal(down.relay.type, "node.unreachable");
    assert.equal(down.aps.alert.title, "Machine is unreachable");
    assert.equal(down.aps.category, "RELAY_NODE_UNREACHABLE");

    t.apnsTransport.requests.length = 0;
    t.app.notify.sweepWatchdog();
    await t.app.notify.drain();
    assert.equal(t.apnsTransport.requests.length, 0, "already-unreachable does not re-page");

    t.clock.t += 1_000;
    const again = await api(t.baseUrl, "POST", "/v1/node/heartbeat", {
      raw: Buffer.from("{}"),
      headers: heartbeatHeaders(identity, nodeId, t.clock.t),
    });
    assert.equal(again.status, 200);
    t.app.notify.sweepWatchdog();
    await t.app.notify.drain();
    assert.equal(t.apnsTransport.requests.length, 1);
    const up = t.apnsTransport.requests[0].body;
    assert.equal(up.relay.type, "node.recovered");
    assert.equal(up.aps.alert.title, "Machine is back");
  } finally {
    await t.close();
  }
});

test("a stale last_seen on first observation does not page", async () => {
  const { t, nodeId } = await setup();
  try {
    t.app.registry.touchNode(nodeId);
    t.clock.t += UNREACHABLE_AFTER_MS + 1;
    t.app.notify.sweepWatchdog();
    await t.app.notify.drain();
    assert.equal(t.apnsTransport.requests.length, 0);
  } finally {
    await t.close();
  }
});

test("node.pressure is a mutable event with a fixed banner", async () => {
  const { t, identity, nodeId } = await setup();
  try {
    const body = Buffer.from(
      JSON.stringify({
        v: 1,
        nodeId,
        jobId: null,
        type: "node.pressure",
        ts: t.clock.t,
        seq: 1,
      }),
      "utf8",
    );
    const res = await api(t.baseUrl, "POST", "/v1/node-events", {
      raw: body,
      headers: { "x-relay-signature": identity.signBody(body) },
    });
    assert.equal(res.status, 202);
    assert.equal(res.json.kind, "mutable");
    await t.app.notify.drain();
    const push = t.apnsTransport.requests.at(-1).body;
    assert.equal(push.aps.alert.title, "Machine is under load");
    assert.equal(push.aps.category, "RELAY_NODE_PRESSURE");
    assert.deepEqual(Object.keys(push.relay).sort(), ["jobId", "nodeId", "seq", "ts", "type"]);
  } finally {
    await t.close();
  }
});
