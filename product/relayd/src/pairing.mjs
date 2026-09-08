// relayd pairing.mjs — pairing protocol v2 (API.md §2.3).
//
// WHO HOLDS WHAT
//   The NODE originates the pairing secret — a 24-byte token. The PHONE
//   receives it out of band: scanned from the QR, or pasted. The CLOUD, when it
//   is used at all, relays opaque bytes and is told ONLY a derived authToken;
//   it never possesses the secret and therefore can never derive the MAC key
//   that authenticates the relayed blobs.
//
//   THE SHORT CODE IS NOT A CREDENTIAL. `relayd pair` also prints an
//   eight-character code, but redeeming on it is impossible by construction:
//   every key in this protocol — macKey, p12pass, the device token — is derived
//   from the TOKEN, so a caller holding only the code cannot produce a device
//   blob tag the node will accept. Making the code redeemable would mean
//   deriving macKey from ~40 bits of entropy, and one captured blob+tag pair
//   would then be brute-forcible offline, which is the entire integrity
//   argument for the rendezvous. The code is instead a NUMERIC-COMPARISON
//   confirmation, in the Bluetooth sense: the node returns it in the node blob,
//   the app shows it, and the human checks it against the terminal.
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
import fs from "node:fs";
import http from "node:http";
import https from "node:https";

import { sendJson, sendError, readBody, nowIso } from "./util.mjs";
import { appendAudit } from "./audit.mjs";
import {
  issueDeviceCert,
  initIdentity,
  publicDevice,
  mintDeviceP12,
  caSpkiFingerprint,
  nodeServerTlsOptions,
  identityPaths,
  readEncPublicKeyB64,
} from "./identity.mjs";
import { emitEvent } from "./events.mjs";
import { store } from "./store.mjs";
import { deviceTokenStore } from "./device-tokens.mjs";
import {
  pairingEnabled,
  pairingHost,
  pairingPort,
  pairingAutoAllow,
  pairingEndpointUrl,
  pairingIsLoopbackOnly,
  allowCertSubject,
  apiBaseUrl,
  pairLinkBase,
  servesTls,
} from "./config.mjs";

const pairingTtlMs = 15 * 60 * 1000;

// Unambiguous code alphabet (no 0/O/1/I).
const codeAlphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

const DEVICE_SLOT = "device-blob";
const NODE_SLOT = "node-blob";

const AUTH_LABEL = "relay-pair-auth-v1";
const MAC_LABEL = "relay-pair-mac-v1";

// Two more derivations from the same single-use secret, for the MINT variant
// (a phone with no CSR stack). Deriving rather than transmitting means the
// envelope is unchanged: no new field, no second blob, nothing extra to
// intercept. The labels are wire values shared with the Swift implementation
// in ios/.../RelayPairing.swift — never rename them.
const P12_LABEL = "relay-trial-p12-v1";
const DEVICE_TOKEN_LABEL = "relay-device-token-v1";

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

