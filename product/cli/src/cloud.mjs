// Thin typed wrapper over the relay-cloud HTTP API. Every method returns
// { status, json } so callers decide what a non-2xx means; nothing here throws
// on status alone, and nothing here logs — except the session-refresh path,
// which prints a fixed re-login hint and exits when the refresh token is dead.
import { readCredentials, writeCredentials } from "./creds.mjs";

const DEFAULT_BASE_URL = process.env.RELAY_CLOUD_URL || "https://api.relay.example";
const REFRESH_SKEW_MS = 60_000;

function decodeJwtPayload(token) {
  try {
    const parts = String(token || "").split(".");
    if (parts.length < 2) return null;
    return JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
  } catch {
    return null;
  }
}

function sessionExpiringSoon(sessionToken, nowMs) {
  const payload = decodeJwtPayload(sessionToken);
  if (!payload || typeof payload.exp !== "number") return false;
  return payload.exp * 1000 - nowMs <= REFRESH_SKEW_MS;
}

function createCloudApi({
  baseUrl = DEFAULT_BASE_URL,
  sessionToken = null,
  refreshToken = null,
  home = undefined,
  fetchImpl = fetch,
  now = () => Date.now(),
  logError = (...args) => console.error(...args),
  exit = (code) => process.exit(code),
} = {}) {
  const base = String(baseUrl).replace(/\/+$/, "");
  let currentSession = sessionToken;
  let currentRefresh = refreshToken;

  async function rawRequest(method, pathname, { body, headers = {}, raw, token } = {}) {
    const init = { method, headers: { ...headers } };
    if (token) init.headers.authorization = `Bearer ${token}`;
    if (raw !== undefined) {
      init.headers["content-type"] = "application/octet-stream";
      init.body = raw;
    } else if (body !== undefined) {
      init.headers["content-type"] = "application/json";
      init.body = JSON.stringify(body);
    }
    const res = await fetchImpl(`${base}${pathname}`, init);
    const json = await res.json().catch(() => null);
    return { status: res.status, json };
  }

  async function refreshSession() {
    if (!currentRefresh) return false;
    const res = await rawRequest("POST", "/v1/auth/refresh", { body: { refreshToken: currentRefresh } });
    if (res.status < 200 || res.status >= 300 || !res.json?.sessionToken || !res.json?.refreshToken) {
      return false;
    }
    currentSession = res.json.sessionToken;
    currentRefresh = res.json.refreshToken;
    // Rotate both tokens on disk. Leaves other fields (nodeId, …) intact.
    writeCredentials({
      sessionToken: currentSession,
      refreshToken: currentRefresh,
      accountId: res.json.accountId ?? readCredentials({ home })?.accountId ?? null,
    }, { home });
    return true;
  }

  function failExpired() {
    logError("Session expired — run `relay login`");
    exit(1);
    // Tests stub `exit` as a no-op / thrower; keep a recognizable error either way.
    throw new Error("session_expired");
  }

  // Authenticated requests: proactively refresh near expiry, and on a 401
  // refresh once then retry the original call exactly once. Anonymous callers
  // (no sessionToken) skip this path entirely.
  async function request(method, pathname, opts = {}) {
    if (!currentSession) return rawRequest(method, pathname, opts);

    if (sessionExpiringSoon(currentSession, now())) {
      if (!(await refreshSession())) failExpired();
    }

    const first = await rawRequest(method, pathname, { ...opts, token: currentSession });
    if (first.status !== 401) return first;

    if (!(await refreshSession())) failExpired();
    return rawRequest(method, pathname, { ...opts, token: currentSession });
  }

  return {
    baseUrl: base,
    startDeviceLogin: (payload = {}) => request("POST", "/v1/auth/device/start", { body: payload }),
    pollDeviceToken: (deviceCode) => request("POST", "/v1/auth/device/token", { body: { deviceCode } }),
    currentTrial: () => request("GET", "/v1/trial-nodes/current"),
    registerRepo: (fullName) => request("POST", "/v1/repos", { body: { fullName } }),
    createHandoff: (payload) => request("POST", "/v1/handoffs", { body: payload }),
    listHandoffs: (repo) => request("GET", `/v1/handoffs?repo=${encodeURIComponent(repo)}`),
    createPairingSession: (authToken, kind) => request("POST", "/v1/pairing/sessions", { body: { authToken, kind } }),
    putDeviceBlob: (pairingId, authToken, tag, raw) =>
      request("POST", `/v1/pairing/sessions/${encodeURIComponent(pairingId)}/device-blob`,
        { raw, headers: { "x-pairing-auth": authToken, "x-pairing-tag": tag } }),
    // Tells the machine a sealed blob is waiting for it. Nothing on the node
    // can discover a pending rendezvous on its own, so without this the slot
    // is never read and the sync silently expires. `secret` (not the derived
    // auth token) is what the node needs: it authorizes the slot AND derives
    // the MAC key that authenticates the blob. The payload it unlocks is
    // sealed to the node's X25519 key, so the cloud relays ciphertext it
    // cannot open.
    postSyncAuthNotice: ({ pairingId, nodeId, secret }) =>
      request("POST", "/v1/sync-auth/notices", { body: { pairingId, nodeId, secret } }),
  };
}

export { createCloudApi, DEFAULT_BASE_URL, decodeJwtPayload, sessionExpiringSoon };
