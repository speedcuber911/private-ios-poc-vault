import test from "node:test";
import assert from "node:assert/strict";
import { startTestApp, api, signIn, authed } from "./helpers.mjs";

const APP = "https://app.example.test";
const EVIL = "https://evil.example.test";

function corsEnv() {
  return { RELAY_WEB_ORIGINS: APP };
}

test("allowlisted Origin on JSON GET echoes ACAO, credentials, and Vary", async () => {
  const t = await startTestApp({ env: corsEnv() });
  try {
    const res = await api(t.baseUrl, "GET", "/healthz", {
      headers: { origin: APP },
    });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("access-control-allow-origin"), APP);
    assert.equal(res.headers.get("access-control-allow-credentials"), "true");
    assert.match(res.headers.get("vary") || "", /Origin/i);
  } finally {
    await t.close();
  }
});

test("non-allowlisted Origin gets no Access-Control-Allow-Origin", async () => {
  const t = await startTestApp({ env: corsEnv() });
  try {
    const res = await api(t.baseUrl, "GET", "/healthz", {
      headers: { origin: EVIL },
    });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("access-control-allow-origin"), null);
    assert.notEqual(res.headers.get("access-control-allow-origin"), "*");
  } finally {
    await t.close();
  }
});

test("OPTIONS preflight for an allowlisted origin is 204 with content-type and authorization", async () => {
  const t = await startTestApp({ env: corsEnv() });
  try {
    const res = await api(t.baseUrl, "OPTIONS", "/v1/account", {
      headers: {
        origin: APP,
        "access-control-request-method": "GET",
        "access-control-request-headers": "content-type,authorization",
      },
    });
    assert.equal(res.status, 204);
    assert.equal(res.headers.get("access-control-allow-origin"), APP);
    assert.equal(res.headers.get("access-control-allow-credentials"), "true");
    const allowHeaders = (res.headers.get("access-control-allow-headers") || "").toLowerCase();
    assert.match(allowHeaders, /content-type/);
    assert.match(allowHeaders, /authorization/);
    assert.match(res.headers.get("vary") || "", /Origin/i);
  } finally {
    await t.close();
  }
});

test("OPTIONS preflight for a non-allowlisted origin has no ACAO", async () => {
  const t = await startTestApp({ env: corsEnv() });
  try {
    const res = await api(t.baseUrl, "OPTIONS", "/v1/account", {
      headers: {
        origin: EVIL,
        "access-control-request-method": "POST",
        "access-control-request-headers": "content-type",
      },
    });
    assert.equal(res.headers.get("access-control-allow-origin"), null);
    assert.notEqual(res.headers.get("access-control-allow-origin"), "*");
  } finally {
    await t.close();
  }
});

test("POST /api/auth/sign-up/email from the app origin echoes ACAO", async () => {
  const t = await startTestApp({ env: corsEnv() });
  try {
    const res = await api(t.baseUrl, "POST", "/api/auth/sign-up/email", {
      headers: { origin: APP },
      body: {
        email: "cors-signup@example.com",
        name: "Cors Signup",
        username: "cors_signup",
        password: "correct-horse-battery",
      },
    });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("access-control-allow-origin"), APP);
    assert.equal(res.headers.get("access-control-allow-credentials"), "true");
  } finally {
    await t.close();
  }
});

test("credentialed JSON POST from the app origin includes CORS on the response", async () => {
  const t = await startTestApp({ env: corsEnv() });
  try {
    const session = await signIn(t);
    const res = await api(t.baseUrl, "GET", "/v1/account", {
      ...authed(session.sessionToken, { origin: APP }),
    });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("access-control-allow-origin"), APP);
    assert.equal(res.headers.get("access-control-allow-credentials"), "true");
  } finally {
    await t.close();
  }
});
