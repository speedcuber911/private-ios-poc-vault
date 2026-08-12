// Signed-request auth for node-originated GETs.
//
// POST /v1/node-events authenticates by signing the raw request body, which a
// GET does not have. These routes sign a canonical string binding the method,
// the exact path+query, the node id, and a timestamp, so a captured signature
// cannot be replayed against a different route or a different node.
import { verify as cryptoVerify } from "node:crypto";

import { parseNodePubkey } from "./notify.js";

const NODE_REQUEST_LABEL = "relay-node-req-v1";
const TS_MAX_AGE_MS = 10 * 60 * 1000;
const TS_MAX_SKEW_MS = 2 * 60 * 1000;

function nodeRequestSigningInput({ method, pathWithQuery, ts, nodeId }) {
  return Buffer.from(
    `${NODE_REQUEST_LABEL}\n${String(method).toUpperCase()}\n${pathWithQuery}\n${nodeId}\n${ts}`,
    "utf8",
  );
}

function verifyNodeRequest(req, pathWithQuery, { registry, now, replayGuard } = {}) {
  const nodeId = String(req.headers["x-relay-node"] || "");
  const tsHeader = String(req.headers["x-relay-ts"] || "");
  const signatureB64 = String(req.headers["x-relay-signature"] || "");
  if (!nodeId || !tsHeader || !signatureB64) return { error: "missing_signature" };

  const ts = Number.parseInt(tsHeader, 10);
  if (!Number.isSafeInteger(ts)) return { error: "bad_ts" };
  const nowMs = now();
  if (ts < nowMs - TS_MAX_AGE_MS || ts > nowMs + TS_MAX_SKEW_MS) return { error: "bad_ts" };

  const node = registry.getNode(nodeId);
  if (!node) return { error: "unknown_node" };
  const key = parseNodePubkey(node.pubkey);
  if (!key) return { error: "node_key_unusable" };

  const signature = Buffer.from(signatureB64, "base64url");
  const input = nodeRequestSigningInput({ method: req.method, pathWithQuery, ts, nodeId });
  if (signature.length === 0 || !cryptoVerify(null, input, key, signature)) return { error: "bad_signature" };

  // Opt-in, per call site: a captured (nodeId, ts, signature) triple is a
  // pure bearer credential for the rest of TS_MAX_AGE_MS unless a
  // replayGuard is supplied. A replayed READ is tolerable; a replayed
  // request against a route that mutates state on every successful call
  // (e.g. the handoff long-poll, which flips rows to `delivered`) is not —
  // see Task 8 review, finding I-3. This performs no change to what is
  // signed, so it never requires a matching client change.
  if (replayGuard && !replayGuard.claim(nodeId, ts, signatureB64, nowMs)) {
    return { error: "replayed" };
  }

  return { node };
}

// A short-lived cache of (nodeId, ts, signature) triples that have already
// authenticated a request, so a byte-for-byte captured replay of the same
// three headers is refused the second time it is presented. Entries expire
// with the same TS_MAX_AGE_MS freshness window `verifyNodeRequest` already
// enforces, and are swept lazily on each claim — no separate timer needed.
//
// This does NOT change what is signed: relayd (the only shipped node-signed
// client — see product/relayd/src/cloudclient.mjs `signedHeaders`) mints a
// fresh `ts`, and therefore a fresh signature, on every call, so single-use
// enforcement here never rejects legitimate traffic; it only closes the
// replay window. Callers that only ever read (and for whom a replayed read
// is harmless) may omit the guard.
function createReplayGuard() {
  const seen = new Map(); // "nodeId:ts:signature" -> expiresAtMs

  function sweep(nowMs) {
    for (const [key, expiresAt] of seen) {
      if (expiresAt <= nowMs) seen.delete(key);
    }
  }

  return {
    // Returns true the first time this exact triple is claimed; false on
    // every replay within the freshness window.
    claim(nodeId, ts, signatureB64, nowMs) {
      sweep(nowMs);
      const key = `${nodeId}:${ts}:${signatureB64}`;
      if (seen.has(key)) return false;
      seen.set(key, ts + TS_MAX_AGE_MS);
      return true;
    },
  };
}

export { NODE_REQUEST_LABEL, nodeRequestSigningInput, verifyNodeRequest, createReplayGuard };
