// relayd pairing.mjs — pairing protocol v2 (API.md §2.3).
//
// WHO HOLDS WHAT
//   The NODE originates the pairing secret (`relayd pair` prints a short code
//   and a long token). The PHONE receives it out of band — QR scan or typed
//   code. The CLOUD, when it is used at all, relays opaque bytes and is told
//   ONLY a derived authToken; it never possesses the secret and therefore can
//   never derive the MAC key that authenticates the relayed blobs.
//
// DERIVATION (both peers, never the cloud)
//   secret    = the long pairing token (>= 24 random bytes, base64url)
//   authToken = base64url( sha256( "relay-pair-auth-v1" || 0x00 || secret ) )
//   macKey    =           hmac-sha256( key = secret, msg = "relay-pair-mac-v1" )
//
// BLOB INTEGRITY — the fix for the control-plane substitution attack
//   tag = base64( hmac-sha256( key = macKey, msg = slotName || 0x00 || blob ) )
//   slotName is exactly "device-blob" or "node-blob". A compromised cloud can
//   still overwrite the stored bytes, but it cannot produce a tag for them, so
//   the receiving PEER detects the substitution without trusting the cloud.
//   Verification failure on the node => audit event, session consumed, and NO
//   certificate is issued. Tags are compared with crypto.timingSafeEqual.
//
// SESSIONS ARE PERSISTED, NOT PROCESS-LOCAL
//   `relayd pair` is a short-lived CLI process; the daemon that serves
//   POST /v1/pair is a different process. Sessions therefore live in the store
//   (json or sqlite) and are claimed atomically, so a printed code is
//   redeemable by the running daemon and can be redeemed exactly once even
//   under concurrent attempts.
//
//   SINGLE USE IS A SECURITY PROPERTY, not tidiness: a second certificate
//   minted from one code is an unauthorized device with full data-path access.
//   The claim therefore rests on a primitive that is atomic ACROSS PROCESSES on
//   every platform — O_CREAT|O_EXCL on the json backend, an exclusive write
//   transaction on sqlite (store.mjs). It is not a read-then-delete: two
//   processes racing `unlink` on darwin/APFS both succeed, and that is exactly
//   how one code minted two certificates.
//
// POST /v1/pair is authenticated by the pairing secret plus the blob tag and
// is NEVER served on the mTLS data listener — it gets its own listener
// (config: RELAYD_PAIRING_*). The response carries the issued cert + node CA
// and no private key material of any kind.

import crypto from "node:crypto";
import http from "node:http";

import { sendJson, sendError, readBody, nowIso } from "./util.mjs";
import { appendAudit } from "./audit.mjs";
import { issueDeviceCert, initIdentity, publicDevice } from "./identity.mjs";
import { emitEvent } from "./events.mjs";
import { store } from "./store.mjs";
import {
  pairingEnabled,
  pairingHost,
  pairingPort,
  pairingAutoAllow,
  pairingEndpointUrl,
  pairingIsLoopbackOnly,
  allowCertSubject,
} from "./config.mjs";

const pairingTtlMs = 15 * 60 * 1000;

// Unambiguous code alphabet (no 0/O/1/I).
const codeAlphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

const DEVICE_SLOT = "device-blob";
const NODE_SLOT = "node-blob";

const AUTH_LABEL = "relay-pair-auth-v1";
const MAC_LABEL = "relay-pair-mac-v1";

// Bound on a relayed blob; matches the cloud's PAIRING_BLOB_MAX_BYTES default.
const maxBlobBytes = 64 * 1024;

// Rate limit. ONLY attempts that failed to match a live session are counted,
// and they are counted PER SOURCE — never in one global bucket.
//
// The global counter this replaces was a denial of service with no
// authentication at all: ten junk POSTs (any code, from anywhere) filled the
// single window and the owner's very next legitimate attempt got 429, for five
// minutes, repeatable forever at two requests a minute. A request carrying the
// real code now always proceeds — it can neither be blocked by, nor consume,
// anyone's budget — so an attacker can no longer stand between the owner and
// their own node. What remains rate-limited is exactly what should be: blind
// guessing, throttled per source address.
//
// There is deliberately no per-session budget: a session is single-use and is
// claimed atomically on the first match, so it has no second attempt to limit.
const attemptWindowMs = 5 * 60 * 1000;
const attemptLimit = 10;
let failedAttempts = new Map();

function pruneAttempts(now) {
  for (const [key, stamps] of failedAttempts) {
    const kept = stamps.filter((ts) => now - ts < attemptWindowMs);
    if (kept.length === 0) failedAttempts.delete(key);
    else failedAttempts.set(key, kept);
  }
}

