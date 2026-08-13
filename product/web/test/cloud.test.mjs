import test from "node:test";
import assert from "node:assert/strict";
import { createCloud } from "../src/api/cloud.js";

function mockFetch(calls, response = { ok: true, status: 200, json: { user: { id: "u1" } } }) {
  return async (url, init) => {
    calls.push({ url, init });
    return {
      ok: response.ok,
      status: response.status,
      async text() {
        return JSON.stringify(response.json);
      },
    };
  };
}

test("signIn posts username/password to /api/auth/sign-in/username with credentials include", async () => {
  const calls = [];
  const cloud = createCloud({
    baseUrl: "https://cloud.example.test",
    fetchImpl: mockFetch(calls),
  });
  const result = await cloud.signIn({ username: "relay_user", password: "correct-horse-battery" });
  assert.equal(result.status, 200);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://cloud.example.test/api/auth/sign-in/username");
  assert.equal(calls[0].init.method, "POST");
  assert.equal(calls[0].init.credentials, "include");
  assert.deepEqual(JSON.parse(calls[0].init.body), {
    username: "relay_user",
    password: "correct-horse-battery",
  });
});

test("signUp posts email/username/password to /api/auth/sign-up/email with credentials include", async () => {
  const calls = [];
  const cloud = createCloud({
    baseUrl: "https://cloud.example.test",
    fetchImpl: mockFetch(calls),
  });
  const result = await cloud.signUp({
    email: "relay-user@example.com",
    username: "relay_user",
    password: "correct-horse-battery",
  });
  assert.equal(result.status, 200);
  assert.equal(calls[0].url, "https://cloud.example.test/api/auth/sign-up/email");
  assert.equal(calls[0].init.credentials, "include");
  const body = JSON.parse(calls[0].init.body);
  assert.equal(body.email, "relay-user@example.com");
  assert.equal(body.username, "relay_user");
  assert.equal(body.password, "correct-horse-battery");
});

test("cloudFetch always sends credentials include against the configured origin", async () => {
  const calls = [];
  const cloud = createCloud({
    baseUrl: "https://other.example.test/",
    fetchImpl: mockFetch(calls, { ok: true, status: 200, json: { account: {} } }),
  });
  await cloud.cloudFetch("/v1/account");
  assert.equal(calls[0].url, "https://other.example.test/v1/account");
  assert.equal(calls[0].init.credentials, "include");
});

test("omitted baseUrl falls back to the live origin", async () => {
  const calls = [];
  const previous = process.env.VITE_RELAY_CLOUD_URL;
  delete process.env.VITE_RELAY_CLOUD_URL;
  try {
    const cloud = createCloud({ fetchImpl: mockFetch(calls) });
    await cloud.cloudFetch("/v1/account");
    assert.equal(calls[0].url, "https://relay.ai-rocket-experiments.com/v1/account");
    assert.equal(calls[0].init.credentials, "include");
  } finally {
    if (previous === undefined) delete process.env.VITE_RELAY_CLOUD_URL;
    else process.env.VITE_RELAY_CLOUD_URL = previous;
  }
});