// Shape of the printed confirmation code (see randomCode). Used only to give a
// caller who typed it a straight answer; it is never matched against a session.
function looksLikeVerificationCode(value) {
  return /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{4}-[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{4}$/
    .test(String(value || "").trim().toUpperCase());
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
// (a different process from `relayd pair`) can redeem it. `token` is the secret
// and the only thing that redeems the session; `code` is the confirmation
// string the human compares between the terminal and the phone.
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

// The QR / universal-link payload (spec "QR payload"):
//
//   https://get.openrelay.sh/pair#v=1&n=<nodeId>&m=<nodeName>&t=<token>
//                                &p=<base64url(pairEndpointUrl)>
//                                &a=<base64url(apiBaseUrl)>
//                                &f=<base64url(sha256(node CA SPKI))>
//
// Everything rides in the FRAGMENT, which no HTTP client ever sends to a
// server: the origin is a universal-link target, so a generic camera app shows
// something tappable, but it never learns the pairing token. The in-app scanner
// parses the same string directly and never opens a browser at all.
//
// `f` is the bootstrap pin. The node signs its own TLS certificate, so the
// phone's very first request has nothing to trust; plain HTTP is not an option
// because the token travels in that request. The QR came off the user's own
// terminal, so it is itself an authenticated out-of-band channel and carries
// the pin. It is taken over the node CA's SubjectPublicKeyInfo rather than a
// leaf, so `ensureServerCert` can rotate the server certificate without
// invalidating already-printed codes.
function pairingPresentation(session, { linkBase = pairLinkBase } = {}) {
  const b64 = (value) => Buffer.from(String(value), "utf8").toString("base64url");
  const pairUrl = pairingEndpointUrl();
  const apiUrl = apiBaseUrl();
  const caFingerprint = caSpkiFingerprint();
  const fragment = [
    "v=1",
    `n=${encodeURIComponent(session.nodeId)}`,
    `m=${encodeURIComponent(session.nodeName || session.nodeId)}`,
    `t=${session.token}`,
    `p=${b64(pairUrl)}`,
    `a=${b64(apiUrl)}`,
    ...(caFingerprint ? [`f=${caFingerprint}`] : []),
  ].join("&");
  const url = `${linkBase}#${fragment}`;
  const otpauthUrl = `otpauth://relay-pair/${encodeURIComponent(session.nodeName || session.nodeId)}?secret=${session.token}&issuer=relayd&node=${encodeURIComponent(session.nodeId)}`;
  return {
    code: session.code,
    url,
    otpauthUrl,
    expiresAt: session.expiresAt,
    pairUrl,
    apiBaseUrl: apiUrl,
    caFingerprint,
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

// A used token is indistinguishable from an expired one (403 either way).
// The claim is atomic across processes (store.consumePairingSession — O_EXCL
// create on json, exclusive write transaction on sqlite), so two concurrent
// redemptions of the same token cannot both succeed even when they are served
// by two different daemons sharing one data dir.
//
// ONLY the token matches. See the header: the short code is a confirmation
// string, and accepting it here would make it the MAC key.
function consumePairingSecret(rawValue, { source = null } = {}) {
  const now = Date.now();
  const rawToken = String(rawValue || "").trim();

  // Someone typed the confirmation code into the token field. This is a pure
  // shape test against no session at all, so it discloses nothing and costs
  // nobody's rate budget — it just replaces a baffling 403 with the truth.
  if (looksLikeVerificationCode(rawToken)) {
    throw Object.assign(
      new Error("that is the confirmation code, not the pairing token — scan the QR or paste the token"),
      { status: 400 },
    );
  }

  // Match FIRST. A caller holding the real secret is never gated on a counter
  // that unauthenticated traffic can move.
  let matched = null;
  for (const session of store.listPairingSessions()) {
    if (Date.parse(session.expiresAt) <= now) continue;
    if (rawToken.length > 0 && timingSafeEqualString(session.token, rawToken)) {
      matched = session;
      break;
    }
  }

  if (matched) {
    // Exactly one caller wins this claim; the loser falls through to 403 and,
    // having matched a real session, still spends nobody's budget.
    if (store.consumePairingSession(matched.id)) return matched;
    throw Object.assign(new Error("pairing token is invalid or expired"), { status: 403 });
  }

  pruneAttempts(now);
  if (!recordFailedAttempt(normalizeSource(source), now)) {
    throw Object.assign(new Error("too many pairing attempts"), { status: 429 });
  }
  throw Object.assign(new Error("pairing token is invalid or expired"), { status: 403 });
}

// ---------------------------------------------------------------------------
// The exchange itself — transport independent.
//
// Used by POST /v1/pair (direct mode) and by any rendezvous transport that
// relays the same two blobs through the cloud. The tag check happens BEFORE
// the CSR is parsed or anything is issued, which is precisely what makes a
// control-plane blob substitution fail closed.
// ---------------------------------------------------------------------------

// hex( hmac-sha256(secret, "relay-trial-p12-v1") ) — the PKCS#12 passphrase
// for the mint variant. Both peers derive it; it is never transmitted.
function p12Passphrase(secret) {
  return crypto.createHmac("sha256", Buffer.from(String(secret), "utf8")).update(P12_LABEL).digest("hex");
}

// hex( hmac-sha256(secret, "relay-device-token-v1") ) — the paired device's
// bearer token. Also derived on both sides; the node keeps only its sha256.
function deviceToken(secret) {
  return crypto.createHmac("sha256", Buffer.from(String(secret), "utf8")).update(DEVICE_TOKEN_LABEL).digest("hex");
}

function deviceTokenHashOf(secret) {
  return crypto.createHash("sha256").update(deviceToken(secret), "utf8").digest("hex");
}

// Public key material every paired device is handed, whatever the variant.
//
// `encPubkey` is load-bearing beyond pairing: `relay handoff` seals a session
// to this X25519 key, and since trial enrolment (the only other publisher of
// it) is gone, pairing is now the ONLY way a phone can learn it. A signed-in
// user later registers the machine with POST /v1/nodes carrying both.
function nodePublicKeys() {
  const paths = identityPaths();
  let pubkey = null;
  try {
    pubkey = fs.readFileSync(paths.identityPubPath, "utf8");
  } catch {
    pubkey = null;
  }
  return { pubkey, encPubkey: readEncPublicKeyB64(paths) };
}

// Allowlists the subject THIS node just minted — the whole point of pairing is
// that this device is now trusted. Never widens to anything the node did not
// itself issue in this exchange.
function autoAllowIssuedSubject(issued) {
  if (!pairingAutoAllow || !issued.device?.certSubject) return;
  if (allowCertSubject(issued.device.certSubject, { reason: "paired", deviceId: issued.deviceId })) {
    appendAudit("cert_subject_allowlisted", null, {
      deviceId: issued.deviceId,
      certSerial: issued.certSerial,
      certSubject: issued.device.certSubject,
      reason: "paired",
    });
  }
}

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

  const deviceName = typeof request.deviceName === "string" ? request.deviceName : null;
  const platform = typeof request.platform === "string" ? request.platform : null;
  const wantsMint = request.mint === "p12";
  const hasCsr = typeof request.csrPem === "string" && request.csrPem.trim().length > 0;
  if (!wantsMint && !hasCsr) {
    // Neither variant. The message names both so a caller that sent an empty
    // or misspelled field can tell which half of the contract it missed.
    throw Object.assign(new Error("csrPem or mint is required"), { status: 400 });
  }
  if (wantsMint && request.mint !== "p12") {
    throw Object.assign(new Error("mint must be p12"), { status: 400 });
  }

  const keys = nodePublicKeys();
  let issued;
  let body;

  if (wantsMint) {
    // MINT VARIANT — the phone has no CSR stack, so the node generates the
    // keypair, issues the certificate against its own CA, and returns both in
    // a PKCS#12 encrypted under a passphrase derived from the pairing secret.
    // No private key crosses in cleartext, and no secret crosses that both
    // sides cannot already derive.
    issued = mintDeviceP12({ deviceName, platform, passphrase: p12Passphrase(session.token) });
    autoAllowIssuedSubject(issued);
    // The bearer credential this device will present on the data listener.
    // Recorded BEFORE the node blob is handed back: the phone can present the
    // token the moment it has the secret, and a node that rejected it in the
    // interval would look exactly like a failed pairing.
    deviceTokenStore().registerDevice({
      pairingId: session.id,
      deviceId: issued.deviceId,
      tokenHash: deviceTokenHashOf(session.token),
      certSerial: issued.certSerial,
      notAfter: Date.parse(issued.notAfter),
    });
    body = {
      deviceId: issued.deviceId,
      p12: issued.p12.toString("base64"),
      caPem: issued.caPem,
      nodeId: issued.nodeId,
      nodeName: issued.nodeName,
      certSerial: issued.certSerial,
      notAfter: issued.notAfter,
      apiBaseUrl: apiBaseUrl(),
      verificationCode: session.code,
      ...keys,
    };
  } else {
    // CSR VARIANT — unchanged: the caller made its own keypair and the private
    // key never existed on this machine.
    issued = issueDeviceCert({ csrPem: request.csrPem, deviceName, platform });
    autoAllowIssuedSubject(issued);
    body = {
      deviceId: issued.deviceId,
      certificatePem: issued.certificatePem,
      caPem: issued.caPem,
      nodeId: issued.nodeId,
      nodeName: issued.nodeName,
      certSerial: issued.certSerial,
      notAfter: issued.notAfter,
      apiBaseUrl: apiBaseUrl(),
      verificationCode: session.code,
      ...keys,
    };
  }

  appendAudit("device_paired", null, {
    sessionId: session.id,
    deviceId: issued.deviceId,
    certSerial: issued.certSerial,
    variant: wantsMint ? "p12" : "csr",
  });
  emitEvent("device.paired", publicDevice(issued.device));

  const nodeBlob = Buffer.from(JSON.stringify(body), "utf8");

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
function startPairingListener({ host = pairingHost, port = pairingPort, tls = servesTls } = {}) {
  const handler = (req, res) => {
    if (req.method === "POST" && (req.url || "").split("?")[0] === "/v1/pair") {
      handlePairRequest(req, res).catch((error) => sendPairError(res, error));
      return;
    }
    sendError(res, 404, "not found");
  };
  // TLS here is not optional politeness: the pairing token travels INSIDE this
  // request, so a plaintext pairing listener hands it to any passive listener
  // on the path. The phone cannot pre-trust a self-signed node, which is why
  // the QR carries the CA pin (`f=`) — the certificate served here chains to
  // exactly that CA.
  const server = tls ? https.createServer(nodeServerTlsOptions(), handler) : http.createServer(handler);
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
  p12Passphrase,
  deviceToken,
  deviceTokenHashOf,
  blobTag,
  verifyBlobTag,
  createPairingSession,
  pairingPresentation,
  looksLikeVerificationCode,
  consumePairingSecret,
  prunePairingSessions,
  redeemPairing,
  handlePairRequest,
  sendPairError,
  startPairingListener,
  resetPairingState,
};
