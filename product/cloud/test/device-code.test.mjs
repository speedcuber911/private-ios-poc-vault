import test from "node:test";
import assert from "node:assert/strict";

import { startTestApp, api, signIn, authed } from "./helpers.mjs";

test("full device-code flow: start, poll pending, approve, poll returns a session", async () => {
  const t = await startTestApp();
  try {
    const start = await api(t.baseUrl, "POST", "/v1/auth/device/start", { body: {} });
    assert.equal(start.status, 201);
    assert.match(start.json.deviceCode, /^[A-Za-z0-9_-]{43}$/);
    assert.match(start.json.userCode, /^[BCDFGHJKLMNPQRSTVWXZ2-9]{4}-[BCDFGHJKLMNPQRSTVWXZ2-9]{4}$/);
    assert.equal(start.json.interval, 5);
    assert.ok(start.json.verificationUri.length > 0);

    const pending = await api(t.baseUrl, "POST", "/v1/auth/device/token", { body: { deviceCode: start.json.deviceCode } });
    assert.equal(pending.status, 400);
    assert.equal(pending.json.error, "authorization_pending");

    const session = await signIn(t);
    const approve = await api(t.baseUrl, "POST", "/v1/auth/device/approve", {
      body: { userCode: start.json.userCode.toLowerCase() }, ...authed(session.sessionToken),
    });
    assert.equal(approve.status, 200);

    const granted = await api(t.baseUrl, "POST", "/v1/auth/device/token", { body: { deviceCode: start.json.deviceCode } });
    assert.equal(granted.status, 200);
    assert.equal(granted.json.accountId, session.accountId);
    assert.ok(granted.json.sessionToken.length > 0);
  } finally { await t.close(); }
});

test("a device code is single-use", async () => {
  const t = await startTestApp();
  try {
    const start = await api(t.baseUrl, "POST", "/v1/auth/device/start", { body: {} });
    const session = await signIn(t);
    await api(t.baseUrl, "POST", "/v1/auth/device/approve", {
      body: { userCode: start.json.userCode }, ...authed(session.sessionToken),
    });
    await api(t.baseUrl, "POST", "/v1/auth/device/token", { body: { deviceCode: start.json.deviceCode } });

    const second = await api(t.baseUrl, "POST", "/v1/auth/device/token", { body: { deviceCode: start.json.deviceCode } });
    assert.equal(second.status, 400);
    assert.equal(second.json.error, "invalid_grant");
  } finally { await t.close(); }
});

test("an expired device code is refused and swept", async () => {
  const t = await startTestApp();
  try {
    const start = await api(t.baseUrl, "POST", "/v1/auth/device/start", { body: {} });
    t.clock.t += 16 * 60 * 1000;

    const res = await api(t.baseUrl, "POST", "/v1/auth/device/token", { body: { deviceCode: start.json.deviceCode } });
    assert.equal(res.status, 400);
    assert.equal(res.json.error, "expired_token");

    t.app.runSweeps();
    const after = await api(t.baseUrl, "POST", "/v1/auth/device/token", { body: { deviceCode: start.json.deviceCode } });
    assert.equal(after.json.error, "invalid_grant", "swept rows become indistinguishable from unknown codes");
  } finally { await t.close(); }
});

test("an unknown device code or user code never reveals which", async () => {
  const t = await startTestApp();
  try {
    const token = await api(t.baseUrl, "POST", "/v1/auth/device/token", { body: { deviceCode: "nope" } });
    assert.equal(token.status, 400);
    assert.equal(token.json.error, "invalid_grant");

    const session = await signIn(t);
    const approve = await api(t.baseUrl, "POST", "/v1/auth/device/approve", {
      body: { userCode: "ZZZZ-ZZZZ" }, ...authed(session.sessionToken),
    });
    assert.equal(approve.status, 404);
    assert.equal(approve.json.error, "unknown_user_code");
  } finally { await t.close(); }
});

test("approving requires a session", async () => {
  const t = await startTestApp();
  try {
    const start = await api(t.baseUrl, "POST", "/v1/auth/device/start", { body: {} });
    const res = await api(t.baseUrl, "POST", "/v1/auth/device/approve", { body: { userCode: start.json.userCode } });
    assert.equal(res.status, 401);
  } finally { await t.close(); }
});
