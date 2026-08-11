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

function verifyNodeRequest(req, pathWithQuery, { registry, now }) {
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

  return { node };
}

export { NODE_REQUEST_LABEL, nodeRequestSigningInput, verifyNodeRequest };
