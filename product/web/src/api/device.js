// Device-code start/poll/inspect/approve for the web app.
//
// client:"web" signs the browser in (cookie on /device/token).
// client:"cli" is approved on /cli-login after a session exists.
// The redeeming secret (deviceCode) never goes in a QR or URL hash.

import { cloud as defaultCloud } from "./cloud.js";

const DEFAULT_MACHINE_NAME = "This browser";
const MAX_POLL_INTERVAL_SECONDS = 300;
const CLI_CONFIRM_COPY = "Only continue if you just ran relay login on this computer.";

function normalizeUserCode(value) {
  const cleaned = String(value || "")
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");
  if (cleaned.length !== 8) return null;
  return `${cleaned.slice(0, 4)}-${cleaned.slice(4)}`;
}

export function parseUserCodeFromHash(hash) {
  const raw = String(hash || "");
  const fragment = raw.startsWith("#") ? raw.slice(1) : raw;
  if (!fragment) return null;
  for (const pair of fragment.split("&")) {
    const eq = pair.indexOf("=");
    if (eq <= 0) continue;
    const key = pair.slice(0, eq);
    if (key !== "code") continue;
    const value = decodeURIComponent(pair.slice(eq + 1));
    return normalizeUserCode(value);
  }
  return null;
}

export function qrPayloadFromStart(start) {
  const deviceCode = start?.deviceCode;
  const complete = start?.verificationUriComplete;
  const fallback =
    start?.verificationUri && start?.userCode
      ? `${start.verificationUri}#code=${start.userCode}`
      : null;
  const payload = complete || fallback;
  if (!payload) return null;
  if (deviceCode && String(payload).includes(String(deviceCode))) {
    throw new Error("qr_payload_leaked_device_code");
  }
  return payload;
}

export function decideCliLogin({ hasSession, inspect } = {}) {
  if (!hasSession) return { action: "login" };
  if (!inspect) return { action: "login" };
  if (!inspect.ok) {
    if (inspect.status === 401) return { action: "login" };
    if (inspect.status === 409) return { action: "computer_linked" };
    return { action: "invalid" };
  }
  if (inspect.json?.client === "web") return { action: "web_code" };
  return { action: "cli_confirm", machineName: inspect.json?.machineName || null };
}

function pollIntervalMs(interval) {
  return Math.min(MAX_POLL_INTERVAL_SECONDS, Math.max(1, Number(interval) || 5)) * 1000;
}

export function createDevice({
  cloud = defaultCloud,
  machineName = DEFAULT_MACHINE_NAME,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now = () => Date.now(),
} = {}) {
  function startWebLogin({ name = machineName } = {}) {
    return cloud.cloudFetch("/v1/auth/device/start", {
      method: "POST",
      body: { client: "web", machineName: name, platform: "web" },
    });
  }

  async function pollWebLogin(deviceCode, { interval, expiresIn, signal } = {}) {
    const expiresInSeconds = Number(expiresIn);
    const deadline =
      Number.isFinite(expiresInSeconds) && expiresInSeconds > 0
        ? now() + expiresInSeconds * 1000
        : Infinity;
    let waitMs = pollIntervalMs(interval);

    for (;;) {
      if (signal?.aborted) return { ok: false, status: 0, json: { error: "aborted" } };
      await sleep(waitMs);
      if (signal?.aborted) return { ok: false, status: 0, json: { error: "aborted" } };
      if (now() >= deadline) {
        return { ok: false, status: 400, json: { error: "expired_token" } };
      }
      const poll = await cloud.cloudFetch("/v1/auth/device/token", {
        method: "POST",
        body: { deviceCode },
      });
      if (poll.status === 200) return poll;
      const error = poll.json?.error;
      if (error === "authorization_pending") continue;
      if (error === "slow_down") {
        waitMs = Math.min(MAX_POLL_INTERVAL_SECONDS * 1000, waitMs + 5000);
        continue;
      }
      return poll;
    }
  }

  function inspectUserCode(userCode) {
    return cloud.cloudFetch("/v1/auth/device/inspect", {
      method: "POST",
      body: { userCode },
    });
  }

  function approveUserCode(userCode) {
    return cloud.cloudFetch("/v1/auth/device/approve", {
      method: "POST",
      body: { userCode },
    });
  }

  function getSession() {
    return cloud.cloudFetch("/v1/account");
  }

  return {
    startWebLogin,
    pollWebLogin,
    inspectUserCode,
    approveUserCode,
    getSession,
  };
}

export const device = createDevice();
export { CLI_CONFIRM_COPY };
