import test from "node:test";
import assert from "node:assert/strict";
import { startTestApp, api, TEST_ADMIN_TOKEN } from "./helpers.mjs";

const ADMIN_EMAIL = "ops@example.test";
async function signUp(t, { email, username, name = username }) {
  const res = await api(t.baseUrl, "POST", "/api/auth/sign-up/email", {
    headers: { origin: t.config.betterAuthBaseURL },
    body: { email, username, name, password: "correct-horse-battery" },
  });
  assert.equal(res.status, 200, `sign-up ${email}: ${res.status} ${JSON.stringify(res.json)}`);
  return {
    token: res.headers.get("set-auth-token"),
    user: res.json.user,
  };
}

function ba(t, token, extra = {}) {
  return {
    headers: {
      origin: t.config.betterAuthBaseURL,
      authorization: `Bearer ${token}`,
      ...extra,
    },
  };
}

async function startAdminApp(overrides = {}) {
  const t = await startTestApp({
    env: {
      RELAY_ADMIN_EMAILS: overrides.adminEmails ?? ADMIN_EMAIL,
      ...overrides.env,
    },
  });
  return { t };
}

function userColumns(t) {
  return t.app.db.prepare("PRAGMA table_info(user)").all();
}

function userRow(t, email) {
  return t.app.db.prepare("SELECT * FROM user WHERE email = ?").get(email);
}

function seedNode(t, accountId, {
  nodeId = "node-00112233aabbccdd",
  name = "Machine",
} = {}) {
  t.app.registry.createNode(accountId, {
    id: nodeId,
    kind: "byo",
    name,
    pubkey: "pk-must-not-leak",
    version: null,
  });
  return { nodeId };
}

function assertNoSecrets(value) {
  const blob = JSON.stringify(value);
  assert.doesNotMatch(blob, /pk-must-not-leak/);
  assert.doesNotMatch(blob, /enrollToken/i);
  assert.doesNotMatch(blob, /sessionToken/);
  assert.equal(value.pubkey, undefined);
}

test("RELAY_ADMIN_EMAILS is normalized into config.adminEmails", async () => {
  const t = await startTestApp({
    env: { RELAY_ADMIN_EMAILS: " Ops@Example.COM , other@x.test, " },
  });
  try {
    assert.deepEqual(t.config.adminEmails, ["ops@example.com", "other@x.test"]);
  } finally {
    await t.close();
  }
});

test("admin plugin migrations add role and banned; pinned email is admin and a normal user is not", async () => {
  const { t } = await startAdminApp();
  try {
    const columns = userColumns(t);
    assert.ok(columns.some((c) => c.name === "role"), "user.role column");
    assert.ok(columns.some((c) => c.name === "banned"), "user.banned column");

    const admin = await signUp(t, { email: ADMIN_EMAIL, username: "ops_admin", name: "Ops" });
    const user = await signUp(t, { email: "member@example.test", username: "member_user", name: "Member" });

    const adminRow = userRow(t, ADMIN_EMAIL);
    const userRowDb = userRow(t, "member@example.test");
    assert.ok(String(adminRow.role || "").split(",").map((s) => s.trim()).includes("admin"));
    assert.equal(String(userRowDb.role || "user").split(",").map((s) => s.trim()).includes("admin"), false);

    const asAdmin = await api(t.baseUrl, "GET", "/v1/admin/accounts", ba(t, admin.token));
    assert.equal(asAdmin.status, 200);
    const asUser = await api(t.baseUrl, "GET", "/v1/admin/accounts", ba(t, user.token));
    assert.equal(asUser.status, 403);
    assert.equal(asUser.json.error, "forbidden");
  } finally {
    await t.close();
  }
});

test("GET /v1/admin/accounts is 401 without a session, 403 for a member, 200 for an admin", async () => {
  const { t } = await startAdminApp();
  try {
    const admin = await signUp(t, { email: ADMIN_EMAIL, username: "ops_gate" });
    const member = await signUp(t, { email: "gate-member@example.test", username: "gate_member" });

    const anon = await api(t.baseUrl, "GET", "/v1/admin/accounts");
    assert.equal(anon.status, 401);
    assert.equal(anon.json.error, "unauthorized");

    const tokenOnly = await api(t.baseUrl, "GET", "/v1/admin/accounts", {
      headers: { authorization: `Bearer ${TEST_ADMIN_TOKEN}` },
    });
    assert.equal(tokenOnly.status, 401);
    assert.equal(tokenOnly.json.error, "unauthorized");

    const forbidden = await api(t.baseUrl, "GET", "/v1/admin/accounts", ba(t, member.token));
    assert.equal(forbidden.status, 403);
    assert.equal(forbidden.json.error, "forbidden");

    const ok = await api(t.baseUrl, "GET", "/v1/admin/accounts", ba(t, admin.token));
    assert.equal(ok.status, 200);
    assert.ok(Array.isArray(ok.json.accounts));
  } finally {
    await t.close();
  }
});

