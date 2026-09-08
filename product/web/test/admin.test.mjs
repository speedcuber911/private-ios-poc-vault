import test from "node:test";
import assert from "node:assert/strict";
import { createCloud } from "../src/api/cloud.js";
import {
  adminRouteFor,
  canImpersonate,
  createAdmin,
  isAdminRole,
  isImpersonating,
  nodesMax,
  roleActionLabel,
  shouldShowAdminNav,
} from "../src/api/admin.js";
import * as adminApi from "../src/api/admin.js";

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

test("adminRouteFor sends signed-out users to login and non-admins to activity", () => {
  assert.equal(adminRouteFor({ signedIn: false }), "/login");
  assert.equal(adminRouteFor({ signedIn: true, role: "user" }), "/activity");
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

test("canImpersonate is hidden for admin targets", () => {
  assert.equal(canImpersonate({ role: "user" }), true);
  assert.equal(canImpersonate({ role: "admin" }), false);
  assert.equal(canImpersonate({ role: "admin,user" }), false);
});

test("roleActionLabel toggles Make admin and Make user", () => {
  assert.equal(roleActionLabel("user"), "Make admin");
  assert.equal(roleActionLabel("admin"), "Make user");
});

test("nodes.max comes from the account entitlements", () => {
  assert.equal(nodesMax([{ feature: "nodes.max", value: "2" }]), "2");
  assert.equal(nodesMax([]), "0");
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

test("the admin API offers no machine lifecycle actions", () => {
  const { api } = adminWith(() => ({ status: 200, json: {} }));
  assert.deepEqual(Object.keys(api), ["listAccounts"]);
  for (const name of [
    "upgradeAccount",
    "unlinkMachine",
    "confirmAndUpgrade",
    "confirmAndUnlink",
    "canUpgrade",
    "canUnlink",
    "hostedMachineId",
    "trialStateWord",
    "upgradeErrorWord",
    "UPGRADE_CONFIRM_COPY",
    "UNLINK_CONFIRM_COPY",
    "REMOVE_CONFIRM_COPY",
  ]) {
    assert.equal(adminApi[name], undefined, `${name} should be gone`);
  }
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
