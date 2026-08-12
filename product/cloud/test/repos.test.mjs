import test from "node:test";
import assert from "node:assert/strict";

import { startTestApp, api, signIn, authed } from "./helpers.mjs";

test("registering a repo is idempotent and case-insensitive", async () => {
  const t = await startTestApp();
  try {
    const session = await signIn(t);
    const first = await api(t.baseUrl, "POST", "/v1/repos", {
      body: { fullName: "Parikshit/Relay" }, ...authed(session.sessionToken),
    });
    assert.equal(first.status, 201);
    assert.equal(first.json.repo.fullName, "parikshit/relay");

    const second = await api(t.baseUrl, "POST", "/v1/repos", {
      body: { fullName: "parikshit/relay" }, ...authed(session.sessionToken),
    });
    assert.equal(second.status, 201);
    assert.equal(second.json.repo.id, first.json.repo.id, "the same repo keeps its id");

    const list = await api(t.baseUrl, "GET", "/v1/repos", authed(session.sessionToken));
    assert.equal(list.json.repos.length, 1);
  } finally { await t.close(); }
});

test("a malformed repo name is rejected", async () => {
  const t = await startTestApp();
  try {
    const session = await signIn(t);
    for (const fullName of ["no-slash", "too/many/slashes", "", "bad name/repo"]) {
      const res = await api(t.baseUrl, "POST", "/v1/repos", { body: { fullName }, ...authed(session.sessionToken) });
      assert.equal(res.status, 400, `${fullName} must be rejected`);
      assert.equal(res.json.error, "invalid_repo");
    }
  } finally { await t.close(); }
});

test("repos are isolated per account", async () => {
  const t = await startTestApp();
  try {
    const mine = await signIn(t, { sub: "apple-a", email: "a@example.com" });
    const theirs = await signIn(t, { sub: "apple-b", email: "b@example.com" });
    await api(t.baseUrl, "POST", "/v1/repos", { body: { fullName: "me/secret" }, ...authed(mine.sessionToken) });

    const list = await api(t.baseUrl, "GET", "/v1/repos", authed(theirs.sessionToken));
    assert.deepEqual(list.json.repos, []);
  } finally { await t.close(); }
});
