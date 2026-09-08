// Admin console helpers and Relay admin HTTP.
// Better Auth remains the source of truth for who is an admin.

import { cloud as defaultCloud } from "./cloud.js";

export function isAdminRole(role) {
  if (!role) return false;
  return String(role)
    .split(",")
    .map((part) => part.trim())
    .includes("admin");
}

export function adminRouteFor({ signedIn, role } = {}) {
  if (!signedIn) return "/login";
  if (!isAdminRole(role)) return "/activity";
  return "/admin";
}

export function shouldShowAdminNav({ signedIn, role } = {}) {
  return Boolean(signedIn) && isAdminRole(role);
}

export function isImpersonating(session) {
  return Boolean(session?.impersonatedBy);
}

export function canImpersonate(account) {
  return !isAdminRole(account?.role);
}

export function roleActionLabel(role) {
  return isAdminRole(role) ? "Make user" : "Make admin";
}

export function nodesMax(entitlements = []) {
  const raw = entitlements.find((row) => row.feature === "nodes.max")?.value;
  return raw == null || raw === "" ? "0" : String(raw);
}

export function createAdmin({ cloud = defaultCloud } = {}) {
  function listAccounts() {
    return cloud.cloudFetch("/v1/admin/accounts");
  }

  return { listAccounts };
}

export const admin = createAdmin();
