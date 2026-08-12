// Coverage for the account-scoping boundary on repos: getRepo's
// `WHERE account_id = ? AND full_name = ?` and the
// `idx_repos_account_name` UNIQUE(account_id, full_name) index (db.js). This
// is not a schema migration like the other two gaps in this pattern, but the
// same shape — a load-bearing guard with zero coverage. Every existing repos
// test ("repos are isolated per account" in repos.test.mjs) only ever
// registers a name under ONE account, so it can't observe what happens when
// a SECOND account claims the identical fullName — which is the exact
// authorization boundary this table exists to enforce.
//
// Per Task 6 review: both of the following pass the full suite unmodified
// before this file existed —
//   (a) dropping `account_id` from getRepo's WHERE clause
//   (b) narrowing idx_repos_account_name from (account_id, full_name) to
//       (full_name) alone
// This test is written to go red under either mutation.

import { test } from "node:test";
import assert from "node:assert/strict";

import { startTestApp, api, signIn, authed } from "./helpers.mjs";

test("two accounts registering the same repo name get distinct, isolated rows", async () => {
  const t = await startTestApp();
  try {
    const accountA = await signIn(t, { sub: "apple-cross-a", email: "cross-a@example.com" });
    const accountB = await signIn(t, { sub: "apple-cross-b", email: "cross-b@example.com" });

    // Boundary check BEFORE B ever registers anything: B must not be able to
    // read A's row by name. This is what a getRepo missing its account_id
    // filter would break — registry.getRepo(accountB.id, name) would find
    // A's row instead of nothing. Exercised through the real authorization
    // consumer (`POST /v1/handoffs` calls `registry.getRepo(account.id,
    // repo)` to check repo ownership before accepting a handoff) rather than
    // by reaching into the registry directly, so this pins the HTTP-visible
    // behavior, not just an internal function's return value.
    await api(t.baseUrl, "POST", "/v1/repos", {
      body: { fullName: "org/shared-repo" }, ...authed(accountA.sessionToken),
    });
    const handoffAttempt = await api(t.baseUrl, "POST", "/v1/handoffs", {
      body: {
        handoffId: "a".repeat(16),
        repo: "org/shared-repo",
        branch: "relay/handoff-test",
        nodeId: "does-not-matter-repo-check-runs-first",
      },
      ...authed(accountB.sessionToken),
    });
    assert.equal(
      handoffAttempt.status,
      404,
      "account B must not be able to piggyback on account A's repo registration",
    );
    assert.equal(handoffAttempt.json.error, "unknown_repo");

    // Now B registers the identical name independently.
    const resA = await api(t.baseUrl, "GET", "/v1/repos", authed(accountA.sessionToken));
    const resB = await api(t.baseUrl, "POST", "/v1/repos", {
      body: { fullName: "org/shared-repo" }, ...authed(accountB.sessionToken),
    });
    assert.equal(resB.status, 201);
    assert.ok(resB.json.repo, "account B must get back its own repo row, not a rejection");

    const repoAId = resA.json.repos[0].id;
    const repoBId = resB.json.repo.id;
    assert.notEqual(
      repoBId,
      repoAId,
      "each account's registration of the same name must be its own row, not a shared one",
    );

    // Each account's list contains exactly its own row — not the other's,
    // and not both (which a (full_name)-only unique index would produce by
    // colliding the two accounts onto one row).
    const listA = await api(t.baseUrl, "GET", "/v1/repos", authed(accountA.sessionToken));
    const listB = await api(t.baseUrl, "GET", "/v1/repos", authed(accountB.sessionToken));
    assert.deepEqual(listA.json.repos.map((r) => r.id), [repoAId]);
    assert.deepEqual(listB.json.repos.map((r) => r.id), [repoBId]);

    // And now that B has its own registration, B's handoff path opens up —
    // scoped to B's own row, not A's.
    const handoffAfterB = await api(t.baseUrl, "POST", "/v1/handoffs", {
      body: {
        handoffId: "b".repeat(16),
        repo: "org/shared-repo",
        branch: "relay/handoff-test",
        nodeId: "still-does-not-matter",
      },
      ...authed(accountB.sessionToken),
    });
    assert.equal(handoffAfterB.status, 404, "unknown_node, not unknown_repo, once B owns the name");
    assert.equal(handoffAfterB.json.error, "unknown_node");

    // Direct registry-level pin as well: getRepo scoped to each account must
    // resolve to that account's own row.
    assert.equal(t.app.registry.getRepo(accountA.accountId, "org/shared-repo").id, repoAId);
    assert.equal(t.app.registry.getRepo(accountB.accountId, "org/shared-repo").id, repoBId);
  } finally {
    await t.close();
  }
});
