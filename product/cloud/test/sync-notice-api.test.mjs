// Credential-sync notices: how a node learns that `relay sync-auth` left a
// sealed bundle in a rendezvous slot for it.
//
// The node has no way to discover a pending rendezvous session on its own —
// there is no route that lists them, and there must not be one (it would let
// anything holding a node identity enumerate an account's pairing sessions).
// So the CLI, after it PUTs the sealed blob, posts a NOTICE naming the
// pairing session; the node picks it up over the same node-authenticated
// long-poll it already holds open for handoffs, and collects the blob over
// the rendezvous itself.
//
// The notice carries the pairing SECRET, not the derived auth token: the node
// needs both halves of the protocol — authTokenFor(secret) to authorize the
// slot GET, and macKeyFor(secret) to verify the x-pairing-tag the sender
// computed. authToken alone is a one-way function of the secret, so a node
// holding only that could not verify the tag at all. What the seal (not the
// secret) protects is the payload: the bundle is sealed to the node's X25519
// key, so a cloud holding a pairing id and secret can read ciphertext, drop
// the slot, or refuse to deliver — never read a credential.
//
// Notices ride the SAME delivery lease as handoffs (Task 8): a poll hands out
// a lease, POST /v1/node/handoffs/ack is the only path to `delivered`, and an
// unconfirmed lease expires so the row becomes claimable again.

import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";

import { startTestApp, api, signIn, authed } from "./helpers.mjs";
import { nodeRequestSigningInput } from "../src/nodeauth.js";
import { SYNC_NOTICE_MAX_PENDING } from "../src/server.js";

const NODE_ID = "node-00112233445566bb";
const PAIRING_SECRET = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

function nodeIdentity() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  return { pubkeyPem: publicKey.export({ type: "spki", format: "pem" }), privateKey };
}

function nodeHeaders(identity, { method = "GET", pathWithQuery, ts, nodeId = NODE_ID }) {
  const signature = crypto.sign(null,
    nodeRequestSigningInput({ method, pathWithQuery, ts, nodeId }), identity.privateKey);
  return {
    headers: {
      "x-relay-node": nodeId,
      "x-relay-ts": String(ts),
      "x-relay-signature": signature.toString("base64url"),
    },
  };
}

function hardTimeout(ms, label) {
  return new Promise((_, reject) => {
    const timer = setTimeout(() => reject(new Error(`hard guard: ${label} exceeded ${ms}ms`)), ms);
    timer.unref?.();
  });
}

async function setup() {
  const t = await startTestApp();
  const session = await signIn(t);
  const identity = nodeIdentity();
  t.app.registry.createNode(session.accountId, {
    id: NODE_ID, kind: "trial", name: "Trial", pubkey: identity.pubkeyPem,
  });
  return { t, session, identity };
}

// Creates a real sync-auth rendezvous session the way the CLI does, and
// returns its pairing id. The auth token the cloud stores is derived from the
// secret exactly as product/cli/src/commands/syncauth.mjs derives it.
async function createRendezvous(t, session, kind = "sync-auth", secret = PAIRING_SECRET) {
  const authToken = crypto.createHash("sha256")
    .update(Buffer.concat([
      Buffer.from("relay-pair-auth-v1", "utf8"), Buffer.from([0]), Buffer.from(secret, "utf8"),
    ]))
    .digest("base64url");
  const created = await api(t.baseUrl, "POST", "/v1/pairing/sessions", {
    body: { authToken, kind }, ...authed(session.sessionToken),
  });
  assert.equal(created.status, 201, "setup: the rendezvous session must be created");
  return created.json.pairingId;
}

function postNotice(t, session, body) {
  return api(t.baseUrl, "POST", "/v1/sync-auth/notices", { body, ...authed(session.sessionToken) });
}

test("a posted notice reaches the node's poll, carrying the pairing id and secret", async () => {
  const { t, session, identity } = await setup();
  try {
    const pairingId = await createRendezvous(t, session);
    const posted = await postNotice(t, session, { pairingId, nodeId: NODE_ID, secret: PAIRING_SECRET });
    assert.equal(posted.status, 201);
    assert.equal(posted.json.notice.state, "pending");
    assert.ok(
      !JSON.stringify(posted.json).includes(PAIRING_SECRET),
      "the session-authed response must never echo the rendezvous secret back",
    );

    const pathWithQuery = "/v1/node/handoffs?wait=0";
    const poll = await api(t.baseUrl, "GET", pathWithQuery, nodeHeaders(identity, { pathWithQuery, ts: t.clock.t }));
    assert.equal(poll.status, 200);
    assert.deepEqual(poll.json.handoffs, [], "notices must ride alongside handoffs, not replace them");
    assert.equal(poll.json.notices.length, 1);
    assert.equal(poll.json.notices[0].pairingId, pairingId);
    assert.equal(poll.json.notices[0].secret, PAIRING_SECRET,
      "the node needs the secret to derive both the slot auth token and the MAC key");
    assert.equal(typeof poll.json.notices[0].lease, "string", "a notice is leased, exactly like a handoff");
  } finally { await t.close(); }
});