// Records one failed attempt against `key`. Returns false once the source is
// over budget for the window.
function recordFailedAttempt(key, now) {
  const stamps = failedAttempts.get(key) || [];
  if (stamps.length >= attemptLimit) return false;
  stamps.push(now);
  failedAttempts.set(key, stamps);
  return true;
}

// IPv4-mapped IPv6 (::ffff:203.0.113.9) and the bare form are one source.
function normalizeSource(value) {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) return "unknown";
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(text);
  return (mapped ? mapped[1] : text).slice(0, 64);
}

function randomCode() {
  const chars = [];
  for (let i = 0; i < 8; i += 1) {
    chars.push(codeAlphabet[crypto.randomInt(codeAlphabet.length)]);
    if (i === 3) chars.push("-");
  }
  return chars.join("");
}

function normalizeCode(value) {
  return String(value || "").trim().toUpperCase().replace(/[^A-Z0-9-]/g, "");
}

function prunePairingSessions(nowMs = Date.now()) {
  try {
    return store.prunePairingSessions(nowMs);
  } catch {
    return 0;
  }
}

// ---------------------------------------------------------------------------
// Key derivation + blob tags (the peer-to-peer half of protocol v2)
// ---------------------------------------------------------------------------

// authToken is the ONLY pairing value the cloud is ever told. It is a one-way
// function of the secret: possessing it does not yield the secret and so does
// not yield macKey.
function pairingAuthToken(secret) {
  return crypto
    .createHash("sha256")
    .update(Buffer.concat([Buffer.from(AUTH_LABEL, "utf8"), Buffer.from([0]), Buffer.from(String(secret), "utf8")]))
    .digest("base64url");
}

function pairingMacKey(secret) {
  return crypto.createHmac("sha256", Buffer.from(String(secret), "utf8")).update(MAC_LABEL).digest();
}

function pairingKeys(secret) {
  return { authToken: pairingAuthToken(secret), macKey: pairingMacKey(secret) };
}

function assertKnownSlot(slotName) {
  if (slotName !== DEVICE_SLOT && slotName !== NODE_SLOT) {
    throw new Error("pairing slot must be device-blob or node-blob");
  }
  return slotName;
}

// tag = base64( hmac-sha256(macKey, slotName || 0x00 || blob) )
function blobTag(macKey, slotName, blob) {
  assertKnownSlot(slotName);
  const bytes = Buffer.isBuffer(blob) ? blob : Buffer.from(String(blob), "utf8");
  return crypto
    .createHmac("sha256", macKey)
    .update(Buffer.concat([Buffer.from(slotName, "utf8"), Buffer.from([0]), bytes]))
    .digest("base64");
}

// Constant-time tag check. Compares the DECODED bytes so the comparison is
// always over two equal-length buffers of the same fixed digest size — a
// length difference is rejected before timingSafeEqual, which would otherwise
// throw.
function verifyBlobTag(macKey, slotName, blob, tag) {
  const expected = Buffer.from(blobTag(macKey, slotName, blob), "base64");
  let presented;
  try {
    presented = Buffer.from(String(tag || ""), "base64");
  } catch {
    return false;
  }
  if (presented.length !== expected.length) return false;
  return crypto.timingSafeEqual(presented, expected);
}

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

// Creates a single-use pairing session and PERSISTS it, so the running daemon
// (a different process from `relayd pair`) can redeem it. `code` is the short
// human code; `token` is the long secret for QR/universal-link payloads.
// Either redeems the session.
function createPairingSession() {
  prunePairingSessions();
  const identity = initIdentity();
  const session = {
    id: crypto.randomUUID(),
    code: randomCode(),
    token: crypto.randomBytes(24).toString("base64url"),
    nodeId: identity.nodeId,
    nodeName: identity.nodeName,
    createdAt: nowIso(),
    expiresAt: new Date(Date.now() + pairingTtlMs).toISOString(),
  };
  store.savePairingSession(session);
  appendAudit("pairing_session_created", null, { sessionId: session.id, expiresAt: session.expiresAt });
  return session;
}

// otpauth-style + link forms for the CLI printout (05-onboarding §4.2).
// Domains are placeholders — no live endpoints belong here. `pairUrl` is the
// address the phone POSTs /v1/pair to.
function pairingPresentation(session, { linkBase = process.env.RELAYD_PAIR_LINK_BASE || "https://get.<domain>/pair" } = {}) {
  const url = `${linkBase}#node=${encodeURIComponent(session.nodeId)}&token=${session.token}`;
  const otpauthUrl = `otpauth://relay-pair/${encodeURIComponent(session.nodeName || session.nodeId)}?secret=${session.token}&issuer=relayd&node=${encodeURIComponent(session.nodeId)}`;
  return {
    code: session.code,
    url,
    otpauthUrl,
    expiresAt: session.expiresAt,
    pairUrl: pairingEndpointUrl(),
    pairListenerEnabled: pairingEnabled,
    pairListenerLoopbackOnly: pairingIsLoopbackOnly(),
    // The cloud rendezvous is told this and only this.
    authToken: pairingAuthToken(session.token),
  };
}

