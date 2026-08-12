// Signed-request auth for node-originated GETs.
//
// POST /v1/node-events authenticates by signing the raw request body, which a
// GET does not have. These routes sign a canonical string binding the method,
// the exact path+query, the node id, and a timestamp, so a captured signature
// cannot be replayed against a different route or a different node.
//
// `pathWithQuery` is the NORMALISED path+query the server routes on
// (`new URL(req.url, …).pathname` + `url.search`), not the raw request
// target: WHATWG URL drops fragments and collapses dot-segments, so
// `/v1/./node/handoffs?wait=0` and `/v1/node/handoffs?wait=0` verify under
// one signature. That is the safe arrangement — what is signed is exactly
// what the route dispatches on — but it is not byte-identical to the wire
// target, and callers must not assume it is.
import { createHash, verify as cryptoVerify } from "node:crypto";

import { parseNodePubkey } from "./notify.js";

const NODE_REQUEST_LABEL = "relay-node-req-v1";
const TS_MAX_AGE_MS = 10 * 60 * 1000;
const TS_MAX_SKEW_MS = 2 * 60 * 1000;

// FROZEN WIRE FORMAT. relayd's already-shipped cloudclient.mjs `signedHeaders`
// builds this exact string; changing a byte of it requires a matching relayd
// change and a coordinated deployment.
function nodeRequestSigningInput({ method, pathWithQuery, ts, nodeId }) {
  return Buffer.from(
    `${NODE_REQUEST_LABEL}\n${String(method).toUpperCase()}\n${pathWithQuery}\n${nodeId}\n${ts}`,
    "utf8",
  );
}

// `registry` and `now` are mandatory, and the options object has no `= {}`
// default: omitting it must fail at the call site, immediately and by name,
// rather than looking optional and then throwing halfway through
// verification with a message that names neither the caller nor the field.
// Nothing an attacker can send reaches this check — it fires only on a
// miswired call site.
function verifyNodeRequest(req, pathWithQuery, { registry, now, replayGuard, allowReplay = false }) {
  if (!registry || typeof now !== "function") {
    throw new TypeError("verifyNodeRequest requires { registry, now }");
  }
  const nodeId = String(req.headers["x-relay-node"] || "");
  const tsHeader = String(req.headers["x-relay-ts"] || "");
  const signatureB64 = String(req.headers["x-relay-signature"] || "");
  if (!nodeId || !tsHeader || !signatureB64) return { error: "missing_signature" };

  const ts = Number.parseInt(tsHeader, 10);
  if (!Number.isSafeInteger(ts)) return { error: "bad_ts" };
  // One timestamp, one spelling. `Number.parseInt` accepts leading
  // whitespace, a leading `+`, leading zeros, an exponent and arbitrary
  // trailing junk — eight header strings for one instant, all authenticating
  // under one signature. relayd sends `String(Date.now())`, so demanding the
  // canonical form costs a legitimate client nothing.
  if (String(ts) !== tsHeader) return { error: "bad_ts" };
  const nowMs = now();
  if (ts < nowMs - TS_MAX_AGE_MS || ts > nowMs + TS_MAX_SKEW_MS) return { error: "bad_ts" };

  const node = registry.getNode(nodeId);
  if (!node) return { error: "unknown_node" };
  const key = parseNodePubkey(node.pubkey);
  if (!key) return { error: "node_key_unusable" };

  const signature = Buffer.from(signatureB64, "base64url");
  // `Buffer.from(s, "base64url")` is lenient: it accepts the standard `+/`
  // alphabet, accepts padding, silently skips every non-alphabet character,
  // and ignores the four unused bits in the final character of an 86-character
  // (512-bit) payload. One signature therefore has effectively unlimited
  // distinct spellings, every one of which verifies. Decode-and-re-encode
  // admits exactly one — the same rule server.js applies to `encPubkey` and
  // relayd's seal.mjs applies to a recipient key.
  if (signature.length === 0 || signature.toString("base64url") !== signatureB64) {
    return { error: "bad_signature" };
  }
  const input = nodeRequestSigningInput({ method: req.method, pathWithQuery, ts, nodeId });
  if (!cryptoVerify(null, input, key, signature)) return { error: "bad_signature" };

  // Replay defence is ON by default, and a call site that says nothing gets
  // no authentication at all rather than silently replayable authentication.
  //
  // The previous polarity was opt-in on the theory that a replayed READ is
  // harmless. That reasoning failed once already: the handoff long-poll
  // looked like a read — a GET named /handoffs — and was in fact a
  // state-mutating operation that permanently consumes rows (Task 8 review,
  // I-3). The next node-signed route would inherit the hazard by omission,
  // and a replayed read is indistinguishable from a legitimate one in tests.
  //
  // The cost of the default is zero: relayd (the only shipped node-signed
  // client, cloudclient.mjs `signedHeaders`) mints a fresh `ts` — and
  // therefore a fresh signature — on every call, so single-use enforcement
  // never rejects legitimate traffic. `allowReplay: true` is the explicit,
  // deliberate opt-out for a route proven side-effect-free.
  if (!replayGuard) {
    if (!allowReplay) return { error: "replay_guard_missing" };
  } else if (!replayGuard.claim(
    { method: req.method, pathWithQuery, nodeId, ts, signature }, nowMs,
  )) {
    return { error: "replayed" };
  }

  return { node };
}

