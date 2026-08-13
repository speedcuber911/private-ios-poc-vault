// Minimal JWT helpers on node:crypto only.
// - HS256 sign/verify for Relay session tokens.
// - RS256 verify against a JWK for Sign in with Apple identity tokens.
//
// TOTALITY IS A SECURITY PROPERTY HERE. These functions parse attacker-supplied
// bytes on unauthenticated paths, so every one of them returns null on bad
// input and never throws: a malformed token must produce a clean 401, never a
// 500. In particular a JWT segment can decode to valid JSON that is not an
// object (`null`, `[]`, `7`, `"x"`) — those are rejected during decode so no
// caller ever dereferences a non-object header or claim set.

import {
  createHmac,
  createPrivateKey,
  createPublicKey,
  sign as cryptoSign,
  timingSafeEqual,
  verify as cryptoVerify,
} from "node:crypto";

// RFC 7515 base64url: no padding, no whitespace, no standard-base64 "+/".
// Node's base64url decoder silently ignores characters outside the alphabet,
// so we check the alphabet ourselves rather than accept a token whose text
// differs from the bytes we would decode from it.
const B64URL_RE = /^[A-Za-z0-9_-]+$/;

export function b64urlJson(obj) {
  return Buffer.from(JSON.stringify(obj)).toString("base64url");
}

function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// Returns the decoded object, or null for anything that is not a base64url
// segment holding a JSON object.
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

// Decodes without verifying anything. Returns null unless the token is exactly
// three base64url segments whose first two are JSON objects; callers may
// therefore always treat `header` and `payload` as objects.
export function decodeJwtUnsafe(token) {
  if (typeof token !== "string" || token.length === 0) return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  if (!B64URL_RE.test(parts[2])) return null; // signature segment
  const header = decodePart(parts[0]);
  const payload = decodePart(parts[1]);
  if (!header || !payload) return null;
  return { header, payload, parts };
}

export function signHS256(payload, secret) {
  const header = b64urlJson({ alg: "HS256", typ: "JWT" });
  const body = b64urlJson(payload);
  const mac = createHmac("sha256", secret)
    .update(`${header}.${body}`)
    .digest("base64url");
  return `${header}.${body}.${mac}`;
}

// Returns the payload on success, null on any failure (bad shape, bad alg,
// bad signature, expired). `nowMs` is injectable for tests.
export function verifyHS256(token, secret, nowMs = Date.now()) {
  const decoded = decodeJwtUnsafe(token);
  if (!decoded) return null;
  const { header, payload, parts } = decoded;
  if (header.alg !== "HS256") return null;
  let expected;
  try {
    expected = createHmac("sha256", secret)
      .update(`${parts[0]}.${parts[1]}`)
      .digest();
  } catch {
    return null; // unusable secret — treat as "cannot verify", never throw
  }
  const got = Buffer.from(parts[2], "base64url");
  if (expected.length !== got.length || !timingSafeEqual(expected, got)) {
    return null;
  }
  if (
    typeof payload.exp !== "number" ||
    !Number.isFinite(payload.exp) ||
    payload.exp * 1000 <= nowMs
  ) {
    return null;
  }
  return payload;
}

// Verify an RS256 JWT signature against a single JWK. Claim checks (iss, aud,
// exp) are the caller's job. Returns { header, payload } or null.
export function verifyRS256(token, jwk) {
  const decoded = decodeJwtUnsafe(token);
  if (!decoded) return null;
  const { header, payload, parts } = decoded;
  if (header.alg !== "RS256") return null;
  // Pin the key type to the algorithm: an RS256 header must never be checked
  // against a key of some other family.
  if (!isPlainObject(jwk) || jwk.kty !== "RSA") return null;
  let key;
  try {
    key = createPublicKey({ key: jwk, format: "jwk" });
  } catch {
    return null;
  }
  const sig = Buffer.from(parts[2], "base64url");
  let ok = false;
  try {
    ok = cryptoVerify(
      "RSA-SHA256",
      Buffer.from(`${parts[0]}.${parts[1]}`),
      key,
      sig,
    );
  } catch {
    return null;
  }
  return ok ? { header, payload } : null;
}

function normalizePrivateKey(privateKey) {
  if (typeof privateKey === "string") {
    return createPrivateKey(privateKey);
  }
  return privateKey;
}

export function signEd25519(payload, privateKey) {
  const header = b64urlJson({ alg: "EdDSA", typ: "JWT" });
  const body = b64urlJson(payload);
  const data = `${header}.${body}`;
  const sig = cryptoSign(null, Buffer.from(data), normalizePrivateKey(privateKey)).toString(
    "base64url",
  );
  return `${data}.${sig}`;
}

// Returns the payload on success, null on any failure. Never throws.
export function verifyEd25519(token, publicKey, nowMs = Date.now()) {
  const decoded = decodeJwtUnsafe(token);
  if (!decoded) return null;
  const { header, payload, parts } = decoded;
  if (header.alg !== "EdDSA") return null;
  if (
    typeof payload.exp !== "number" ||
    !Number.isFinite(payload.exp) ||
    payload.exp * 1000 <= nowMs
  ) {
    return null;
  }
  const sig = Buffer.from(parts[2], "base64url");
  let ok = false;
  try {
    ok = cryptoVerify(
      null,
      Buffer.from(`${parts[0]}.${parts[1]}`),
      publicKey,
      sig,
    );
  } catch {
    return null;
  }
  return ok ? payload : null;
}
