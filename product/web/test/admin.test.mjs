import test from "node:test";
import assert from "node:assert/strict";
import { createCloud } from "../src/api/cloud.js";
import { kindWord, machineStatusWord } from "../src/api/trial.js";
import {
  UPGRADE_CONFIRM_COPY,
  adminRouteFor,
  canImpersonate,
  canUpgrade,
  confirmAndUpgrade,
  createAdmin,
  hostedMachineId,
  isAdminRole,
  isImpersonating,
  nodesMax,
  roleActionLabel,
  shouldShowAdminNav,
  trialStateWord,
  upgradeErrorWord,
} from "../src/api/admin.js";

function mockFetch(handler) {
  return async (url, init) => {
    const parsed = new URL(url, "https://cloud.example.test");
    const body = init?.body ? JSON.parse(init.body) : null;
    const res = await handler({
      url: String(url),
      path: parsed.pathname,
      method: init?.method || "GET",
      credentials: init?.credentials,
      body,
    });
    const json = res.json === undefined ? {} : res.json;
    const text = json == null ? "" : JSON.stringify(json);
    return {
      ok: res.status >= 200 && res.status < 300,
      status: res.status,
      headers: { get: () => "application/json" },
      async text() {
        return text;
      },
      async json() {
        return json;
      },
    };
  };
}

function adminWith(handler) {
  const cloud = createCloud({
    baseUrl: "https://cloud.example.test",
    fetchImpl: mockFetch(handler),
  });
  return { cloud, api: createAdmin({ cloud }) };
}

test("adminRouteFor sends signed-out users to login and non-admins to machines", () => {
  assert.equal(adminRouteFor({ signedIn: false }), "/login");
  assert.equal(adminRouteFor({ signedIn: true, role: "user" }), "/machines");
  assert.equal(adminRouteFor({ signedIn: true, role: "admin" }), "/admin");
  assert.equal(adminRouteFor({ signedIn: true, role: "admin,user" }), "/admin");
});

test("isAdminRole is true when role includes admin", () => {
  assert.equal(isAdminRole("admin"), true);
  assert.equal(isAdminRole("admin,user"), true);
  assert.equal(isAdminRole("user, admin"), true);
  assert.equal(isAdminRole("user"), false);
  assert.equal(isAdminRole(""), false);
  assert.equal(isAdminRole(null), false);
});

test("Admin nav is visible only for a signed-in admin session", () => {
  assert.equal(shouldShowAdminNav({ signedIn: true, role: "admin" }), true);
  assert.equal(shouldShowAdminNav({ signedIn: true, role: "user" }), false);
  assert.equal(shouldShowAdminNav({ signedIn: false, role: "admin" }), false);
});

test("isImpersonating follows Better Auth session.impersonatedBy", () => {
  assert.equal(isImpersonating({ impersonatedBy: "admin-1" }), true);
  assert.equal(isImpersonating({ impersonatedBy: null }), false);
  assert.equal(isImpersonating({}), false);
});

test("trialStateWord is a small-caps state or NONE", () => {
  assert.equal(trialStateWord({ state: "creating" }), "CREATING");
  assert.equal(trialStateWord({ state: "ready" }), "READY");
  assert.equal(trialStateWord({ state: "upgraded" }), "UPGRADED");
  assert.equal(trialStateWord({ state: "expired" }), "EXPIRED");
  assert.equal(trialStateWord({ state: "destroyed" }), "DESTROYED");
  assert.equal(trialStateWord({ state: "failed" }), "FAILED");
  assert.equal(trialStateWord(null), "NONE");
  assert.equal(trialStateWord({}), "NONE");
});

test("canUpgrade requires creating or ready plus a hosted nodeId", () => {
  assert.equal(canUpgrade({ trial: { state: "ready", nodeId: "node-1" } }), true);
  assert.equal(canUpgrade({ trial: { state: "creating", nodeId: "node-1" } }), true);
  assert.equal(canUpgrade({ trial: { state: "ready", nodeId: null } }), false);
  assert.equal(canUpgrade({ trial: { state: "upgraded", nodeId: "node-1" } }), false);
  assert.equal(canUpgrade({ trial: { state: "expired", nodeId: "node-1" } }), false);
  assert.equal(canUpgrade({ trial: { state: "failed", nodeId: "node-1" } }), false);
  assert.equal(canUpgrade({ trial: null }), false);
});

test("canImpersonate is hidden for admin targets", () => {
  assert.equal(canImpersonate({ role: "user" }), true);
  assert.equal(canImpersonate({ role: "admin" }), false);
  assert.equal(canImpersonate({ role: "admin,user" }), false);
});

