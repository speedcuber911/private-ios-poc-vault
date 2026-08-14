// The web session cookie is SameSite=None so a cross-origin SPA can send it.
// That is exactly what a browser's built-in CSRF protection used to be, so
// something else has to stand in its place: state-changing routes reject a
// foreign Origin, and JSON bodies must arrive with a JSON content-type (the
// three browser-"simple" content types are precisely the ones that skip the
// preflight, and therefore skip the CORS allowlist entirely).
//
// The takeover this file pins was reproduced end to end before the fix: a page
// on another origin made the victim's browser approve the ATTACKER's
// client=web device code, and the attacker's poll returned a session for the
// victim's account.

import test from "node:test";
import assert from "node:assert/strict";
import { startTestApp, api } from "./helpers.mjs";

const APP = "https://app.example.test";
const EVIL = "https://evil.example.test";

async function signUpWithCookie(t, { email, username }) {
  const res = await api(t.baseUrl, "POST", "/api/auth/sign-up/email", {
    headers: { origin: APP },
    body: { email, username, name: username, password: "correct-horse-battery" },
  });
  assert.equal(res.status, 200);
  const cookie = (res.headers.get("set-cookie") || "").split(";")[0];
  assert.ok(cookie, "sign-up must set a session cookie");
  return cookie;
}

test("a cross-site approve cannot hand an attacker a session for the victim's account", async () => {
  const t = await startTestApp({ env: { RELAY_WEB_ORIGINS: APP } });
  try {
    const victimCookie = await signUpWithCookie(t, {
      email: "victim@example.test",
      username: "victim",
    });
    const attacker = await api(t.baseUrl, "POST", "/v1/auth/device/start", {
      body: { client: "web", machineName: "Attacker's browser", platform: "web" },
    });
    assert.equal(attacker.status, 201);

    // A form/fetch POST from another origin: "simple" content-type, so no
    // preflight fires and the SameSite=None cookie is attached.
    const forged = await api(t.baseUrl, "POST", "/v1/auth/device/approve", {
      headers: {
        origin: EVIL,
        cookie: victimCookie,
        "content-type": "text/plain;charset=UTF-8",
      },
      raw: JSON.stringify({ userCode: attacker.json.userCode }),
    });
    assert.notEqual(forged.status, 200, "a foreign origin must not approve a device code");

    const polled = await api(t.baseUrl, "POST", "/v1/auth/device/token", {
      body: { deviceCode: attacker.json.deviceCode },
    });
    assert.equal(polled.status, 400);
    assert.equal(polled.json.error, "authorization_pending");
    assert.equal(polled.headers.get("set-cookie"), null);
  } finally {
    await t.close();
  }
});

test("a state-changing request from a non-allowlisted Origin is rejected", async () => {
  const t = await startTestApp({ env: { RELAY_WEB_ORIGINS: APP } });
  try {
    const res = await api(t.baseUrl, "POST", "/v1/waitlist", {
      headers: { origin: EVIL },
      body: { email: "attacker@evil.test" },
    });
    assert.equal(res.status, 403);
    assert.equal(res.json.error, "forbidden_origin");
  } finally {
    await t.close();
  }
});

test("a state-changing request from the allowlisted app origin still works", async () => {
  const t = await startTestApp({ env: { RELAY_WEB_ORIGINS: APP } });
  try {
    const res = await api(t.baseUrl, "POST", "/v1/waitlist", {
      headers: { origin: APP },
      body: { email: "wanted@example.test" },
    });
    assert.equal(res.status, 202);
  } finally {
    await t.close();
  }
});

test("a path on BETTER_AUTH_URL does not reject the API origin", async () => {
  // Origin is scheme+host+port. BETTER_AUTH_URL is Better Auth's baseURL and
  // an operator can accidentally give it a path (/auth). CSRF compares against
  // Origin, so the path must not make the API's own origin forbidden.
  const t = await startTestApp({
    env: { BETTER_AUTH_URL: "https://api.example.test/auth" },
  });
  try {
    const res = await api(t.baseUrl, "POST", "/v1/waitlist", {
      headers: { origin: "https://api.example.test" },
      body: { email: "path-api@example.test" },
    });
    assert.equal(res.status, 202);
  } finally {
    await t.close();
  }
});

