import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { request as httpRequest } from "node:http";
import { createServer as createTcpServer, createConnection } from "node:net";

import { startTestApp, api, signIn, authed } from "./helpers.mjs";
import { nodeRequestSigningInput } from "../src/nodeauth.js";
import { loadConfig } from "../src/config.js";
import { HANDOFF_MAX_WAITERS_PER_NODE } from "../src/server.js";

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

// A hard guard for anything that awaits a long-poll. node:test's per-test
// `timeout` does NOT kill a hung async loop underneath it — it marks the
// test cancelled while the loop (and any open socket/timer it holds) keeps
// running, which is how a broken fix leaves orphaned node processes behind
// instead of a clean, fast test failure. Every long-poll await in this file
// is raced against this instead of trusted to the runner. The guard timer
// itself is unref()'d so it never becomes the reason the process hangs.
function hardTimeout(ms, label) {
  return new Promise((_, reject) => {
    const timer = setTimeout(() => reject(new Error(`hard guard: ${label} exceeded ${ms}ms`)), ms);
    timer.unref?.();
  });
}

// Polls a real predicate against real wall-clock time (not the fake
// `t.clock`) — for observing server-side effects of a raw socket disconnect,
// which happens on its own schedule.
function waitUntil(predicate, timeoutMs, intervalMs = 15) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const tick = () => {
      if (predicate()) return resolve();
      if (Date.now() - start > timeoutMs) return reject(new Error(`waitUntil: condition not met within ${timeoutMs}ms`));
      setTimeout(tick, intervalMs);
    };
    tick();
  });
}

