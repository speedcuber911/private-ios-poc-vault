import { test } from "node:test";
import assert from "node:assert/strict";
import {
  startTestApp,
  api,
  authed,
  signIn,
  makeNodeIdentity,
  TEST_ADMIN_TOKEN,
  TEST_BROKER_TOKEN,
} from "./helpers.mjs";

test("entitlement gate: nodes.max enforced, raised limit honored", async () => {
  const t = await startTestApp();
  try {
    const session = await signIn(t);
    const id1 = makeNodeIdentity();
    const id2 = makeNodeIdentity();

    // First node fits the default entitlement (nodes.max = 1).
    let res = await api(t.baseUrl, "POST", "/v1/nodes", {
      body: { kind: "byo", name: "box-1", pubkey: id1.pubkeyPem },
      ...authed(session.sessionToken),
    });
    assert.equal(res.status, 201);

    // Second node exceeds it.
    res = await api(t.baseUrl, "POST", "/v1/nodes", {
      body: { kind: "byo", name: "box-2", pubkey: id2.pubkeyPem },
      ...authed(session.sessionToken),
    });
    assert.equal(res.status, 403);
    assert.equal(res.json.error, "entitlement_limit");
    assert.equal(res.json.feature, "nodes.max");

    // Raise the entitlement → second node registers.
    t.app.registry.setEntitlement(session.accountId, "nodes.max", "2");
    res = await api(t.baseUrl, "POST", "/v1/nodes", {
      body: { kind: "managed", name: "box-2", pubkey: id2.pubkeyPem },
      ...authed(session.sessionToken),
    });
    assert.equal(res.status, 201);

    // Bad kind and bad pubkey rejected.
    res = await api(t.baseUrl, "POST", "/v1/nodes", {
      body: { kind: "shared", pubkey: id1.pubkeyPem },
      ...authed(session.sessionToken),
    });
    assert.equal(res.status, 400);
    res = await api(t.baseUrl, "POST", "/v1/nodes", {
      body: { kind: "byo", pubkey: "not-a-key" },
      ...authed(session.sessionToken),
    });
    assert.equal(res.status, 400);

    const list = await api(t.baseUrl, "GET", "/v1/nodes", authed(session.sessionToken));
    assert.equal(list.json.nodes.length, 2);
  } finally {
    await t.close();
  }
});

test("devices CRUD: cert serials round-trip, cross-account isolation", async () => {
  const t = await startTestApp();
  try {
    const session = await signIn(t);
    let res = await api(t.baseUrl, "POST", "/v1/devices", {
      body: {
        name: "iPhone",
        platform: "ios",
        apnsToken: "tok-1",
        certSerials: ["01AB", "02CD"],
      },
      ...authed(session.sessionToken),
    });
    assert.equal(res.status, 201);
    const deviceId = res.json.device.id;
    assert.deepEqual(res.json.device.certSerials, ["01AB", "02CD"]);

    res = await api(t.baseUrl, "PATCH", `/v1/devices/${deviceId}`, {
      body: { certSerials: ["01AB", "02CD", "03EF"], apnsToken: "tok-2" },
      ...authed(session.sessionToken),
    });
    assert.equal(res.status, 200);
    assert.deepEqual(res.json.device.certSerials, ["01AB", "02CD", "03EF"]);
    assert.equal(res.json.device.apnsToken, "tok-2");

    // Another account cannot see or edit it.
    const other = await api(t.baseUrl, "POST", "/v1/auth/apple", {
      body: { identityToken: t.idp.mintIdentityToken({ sub: "other-sub", email: "o@x.com" }) },
    });
    res = await api(t.baseUrl, "GET", "/v1/devices", authed(other.json.sessionToken));
    assert.equal(res.json.devices.length, 0);
    res = await api(t.baseUrl, "PATCH", `/v1/devices/${deviceId}`, {
      body: { name: "stolen" },
      ...authed(other.json.sessionToken),
    });
    assert.equal(res.status, 404);

    // Delete.
    res = await api(t.baseUrl, "DELETE", `/v1/devices/${deviceId}`, authed(session.sessionToken));
    assert.equal(res.status, 204);
    res = await api(t.baseUrl, "GET", "/v1/devices", authed(session.sessionToken));
    assert.equal(res.json.devices.length, 0);
  } finally {
    await t.close();
  }
});

test("waitlist accepts emails; idempotent", async () => {
  const t = await startTestApp();
  try {
    let res = await api(t.baseUrl, "POST", "/v1/waitlist", {
      body: { email: "Wait@Example.com" },
    });
    assert.equal(res.status, 202);
    res = await api(t.baseUrl, "POST", "/v1/waitlist", {
      body: { email: "wait@example.com" },
    });
    assert.equal(res.status, 202);
    res = await api(t.baseUrl, "POST", "/v1/waitlist", { body: { email: "nope" } });
    assert.equal(res.status, 400);
  } finally {
    await t.close();
  }
});

