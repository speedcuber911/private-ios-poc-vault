// Pairing rendezvous (protocol v2): short-lived sessions relaying opaque blobs
// between a node and a device during enrollment (CSR one way, issued cert the
// other).
//
// WHAT THE PREVIOUS COMMENT CLAIMED, AND WHY IT WAS FALSE
// -------------------------------------------------------
// v1 said: "The cloud NEVER parses blob contents … This is what keeps the
// control plane unable to mint access to any node." Opacity alone never bought
// that property. In v1 the CLOUD generated the pairing secret and handed out
// the plaintext, and the blobs had no integrity tag, no put-once and no
// binding — so a compromised control plane could simply OVERWRITE the stored
// device-blob with its own CSR before the node read it. The node's CA signed
// it and returned a valid mTLS client certificate: full read/write access to
// the user's files and job submission. The cloud never minted the certificate
// itself; it induced the node to mint one. An adversarial audit ran exactly
// that attack.
//
// WHAT v2 ACTUALLY GUARANTEES
// ---------------------------
// The NODE originates the secret; the PHONE receives it out of band (QR /
// typed code). Both peers derive, and the cloud cannot:
//
//   authToken = base64url( sha256( "relay-pair-auth-v1" || 0x00 || secret ) )
//   macKey    =           hmac-sha256( key = secret, msg = "relay-pair-mac-v1" )
//
// The cloud is told ONLY authToken and stores only sha256(authToken), so it
// possesses neither `secret` nor `macKey`. Every blob carries
//
//   tag = base64( hmac-sha256( macKey, slotName || 0x00 || blob ) )
//
// computed by its SENDER and verified by the receiving PEER (slotName is
// exactly "device-blob" or "node-blob"). The cloud stores {blob, tag}
// verbatim, treats both as opaque, and validates neither — it cannot. A
// substituted blob therefore fails the peer's tag check, and the node refuses
// to issue anything. Opacity is a privacy property; the MAC is the integrity
// property, and only the MAC stops the substitution attack.
//
// Additional hardening in v2: each slot is PUT-ONCE (a second write is a
// conflict, never an overwrite); a session is closed and its blobs deleted as
// soon as both slots have been read; and a per-account cap bounds how many
// live sessions one caller can pin.

import { createHash, randomUUID, timingSafeEqual } from "node:crypto";

const SLOTS = new Set(["node", "device"]);

// Rendezvous kinds sharing these same put-once, MAC'd, 15-minute-TTL rails,
// but never each other's quota or backlog:
//   pair          — node <-> phone enrollment (CSR one way, cert the other).
//   sync-auth     — `relay sync-auth` ships a sealed credential bundle from
//                   the laptop CLI to the sandbox; only the device slot is
//                   written (by the CLI) and read (by the node).
//   session-index — the "On your Mac" session index; same one-way shape as
//                   sync-auth, different payload.
// Slot names stay exactly "node" / "device" for all three kinds — sync-auth
// and session-index simply never write "node".
const KINDS = new Set(["pair", "hosted-device", "sync-auth", "session-index"]);

// `sync-auth` and `session-index` are one-directional: only the "device"
// slot is ever written (by the CLI) or read (by the node) — nothing ever
// touches "node" for these kinds. getBlob's close condition below was
// written for the two-sided `pair` protocol ("close once BOTH slots have
// been read") and for these kinds `nodeReadAt` can therefore never become
// non-null, so the close never fires — not on failure only, on EVERY
// exchange, success included. The session then rides its full TTL
// (config.pairingTtlSec) instead of closing the instant its one slot is
// consumed, which matters because live sessions are capped per (account,
// kind): a user who runs `relay handoff` or `relay sync-auth` enough times
// inside one TTL window starts getting 429 too_many_pairing_sessions with
// budget sitting idle in already-fully-read rows. See handoff.mjs and
// syncauth.mjs on the relayd/CLI side for the one-directional read pattern
// this describes.
const ONE_WAY_KINDS = new Set(["sync-auth", "session-index"]);

// Max live (unexpired, unclosed) sessions per (account, kind).
const DEFAULT_MAX_SESSIONS_PER_ACCOUNT = 5;

// authToken shape check. It is base64url of a sha256 digest (43 chars), but a
// range is accepted so the check never becomes a compatibility trap.
const AUTH_TOKEN_RE = /^[A-Za-z0-9_-]{22,128}$/;

// Tags are base64 of a sha256 HMAC (44 chars with padding). The cloud does not
// interpret them; this only bounds what it will store.
const TAG_RE = /^[A-Za-z0-9+/]{16,128}={0,2}$/;

function sha256Hex(value) {
  return createHash("sha256").update(value).digest("hex");
}

function hashesEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const ba = Buffer.from(a, "hex");
  const bb = Buffer.from(b, "hex");
  return ba.length === bb.length && ba.length > 0 && timingSafeEqual(ba, bb);
}

