// Trial pairing, provisioning stages, machines list, and waitlist.
// The cloud never mints the pairing secret; this client does.
// Do not offer trial destroy.

import { cloud as defaultCloud } from "./cloud.js";

const PAIRING_SECRET_RE = /^[A-Za-z0-9_-]{22,128}$/;
const AUTH_LABEL = "relay-pair-auth-v1";
const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;

function bytesToBase64url(bytes) {
  const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let binary = "";
  for (const value of arr) binary += String.fromCharCode(value);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function defaultRandom24() {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return bytes;
}

export function mintPairingSecret(getBytes = defaultRandom24) {
  const secret = bytesToBase64url(getBytes(24));
  if (!PAIRING_SECRET_RE.test(secret)) throw new Error("pairing_secret_invalid");
  return secret;
}

export async function deriveAuthToken(secret) {
  const prefix = new TextEncoder().encode(AUTH_LABEL);
  const secretBytes = new TextEncoder().encode(secret);
  const data = new Uint8Array(prefix.length + 1 + secretBytes.length);
  data.set(prefix, 0);
  data[prefix.length] = 0;
  data.set(secretBytes, prefix.length + 1);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", data));
  return bytesToBase64url(digest);
}

/**
 * @param {{ state?: string, nodeId?: string | null } | null | undefined} trial
 */
export function provisioningStage(trial) {
  const state = trial?.state;
  if (state === "failed") return { stage: "failed", label: "Failed" };
  if (state === "ready") return { stage: "ready", label: "Ready" };
  if (state === "creating" && trial?.nodeId) return { stage: "booting", label: "Booting" };
  return { stage: "creating", label: "Creating" };
}

export function kindWord(kind) {
  return kind === "trial" ? "TRIAL" : "YOUR MACHINE";
}

function remainingStatus(expiresAt, now) {
  const remaining = Number(expiresAt) - now;
  if (!Number.isFinite(remaining) || remaining <= 0) return "EXPIRED";
  const days = Math.floor(remaining / DAY_MS);
  if (days >= 1) return `${days} DAY${days === 1 ? "" : "S"} LEFT`;
  const hours = Math.max(1, Math.ceil(remaining / HOUR_MS));
  return `${hours} HOUR${hours === 1 ? "" : "S"} LEFT`;
}

/**
 * @param {{
 *   node?: { kind?: string, lastSeen?: number | null },
 *   trial?: { state?: string, expiresAt?: number } | null,
 *   now?: number,
 * }} [args]
 */
export function machineStatusWord({ node, trial, now = Date.now() } = {}) {
  if (node?.kind === "trial") {
    if (trial?.state === "failed") return "FAILED";
    if (trial?.state === "expired" || trial?.state === "destroyed") return "EXPIRED";
    const left = remainingStatus(trial?.expiresAt, now);
    if (left === "EXPIRED") return "EXPIRED";
    return `TRIAL · ${left}`;
  }
  return "READY";
}

/**
 * @param {{
 *   nodes?: { kind?: string }[],
 *   entitlements?: { feature: string, value: string }[],
 *   waitlistJoined?: boolean,
 *   defaultMaxNodes?: number,
 * }} [args]
 */
export function decideMachineAction({
  nodes = [],
  entitlements = [],
  waitlistJoined = false,
  defaultMaxNodes = 1,
} = {}) {
  const raw = entitlements.find((row) => row.feature === "nodes.max")?.value;
  const parsed = Number.parseInt(raw ?? String(defaultMaxNodes), 10);
  const max = Number.isFinite(parsed) ? parsed : defaultMaxNodes;
  const byoCount = nodes.filter((node) => node.kind !== "trial").length;
  if (byoCount < max) return { action: "new_machine" };
  if (waitlistJoined) return { action: "on_waitlist" };
  return { action: "waitlist" };
}

export function createTrial({
  cloud = defaultCloud,
  mintSecret = mintPairingSecret,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
} = {}) {
  async function startTrial() {
    const pairingSecret = mintSecret();
    const authToken = await deriveAuthToken(pairingSecret);
    const session = await cloud.cloudFetch("/v1/pairing/sessions", {
      method: "POST",
      body: { authToken },
    });
    if (!session.ok) return session;
    const created = await cloud.cloudFetch("/v1/trial-nodes", {
      method: "POST",
      body: { pairingId: session.json?.pairingId, pairingSecret },
    });
    if (created.status === 409 && created.json?.error === "trial_already_used") {
      return cloud.cloudFetch("/v1/trial-nodes/current");
    }
    return created;
  }

  function getCurrent() {
    return cloud.cloudFetch("/v1/trial-nodes/current");
  }

  /**
   * @param {{ interval?: number, signal?: AbortSignal }} [opts]
   */
  async function pollUntilSettled({ interval = 2, signal } = {}) {
    const waitMs = Math.max(1, Number(interval) || 2) * 1000;
    for (;;) {
      if (signal?.aborted) return { ok: false, status: 0, json: { error: "aborted" } };
      const current = await getCurrent();
      const state = current.json?.trial?.state;
      if (current.ok && (state === "ready" || state === "failed")) return current;
      if (!current.ok && current.status !== 404) return current;
      await sleep(waitMs);
    }
  }

  function listNodes() {
    return cloud.cloudFetch("/v1/nodes");
  }

  function getAccount() {
    return cloud.cloudFetch("/v1/account");
  }

  function joinWaitlist(email) {
    return cloud.cloudFetch("/v1/waitlist", {
      method: "POST",
      body: { email },
    });
  }

  return {
    startTrial,
    getCurrent,
    pollUntilSettled,
    listNodes,
    getAccount,
    joinWaitlist,
  };
}

export const trial = createTrial();