test("a notice becomes delivered only through the ack, and an unconfirmed lease is redelivered", async () => {
  const { t, session, identity } = await setup();
  try {
    const pairingId = await createRendezvous(t, session);
    await postNotice(t, session, { pairingId, nodeId: NODE_ID, secret: PAIRING_SECRET });

    const pollPath = "/v1/node/handoffs?wait=0";
    const first = await api(t.baseUrl, "GET", pollPath, nodeHeaders(identity, { pathWithQuery: pollPath, ts: t.clock.t }));
    const leased = first.json.notices[0];
    assert.equal(t.app.registry.getSyncNoticeByPairingId(pairingId).state, "leased",
      "a bare poll must not itself mark a notice delivered");

    // Still inside the lease window: not handed out twice.
    t.clock.t += 1;
    const again = await api(t.baseUrl, "GET", pollPath, nodeHeaders(identity, { pathWithQuery: pollPath, ts: t.clock.t }));
    assert.deepEqual(again.json.notices, [], "a live lease is not handed out a second time");

    // Past the lease with no ack: claimable again, with a fresh token.
    t.clock.t += t.config.handoffLeaseSec * 1000 + 1;
    const redelivered = await api(t.baseUrl, "GET", pollPath, nodeHeaders(identity, { pathWithQuery: pollPath, ts: t.clock.t }));
    assert.equal(redelivered.json.notices.length, 1, "an unconfirmed notice must never be lost");
    assert.notEqual(redelivered.json.notices[0].lease, leased.lease, "redelivery mints a fresh lease token");

    const ackPath = "/v1/node/handoffs/ack";
    t.clock.t += 1;
    const ack = await api(t.baseUrl, "POST", ackPath, {
      body: { notices: [{ id: redelivered.json.notices[0].id, lease: redelivered.json.notices[0].lease }] },
      ...nodeHeaders(identity, { method: "POST", pathWithQuery: ackPath, ts: t.clock.t }),
    });
    assert.equal(ack.status, 200);
    assert.deepEqual(ack.json.noticesAcked, [redelivered.json.notices[0].id]);
    assert.equal(t.app.registry.getSyncNoticeByPairingId(pairingId).state, "delivered");
  } finally { await t.close(); }
});

// The route only ever leases ids that listPendingSyncNotices just handed it,
// so this guard is not reachable over HTTP today — which is exactly why it is
// pinned here directly. It is what keeps "a notice is leased to one poll at a
// time" true if a second caller is ever added, rather than a property that
// happens to hold because of the call order in one route.
test("leaseSyncNotices refuses a notice that is not pending, rather than re-issuing it", async () => {
  const { t, session } = await setup();
  try {
    const pairingId = crypto.randomUUID();
    const notice = t.app.registry.createSyncNotice({
      accountId: session.accountId, nodeId: NODE_ID, pairingId,
      secret: PAIRING_SECRET, expiresAt: t.clock.t + 60_000,
    });

    const [leased] = t.app.registry.leaseSyncNotices([notice.id], NODE_ID, 30_000);
    assert.equal(typeof leased.leaseToken, "string");

    const again = t.app.registry.leaseSyncNotices([notice.id], NODE_ID, 30_000);
    assert.deepEqual(again, [], "a live lease must not be re-issued under a second token");
    assert.equal(t.app.registry.getSyncNoticeByPairingId(pairingId).leaseToken, leased.leaseToken,
      "the original lease token must survive the refused second lease");

    t.app.registry.confirmSyncNoticeDelivery(NODE_ID, [{ id: notice.id, lease: leased.leaseToken }]);
    assert.deepEqual(t.app.registry.leaseSyncNotices([notice.id], NODE_ID, 30_000), [],
      "an already-delivered notice must never be leased again");
  } finally { await t.close(); }
});