test("a trailing slash in a configured origin does not reject the real origin", async () => {
  // An Origin header never carries a trailing slash, but an operator writing
  // RELAY_WEB_ORIGINS or BETTER_AUTH_URL easily adds one. That must not turn
  // every write from the app origin into forbidden_origin.
  const t = await startTestApp({
    env: { RELAY_WEB_ORIGINS: `${APP}/`, BETTER_AUTH_URL: "https://api.example.test/" },
  });
  try {
    const fromApp = await api(t.baseUrl, "POST", "/v1/waitlist", {
      headers: { origin: APP },
      body: { email: "slash-app@example.test" },
    });
    assert.equal(fromApp.status, 202);
    const fromApi = await api(t.baseUrl, "POST", "/v1/waitlist", {
      headers: { origin: "https://api.example.test" },
      body: { email: "slash-api@example.test" },
    });
    assert.equal(fromApi.status, 202);
  } finally {
    await t.close();
  }
});

test("a JSON body sent with a browser-simple content-type is rejected", async () => {
  const t = await startTestApp({ env: { RELAY_WEB_ORIGINS: APP } });
  try {
    for (const contentType of [
      "text/plain;charset=UTF-8",
      "application/x-www-form-urlencoded",
      "multipart/form-data; boundary=x",
    ]) {
      const res = await api(t.baseUrl, "POST", "/v1/waitlist", {
        headers: { "content-type": contentType },
        raw: JSON.stringify({ email: "simple@example.test" }),
      });
      assert.equal(res.status, 415, `content-type ${contentType} must not be parsed as JSON`);
      assert.equal(res.json.error, "unsupported_media_type");
    }
  } finally {
    await t.close();
  }
});

test("bearer clients that send no Origin are unaffected", async () => {
  const t = await startTestApp({ env: { RELAY_WEB_ORIGINS: APP } });
  try {
    // iOS, the CLI, relayd and the trial sandbox are not browsers: they send
    // a JSON content-type and no Origin at all. None of this may touch them.
    const res = await api(t.baseUrl, "POST", "/v1/waitlist", {
      body: { email: "native@example.test" },
    });
    assert.equal(res.status, 202);
  } finally {
    await t.close();
  }
});

test("the session cookie is SameSite=Lax when no web origin is configured", async () => {
  // Better Auth trusts betterAuthBaseURL, which is not the random test port,
  // so name the API origin explicitly and send it as Origin.
  const t = await startTestApp({ env: { BETTER_AUTH_URL: "https://api.example.test" } });
  try {
    const res = await api(t.baseUrl, "POST", "/api/auth/sign-up/email", {
      headers: { origin: "https://api.example.test" },
      body: {
        email: "lax@example.test",
        username: "laxuser",
        name: "Lax User",
        password: "correct-horse-battery",
      },
    });
    assert.equal(res.status, 200);
    const setCookie = res.headers.get("set-cookie") || "";
    assert.match(setCookie, /SameSite=Lax/i);
    assert.doesNotMatch(setCookie, /SameSite=None/i);
  } finally {
    await t.close();
  }
});

test("the session cookie is SameSite=None when a web origin is configured", async () => {
  const t = await startTestApp({ env: { RELAY_WEB_ORIGINS: APP } });
  try {
    const res = await api(t.baseUrl, "POST", "/api/auth/sign-up/email", {
      headers: { origin: APP },
      body: {
        email: "none@example.test",
        username: "noneuser",
        name: "None User",
        password: "correct-horse-battery",
      },
    });
    assert.equal(res.status, 200);
    assert.match(res.headers.get("set-cookie") || "", /SameSite=None/i);
  } finally {
    await t.close();
  }
});