test("roleActionLabel toggles Make admin and Make user", () => {
  assert.equal(roleActionLabel("user"), "Make admin");
  assert.equal(roleActionLabel("admin"), "Make user");
});

test("hostedMachineId and nodes.max come from the account row", () => {
  assert.equal(
    hostedMachineId({ trial: { nodeId: "node-9" }, nodes: [{ id: "other" }] }),
    "node-9",
  );
  assert.equal(hostedMachineId({ trial: null, nodes: [{ id: "byo-1" }] }), "byo-1");
  assert.equal(hostedMachineId({ trial: null, nodes: [] }), null);
  assert.equal(nodesMax([{ feature: "nodes.max", value: "2" }]), "2");
  assert.equal(nodesMax([]), "0");
});

test("upgrade confirm copy is the operator warning", () => {
  assert.equal(
    UPGRADE_CONFIRM_COPY,
    "Keep this hosted machine, drop the trial limit, allow their own computer.",
  );
});

test("listAccounts GETs /v1/admin/accounts with credentials include", async () => {
  const calls = [];
  const { api } = adminWith(({ path, method, credentials }) => {
    calls.push({ path, method, credentials });
    return { status: 200, json: { accounts: [] } };
  });
  const result = await api.listAccounts();
  assert.equal(result.status, 200);
  assert.deepEqual(calls[0], {
    path: "/v1/admin/accounts",
    method: "GET",
    credentials: "include",
  });
});

test("upgrade confirm posts /v1/admin/accounts/:id/upgrade", async () => {
  const calls = [];
  const { api } = adminWith(({ path, method, credentials, body }) => {
    calls.push({ path, method, credentials, body });
    return { status: 200, json: { ok: true, account: { id: "acc-1" } } };
  });
  const result = await confirmAndUpgrade("acc-1", {
    confirm: () => true,
    upgrade: (id) => api.upgradeAccount(id),
  });
  assert.equal(result.status, 200);
  assert.deepEqual(calls[0], {
    path: "/v1/admin/accounts/acc-1/upgrade",
    method: "POST",
    credentials: "include",
    body: null,
  });
});

test("upgrade confirm does not post when the operator cancels", async () => {
  let posted = false;
  const result = await confirmAndUpgrade("acc-1", {
    confirm: (copy) => {
      assert.equal(copy, UPGRADE_CONFIRM_COPY);
      return false;
    },
    upgrade: async () => {
      posted = true;
      return { ok: true, status: 200, json: {} };
    },
  });
  assert.equal(result.cancelled, true);
  assert.equal(posted, false);
});

test("409 nothing_to_upgrade is a short error word and does not throw", () => {
  assert.equal(
    upgradeErrorWord({
      ok: false,
      status: 409,
      json: { error: "nothing_to_upgrade" },
    }),
    "NOTHING TO UPGRADE",
  );
  assert.equal(upgradeErrorWord({ ok: true, status: 200, json: { ok: true } }), null);
});

test("kindWord and machineStatusWord stay YOUR MACHINE / READY after kind byo", () => {
  const now = 1_700_000_000_000;
  assert.equal(kindWord("byo"), "YOUR MACHINE");
  assert.equal(
    machineStatusWord({
      node: { kind: "byo", lastSeen: now },
      trial: { state: "upgraded", expiresAt: now + 6 * 86_400_000 },
      now,
    }),
    "READY",
  );
  assert.notEqual(kindWord("byo"), "TRIAL");
});

test("authClient.admin.stopImpersonating posts Better Auth stop-impersonating", async () => {
  const calls = [];
  const { cloud } = adminWith(({ path, method, credentials }) => {
    calls.push({ path, method, credentials });
    return { status: 200, json: { session: {}, user: {} } };
  });
  await cloud.authClient.admin.stopImpersonating();
  assert.equal(calls[0].path, "/api/auth/admin/stop-impersonating");
  assert.equal(calls[0].method, "POST");
  assert.equal(calls[0].credentials, "include");
});

test("authClient.admin ban, impersonate, and setRole hit plugin paths", async () => {
  const calls = [];
  const { cloud } = adminWith(({ path, method, credentials, body }) => {
    calls.push({ path, method, credentials, body });
    return { status: 200, json: { user: { id: "u1" } } };
  });
  await cloud.authClient.admin.banUser({ userId: "u1" });
  await cloud.authClient.admin.impersonateUser({ userId: "u1" });
  await cloud.authClient.admin.setRole({ userId: "u1", role: "admin" });
  assert.deepEqual(
    calls.map((call) => call.path),
    [
      "/api/auth/admin/ban-user",
      "/api/auth/admin/impersonate-user",
      "/api/auth/admin/set-role",
    ],
  );
  for (const call of calls) {
    assert.equal(call.method, "POST");
    assert.equal(call.credentials, "include");
  }
});