// The canonical identity of one request, as the replay cache sees it.
//
// Keyed on the DECODED signature bytes: keying on the header string guarded
// nothing, because the spellings above all decode to the same signature and
// so all verified while presenting as distinct cache entries. A captured
// triple remained a bearer credential for the full freshness window —
// `sig + "="`, the standard-base64 spelling and a spelling with an embedded
// space each stole and permanently consumed handoffs minted after the
// capture (review-t5-t7, T7-C1).
//
// Fields are length-prefixed before hashing so no two distinct tuples can
// collide by running one field into the next: bare concatenation makes
// ("/a", "b:c") and ("/a:b", "c") the same key.
function replayKey({ method, pathWithQuery, nodeId, ts, signature }) {
  const hash = createHash("sha256");
  const fields = [
    Buffer.from(String(method).toUpperCase(), "utf8"),
    Buffer.from(String(pathWithQuery), "utf8"),
    Buffer.from(String(nodeId), "utf8"),
    Buffer.from(String(ts), "utf8"),
    Buffer.isBuffer(signature) ? signature : Buffer.from(String(signature), "utf8"),
  ];
  for (const field of fields) {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(field.length);
    hash.update(length);
    hash.update(field);
  }
  return hash.digest("base64");
}

// A short-lived cache of request identities that have already authenticated,
// so a captured request is refused the second time it is presented. Entries
// expire with the same TS_MAX_AGE_MS freshness window `verifyNodeRequest`
// enforces, and are swept lazily on each claim — no separate timer needed.
function createReplayGuard() {
  const seen = new Map(); // canonical request identity -> expiresAtMs

  // Entries are inserted in roughly increasing expiry order, since `ts`
  // advances, so the first live entry ends the sweep: O(evicted) per claim
  // rather than O(size). A future-skewed `ts` can park one entry out of
  // order and delay eviction of those behind it by at most TS_MAX_SKEW_MS;
  // that costs memory, never correctness, because a lingering entry can only
  // reject a request whose `ts` is outside the freshness window — and those
  // are already refused as `bad_ts` before reaching here.
  function sweep(nowMs) {
    for (const [key, expiresAt] of seen) {
      if (expiresAt > nowMs) break;
      seen.delete(key);
    }
  }

  return {
    // Returns true the first time this exact request identity is claimed;
    // false on every replay within the freshness window.
    claim(identity, nowMs) {
      sweep(nowMs);
      const key = replayKey(identity);
      if (seen.has(key)) return false;
      // Strictly OUTLIVES the freshness window. That window admits `ts` while
      // `ts >= nowMs - TS_MAX_AGE_MS`, i.e. up to and including
      // `nowMs === ts + TS_MAX_AGE_MS`; expiring the entry at exactly that
      // instant left one millisecond in which the timestamp was still fresh
      // and the guard had already forgotten it, and a replay fired into that
      // millisecond succeeded (review-t5-t7, T7-I1).
      seen.set(key, Number(identity.ts) + TS_MAX_AGE_MS + 1);
      return true;
    },
  };
}

export { NODE_REQUEST_LABEL, nodeRequestSigningInput, verifyNodeRequest, createReplayGuard };