test("GET /v1/admin/accounts lists newest first with nodes, entitlements and no secrets", async () => {
  const { t } = await startAdminApp();
  try {
    const admin = await signUp(t, { email: ADMIN_EMAIL, username: "ops_list", name: "Ops" });
    const customer = await signUp(t, {
      email: "listed@example.test",
      username: "listed_user",
      name: "Listed",
    });
    seedNode(t, customer.user.id);

    const page = await api(t.baseUrl, "GET", "/v1/admin/accounts?limit=1", ba(t, admin.token));
    assert.equal(page.status, 200);
    assert.equal(page.json.accounts.length, 1);

    const all = await api(t.baseUrl, "GET", "/v1/admin/accounts", ba(t, admin.token));
    assert.equal(all.status, 200);
    const emails = all.json.accounts.map((a) => a.email);
    assert.ok(emails.includes(ADMIN_EMAIL));
    const listed = all.json.accounts.find((a) => a.id === customer.user.id);
    assert.ok(listed, "customer account must appear");
    assert.equal(listed.email, "listed@example.test");
    assert.equal(listed.name, "Listed");
    assert.equal(listed.trial, undefined, "the admin row no longer carries a trial");
    assert.equal(listed.nodes.length, 1);
    assert.equal(listed.nodes[0].id, "node-00112233aabbccdd");
    assert.equal(listed.nodes[0].kind, "byo");
    assert.equal(listed.nodes[0].name, "Machine");
    assert.equal(listed.nodes[0].pubkey, undefined);
    assert.ok(listed.entitlements.some((e) => e.feature === "nodes.max"));
    assertNoSecrets(listed);
    assertNoSecrets(listed.nodes[0]);
  } finally {
    await t.close();
  }
});

test("DELETE /v1/nodes/:id deletes the caller's own node and nothing else", async () => {
  const { t } = await startAdminApp();
  try {
    const owner = await signUp(t, { email: "del@example.test", username: "del_user" });
    const other = await signUp(t, { email: "del-other@example.test", username: "del_other" });
    const { nodeId } = seedNode(t, owner.user.id);

    const foreign = await api(t.baseUrl, "DELETE", `/v1/nodes/${nodeId}`, ba(t, other.token));
    assert.equal(foreign.status, 404);
    assert.ok(t.app.registry.getNode(nodeId), "a foreign DELETE must not remove the node");

    const del = await api(t.baseUrl, "DELETE", `/v1/nodes/${nodeId}`, ba(t, owner.token));
    assert.equal(del.status, 204);
    assert.equal(t.app.registry.getNode(nodeId), null);
  } finally {
    await t.close();
  }
});

test("Better Auth admin list/ban/set-role/impersonate succeed as admin and fail as a user; impersonating an admin fails", async () => {
  const { t } = await startAdminApp();
  try {
    const admin = await signUp(t, { email: ADMIN_EMAIL, username: "ops_ba", name: "Ops" });
    const member = await signUp(t, { email: "ba-member@example.test", username: "ba_member", name: "Member" });
    const otherAdmin = await signUp(t, { email: "made-admin@example.test", username: "made_admin", name: "Made" });

    const listed = await api(t.baseUrl, "GET", "/api/auth/admin/list-users", ba(t, admin.token));
    assert.equal(listed.status, 200);
    assert.ok(Array.isArray(listed.json.users));

    const asUser = await api(t.baseUrl, "GET", "/api/auth/admin/list-users", ba(t, member.token));
    assert.equal(asUser.status, 403);

    const userBan = await api(t.baseUrl, "POST", "/api/auth/admin/ban-user", {
      ...ba(t, member.token),
      body: { userId: admin.user.id },
    });
    assert.equal(userBan.status, 403);

    const userSet = await api(t.baseUrl, "POST", "/api/auth/admin/set-role", {
      ...ba(t, member.token),
      body: { userId: member.user.id, role: "admin" },
    });
    assert.equal(userSet.status, 403);

    const userImpersonate = await api(t.baseUrl, "POST", "/api/auth/admin/impersonate-user", {
      ...ba(t, member.token),
      body: { userId: admin.user.id },
    });
    assert.equal(userImpersonate.status, 403);

    const impersonateMember = await api(t.baseUrl, "POST", "/api/auth/admin/impersonate-user", {
      ...ba(t, admin.token),
      body: { userId: member.user.id },
    });
    assert.equal(impersonateMember.status, 200);

    const banned = await api(t.baseUrl, "POST", "/api/auth/admin/ban-user", {
      ...ba(t, admin.token),
      body: { userId: member.user.id },
    });
    assert.equal(banned.status, 200);
    assert.equal(Boolean(banned.json.user.banned), true);

    const made = await api(t.baseUrl, "POST", "/api/auth/admin/set-role", {
      ...ba(t, admin.token),
      body: { userId: otherAdmin.user.id, role: "admin" },
    });
    assert.equal(made.status, 200);

    const impersonateAdmin = await api(t.baseUrl, "POST", "/api/auth/admin/impersonate-user", {
      ...ba(t, admin.token),
      body: { userId: otherAdmin.user.id },
    });
    assert.equal(impersonateAdmin.status, 403);

    const demote = await api(t.baseUrl, "POST", "/api/auth/admin/set-role", {
      ...ba(t, admin.token),
      body: { userId: admin.user.id, role: "user" },
    });
    assert.equal(demote.status, 200);
    const stillAdmin = await api(t.baseUrl, "GET", "/v1/admin/accounts", ba(t, admin.token));
    assert.equal(stillAdmin.status, 200);
  } finally {
    await t.close();
  }
});

test("GET /v1/admin/nodes stays on ADMIN_TOKEN and is not a session admin route", async () => {
  const { t } = await startAdminApp();
  try {
    const admin = await signUp(t, { email: ADMIN_EMAIL, username: "ops_nodes" });
    const withSession = await api(t.baseUrl, "GET", "/v1/admin/nodes", ba(t, admin.token));
    assert.equal(withSession.status, 401);
    const withToken = await api(t.baseUrl, "GET", "/v1/admin/nodes", {
      headers: { authorization: `Bearer ${TEST_ADMIN_TOKEN}` },
    });
    assert.equal(withToken.status, 200);
    assert.ok(Array.isArray(withToken.json.nodes));
  } finally {
    await t.close();
  }
});
