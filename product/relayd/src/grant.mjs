// Verify-only Ed25519 browser-grant JWT. Totality: never throw.
// Nodes hold the enroll-delivered public key only; signing stays on the cloud.
// Do not import product/cloud — this copy is the relayd verify path.

import { createPublicKey, verify as cryptoVerify } from "node:crypto";

const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");
const B64URL_RE = /^[A-Za-z0-9_-]+$/;

const ACTIVITY_SCOPE = {
  "/v1/jobs": "jobs.read",
  "/v1/codex/jobs": "jobs.read",
  "/v1/threads": "threads.read",
  "/v1/codex/threads": "threads.read",
  "/v1/events": "events.read",
};

function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function decodePart(part) {
  if (typeof part !== "string" || !B64URL_RE.test(part)) return null;
  let parsed;
  try {
    parsed = JSON.parse(Buffer.from(part, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  return isPlainObject(parsed) ? parsed : null;
}

export function isJwtShaped(token) {
  if (typeof token !== "string" || token.length === 0) return false;
  const parts = token.split(".");
  return parts.length === 3 && parts.every((part) => B64URL_RE.test(part));
}

export function activityScope(method, pathname) {
  const verb = typeof method === "string" ? method.toUpperCase() : "GET";
  if (verb !== "GET") return null;
  return ACTIVITY_SCOPE[pathname] || null;
}

export function scopeCovers(scope, needed) {
  return typeof needed === "string" && Array.isArray(scope) && scope.includes(needed);
}

export function loadGrantPublicKey(value) {
  if (!value) return null;
  if (typeof value === "object" && value.asymmetricKeyType === "ed25519") return value;
  if (typeof value !== "string") return null;
  try {
    const raw = Buffer.from(value, "base64url");
    if (raw.length !== 32) return null;
    return createPublicKey({
      key: Buffer.concat([ED25519_SPKI_PREFIX, raw]),
      format: "der",
      type: "spki",
    });
  } catch {
    return null;
  }
}

function decodeJwtUnsafe(token) {
  if (typeof token !== "string" || token.length === 0) return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  if (!B64URL_RE.test(parts[2])) return null;
  const header = decodePart(parts[0]);
  const payload = decodePart(parts[1]);
  if (!header || !payload) return null;
  return { header, payload, parts };
}

export function verifyBrowserGrant(token, { publicKey, nodeId, nowMs = Date.now() } = {}) {
  try {
    const key = loadGrantPublicKey(publicKey);
    if (!key) return { ok: false };
    const decoded = decodeJwtUnsafe(token);
    if (!decoded) return { ok: false };
    const { header, payload, parts } = decoded;
    if (header.alg !== "EdDSA") return { ok: false };
    if (typeof payload.node !== "string" || payload.node !== nodeId) return { ok: false };
    if (
      typeof payload.exp !== "number" ||
      !Number.isFinite(payload.exp) ||
      payload.exp * 1000 <= nowMs
    ) {
      return { ok: false };
    }
    const sig = Buffer.from(parts[2], "base64url");
    const ok = cryptoVerify(null, Buffer.from(`${parts[0]}.${parts[1]}`), key, sig);
    return ok ? { ok: true, payload } : { ok: false };
  } catch {
    return { ok: false };
  }
}
