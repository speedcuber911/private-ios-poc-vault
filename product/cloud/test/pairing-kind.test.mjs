import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";

import { startTestApp, api, signIn, authed } from "./helpers.mjs";

const AUTH_TOKEN = "c2VjcmV0LXNlY3JldC1zZWNyZXQ";

// The cloud never verifies a blob's MAC tag — only its shape (TAG_RE) — so a
// random base64 string is a legitimate stand-in for the peer-computed tag in
// every test below that never checks the tag itself.
function fakeTag() {
  return randomBytes(32).toString("base64");
}

test("a session records its kind and defaults to pair", async () => {
  const t = await startTestApp();
  try {
    const session = await signIn(t);
    const typed = await api(t.baseUrl, "POST", "/v1/pairing/sessions", {
      body: { authToken: AUTH_TOKEN, kind: "sync-auth" }, ...authed(session.sessionToken),
    });
    assert.equal(typed.status, 201);
    assert.equal(t.app.registry.getPairingSession(typed.json.pairingId).kind, "sync-auth");

    const untyped = await api(t.baseUrl, "POST", "/v1/pairing/sessions", {
      body: { authToken: AUTH_TOKEN }, ...authed(session.sessionToken),
    });
    assert.equal(t.app.registry.getPairingSession(untyped.json.pairingId).kind, "pair");
  } finally { await t.close(); }
});

test("an unknown kind is refused", async () => {
  const t = await startTestApp();
  try {
    const session = await signIn(t);
    const res = await api(t.baseUrl, "POST", "/v1/pairing/sessions", {
      body: { authToken: AUTH_TOKEN, kind: "exfiltrate" }, ...authed(session.sessionToken),
    });
    assert.equal(res.status, 400);
    assert.equal(res.json.error, "invalid_kind");
  } finally { await t.close(); }
});

test("quotas are per kind — exhausting one kind leaves the others usable", async () => {
  const t = await startTestApp();
  try {
    const session = await signIn(t);
    for (let index = 0; index < t.app.pairing.maxPerAccount; index += 1) {
      const res = await api(t.baseUrl, "POST", "/v1/pairing/sessions", {
        body: { authToken: AUTH_TOKEN, kind: "session-index" }, ...authed(session.sessionToken),
      });
      assert.equal(res.status, 201, `session-index session ${index} should be allowed`);
    }
    const overflow = await api(t.baseUrl, "POST", "/v1/pairing/sessions", {
      body: { authToken: AUTH_TOKEN, kind: "session-index" }, ...authed(session.sessionToken),
    });
    assert.equal(overflow.status, 429);

    const pair = await api(t.baseUrl, "POST", "/v1/pairing/sessions", {
      body: { authToken: AUTH_TOKEN, kind: "pair" }, ...authed(session.sessionToken),
    });
    assert.equal(pair.status, 201, "pairing must not be blocked by another kind's backlog");
  } finally { await t.close(); }
});

// ── one-way close (F15 in the branch-seam review) ──────────────────────────
//
// `sync-auth` and `session-index` are one-directional protocols: the CLI
// writes the "device" slot and the node reads it; nothing ever touches
// "node". getBlob's close condition — "close once BOTH slots have been
// read" — was written for the two-sided `pair` protocol, so for these two
// kinds `nodeReadAt` can never become non-null and the session never closed
// early: not on a failed publish only, on every read, success included. It
// rode out the full TTL instead, sitting against the same per-(account,
// kind) quota `countLivePairingSessions` enforces above.
for (const kind of ["sync-auth", "session-index"]) {
  test(`rendezvous: a ${kind} session closes as soon as its one slot (device-blob) is read`, async () => {
    const t = await startTestApp();
    try {
      const session = await signIn(t);
      const created = await api(t.baseUrl, "POST", "/v1/pairing/sessions", {
        body: { authToken: AUTH_TOKEN, kind }, ...authed(session.sessionToken),
      });
      assert.equal(created.status, 201);
      const { pairingId } = created.json;

      const blob = randomBytes(64);
      const put = await api(t.baseUrl, "POST", `/v1/pairing/sessions/${pairingId}/device-blob`, {
        raw: blob,
        headers: { "x-pairing-auth": AUTH_TOKEN, "x-pairing-tag": fakeTag() },
      });
      assert.equal(put.status, 204);
      assert.equal(t.app.registry.getPairingSession(pairingId).closedAt, null, "must still be open before the read");

      const got = await api(t.baseUrl, "GET", `/v1/pairing/sessions/${pairingId}/device-blob`, {
        headers: { "x-pairing-auth": AUTH_TOKEN },
      });
      assert.equal(got.status, 200);
      assert.ok(got.buf.equals(blob));

      // The read above is the ONLY read this protocol ever makes — there is
      // no second slot to wait for — so the session must already be closed,
      // not sitting open until TTL sweep.
      const closed = t.app.registry.getPairingSession(pairingId);
      assert.notEqual(closed.closedAt, null, `a ${kind} session was not closed after its one read`);
      assert.equal(closed.deviceBlob, null, "blob bytes must be dropped on close, not just marked closed");
      assert.equal(closed.deviceTag, null);

      // And the quota slot it held is free again immediately — the whole
      // operational point of closing early rather than riding out the TTL.
      assert.equal(
        t.app.registry.countLivePairingSessions(session.accountId, kind, t.clock.t), 0,
        "closing early must free the per-(account, kind) quota immediately",
      );

      // A second read of an already-closed session is a clean rejection,
      // same as the two-sided protocol's post-close behaviour.
      const late = await api(t.baseUrl, "GET", `/v1/pairing/sessions/${pairingId}/device-blob`, {
        headers: { "x-pairing-auth": AUTH_TOKEN },
      });
      assert.equal(late.status, 401);
    } finally { await t.close(); }
  });
}

test("rendezvous: a two-sided pair session is NOT closed by a single read — one-way close must not leak into it", async () => {
  const t = await startTestApp();
  try {
    const session = await signIn(t);
    const created = await api(t.baseUrl, "POST", "/v1/pairing/sessions", {
      body: { authToken: AUTH_TOKEN, kind: "pair" }, ...authed(session.sessionToken),
    });
    assert.equal(created.status, 201);
    const { pairingId } = created.json;

    const deviceBlob = randomBytes(48);
    const putDevice = await api(t.baseUrl, "POST", `/v1/pairing/sessions/${pairingId}/device-blob`, {
      raw: deviceBlob, headers: { "x-pairing-auth": AUTH_TOKEN, "x-pairing-tag": fakeTag() },
    });
    assert.equal(putDevice.status, 204);

    const readDevice = await api(t.baseUrl, "GET", `/v1/pairing/sessions/${pairingId}/device-blob`, {
      headers: { "x-pairing-auth": AUTH_TOKEN },
    });
    assert.equal(readDevice.status, 200);

    // Exactly the reverse of the one-way case above: reading the ONE slot a
    // `pair` session has produced so far must NOT close it — the node slot
    // has not been written or read yet, and a `pair` exchange is not
    // complete until it has.
    assert.equal(
      t.app.registry.getPairingSession(pairingId).closedAt, null,
      "a pair session closed after only one of its two slots was read",
    );
    assert.equal(
      t.app.registry.countLivePairingSessions(session.accountId, "pair", t.clock.t), 1,
      "a pair session's quota slot must still be held until both sides have read",
    );
  } finally { await t.close(); }
});
