// Admin console helpers and Relay admin HTTP.
// Better Auth remains the source of truth for who is an admin.

import { cloud as defaultCloud } from "./cloud.js";

export const UPGRADE_CONFIRM_COPY =
  "Keep this hosted machine, drop the trial limit, allow their own computer.";

export const UNLINK_CONFIRM_COPY =
  "Unlink deletes this hosted machine and its files.";

const TRIAL_STATES = new Set([
  "creating",
  "ready",
  "upgraded",
  "expired",
  "destroyed",
  "failed",
]);

export function isAdminRole(role) {
  if (!role) return false;
  return String(role)
    .split(",")
    .map((part) => part.trim())
    .includes("admin");
}

export function adminRouteFor({ signedIn, role } = {}) {
  if (!signedIn) return "/login";
  if (!isAdminRole(role)) return "/machines";
  return "/admin";
}

export function shouldShowAdminNav({ signedIn, role } = {}) {
  return Boolean(signedIn) && isAdminRole(role);
}

export function isImpersonating(session) {
  return Boolean(session?.impersonatedBy);
}

export function trialStateWord(trial) {
  const state = trial?.state;
  if (!state || !TRIAL_STATES.has(state)) return "NONE";
  return String(state).toUpperCase();
}

export function canUpgrade(account) {
  const state = account?.trial?.state;
  const nodeId = account?.trial?.nodeId;
  return (state === "creating" || state === "ready") && Boolean(nodeId);
}

export function canUnlink(account) {
  return Boolean(hostedMachineId(account));
}

export function canImpersonate(account) {
  return !isAdminRole(account?.role);
}

export function roleActionLabel(role) {
  return isAdminRole(role) ? "Make user" : "Make admin";
}

export function hostedMachineId(account) {
  return account?.trial?.nodeId || account?.nodes?.[0]?.id || null;
}

export function nodesMax(entitlements = []) {
  const raw = entitlements.find((row) => row.feature === "nodes.max")?.value;
  return raw == null || raw === "" ? "0" : String(raw);
}

export function upgradeErrorWord(result) {
  if (!result || result.ok) return null;
  if (result.json?.error === "nothing_to_upgrade") return "NOTHING TO UPGRADE";
  const error = result.json?.error;
  if (error) return String(error).replace(/_/g, " ").toUpperCase();
  return "FAILED";
}

/**
 * @param {string} accountId
 * @param {{
 *   confirm?: (message?: string) => boolean,
 *   upgrade: (id: string) => Promise<{ ok?: boolean, status?: number, json?: { error?: string } | null, cancelled?: boolean }>,
 * }} opts
 */
export async function confirmAndUpgrade(
  accountId,
  {
    confirm = globalThis.confirm?.bind(globalThis),
    upgrade,
  } = {},
) {
  if (!confirm(UPGRADE_CONFIRM_COPY)) return { cancelled: true };
  return upgrade(accountId);
}

/**
 * @param {string} accountId
 * @param {{
 *   confirm?: (message?: string) => boolean,
 *   unlink: (id: string) => Promise<{ ok?: boolean, status?: number, json?: { error?: string } | null, cancelled?: boolean }>,
 * }} opts
 */
export async function confirmAndUnlink(
  accountId,
  {
    confirm = globalThis.confirm?.bind(globalThis),
    unlink,
  } = {},
) {
  if (!confirm(UNLINK_CONFIRM_COPY)) return { cancelled: true };
  return unlink(accountId);
}

export function createAdmin({ cloud = defaultCloud } = {}) {
  function listAccounts() {
    return cloud.cloudFetch("/v1/admin/accounts");
  }

  function upgradeAccount(id) {
    return cloud.cloudFetch(`/v1/admin/accounts/${encodeURIComponent(id)}/upgrade`, {
      method: "POST",
    });
  }

  function unlinkMachine(id) {
    return cloud.cloudFetch(`/v1/admin/accounts/${encodeURIComponent(id)}/machine`, {
      method: "DELETE",
    });
  }

  return { listAccounts, upgradeAccount, unlinkMachine };
}

export const admin = createAdmin();