function timingSafeEqualString(left, right) {
  const a = Buffer.from(String(left));
  const b = Buffer.from(String(right));
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

// A used code is indistinguishable from an expired one (403 either way).
// The claim is atomic across processes (store.consumePairingSession — O_EXCL
// create on json, exclusive write transaction on sqlite), so two concurrent
// redemptions of the same code cannot both succeed even when they are served
// by two different daemons sharing one data dir.
function consumePairingSecret(rawValue, { source = null } = {}) {
  const now = Date.now();

  // Match FIRST. A caller holding the real secret is never gated on a counter
  // that unauthenticated traffic can move.
  const normalized = normalizeCode(rawValue);
  const rawToken = String(rawValue || "").trim();
  let matched = null;
  for (const session of store.listPairingSessions()) {
    if (Date.parse(session.expiresAt) <= now) continue;
    const codeMatch = normalized.length > 0 && timingSafeEqualString(session.code, normalized);
    const tokenMatch = rawToken.length > 0 && timingSafeEqualString(session.token, rawToken);
    if (codeMatch || tokenMatch) {
      matched = session;
      break;
    }
  }

  if (matched) {
    // Exactly one caller wins this claim; the loser falls through to 403 and,
    // having matched a real session, still spends nobody's budget.
    if (store.consumePairingSession(matched.id)) return matched;
    throw Object.assign(new Error("pairing code is invalid or expired"), { status: 403 });
  }

  pruneAttempts(now);
  if (!recordFailedAttempt(normalizeSource(source), now)) {
    throw Object.assign(new Error("too many pairing attempts"), { status: 429 });
  }
  throw Object.assign(new Error("pairing code is invalid or expired"), { status: 403 });
}

// ---------------------------------------------------------------------------
// The exchange itself — transport independent.
//
// Used by POST /v1/pair (direct mode) and by any rendezvous transport that
// relays the same two blobs through the cloud. The tag check happens BEFORE
// the CSR is parsed or anything is issued, which is precisely what makes a
// control-plane blob substitution fail closed.
// ---------------------------------------------------------------------------

function redeemPairing({ secret, deviceBlob, deviceTag, source = null }) {
  const blob = Buffer.isBuffer(deviceBlob) ? deviceBlob : Buffer.from(String(deviceBlob ?? ""), "utf8");
  if (blob.length === 0 || blob.length > maxBlobBytes) {
    throw Object.assign(new Error("pairing blob is invalid"), { status: 400 });
  }

  // Consume first: a failed exchange must burn the code either way, so an
  // attacker cannot retry against the same session.
  const session = consumePairingSecret(secret, { source });
  const { macKey } = pairingKeys(session.token);

  if (!verifyBlobTag(macKey, DEVICE_SLOT, blob, deviceTag)) {
    appendAudit("pairing_blob_auth_failed", null, { sessionId: session.id, slot: DEVICE_SLOT });
    emitEvent("pairing.rejected", { sessionId: session.id, slot: DEVICE_SLOT, reason: "tag_mismatch" });
    throw Object.assign(new Error("pairing blob authentication failed"), { status: 403 });
  }

  let request;
  try {
    request = JSON.parse(blob.toString("utf8"));
  } catch {
    request = null;
  }
  if (!request || typeof request !== "object" || Array.isArray(request)) {
    throw Object.assign(new Error("pairing blob is invalid"), { status: 400 });
  }
  if (typeof request.csrPem !== "string" || !request.csrPem.trim()) {
    throw Object.assign(new Error("csrPem is required"), { status: 400 });
  }

  const issued = issueDeviceCert({
    csrPem: request.csrPem,
    deviceName: typeof request.deviceName === "string" ? request.deviceName : null,
    platform: typeof request.platform === "string" ? request.platform : null,
  });

  // Explicit, audited allowlisting of the subject THIS node just minted — the
  // whole point of pairing is that this device is now trusted. Never widens to
  // anything the node did not itself issue in this exchange.
  if (pairingAutoAllow && issued.device?.certSubject) {
    if (allowCertSubject(issued.device.certSubject, { reason: "paired", deviceId: issued.deviceId })) {
      appendAudit("cert_subject_allowlisted", null, {
        deviceId: issued.deviceId,
        certSerial: issued.certSerial,
        certSubject: issued.device.certSubject,
        reason: "paired",
      });
    }
  }

  appendAudit("device_paired", null, {
    sessionId: session.id,
    deviceId: issued.deviceId,
    certSerial: issued.certSerial,
  });
  emitEvent("device.paired", publicDevice(issued.device));

  // Exactly the historical v1 201 body — now carried as an authenticated blob.
  const nodeBlob = Buffer.from(
    JSON.stringify({
      deviceId: issued.deviceId,
      certificatePem: issued.certificatePem,
      caPem: issued.caPem,
      nodeId: issued.nodeId,
      nodeName: issued.nodeName,
      certSerial: issued.certSerial,
      notAfter: issued.notAfter,
    }),
    "utf8",
  );

  return { session, issued, nodeBlob, nodeTag: blobTag(macKey, NODE_SLOT, nodeBlob) };
}

// ---------------------------------------------------------------------------
// POST /v1/pair (API.md §2.3)
//
// { "v": 2, "code": "<code|token>", "blob": "<base64 device blob>",
//   "tag": "<base64 tag>" }
// -> 201 { "v": 2, "blob": "<base64 node blob>", "tag": "<base64 tag>" }
// ---------------------------------------------------------------------------

// Buffer.from(..., "base64") silently discards junk, so the alphabet is
// checked first. Accepts base64 and base64url.
function decodeBase64Strict(value) {
  if (typeof value !== "string") return null;
  const text = value.trim();
  if (!text || text.length > 2 * maxBlobBytes) return null;
  if (!/^[A-Za-z0-9+/_-]+={0,2}$/.test(text)) return null;
  const buf = Buffer.from(text, "base64");
  return buf.length > 0 ? buf : null;
}

async function handlePairRequest(req, res) {
  const body = await readBody(req);
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return sendError(res, 400, "request body must be a JSON object");
  }
  if (typeof body.code !== "string" || !body.code.trim()) {
    return sendError(res, 400, "code is required");
  }
  if (typeof body.blob !== "string" || !body.blob.trim()) {
    return sendError(res, 400, "blob is required");
  }
  if (typeof body.tag !== "string" || !body.tag.trim()) {
    return sendError(res, 400, "tag is required");
  }
  const deviceBlob = decodeBase64Strict(body.blob.trim());
  if (!deviceBlob) {
    return sendError(res, 400, "blob is invalid");
  }

  const { nodeBlob, nodeTag } = redeemPairing({
    secret: body.code,
    deviceBlob,
    deviceTag: body.tag,
    // Blind guessing is throttled per source; a request with the real code is
    // never throttled at all.
    source: req.socket?.remoteAddress || null,
  });

  return sendJson(res, 201, { v: 2, blob: nodeBlob.toString("base64"), tag: nodeTag });
}

