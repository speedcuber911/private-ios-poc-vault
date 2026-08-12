// Thin typed wrapper over the relay-cloud HTTP API. Every method returns
// { status, json } so callers decide what a non-2xx means; nothing here throws
// on status alone, and nothing here logs.
const DEFAULT_BASE_URL = process.env.RELAY_CLOUD_URL || "https://api.relay.example";

function createCloudApi({ baseUrl = DEFAULT_BASE_URL, sessionToken = null, fetchImpl = fetch } = {}) {
  const base = String(baseUrl).replace(/\/+$/, "");

  async function request(method, pathname, { body, headers = {}, raw } = {}) {
    const init = { method, headers: { ...headers } };
    if (sessionToken) init.headers.authorization = `Bearer ${sessionToken}`;
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

  return {
    baseUrl: base,
    startDeviceLogin: () => request("POST", "/v1/auth/device/start", { body: {} }),
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

export { createCloudApi, DEFAULT_BASE_URL };