// A real network-partition proxy, not a simulated close — the shape the
// review's reproduction used. Sits in front of the real app's TCP port and
// forwards CLIENT -> SERVER bytes normally (so the app fully receives and
// processes the request, exactly as it would over a live connection), but
// NEVER forwards SERVER -> CLIENT bytes: they are drained into the void
// instead of being piped back. This is what a silent packet black-hole looks
// like from the server's side — the proxy<->app socket is never destroyed,
// never FINs, never errors, so `req.destroyed`/`close` never fire on it —
// while "the node" (whatever is on the other side of the proxy) receives
// nothing, ever. No timing race is needed: the black hole is unconditional
// from the first byte, not something toggled mid-flight.
function startBlackholeProxy(targetPort) {
  return new Promise((resolve) => {
    const legs = [];
    const proxy = createTcpServer((clientSocket) => {
      const serverSocket = createConnection({ port: targetPort, host: "127.0.0.1" }, () => {
        clientSocket.pipe(serverSocket); // request bytes: forwarded normally
        serverSocket.resume(); // response bytes: read and discarded, never forwarded
      });
      clientSocket.on("error", () => {});
      serverSocket.on("error", () => {});
      legs.push({ clientSocket, serverSocket });
    });
    proxy.listen(0, "127.0.0.1", () => resolve({ proxy, legs, port: proxy.address().port }));
  });
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

// A poll response is a LEASE, not a delivery — see IMPORTANT 1 / Finding 1:
// flipping straight to `delivered` the instant the cloud WRITES the response
// cannot tell a live socket from a partitioned one, so a handoff written into
// a dead peer was lost for good. The node must explicitly confirm receipt via
// POST /v1/node/handoffs/ack before the row becomes `delivered`.
test("a ping creates a pending handoff the node leases, then acks, then it is delivered", async () => {
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
    const lease = poll.json.handoffs[0].lease;
    assert.equal(typeof lease, "string", "a poll response must carry a lease token to ack against");
    assert.equal(t.app.registry.getHandoff(HANDOFF_ID).state, "leased", "a bare poll must not itself mark delivery");

    // A fresh ts for the second poll: it's a distinct logical request, not a
    // replay of the first (see the I-3 replay-guard tests below), and the
    // guard would otherwise refuse a byte-identical repeat.
    t.clock.t += 1;
    const again = await api(t.baseUrl, "GET", pathWithQuery, nodeHeaders(identity, { pathWithQuery, ts: t.clock.t }));
    assert.deepEqual(again.json.handoffs, [], "a live, unexpired lease is not handed out twice");

    t.clock.t += 1;
    const ackPath = "/v1/node/handoffs/ack";
    const ack = await api(t.baseUrl, "POST", ackPath, {
      body: { acks: [{ id: HANDOFF_ID, lease }] },
      ...nodeHeaders(identity, { method: "POST", pathWithQuery: ackPath, ts: t.clock.t }),
    });
    assert.equal(ack.status, 200);
    assert.deepEqual(ack.json.acked, [HANDOFF_ID]);
    assert.equal(t.app.registry.getHandoff(HANDOFF_ID).state, "delivered", "an acked lease is the only way to reach delivered");
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

// The assertion above reads through mapHandoff, which hardcodes its field
// list — so `row.transcript` is `undefined` regardless of what is actually
// in the database. This test reads the RAW row and the table's actual
// column set instead, so it fails if a content column ever gets added and
// written to, not just if the mapper forgets to project it back out.
test("the ping is content-free at the raw row level, not just through the mapper", async () => {
  const { t, session } = await setup();
  try {
    const canary = "CANARY-TRANSCRIPT-content-free-check";
    const res = await api(t.baseUrl, "POST", "/v1/handoffs", {
      body: { ...PING, transcript: canary, manifest: { goal: canary } },
      ...authed(session.sessionToken),
    });
    assert.equal(res.status, 201);

    const columns = t.app.db.prepare("PRAGMA table_info(handoffs)").all().map((c) => c.name).sort();
    assert.deepEqual(columns, [
      "account_id", "branch", "created_at", "delivered_at", "id",
      "lease_expires_at", "lease_token", "node_id", "reason", "repo", "state", "updated_at",
    ], "the handoffs table must carry no content columns");

    const raw = t.app.db.prepare("SELECT * FROM handoffs WHERE id = ?").get(HANDOFF_ID);
    assert.ok(!JSON.stringify(raw).includes(canary), "the canary must not appear anywhere in the raw row");
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

// I-5: with the ownership guard on the idempotency branch removed, account B
// posting A's handoffId got A's row echoed back with 201 (a leak worse than
// the oracle in M-3) — and the 8-test brief suite noticed nothing.
test("a handoffId already owned by another account cannot be reused or read back via POST", async () => {
  const { t, session } = await setup();
  try {
    await api(t.baseUrl, "POST", "/v1/handoffs", { body: PING, ...authed(session.sessionToken) });

    const other = await signIn(t, { sub: "apple-b", email: "b@example.com" });
    const otherIdentity = nodeIdentity();
    const otherNodeId = "node-ffffffffffffffff";
    t.app.registry.createNode(other.accountId, { id: otherNodeId, kind: "trial", name: "Trial B", pubkey: otherIdentity.pubkeyPem });
    await api(t.baseUrl, "POST", "/v1/repos", { body: { fullName: "me/relay" }, ...authed(other.sessionToken) });

    const res = await api(t.baseUrl, "POST", "/v1/handoffs", {
      body: { ...PING, nodeId: otherNodeId }, ...authed(other.sessionToken),
    });
    assert.equal(res.status, 400);
    assert.equal(res.json.error, "invalid_handoff");
    assert.equal(t.app.registry.getHandoff(HANDOFF_ID).accountId, session.accountId, "A's row must be untouched");
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

    const poll = await Promise.race([polling, hardTimeout(8000, "wake-on-ping poll")]);
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

// I-5(b): with `account_id = ?` dropped from listHandoffsForRepo, account B
// reads account A's row wholesale for a same-named repo, and the 8-test
// brief suite noticed nothing. This is a security assertion, not a
// convenience one — it must read as a leak check, not just a happy path.
test("GET /v1/handoffs is scoped to the caller's account, not just the repo name", async () => {
  const { t, session } = await setup();
  try {
    await api(t.baseUrl, "POST", "/v1/handoffs", { body: PING, ...authed(session.sessionToken) });

    const other = await signIn(t, { sub: "apple-b", email: "b@example.com" });
    await api(t.baseUrl, "POST", "/v1/repos", { body: { fullName: "me/relay" }, ...authed(other.sessionToken) });

    const asOther = await api(t.baseUrl, "GET", "/v1/handoffs?repo=me%2Frelay", authed(other.sessionToken));
    assert.equal(asOther.status, 200);
    assert.deepEqual(asOther.json.handoffs, [], "account B must not see account A's handoff for a same-named repo");
  } finally { await t.close(); }
});

test("listing returns newest first and honors the cap", async () => {
  const { t, session } = await setup();
  try {
    const ids = ["1111111111111111", "2222222222222222", "3333333333333333"];
    for (const id of ids) {
      await api(t.baseUrl, "POST", "/v1/handoffs", {
        body: { handoffId: id, repo: "me/relay", branch: `relay/handoff-${id}`, nodeId: NODE_ID },
        ...authed(session.sessionToken),
      });
      t.clock.t += 1000; // force distinct created_at, deterministic order
    }
    const list = await api(t.baseUrl, "GET", "/v1/handoffs?repo=me%2Frelay", authed(session.sessionToken));
    assert.deepEqual(list.json.handoffs.map((h) => h.id), [...ids].reverse(), "newest first");
  } finally { await t.close(); }
});

// M-7: created_at is millisecond-resolution, so two handoffs minted in the
// same millisecond need a deterministic tiebreak or "newest first" is
// nondeterministic. The clock is deliberately left unmoved between the two
// pings.
test("listing order is deterministic even when two handoffs share a millisecond", async () => {
  const { t, session } = await setup();
  try {
    await api(t.baseUrl, "POST", "/v1/handoffs", {
      body: { handoffId: "1111111111111111", repo: "me/relay", branch: "relay/handoff-first", nodeId: NODE_ID },
      ...authed(session.sessionToken),
    });
    await api(t.baseUrl, "POST", "/v1/handoffs", {
      body: { handoffId: "2222222222222222", repo: "me/relay", branch: "relay/handoff-second", nodeId: NODE_ID },
      ...authed(session.sessionToken),
    });
    const list1 = await api(t.baseUrl, "GET", "/v1/handoffs?repo=me%2Frelay", authed(session.sessionToken));
    const list2 = await api(t.baseUrl, "GET", "/v1/handoffs?repo=me%2Frelay", authed(session.sessionToken));
    assert.deepEqual(list1.json.handoffs.map((h) => h.id), list2.json.handoffs.map((h) => h.id));
    assert.deepEqual(list1.json.handoffs.map((h) => h.id),
      ["2222222222222222", "1111111111111111"], "the later insert wins the tie, deterministically");
  } finally { await t.close(); }
});

test("a poll touches the node's last-seen timestamp", async () => {
  const { t, identity } = await setup();
  try {
    assert.equal(t.app.registry.getNode(NODE_ID).lastSeen, null);
    const pathWithQuery = "/v1/node/handoffs?wait=0";
    await api(t.baseUrl, "GET", pathWithQuery, nodeHeaders(identity, { pathWithQuery, ts: t.clock.t }));
    assert.equal(t.app.registry.getNode(NODE_ID).lastSeen, t.clock.t);
  } finally { await t.close(); }
});

test("handoffId must be lowercase hex, 16-64 characters", async () => {
  const { t, session } = await setup();
  try {
    for (const bad of ["", "xyz", "A1B2C3D4E5F60718", "a1b2c3", "g".repeat(20), "a".repeat(65), "a".repeat(15)]) {
      const res = await api(t.baseUrl, "POST", "/v1/handoffs", {
        body: { ...PING, handoffId: bad }, ...authed(session.sessionToken),
      });
      assert.equal(res.status, 400, `handoffId ${JSON.stringify(bad)} should be rejected`);
    }
  } finally { await t.close(); }
});

test("branch must use the relay/handoff- prefix", async () => {
  const { t, session } = await setup();
  try {
    for (const bad of ["main", "handoff-fix-auth", "relay/other-fix-auth", "relay/handoff-"]) {
      const res = await api(t.baseUrl, "POST", "/v1/handoffs", {
        body: { ...PING, branch: bad }, ...authed(session.sessionToken),
      });
      assert.equal(res.status, 400, `branch ${JSON.stringify(bad)} should be rejected`);
    }
  } finally { await t.close(); }
});

test("branch length is capped at 200", async () => {
  const { t, session } = await setup();
  try {
    const atCap = "relay/handoff-" + "a".repeat(200 - "relay/handoff-".length);
    assert.equal(atCap.length, 200);
    const ok = await api(t.baseUrl, "POST", "/v1/handoffs", {
      body: { ...PING, branch: atCap }, ...authed(session.sessionToken),
    });
    assert.equal(ok.status, 201, "exactly 200 chars must be accepted");
    assert.equal(t.app.registry.getHandoff(HANDOFF_ID).branch, atCap, "stored value must be identical to the validated one");

    const overCap = atCap + "a";
    const bad = await api(t.baseUrl, "POST", "/v1/handoffs", {
      body: { ...PING, handoffId: "eeeeeeeeeeeeeeee", branch: overCap }, ...authed(session.sessionToken),
    });
    assert.equal(bad.status, 400, "201 chars must be rejected");
  } finally { await t.close(); }
});

// I-4: charset alone does not close a git-ref-format hole ("../../etc/passwd"
// is built entirely from allowed characters); the ".." check is what closes
// it. Every payload here was previously accepted, stored verbatim, and
// handed to relayd, which feeds branch names to `git`.
test("branch is validated against what a git ref may actually contain", async () => {
  const { t, session } = await setup();
  try {
    const badBranches = [
      "relay/handoff-x\nHost: evil",
      "relay/handoff-$(id)",
      "relay/handoff-`whoami`",
      "relay/handoff-;rm -rf /",
      "relay/handoff-../../../../etc/passwd",
      "relay/handoff-foo..bar", // ".." embedded mid-component, not its own segment
      "relay/handoff--upload-pack=touch /tmp/pwn",
      "relay/handoff- nul",
      "relay/handoff-‮reversed",
      "relay/handoff-{\"secret\":\"leak\"}",
      "relay/handoff-foo/.hidden",
      "relay/handoff-foo.lock",
      "relay/handoff-foo/bar.lock",
      "relay/handoff-foo.",
      "relay/handoff-foo@{1}",
    ];
    for (const branch of badBranches) {
      const res = await api(t.baseUrl, "POST", "/v1/handoffs", {
        body: { ...PING, branch }, ...authed(session.sessionToken),
      });
      assert.equal(res.status, 400, `branch ${JSON.stringify(branch)} should be rejected, got ${res.status}`);
    }

    // A legitimately structured branch (letters, digits, ., _, -, / — no
    // NUL, no "..", no leading-dot component) must still work, and the
    // stored value must be byte-identical to what was validated.
    const goodBranch = "relay/handoff-fix_auth-v2.1/sub-part";
    const ok = await api(t.baseUrl, "POST", "/v1/handoffs", {
      body: { ...PING, handoffId: "dddddddddddddddd", branch: goodBranch }, ...authed(session.sessionToken),
    });
    assert.equal(ok.status, 201);
    assert.equal(ok.json.handoff.branch, goodBranch);
    assert.equal(t.app.registry.getHandoff("dddddddddddddddd").branch, goodBranch);
  } finally { await t.close(); }
});

// I-5: with the pending-work short-circuit removed, a poll with work already
// waiting would still hold for the full `wait` instead of returning at once.
test("a poll returns immediately when work is already pending, without waiting out the poll", async () => {
  const { t, session, identity } = await setup();
  try {
    await api(t.baseUrl, "POST", "/v1/handoffs", { body: PING, ...authed(session.sessionToken) });
    const pathWithQuery = "/v1/node/handoffs?wait=20";
    const started = Date.now();
    const poll = await Promise.race([
      api(t.baseUrl, "GET", pathWithQuery, nodeHeaders(identity, { pathWithQuery, ts: t.clock.t })),
      hardTimeout(5000, "pending short-circuit"),
    ]);
    assert.ok(Date.now() - started < 1000, "pending work must not wait out the poll");
    assert.equal(poll.json.handoffs.length, 1);
  } finally { await t.close(); }
});

// I-5: with `Math.min(requested, config.handoffPollMaxWaitSec)` dropped, a
// client asking for wait=40 would be held for 40s regardless of the
// configured cap. HANDOFF_POLL_MAX_WAIT_SEC=1 makes this fast to observe
// without waiting out a real 25s window.
test("wait is clamped to the configured max, even when the client asks for more", async () => {
  const t = await startTestApp({ env: { HANDOFF_POLL_MAX_WAIT_SEC: "1" } });
  try {
    const session = await signIn(t);
    const identity = nodeIdentity();
    t.app.registry.createNode(session.accountId, { id: NODE_ID, kind: "trial", name: "Trial", pubkey: identity.pubkeyPem });
    const pathWithQuery = "/v1/node/handoffs?wait=40";
    const controller = new AbortController();
    const started = Date.now();
    try {
      await Promise.race([
        api(t.baseUrl, "GET", pathWithQuery, {
          ...nodeHeaders(identity, { pathWithQuery, ts: t.clock.t }),
          signal: controller.signal,
        }),
        hardTimeout(4000, "wait clamp"),
      ]);
    } finally {
      controller.abort(); // tear the connection down before t.close(), win or lose
    }
    const elapsed = Date.now() - started;
    assert.ok(elapsed < 3000, `expected the configured 1s cap to hold, got ${elapsed}ms`);
  } finally { await t.close(); }
});

// M-1: HANDOFF_POLL_MAX_WAIT_SEC must never be able to exceed nginx's
// proxy_read_timeout (deploy/relay-cloud.nginx.conf.template), regardless of
// operator input.
test("HANDOFF_POLL_MAX_WAIT_SEC is clamped below nginx's proxy_read_timeout", () => {
  const config = loadConfig({ SESSION_SECRET: "x".repeat(40), HANDOFF_POLL_MAX_WAIT_SEC: "600" });
  assert.ok(config.handoffPollMaxWaitSec < 300, `expected a clamp under 300s, got ${config.handoffPollMaxWaitSec}`);
  const normal = loadConfig({ SESSION_SECRET: "x".repeat(40) });
  assert.equal(normal.handoffPollMaxWaitSec, 25, "the default must be unaffected by the clamp");
});

// A lease of 0s (or negative, from a misconfigured operator env) would expire
// before any real ack could ever arrive, silently degrading every handoff to
// "redelivered on the very next poll forever" — never actually confirmable.
// Mirrors the HANDOFF_POLL_MAX_WAIT_SEC clamp test above.
test("HANDOFF_LEASE_SEC has a floor of 1s regardless of operator input", () => {
  const config = loadConfig({ SESSION_SECRET: "x".repeat(40), HANDOFF_LEASE_SEC: "0" });
  assert.ok(config.handoffLeaseSec >= 1, `expected a floor of at least 1s, got ${config.handoffLeaseSec}`);
  const negative = loadConfig({ SESSION_SECRET: "x".repeat(40), HANDOFF_LEASE_SEC: "-5" });
  assert.ok(negative.handoffLeaseSec >= 1, `expected a floor of at least 1s, got ${negative.handoffLeaseSec}`);
  const normal = loadConfig({ SESSION_SECRET: "x".repeat(40) });
  assert.equal(normal.handoffLeaseSec, 30, "the default must be unaffected by the floor");
});

// Mirrors the M-6 pending-poll cap: an ack batch is bounded the same way the
// poll response that produced it is (listPendingHandoffs never hands out
// more than 50), so no legitimate batch can ever need more than that.
test("POST /v1/node/handoffs/ack rejects an empty batch", async () => {
  const { t, identity } = await setup();
  try {
    const ackPath = "/v1/node/handoffs/ack";
    const res = await api(t.baseUrl, "POST", ackPath, {
      body: { acks: [] },
      ...nodeHeaders(identity, { method: "POST", pathWithQuery: ackPath, ts: t.clock.t }),
    });
    assert.equal(res.status, 400);
    assert.equal(res.json.error, "invalid_ack");
  } finally { await t.close(); }
});

test("POST /v1/node/handoffs/ack rejects an oversized batch", async () => {
  const { t, identity } = await setup();
  try {
    const ackPath = "/v1/node/handoffs/ack";
    const acks = Array.from({ length: 51 }, (_, i) => ({ id: i.toString(16).padStart(16, "0"), lease: "x" }));
    const res = await api(t.baseUrl, "POST", ackPath, {
      body: { acks },
      ...nodeHeaders(identity, { method: "POST", pathWithQuery: ackPath, ts: t.clock.t }),
    });
    assert.equal(res.status, 400);
    assert.equal(res.json.error, "invalid_ack");
  } finally { await t.close(); }
});

// I-1: the empty Set a natural timeout leaves behind is never removed by
// anything else. Left unfixed, `handoffWaiters` grows by one entry per
// timed-out poll for the rest of the process lifetime.
test("a waiter that times out cleans up its map entry (no leak)", async () => {
  const { t, identity } = await setup();
  try {
    assert.equal(t.app.handoffWaiters.size, 0);
    const pathWithQuery = "/v1/node/handoffs?wait=1";
    await Promise.race([
      api(t.baseUrl, "GET", pathWithQuery, nodeHeaders(identity, { pathWithQuery, ts: t.clock.t })),
      hardTimeout(5000, "natural timeout"),
    ]);
    assert.equal(t.app.handoffWaiters.size, 0, "the empty Set left behind by a natural timeout must be removed");
  } finally { await t.close(); }
});

// C-1 + I-1/I-2: a client that disconnects while parked must (a) never have
// its handoff silently flipped to `delivered` into a dead socket, and (b)
// release its waiter promptly — not linger until the wait deadline.
test("a client disconnect while parked releases its waiter immediately and never delivers into the dead socket", async () => {
  const { t, session, identity } = await setup();
  try {
    const pathWithQuery = "/v1/node/handoffs?wait=10";
    const ts = t.clock.t;
    const { headers } = nodeHeaders(identity, { pathWithQuery, ts });
    const req = httpRequest(`${t.baseUrl}${pathWithQuery}`, { method: "GET", headers });
    req.on("error", () => {}); // destroying below is expected to surface locally; swallow it
    req.end();

    await Promise.race([
      waitUntil(() => (t.app.handoffWaiters.get(NODE_ID)?.size ?? 0) === 1, 2000),
      hardTimeout(5000, "waiter parked"),
    ]);

    req.destroy();

    await Promise.race([
      waitUntil(() => !t.app.handoffWaiters.has(NODE_ID), 2000),
      hardTimeout(5000, "waiter released after disconnect"),
    ]);

    const ping = await api(t.baseUrl, "POST", "/v1/handoffs", { body: PING, ...authed(session.sessionToken) });
    assert.equal(ping.status, 201);
    assert.equal(ping.json.handoff.state, "pending", "nothing was ever delivered to the dead socket");

    t.clock.t += 1000; // a fresh, distinct ts for the reconnect poll
    const reconnect = await Promise.race([
      api(t.baseUrl, "GET", pathWithQuery, nodeHeaders(identity, { pathWithQuery, ts: t.clock.t })),
      hardTimeout(5000, "reconnect poll"),
    ]);
    assert.deepEqual(reconnect.json.handoffs.map((h) => h.id), [HANDOFF_ID], "the reconnected node catches up");
    assert.equal(t.app.registry.getHandoff(HANDOFF_ID).state, "leased", "leased, not delivered, until the node acks it");
  } finally { await t.close(); }
});

// I-2: an abandoned-poll flood from one node must not park unbounded
// waiters. Each request gets a distinct ts (real relayd always mints one
// fresh per call) so the replay guard doesn't interfere with this test.
test("a per-node cap bounds parked long-polls from one node", async () => {
  const { t, identity } = await setup();
  try {
    const pathWithQuery = "/v1/node/handoffs?wait=6";
    const reqs = [];
    const N = HANDOFF_MAX_WAITERS_PER_NODE + 20;
    for (let i = 0; i < N; i++) {
      const { headers } = nodeHeaders(identity, { pathWithQuery, ts: t.clock.t + i });
      const r = httpRequest(`${t.baseUrl}${pathWithQuery}`, { method: "GET", headers });
      r.on("error", () => {});
      r.end();
      reqs.push(r);
    }

    await Promise.race([
      waitUntil(() => (t.app.handoffWaiters.get(NODE_ID)?.size ?? 0) > 0, 3000),
      hardTimeout(6000, "flood polls parking"),
    ]);
    // Give the surplus connections a moment to be told "no" and return.
    await new Promise((resolve) => setTimeout(resolve, 300));

    const parked = t.app.handoffWaiters.get(NODE_ID)?.size ?? 0;
    assert.ok(parked <= HANDOFF_MAX_WAITERS_PER_NODE, `parked=${parked} exceeds the per-node cap of ${HANDOFF_MAX_WAITERS_PER_NODE}`);
    assert.ok(parked > 0, "at least some polls should have parked");

    for (const r of reqs) r.destroy();
    await Promise.race([
      waitUntil(() => !t.app.handoffWaiters.has(NODE_ID), 3000),
      hardTimeout(6000, "flood polls releasing"),
    ]);
  } finally { await t.close(); }
});

// I-5: the report's evidence for `unref` ("the suite exits promptly") does
// not discriminate — every existing test awaits its poll to completion, so
// no timer is ever armed at process exit either way. This asserts the
// property directly on the Timeout object instead of inferring it from
// process-exit timing.
test("the long-poll timer is created unref()'d", async () => {
  const { t, session, identity } = await setup();
  try {
    const pathWithQuery = "/v1/node/handoffs?wait=20";
    const polling = api(t.baseUrl, "GET", pathWithQuery, nodeHeaders(identity, { pathWithQuery, ts: t.clock.t }));

    await Promise.race([
      waitUntil(() => (t.app.handoffWaiters.get(NODE_ID)?.size ?? 0) === 1, 2000),
      hardTimeout(5000, "waiter parked"),
    ]);
    const [entry] = t.app.handoffWaiters.get(NODE_ID);
    assert.equal(typeof entry.timer?.hasRef, "function", "expected a real Timeout object");
    assert.equal(entry.timer.hasRef(), false, "the waiter's timer must be unref()'d");

    // Wake it (rather than waiting out wait=20) so the test stays fast.
    await api(t.baseUrl, "POST", "/v1/handoffs", { body: PING, ...authed(session.sessionToken) });
    await Promise.race([polling, hardTimeout(5000, "unref test drain")]);
  } finally { await t.close(); }
});

// I-3: a byte-for-byte replay of a captured node-poll signature must not be
// able to consume a handoff minted after the original request — the
// reviewer's exact C-1-adjacent finding. This does not depend on `wait`
// or timing at all: the SAME headers are presented twice.
test("a replayed node-poll signature cannot steal a handoff minted after it was captured", async () => {
  const { t, session, identity } = await setup();
  try {
    const pathWithQuery = "/v1/node/handoffs?wait=0";
    const headers = nodeHeaders(identity, { pathWithQuery, ts: t.clock.t });

    const first = await api(t.baseUrl, "GET", pathWithQuery, headers);
    assert.equal(first.status, 200);
    assert.deepEqual(first.json.handoffs, []);

    await api(t.baseUrl, "POST", "/v1/handoffs", { body: PING, ...authed(session.sessionToken) });

    const replay = await api(t.baseUrl, "GET", pathWithQuery, headers);
    assert.equal(replay.status, 401, "a byte-identical replay of a captured signature must be refused");
    assert.equal(t.app.registry.getHandoff(HANDOFF_ID).state, "pending",
      "the handoff must remain claimable by the real node on reconnect, not consumed by the replay");
  } finally { await t.close(); }
});

// M-6: a node that was offline while many pings landed must not be handed
// one unbounded JSON response — the rest stays `pending` for the next poll.
// Seeded directly through the registry (bypassing HTTP) so the test stays
// fast and isolates the query's LIMIT behavior specifically.
test("listPendingHandoffs caps a single poll's response", async () => {
  const { t, session } = await setup();
  try {
    for (let i = 0; i < 60; i++) {
      const id = i.toString(16).padStart(16, "0");
      t.app.registry.createHandoff({ id, accountId: session.accountId, nodeId: NODE_ID, repo: "me/relay", branch: `relay/handoff-${id}` });
    }
    const first = t.app.registry.listPendingHandoffs(NODE_ID);
    assert.ok(first.length <= 50, `expected a capped batch, got ${first.length}`);
    assert.ok(first.length < 60, "not everything should come back in one batch");
    const remaining = t.app.registry.countPendingHandoffs(NODE_ID) - first.length;
    assert.ok(remaining > 0, "the rest must still be pending for the next poll");
  } finally { await t.close(); }
});

// Finding 2: `ORDER BY created_at, rowid` on listPendingHandoffs was
// untested — dropping it (keeping the LIMIT) survived the full suite.
// created_at is set out of insertion order here specifically so a plain
// table/index scan (what SQLite does absent an ORDER BY, which tends to
// enumerate in rowid/insertion order) would return a DIFFERENT subset than
// "oldest created_at first", not merely the same rows in a different order —
// the strongest observable difference available at limit=2 of 3.
test("listPendingHandoffs returns the oldest-created rows first, not insertion order", async () => {
  const { t, session } = await setup();
  try {
    const ids = ["1111111111111111", "2222222222222222", "3333333333333333"];
    for (const id of ids) {
      t.app.registry.createHandoff({ id, accountId: session.accountId, nodeId: NODE_ID, repo: "me/relay", branch: `relay/handoff-${id}` });
    }
    // Rewrite created_at directly so it runs OPPOSITE to insertion (rowid)
    // order: the LAST-inserted row gets the SMALLEST created_at.
    const createdAt = { "1111111111111111": 3000, "2222222222222222": 2000, "3333333333333333": 1000 };
    for (const [id, ts] of Object.entries(createdAt)) {
      t.app.db.prepare("UPDATE handoffs SET created_at = ? WHERE id = ?").run(ts, id);
    }
    const page = t.app.registry.listPendingHandoffs(NODE_ID, 2);
    assert.deepEqual(page.map((h) => h.id), ["3333333333333333", "2222222222222222"],
      "expected the two oldest-by-created_at rows, in ascending created_at order — " +
      "a plain rowid-order scan (what dropping ORDER BY falls back to) would return the two EARLIEST-INSERTED rows instead");
  } finally { await t.close(); }
});

test("POST /v1/node/handoffs/ack requires a valid node signature", async () => {
  const { t } = await setup();
  try {
    const res = await api(t.baseUrl, "POST", "/v1/node/handoffs/ack", {
      body: { acks: [{ id: HANDOFF_ID, lease: "whatever" }] },
    });
    assert.equal(res.status, 401);
  } finally { await t.close(); }
});

// The CAS proof: an ack naming the right id but the WRONG lease token — a
// stale token from an earlier, superseded lease, or a guess — must not be
// able to confirm delivery. This is what makes confirmHandoffDelivery a
// capability check rather than a bare "does this id exist for this node".
test("an ack with the wrong lease token is a no-op, not a confirmation", async () => {
  const { t, session, identity } = await setup();
  try {
    await api(t.baseUrl, "POST", "/v1/handoffs", { body: PING, ...authed(session.sessionToken) });
    const pollPath = "/v1/node/handoffs?wait=0";
    const poll = await api(t.baseUrl, "GET", pollPath, nodeHeaders(identity, { pathWithQuery: pollPath, ts: t.clock.t }));
    const realLease = poll.json.handoffs[0].lease;
    assert.equal(typeof realLease, "string");

    t.clock.t += 1;
    const ackPath = "/v1/node/handoffs/ack";
    const ack = await api(t.baseUrl, "POST", ackPath, {
      body: { acks: [{ id: HANDOFF_ID, lease: "not-the-real-lease-token" }] },
      ...nodeHeaders(identity, { method: "POST", pathWithQuery: ackPath, ts: t.clock.t }),
    });
    assert.equal(ack.status, 200, "a wrong token is refused silently, not with an error status");
    assert.deepEqual(ack.json.acked, [], "nothing was actually confirmed");
    assert.equal(t.app.registry.getHandoff(HANDOFF_ID).state, "leased", "the row must remain leased, not flip to delivered");

    // The REAL token still works afterward — a wrong guess must not consume
    // or invalidate the row's actual lease.
    t.clock.t += 1;
    const realAck = await api(t.baseUrl, "POST", ackPath, {
      body: { acks: [{ id: HANDOFF_ID, lease: realLease }] },
      ...nodeHeaders(identity, { method: "POST", pathWithQuery: ackPath, ts: t.clock.t }),
    });
    assert.deepEqual(realAck.json.acked, [HANDOFF_ID]);
    assert.equal(t.app.registry.getHandoff(HANDOFF_ID).state, "delivered");
  } finally { await t.close(); }
});

// IMPORTANT 1 core behavior, isolated from socket mechanics: an unconfirmed
// lease must become claimable again once it expires, using the same fake
// clock the rest of the suite uses for logical time (see helpers.mjs).
test("an unconfirmed lease expires and the row becomes claimable again", async () => {
  const t = await startTestApp({ env: { HANDOFF_LEASE_SEC: "5" } });
  try {
    const session = await signIn(t);
    const identity = nodeIdentity();
    t.app.registry.createNode(session.accountId, { id: NODE_ID, kind: "trial", name: "Trial", pubkey: identity.pubkeyPem });
    await api(t.baseUrl, "POST", "/v1/repos", { body: { fullName: "me/relay" }, ...authed(session.sessionToken) });
    await api(t.baseUrl, "POST", "/v1/handoffs", { body: PING, ...authed(session.sessionToken) });

    const pathWithQuery = "/v1/node/handoffs?wait=0";
    const first = await api(t.baseUrl, "GET", pathWithQuery, nodeHeaders(identity, { pathWithQuery, ts: t.clock.t }));
    assert.deepEqual(first.json.handoffs.map((h) => h.id), [HANDOFF_ID]);
    assert.equal(t.app.registry.getHandoff(HANDOFF_ID).state, "leased");

    // Still inside the lease window: not handed out again, and not yet
    // reclaimed.
    t.clock.t += 4000;
    const stillLeased = await api(t.baseUrl, "GET", pathWithQuery, nodeHeaders(identity, { pathWithQuery, ts: t.clock.t }));
    assert.deepEqual(stillLeased.json.handoffs, [], "must not be redelivered before the lease expires");

    // Past the lease window, still no ack: the row must be claimable again.
    t.clock.t += 2000; // total 6000ms since the lease was handed out > 5000ms
    const reclaimed = await api(t.baseUrl, "GET", pathWithQuery, nodeHeaders(identity, { pathWithQuery, ts: t.clock.t }));
    assert.deepEqual(reclaimed.json.handoffs.map((h) => h.id), [HANDOFF_ID],
      "an unconfirmed lease must expire and become claimable again — nothing may be permanently lost");
    assert.equal(t.app.registry.getHandoff(HANDOFF_ID).state, "leased", "re-leased under a fresh lease, not left dangling");
    assert.notEqual(reclaimed.json.handoffs[0].lease, first.json.handoffs[0].lease, "expiry must mint a fresh, distinct lease token");
  } finally { await t.close(); }
});

// IMPORTANT 1 / Finding 1, end to end: a REAL partitioned connection (a TCP
// proxy that forwards the request but silently drops the response — see
// startBlackholeProxy above), not a simulated `.destroy()`. This reproduces
// exactly the reviewer's finding: `req.destroyed` never fires because the
// server<->proxy socket is never closed, so the old code (flip straight to
// `delivered`) would lose the handoff permanently and silently. The fix
// makes this recoverable structurally: the row is leased, not delivered, and
// an unconfirmed lease expires.
test("a partitioned node (no FIN observed, socket looks alive) still recovers its handoff once the lease expires", async () => {
  const t = await startTestApp({ env: { HANDOFF_LEASE_SEC: "5" } });
  let proxy;
  try {
    const session = await signIn(t);
    const identity = nodeIdentity();
    t.app.registry.createNode(session.accountId, { id: NODE_ID, kind: "trial", name: "Trial", pubkey: identity.pubkeyPem });
    await api(t.baseUrl, "POST", "/v1/repos", { body: { fullName: "me/relay" }, ...authed(session.sessionToken) });
    t.app.registry.createHandoff({ id: HANDOFF_ID, accountId: session.accountId, nodeId: NODE_ID, repo: "me/relay", branch: "relay/handoff-fix-auth" });

    const targetPort = Number(new URL(t.baseUrl).port);
    const started = await startBlackholeProxy(targetPort);
    proxy = started;

    const pathWithQuery = "/v1/node/handoffs?wait=0";
    const { headers } = nodeHeaders(identity, { pathWithQuery, ts: t.clock.t });
    const req = httpRequest({ host: "127.0.0.1", port: started.port, path: pathWithQuery, method: "GET", headers });
    // No 'response' listener: the whole point is that no response ever
    // reaches this side of the black hole. Only guard against the raw
    // socket erroring noisily when the test tears the proxy down.
    req.on("error", () => {});
    req.end();

    // The server fully receives and processes the request over what looks,
    // from its side, like a perfectly live connection — proven by the row
    // actually transitioning to `leased` (not staying `pending`, which is
    // what `req.destroyed` skipping the work would look like).
    await Promise.race([
      waitUntil(() => t.app.registry.getHandoff(HANDOFF_ID)?.state === "leased", 3000),
      hardTimeout(6000, "blackholed poll processed"),
    ]);
    assert.equal(t.app.registry.getHandoff(HANDOFF_ID).state, "leased",
      "handed out into what the server believes is a live socket — exactly the C-1 precondition");

    // No FIN, no close, no error ever reached the server for this
    // connection — it is still just sitting there, proxy<->app, exactly as
    // a real partition would leave it. Advance the fake clock past the
    // lease window with no ack ever sent (the node is genuinely gone).
    t.clock.t += 5001;

    // A fresh, REAL connection (bypassing the proxy entirely) recovers it.
    const pathWithQuery2 = "/v1/node/handoffs?wait=0";
    const reconnect = await api(t.baseUrl, "GET", pathWithQuery2, nodeHeaders(identity, { pathWithQuery: pathWithQuery2, ts: t.clock.t }));
    assert.deepEqual(reconnect.json.handoffs.map((h) => h.id), [HANDOFF_ID],
      "an unconfirmed lease left behind by a genuine partition must become claimable again — nothing was lost");

    const lease = reconnect.json.handoffs[0].lease;
    t.clock.t += 1;
    const ackPath = "/v1/node/handoffs/ack";
    const ack = await api(t.baseUrl, "POST", ackPath, {
      body: { acks: [{ id: HANDOFF_ID, lease }] },
      ...nodeHeaders(identity, { method: "POST", pathWithQuery: ackPath, ts: t.clock.t }),
    });
    assert.deepEqual(ack.json.acked, [HANDOFF_ID]);
    assert.equal(t.app.registry.getHandoff(HANDOFF_ID).state, "delivered", "the recovered delivery can still reach a real, confirmed terminal state");
  } finally {
    if (proxy) {
      proxy.proxy.close();
      for (const leg of proxy.legs) { leg.clientSocket.destroy(); leg.serverSocket.destroy(); }
    }
    await t.close();
  }
});