// Failure reply for the pairing listener.
//
// THIS LISTENER IS UNAUTHENTICATED: anyone who can reach the port gets this
// body, so only messages we wrote deliberately may travel. Those all carry an
// integer `status` (400/403/429). Everything else is an internal fault whose
// message describes the host — the reported leaks were
// `ENOENT: ... rename '/var/folders/.../devices.json.tmp' -> '...'` (absolute
// filesystem paths) and, on the sqlite backend, `database is locked` (which
// names the storage engine). Those are logged server-side and replaced with a
// fixed string.
//
// A lost pairing claim is NOT one of these: it throws status 403 and is
// therefore the same reply as any other invalid code, never a 500.
function sendPairError(res, error) {
  if (Number.isInteger(error?.status)) {
    return sendError(res, error.status, error.message || "pairing failed");
  }
  appendAudit("pairing_request_failed", null, { error: error?.message || String(error) });
  console.error(`relayd: pairing request failed — ${error?.stack || error?.message || String(error)}`);
  return sendError(res, 500, "internal error");
}

// Dedicated pairing listener. Serves ONLY POST /v1/pair; the data listener
// never routes it, so a client cert is never required here — the single-use
// secret plus the blob tag are the authentication.
function startPairingListener({ host = pairingHost, port = pairingPort } = {}) {
  const server = http.createServer((req, res) => {
    if (req.method === "POST" && (req.url || "").split("?")[0] === "/v1/pair") {
      handlePairRequest(req, res).catch((error) => sendPairError(res, error));
      return;
    }
    sendError(res, 404, "not found");
  });
  return new Promise((resolve, reject) => {
    server.on("error", reject);
    server.listen(port, host, () => resolve(server));
  });
}

// Test hook: clears persisted sessions and the rate-limit window.
function resetPairingState() {
  for (const session of store.listPairingSessions()) {
    store.consumePairingSession(session.id);
  }
  failedAttempts = new Map();
}

export {
  pairingTtlMs,
  maxBlobBytes,
  DEVICE_SLOT,
  NODE_SLOT,
  pairingAuthToken,
  pairingMacKey,
  pairingKeys,
  blobTag,
  verifyBlobTag,
  createPairingSession,
  pairingPresentation,
  consumePairingSecret,
  prunePairingSessions,
  redeemPairing,
  handlePairRequest,
  sendPairError,
  startPairingListener,
  resetPairingState,
};