test("admin and tunnel hooks: token-gated, correct payloads", async () => {
  const t = await startTestApp();
  try {
    const session = await signIn(t);
    const identity = makeNodeIdentity();
    const created = await api(t.baseUrl, "POST", "/v1/nodes", {
      body: { kind: "byo", name: "box-1", pubkey: identity.pubkeyPem },
      ...authed(session.sessionToken),
    });
    const nodeId = created.json.node.id;

    // Admin list: no token / wrong token → 401; session token is NOT ops auth.
    let res = await api(t.baseUrl, "GET", "/v1/admin/nodes");
    assert.equal(res.status, 401);
    res = await api(t.baseUrl, "GET", "/v1/admin/nodes", {
      headers: { authorization: "Bearer wrong" },
    });
    assert.equal(res.status, 401);
    res = await api(t.baseUrl, "GET", "/v1/admin/nodes", authed(session.sessionToken));
    assert.equal(res.status, 401);
    res = await api(t.baseUrl, "GET", "/v1/admin/nodes", {
      headers: { authorization: `Bearer ${TEST_ADMIN_TOKEN}` },
    });
    assert.equal(res.status, 200);
    assert.equal(res.json.nodes.length, 1);
    // Admin listing must not expose pubkeys (broker hook is for that) —
    // and must never contain anything credential-like.
    assert.equal(res.json.nodes[0].pubkey, undefined);

    // Tunnel hook: broker token required; returns pubkey for handshake auth.
    res = await api(t.baseUrl, "GET", `/v1/tunnel/nodes/${nodeId}`);
    assert.equal(res.status, 401);
    res = await api(t.baseUrl, "GET", `/v1/tunnel/nodes/${nodeId}`, {
      headers: { authorization: `Bearer ${TEST_ADMIN_TOKEN}` },
    });
    assert.equal(res.status, 401, "admin token must not work on the broker hook");
    res = await api(t.baseUrl, "GET", `/v1/tunnel/nodes/${nodeId}`, {
      headers: { authorization: `Bearer ${TEST_BROKER_TOKEN}` },
    });
    assert.equal(res.status, 200);
    assert.equal(res.json.nodeId, nodeId);
    assert.equal(res.json.pubkey, identity.pubkeyPem);
    res = await api(t.baseUrl, "GET", "/v1/tunnel/nodes/ghost", {
      headers: { authorization: `Bearer ${TEST_BROKER_TOKEN}` },
    });
    assert.equal(res.status, 404);
  } finally {
    await t.close();
  }
});

test("healthz is public; unknown routes 404; unauthed registry routes 401", async () => {
  const t = await startTestApp();
  try {
    let res = await api(t.baseUrl, "GET", "/healthz");
    assert.equal(res.status, 200);
    assert.deepEqual(res.json, { ok: true });

    res = await api(t.baseUrl, "GET", "/v1/nodes");
    assert.equal(res.status, 401);

    const session = await signIn(t);
    res = await api(t.baseUrl, "GET", "/v1/definitely-not-a-route", authed(session.sessionToken));
    assert.equal(res.status, 404);
  } finally {
    await t.close();
  }
});

// Task 8 review, M-5: a handoff row whose node no longer exists can never be
// delivered — nothing will ever poll for it again. deleteAccount already
// clears every handoff for an account in one transaction; deleteNode
// (single-node removal — BYO/managed delete, or the trial reaper's
// past-grace path) previously left these rows behind forever.
test("deleting a node also deletes its orphan handoff rows", async () => {
  const t = await startTestApp();
  try {
    const session = await signIn(t);
    const identity = makeNodeIdentity();
    const nodeId = "node-00112233445566aa";
    t.app.registry.createNode(session.accountId, { id: nodeId, kind: "trial", name: "Trial", pubkey: identity.pubkeyPem });
    await api(t.baseUrl, "POST", "/v1/repos", { body: { fullName: "me/relay" }, ...authed(session.sessionToken) });

    const handoffId = "a1b2c3d4e5f60718";
    t.app.registry.createHandoff({
      id: handoffId, accountId: session.accountId, nodeId, repo: "me/relay", branch: "relay/handoff-fix-auth",
    });
    assert.equal(t.app.registry.getHandoff(handoffId)?.state, "pending");

    t.app.registry.deleteNode(session.accountId, nodeId);
    assert.equal(t.app.registry.getHandoff(handoffId), null, "handoff rows for a deleted node must not be orphaned");
  } finally {
    await t.close();
  }
});
