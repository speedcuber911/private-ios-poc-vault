import test from "node:test";
import assert from "node:assert/strict";
import { startTestApp, api, signIn, authed } from "./helpers.mjs";

const APP = "https://app.example.test";

async function signUp(t, { email, username }) {
  const res = await api(t.baseUrl, "POST", "/api/auth/sign-up/email", {
    headers: { origin: t.config.betterAuthBaseURL },
    body: { email, username, name: username, password: "correct-horse-battery" },
  });
  assert.equal(res.status, 200);
  return res.headers.get("set-auth-token");
}

async function approveWeb(t, sessionToken, machineName = "This browser") {
  const started = await api(t.baseUrl, "POST", "/v1/auth/device/start", {
    body: { client: "web", machineName, platform: "web" },
  });
  assert.equal(started.status, 201);
  assert.equal(
    (await api(t.baseUrl, "POST", "/v1/auth/device/approve", {
      body: { userCode: started.json.userCode },
      ...authed(sessionToken),
    })).status,
    200,
  );
  const granted = await api(t.baseUrl, "POST", "/v1/auth/device/token", {
    body: { deviceCode: started.json.deviceCode },
  });
  return { started, granted };
}

test("GET /v1/auth/places requires a session", async () => {
  const t = await startTestApp();
  try {
    assert.equal((await api(t.baseUrl, "GET", "/v1/auth/places")).status, 401);
  } finally { await t.close(); }
});

test("places lists a linked computer and no browsers", async () => {
  const t = await startTestApp();
  try {
    const session = await signIn(t);
    const started = await api(t.baseUrl, "POST", "/v1/auth/device/start", {
      body: { machineName: "dev-box", platform: "macos" },
    });
    assert.equal(
      (await api(t.baseUrl, "POST", "/v1/auth/device/approve", {
        body: { userCode: started.json.userCode },
        ...authed(session.sessionToken),
      })).status,
      200,
    );
    await api(t.baseUrl, "POST", "/v1/auth/device/token", {
      body: { deviceCode: started.json.deviceCode },
    });
    const places = await api(t.baseUrl, "GET", "/v1/auth/places", authed(session.sessionToken));
    assert.equal(places.status, 200);
    assert.equal(places.json.computer.machineName, "dev-box");
    assert.equal(places.json.computer.status, "connected");
    assert.deepEqual(places.json.browsers, []);
  } finally { await t.close(); }
});

test("a web token appears as a browser and does not drop the computer", async () => {
  const t = await startTestApp();
  try {
    const session = await signIn(t, { sub: "both", email: "both@example.com" });
    const cli = await api(t.baseUrl, "POST", "/v1/auth/device/start", {
      body: { machineName: "dev-box", platform: "macos" },
    });
    await api(t.baseUrl, "POST", "/v1/auth/device/approve", {
      body: { userCode: cli.json.userCode },
      ...authed(session.sessionToken),
    });
    await api(t.baseUrl, "POST", "/v1/auth/device/token", {
      body: { deviceCode: cli.json.deviceCode },
    });
    const { granted } = await approveWeb(t, session.sessionToken, "Safari on Mac");
    assert.equal(granted.status, 200);
    const cookie = (granted.headers.get("set-cookie") || "").split(";")[0];
    const places = await api(t.baseUrl, "GET", "/v1/auth/places", authed(session.sessionToken));
    assert.equal(places.json.computer.machineName, "dev-box");
    assert.equal(places.json.browsers.length, 1);
    assert.equal(places.json.browsers[0].name, "Safari on Mac");
    assert.equal(places.json.browsers[0].platform, "web");
    assert.ok(places.json.browsers[0].id);
    assert.equal(places.json.browsers[0].token, undefined);
    const me = await api(t.baseUrl, "GET", "/v1/account", { headers: { cookie } });
    assert.equal(me.status, 200);
  } finally { await t.close(); }
});