test("an ack naming the wrong lease token confirms nothing", async () => {
  const { t, session, identity } = await setup();
  try {
    const pairingId = await createRendezvous(t, session);
    await postNotice(t, session, { pairingId, nodeId: NODE_ID, secret: PAIRING_SECRET });
    const pollPath = "/v1/node/handoffs?wait=0";
    const poll = await api(t.baseUrl, "GET", pollPath, nodeHeaders(identity, { pathWithQuery: pollPath, ts: t.clock.t }));

    const ackPath = "/v1/node/handoffs/ack";
    t.clock.t += 1;
    const ack = await api(t.baseUrl, "POST", ackPath, {
      body: { notices: [{ id: poll.json.notices[0].id, lease: crypto.randomUUID() }] },
      ...nodeHeaders(identity, { method: "POST", pathWithQuery: ackPath, ts: t.clock.t }),
    });
    assert.equal(ack.status, 200);
    assert.deepEqual(ack.json.noticesAcked, []);
    assert.equal(t.app.registry.getSyncNoticeByPairingId(pairingId).state, "leased",
      "a wrong lease token must not reach delivered");
  } finally { await t.close(); }
});

test("an ack body naming neither handoffs nor notices is still refused", async () => {
  const { t, identity } = await setup();
  try {
    const ackPath = "/v1/node/handoffs/ack";
    const empty = await api(t.baseUrl, "POST", ackPath, {
      body: { acks: [], notices: [] },
      ...nodeHeaders(identity, { method: "POST", pathWithQuery: ackPath, ts: t.clock.t }),
    });
    assert.equal(empty.status, 400);
    assert.equal(empty.json.error, "invalid_ack");

    t.clock.t += 1;
    const oversized = await api(t.baseUrl, "POST", ackPath, {
      body: { notices: Array.from({ length: 51 }, () => ({ id: crypto.randomUUID(), lease: "l" })) },
      ...nodeHeaders(identity, { method: "POST", pathWithQuery: ackPath, ts: t.clock.t }),
    });
    assert.equal(oversized.status, 400, "a notice ack batch is bounded exactly like the handoff one");
  } finally { await t.close(); }
});

test("a notice for someone else's node, or an unknown pairing session, is refused", async () => {
  const { t, session } = await setup();
  try {
    const stranger = await signIn(t, { sub: "apple-sub-2", email: "other@example.com" });
    const pairingId = await createRendezvous(t, session);

    const foreign = await postNotice(t, stranger, { pairingId, nodeId: NODE_ID, secret: PAIRING_SECRET });
    assert.equal(foreign.status, 404, "a node belonging to another account must not be notifiable");
    assert.equal(foreign.json.error, "unknown_node");

    const unknownSession = await postNotice(t, session, {
      pairingId: crypto.randomUUID(), nodeId: NODE_ID, secret: PAIRING_SECRET,
    });
    assert.equal(unknownSession.status, 404);
    assert.equal(unknownSession.json.error, "unknown_pairing_session");

    // A real session belonging to someone else is refused the same way, and
    // the refusal does not distinguish "not yours" from "never existed".
    const strangersSession = await createRendezvous(t, stranger, "sync-auth", "BBBBBBBBBBBBBBBBBBBBBBBB");
    const crossAccount = await postNotice(t, session, {
      pairingId: strangersSession, nodeId: NODE_ID, secret: "BBBBBBBBBBBBBBBBBBBBBBBB",
    });
    assert.equal(crossAccount.status, 404);
    assert.equal(crossAccount.json.error, "unknown_pairing_session");
  } finally { await t.close(); }
});

test("a notice for a plain `pair` rendezvous, or with a malformed secret, is refused", async () => {
  const { t, session } = await setup();
  try {
    const pairKind = await createRendezvous(t, session, "pair", "CCCCCCCCCCCCCCCCCCCCCCCC");
    const wrongKind = await postNotice(t, session, {
      pairingId: pairKind, nodeId: NODE_ID, secret: "CCCCCCCCCCCCCCCCCCCCCCCC",
    });
    assert.equal(wrongKind.status, 404, "device pairing is redeemed on the node's own listener, never through this route");

    const pairingId = await createRendezvous(t, session);
    for (const secret of [undefined, "", "short", "has spaces in it", "a".repeat(129), 12345, { a: 1 }]) {
      const res = await postNotice(t, session, { pairingId, nodeId: NODE_ID, secret });
      assert.equal(res.status, 400, `secret ${JSON.stringify(secret)} must be refused`);
      assert.equal(res.json.error, "invalid_notice");
    }
  } finally { await t.close(); }
});

