import test from "node:test";
import assert from "node:assert/strict";
import { api, startTestApp } from "./helpers.mjs";

test("Better Auth gates Relay, supports username sign-in, and hard-deletes the account", async () => {
  const t = await startTestApp();
  const origin = t.config.betterAuthBaseURL;
  const authHeaders = { origin };

  try {
    const signup = await api(t.baseUrl, "POST", "/api/auth/sign-up/email", {
      headers: authHeaders,
      body: {
        email: "relay-user@example.com",
        name: "Relay User",
        username: "relay_user",
        password: "correct-horse-battery",
      },
    });
    assert.equal(signup.status, 200);
    assert.equal(signup.json.user.username, "relay_user");
    const signupToken = signup.headers.get("set-auth-token");
    assert.ok(signupToken);

    const account = await api(t.baseUrl, "GET", "/v1/account", {
      headers: { authorization: `Bearer ${signupToken}` },
    });
    assert.equal(account.status, 200);
    assert.equal(account.json.account.email, "relay-user@example.com");
    assert.deepEqual(account.json.entitlements, [
      { feature: "nodes.max", value: "1" },
    ]);

    const device = await api(t.baseUrl, "POST", "/v1/devices", {
      headers: {
        ...authHeaders,
        authorization: `Bearer ${signupToken}`,
      },
      body: { platform: "ios", name: "Test iPhone" },
    });
    assert.equal(device.status, 201);

    const signedOut = await api(t.baseUrl, "POST", "/api/auth/sign-out", {
      headers: {
        ...authHeaders,
        authorization: `Bearer ${signupToken}`,
      },
      body: {},
    });
    assert.equal(signedOut.status, 200);

    const signIn = await api(t.baseUrl, "POST", "/api/auth/sign-in/username", {
      headers: authHeaders,
      body: { username: "relay_user", password: "correct-horse-battery" },
    });
    assert.equal(signIn.status, 200);
    const sessionToken = signIn.headers.get("set-auth-token");
    assert.ok(sessionToken);

    const deleted = await api(t.baseUrl, "POST", "/api/auth/delete-user", {
      headers: {
        ...authHeaders,
        authorization: `Bearer ${sessionToken}`,
      },
      body: { password: "correct-horse-battery" },
    });
    assert.equal(deleted.status, 200);
    assert.deepEqual(deleted.json, { success: true, message: "User deleted" });
    assert.equal(t.app.registry.findAccountByEmail("relay-user@example.com"), null);
    assert.equal(t.app.db.prepare("SELECT COUNT(*) AS n FROM devices").get().n, 0);
    assert.equal(t.app.db.prepare("SELECT COUNT(*) AS n FROM entitlements").get().n, 0);

    const cannotSignIn = await api(
      t.baseUrl,
      "POST",
      "/api/auth/sign-in/username",
      {
        headers: authHeaders,
        body: { username: "relay_user", password: "correct-horse-battery" },
      },
    );
    assert.equal(cannotSignIn.status, 401);
  } finally {
    await t.close();
  }
});
