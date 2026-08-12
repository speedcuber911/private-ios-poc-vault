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

function nodeHeaders(identity, { method = "GET", pathWithQuery, ts }) {
  const signature = crypto.sign(null,
    nodeRequestSigningInput({ method, pathWithQuery, ts, nodeId: NODE_ID }), identity.privateKey);
  return { headers: { "x-relay-node": NODE_ID, "x-relay-ts": String(ts), "x-relay-signature": signature.toString("base64url") } };
}

async function setup() {
  const t = await startTestApp();
  const session = await signIn(t);
  const identity = nodeIdentity();
  t.app.registry.createNode(session.accountId, { id: NODE_ID, kind: "trial", name: "Trial", pubkey: identity.pubkeyPem });
  await api(t.baseUrl, "POST", "/v1/repos", { body: { fullName: "me/relay" }, ...authed(session.sessionToken) });
  return { t, session, identity };
}

const PING = { handoffId: HANDOFF_ID, repo: "me/relay", branch: "relay/handoff-fix-auth", nodeId: NODE_ID };

test("a ping creates a pending handoff the node then collects", async () => {
  const { t, session, identity } = await setup();
  try {
    const ping = await api(t.baseUrl, "POST", "/v1/handoffs", { body: PING, ...authed(session.sessionToken) });
    assert.equal(ping.status, 201);
    assert.equal(ping.json.handoff.state, "pending");

    const pathWithQuery = "/v1/node/handoffs?wait=0";
    const poll = await api(t.baseUrl, "GET", pathWithQuery, nodeHeaders(identity, { pathWithQuery, ts: t.clock.t }));
    assert.equal(poll.status, 200);
    assert.equal(poll.json.handoffs.length, 1);
    assert.deepEqual(
      { id: poll.json.handoffs[0].id, repo: poll.json.handoffs[0].repo, branch: poll.json.handoffs[0].branch },
      { id: HANDOFF_ID, repo: "me/relay", branch: "relay/handoff-fix-auth" },
    );
    assert.equal(t.app.registry.getHandoff(HANDOFF_ID).state, "delivered");

    const again = await api(t.baseUrl, "GET", pathWithQuery, nodeHeaders(identity, { pathWithQuery, ts: t.clock.t }));
    assert.deepEqual(again.json.handoffs, [], "a delivered handoff is not handed out twice");
  } finally { await t.close(); }
});

test("the ping is content-free: only names are accepted and stored", async () => {
  const { t, session } = await setup();
  try {
    const res = await api(t.baseUrl, "POST", "/v1/handoffs", {
      body: { ...PING, transcript: "secret conversation", manifest: { goal: "secret" } },
      ...authed(session.sessionToken),
    });
    assert.equal(res.status, 201);
    assert.deepEqual(Object.keys(res.json.handoff).sort(),
      ["branch", "createdAt", "deliveredAt", "id", "nodeId", "reason", "repo", "state", "updatedAt"]);
    const row = t.app.registry.getHandoff(HANDOFF_ID);
    assert.equal(row.transcript, undefined);
    assert.equal(row.manifest, undefined);
  } finally { await t.close(); }
});

test("a ping for an unregistered repo or a foreign node is refused", async () => {
  const { t, session } = await setup();
  try {
    const badRepo = await api(t.baseUrl, "POST", "/v1/handoffs", {
      body: { ...PING, repo: "me/never-registered" }, ...authed(session.sessionToken),
    });
    assert.equal(badRepo.status, 404);
    assert.equal(badRepo.json.error, "unknown_repo");

    const other = await signIn(t, { sub: "apple-b", email: "b@example.com" });
    await api(t.baseUrl, "POST", "/v1/repos", { body: { fullName: "me/relay" }, ...authed(other.sessionToken) });
    const badNode = await api(t.baseUrl, "POST", "/v1/handoffs", { body: PING, ...authed(other.sessionToken) });
    assert.equal(badNode.status, 404);
    assert.equal(badNode.json.error, "unknown_node");
  } finally { await t.close(); }
});

test("pings are idempotent on handoffId", async () => {
  const { t, session } = await setup();
  try {
    await api(t.baseUrl, "POST", "/v1/handoffs", { body: PING, ...authed(session.sessionToken) });
    const repeat = await api(t.baseUrl, "POST", "/v1/handoffs", { body: PING, ...authed(session.sessionToken) });
    assert.equal(repeat.status, 201);
    assert.equal(t.app.registry.listHandoffsForRepo(session.accountId, "me/relay", 50).length, 1);
  } finally { await t.close(); }
});

test("a waiting node is woken by a ping instead of waiting out the poll", async () => {
  const { t, session, identity } = await setup();
  try {
    const pathWithQuery = "/v1/node/handoffs?wait=20";
    const started = Date.now();
    const polling = api(t.baseUrl, "GET", pathWithQuery, nodeHeaders(identity, { pathWithQuery, ts: t.clock.t }));
    await new Promise((resolve) => setTimeout(resolve, 50));
    await api(t.baseUrl, "POST", "/v1/handoffs", { body: PING, ...authed(session.sessionToken) });

    const poll = await polling;
    assert.equal(poll.json.handoffs.length, 1);
    assert.ok(Date.now() - started < 5000, "the waiter returned as soon as the ping landed");
  } finally { await t.close(); }
});

test("an empty long-poll returns an empty list rather than hanging forever", async () => {
  const { t, identity } = await setup();
  try {
    const pathWithQuery = "/v1/node/handoffs?wait=1";
    const poll = await api(t.baseUrl, "GET", pathWithQuery, nodeHeaders(identity, { pathWithQuery, ts: t.clock.t }));
    assert.equal(poll.status, 200);
    assert.deepEqual(poll.json.handoffs, []);
  } finally { await t.close(); }
});

test("an unsigned node poll is refused", async () => {
  const { t } = await setup();
  try {
    const res = await api(t.baseUrl, "GET", "/v1/node/handoffs?wait=0");
    assert.equal(res.status, 401);
  } finally { await t.close(); }
});

test("the owner can list handoffs for a repo", async () => {
  const { t, session } = await setup();
  try {
    await api(t.baseUrl, "POST", "/v1/handoffs", { body: PING, ...authed(session.sessionToken) });
    const list = await api(t.baseUrl, "GET", "/v1/handoffs?repo=me%2Frelay", authed(session.sessionToken));
    assert.equal(list.status, 200);
    assert.equal(list.json.handoffs[0].branch, "relay/handoff-fix-auth");
  } finally { await t.close(); }
});