test("posting the same pairing id twice is idempotent rather than duplicating the notice", async () => {
  const { t, session, identity } = await setup();
  try {
    const pairingId = await createRendezvous(t, session);
    const first = await postNotice(t, session, { pairingId, nodeId: NODE_ID, secret: PAIRING_SECRET });
    const second = await postNotice(t, session, { pairingId, nodeId: NODE_ID, secret: PAIRING_SECRET });
    assert.equal(second.status, 201);
    assert.equal(second.json.notice.id, first.json.notice.id);

    const pollPath = "/v1/node/handoffs?wait=0";
    const poll = await api(t.baseUrl, "GET", pollPath, nodeHeaders(identity, { pathWithQuery: pollPath, ts: t.clock.t }));
    assert.equal(poll.json.notices.length, 1, "one rendezvous is one notice, however many times it is announced");
  } finally { await t.close(); }
});

test("a node cannot be made to accumulate unbounded pending notices", async () => {
  const { t, session } = await setup();
  try {
    // Straight through the registry: the per-(account, kind) rendezvous quota
    // would otherwise cap this long before the notice ceiling is reached,
    // which is exactly the hole this ceiling exists to close (sessions expire
    // and are swept; the notices they left behind do not).
    for (let index = 0; index < SYNC_NOTICE_MAX_PENDING; index += 1) {
      t.app.registry.createSyncNotice({
        accountId: session.accountId, nodeId: NODE_ID, pairingId: crypto.randomUUID(),
        secret: PAIRING_SECRET, expiresAt: t.clock.t + 60_000,
      });
    }
    const pairingId = await createRendezvous(t, session);
    const refused = await postNotice(t, session, { pairingId, nodeId: NODE_ID, secret: PAIRING_SECRET });
    assert.equal(refused.status, 429);
    assert.equal(refused.json.error, "too_many_sync_notices");
  } finally { await t.close(); }
});

// The mirror of the wake test: a notice that is ALREADY pending when the
// poll arrives must not be parked behind an empty handoff list — it answers
// straight away, exactly as a pending handoff does.
test("a poll never parks while a notice is already waiting for that node", async () => {
  const { t, session, identity } = await setup();
  try {
    const pairingId = await createRendezvous(t, session);
    await postNotice(t, session, { pairingId, nodeId: NODE_ID, secret: PAIRING_SECRET });

    const pathWithQuery = "/v1/node/handoffs?wait=25";
    const poll = await Promise.race([
      api(t.baseUrl, "GET", pathWithQuery, nodeHeaders(identity, { pathWithQuery, ts: t.clock.t })),
      hardTimeout(2000, "a poll with a notice already pending"),
    ]);
    assert.equal(poll.json.notices.length, 1);
    assert.equal(t.app.handoffWaiters.size, 0, "nothing should have been parked at all");
  } finally { await t.close(); }
});

test("a parked long-poll wakes the moment a notice is posted", async () => {
  const { t, session, identity } = await setup();
  try {
    const pathWithQuery = "/v1/node/handoffs?wait=25";
    const polling = api(t.baseUrl, "GET", pathWithQuery, nodeHeaders(identity, { pathWithQuery, ts: t.clock.t }));
    // Let the poll actually park before the notice lands.
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(t.app.handoffWaiters.get(NODE_ID)?.size, 1, "the poll must be parked, or this proves nothing");

    const pairingId = await createRendezvous(t, session);
    await postNotice(t, session, { pairingId, nodeId: NODE_ID, secret: PAIRING_SECRET });

    const poll = await Promise.race([polling, hardTimeout(3000, "a parked poll waiting for a notice")]);
    assert.equal(poll.json.notices.length, 1, "a notice must wake the long-poll, not wait out the full 25s");
  } finally { await t.close(); }
});