export function createPairing({ registry, config, now = () => Date.now() }) {
  const maxPerAccount = Number.isInteger(config.pairingMaxSessionsPerAccount)
    ? config.pairingMaxSessionsPerAccount
    : DEFAULT_MAX_SESSIONS_PER_ACCOUNT;

  // The caller (the node's owner, via the phone, the CLI, or the node itself
  // depending on kind) supplies authToken. The cloud NEVER generates a
  // pairing secret and NEVER returns one — there is nothing secret in the
  // response. Returns { pairingId, expiresAt } | "invalid_auth_token" |
  // "invalid_kind" | "too_many_sessions".
  function createSession({ accountId, authToken, kind = "pair" }) {
    if (typeof authToken !== "string" || !AUTH_TOKEN_RE.test(authToken)) {
      return "invalid_auth_token";
    }
    if (!KINDS.has(kind)) {
      return "invalid_kind";
    }
    if (registry.countLivePairingSessions(accountId, kind, now()) >= maxPerAccount) {
      return "too_many_sessions";
    }
    const pairingId = randomUUID();
    const expiresAt = now() + config.pairingTtlSec * 1000;
    registry.insertPairingSession({
      id: pairingId,
      accountId,
      kind,
      authTokenHash: sha256Hex(authToken),
      expiresAt,
    });
    return { pairingId, expiresAt };
  }

  function authorize(id, authToken) {
    if (typeof authToken !== "string" || !authToken) return null;
    const session = registry.getPairingSession(id);
    if (!session) return null;
    if (session.expiresAt <= now()) return null;
    if (session.closedAt !== null) return null;
    if (!hashesEqual(session.authTokenHash, sha256Hex(authToken))) return null;
    return session;
  }

  // blob is a Buffer of opaque bytes; tag is the SENDER's MAC, stored verbatim
  // and never checked here. Returns "ok" | "unauthorized" | "bad_slot" |
  // "too_large" | "conflict".
  function putBlob(id, authToken, slot, blob, tag) {
    if (!SLOTS.has(slot)) return "bad_slot";
    if (!Buffer.isBuffer(blob) || blob.length === 0) return "bad_slot";
    if (blob.length > config.pairingBlobMaxBytes) return "too_large";
    if (typeof tag !== "string" || !TAG_RE.test(tag)) return "bad_slot";
    const session = authorize(id, authToken);
    if (!session) return "unauthorized";
    // A node may retry the SAME encrypted response after a crash or a
    // lost HTTP acknowledgement. Never permit replacement or extend its TTL.
    if (["pair", "hosted-device"].includes(session.kind) && slot === "node" && session.nodeBlob !== null) {
      return session.nodeBlob === blob.toString("base64") && session.nodeTag === tag ? "ok" : "conflict";
    }
    // PUT-ONCE: a filled slot is a conflict, never an overwrite. This is what
    // denies the control plane a quiet substitution even before the peer's MAC
    // check catches it.
    if (!registry.setPairingBlob(id, slot, blob.toString("base64"), tag)) {
      return "conflict";
    }
    return "ok";
  }

  // Returns { blob: Buffer, tag: string } | "unauthorized" | "bad_slot" |
  // "empty". Once both slots have been read the session is closed and the
  // relayed bytes are deleted immediately.
  function getBlob(id, authToken, slot) {
    if (!SLOTS.has(slot)) return "bad_slot";
    const session = authorize(id, authToken);
    if (!session) return "unauthorized";
    const b64 = slot === "node" ? session.nodeBlob : session.deviceBlob;
    const tag = slot === "node" ? session.nodeTag : session.deviceTag;
    if (!b64) return "empty";

    registry.markPairingBlobRead(id, slot);
    const after = registry.getPairingSession(id);
    const bothSlotsRead = after && after.nodeReadAt !== null && after.deviceReadAt !== null;
    // One-directional kinds never write or read the "node" slot, so
    // `bothSlotsRead` above can never become true for them — close as soon
    // as the ONLY slot they use has been read instead, on every read
    // (there is no separate success/failure signal at this layer; a read
    // that happened at all is the one and only delivery event these kinds
    // have). A genuinely two-sided `pair` session is untouched: it is not in
    // ONE_WAY_KINDS, so it keeps requiring both reads exactly as before.
    const oneWaySlotRead = after && ONE_WAY_KINDS.has(session.kind) && slot === "device" && after.deviceReadAt !== null;
    if (bothSlotsRead || oneWaySlotRead) {
      registry.closePairingSession(id);
    }
    return { blob: Buffer.from(b64, "base64"), tag };
  }

  function sweep() {
    registry.sweepPairingSessions(now());
  }

  return { createSession, putBlob, getBlob, sweep, maxPerAccount, isAuthorized: (id, authToken) => Boolean(authorize(id, authToken)) };
}
