import test from "node:test";
import assert from "node:assert/strict";

import { startTestApp, api, signIn, authed } from "./helpers.mjs";

const AUTH_TOKEN = "c2VjcmV0LXNlY3JldC1zZWNyZXQ";

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