// A notice whose rendezvous has already expired is still DELIVERED, on
// purpose: the node's collect then fails at the slot (401) and it raises a
// visible "re-run relay sync-auth" failure. Dropping it here instead would
// leave the user believing their sandbox is authenticated when it is not —
// the single worst outcome for this feature.
test("a notice whose rendezvous already expired is delivered anyway, so the failure is visible", async () => {
  const { t, session, identity } = await setup();
  try {
    const pairingId = await createRendezvous(t, session);
    await postNotice(t, session, { pairingId, nodeId: NODE_ID, secret: PAIRING_SECRET });

    // Past the rendezvous TTL: the pairing session itself is swept away.
    t.clock.t += t.config.pairingTtlSec * 1000 + 1;
    t.app.runSweeps();
    assert.equal(t.app.registry.getPairingSession(pairingId), null, "setup: the rendezvous is gone");

    const pollPath = "/v1/node/handoffs?wait=0";
    const poll = await api(t.baseUrl, "GET", pollPath, nodeHeaders(identity, { pathWithQuery: pollPath, ts: t.clock.t }));
    assert.equal(poll.json.notices.length, 1,
      "an expired rendezvous must still reach the node so it can fail visibly rather than silently");
  } finally { await t.close(); }
});

test("a notice dies with its node and with its account — a rendezvous secret is not left lying around", async () => {
  const { t, session, identity } = await setup();
  try {
    const first = await createRendezvous(t, session, "sync-auth", "DDDDDDDDDDDDDDDDDDDDDDDD");
    await postNotice(t, session, { pairingId: first, nodeId: NODE_ID, secret: "DDDDDDDDDDDDDDDDDDDDDDDD" });
    t.app.registry.deleteNode(session.accountId, NODE_ID);
    assert.equal(t.app.registry.getSyncNoticeByPairingId(first), null,
      "nothing will ever poll for a deleted node's notice again");

    t.app.registry.createNode(session.accountId, {
      id: NODE_ID, kind: "trial", name: "Trial", pubkey: identity.pubkeyPem,
    });
    const second = await createRendezvous(t, session, "sync-auth", "EEEEEEEEEEEEEEEEEEEEEEEE");
    await postNotice(t, session, { pairingId: second, nodeId: NODE_ID, secret: "EEEEEEEEEEEEEEEEEEEEEEEE" });
    t.app.registry.deleteAccount(session.accountId);
    assert.equal(t.app.registry.getSyncNoticeByPairingId(second), null);
  } finally { await t.close(); }
});

test("a notice is swept once it is far past any use, but not while it can still explain itself", async () => {
  const { t, session } = await setup();
  try {
    const pairingId = await createRendezvous(t, session);
    await postNotice(t, session, { pairingId, nodeId: NODE_ID, secret: PAIRING_SECRET });

    // Past the rendezvous TTL but inside the grace window: the row survives,
    // so a node that reconnects here still gets a visible failure instead of
    // silence.
    t.clock.t += t.config.pairingTtlSec * 1000 + 1;
    t.app.runSweeps();
    assert.ok(t.app.registry.getSyncNoticeByPairingId(pairingId), "still inside the grace window: not swept yet");

    t.clock.t += 60 * 60 * 1000;
    t.app.runSweeps();
    assert.equal(t.app.registry.getSyncNoticeByPairingId(pairingId), null, "a long-dead notice must not pin a row forever");
  } finally { await t.close(); }
});

// The node reports the outcome of a credential sync back over the ordinary
// node-event channel; without these types the cloud answers 400 invalid_event
// and the user's phone is told nothing at all — the silent failure this whole
// feature is written to avoid.
test("credential-sync outcomes are accepted node event types, and the failure is user-visible", async () => {
  const { t, session, identity } = await setup();
  try {
    await api(t.baseUrl, "POST", "/v1/devices", {
      body: { apnsToken: "a".repeat(64), platform: "ios", name: "Phone" }, ...authed(session.sessionToken),
    });

    let seq = t.clock.t;
    async function postEvent(type) {
      const body = Buffer.from(JSON.stringify({ v: 1, nodeId: NODE_ID, type, ts: t.clock.t, seq: ++seq }), "utf8");
      const signature = crypto.sign(null, body, identity.privateKey).toString("base64url");
      return api(t.baseUrl, "POST", "/v1/node-events", {
        raw: body, headers: { "x-relay-signature": signature },
      });
    }

    const failed = await postEvent("credentials.failed");
    assert.equal(failed.status, 202, "a credential sync that failed must be pushable");
    assert.equal(failed.json.kind, "mutable", "the user has to be told to re-run relay sync-auth");

    const installed = await postEvent("credentials.installed");
    assert.equal(installed.status, 202);

    await t.app.notify.drain?.();
    const categories = t.apnsTransport.requests.map((request) => request.body?.aps?.category);
    assert.ok(categories.includes("RELAY_CREDENTIALS_FAILED"),
      `expected a credentials-failed push category, saw ${JSON.stringify(categories)}`);
  } finally { await t.close(); }
});