test("DELETE /v1/auth/places/browsers/:id signs that browser out and keeps the computer", async () => {
  const t = await startTestApp();
  try {
    const session = await signIn(t, { sub: "rev", email: "rev@example.com" });
    const { granted } = await approveWeb(t, session.sessionToken);
    const cookie = (granted.headers.get("set-cookie") || "").split(";")[0];
    const places = await api(t.baseUrl, "GET", "/v1/auth/places", authed(session.sessionToken));
    const id = places.json.browsers[0].id;
    const removed = await api(
      t.baseUrl,
      "DELETE",
      `/v1/auth/places/browsers/${id}`,
      authed(session.sessionToken),
    );
    assert.equal(removed.status, 200);
    assert.equal(removed.json.ok, true);
    assert.equal(
      (await api(t.baseUrl, "GET", "/v1/account", { headers: { cookie } })).status,
      401,
    );
    const after = await api(t.baseUrl, "GET", "/v1/auth/places", authed(session.sessionToken));
    assert.deepEqual(after.json.browsers, []);
  } finally { await t.close(); }
});

test("DELETE of a missing or foreign browser is unknown_browser", async () => {
  const t = await startTestApp();
  try {
    const session = await signIn(t);
    const other = await signIn(t, { sub: "other", email: "other-places@example.com" });
    const { granted } = await approveWeb(t, session.sessionToken);
    assert.equal(granted.status, 200);
    const id = (await api(t.baseUrl, "GET", "/v1/auth/places", authed(session.sessionToken)))
      .json.browsers[0].id;
    const foreign = await api(
      t.baseUrl,
      "DELETE",
      `/v1/auth/places/browsers/${id}`,
      authed(other.sessionToken),
    );
    assert.equal(foreign.status, 404);
    assert.equal(foreign.json.error, "unknown_browser");
    const missing = await api(
      t.baseUrl,
      "DELETE",
      "/v1/auth/places/browsers/no-such",
      authed(session.sessionToken),
    );
    assert.equal(missing.status, 404);
    assert.equal(missing.json.error, "unknown_browser");
  } finally { await t.close(); }
});

test("the 11th web token is too_many_browsers and sets no cookie", async () => {
  const t = await startTestApp();
  try {
    const token = await signUp(t, { email: "cap@example.com", username: "capuser" });
    for (let i = 0; i < 10; i += 1) {
      const { granted } = await approveWeb(t, token, `Browser ${i}`);
      assert.equal(granted.status, 200, `mint ${i}`);
    }
    const eleventh = await approveWeb(t, token, "Browser 10");
    assert.equal(eleventh.granted.status, 429);
    assert.equal(eleventh.granted.json.error, "too_many_browsers");
    assert.equal(eleventh.granted.headers.get("set-cookie"), null);
    const places = await api(t.baseUrl, "GET", "/v1/auth/places", authed(token));
    assert.equal(places.json.browsers.length, 10);
  } finally { await t.close(); }
});

test("password sign-up from a trusted web origin appears as a browser", async () => {
  const t = await startTestApp({ env: { RELAY_WEB_ORIGINS: APP } });
  try {
    const signup = await api(t.baseUrl, "POST", "/api/auth/sign-up/email", {
      headers: { origin: APP, "user-agent": "Mozilla/5.0 Safari/605.1.15" },
      body: {
        email: "webpass@example.test",
        username: "webpass",
        name: "webpass",
        password: "correct-horse-battery",
      },
    });
    assert.equal(signup.status, 200);
    const bearer = signup.headers.get("set-auth-token");
    const places = await api(t.baseUrl, "GET", "/v1/auth/places", authed(bearer));
    assert.equal(places.json.browsers.length, 1);
    assert.equal(places.json.browsers[0].platform, "web");
    assert.ok(String(places.json.browsers[0].name || "").length > 0);
  } finally { await t.close(); }
});

test("password sign-up without a trusted web Origin does not appear as a browser", async () => {
  const t = await startTestApp({ env: { RELAY_WEB_ORIGINS: APP } });
  try {
    const token = await signUp(t, { email: "phonepass@example.test", username: "phonepass" });
    const places = await api(t.baseUrl, "GET", "/v1/auth/places", authed(token));
    assert.deepEqual(places.json.browsers, []);
  } finally { await t.close(); }
});
